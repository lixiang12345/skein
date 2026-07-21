import {basename, isAbsolute, resolve} from 'node:path';
import type {MosaicConfig, ContextHit, PackedContext} from '../types.js';
import {WorkspaceAccess} from '../tools/workspace.js';
import {resolveExecutableRuntime, runProcess, type ExecutableRuntime} from '../utils/process.js';
import {isInside, workspaceAliasPath} from '../utils/path.js';
import {LocalContextIndex, type IndexProgress} from './local-index.js';

interface ExternalHit {
  chunk?: {
    path?: string;
    startLine?: number;
    endLine?: number;
    content?: string;
    symbol?: string;
  };
  preview?: string;
  score?: number;
  source?: string;
}

interface ExternalPacked {
  packedText?: string;
  estimatedTokens?: number;
  truncated?: boolean;
  hits?: ExternalHit[];
}

export class ContextEngine {
  readonly local: LocalContextIndex;
  private readonly workspace: WorkspaceAccess;
  private externalAvailable?: boolean;
  private externalRuntime?: ExecutableRuntime | null;

  constructor(private readonly config: MosaicConfig) {
    this.local = new LocalContextIndex(config.workspaceRoots);
    this.workspace = new WorkspaceAccess(config.workspaceRoots);
  }

  async pack(query: string): Promise<PackedContext> {
    const externalAvailable = this.config.context.engine !== 'local' &&
      await this.canUseExternal();
    if (this.config.context.engine === 'contextengine' && !externalAvailable) {
      throw new Error(`ContextEngine is required but unavailable: ${this.config.context.contextEngineCommand}`);
    }
    if (externalAvailable) {
      try {
        const result = await this.external(['context', query, '--max-tokens',
          String(this.config.context.maxTokens), '--json']);
        const packed = parseJsonOutput(result.stdout) as ExternalPacked;
        const externalHits = packed.hits ?? [];
        const hits = (await Promise.all(externalHits
          .map((hit) => this.mapHit(hit))))
          .filter((hit): hit is ContextHit => hit !== undefined);
        // `packedText` is produced from the same chunks as `hits`. If even one
        // hit is outside the configured roots, filtering the metadata alone is
        // insufficient because the corresponding source may still be present
        // in `packedText`. Reject the external response so auto mode can safely
        // rebuild context locally (and explicit mode reports the violation).
        if (hits.length !== externalHits.length) {
          throw new Error('ContextEngine returned context outside configured workspace roots.');
        }
        return {
          text: packed.packedText ?? '',
          hits,
          estimatedTokens: packed.estimatedTokens ?? 0,
          engine: 'contextengine',
          truncated: packed.truncated ?? false,
        };
      } catch (error) {
        if (this.config.context.engine === 'contextengine') throw error;
      }
    }
    await this.local.build();
    return this.local.pack(
      query,
      this.config.context.topK,
      this.config.context.maxTokens,
    );
  }

  async search(query: string, topK = this.config.context.topK): Promise<ContextHit[]> {
    const externalAvailable = this.config.context.engine !== 'local' &&
      await this.canUseExternal();
    if (this.config.context.engine === 'contextengine' && !externalAvailable) {
      throw new Error(`ContextEngine is required but unavailable: ${this.config.context.contextEngineCommand}`);
    }
    if (externalAvailable) {
      try {
        const result = await this.external([
          'search', query, '--top-k', String(topK), '--json',
        ]);
        const hits = parseJsonOutput(result.stdout) as ExternalHit[];
        return (await Promise.all(hits
          .map((hit) => this.mapHit(hit))))
          .filter((hit): hit is ContextHit => hit !== undefined);
      } catch (error) {
        if (this.config.context.engine === 'contextengine') throw error;
      }
    }
    await this.local.build();
    return this.local.search(query, topK);
  }

  async index(onProgress?: (progress: IndexProgress) => void): Promise<Record<string, unknown>> {
    if (this.config.context.engine === 'contextengine' ||
      (this.config.context.engine === 'auto' && await this.canUseExternal())) {
      const args = ['index', this.config.workspaceRoots[0] ?? process.cwd()];
      for (const [index, root] of this.config.workspaceRoots.slice(1).entries()) {
        args.push('--extra', `workspace${index + 2}:${root}`);
      }
      args.push('--quiet');
      try {
        const result = await this.external(args, 15 * 60_000);
        const output = parseJsonOutput(result.stdout);
        return {
          ...(output && typeof output === 'object' && !Array.isArray(output)
            ? output as Record<string, unknown>
            : {output}),
          engine: 'contextengine',
        };
      } catch (error) {
        if (this.config.context.engine === 'contextengine') throw error;
        const local = await this.local.build(onProgress);
        return {
          engine: 'local',
          fallback: 'contextengine-index-failed',
          ...(error instanceof Error ? {error: error.message} : {}),
          ...local,
        };
      }
    }
    return {engine: 'local', ...(await this.local.build(onProgress))};
  }

  async status(): Promise<Record<string, unknown>> {
    const external = await this.canUseExternal();
    let externalStatus: unknown;
    if (external) {
      try {
        const result = await this.external(['status']);
        externalStatus = parseJsonOutput(result.stdout);
      } catch (error) {
        externalStatus = {ok: false, error: error instanceof Error ? error.message : String(error)};
      }
    }
    await this.local.load();
    return {
      selected: external && this.config.context.engine !== 'local' ? 'contextengine' : 'local',
      externalAvailable: external,
      external: externalStatus,
      local: this.local.status(),
    };
  }

  async canUseExternal(): Promise<boolean> {
    if (this.externalAvailable !== undefined) return this.externalAvailable;
    const runtime = await this.resolveExternalRuntime();
    if (!runtime) {
      this.externalAvailable = false;
      return false;
    }
    try {
      const result = await runProcess(runtime.executable, ['status', '--root', this.config.workspaceRoots[0] ?? process.cwd()], {
        cwd: this.config.workspaceRoots[0] ?? process.cwd(),
        timeoutMs: 10_000,
        maxOutputBytes: 100_000,
        env: {PATH: runtime.path},
        unsetEnv: ['Path'],
      });
      // ContextEngine intentionally exits with code 1 when the executable is
      // healthy but this workspace has not been indexed yet. Treat that as
      // available so `skein index` can bootstrap the external engine in auto
      // mode instead of silently building the local fallback forever.
      let unindexed = false;
      if (result.stdout.trim()) {
        try {
          const status = parseJsonOutput(result.stdout) as {error?: unknown};
          unindexed = status.error === 'no index';
        } catch {
          unindexed = false;
        }
      }
      this.externalAvailable = result.exitCode === 0 || unindexed;
    } catch {
      this.externalAvailable = false;
    }
    return this.externalAvailable;
  }

  private async external(args: string[], timeoutMs = 120_000) {
    const root = this.config.workspaceRoots[0] ?? process.cwd();
    const runtime = await this.resolveExternalRuntime();
    if (!runtime) {
      throw new Error(`ContextEngine executable is unavailable: ${this.config.context.contextEngineCommand}`);
    }
    const result = await runProcess(runtime.executable, [
      ...args,
      ...(!args.includes('--root') && args[0] !== 'index' ? ['--root', root] : []),
    ], {
      cwd: root,
      timeoutMs,
      maxOutputBytes: 5_000_000,
      env: {PATH: runtime.path},
      unsetEnv: ['Path'],
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() ||
        `ContextEngine exited with code ${result.exitCode}`);
    }
    return result;
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

  private async mapHit(hit: ExternalHit): Promise<ContextHit | undefined> {
    const rawPath = hit.chunk?.path;
    if (!rawPath) return undefined;
    const mappedPath = mapExternalPath(rawPath, this.config.workspaceRoots);
    if (!mappedPath) return undefined;
    let path: string;
    try {
      // External index data may be stale or tampered with. Reuse the same
      // realpath-aware boundary check as file tools so an in-root symlink
      // cannot make an outside file look like a valid ContextEngine hit.
      path = await this.workspace.resolvePath(mappedPath, {expect: 'file'});
    } catch {
      return undefined;
    }
    return {
      path,
      startLine: hit.chunk?.startLine ?? 1,
      endLine: hit.chunk?.endLine ?? 1,
      content: hit.chunk?.content ?? hit.preview ?? '',
      score: hit.score ?? 0,
      source: hit.source ?? 'contextengine',
      ...(hit.chunk?.symbol ? {symbol: hit.chunk.symbol} : {}),
    };
  }
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
    if (first === 'main') {
      candidate = resolve(primary, ...segments.slice(1));
    } else if (workspaceAlias) {
      const aliasNumber = Number(workspaceAlias[1]);
      const aliasRoot = Number.isSafeInteger(aliasNumber) && aliasNumber >= 2
        ? resolvedRoots[aliasNumber - 1]
        : undefined;
      // An alias-looking path must never silently become a path below the
      // primary root. ContextEngine assigns extras as workspace2, workspace3,
      // and so on, so an unknown alias indicates stale or malformed output.
      if (!aliasRoot) return undefined;
      candidate = resolve(aliasRoot, ...segments.slice(1));
    } else {
      // ContextEngine itself accepts arbitrary aliases for --extra roots
      // (for example `docs:/repo/docs`). Skein indexes its own extra roots as
      // workspace2, workspace3, ... but also recognizes an unambiguous root
      // basename so a separately-created ContextEngine index remains usable.
      const namedRoots = resolvedRoots.filter((root) =>
        basename(root).toLocaleLowerCase() === first,
      );
      const namedRoot = namedRoots.length === 1 && namedRoots[0] !== primary
        ? namedRoots[0]
        : undefined;
      candidate = namedRoot
        ? resolve(namedRoot, ...segments.slice(1))
        : resolve(primary, normalized);
    }
  }

  return resolvedRoots.some((root) => isInside(root, candidate))
    ? candidate
    : undefined;
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const starts = [trimmed.indexOf('{'), trimmed.indexOf('[')].filter((index) => index >= 0);
    if (!starts.length) throw new Error(`Expected JSON from ContextEngine: ${trimmed.slice(0, 300)}`);
    const start = Math.min(...starts);
    return JSON.parse(trimmed.slice(start));
  }
}

export function formatContextHits(hits: ContextHit[], workspace: string | string[]): string {
  if (!hits.length) return 'No relevant context found.';
  const roots = Array.isArray(workspace) ? workspace : [workspace];
  return hits.map((hit, index) =>
    `${index + 1}. ${workspaceAliasPath(hit.path, roots)}:${hit.startLine}-${hit.endLine} ` +
    `[${hit.source} ${hit.score.toFixed(3)}]${hit.symbol ? ` ${hit.symbol}` : ''}`,
  ).join('\n');
}
