import {createHash} from 'node:crypto';
import {lstat, readFile, stat} from 'node:fs/promises';
import {basename, dirname, extname, join, resolve} from 'node:path';
import fg from 'fast-glob';
import {z} from 'zod';
import type {ContextHit, PackedContext} from '../types.js';
import {WorkspaceAccess} from '../tools/workspace.js';
import {atomicWrite} from '../tools/write.js';
import {assertNoSymlinkPath, ensureWorkspaceStorageDirectory} from '../utils/storage.js';
import {workspaceAliasPath} from '../utils/path.js';
import {
  assertActiveProjectNamespacePath,
  projectNamespacePaths,
  resolveProjectNamespaceSync,
} from '../utils/namespace.js';
import {withNamespaceLease} from '../utils/namespace-lease.js';

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
  contentHash: string;
  chunks: IndexedChunk[];
}

interface LocalIndexFile {
  version: 2;
  createdAt: string;
  generation: string;
  roots: string[];
  files: IndexedFile[];
}

interface DiscoveredFile {
  root: string;
  path: string;
  absolutePath: string;
}

interface FileFingerprint {
  mtimeMs: number;
  size: number;
}

const contentHashSchema = z.string().regex(/^[a-f\d]{64}$/u);

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
  contentHash: contentHashSchema,
  chunks: z.array(indexedChunkSchema),
}).strict();

const localIndexSchema = z.object({
  version: z.literal(2),
  createdAt: z.string(),
  generation: z.string().min(1),
  roots: z.array(z.string()),
  files: z.array(indexedFileSchema),
}).strict();

export interface IndexProgress {
  phase: 'inspect' | 'scan' | 'index' | 'write' | 'validate' | 'done';
  completed: number;
  total: number;
  path?: string;
}

export interface LocalIndexStatus {
  available: boolean;
  path: string;
  files: number;
  chunks: number;
  queryCacheEntries: number;
  createdAt?: string;
  generation?: string;
}

export interface IndexBuildResult {
  files: number;
  chunks: number;
  reused: number;
  durationMs: number;
  generation: string;
}

export interface IndexPreparationResult extends IndexBuildResult {
  rebuilt: boolean;
  validated: true;
  path: string;
}

const include = [
  '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,kts,rb,php,swift,c,cc,cpp,h,hpp,cs,scala,vue,svelte,html,css,scss,less,sql,graphql,gql,sh,bash,zsh,fish,ps1,json,jsonc,yaml,yml,toml,xml,md,mdx,txt,proto,tf,hcl}',
  '**/{Dockerfile,Makefile,Justfile,Procfile,Rakefile,Gemfile,Cargo.toml,go.mod,go.sum,package.json,tsconfig.json}',
];

const ignorePatterns = [
  '**/.git/**', '**/.mosaic/**', '**/.skein/**', '**/.skein.migrating-*/**', '**/.skein.rollback-*/**', '**/node_modules/**', '**/dist/**',
  '**/build/**', '**/coverage/**', '**/.next/**', '**/.cache/**',
  '**/vendor/**', '**/target/**', '**/*.min.js', '**/*.map',
  '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
];

const MAX_FILE_BYTES = 1_500_000;
const MAX_QUERY_CACHE_ENTRIES = 64;
const CHUNK_LINES = 100;
const CHUNK_OVERLAP = 15;
const MIN_STRUCTURAL_CHUNK_LINES = 12;

export class LocalContextIndex {
  private index?: LocalIndexFile;
  private readonly workspace: WorkspaceAccess;
  private readonly queryCache = new Map<string, ContextHit[]>();
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
          if (!this.roots.includes(file.root) || resolve(file.root, file.path) !== file.absolutePath) continue;
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
      this.queryCache.clear();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      delete this.index;
      this.queryCache.clear();
      return false;
    }
  }

  async build(onProgress?: (progress: IndexProgress) => void): Promise<IndexBuildResult> {
    return this.buildWithOptions(onProgress, false);
  }

  async prepare(
    onProgress?: (progress: IndexProgress) => void,
    forceBuild = false,
  ): Promise<IndexPreparationResult> {
    const started = Date.now();
    onProgress?.({phase: 'inspect', completed: 0, total: 0});
    const loaded = await this.load();
    let shouldBuild = forceBuild || !loaded || await this.manifestChanged();
    let rebuildWithHashes = false;
    let existingValidated = false;
    if (!shouldBuild) {
      existingValidated = await this.validateLoadedIndex(onProgress);
      if (!existingValidated) {
        shouldBuild = true;
        rebuildWithHashes = true;
      }
    }
    const result = shouldBuild
      ? await this.buildWithOptions((progress) => {
        if (progress.phase !== 'done') onProgress?.(progress);
      }, rebuildWithHashes)
      : existingBuildResult(this.status(), started);

    // Reload the persisted artifact instead of trusting the in-memory build.
    // This catches failed/truncated writes and schema or workspace-boundary drift
    // before the user starts a conversation.
    if (shouldBuild && !(await this.load())) {
      throw new Error('The local context index could not be reloaded after preparation.');
    }
    const status = this.status();
    if (!status.available || !status.generation) {
      throw new Error('The local context index did not report a valid generation.');
    }
    if (status.generation !== result.generation || status.files !== result.files || status.chunks !== result.chunks) {
      throw new Error('The persisted local context index does not match the prepared workspace snapshot.');
    }
    if (!existingValidated && !(await this.validateLoadedIndex(onProgress))) {
      throw new Error('The persisted local context index failed content and chunk validation.');
    }
    if (await this.manifestChanged()) {
      throw new Error('The workspace changed while its local context index was being validated. Retry preparation.');
    }
    onProgress?.({phase: 'done', completed: status.files, total: status.files});
    return {
      ...result,
      rebuilt: shouldBuild,
      validated: true,
      path: status.path,
    };
  }

  async search(query: string, topK = 12): Promise<ContextHit[]> {
    await this.ensureCurrentIndex();
    const limit = Math.max(1, Math.floor(topK));
    let hits = this.getCachedHits(query, limit) ?? this.rank(query, limit);
    if (!(await this.hitsAreCurrent(hits))) {
      // A candidate may change without a reliable mtime/size signal. Rehashing
      // the full manifest once keeps stale bytes out of both cache and prompts.
      await this.buildWithOptions(undefined, true);
      hits = this.rank(query, limit);
      if (!(await this.hitsAreCurrent(hits))) return [];
    }
    this.cacheHits(query, limit, hits);
    return cloneHits(hits);
  }

  async pack(query: string, topK: number, maxTokens: number): Promise<PackedContext> {
    const hits = await this.search(query, topK);
    return packContextHits(hits, this.roots, maxTokens, 'local');
  }

  status(): LocalIndexStatus {
    return {
      available: Boolean(this.index),
      path: this.indexPath,
      files: this.index?.files.length ?? 0,
      chunks: this.index?.files.reduce((total, file) => total + file.chunks.length, 0) ?? 0,
      queryCacheEntries: this.queryCache.size,
      ...(this.index?.createdAt ? {createdAt: this.index.createdAt} : {}),
      ...(this.index?.generation ? {generation: this.index.generation} : {}),
    };
  }

  private async buildWithOptions(
    onProgress: ((progress: IndexProgress) => void) | undefined,
    verifyContentHashes: boolean,
  ): Promise<IndexBuildResult> {
    const workspace = this.roots[0] ?? process.cwd();
    return withNamespaceLease(projectNamespacePaths(workspace).canonical, 'shared', async () => {
      assertActiveProjectNamespacePath(workspace, dirname(this.indexPath));
      return this.buildUnlocked(onProgress, verifyContentHashes);
    });
  }

  private async buildUnlocked(
    onProgress: ((progress: IndexProgress) => void) | undefined,
    verifyContentHashes: boolean,
  ): Promise<IndexBuildResult> {
    const started = Date.now();
    if (!this.index) await this.load();
    const previous = new Map(
      (this.index?.files ?? []).map((file) => [file.absolutePath, file]),
    );
    const discovered = await this.discoverFiles();
    onProgress?.({phase: 'scan', completed: discovered.length, total: discovered.length});
    const files: IndexedFile[] = [];
    const seen = new Set<string>();
    let reused = 0;
    for (const [index, item] of discovered.entries()) {
      onProgress?.({
        phase: 'index',
        completed: index,
        total: discovered.length,
        path: item.path,
      });
      let safePath: string;
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        safePath = await this.workspace.resolvePath(item.absolutePath, {expect: 'file'});
        if (seen.has(safePath)) continue;
        seen.add(safePath);
        info = await stat(safePath);
      } catch {
        continue;
      }
      if (info.size > MAX_FILE_BYTES) continue;
      const old = previous.get(safePath);
      if (old && !verifyContentHashes && old.mtimeMs === info.mtimeMs && old.size === info.size) {
        files.push(old);
        reused += 1;
        continue;
      }
      let content: string;
      try {
        content = await readFile(safePath, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\u0000')) continue;
      const contentHash = hashContent(content);
      const safeItem = {...item, absolutePath: safePath};
      if (old && !verifyContentHashes && old.contentHash === contentHash) {
        files.push({
          ...old,
          ...safeItem,
          mtimeMs: info.mtimeMs,
          size: info.size,
          contentHash,
          chunks: old.chunks.map((chunk) => ({
            ...chunk,
            root: safeItem.root,
            path: safeItem.path,
            absolutePath: safePath,
          })),
        });
        reused += 1;
        continue;
      }
      files.push({
        ...safeItem,
        mtimeMs: info.mtimeMs,
        size: info.size,
        contentHash,
        chunks: chunkFile(safeItem, content),
      });
    }
    const generation = createGeneration(files);
    this.index = {
      version: 2,
      createdAt: new Date().toISOString(),
      generation,
      roots: this.roots,
      files,
    };
    this.queryCache.clear();
    onProgress?.({phase: 'write', completed: files.length, total: files.length});
    await ensureWorkspaceStorageDirectory(
      this.roots[0] ?? process.cwd(),
      dirname(this.indexPath),
      {requireActiveNamespace: true},
    );
    await atomicWrite(this.indexPath, `${JSON.stringify(this.index)}\n`, 0o600);
    onProgress?.({phase: 'done', completed: files.length, total: files.length});
    return {
      files: files.length,
      chunks: files.reduce((total, file) => total + file.chunks.length, 0),
      reused,
      durationMs: Date.now() - started,
      generation,
    };
  }

  private async ensureCurrentIndex(): Promise<void> {
    if (!this.index && !(await this.load())) {
      await this.build();
      return;
    }
    if (await this.manifestChanged()) await this.build();
  }

  private async manifestChanged(): Promise<boolean> {
    const current = new Map<string, FileFingerprint>();
    for (const item of await this.discoverFiles()) {
      try {
        const safePath = await this.workspace.resolvePath(item.absolutePath, {expect: 'file'});
        const info = await stat(safePath);
        if (info.size <= MAX_FILE_BYTES) current.set(safePath, {mtimeMs: info.mtimeMs, size: info.size});
      } catch {
        // Inaccessible paths are omitted and cause an existing entry to refresh.
      }
    }
    const indexed = this.index?.files ?? [];
    if (current.size !== indexed.length) return true;
    return indexed.some((file) => {
      const actual = current.get(file.absolutePath);
      return !actual || actual.mtimeMs !== file.mtimeMs || actual.size !== file.size;
    });
  }

  private async validateLoadedIndex(onProgress?: (progress: IndexProgress) => void): Promise<boolean> {
    const index = this.index;
    if (!index || index.roots.length !== this.roots.length ||
      index.roots.some((root, position) => root !== this.roots[position]) ||
      createGeneration(index.files) !== index.generation) return false;
    const total = index.files.length;
    onProgress?.({phase: 'validate', completed: 0, total});
    for (const [position, file] of index.files.entries()) {
      onProgress?.({phase: 'validate', completed: position, total, path: file.path});
      try {
        const safePath = await this.workspace.resolvePath(file.absolutePath, {expect: 'file'});
        if (safePath !== file.absolutePath) return false;
        const content = await readFile(safePath, 'utf8');
        if (content.includes('\u0000') || hashContent(content) !== file.contentHash) return false;
        const expectedChunks = chunkFile({
          root: file.root,
          path: file.path,
          absolutePath: file.absolutePath,
        }, content);
        if (!chunksMatch(expectedChunks, file.chunks)) return false;
      } catch {
        return false;
      }
    }
    onProgress?.({phase: 'validate', completed: total, total});
    return true;
  }

  private async discoverFiles(): Promise<DiscoveredFile[]> {
    const discovered: DiscoveredFile[] = [];
    for (const root of this.roots) {
      const paths = await fg(include, {
        cwd: root,
        onlyFiles: true,
        dot: true,
        unique: true,
        followSymbolicLinks: false,
        ignore: ignorePatterns,
      });
      for (const path of paths) discovered.push({root, path, absolutePath: resolve(root, path)});
    }
    discovered.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
    return discovered;
  }

  private rank(query: string, topK: number): ContextHit[] {
    const chunks = (this.index?.files ?? []).flatMap((file) => file.chunks);
    if (!chunks.length) return [];
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const queryTerms = new Set(terms);
    const documentFrequency = new Map([...queryTerms].map((term) => [term, 0]));
    for (const chunk of chunks) {
      for (const term of new Set(chunk.tokens)) {
        if (queryTerms.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
    const averageLength = chunks.reduce((sum, chunk) => sum + chunk.tokens.length, 0)
      / Math.max(chunks.length, 1);
    return chunks
      .map((chunk) => ({chunk, score: scoreChunk(
        chunk,
        terms,
        query,
        documentFrequency,
        chunks.length,
        averageLength,
      )}))
      .filter(({score}) => score > 0)
      .sort((left, right) => right.score - left.score || left.chunk.absolutePath.localeCompare(right.chunk.absolutePath))
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

  private async hitsAreCurrent(hits: ContextHit[]): Promise<boolean> {
    const files = new Map((this.index?.files ?? []).map((file) => [file.absolutePath, file]));
    for (const hit of hits) {
      const indexed = files.get(hit.path);
      if (!indexed) return false;
      try {
        const safePath = await this.workspace.resolvePath(hit.path, {expect: 'file'});
        if (safePath !== hit.path) return false;
        const content = await readFile(safePath, 'utf8');
        if (content.includes('\u0000') || hashContent(content) !== indexed.contentHash) return false;
        const lines = content.split('\n');
        if (hit.startLine < 1 || hit.endLine < hit.startLine || hit.endLine > lines.length) return false;
        const currentChunk = lines.slice(hit.startLine - 1, hit.endLine).join('\n');
        if (currentChunk !== hit.content) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private getCachedHits(query: string, topK: number): ContextHit[] | undefined {
    const generation = this.index?.generation;
    if (!generation) return undefined;
    const key = `${generation}\u0000${topK}\u0000${query}`;
    const cached = this.queryCache.get(key);
    if (!cached) return undefined;
    this.queryCache.delete(key);
    this.queryCache.set(key, cached);
    return cloneHits(cached);
  }

  private cacheHits(query: string, topK: number, hits: ContextHit[]): void {
    const generation = this.index?.generation;
    if (!generation) return;
    const key = `${generation}\u0000${topK}\u0000${query}`;
    this.queryCache.delete(key);
    this.queryCache.set(key, cloneHits(hits));
    while (this.queryCache.size > MAX_QUERY_CACHE_ENTRIES) {
      const oldest = this.queryCache.keys().next().value;
      if (oldest === undefined) break;
      this.queryCache.delete(oldest);
    }
  }
}

function chunksMatch(expected: IndexedChunk[], actual: IndexedChunk[]): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((chunk, index) => {
    const candidate = actual[index];
    return Boolean(candidate) && chunk.id === candidate?.id && chunk.root === candidate.root &&
      chunk.path === candidate.path && chunk.absolutePath === candidate.absolutePath &&
      chunk.startLine === candidate.startLine && chunk.endLine === candidate.endLine &&
      chunk.content === candidate.content && chunk.symbol === candidate.symbol &&
      chunk.tokens.length === candidate.tokens.length &&
      chunk.tokens.every((token, tokenIndex) => token === candidate.tokens[tokenIndex]);
  });
}

function existingBuildResult(status: LocalIndexStatus, started: number): IndexBuildResult {
  if (!status.available || !status.generation) {
    throw new Error('The existing local context index is unavailable.');
  }
  return {
    files: status.files,
    chunks: status.chunks,
    reused: status.files,
    durationMs: Date.now() - started,
    generation: status.generation,
  };
}

export function packContextHits(
  hits: ContextHit[],
  roots: string[],
  maxTokens: number,
  engine: string,
): PackedContext {
  const selected: ContextHit[] = [];
  const perFile = new Map<string, number>();
  const uniquePaths = new Set(hits.map((hit) => hit.path)).size;
  let estimatedTokens = 0;
  let truncated = false;
  for (const hit of hits) {
    const count = perFile.get(hit.path) ?? 0;
    if (uniquePaths > 1 && count >= 2) continue;
    if (selected.some((candidate) => hasSubstantialOverlap(candidate, hit))) continue;
    const tokens = estimateTokens(hit.content);
    if (estimatedTokens + tokens > maxTokens) {
      const remainingChars = Math.max(0, (maxTokens - estimatedTokens) * 4);
      if (remainingChars >= 32) {
        selected.push({...hit, content: hit.content.slice(0, remainingChars)});
        perFile.set(hit.path, count + 1);
        estimatedTokens = maxTokens;
      }
      truncated = true;
      break;
    }
    selected.push(hit);
    perFile.set(hit.path, count + 1);
    estimatedTokens += tokens;
  }
  const text = selected.map((hit) => {
    const shownPath = workspaceAliasPath(hit.path, roots);
    const symbol = hit.symbol ? ` symbol="${escapeAttribute(hit.symbol)}"` : '';
    return `<code path="${escapeAttribute(shownPath)}" lines="${hit.startLine}-${hit.endLine}" score="${hit.score.toFixed(3)}"${symbol}>\n${hit.content}\n</code>`;
  }).join('\n\n');
  return {text, hits: selected, estimatedTokens, engine, truncated};
}

function cloneHits(hits: ContextHit[]): ContextHit[] {
  return hits.map((hit) => ({...hit}));
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function createGeneration(files: IndexedFile[]): string {
  return createHash('sha256')
    .update(files
      .slice()
      .sort((left, right) => left.absolutePath.localeCompare(right.absolutePath))
      .map((file) => `${file.absolutePath}\u0000${file.contentHash}`)
      .join('\n'), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function hasSubstantialOverlap(left: ContextHit, right: ContextHit): boolean {
  if (left.path !== right.path) return false;
  const overlap = Math.max(0, Math.min(left.endLine, right.endLine) - Math.max(left.startLine, right.startLine) + 1);
  const shorter = Math.min(left.endLine - left.startLine + 1, right.endLine - right.startLine + 1);
  return overlap > 0 && overlap / Math.max(shorter, 1) >= 0.4;
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
  const starts = [...new Set([0, ...structuralStarts(file.path, lines)])]
    .filter((start) => start >= 0 && start < lines.length)
    .sort((left, right) => left - right);
  const chunks: IndexedChunk[] = [];
  let sectionStart = starts[0] ?? 0;
  for (const start of starts.slice(1)) {
    if (start - sectionStart < MIN_STRUCTURAL_CHUNK_LINES) continue;
    appendChunkRange(chunks, file, lines, sectionStart, start);
    sectionStart = start;
  }
  appendChunkRange(chunks, file, lines, sectionStart, lines.length);
  return chunks;
}

function appendChunkRange(
  chunks: IndexedChunk[],
  file: {root: string; path: string; absolutePath: string},
  lines: string[],
  rangeStart: number,
  rangeEnd: number,
): void {
  for (let start = rangeStart; start < rangeEnd; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(rangeEnd, start + CHUNK_LINES);
    const content = lines.slice(start, end).join('\n');
    const symbol = detectSymbol(lines.slice(start, Math.min(end, start + 24)));
    chunks.push({
      id: `${file.absolutePath}:${start + 1}`,
      ...file,
      startLine: start + 1,
      endLine: end,
      content,
      ...(symbol ? {symbol} : {}),
      tokens: tokenize(`${file.path} ${symbol ?? ''} ${content}`),
    });
    if (end === rangeEnd) break;
  }
}

function structuralStarts(path: string, lines: string[]): number[] {
  const extension = extname(path).toLocaleLowerCase();
  return lines.flatMap((line, index) => isStructuralLine(line, extension) ? [index] : []);
}

function isStructuralLine(line: string, extension: string): boolean {
  if (/^\s*#{1,6}\s+\S/u.test(line) && ['.md', '.mdx'].includes(extension)) return true;
  if (/^\s*(?:query|mutation|subscription|fragment|type|interface|input|enum|schema|directive)\b/iu.test(line) && ['.graphql', '.gql'].includes(extension)) return true;
  if (/^\s*(?:create|alter|drop|select|insert|update|delete|with)\b/iu.test(line) && extension === '.sql') return true;
  if (/^\s*<(?:script|template|style)\b/iu.test(line) && ['.vue', '.svelte', '.html'].includes(extension)) return true;
  if (/^\S[^:]*:\s*(?:$|[^/])/u.test(line) && ['.yaml', '.yml', '.toml'].includes(extension)) return true;
  if (/^\s*(?:async\s+def|def|class|module)\s+/u.test(line) && ['.py', '.rb'].includes(extension)) return true;
  if (/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod)\s+/u.test(line) && extension === '.rs') return true;
  if (/^\s*(?:func|type|var|const)\s+/u.test(line) && extension === '.go') return true;
  if (/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|namespace|const|let|var)\s+/u.test(line)) return true;
  return /^\s*(?:public|private|protected|internal|static|final|abstract|sealed|data|open|partial|record|class|interface|enum|struct|trait|impl|fun)\b/u.test(line);
}

function detectSymbol(lines: string[]): string | undefined {
  const identifier = '([\\p{L}_$][\\p{L}\\p{N}_$]*)';
  const patterns = [
    new RegExp(`(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|enum|namespace)\\s+${identifier}`, 'u'),
    new RegExp(`(?:async\\s+def|def|class|module|func|fn|fun)\\s+${identifier}`, 'u'),
    new RegExp(`(?:const|let|var)\\s+${identifier}\\s*=`, 'u'),
    new RegExp(`(?:struct|trait|impl|record)\\s+${identifier}`, 'u'),
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
    .replace(/([\p{Ll}])([\p{Lu}])/gu, '$1 $2')
    .toLocaleLowerCase();
  const base = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const output: string[] = [];
  for (const token of base) {
    const variants = new Set([token, ...token.split(/[_-]/)]);
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length > 1) {
      for (let index = 0; index < token.length - 1; index += 1) {
        variants.add(token.slice(index, index + 2));
      }
    }
    output.push(...[...variants].filter((variant) => variant.length > 1));
  }
  return output;
}

function scoreChunk(
  chunk: IndexedChunk,
  terms: string[],
  rawQuery: string,
  documentFrequency: Map<string, number>,
  documentCount: number,
  averageLength: number,
): number {
  const frequencies = new Map<string, number>();
  for (const token of chunk.tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
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
  const phrase = rawQuery.trim().toLocaleLowerCase();
  if (phrase.length > 3 && chunk.content.toLocaleLowerCase().includes(phrase)) score += 3;
  return score;
}

export function defaultIndexName(root: string): string {
  return basename(root) || 'workspace';
}
