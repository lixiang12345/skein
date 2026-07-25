import type {
  ContextDegradation,
  ContextDiagnosticUpdate,
  ContextHit,
  ContextPackOptions,
  MosaicConfig,
  PackedContext,
} from '../types.js';
import {workspaceAliasPath} from '../utils/path.js';
import type {ContextRefreshResult} from '../tools/types.js';
import {emptyPackedContext, selectContextBudget} from './budget.js';
import {
  LocalContextIndex,
  type IndexPreparationResult,
  type IndexProgress,
  type LocalIndexStatus,
} from './local-index.js';

export interface ContextEngineStatus {
  [key: string]: unknown;
  selected: 'local';
  local: LocalIndexStatus;
  degradation?: ContextDegradation;
}

/**
 * The in-process retrieval boundary used by the agent and search tool.
 *
 * Retrieval deliberately has no daemon, database service, model download, or
 * executable integration. LocalContextIndex owns persistence and freshness;
 * this class keeps the public pack/search/index surface narrow.
 */
export class ContextEngine {
  readonly local: LocalContextIndex;
  private degradation: ContextDegradation | undefined;

  constructor(private readonly config: MosaicConfig) {
    this.local = new LocalContextIndex(config.workspaceRoots);
  }

  async pack(query: string, options: ContextPackOptions = {}): Promise<PackedContext> {
    const decision = selectContextBudget(query, this.config, options);
    if (decision.budgetTokens === 0 || decision.topK === 0) {
      this.degradation = undefined;
      return emptyPackedContext(decision);
    }
    try {
      const packed = await this.local.pack(
        query,
        decision.topK,
        decision.budgetTokens,
      );
      this.degradation = undefined;
      return {
        ...packed,
        budgetTier: decision.tier,
        budgetTokens: decision.budgetTokens,
        baseBudgetTokens: decision.baseBudgetTokens,
        incrementalBudgetTokens: decision.incrementalBudgetTokens,
        budgetReason: decision.reason,
        incrementalEvidenceTokens: Math.max(0, packed.estimatedTokens - decision.baseBudgetTokens),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.degradation = {
        code: 'local-retrieval-failed',
        summary: 'Local code retrieval failed; continuing without retrieved code.',
        detail,
      };
      const degradation = this.lastDegradation();
      return {
        ...emptyPackedContext(decision),
        ...(degradation ? {degradation} : {}),
      };
    }
  }

  async search(query: string, topK = this.config.context.topK): Promise<ContextHit[]> {
    try {
      const hits = await this.local.search(query, topK);
      this.degradation = undefined;
      return hits;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.degradation = {
        code: 'local-retrieval-failed',
        summary: 'Local code retrieval failed.',
        detail,
      };
      return [];
    }
  }

  invalidate(paths: string[]): void {
    this.local.invalidate(paths);
  }

  recordDiagnostics(update: ContextDiagnosticUpdate): void {
    this.local.recordDiagnostics(update);
  }

  resetDiagnostics(): void {
    this.local.resetDiagnostics();
  }

  async flushDirty(): Promise<ContextRefreshResult> {
    try {
      const result = await this.local.flushDirty();
      this.degradation = undefined;
      return {status: 'current', ...result};
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.degradation = {
        code: 'local-index-refresh-failed',
        summary: 'Local code index refresh failed; the next retrieval will retry.',
        detail,
      };
      return {status: 'degraded', detail, paths: 0};
    }
  }

  async index(onProgress?: (progress: IndexProgress) => void): Promise<Record<string, unknown>> {
    const result = await this.local.build(onProgress);
    this.degradation = undefined;
    return {engine: 'local', ...result};
  }

  async prepare(
    onProgress?: (progress: IndexProgress) => void,
    forceBuild = false,
  ): Promise<IndexPreparationResult> {
    const result = await this.local.prepare(onProgress, forceBuild);
    this.degradation = undefined;
    return result;
  }

  async status(): Promise<ContextEngineStatus> {
    await this.local.load();
    const degradation = this.lastDegradation();
    return {
      selected: 'local',
      local: this.local.status(),
      ...(degradation ? {degradation} : {}),
    };
  }

  lastDegradation(): ContextDegradation | undefined {
    return this.degradation ? {...this.degradation} : undefined;
  }

  async functionFingerprints() {
    return this.local.functionFingerprints();
  }
}

export function formatContextHits(hits: ContextHit[], roots: string[]): string {
  return hits.map((hit) => {
    const path = workspaceAliasPath(hit.path, roots);
    const symbol = hit.symbol ? ` ${hit.symbol}` : '';
    const score = hit.provenance?.score;
    const breakdown = score
      ? ` bm25=${score.bm25.toFixed(2)} path=${score.path.toFixed(2)} symbol=${score.symbol.toFixed(2)} graph=${score.graph.toFixed(2)} recency=${score.recency.toFixed(6)} diagnostic=${score.diagnostic.toFixed(3)}`
      : '';
    const hash = hit.provenance?.contentHash.slice(0, 12);
    return `[${hit.source} ${hit.score.toFixed(3)}${breakdown}${hash ? ` hash=${hash}` : ''}]${symbol} ${path}:${hit.startLine}-${hit.endLine}`;
  }).join('\n');
}
