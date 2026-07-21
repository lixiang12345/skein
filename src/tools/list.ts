import {lstat} from 'node:fs/promises';
import {relative, resolve} from 'node:path';
import fg from 'fast-glob';
import {z} from 'zod';
import type {AgentTool} from './types.js';
import {jsonSchema} from './types.js';
import {workspaceAliasPath} from '../utils/path.js';

const inputSchema = z.object({
  path: z.string().min(1).optional(),
  pattern: z.string().min(1).optional(),
  depth: z.number().int().min(1).max(20).optional(),
  include_hidden: z.boolean().optional(),
  include_directories: z.boolean().optional(),
  limit: z.number().int().min(1).max(5_000).optional(),
}).strict();

const ignored = [
  '**/.git/**', '**/.mosaic/**', '**/node_modules/**', '**/dist/**',
  '**/build/**', '**/coverage/**', '**/.next/**', '**/target/**',
];

export const listFilesTool: AgentTool = {
  definition: {
    name: 'list_files',
    description: 'List files (and optionally directories) under a workspace directory using a glob.',
    category: 'read',
    inputSchema: jsonSchema({
      path: {type: 'string', default: '.', description: 'Directory inside the workspace.'},
      pattern: {type: 'string', default: '**/*', description: 'Glob relative to path.'},
      depth: {type: 'integer', minimum: 1, maximum: 20, default: 6},
      include_hidden: {type: 'boolean', default: false},
      include_directories: {type: 'boolean', default: false},
      limit: {type: 'integer', minimum: 1, maximum: 5000, default: 500},
    }),
  },

  async execute(arguments_, context) {
    const input = inputSchema.parse(arguments_);
    const directory = await context.workspace.resolveDirectory(input.path ?? '.');
    const limit = input.limit ?? 500;
    const paths = await fg(input.pattern ?? '**/*', {
      cwd: directory,
      onlyFiles: !(input.include_directories ?? false),
      onlyDirectories: false,
      dot: input.include_hidden ?? false,
      deep: input.depth ?? 6,
      unique: true,
      followSymbolicLinks: false,
      ignore: ignored,
    });
    paths.sort((a, b) => a.localeCompare(b));
    const selected = paths.slice(0, limit);
    const rendered: string[] = [];
    for (const path of selected) {
      let safePath: string;
      try {
        safePath = await context.workspace.resolvePath(resolve(directory, path), {expect: 'any'});
      } catch {
        continue;
      }
      const info = await lstat(safePath);
      rendered.push(`${info.isDirectory() ? 'd' : 'f'} ${relative(directory, safePath)}${info.isDirectory() ? '/' : ''}`);
    }
    const base = workspaceAliasPath(directory, context.workspace.roots);
    return {
      content: rendered.length ? rendered.join('\n') : `No entries found under ${base}.`,
      metadata: {
        directory,
        count: selected.length,
        totalMatched: paths.length,
        truncated: paths.length > selected.length,
      },
    };
  },
};
