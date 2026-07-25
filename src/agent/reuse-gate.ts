import {createHash} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import {basename, extname} from 'node:path';
import type {ReuseReceipt} from '../types.js';
import type {ContextProvider} from '../tools/types.js';
import type {WorkspaceAccess} from '../tools/workspace.js';
import {extractPatchPaths} from '../tools/apply-patch.js';

const MAX_CANDIDATES = 5;
const SKIPPED_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.rst', '.adoc', '.json', '.jsonc', '.yaml', '.yml',
  '.toml', '.ini', '.env', '.lock', '.csv', '.tsv', '.svg',
]);
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.kt', '.kts', '.rb', '.php', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.cs', '.scala', '.vue', '.svelte', '.html', '.css', '.scss', '.less', '.sql',
  '.graphql', '.gql', '.sh', '.bash', '.zsh', '.fish', '.ps1',
]);
const DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

export interface ReuseGateInput {
  requestId: string;
  request: string;
  changeSequence: number;
  call: {name: string; arguments: Record<string, unknown>};
  context: ContextProvider;
  workspace: WorkspaceAccess;
}

export interface ReuseGateResult {
  triggered: boolean;
  receipt?: ReuseReceipt;
  warning?: string;
}

/** Evaluate the first substantive implementation write without blocking it. */
export async function evaluateReuseGate(input: ReuseGateInput): Promise<ReuseGateResult> {
  const preview = await previewWrite(input.call, input.workspace);
  if (!preview || !preview.paths.length || !preview.symbols.length) return {triggered: false};
  if (preview.paths.every(isExemptPath)) return {triggered: false};

  const targetPaths = preview.paths.slice(0, MAX_CANDIDATES);
  const query = [input.request, ...preview.symbols, ...targetPaths.map((path) => basename(path))]
    .join(' ').slice(0, 8_000);
  const queryHash = hash(query);
  let refresh: Awaited<ReturnType<NonNullable<ContextProvider['flushDirty']>>> | undefined;
  try {
    refresh = input.context.flushDirty ? await input.context.flushDirty() : {status: 'current', paths: 0};
  } catch (error) {
    const receipt = unresolvedReceipt(input, queryHash, targetPaths, preview.trigger, 'context refresh failed');
    return {triggered: true, receipt, warning: `Reuse check (warning-only): ${receipt.rationale}`};
  }
  if (refresh.status === 'degraded') {
    const receipt = unresolvedReceipt(input, queryHash, targetPaths, preview.trigger, 'context refresh degraded');
    return {triggered: true, receipt, warning: `Reuse check (warning-only): ${receipt.rationale}`};
  }

  let hits;
  try {
    hits = await input.context.search(query, MAX_CANDIDATES);
  } catch (error) {
    const receipt = unresolvedReceipt(input, queryHash, targetPaths, preview.trigger, 'candidate search failed');
    return {triggered: true, receipt, warning: `Reuse check (warning-only): ${receipt.rationale}`};
  }
  if (input.context.lastDegradation?.()) {
    const receipt = unresolvedReceipt(input, queryHash, targetPaths, preview.trigger, 'candidate search degraded');
    return {triggered: true, receipt, warning: `Reuse check (warning-only): ${receipt.rationale}`};
  }
  const candidates: ReuseReceipt['candidates'] = [];
  for (const hit of hits.slice(0, MAX_CANDIDATES)) {
    if (!input.workspace.contains(hit.path)) continue;
    let read: 'current' | 'unreadable' = 'unreadable';
    try {
      const currentPath = await input.workspace.resolvePath(hit.path, {expect: 'file'});
      await readFile(currentPath, 'utf8');
      read = 'current';
    } catch {
      // A ranked span is not evidence until the current file can be read.
    }
    candidates.push({
      path: hit.path,
      ...(hit.symbol ? {symbol: hit.symbol.slice(0, 160)} : {}),
      score: roundScore(hit.score),
      read,
    });
  }
  const current = candidates.filter((candidate) => candidate.read === 'current');
  const selected = current.find((candidate) => candidate.symbol &&
    preview.symbols.some((symbol) => symbol === candidate.symbol));
  const fallback = current[0];
  const chosen = selected ?? fallback;
  const decision: ReuseReceipt['decision'] = chosen
    ? selected ? 'reuse' : 'extend'
    : candidates.length ? 'unresolved' : 'new';
  const status: ReuseReceipt['status'] = decision === 'unresolved' ? 'unresolved' : 'warning';
  const rationale = chosen
    ? `${decision === 'reuse' ? 'Current candidate symbol matches the proposed addition.' : 'Current related code is available for extension.'}`
    : candidates.length ? 'Candidates were not readable at the current workspace generation.' : 'No current repository candidate matched the proposed addition.';
  const receipt: ReuseReceipt = {
    requestId: input.requestId,
    queryHash,
    targetPaths,
    trigger: preview.trigger,
    decision,
    candidates,
    ...(chosen ? {selectedPath: chosen.path, ...(chosen.symbol ? {selectedSymbol: chosen.symbol} : {})} : {}),
    rationale,
    ...(refresh.generation ? {indexGeneration: refresh.generation} : {}),
    changeSequence: input.changeSequence,
    status,
    warningOnly: true,
  };
  return {
    triggered: true,
    receipt,
    warning: `Reuse check (warning-only): ${decision}; ${rationale}`,
  };
}

interface WritePreview {
  paths: string[];
  symbols: string[];
  trigger: ReuseReceipt['trigger'];
}

async function previewWrite(
  call: ReuseGateInput['call'],
  workspace: WorkspaceAccess,
): Promise<WritePreview | undefined> {
  if (call.name === 'write_file' && typeof call.arguments.path === 'string' &&
    typeof call.arguments.content === 'string') {
    const path = await workspace.resolvePath(call.arguments.path, {allowMissing: true});
    const content = call.arguments.content;
    let before = '';
    let exists = true;
    try {
      await stat(path);
      before = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      exists = false;
    }
    const symbols = declarations(content).filter((symbol) => !before.includes(symbol));
    if (!symbols.length && exists) return undefined;
    return {paths: [path], symbols, trigger: exists ? 'new-symbol' : 'new-file'};
  }
  if (call.name === 'apply_patch' && typeof call.arguments.patch === 'string') {
    const patch = call.arguments.patch;
    const paths = await Promise.all(extractPatchPaths(patch).map((path) =>
      workspace.resolvePath(path, {allowMissing: true})));
    const additions = patch.split(/\r?\n/)
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
      .join('\n');
    const existingContent = (await Promise.all(paths.map(async (path) => {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      }
    }))).join('\n');
    const symbols = declarations(additions).filter((symbol) => !existingContent.includes(symbol));
    if (!symbols.length) return undefined;
    const missing = await Promise.all(paths.map(async (path) => {
      try {
        await stat(path);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
      }
    }));
    return {paths, symbols, trigger: missing.some(Boolean) ? 'new-file' : 'new-symbol'};
  }
  return undefined;
}

function declarations(content: string): string[] {
  const symbols: string[] = [];
  for (const match of content.matchAll(DECLARATION)) {
    const symbol = match[1];
    if (symbol && !symbols.includes(symbol)) symbols.push(symbol);
    if (symbols.length >= 16) break;
  }
  return symbols;
}

function isExemptPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLocaleLowerCase();
  if (/(^|\/)(test|tests|__tests__|fixtures|fixture|generated|vendor|dist|build)(\/|$)/.test(normalized)) return true;
  if (/(\.generated|\.min)\.[^.]+$/.test(normalized)) return true;
  const extension = extname(normalized);
  if (SKIPPED_EXTENSIONS.has(extension)) return true;
  return !SOURCE_EXTENSIONS.has(extension);
}

function unresolvedReceipt(
  input: ReuseGateInput,
  queryHash: string,
  targetPaths: string[],
  trigger: ReuseReceipt['trigger'],
  detail: string,
): ReuseReceipt {
  return {
    requestId: input.requestId,
    queryHash,
    targetPaths,
    trigger,
    decision: 'unresolved',
    candidates: [],
    rationale: `Reuse evidence is incomplete: ${detail.slice(0, 240)}`,
    changeSequence: input.changeSequence,
    status: 'unresolved',
    warningOnly: true,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function roundScore(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : 0;
}
