import {readFile, stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import fg from 'fast-glob';
import {z} from 'zod';
import type {ContextHit} from '../types.js';
import type {AgentTool} from './types.js';
import {jsonSchema} from './types.js';
import {isInside, workspaceAliasPath} from '../utils/path.js';

const inputSchema = z.object({
  query: z.string().min(1).max(10_000),
  path: z.string().min(1).optional(),
  pattern: z.string().min(1).optional(),
  mode: z.enum(['text', 'ranked']).optional(),
  literal: z.boolean().optional(),
  case_sensitive: z.boolean().optional(),
  context_lines: z.number().int().min(0).max(20).optional(),
  max_results: z.number().int().min(1).max(500).optional(),
}).strict();

const ignore = [
  '**/.git/**', '**/.mosaic/**', '**/.skein/**', '**/.skein.migrating-*/**', '**/.skein.rollback-*/**', '**/node_modules/**', '**/dist/**',
  '**/build/**', '**/coverage/**', '**/.next/**', '**/vendor/**', '**/target/**',
  '**/*.min.js', '**/*.map',
];

export const searchCodeTool: AgentTool = {
  definition: {
    name: 'search_code',
    description: 'Search workspace code by exact/regex text or local ranked relevance.',
    category: 'read',
    inputSchema: jsonSchema({
      query: {type: 'string'},
      path: {type: 'string', default: '.'},
      pattern: {type: 'string', default: '**/*'},
      mode: {type: 'string', enum: ['text', 'ranked'], default: 'text'},
      literal: {type: 'boolean', default: true},
      case_sensitive: {type: 'boolean', default: false},
      context_lines: {type: 'integer', minimum: 0, maximum: 20, default: 1},
      max_results: {type: 'integer', minimum: 1, maximum: 500, default: 100},
    }, ['query']),
  },

  async execute(arguments_, context) {
    const input = inputSchema.parse(arguments_);
    const directory = await context.workspace.resolveDirectory(input.path ?? '.');
    if ((input.mode ?? 'text') === 'ranked') {
      if (!context.contextEngine) throw new Error('Local ranked retrieval is unavailable.');
      return rankedSearch(input.query, input.max_results ?? 20, directory, context);
    }
    const files = await fg(input.pattern ?? '**/*', {
      cwd: directory,
      onlyFiles: true,
      dot: true,
      unique: true,
      followSymbolicLinks: false,
      ignore,
    });
    const maxResults = input.max_results ?? 100;
    const contextLines = input.context_lines ?? 1;
    const caseSensitive = input.case_sensitive ?? false;
    const matcher = createMatcher(input.query, input.literal ?? true, caseSensitive);
    const results: SearchMatch[] = [];
    let skipped = 0;
    for (const file of files.sort((a, b) => a.localeCompare(b))) {
      if (results.length >= maxResults) break;
      let path: string;
      try {
        path = await context.workspace.resolvePath(resolve(directory, file), {expect: 'file'});
      } catch {
        skipped += 1;
        continue;
      }
      const info = await stat(path);
      if (info.size > 2_000_000) {
        skipped += 1;
        continue;
      }
      const buffer = await readFile(path);
      if (buffer.subarray(0, 8_192).includes(0)) {
        skipped += 1;
        continue;
      }
      const lines = buffer.toString('utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        const column = matcher(line);
        if (column < 0) continue;
        const start = Math.max(0, index - contextLines);
        const end = Math.min(lines.length, index + contextLines + 1);
        results.push({
          path,
          shownPath: workspaceAliasPath(path, context.workspace.roots),
          line: index + 1,
          column: column + 1,
          excerpt: lines.slice(start, end).map((value, offset) =>
            `${String(start + offset + 1).padStart(6)} | ${value}`,
          ).join('\n'),
        });
        if (results.length >= maxResults) break;
      }
    }
    return {
      content: results.length
        ? results.map((item) =>
          `${item.shownPath}:${item.line}:${item.column}\n${item.excerpt}`,
        ).join('\n\n')
        : 'No matches found.',
      metadata: {
        count: results.length,
        scannedFiles: files.length,
        skippedFiles: skipped,
        truncated: results.length >= maxResults,
      },
    };
  },
};

interface SearchMatch {
  path: string;
  shownPath: string;
  line: number;
  column: number;
  excerpt: string;
}

function createMatcher(
  query: string,
  literal: boolean,
  caseSensitive: boolean,
): (line: string) => number {
  if (literal) {
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    return (line) => (caseSensitive ? line : line.toLocaleLowerCase()).indexOf(needle);
  }
  let expression: RegExp;
  try {
    expression = new RegExp(query, caseSensitive ? '' : 'i');
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  return (line) => expression.exec(line)?.index ?? -1;
}

async function rankedSearch(
  query: string,
  limit: number,
  directory: string,
  context: Parameters<AgentTool['execute']>[1],
) {
  const hits = await context.contextEngine?.search(query, limit) ?? [];
  const safe: ContextHit[] = [];
  for (const hit of hits) {
    if (!context.workspace.contains(hit.path)) continue;
    if (!isInside(directory, hit.path)) continue;
    try {
      await context.workspace.resolvePath(hit.path, {expect: 'file'});
      safe.push(hit);
    } catch {
      // A stale local index entry must not cross the workspace boundary.
    }
  }
  return {
    content: safe.length
      ? safe.map((hit) =>
        `${workspaceAliasPath(hit.path, context.workspace.roots)}:${hit.startLine}-${hit.endLine} ` +
        `[score ${hit.score.toFixed(3)}]\n${hit.content}`,
      ).join('\n\n')
      : 'No ranked matches found.',
    metadata: {count: safe.length, engine: safe[0]?.source ?? 'local'},
  };
}
