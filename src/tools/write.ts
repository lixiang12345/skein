import {randomUUID} from 'node:crypto';
import {chmod, lstat, readFile, rename, stat, unlink, writeFile} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {z} from 'zod';
import type {AgentTool} from './types.js';
import {jsonSchema} from './types.js';

const inputSchema = z.object({
  path: z.string().min(1),
  content: z.string().max(10_000_000),
  overwrite: z.boolean().optional(),
  expected_content: z.string().max(10_000_000).optional(),
}).strict();

export const writeFileTool: AgentTool = {
  definition: {
    name: 'write_file',
    description: 'Atomically create or replace a UTF-8 file inside the workspace.',
    category: 'write',
    inputSchema: jsonSchema({
      path: {type: 'string'},
      content: {type: 'string'},
      overwrite: {type: 'boolean', default: true},
      expected_content: {
        type: 'string',
        description: 'Optional optimistic-lock value; writing fails if the current file differs.',
      },
    }, ['path', 'content']),
  },

  async affectedPaths(arguments_, context) {
    const input = inputSchema.parse(arguments_);
    return [await context.workspace.resolvePath(input.path, {allowMissing: true})];
  },

  async execute(arguments_, context) {
    const input = inputSchema.parse(arguments_);
    const path = await context.workspace.resolvePath(input.path, {allowMissing: true});
    const existed = await exists(path);
    if (existed && input.overwrite === false) throw new Error(`File already exists: ${input.path}`);
    if (input.expected_content !== undefined) {
      const current = existed ? await readFile(path, 'utf8') : undefined;
      if (current !== input.expected_content) {
        throw new Error('File changed since it was read; expected_content did not match.');
      }
    }
    await context.workspace.ensureParent(path);
    await context.workspace.assertWritableFile(path);
    if (existed && (await lstat(path)).isSymbolicLink()) {
      throw new Error(`Refusing to replace a symbolic link: ${input.path}`);
    }
    const previousMode = existed ? (await stat(path)).mode : undefined;
    await atomicWrite(path, input.content, previousMode);
    return {
      content: `${existed ? 'Updated' : 'Created'} ${context.workspace.display(path)} (${Buffer.byteLength(input.content)} bytes).`,
      metadata: {path, bytes: Buffer.byteLength(input.content), created: !existed},
      changedFiles: [path],
    };
  },
};

export async function atomicWrite(
  path: string,
  content: string | Uint8Array,
  mode?: number,
): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, {flag: 'wx', ...(mode !== undefined ? {mode} : {})});
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
