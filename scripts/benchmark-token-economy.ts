import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {resolve} from 'node:path';
import {selectContextBudget} from '../src/context/budget.js';
import {dynamicToolOutputBudget} from '../src/agent/tool-output.js';
import {ToolRecoveryController} from '../src/agent/tool-recovery.js';
import type {ContextBudgetTier, ContextPackOptions, ToolCall, ToolResult} from '../src/types.js';

export interface TokenEconomyFixture {
  id: string;
  query: string;
  intent: NonNullable<ContextPackOptions['intent']>;
  requiredEvidenceTokens: number;
  toolOutputTokens: number;
  expectedTier: ContextBudgetTier;
  repeatedEmptySearches?: number;
}

export interface TokenEconomyBenchmarkReport {
  fixtureVersion: 'token-economy-benchmark-v1';
  measurement: 'deterministic-budget-replay';
  caseCount: number;
  aggregate: {
    baselineInputTokens: number;
    optimizedInputTokens: number;
    savedInputTokens: number;
    savingsRatio: number;
    evidenceCoverage: number;
    firewallCoverage: number;
    noProgressCircuitCoverage: number;
    runtimeMs: {p50: number; p95: number};
  };
  results: Array<{
    id: string;
    tier: ContextBudgetTier;
    tierMatches: boolean;
    baselineInputTokens: number;
    optimizedInputTokens: number;
    savedInputTokens: number;
    evidenceCovered: boolean;
    toolOutputCovered: boolean;
    repeatedSearchCallsAllowed: number;
    noProgressCircuitCovered: boolean;
    runtimeMs: number;
  }>;
}

const DEFAULT_FIXTURES = resolve('test/fixtures/token-economy-benchmark.json');
const LEGACY_RETRIEVAL_TOKENS = 12_000;
const LEGACY_TOOL_OUTPUT_TOKENS = 20_000;
const TOOL_CONTEXT_WINDOW = 24_000;
const TOOL_ACTIVE_CONTEXT = 8_000;
const TOOL_SESSION_REMAINING = 100_000;

if (process.argv[1]?.endsWith('benchmark-token-economy.ts')) {
  const report = await runTokenEconomyBenchmark(
    process.argv[2] ? resolve(process.argv[2]) : DEFAULT_FIXTURES,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export async function runTokenEconomyBenchmark(
  fixturePath = DEFAULT_FIXTURES,
): Promise<TokenEconomyBenchmarkReport> {
  const fixtures = await loadFixtures(fixturePath);
  const results: TokenEconomyBenchmarkReport['results'] = [];
  for (const fixture of fixtures) {
    const startedAt = performance.now();
    const decision = selectContextBudget(fixture.query, {
      context: {maxTokens: LEGACY_RETRIEVAL_TOKENS, topK: 16},
    }, {intent: fixture.intent});
    const baselineRetrieval = Math.min(LEGACY_RETRIEVAL_TOKENS, Math.max(
      fixture.requiredEvidenceTokens,
      decision.budgetTokens,
    ));
    const optimizedRetrieval = Math.min(decision.budgetTokens, fixture.requiredEvidenceTokens);
    const optimizedTool = Math.min(fixture.toolOutputTokens, dynamicToolOutputBudget(
      TOOL_CONTEXT_WINDOW,
      TOOL_ACTIVE_CONTEXT,
      TOOL_SESSION_REMAINING,
    ));
    const repeatedSearchCallsAllowed = repeatedSearchCalls(fixture);
    const baselineInputTokens = baselineRetrieval + Math.min(
      fixture.toolOutputTokens,
      LEGACY_TOOL_OUTPUT_TOKENS,
    );
    const optimizedInputTokens = optimizedRetrieval + optimizedTool;
    results.push({
      id: fixture.id,
      tier: decision.tier,
      tierMatches: decision.tier === fixture.expectedTier,
      baselineInputTokens,
      optimizedInputTokens,
      savedInputTokens: Math.max(0, baselineInputTokens - optimizedInputTokens),
      evidenceCovered: decision.budgetTokens >= fixture.requiredEvidenceTokens,
      toolOutputCovered: fixture.toolOutputTokens <= optimizedTool || optimizedTool >= 1_024,
      repeatedSearchCallsAllowed,
      noProgressCircuitCovered: (fixture.repeatedEmptySearches ?? 0) === 0 || repeatedSearchCallsAllowed === 2,
      runtimeMs: round(performance.now() - startedAt),
    });
  }
  const baselineInputTokens = sum(results, 'baselineInputTokens');
  const optimizedInputTokens = sum(results, 'optimizedInputTokens');
  const runtimes = results.map((result) => result.runtimeMs);
  return {
    fixtureVersion: 'token-economy-benchmark-v1',
    measurement: 'deterministic-budget-replay',
    caseCount: fixtures.length,
    aggregate: {
      baselineInputTokens,
      optimizedInputTokens,
      savedInputTokens: baselineInputTokens - optimizedInputTokens,
      savingsRatio: ratio(baselineInputTokens - optimizedInputTokens, baselineInputTokens),
      evidenceCoverage: ratio(results.filter((result) => result.evidenceCovered).length, results.length),
      firewallCoverage: ratio(results.filter((result) => result.toolOutputCovered).length, results.length),
      noProgressCircuitCoverage: ratio(results.filter((result) => result.noProgressCircuitCovered).length, results.length),
      runtimeMs: {p50: percentile(runtimes, 0.5), p95: percentile(runtimes, 0.95)},
    },
    results,
  };
}

async function loadFixtures(path: string): Promise<TokenEconomyFixture[]> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('Token Economy fixtures must be a non-empty array.');
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Fixture ${index + 1} must be an object.`);
    const value = entry as Partial<TokenEconomyFixture>;
    if (typeof value.id !== 'string' || !value.id || typeof value.query !== 'string' || !value.query ||
      !['explain', 'review', 'debug', 'refactor', 'test', 'implement'].includes(String(value.intent)) ||
      !Number.isInteger(value.requiredEvidenceTokens) || Number(value.requiredEvidenceTokens) < 0 ||
      !Number.isInteger(value.toolOutputTokens) || Number(value.toolOutputTokens) < 0 ||
      !['none', 'focused', 'standard', 'broad', 'maximum'].includes(String(value.expectedTier)) ||
      (value.repeatedEmptySearches !== undefined && (!Number.isInteger(value.repeatedEmptySearches) || value.repeatedEmptySearches < 0))) {
      throw new Error(`Fixture ${index + 1} is invalid.`);
    }
    return value as TokenEconomyFixture;
  });
}

function repeatedSearchCalls(fixture: TokenEconomyFixture): number {
  const requested = fixture.repeatedEmptySearches ?? 0;
  if (!requested) return 0;
  const controller = new ToolRecoveryController();
  let allowed = 0;
  for (let index = 0; index < requested; index += 1) {
    const call: ToolCall = {id: `search-${index}`, name: 'search_code', arguments: {query: fixture.query}};
    if (controller.preflight(call)) break;
    allowed += 1;
    const result: ToolResult = {
      toolCallId: call.id,
      name: call.name,
      ok: true,
      content: 'No matches found.',
      metadata: {count: 0},
    };
    controller.recordEvidence(call, result);
  }
  return allowed;
}

function sum(
  values: TokenEconomyBenchmarkReport['results'],
  key: 'baselineInputTokens' | 'optimizedInputTokens',
): number {
  return values.reduce((total, value) => total + value[key], 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? round(numerator / denominator) : 0;
}

function percentile(values: number[], ratioValue: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratioValue) - 1)] ?? 0;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
