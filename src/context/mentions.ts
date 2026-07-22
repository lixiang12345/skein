import {readFile, stat} from 'node:fs/promises';
import {isAbsolute, resolve} from 'node:path';
import fg from 'fast-glob';
import type {ContextHit} from '../types.js';
import {WorkspaceAccess} from '../tools/workspace.js';
import {isInside, workspaceAliasPath} from '../utils/path.js';

export interface ResolvedMention {
  mention: string;
  path: string;
  content: string;
  truncated: boolean;
}

export interface ActiveMentionToken {
  start: number;
  end: number;
  cursor: number;
  query: string;
}

export interface MentionReplacement {
  value: string;
  cursor: number;
}

export interface MentionIndexOptions {
  ignore?: string[];
}

const defaultMentionIgnores = [
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/.mosaic/**', '**/.skein/**', '**/.skein.migrating-*/**', '**/.skein.rollback-*/**',
];

const mentionIndexCache = new Map<string, Promise<MentionPathIndex>>();

const mentionPattern = /(?:^|\s)@([^\s,;]+)/g;

export function parseMentions(input: string): string[] {
  const matches = [...input.matchAll(mentionPattern)];
  return [...new Set(matches.map((match) =>
    (match[1] ?? '').replace(/[.!?)\]}]+$/, ''),
  ).filter(Boolean))];
}

/** Finds the mention token intersecting the cursor, using UTF-16 offsets. */
export function activeMentionToken(
  input: string,
  cursor = input.length,
): ActiveMentionToken | undefined {
  const safeCursor = Math.max(0, Math.min(cursor, input.length));
  const prefix = input.slice(0, safeCursor);
  const match = /(?:^|\s)@([^\s,;\)\]\}]*)$/.exec(prefix);
  if (!match) return undefined;

  const at = prefix.lastIndexOf('@');
  if (at < 0) return undefined;
  let end = safeCursor;
  while (end < input.length && !/[\s,;\)\]\}]/.test(input[end] ?? '')) end += 1;
  return {
    start: at,
    end,
    cursor: safeCursor,
    query: input.slice(at + 1, safeCursor),
  };
}

export function replaceActiveMentionToken(
  input: string,
  suggestion: string,
  cursor = input.length,
  options: {appendSpace?: boolean} = {},
): MentionReplacement | undefined {
  const token = activeMentionToken(input, cursor);
  const clean = normalizeMentionCandidate(suggestion.replace(/^@/, ''));
  if (!token || !clean) return undefined;

  const suffix = input.slice(token.end);
  const appendSpace = options.appendSpace ?? true;
  const separator = appendSpace && (!suffix || !/^[\s,;\)\]\}]/.test(suffix)) ? ' ' : '';
  const inserted = `@${clean}${separator}`;
  return {
    value: `${input.slice(0, token.start)}${inserted}${suffix}`,
    cursor: token.start + inserted.length,
  };
}

export async function resolveMentions(
  input: string,
  roots: string[],
  maxChars = 80_000,
): Promise<ResolvedMention[]> {
  const mentions = parseMentions(input);
  const results: ResolvedMention[] = [];
  const workspace = new WorkspaceAccess(roots);
  let remaining = maxChars;
  for (const mention of mentions) {
    if (remaining <= 0) break;
    const clean = mention.replace(/^['"]|['"]$/g, '');
    let matched: string[] = [];
    if (/^(?:main|workspace\d+)(?:[\\/]|$)/i.test(clean)) {
      try {
        const aliased = await workspace.resolvePath(clean);
        const info = await stat(aliased);
        if (info.isFile()) matched.push(aliased);
        else if (info.isDirectory()) {
          const children = await fg('**/*', {
            cwd: aliased,
            onlyFiles: true,
            dot: true,
            followSymbolicLinks: false,
            ignore: ['**/.git/**', '**/node_modules/**', '**/dist/**', '**/.mosaic/**', '**/.skein/**', '**/.skein.migrating-*/**', '**/.skein.rollback-*/**'],
          });
          matched.push(...await safeMentionPaths(
            children.slice(0, 25).map((path) => resolve(aliased, path)),
            workspace,
          ));
        }
      } catch {
        // Invalid aliases are ignored just like missing ordinary mentions.
      }
    }
    for (const root of matched.length ? [] : roots) {
      const direct = resolve(root, clean);
      try {
        const safeDirect = await workspace.resolvePath(direct);
        const info = await stat(safeDirect);
        if (info.isFile()) matched.push(safeDirect);
        else if (info.isDirectory()) {
          const children = await fg('**/*', {
            cwd: safeDirect,
            onlyFiles: true,
            dot: true,
            followSymbolicLinks: false,
            ignore: ['**/.git/**', '**/node_modules/**', '**/dist/**', '**/.mosaic/**', '**/.skein/**', '**/.skein.migrating-*/**', '**/.skein.rollback-*/**'],
          });
          matched.push(...await safeMentionPaths(
            children.slice(0, 25).map((path) => resolve(safeDirect, path)),
            workspace,
          ));
        }
        continue;
      } catch {
        // A direct miss may still be a glob; unsafe paths are ignored.
      }
      if (/[*?\[\]{}]/.test(clean)) {
        const globbed = await fg(clean, {
          cwd: root,
          onlyFiles: true,
          dot: true,
          followSymbolicLinks: false,
            ignore: ['**/.git/**', '**/node_modules/**', '**/dist/**', '**/.mosaic/**', '**/.skein/**', '**/.skein.migrating-*/**', '**/.skein.rollback-*/**'],
        });
        matched.push(...await safeMentionPaths(
          globbed.slice(0, 25).map((path) => resolve(root, path)),
          workspace,
        ));
      }
    }
    for (const path of [...new Set(matched)]) {
      if (remaining <= 0) break;
      const raw = await readFile(path, 'utf8');
      const content = raw.slice(0, remaining);
      results.push({mention, path, content, truncated: content.length < raw.length});
      remaining -= content.length;
    }
  }
  return results;
}

async function safeMentionPaths(
  paths: string[],
  workspace: WorkspaceAccess,
): Promise<string[]> {
  const safe: string[] = [];
  for (const path of paths) {
    try {
      safe.push(await workspace.resolvePath(path, {expect: 'file'}));
    } catch {
      // Ignore stale or symlink-escaped glob results.
    }
  }
  return safe;
}

export function formatMentionContext(
  mentions: ResolvedMention[],
  primaryRoot: string,
  roots: string[] = [primaryRoot],
): string {
  return mentions.map((item) =>
    `<mentioned-file path="${escapeAttribute(workspaceAliasPath(item.path, roots))}"${item.truncated ? ' truncated="true"' : ''}>\n${item.content}\n</mentioned-file>`,
  ).join('\n\n');
}

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/g, (character) => ({
    '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;',
  })[character] ?? character);
}

export async function mentionSuggestions(
  partial: string,
  root: string | string[],
  limit = 6,
): Promise<string[]> {
  return (await getMentionPathIndex(root)).suggest(partial, limit);
}

export class MentionPathIndex {
  readonly roots: readonly string[];
  readonly paths: readonly string[];

  constructor(roots: readonly string[], paths: readonly string[]) {
    this.roots = Object.freeze([...roots]);
    this.paths = Object.freeze(dedupeMentionCandidates(paths));
  }

  suggest(partial: string, limit = 6): string[] {
    return rankMentionSuggestions(this.paths, partial, limit);
  }
}

export async function buildMentionPathIndex(
  roots: string | readonly string[],
  options: MentionIndexOptions = {},
): Promise<MentionPathIndex> {
  const normalizedRoots = normalizeRoots(roots);
  if (!normalizedRoots.length) throw new Error('At least one workspace root is required.');
  const ignore = options.ignore ?? defaultMentionIgnores;
  const filesByRoot = await Promise.all(normalizedRoots.map(async (root) => ({
    root,
    files: await fg('**/*', {
      cwd: root,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
      ignore,
    }),
  })));
  const paths = filesByRoot.flatMap(({root, files}) => files.map((path) =>
    workspaceAliasPath(resolve(root, path), normalizedRoots),
  ));
  return new MentionPathIndex(normalizedRoots, paths);
}

export function getMentionPathIndex(
  roots: string | readonly string[],
): Promise<MentionPathIndex> {
  const normalizedRoots = normalizeRoots(roots);
  const key = normalizedRoots.join('\0');
  let cached = mentionIndexCache.get(key);
  if (!cached) {
    cached = buildMentionPathIndex(normalizedRoots);
    mentionIndexCache.set(key, cached);
    cached.catch(() => mentionIndexCache.delete(key));
  }
  return cached;
}

/** Invalidate after file-creating or file-removing tool calls. */
export function invalidateMentionPathIndex(
  roots?: string | readonly string[],
): void {
  if (!roots) {
    mentionIndexCache.clear();
    return;
  }
  mentionIndexCache.delete(normalizeRoots(roots).join('\0'));
}

/**
 * ContextEngine returns already realpath-validated hits. This adds a final
 * lexical boundary check, maps them to stable aliases, deduplicates, and ranks.
 */
export function contextHitMentionSuggestions(
  hits: readonly Pick<ContextHit, 'path'>[],
  roots: readonly string[],
  partial: string,
  limit = 6,
): string[] {
  return rankMentionSuggestions(
    hits.map((hit) => mapMentionCandidatePath(hit.path, roots))
      .filter((path): path is string => path !== undefined),
    partial,
    limit,
  );
}

export function mapMentionCandidatePath(
  path: string,
  roots: readonly string[],
): string | undefined {
  const normalizedRoots = normalizeRoots(roots);
  const primary = normalizedRoots[0];
  if (!primary || !path || path.includes('\0')) return undefined;

  let candidate: string;
  if (isAbsolute(path)) {
    candidate = resolve(path);
  } else {
    const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
    const [first = '', ...rest] = normalized.split('/');
    const alias = first.toLocaleLowerCase();
    const workspace = alias.match(/^workspace(\d+)$/);
    if (alias === 'main') {
      candidate = resolve(primary, ...rest);
    } else if (workspace) {
      const index = Number(workspace[1]) - 1;
      const root = Number.isSafeInteger(index) && index >= 1
        ? normalizedRoots[index]
        : undefined;
      if (!root) return undefined;
      candidate = resolve(root, ...rest);
    } else {
      candidate = resolve(primary, normalized);
    }
  }
  if (!normalizedRoots.some((root) => isInside(root, candidate))) return undefined;

  const mapped = workspaceAliasPath(candidate, normalizedRoots);
  if (mapped === '.' || /^(?:main|workspace\d+)$/i.test(mapped)) return undefined;
  return normalizeMentionCandidate(mapped);
}

export function rankMentionSuggestions(
  candidates: readonly string[],
  partial: string,
  limit = 6,
): string[] {
  const needle = normalizeForMatch(partial.replace(/^@/, ''));
  if (!Number.isFinite(limit) || limit <= 0) return [];
  return dedupeMentionCandidates(candidates)
    .map((path) => ({path, score: rankMention(path, needle)}))
    .filter((candidate) => candidate.score < Number.POSITIVE_INFINITY)
    .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
    .slice(0, Math.floor(limit))
    .map(({path}) => path);
}

function rankMention(path: string, needle: string): number {
  const lower = normalizeForMatch(path);
  const basename = lower.slice(lower.lastIndexOf('/') + 1);
  const segments = lower.split('/');
  if (!needle) return segments.length * 100 + lower.length;
  if (lower === needle) return 0;
  if (basename === needle) return 10 + lower.length;
  if (basename.startsWith(needle)) return 100 + basename.length + lower.length / 1_000;
  if (segments.some((segment) => segment.startsWith(needle))) {
    return 200 + lower.indexOf(needle) + lower.length / 1_000;
  }
  if (lower.startsWith(needle)) return 300 + lower.length;
  const index = lower.indexOf(needle);
  return index < 0 ? Number.POSITIVE_INFINITY : 1_000 + index * 10 + lower.length;
}

function normalizeRoots(roots: string | readonly string[]): string[] {
  const values = typeof roots === 'string' ? [roots] : roots;
  return [...new Set(values.map((root) => resolve(root)))];
}

function normalizeMentionCandidate(path: string): string | undefined {
  const normalized = path.replaceAll('\\', '/').normalize('NFC');
  if (!normalized || /[\0-\x1f\x7f\s,;]/.test(normalized)) return undefined;
  return normalized;
}

function dedupeMentionCandidates(candidates: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeMentionCandidate(candidate.replace(/^@/, ''));
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeForMatch(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase();
}
