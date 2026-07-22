import {createHash} from 'node:crypto';
import {mkdtemp, open, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import stripAnsi from 'strip-ansi';
import {z} from 'zod';
import type {MosaicConfig, ContextDegradation, ContextHit, PackedContext} from '../types.js';
import {WorkspaceAccess} from '../tools/workspace.js';
import {
  resolveExecutableRuntime,
  runProcess,
  type ExecutableRuntime,
  type ProcessResult,
} from '../utils/process.js';
import {isInside, workspaceAliasPath} from '../utils/path.js';
import {LocalContextIndex, packContextHits, type IndexProgress} from './local-index.js';

export const MINIMUM_CONTEXTENGINE_VERSION = '0.4.0';
const CAPABILITY_TTL_MS = 10_000;

export type ContextEngineCapabilityReason =
  | 'not-installed'
  | 'version-unavailable'
  | 'incompatible-version'
  | 'health-check-failed'
  | 'invalid-status'
  | 'not-indexed';

export interface ContextEngineCapability {
  installed: boolean;
  compatible: boolean;
  healthy: boolean;
  available: boolean;
  indexed: boolean;
  freshness: 'unknown' | 'indexing';
  version?: string;
  reason?: ContextEngineCapabilityReason;
  detail: string;
  status?: Record<string, unknown>;
}

const degradedChannelSchema = z.enum(['semantic', 'rerank']);
const terminalSafeStringSchema = z.string().refine(
  (value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
  {message: 'Control characters are not allowed.'},
);

const externalChunkSchema = z.object({
  path: z.string().min(1).max(4_096),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  content: z.string().max(2_000_000),
  symbol: terminalSafeStringSchema.max(1_000).optional(),
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
}).passthrough().refine((chunk) => chunk.endLine >= chunk.startLine, {
  message: 'ContextEngine hit line range is invalid.',
});

const externalHitSchema = z.object({
  chunk: externalChunkSchema,
  preview: z.string().max(500_000).optional(),
  score: z.number().finite(),
  source: z.enum(['bm25', 'semantic', 'hybrid']),
  degradedChannels: z.array(degradedChannelSchema).max(20).optional(),
}).passthrough();

type ExternalHit = z.infer<typeof externalHitSchema>;

const externalSearchSchema = z.array(externalHitSchema).max(1_000);
const externalPackedSchema = z.object({
  packedText: z.string().max(8_000_000),
  estimatedTokens: z.number().int().nonnegative(),
  truncated: z.boolean(),
  hits: z.array(externalHitSchema).max(1_000),
  degradedChannels: z.array(degradedChannelSchema).max(20).optional(),
}).passthrough();

const indexedStatusSchema = z.object({
  ok: z.literal(true),
  root: z.string().min(1).max(4_096),
  fileCount: z.number().int().nonnegative(),
  chunkCount: z.number().int().positive(),
  indexVersion: z.number().int().nonnegative(),
  hasEmbeddings: z.boolean().optional(),
  embeddingModel: z.string().max(1_000).nullable().optional(),
  lastIndexedAt: z.string().max(1_000).nullable().optional(),
  generationId: z.string().max(1_000).nullable().optional(),
  sourceRevision: z.string().max(4_096).nullable().optional(),
  indexedRevision: z.string().max(4_096).nullable().optional(),
  pendingRevision: z.string().max(4_096).nullable().optional(),
}).passthrough();

const unindexedStatusSchema = z.object({
  ok: z.literal(false),
  error: z.literal('no index'),
  hint: z.string().max(4_096).optional(),
}).passthrough();

const externalIndexSchema = z.object({
  ok: z.literal(true),
  filesScanned: z.number().int().nonnegative(),
  filesIndexed: z.number().int().nonnegative(),
  filesRemoved: z.number().int().nonnegative(),
  chunksWritten: z.number().int().nonnegative(),
  embeddingsWritten: z.number().int().nonnegative(),
  storage: terminalSafeStringSchema.min(1).max(100),
}).strip();

export class ContextEngine {
  readonly local: LocalContextIndex;
  private readonly workspace: WorkspaceAccess;
  private externalRuntime: ExecutableRuntime | null | undefined;
  private gitRuntime: ExecutableRuntime | null | undefined;
  private capabilityCache: {expiresAt: number; promise: Promise<ContextEngineCapability>} | undefined;
  private degradation: ContextDegradation | undefined;

  constructor(private readonly config: MosaicConfig) {
    this.local = new LocalContextIndex(config.workspaceRoots);
    this.workspace = new WorkspaceAccess(config.workspaceRoots);
  }

  async pack(query: string): Promise<PackedContext> {
    let degradation: ContextDegradation | undefined;
    if (this.config.context.engine !== 'local') {
      const capability = await this.inspectExternal();
      this.assertExplicitRetrieval(capability);
      if (capability.available && capability.indexed) {
        try {
          const root = this.config.workspaceRoots[0] ?? process.cwd();
          const result = await this.external([
            'context',
            '--top-k', String(this.config.context.topK),
            '--max-tokens', String(this.config.context.maxTokens),
            '--json',
            '--root', root,
            '--', query,
          ]);
          const packed = externalPackedSchema.parse(parseJsonOutput(result.stdout));
          if (packed.hits.length > this.config.context.topK ||
            packed.estimatedTokens > this.config.context.maxTokens) {
            throw new Error('ContextEngine exceeded the requested context budget.');
          }
          const hits = await this.mapHits(packed.hits);
          if (!hits.length && this.config.context.engine === 'auto') {
            const local = await this.localPack(query);
            if (local.hits.length) {
              degradation = emptyResultDegradation();
              this.invalidateCapability();
              this.degradation = degradation;
              return {...local, degradation};
            }
          }
          const safe = packContextHits(
            hits,
            this.config.workspaceRoots,
            this.config.context.maxTokens,
            'contextengine',
          );
          const degradedChannels = collectDegradedChannels(packed.hits, packed.degradedChannels);
          if (degradedChannels.length) {
            degradation = {
              code: 'contextengine-channels-degraded',
              summary: `ContextEngine unavailable channels: ${degradedChannels.join(', ')}`,
            };
          }
          const packedResult = {
            ...safe,
            truncated: safe.truncated || packed.truncated,
            ...(degradation ? {degradation} : {}),
          };
          this.degradation = degradation;
          return packedResult;
        } catch (error) {
          if (this.config.context.engine === 'contextengine') {
            this.invalidateCapability();
            throw sanitizedExternalError(error);
          }
          degradation = queryFailureDegradation(error);
          this.invalidateCapability();
        }
      } else if (this.config.context.engine === 'auto') {
        degradation = capabilityDegradation(capability);
      }
    }
    const packed = await this.localPack(query);
    this.degradation = degradation;
    return {...packed, ...(degradation ? {degradation} : {})};
  }

  async search(query: string, topK = this.config.context.topK): Promise<ContextHit[]> {
    let degradation: ContextDegradation | undefined;
    if (this.config.context.engine !== 'local') {
      const capability = await this.inspectExternal();
      this.assertExplicitRetrieval(capability);
      if (capability.available && capability.indexed) {
        try {
          const root = this.config.workspaceRoots[0] ?? process.cwd();
          const result = await this.external([
            'search', '--top-k', String(topK), '--json', '--root', root, '--', query,
          ]);
          const externalHits = externalSearchSchema.parse(parseJsonOutput(result.stdout));
          if (externalHits.length > topK) {
            throw new Error('ContextEngine returned more hits than requested.');
          }
          const hits = await this.mapHits(externalHits);
          if (!hits.length && this.config.context.engine === 'auto') {
            const localHits = await this.localSearch(query, topK);
            if (localHits.length) {
              degradation = emptyResultDegradation();
              this.invalidateCapability();
              this.degradation = degradation;
              return localHits;
            }
          }
          const degradedChannels = collectDegradedChannels(externalHits);
          if (degradedChannels.length) {
            degradation = {
              code: 'contextengine-channels-degraded',
              summary: `ContextEngine unavailable channels: ${degradedChannels.join(', ')}`,
            };
          }
          this.degradation = degradation;
          return hits;
        } catch (error) {
          if (this.config.context.engine === 'contextengine') {
            this.invalidateCapability();
            throw sanitizedExternalError(error);
          }
          degradation = queryFailureDegradation(error);
          this.invalidateCapability();
        }
      } else if (this.config.context.engine === 'auto') {
        degradation = capabilityDegradation(capability);
      }
    }
    const hits = await this.localSearch(query, topK);
    this.degradation = degradation;
    return hits;
  }

  async index(onProgress?: (progress: IndexProgress) => void): Promise<Record<string, unknown>> {
    let degradation: ContextDegradation | undefined;
    if (this.config.context.engine === 'local') {
      const result = {engine: 'local', ...(await this.local.build(onProgress))};
      this.degradation = undefined;
      return result;
    }
    const capability = await this.inspectExternal({refresh: true});
    if (this.config.context.engine === 'contextengine' && !capability.available) {
      throw requiredExternalError(capability);
    }
    if (capability.available) {
      const args = ['index', this.config.workspaceRoots[0] ?? process.cwd()];
      for (const [index, root] of this.config.workspaceRoots.slice(1).entries()) {
        args.push('--extra', `workspace${index + 2}:${root}`);
      }
      const progress = onProgress ? createExternalProgressParser(onProgress) : undefined;
      let outputTail = '';
      const onStdout = progress ? (chunk: string): void => {
        outputTail = `${outputTail}${chunk}`.slice(-1_000_000);
        progress.push(chunk);
      } : undefined;
      if (!progress) args.push('--quiet');
      try {
        const result = await this.external(args, {
          timeoutMs: 15 * 60_000,
          ...(onStdout ? {onStdout} : {}),
        });
        progress?.flush();
        const output = externalIndexSchema.parse(parseJsonOutput(outputTail || result.stdout));
        progress?.complete(output.filesScanned);
        this.invalidateCapability();
        this.degradation = undefined;
        return {
          engine: 'contextengine',
          ...output,
        };
      } catch (error) {
        if (this.config.context.engine === 'contextengine') {
          this.invalidateCapability();
          throw sanitizedExternalError(error);
        }
        degradation = {
          code: 'contextengine-index-failed',
          summary: 'ContextEngine indexing failed; built the local index.',
          detail: safeExternalDetail(error),
        };
        this.invalidateCapability();
      }
    }
    degradation ??= capabilityDegradation(capability);
    const local = await this.local.build(onProgress);
    this.degradation = degradation;
    return {
      engine: 'local',
      fallback: degradation.code,
      degradation,
      ...local,
    };
  }

  async status(options: {refresh?: boolean} = {}): Promise<Record<string, unknown>> {
    const capability = this.config.context.engine === 'local'
      ? disabledCapability()
      : await this.inspectExternal({refresh: options.refresh ?? true});
    await this.local.load();
    const selected = capability.available && capability.indexed
      ? 'contextengine'
      : this.config.context.engine === 'contextengine'
        ? capability.available ? 'unindexed' : 'unavailable'
        : 'local';
    return {
      configuredEngine: this.config.context.engine,
      selected,
      externalAvailable: capability.available,
      capability,
      external: capability.status,
      local: this.local.status(),
    };
  }

  async canUseExternal(): Promise<boolean> {
    if (this.config.context.engine === 'local') return false;
    return (await this.inspectExternal()).available;
  }

  async inspectExternal(options: {refresh?: boolean} = {}): Promise<ContextEngineCapability> {
    if (this.config.context.engine === 'local') return disabledCapability();
    if (options.refresh) {
      this.capabilityCache = undefined;
      this.externalRuntime = undefined;
    }
    const now = Date.now();
    if (this.capabilityCache && this.capabilityCache.expiresAt > now) {
      return this.capabilityCache.promise;
    }
    if (this.capabilityCache) this.externalRuntime = undefined;
    const promise = this.probeExternal();
    // Keep concurrent callers on the same in-flight probe even when a slow
    // health check takes longer than the normal cache TTL. Start the TTL only
    // after negotiation settles so recovery behavior is deterministic.
    const cache = {expiresAt: Number.POSITIVE_INFINITY, promise};
    this.capabilityCache = cache;
    void promise.then(
      () => {
        if (this.capabilityCache === cache) cache.expiresAt = Date.now() + CAPABILITY_TTL_MS;
      },
      () => {
        if (this.capabilityCache === cache) cache.expiresAt = Date.now();
      },
    );
    return promise;
  }

  lastDegradation(): ContextDegradation | undefined {
    return this.degradation ? {...this.degradation} : undefined;
  }

  private async probeExternal(): Promise<ContextEngineCapability> {
    const runtime = await this.resolveExternalRuntime();
    if (!runtime) {
      return unavailableCapability('not-installed', 'ContextEngine executable was not found.');
    }
    try {
      const versionResult = await this.runExternalProcess(runtime, ['--version'], {
        timeoutMs: 5_000,
        maxOutputBytes: 10_000,
      });
      const version = parseContextEngineVersion(versionResult.stdout);
      if (versionResult.exitCode !== 0 || !version) {
        return unavailableCapability(
          'version-unavailable',
          'ContextEngine did not report a valid CLI version.',
          {installed: true},
        );
      }
      if (!supportsContextEngineVersion(version)) {
        return unavailableCapability(
          'incompatible-version',
          `ContextEngine ${version} is incompatible; ${MINIMUM_CONTEXTENGINE_VERSION} or newer is required.`,
          {installed: true, version},
        );
      }
      const helpResults = await Promise.all([
        this.runExternalProcess(runtime, ['index', '--help'], {timeoutMs: 5_000, maxOutputBytes: 100_000}),
        this.runExternalProcess(runtime, ['search', '--help'], {timeoutMs: 5_000, maxOutputBytes: 100_000}),
        this.runExternalProcess(runtime, ['context', '--help'], {timeoutMs: 5_000, maxOutputBytes: 100_000}),
      ]);
      if (helpResults.some((result) => result.exitCode !== 0) ||
        !validCliHelpContract(helpResults.map((result) => result.stdout))) {
        return unavailableCapability(
          'incompatible-version',
          `ContextEngine ${version} does not expose the required CLI contract.`,
          {installed: true, version},
        );
      }
      const root = this.config.workspaceRoots[0] ?? process.cwd();
      const statusResult = await this.runExternalProcess(
        runtime,
        ['status', '--root', root],
        {timeoutMs: 10_000, maxOutputBytes: 100_000},
      );
      let parsed: unknown;
      try {
        parsed = parseJsonOutput(statusResult.stdout);
      } catch {
        return unavailableCapability(
          statusResult.exitCode === 0 ? 'invalid-status' : 'health-check-failed',
          statusResult.exitCode === 0
            ? 'ContextEngine returned an invalid health response.'
            : `ContextEngine health check failed: ${safeProcessResultDetail(statusResult)}`,
          {installed: true, version},
        );
      }
      const indexed = indexedStatusSchema.safeParse(parsed);
      if (statusResult.exitCode === 0 && indexed.success) {
        if (resolve(indexed.data.root) !== resolve(root)) {
          return unavailableCapability(
            'invalid-status',
            'ContextEngine reported status for a different workspace root.',
            {installed: true, version},
          );
        }
        const status = publicExternalStatus(indexed.data);
        return {
          installed: true,
          compatible: true,
          healthy: true,
          available: true,
          indexed: true,
          freshness: indexed.data.pendingRevision ? 'indexing' : 'unknown',
          version,
          detail: indexed.data.pendingRevision
            ? `ContextEngine ${version} is serving an index while a new generation is building.`
            : `ContextEngine ${version} is indexed; filesystem freshness is verified per result.`,
          status,
        };
      }
      const unindexed = unindexedStatusSchema.safeParse(parsed);
      if (statusResult.exitCode === 1 && unindexed.success) {
        return {
          installed: true,
          compatible: true,
          healthy: true,
          available: true,
          indexed: false,
          freshness: 'unknown',
          version,
          reason: 'not-indexed',
          detail: 'ContextEngine is compatible but this workspace is not indexed.',
          status: {ok: false, error: 'no index'},
        };
      }
      return unavailableCapability(
        statusResult.exitCode === 0 ? 'invalid-status' : 'health-check-failed',
        statusResult.exitCode === 0
          ? 'ContextEngine returned an incompatible health response.'
          : `ContextEngine health check failed: ${safeProcessResultDetail(statusResult)}`,
        {installed: true, version},
      );
    } catch (error) {
      return unavailableCapability(
        'health-check-failed',
        `ContextEngine health check failed: ${safeExternalDetail(error)}`,
        {installed: true},
      );
    }
  }

  private assertExplicitRetrieval(capability: ContextEngineCapability): void {
    if (this.config.context.engine !== 'contextengine') return;
    if (!capability.available) throw requiredExternalError(capability);
    if (!capability.indexed) {
      throw new Error('ContextEngine is required but this workspace is not indexed. Run `skein index`.');
    }
  }

  private invalidateCapability(): void {
    this.capabilityCache = undefined;
  }

  private async localSearch(query: string, topK: number): Promise<ContextHit[]> {
    await this.local.build();
    return this.local.search(query, topK);
  }

  private async localPack(query: string): Promise<PackedContext> {
    await this.local.build();
    return this.local.pack(
      query,
      this.config.context.topK,
      this.config.context.maxTokens,
    );
  }

  private async external(
    args: string[],
    options: {timeoutMs?: number; onStdout?: (chunk: string) => void} = {},
  ) {
    const root = this.config.workspaceRoots[0] ?? process.cwd();
    const runtime = await this.resolveExternalRuntime();
    if (!runtime) {
      throw new Error(`ContextEngine executable is unavailable: ${this.config.context.contextEngineCommand}`);
    }
    const result = await this.runExternalProcess(runtime, [
      ...args,
      ...(!args.includes('--root') && args[0] !== 'index' ? ['--root', root] : []),
    ], {
      timeoutMs: options.timeoutMs ?? 120_000,
      maxOutputBytes: 5_000_000,
      ...(options.onStdout ? {onStdout: options.onStdout} : {}),
    });
    if (result.exitCode !== 0) {
      throw new Error(safeProcessResultDetail(result) ||
        `ContextEngine exited with code ${result.exitCode}`);
    }
    return result;
  }

  private async runExternalProcess(
    runtime: ExecutableRuntime,
    args: string[],
    options: {
      timeoutMs: number;
      maxOutputBytes: number;
      onStdout?: (chunk: string) => void;
    },
  ) {
    const cwd = await mkdtemp(resolve(tmpdir(), 'skein-contextengine-'));
    try {
      return await runProcess(runtime.executable, args, {
        cwd,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        env: contextEngineEnvironment(runtime.path),
        inheritEnv: false,
        ...(options.onStdout ? {onStdout: options.onStdout} : {}),
      });
    } finally {
      await rm(cwd, {recursive: true, force: true});
    }
  }

  private async resolveExternalRuntime(): Promise<ExecutableRuntime | undefined> {
    if (this.externalRuntime !== undefined) return this.externalRuntime ?? undefined;
    const root = this.config.workspaceRoots[0] ?? process.cwd();
    this.externalRuntime = await resolveExecutableRuntime(
      this.config.context.contextEngineCommand,
      root,
      this.config.workspaceRoots,
    ) ?? null;
    return this.externalRuntime ?? undefined;
  }

  private async mapHits(externalHits: ExternalHit[]): Promise<ContextHit[]> {
    const files = new Map<string, Promise<string>>();
    const commits = new Map<string, Promise<VerifiedCommitChunk | undefined>>();
    const hits: ContextHit[] = [];
    for (const externalHit of externalHits) {
      const hit = await this.mapHit(externalHit, files, commits);
      if (!hit) throw new Error('ContextEngine returned stale or invalid workspace context.');
      hits.push(hit);
    }
    return hits;
  }

  private async mapHit(
    hit: ExternalHit,
    files: Map<string, Promise<string>>,
    commits: Map<string, Promise<VerifiedCommitChunk | undefined>>,
  ): Promise<ContextHit | undefined> {
    const rawPath = hit.chunk.path;
    const mappedPath = mapSyntheticCommitPath(rawPath, this.config.workspaceRoots) ??
      mapExternalPath(rawPath, this.config.workspaceRoots);
    if (!mappedPath) return undefined;
    if (createHash('sha256').update(hit.chunk.content).digest('hex') !== hit.chunk.hash) {
      return undefined;
    }
    const commitId = syntheticCommitId(mappedPath, this.config.workspaceRoots);
    if (commitId) {
      let currentPromise = commits.get(commitId);
      if (!currentPromise) {
        const oldestCommit = commits.keys().next().value;
        if (commits.size >= 16 && oldestCommit) commits.delete(oldestCommit);
        currentPromise = this.readCurrentCommitChunk(commitId);
        commits.set(commitId, currentPromise);
      }
      const current = await currentPromise;
      if (!current || hit.chunk.startLine !== 1 ||
        hit.chunk.endLine !== current.content.split('\n').length ||
        hit.chunk.content !== current.content) {
        return undefined;
      }
      return {
        path: mappedPath,
        startLine: 1,
        endLine: hit.chunk.endLine,
        content: current.content,
        score: hit.score,
        source: hit.source,
        symbol: current.symbol,
      };
    }
    let path: string;
    try {
      // External index data may be stale or tampered with. Reuse the same
      // realpath-aware boundary check as file tools so an in-root symlink
      // cannot make an outside file look like a valid ContextEngine hit.
      path = await this.workspace.resolvePath(mappedPath, {expect: 'file'});
    } catch {
      return undefined;
    }
    let contentPromise = files.get(path);
    if (!contentPromise) {
      const oldestFile = files.keys().next().value;
      if (files.size >= 8 && oldestFile) files.delete(oldestFile);
      contentPromise = readBoundedUtf8(path, 4_000_000);
      files.set(path, contentPromise);
    }
    let currentFile: string;
    try {
      currentFile = await contentPromise;
    } catch {
      return undefined;
    }
    const currentLines = currentFile.replaceAll('\r\n', '\n').split('\n');
    if (hit.chunk.startLine > currentLines.length || hit.chunk.endLine > currentLines.length) {
      return undefined;
    }
    const currentChunk = currentLines
      .slice(hit.chunk.startLine - 1, hit.chunk.endLine)
      .join('\n');
    const externalBody = hit.chunk.content.replace(/^(?:#|\/\/) Context: [^\n]*\n/u, '');
    if (currentChunk !== hit.chunk.content && currentChunk !== externalBody) return undefined;
    return {
      path,
      startLine: hit.chunk.startLine,
      endLine: hit.chunk.endLine,
      // ContextEngine may synthesize a container prefix for retrieval. The
      // model receives only bytes reread from the current workspace file.
      content: currentChunk,
      score: hit.score,
      source: hit.source,
      ...(hit.chunk.symbol ? {symbol: hit.chunk.symbol} : {}),
    };
  }

  private async readCurrentCommitChunk(shortHash: string): Promise<VerifiedCommitChunk | undefined> {
    const root = this.config.workspaceRoots[0] ?? process.cwd();
    if (this.gitRuntime === undefined) {
      this.gitRuntime = await resolveExecutableRuntime('git', root, this.config.workspaceRoots) ?? null;
    }
    const runtime = this.gitRuntime ?? undefined;
    if (!runtime) return undefined;
    const result = await runProcess(runtime.executable, [
      '--no-pager',
      '-c', 'color.ui=false',
      '-c', 'core.pager=cat',
      '-c', 'log.showSignature=false',
      'log', '-1',
      `--abbrev=${shortHash.length}`,
      '--date=short',
      '--name-only',
      '--pretty=format:<<<%H|%h|%an|%ad|%s>>>',
      shortHash,
    ], {
      cwd: root,
      timeoutMs: 10_000,
      maxOutputBytes: 1_000_000,
      inheritEnv: false,
      env: {
        PATH: runtime.path,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'C.UTF-8',
      },
    });
    if (result.exitCode !== 0) return undefined;
    return parseCommitChunk(result.stdout, shortHash);
  }
}

interface VerifiedCommitChunk {
  content: string;
  symbol: string;
}

async function readBoundedUtf8(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) {
      throw new Error('ContextEngine result file exceeds the validation limit.');
    }
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > info.size) {
      throw new Error('ContextEngine result file changed during validation.');
    }
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function syntheticCommitId(path: string, roots: string[]): string | undefined {
  const primary = roots[0];
  if (!primary) return undefined;
  const relativePath = relative(resolve(primary), resolve(path)).split(sep).join('/');
  return relativePath.match(/^\.git\/commits\/([a-f0-9]{4,64})$/u)?.[1];
}

function mapSyntheticCommitPath(rawPath: string, roots: string[]): string | undefined {
  const primary = roots[0];
  if (!primary || isAbsolute(rawPath)) return undefined;
  const normalized = rawPath.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!/^\.git\/commits\/[a-f0-9]{4,64}$/u.test(normalized)) return undefined;
  return resolve(primary, normalized);
}

function parseCommitChunk(output: string, requestedShortHash: string): VerifiedCommitChunk | undefined {
  const lines = output.replaceAll('\r\n', '\n').split('\n');
  const header = lines[0]?.match(/^<<<([^|>]+)\|([^|>]+)\|([^|>]*)\|([^|>]*)\|([\s\S]*)>>>$/u);
  if (!header || header[2] !== requestedShortHash || !header[1]?.startsWith(requestedShortHash)) {
    return undefined;
  }
  const files = lines.slice(1).map((line) => line.trim()).filter(Boolean);
  const content = [
    `commit ${header[2]} ${header[4] ?? ''}`,
    `author: ${header[3] ?? ''}`,
    `subject: ${header[5] ?? ''}`,
    files.length ? `files:\n${files.slice(0, 40).map((file) => `- ${file}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
  return {content, symbol: (header[5] ?? '').slice(0, 120)};
}

export function supportsContextEngineVersion(value: string): boolean {
  const parsed = parseSemanticVersion(value);
  if (!parsed) return false;
  const [major, minor] = parsed;
  return major > 0 || minor >= 4;
}

function parseContextEngineVersion(output: string): string | undefined {
  const match = output.trim().match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:[-+][\w.-]+)?(?:\s|$)/u);
  return match?.[1];
}

function parseSemanticVersion(value: string): [number, number, number] | undefined {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/u);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return undefined;
  return parts as [number, number, number];
}

function validCliHelpContract(outputs: string[]): boolean {
  const [indexHelp = '', searchHelp = '', contextHelp = ''] = outputs;
  return ['--extra', '--quiet'].every((flag) => indexHelp.includes(flag)) &&
    ['--top-k', '--json', '--root'].every((flag) => searchHelp.includes(flag)) &&
    ['--top-k', '--max-tokens', '--json', '--root'].every((flag) => contextHelp.includes(flag));
}

function disabledCapability(): ContextEngineCapability {
  return {
    installed: false,
    compatible: false,
    healthy: false,
    available: false,
    indexed: false,
    freshness: 'unknown',
    detail: 'External ContextEngine probing is disabled by context.engine=local.',
  };
}

function unavailableCapability(
  reason: Exclude<ContextEngineCapabilityReason, 'not-indexed'>,
  detail: string,
  known: {installed?: boolean; version?: string} = {},
): ContextEngineCapability {
  return {
    installed: known.installed ?? false,
    compatible: known.version ? supportsContextEngineVersion(known.version) : false,
    healthy: false,
    available: false,
    indexed: false,
    freshness: 'unknown',
    ...(known.version ? {version: known.version} : {}),
    reason,
    detail,
  };
}

function publicExternalStatus(status: z.infer<typeof indexedStatusSchema>): Record<string, unknown> {
  return {
    ok: true,
    root: status.root,
    fileCount: status.fileCount,
    chunkCount: status.chunkCount,
    indexVersion: status.indexVersion,
    ...(status.hasEmbeddings !== undefined ? {hasEmbeddings: status.hasEmbeddings} : {}),
    ...(status.embeddingModel !== undefined ? {embeddingModel: status.embeddingModel} : {}),
    ...(status.lastIndexedAt !== undefined ? {lastIndexedAt: status.lastIndexedAt} : {}),
    ...(status.generationId !== undefined ? {generationId: status.generationId} : {}),
    ...(status.sourceRevision !== undefined ? {sourceRevision: status.sourceRevision} : {}),
    ...(status.indexedRevision !== undefined ? {indexedRevision: status.indexedRevision} : {}),
    ...(status.pendingRevision !== undefined ? {pendingRevision: status.pendingRevision} : {}),
  };
}

function requiredExternalError(capability: ContextEngineCapability): Error {
  return new Error(`ContextEngine is required but unavailable: ${capability.detail}`);
}

function capabilityDegradation(capability: ContextEngineCapability): ContextDegradation {
  if (capability.available && !capability.indexed) {
    return {
      code: 'contextengine-not-indexed',
      summary: 'ContextEngine has no index for this workspace; used the local index.',
      detail: 'Run `skein index` to build the external index.',
    };
  }
  const summary = capability.reason === 'not-installed'
    ? 'ContextEngine is not installed; used the local index.'
    : capability.reason === 'incompatible-version'
      ? 'ContextEngine is incompatible; used the local index.'
      : 'ContextEngine health check failed; used the local index.';
  return {
    code: `contextengine-${capability.reason ?? 'unavailable'}`,
    summary,
    detail: capability.detail,
  };
}

function queryFailureDegradation(error: unknown): ContextDegradation {
  const detail = safeExternalDetail(error);
  const stale = /stale or invalid workspace context/iu.test(detail);
  return {
    code: stale ? 'contextengine-stale-result' : 'contextengine-query-failed',
    summary: stale
      ? 'ContextEngine returned stale context; reran the query with the local index.'
      : 'ContextEngine query failed; reran it with the local index.',
    detail,
  };
}

function emptyResultDegradation(): ContextDegradation {
  return {
    code: 'contextengine-empty-result',
    summary: 'ContextEngine missed current local matches; used the local index.',
    detail: 'The external index may not include recently added files.',
  };
}

function collectDegradedChannels(
  hits: ExternalHit[],
  packedChannels: string[] = [],
): string[] {
  return [...new Set([
    ...packedChannels,
    ...hits.flatMap((hit) => hit.degradedChannels ?? []),
  ])].sort();
}

function contextEngineEnvironment(path: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {PATH: path};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name.startsWith('CONTEXTENGINE_') || [
      'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP',
      'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
      'http_proxy', 'https_proxy', 'no_proxy',
      'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    ].includes(name)) {
      environment[name] = value;
    }
  }
  return environment;
}

function safeProcessResultDetail(result: ProcessResult): string {
  return safeExternalDetail(result.stderr.trim() || result.stdout.trim() ||
    `ContextEngine exited with code ${result.exitCode}`);
}

function sanitizedExternalError(error: unknown): Error {
  return new Error(safeExternalDetail(error));
}

function safeExternalDetail(error: unknown): string {
  let detail = error instanceof Error ? error.message : String(error);
  detail = stripAnsi(detail).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, ' ');
  detail = detail.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, (candidate) => {
    try {
      const url = new URL(candidate);
      if (url.username || url.password) {
        url.username = '<redacted>';
        url.password = '';
      }
      if (url.search) url.search = '?<redacted>';
      if (url.hash) url.hash = '#<redacted>';
      return url.toString();
    } catch {
      return candidate.replace(/:\/\/[^/@\s]+@/u, '://<redacted>@');
    }
  });
  detail = detail
    .replace(/\b(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/giu, '$1<redacted>')
    .replace(/\b((?:api[-_ ]?key|token|secret|password)["']?\s*[=:]\s*["']?)[^\s,"';}]+/giu, '$1<redacted>')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/giu, '<redacted>');
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 7 || !/(?:KEY|TOKEN|SECRET|PASSWORD)/iu.test(name)) continue;
    detail = detail.replaceAll(value, '<redacted>');
  }
  return detail.replace(/\s+/gu, ' ').trim().slice(0, 500) || 'unknown failure';
}

function createExternalProgressParser(onProgress: (progress: IndexProgress) => void): {
  push(chunk: string): void;
  flush(): void;
  complete(total: number): void;
} {
  let buffer = '';
  let total = 0;
  let completed = 0;
  let last = '';
  const emit = (progress: IndexProgress): void => {
    const key = JSON.stringify(progress);
    if (key === last) return;
    last = key;
    onProgress(progress);
  };
  const parseLine = (line: string): void => {
    const clean = stripAnsi(line)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '')
      .trim();
    if (!clean || '{["}'.includes(clean[0] ?? '')) return;
    const standard = clean.match(/^(scan|chunk|embed|write|done)\s+(\d+)\/(\d+)\s+files\s+.*?(\d+)\s+chunks/iu);
    if (standard) {
      const phase = standard[1]?.toLocaleLowerCase();
      const done = Number(standard[2]);
      const files = Number(standard[3]);
      total = Math.max(total, files);
      completed = Math.max(completed, done);
      emit({
        phase: phase === 'chunk' ? 'index' : phase as IndexProgress['phase'],
        completed: done,
        total: files,
      });
      return;
    }
    const found = clean.match(/^Found\s+(\d+)\s+files/iu);
    if (found) {
      total = Number(found[1]);
      emit({phase: 'scan', completed: 0, total});
      return;
    }
    const embedding = clean.match(/^Embedding\s+(\d+)-(\d+)\s*\/\s*(\d+)/iu);
    if (embedding) {
      emit({phase: 'embed', completed: Number(embedding[2]), total: Number(embedding[3])});
      return;
    }
    if (/^Indexing commit lineage/iu.test(clean)) {
      emit({phase: 'write', completed: total, total});
      return;
    }
    if (/^Index complete/iu.test(clean)) {
      return;
    }
    const pathLike = !/[{}\[\]"]/u.test(clean) &&
      !/^[a-z][a-z0-9+.-]*:\/\//iu.test(clean) &&
      !/^(?:debug|error|info|warn|warning)\b/iu.test(clean) &&
      (/^(?:main|workspace\d+)[/\\]/iu.test(clean) ||
        /^[^:]+[/\\][^:]+$/u.test(clean) ||
        /^[^:]+\.[a-z0-9]{1,12}$/iu.test(clean));
    if (total && pathLike) {
      completed = Math.min(total, completed + 1);
      emit({phase: 'index', completed, total, path: clean.slice(0, 4_096)});
    }
  };
  const push = (chunk: string): void => {
    buffer = `${buffer}${chunk}`.slice(-100_000);
    const lines = buffer.split(/[\r\n]/u);
    buffer = lines.pop() ?? '';
    for (const line of lines) parseLine(line);
  };
  return {
    push,
    flush() {
      if (buffer) parseLine(buffer);
      buffer = '';
    },
    complete(files) {
      total = files;
      completed = files;
      emit({phase: 'done', completed: files, total: files});
    },
  };
}

export function mapExternalPath(rawPath: string, roots: string[]): string | undefined {
  const resolvedRoots = roots.map((root) => resolve(root));
  const primary = resolvedRoots[0];
  if (!primary || !rawPath || rawPath.includes('\0')) return undefined;

  let candidate: string;
  if (isAbsolute(rawPath)) {
    candidate = resolve(rawPath);
  } else {
    const normalized = rawPath.replaceAll('\\', '/').replace(/^\.\//, '');
    const segments = normalized.split('/').filter(Boolean);
    const first = segments[0]?.toLowerCase();
    const workspaceAlias = first?.match(/^workspace(\d+)$/);
    if (first === 'main' && resolvedRoots.length > 1) {
      candidate = resolve(primary, ...segments.slice(1));
    } else if (workspaceAlias && resolvedRoots.length > 1) {
      const aliasNumber = Number(workspaceAlias[1]);
      const aliasRoot = Number.isSafeInteger(aliasNumber) && aliasNumber >= 2
        ? resolvedRoots[aliasNumber - 1]
        : undefined;
      // An alias-looking path must never silently become a path below the
      // primary root. ContextEngine assigns extras as workspace2, workspace3,
      // and so on, so an unknown alias indicates stale or malformed output.
      if (!aliasRoot) return undefined;
      candidate = resolve(aliasRoot, ...segments.slice(1));
    } else if (resolvedRoots.length > 1) {
      // In a multi-root index every external path must carry the alias that
      // Skein supplied during indexing. Unknown aliases are never guessed as
      // primary-root paths because that can misattribute another repository.
      return undefined;
    } else {
      candidate = resolve(primary, normalized);
    }
  }

  return resolvedRoots.some((root) => isInside(root, candidate))
    ? candidate
    : undefined;
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/[\r\n]+/u);
    for (let start = lines.length - 1; start >= 0; start -= 1) {
      const candidate = lines.slice(start).join('\n').trim();
      if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
      try {
        return JSON.parse(candidate);
      } catch {
        // Human progress text may contain braces; keep looking for the final object.
      }
    }
    throw new Error(`Expected JSON from ContextEngine: ${trimmed.slice(0, 300)}`);
  }
}

export function formatContextHits(hits: ContextHit[], workspace: string | string[]): string {
  if (!hits.length) return 'No relevant context found.';
  const roots = Array.isArray(workspace) ? workspace : [workspace];
  return hits.map((hit, index) => {
    const path = safeInlineExternalText(workspaceAliasPath(hit.path, roots));
    const source = safeInlineExternalText(hit.source);
    const symbol = hit.symbol ? ` ${safeInlineExternalText(hit.symbol)}` : '';
    return `${index + 1}. ${path}:${hit.startLine}-${hit.endLine} ` +
      `[${source} ${hit.score.toFixed(3)}]${symbol}`;
  }).join('\n');
}

function safeInlineExternalText(value: string): string {
  return stripAnsi(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
