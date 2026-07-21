import {lstat, readFile, stat, unlink} from 'node:fs/promises';
import {applyPatch as applyUnifiedPatch, parsePatch, type StructuredPatch} from 'diff';
import {z} from 'zod';
import type {AgentTool, ToolExecutionContext} from './types.js';
import {jsonSchema} from './types.js';
import {atomicWrite} from './write.js';

const inputSchema = z.object({
  patch: z.string().min(1).max(10_000_000),
  dry_run: z.boolean().optional(),
}).strict();

export const applyPatchTool: AgentTool = {
  definition: {
    name: 'apply_patch',
    description: 'Apply an atomic multi-file patch inside the workspace. Supports unified diffs and *** Begin Patch format.',
    category: 'write',
    inputSchema: jsonSchema({
      patch: {type: 'string', description: 'Unified diff or Begin/End Patch text.'},
      dry_run: {type: 'boolean', default: false},
    }, ['patch']),
  },

  async affectedPaths(arguments_, context) {
    const input = inputSchema.parse(arguments_);
    const names = extractPatchPaths(input.patch);
    return Promise.all(names.map((path) =>
      context.workspace.resolvePath(path, {allowMissing: true}),
    ));
  },

  async execute(arguments_, context) {
    const input = inputSchema.parse(arguments_);
    const changes = input.patch.trimStart().startsWith('*** Begin Patch')
      ? await prepareCustomPatch(input.patch, context)
      : await prepareUnifiedPatch(input.patch, context);
    if (!changes.length) throw new Error('Patch contains no file changes.');
    if (!input.dry_run) await commitChanges(changes, context);
    const changedFiles = changes
      .filter((change) => !buffersEqual(change.before, change.after))
      .map((change) => change.path);
    return {
      content: [
        input.dry_run ? 'Patch validated (dry run).' : 'Patch applied.',
        ...changes.map((change) => {
          const action = change.before === null ? 'create'
            : change.after === null ? 'delete' : 'update';
          return `${action} ${context.workspace.display(change.path)}`;
        }),
      ].join('\n'),
      metadata: {dryRun: input.dry_run ?? false, files: changedFiles},
      changedFiles: input.dry_run ? [] : changedFiles,
    };
  },
};

interface PreparedChange {
  path: string;
  before: Buffer | null;
  after: Buffer | null;
  mode?: number;
}

type CustomOperation =
  | {kind: 'add'; path: string; content: string}
  | {kind: 'delete'; path: string}
  | {kind: 'update'; path: string; moveTo?: string; hunks: CustomHunk[]};

interface CustomHunk {
  header: string;
  lines: Array<{kind: 'context' | 'add' | 'delete'; text: string}>;
  endOfFile: boolean;
}

export function extractPatchPaths(patch: string): string[] {
  if (patch.trimStart().startsWith('*** Begin Patch')) {
    const paths: string[] = [];
    for (const operation of parseCustomPatch(patch)) {
      paths.push(operation.path);
      if (operation.kind === 'update' && operation.moveTo) paths.push(operation.moveTo);
    }
    return [...new Set(paths)];
  }
  const paths: string[] = [];
  for (const index of parsePatch(patch)) {
    for (const name of [index.oldFileName, index.newFileName]) {
      if (name && name !== '/dev/null') paths.push(cleanUnifiedPath(name));
    }
  }
  return [...new Set(paths)];
}

async function prepareCustomPatch(
  patch: string,
  context: ToolExecutionContext,
): Promise<PreparedChange[]> {
  const operations = parseCustomPatch(patch);
  const states = new Map<string, PreparedChange>();
  const get = async (name: string): Promise<PreparedChange> => {
    const path = await context.workspace.resolvePath(name, {allowMissing: true});
    const cached = states.get(path);
    if (cached) return cached;
    const snapshot = await readSnapshot(path);
    const change: PreparedChange = {path, ...snapshot, after: snapshot.before};
    states.set(path, change);
    return change;
  };

  for (const operation of operations) {
    const target = await get(operation.path);
    if (operation.kind === 'add') {
      if (target.after !== null) throw new Error(`Cannot add an existing file: ${operation.path}`);
      target.after = Buffer.from(operation.content);
      continue;
    }
    if (operation.kind === 'delete') {
      if (target.after === null) throw new Error(`Cannot delete a missing file: ${operation.path}`);
      target.after = null;
      continue;
    }
    if (target.after === null) throw new Error(`Cannot update a missing file: ${operation.path}`);
    const source = decodeText(target.after, operation.path);
    const updated = Buffer.from(applyCustomHunks(source, operation.hunks, operation.path));
    if (operation.moveTo) {
      const destination = await get(operation.moveTo);
      if (destination.path !== target.path && destination.after !== null) {
        throw new Error(`Move destination already exists: ${operation.moveTo}`);
      }
      destination.after = updated;
      if (destination.path !== target.path) target.after = null;
    } else {
      target.after = updated;
    }
  }
  return [...states.values()];
}

async function prepareUnifiedPatch(
  patch: string,
  context: ToolExecutionContext,
): Promise<PreparedChange[]> {
  const indexes = parsePatch(patch);
  if (!indexes.length) throw new Error('Invalid or empty unified diff.');
  const states = new Map<string, PreparedChange>();
  const get = async (name: string): Promise<PreparedChange> => {
    const path = await context.workspace.resolvePath(cleanUnifiedPath(name), {allowMissing: true});
    const cached = states.get(path);
    if (cached) return cached;
    const snapshot = await readSnapshot(path);
    const change: PreparedChange = {path, ...snapshot, after: snapshot.before};
    states.set(path, change);
    return change;
  };
  for (const index of indexes) {
    if (index.isBinary) throw new Error('Binary patches are not supported.');
    const oldName = index.oldFileName;
    const newName = index.newFileName;
    if (!oldName && !newName) throw new Error('Patch is missing file headers.');
    const creating = !oldName || oldName === '/dev/null';
    const deleting = !newName || newName === '/dev/null';
    const sourceState = creating ? undefined : await get(oldName);
    if (!creating && sourceState?.after === null) {
      throw new Error(`Cannot patch a missing file: ${oldName}`);
    }
    const source = sourceState?.after ? decodeText(sourceState.after, oldName ?? 'file') : '';
    const result = applyUnifiedPatch(source, index, {fuzzFactor: 0});
    if (result === false) throw new Error(`Patch hunk did not match: ${oldName ?? newName}`);
    if (deleting) {
      if (!sourceState) throw new Error('Delete patch is missing its source file.');
      sourceState.after = null;
      continue;
    }
    if (!newName) throw new Error('Patch is missing its destination file.');
    const destination = await get(newName);
    if (creating && destination.after !== null) {
      throw new Error(`Cannot create an existing file: ${newName}`);
    }
    destination.after = Buffer.from(result);
    const renamed = sourceState && sourceState.path !== destination.path &&
      (index.isRename ?? oldName !== newName);
    if (renamed && !index.isCopy) sourceState.after = null;
  }
  return [...states.values()];
}

export function parseCustomPatch(patch: string): CustomOperation[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '*** Begin Patch') throw new Error('Missing *** Begin Patch marker.');
  const operations: CustomOperation[] = [];
  let index = 1;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '*** End Patch') return operations;
    const header = line.match(/^\*\*\* (Add|Delete|Update) File: (.+)$/);
    if (!header?.[1] || !header[2]) {
      if (!line.trim()) {
        index += 1;
        continue;
      }
      throw new Error(`Invalid patch header at line ${index + 1}: ${line}`);
    }
    const kind = header[1].toLocaleLowerCase() as 'add' | 'delete' | 'update';
    const path = header[2].trim();
    index += 1;
    if (kind === 'add') {
      const content: string[] = [];
      while (index < lines.length && !isOperationBoundary(lines[index] ?? '')) {
        const value = lines[index] ?? '';
        if (!value.startsWith('+')) throw new Error(`Added file lines must start with + (line ${index + 1}).`);
        content.push(value.slice(1));
        index += 1;
      }
      operations.push({kind, path, content: content.length ? `${content.join('\n')}\n` : ''});
      continue;
    }
    if (kind === 'delete') {
      operations.push({kind, path});
      while (index < lines.length && !isOperationBoundary(lines[index] ?? '')) index += 1;
      continue;
    }
    let moveTo: string | undefined;
    if ((lines[index] ?? '').startsWith('*** Move to: ')) {
      moveTo = (lines[index] ?? '').slice('*** Move to: '.length).trim();
      index += 1;
    }
    const hunks: CustomHunk[] = [];
    while (index < lines.length && !isOperationBoundary(lines[index] ?? '')) {
      const hunkHeader = lines[index] ?? '';
      if (!hunkHeader.startsWith('@@')) {
        if (!hunkHeader.trim()) {
          index += 1;
          continue;
        }
        throw new Error(`Expected @@ hunk header at line ${index + 1}.`);
      }
      index += 1;
      const hunk: CustomHunk = {header: hunkHeader, lines: [], endOfFile: false};
      while (index < lines.length && !isOperationBoundary(lines[index] ?? '') &&
        !(lines[index] ?? '').startsWith('@@')) {
        const value = lines[index] ?? '';
        if (value === '*** End of File') {
          hunk.endOfFile = true;
          index += 1;
          continue;
        }
        const prefix = value[0];
        if (prefix !== ' ' && prefix !== '+' && prefix !== '-') {
          throw new Error(`Invalid hunk line ${index + 1}; expected space, +, or - prefix.`);
        }
        hunk.lines.push({
          kind: prefix === '+' ? 'add' : prefix === '-' ? 'delete' : 'context',
          text: value.slice(1),
        });
        index += 1;
      }
      hunks.push(hunk);
    }
    if (!hunks.length) throw new Error(`Update has no hunks: ${path}`);
    operations.push({kind, path, ...(moveTo ? {moveTo} : {}), hunks});
  }
  throw new Error('Missing *** End Patch marker.');
}

function applyCustomHunks(source: string, hunks: CustomHunk[], path: string): string {
  const finalNewline = source.endsWith('\n');
  const lines = source === '' ? [] : source.slice(0, finalNewline ? -1 : undefined).split('\n');
  let cursor = 0;
  let forceFinalNewline = finalNewline;
  for (const hunk of hunks) {
    const oldLines = hunk.lines
      .filter((line) => line.kind !== 'add')
      .map((line) => line.text);
    const newLines = hunk.lines
      .filter((line) => line.kind !== 'delete')
      .map((line) => line.text);
    const numeric = hunk.header.match(/^@@\s+-(\d+)/)?.[1];
    const label = hunk.header.replace(/^@@\s*/, '').replace(/\s*@@$/, '').trim();
    let hint = numeric ? Math.max(0, Number(numeric) - 1) : cursor;
    if (!numeric && label) {
      const anchor = lines.findIndex((line, lineIndex) => lineIndex >= cursor && line.includes(label));
      if (anchor >= 0) hint = anchor;
    }
    const position = oldLines.length
      ? findSequence(lines, oldLines, hint, cursor)
      : Math.min(hint, lines.length);
    if (position < 0) {
      const preview = oldLines.slice(0, 3).join('\n');
      throw new Error(`Patch hunk did not match ${path}:\n${preview}`);
    }
    lines.splice(position, oldLines.length, ...newLines);
    cursor = position + newLines.length;
    if (hunk.endOfFile) forceFinalNewline = false;
  }
  return `${lines.join('\n')}${forceFinalNewline && lines.length ? '\n' : ''}`;
}

function findSequence(
  haystack: string[],
  needle: string[],
  hint: number,
  minimum: number,
): number {
  const matchesAt = (start: number, relaxed: boolean) => needle.every((line, offset) => {
    const candidate = haystack[start + offset];
    return relaxed ? candidate?.trimEnd() === line.trimEnd() : candidate === line;
  });
  const starts: number[] = [];
  for (let index = Math.max(0, minimum); index <= haystack.length - needle.length; index += 1) {
    starts.push(index);
  }
  starts.sort((a, b) => Math.abs(a - hint) - Math.abs(b - hint));
  return starts.find((start) => matchesAt(start, false)) ??
    starts.find((start) => matchesAt(start, true)) ?? -1;
}

async function readSnapshot(path: string): Promise<{
  before: Buffer | null;
  mode?: number;
}> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing to patch a symbolic link: ${path}`);
    if (!info.isFile()) throw new Error(`Patch target is not a regular file: ${path}`);
    return {before: await readFile(path), mode: info.mode};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {before: null};
    throw error;
  }
}

async function commitChanges(
  changes: PreparedChange[],
  context: ToolExecutionContext,
): Promise<void> {
  const committed: PreparedChange[] = [];
  try {
    for (const change of changes) {
      if (buffersEqual(change.before, change.after)) continue;
      if (change.after === null) {
        await unlink(change.path);
      } else {
        await context.workspace.ensureParent(change.path);
        await atomicWrite(change.path, change.after, change.mode);
      }
      committed.push(change);
    }
  } catch (error) {
    for (const change of committed.reverse()) {
      try {
        if (change.before === null) await unlink(change.path).catch(() => undefined);
        else await atomicWrite(change.path, change.before, change.mode);
      } catch {
        // Preserve the original failure; checkpoint recovery remains available.
      }
    }
    throw error;
  }
}

function decodeText(buffer: Buffer, path: string): string {
  if (buffer.subarray(0, 8_192).includes(0)) {
    throw new Error(`Binary file cannot be patched: ${path}`);
  }
  return buffer.toString('utf8');
}

function cleanUnifiedPath(path: string): string {
  const unquoted = path.replace(/^"|"$/g, '');
  return unquoted.startsWith('a/') || unquoted.startsWith('b/')
    ? unquoted.slice(2)
    : unquoted;
}

function isOperationBoundary(line: string): boolean {
  return line === '*** End Patch' || /^\*\*\* (Add|Delete|Update) File: /.test(line);
}

function buffersEqual(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}
