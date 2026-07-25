import type {ContextBudgetTier, ContextPackOptions, MosaicConfig, PackedContext} from '../types.js';

export interface ContextBudgetDecision {
  tier: ContextBudgetTier;
  budgetTokens: number;
  baseBudgetTokens: number;
  incrementalBudgetTokens: number;
  topK: number;
  reason: string;
}

const tierTokens: Record<Exclude<ContextBudgetTier, 'none'>, number> = {
  focused: 2_000,
  standard: 4_000,
  broad: 8_000,
  maximum: 12_000,
};

export function selectContextBudget(
  query: string,
  config: Pick<MosaicConfig, 'context'>,
  options: ContextPackOptions = {},
): ContextBudgetDecision {
  if (options.trivial) return noContextBudget('trivial turn; retrieval skipped');

  const configuredCeiling = positiveFloor(options.maxTokens ?? config.context.maxTokens);
  const configuredTopK = positiveFloor(options.topK ?? config.context.topK);
  if (configuredCeiling === 0 || configuredTopK === 0) {
    return noContextBudget('retrieval disabled by the configured context ceiling');
  }

  const normalized = query.trim().toLocaleLowerCase();
  const explicitPaths = countExplicitPaths(query);
  const breadthSignals = countMatches(normalized, [
    /\b(?:cross[- ]module|cross[- ]package|across modules|across packages|entire repository|whole repository|whole codebase|all modules|all packages|end[- ]to[- ]end)\b/gu,
    /跨模块|跨包|全仓库|全代码库|整个(?:项目|仓库|代码库)|所有(?:模块|包)|端到端/gu,
  ]);
  const exhaustiveSignals = countMatches(normalized, [
    /\b(?:exhaustive|comprehensive|repository[- ]wide|codebase[- ]wide|all call sites|all usages|architecture migration|security audit)\b/gu,
    /全面|完整审计|全量|全局迁移|所有调用|所有引用|架构迁移|安全审计/gu,
  ]);
  const coordinationSignals = countMatches(normalized, [
    /\b(?:and|then|also|plus|including|migrate|redesign|architecture|integration|workflow)\b/gu,
    /并且|然后|同时|以及|包括|迁移|重设计|架构|集成|工作流/gu,
  ]);

  let tier: Exclude<ContextBudgetTier, 'none'>;
  let reason: string;
  if (breadthSignals > 0 && exhaustiveSignals > 0 &&
    (coordinationSignals >= 2 || normalized.length >= 180)) {
    tier = 'maximum';
    reason = 'explicit repository-wide work with exhaustive, multi-part scope';
  } else if (breadthSignals > 0 || exhaustiveSignals >= 2) {
    tier = 'broad';
    reason = 'cross-module or repository-wide evidence requested';
  } else if (explicitPaths > 0 && coordinationSignals < 2) {
    tier = 'focused';
    reason = 'one or more explicit paths bound the evidence surface';
  } else if ((options.intent === 'explain' || options.intent === 'review' || options.intent === 'test') &&
    normalized.length <= 160 && coordinationSignals < 2) {
    tier = 'focused';
    reason = `short ${options.intent} request with a narrow evidence surface`;
  } else {
    tier = 'standard';
    reason = 'ordinary implementation, debugging, or refactoring request';
  }

  const requestedTokens = tierTokens[tier];
  const budgetTokens = Math.min(configuredCeiling, requestedTokens);
  const baseBudgetTokens = Math.min(budgetTokens, tierTokens.focused);
  const incrementalBudgetTokens = Math.max(0, budgetTokens - baseBudgetTokens);
  const topKByTier: Record<Exclude<ContextBudgetTier, 'none'>, number> = {
    focused: 4,
    standard: 8,
    broad: 12,
    maximum: 16,
  };
  const topK = Math.min(configuredTopK, topKByTier[tier]);
  const capped = budgetTokens < requestedTokens ? `; capped by configuration at ${budgetTokens} tokens` : '';
  return {
    tier,
    budgetTokens,
    baseBudgetTokens,
    incrementalBudgetTokens,
    topK,
    reason: `${reason}${capped}`,
  };
}

export function emptyPackedContext(
  decision: ContextBudgetDecision,
  engine = 'local',
): PackedContext {
  return {
    text: '',
    hits: [],
    estimatedTokens: 0,
    engine,
    truncated: false,
    budgetTier: decision.tier,
    budgetTokens: decision.budgetTokens,
    baseBudgetTokens: decision.baseBudgetTokens,
    incrementalBudgetTokens: decision.incrementalBudgetTokens,
    budgetReason: decision.reason,
    candidateHits: 0,
    selectedHits: 0,
    duplicateHits: 0,
    incrementalEvidenceTokens: 0,
  };
}

function noContextBudget(reason: string): ContextBudgetDecision {
  return {
    tier: 'none',
    budgetTokens: 0,
    baseBudgetTokens: 0,
    incrementalBudgetTokens: 0,
    topK: 0,
    reason,
  };
}

function positiveFloor(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function countMatches(value: string, patterns: RegExp[]): number {
  return patterns.reduce((total, pattern) => total + [...value.matchAll(pattern)].length, 0);
}

function countExplicitPaths(value: string): number {
  const matches = value.match(/(?:^|[\s'"`(])@?(?:\.{0,2}[/\\]|[A-Za-z]:[/\\]|[\w.-]+[/\\])[\w@%+.,()[\]{}=-]+(?:[/\\][\w@%+.,()[\]{}=-]+)*(?:\.\w+)?/gu);
  return matches?.length ?? 0;
}
