import type {ContextDegradation, ContextHit, MosaicConfig, PackedContext} from '../types.js';
import {workspaceAliasPath} from '../utils/path.js';
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

  async pack(query: string): Promise<PackedContext> {
    try {
      const packed = await this.local.pack(
        query,
        this.config.context.topK,
        this.config.context.maxTokens,
      );
      this.degradation = undefined;
      return packed;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.degradation = {
        code: 'local-retrieval-failed',
        summary: 'Local code retrieval failed; continuing without retrieved code.',
        detail,
      };
      const degradation = this.lastDegradation();
      return {
        text: '',
        hits: [],
        estimatedTokens: 0,
        engine: 'local',
        truncated: false,
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
}

export function formatContextHits(hits: ContextHit[], roots: string[]): string {
  return hits.map((hit) => {
    const path = workspaceAliasPath(hit.path, roots);
    const symbol = hit.symbol ? ` ${hit.symbol}` : '';
    return `[${hit.source} ${hit.score.toFixed(3)}]${symbol} ${path}:${hit.startLine}-${hit.endLine}`;
  }).join('\n');
}
