import {lstat, readFile, stat} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import fg from 'fast-glob';
import {z} from 'zod';
import type {ContextHit, PackedContext} from '../types.js';
import {WorkspaceAccess} from '../tools/workspace.js';
import {atomicWrite} from '../tools/write.js';
import {assertNoSymlinkPath, ensureWorkspaceStorageDirectory} from '../utils/storage.js';
import {workspaceAliasPath} from '../utils/path.js';
import {resolveProjectNamespaceSync} from '../utils/namespace.js';

interface IndexedChunk {
  id: string;
  root: string;
  path: string;
  absolutePath: string;
  startLine: number;
  endLine: number;
  content: string;
  symbol?: string;
  tokens: string[];
}

interface IndexedFile {
  path: string;
  root: string;
  absolutePath: string;
  mtimeMs: number;
  size: number;
  chunks: IndexedChunk[];
}

interface LocalIndexFile {
  version: 1;
  createdAt: string;
  roots: string[];
  files: IndexedFile[];
}

const indexedChunkSchema = z.object({
  id: z.string(),
  root: z.string(),
  path: z.string(),
  absolutePath: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  content: z.string(),
  symbol: z.string().optional(),
  tokens: z.array(z.string()),
}).strict();

const indexedFileSchema = z.object({
  path: z.string(),
  root: z.string(),
  absolutePath: z.string(),
  mtimeMs: z.number(),
  size: z.number().nonnegative(),
  chunks: z.array(indexedChunkSchema),
}).strict();

const localIndexSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  roots: z.array(z.string()),
  files: z.array(indexedFileSchema),
}).strict();

export interface IndexProgress {
  phase: 'scan' | 'index' | 'write';
  completed: number;
  total: number;
  path?: string;
}

const include = [
  '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,kts,rb,php,swift,c,cc,cpp,h,hpp,cs,scala,vue,svelte,html,css,scss,less,sql,graphql,gql,sh,bash,zsh,fish,ps1,json,jsonc,yaml,yml,toml,xml,md,mdx,txt,proto,tf,hcl}',
  '**/{Dockerfile,Makefile,Justfile,Procfile,Rakefile,Gemfile,Cargo.toml,go.mod,go.sum,package.json,tsconfig.json}',
];

const ignorePatterns = [
  '**/.git/**', '**/.mosaic/**', '**/.skein/**', '**/.skein.lock/**', '**/.skein.migrating-*/**', '**/.skein.rollback-*/**', '**/node_modules/**', '**/dist/**',
  '**/build/**', '**/coverage/**', '**/.next/**', '**/.cache/**',
  '**/vendor/**', '**/target/**', '**/*.min.js', '**/*.map',
  '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
];

export class LocalContextIndex {
  private index?: LocalIndexFile;
  private readonly workspace: WorkspaceAccess;
  readonly indexPath: string;

  constructor(private readonly roots: string[]) {
    this.roots = roots.map((root) => resolve(root));
    this.workspace = new WorkspaceAccess(this.roots);
    this.indexPath = join(resolveProjectNamespaceSync(this.roots[0] ?? process.cwd()).active, 'index.json');
  }

  async load(): Promise<boolean> {
    try {
      await assertNoSymlinkPath(
        this.roots[0] ?? process.cwd(),
        dirname(this.indexPath),
      );
      const info = await lstat(this.indexPath);
      if (!info.isFile() || info.isSymbolicLink()) return false;
      const parsed = localIndexSchema.parse(JSON.parse(await readFile(this.indexPath, 'utf8')) as unknown);
      const files: IndexedFile[] = [];
      for (const file of parsed.files) {
        try {
          const safe = await this.workspace.resolvePath(file.absolutePath, {expect: 'file'});
          if (safe !== file.absolutePath) continue;
          files.push({
            ...file,
            chunks: file.chunks
              .filter((chunk) => chunk.absolutePath === file.absolutePath &&
                chunk.root === file.root && chunk.path === file.path)
              .map(({symbol, ...chunk}) => ({
                ...chunk,
                ...(symbol !== undefined ? {symbol} : {}),
              })),
          });
        } catch {
          // Ignore stale or out-of-workspace entries from a tampered index.
        }
      }
      this.index = {...parsed, files};
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      delete this.index;
      return false;
    }
  }

  async build(onProgress?: (progress: IndexProgress) => void): Promise<{
    files: number;
    chunks: number;
    reused: number;
    durationMs: number;
  }> {
    const started = Date.now();
    if (!this.index) await this.load();
    const previous = new Map(
      (this.index?.files ?? []).map((file) => [file.absolutePath, file]),
    );
    const discovered: Array<{root: string; path: string; absolutePath: string}> = [];
    for (const root of this.roots) {
      const paths = await fg(include, {
        cwd: root,
        onlyFiles: true,
        dot: true,
        unique: true,
        followSymbolicLinks: false,
        ignore: ignorePatterns,
      });
      for (const path of paths) {
        discovered.push({root, path, absolutePath: resolve(root, path)});
      }
    }
    discovered.sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));
    onProgress?.({phase: 'scan', completed: discovered.length, total: discovered.length});
    const files: IndexedFile[] = [];
    let reused = 0;
    for (const [index, item] of discovered.entries()) {
      onProgress?.({
        phase: 'index',
        completed: index,
        total: discovered.length,
        path: item.path,
      });
      let safePath: string;
      try {
        safePath = await this.workspace.resolvePath(item.absolutePath, {expect: 'file'});
      } catch {
        continue;
      }
      const info = await stat(safePath);
      if (info.size > 1_500_000) continue;
      const old = previous.get(safePath);
      if (old && old.mtimeMs === info.mtimeMs && old.size === info.size) {
        files.push(old);
        reused += 1;
        continue;
      }
      const content = await readFile(safePath, 'utf8');
      if (content.includes('\u0000')) continue;
      const safeItem = {...item, absolutePath: safePath};
      files.push({
        ...safeItem,
        mtimeMs: info.mtimeMs,
        size: info.size,
        chunks: chunkFile(safeItem, content),
      });
    }
    this.index = {
      version: 1,
      createdAt: new Date().toISOString(),
      roots: this.roots,
      files,
    };
    onProgress?.({phase: 'write', completed: files.length, total: files.length});
    await ensureWorkspaceStorageDirectory(
      this.roots[0] ?? process.cwd(),
      dirname(this.indexPath),
    );
    await atomicWrite(this.indexPath, `${JSON.stringify(this.index)}\n`, 0o600);
    return {
      files: files.length,
      chunks: files.reduce((total, file) => total + file.chunks.length, 0),
      reused,
      durationMs: Date.now() - started,
    };
  }

  async search(query: string, topK = 12): Promise<ContextHit[]> {
    if (!this.index && !(await this.load())) await this.build();
    const chunks = (this.index?.files ?? []).flatMap((file) => file.chunks);
    if (!chunks.length) return [];
    const terms = tokenize(query);
    if (!terms.length) return [];
    const documentFrequency = new Map<string, number>();
    for (const term of new Set(terms)) {
      documentFrequency.set(
        term,
        chunks.reduce((count, chunk) => count + (chunk.tokens.includes(term) ? 1 : 0), 0),
      );
    }
    const averageLength = chunks.reduce((sum, chunk) => sum + chunk.tokens.length, 0)
      / Math.max(chunks.length, 1);
    return chunks
      .map((chunk) => ({chunk, score: scoreChunk(
        chunk,
        terms,
        documentFrequency,
        chunks.length,
        averageLength,
      )}))
      .filter(({score}) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({chunk, score}) => ({
        path: chunk.absolutePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        score,
        source: 'local-bm25+path+symbol',
        ...(chunk.symbol ? {symbol: chunk.symbol} : {}),
      }));
  }

  async pack(query: string, topK: number, maxTokens: number): Promise<PackedContext> {
    const hits = await this.search(query, topK);
    let estimatedTokens = 0;
    let truncated = false;
    const selected: ContextHit[] = [];
    for (const hit of hits) {
      const tokens = Math.ceil(hit.content.length / 4);
      if (estimatedTokens + tokens > maxTokens) {
        const remainingChars = Math.max(0, (maxTokens - estimatedTokens) * 4);
        if (remainingChars > 200) {
          selected.push({...hit, content: hit.content.slice(0, remainingChars)});
          estimatedTokens = maxTokens;
        }
        truncated = true;
        break;
      }
      selected.push(hit);
      estimatedTokens += tokens;
    }
    const text = selected.map((hit) => {
      const shownPath = workspaceAliasPath(hit.path, this.roots);
      return `<code path="${escapeAttribute(shownPath)}" lines="${hit.startLine}-${hit.endLine}" score="${hit.score.toFixed(3)}">\n${hit.content}\n</code>`;
    }).join('\n\n');
    return {text, hits: selected, estimatedTokens, engine: 'local', truncated};
  }

  status(): {available: boolean; path: string; files: number; chunks: number; createdAt?: string} {
    return {
      available: Boolean(this.index),
      path: this.indexPath,
      files: this.index?.files.length ?? 0,
      chunks: this.index?.files.reduce((total, file) => total + file.chunks.length, 0) ?? 0,
      ...(this.index?.createdAt ? {createdAt: this.index.createdAt} : {}),
    };
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/g, (character) => ({
    '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;',
  })[character] ?? character);
}

function chunkFile(
  file: {root: string; path: string; absolutePath: string},
  content: string,
): IndexedChunk[] {
  const lines = content.split('\n');
  const chunks: IndexedChunk[] = [];
  const size = 100;
  const overlap = 15;
  for (let start = 0; start < lines.length; start += size - overlap) {
    const end = Math.min(lines.length, start + size);
    const chunkContent = lines.slice(start, end).join('\n');
    const symbol = detectSymbol(lines.slice(start, Math.min(end, start + 20)));
    chunks.push({
      id: `${file.absolutePath}:${start + 1}`,
      ...file,
      startLine: start + 1,
      endLine: end,
      content: chunkContent,
      ...(symbol ? {symbol} : {}),
      tokens: tokenize(`${file.path} ${symbol ?? ''} ${chunkContent}`),
    });
    if (end === lines.length) break;
  }
  return chunks;
}

function detectSymbol(lines: string[]): string | undefined {
  const patterns = [
    /(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([\w$]+)/,
    /(?:def|class)\s+([\w_]+)/,
    /(?:func|type)\s+([\w_]+)/,
    /(?:const|let|var)\s+([\w$]+)\s*=/,
  ];
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match?.[1]) return match[1];
    }
  }
  return undefined;
}

export function tokenize(input: string): string[] {
  const normalized = input
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLocaleLowerCase();
  const base = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const output = new Set(base.flatMap((token) => [token, ...token.split(/[_-]/)]));
  for (const token of base) {
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length > 1) {
      for (let index = 0; index < token.length - 1; index += 1) {
        output.add(token.slice(index, index + 2));
      }
    }
  }
  return [...output].filter((token) => token.length > 1);
}

function scoreChunk(
  chunk: IndexedChunk,
  terms: string[],
  documentFrequency: Map<string, number>,
  documentCount: number,
  averageLength: number,
): number {
  const frequencies = new Map<string, number>();
  for (const token of chunk.tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const term of terms) {
    const frequency = frequencies.get(term) ?? 0;
    if (!frequency) continue;
    const df = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
    score += idf * ((frequency * (k1 + 1)) /
      (frequency + k1 * (1 - b + b * chunk.tokens.length / averageLength)));
    if (chunk.path.toLocaleLowerCase().includes(term)) score += 1.5;
    if (chunk.symbol?.toLocaleLowerCase().includes(term)) score += 2.5;
  }
  const queryPhrase = terms.join(' ');
  if (queryPhrase.length > 3 && chunk.content.toLocaleLowerCase().includes(queryPhrase)) {
    score += 3;
  }
  return score;
}

export function defaultIndexName(root: string): string {
  return basename(root) || 'workspace';
}
