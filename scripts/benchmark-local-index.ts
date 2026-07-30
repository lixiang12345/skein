import {access, readFile, rm} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalContextIndex} from '../src/context/local-index.js';
import {estimateTokens} from '../src/utils/tokens.js';

export interface BenchmarkCase {
  id: string;
  language: string;
  query: string;
  relevant: string[];
}

export interface BenchmarkThresholds {
  recallAt5: number;
  recallAt10: number;
  meanReciprocalRank: number;
  usefulTokenRatio: number;
  staleHitRate: number;
  warmQueryP95Ms: number;
  incrementalIndexMs: number;
}

interface BenchmarkFixture {
  version: string;
  thresholds?: BenchmarkThresholds;
  cases: BenchmarkCase[];
}

export interface LocalIndexBenchmarkOptions {
  workspace: string;
  cases: string;
  topK?: number;
  freshIndex?: boolean;
}

export interface LocalIndexBenchmarkReport {
  fixtureVersion: string;
  workspace: string;
  caseFile: string;
  topK: number;
  caseCount: number;
  languages: string[];
  index: {
    cold: Record<string, unknown>;
    incremental: Record<string, unknown>;
  };
  aggregate: {
    recallAt5: number;
    recallAt10: number;
    recallAt20: number;
    meanReciprocalRank: number;
    usefulTokenRatio: number;
    staleHitRate: number;
    warmQueryLatencyMs: {p50: number; p95: number};
  };
  thresholds?: BenchmarkThresholds;
  thresholdChecks?: Record<keyof BenchmarkThresholds, boolean>;
  thresholdsPassed?: boolean;
  results: Array<{
    id: string;
    language: string;
    query: string;
    relevant: string[];
    returned: string[];
    recallAt5: number;
    recallAt10: number;
    recallAt20: number;
    reciprocalRank: number;
    usefulTokenRatio: number;
    staleHits: number;
    graphHits: number;
    latencyMs: number;
  }>;
}

interface ParsedArguments {
  workspace: string;
  cases: string;
  topK: number;
  freshIndex: boolean;
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  const report = await runLocalIndexBenchmark(args);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.thresholdsPassed === false) process.exitCode = 1;
}

export async function runLocalIndexBenchmark(
  options: LocalIndexBenchmarkOptions,
): Promise<LocalIndexBenchmarkReport> {
  const workspace = resolve(options.workspace);
  const caseFile = resolve(options.cases);
  const topK = options.topK ?? 20;
  const fixture = await loadFixture(caseFile);
  await assertWorkspaceContainsRelevantFiles(workspace, fixture.cases);
  const index = new LocalContextIndex([workspace]);
  if (options.freshIndex) await rm(index.indexPath, {force: true});

  const coldStartedAt = performance.now();
  const coldIndex = await index.build();
  const coldIndexMs = performance.now() - coldStartedAt;
  const queryLatencies: number[] = [];
  const results: LocalIndexBenchmarkReport['results'] = [];
  let staleHits = 0;
  let totalHits = 0;
  let usefulTokens = 0;
  let totalTokens = 0;

  for (const benchmark of fixture.cases) {
    const startedAt = performance.now();
    const hits = await index.search(benchmark.query, topK);
    const durationMs = performance.now() - startedAt;
    queryLatencies.push(durationMs);
    const relevant = new Set(benchmark.relevant.map(normalizePath));
    const paths = hits.map((hit) => normalizePath(relative(workspace, hit.path)));
    const firstRelevant = paths.findIndex((path) => relevant.has(path));
    const tokenCount = hits.reduce((sum, hit) => sum + estimateTokens(hit.content), 0);
    const useful = hits
      .filter((hit) => relevant.has(normalizePath(relative(workspace, hit.path))))
      .reduce((sum, hit) => sum + estimateTokens(hit.content), 0);
    const stale = await countStaleHits(hits);
    staleHits += stale;
    totalHits += hits.length;
    usefulTokens += useful;
    totalTokens += tokenCount;
    results.push({
      id: benchmark.id,
      language: benchmark.language,
      query: benchmark.query,
      relevant: benchmark.relevant,
      returned: paths,
      recallAt5: recallAt(paths, relevant, 5),
      recallAt10: recallAt(paths, relevant, 10),
      recallAt20: recallAt(paths, relevant, 20),
      reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
      usefulTokenRatio: tokenCount ? useful / tokenCount : 0,
      staleHits: stale,
      graphHits: hits.filter((hit) => (hit.provenance?.score.graph ?? 0) > 0).length,
      latencyMs: round(durationMs),
    });
  }

  const incrementalStartedAt = performance.now();
  const incrementalIndex = await index.build();
  const incrementalIndexMs = performance.now() - incrementalStartedAt;
  const aggregate = {
    recallAt5: round(mean(results, 'recallAt5')),
    recallAt10: round(mean(results, 'recallAt10')),
    recallAt20: round(mean(results, 'recallAt20')),
    meanReciprocalRank: round(mean(results, 'reciprocalRank')),
    usefulTokenRatio: round(totalTokens ? usefulTokens / totalTokens : 0),
    staleHitRate: round(totalHits ? staleHits / totalHits : 0),
    warmQueryLatencyMs: {
      p50: percentile(queryLatencies, 0.5),
      p95: percentile(queryLatencies, 0.95),
    },
  };
  const thresholdChecks = fixture.thresholds
    ? evaluateThresholds(fixture.thresholds, aggregate, incrementalIndexMs)
    : undefined;
  return {
    fixtureVersion: fixture.version,
    workspace,
    caseFile,
    topK,
    caseCount: fixture.cases.length,
    languages: [...new Set(fixture.cases.map((item) => item.language))].sort(),
    index: {
      cold: {...coldIndex, durationMs: round(coldIndexMs)},
      incremental: {...incrementalIndex, durationMs: round(incrementalIndexMs)},
    },
    aggregate,
    ...(fixture.thresholds ? {thresholds: fixture.thresholds} : {}),
    ...(thresholdChecks ? {
      thresholdChecks,
      thresholdsPassed: Object.values(thresholdChecks).every(Boolean),
    } : {}),
    results,
  };
}

function parseArguments(values: string[]): ParsedArguments {
  const defaults: ParsedArguments = {
    workspace: resolve(process.cwd(), 'test/fixtures/context-benchmark'),
    cases: resolve(process.cwd(), 'test/fixtures/context-benchmark.json'),
    topK: 20,
    freshIndex: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const next = values[index + 1];
    if (value === '--workspace' && next) {
      defaults.workspace = resolve(next);
      index += 1;
    } else if (value === '--cases' && next) {
      defaults.cases = resolve(next);
      index += 1;
    } else if (value === '--top-k' && next) {
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new Error('--top-k must be an integer from 1 to 100.');
      defaults.topK = parsed;
      index += 1;
    } else if (value === '--fresh-index') {
      defaults.freshIndex = true;
    } else if (value === '--help' || value === '-h') {
      process.stdout.write('Usage: npm run benchmark:context -- [--workspace <path>] [--cases <file>] [--top-k <1..100>] [--fresh-index]\n\n--fresh-index removes the workspace local index before measuring cold indexing.\n');
      process.exit(0);
    } else {
      throw new Error(`Unknown benchmark argument: ${value}`);
    }
  }
  return defaults;
}

async function assertWorkspaceContainsRelevantFiles(
  workspace: string,
  cases: BenchmarkCase[],
): Promise<void> {
  const missing: string[] = [];
  for (const path of new Set(cases.flatMap((benchmark) => benchmark.relevant))) {
    const candidate = resolve(workspace, path);
    const relativePath = relative(workspace, candidate);
    const withinWorkspace = relativePath === '' ||
      (!relativePath.startsWith(`..${sep}`) && relativePath !== '..');
    if (!withinWorkspace) {
      missing.push(path);
      continue;
    }
    try {
      await access(candidate);
    } catch {
      missing.push(path);
    }
  }
  if (missing.length) {
    throw new Error(
      `Benchmark workspace is missing manifest relevant files: ${missing.join(', ')}. ` +
      'Use --workspace to select a corpus that matches --cases.',
    );
  }
}

async function loadFixture(path: string): Promise<BenchmarkFixture> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (Array.isArray(parsed)) {
    return {version: 'context-benchmark-v1', cases: validateCases(parsed)};
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Benchmark fixture must be an object.');
  const value = parsed as {version?: unknown; thresholds?: unknown; cases?: unknown};
  if (typeof value.version !== 'string' || !value.version) throw new Error('Benchmark fixture requires a version.');
  const cases = validateCases(value.cases);
  const thresholds = value.thresholds === undefined ? undefined : validateThresholds(value.thresholds);
  return {version: value.version, cases, ...(thresholds ? {thresholds} : {})};
}

function validateCases(value: unknown): BenchmarkCase[] {
  if (!Array.isArray(value) || !value.length) throw new Error('Benchmark cases must be a non-empty array.');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Case ${index + 1} must be an object.`);
    const item = entry as Partial<BenchmarkCase>;
    if (typeof item.id !== 'string' || !item.id ||
      typeof item.language !== 'string' || !item.language ||
      typeof item.query !== 'string' || !item.query ||
      !Array.isArray(item.relevant) || !item.relevant.length ||
      item.relevant.some((path) => typeof path !== 'string' || !path)) {
      throw new Error(`Case ${index + 1} requires id, language, query, and one or more relevant paths.`);
    }
    return item as BenchmarkCase;
  });
}

function validateThresholds(value: unknown): BenchmarkThresholds {
  if (!value || typeof value !== 'object') throw new Error('Benchmark thresholds must be an object.');
  const thresholds = value as Partial<BenchmarkThresholds>;
  for (const key of ['recallAt5', 'recallAt10', 'meanReciprocalRank', 'usefulTokenRatio', 'staleHitRate', 'warmQueryP95Ms', 'incrementalIndexMs'] as const) {
    if (typeof thresholds[key] !== 'number' || !Number.isFinite(thresholds[key])) {
      throw new Error(`Benchmark threshold ${key} must be a finite number.`);
    }
  }
  return thresholds as BenchmarkThresholds;
}

function evaluateThresholds(
  thresholds: BenchmarkThresholds,
  aggregate: LocalIndexBenchmarkReport['aggregate'],
  incrementalIndexMs: number,
): Record<keyof BenchmarkThresholds, boolean> {
  return {
    recallAt5: aggregate.recallAt5 >= thresholds.recallAt5,
    recallAt10: aggregate.recallAt10 >= thresholds.recallAt10,
    meanReciprocalRank: aggregate.meanReciprocalRank >= thresholds.meanReciprocalRank,
    usefulTokenRatio: aggregate.usefulTokenRatio >= thresholds.usefulTokenRatio,
    staleHitRate: aggregate.staleHitRate <= thresholds.staleHitRate,
    warmQueryP95Ms: aggregate.warmQueryLatencyMs.p95 <= thresholds.warmQueryP95Ms,
    incrementalIndexMs: incrementalIndexMs <= thresholds.incrementalIndexMs,
  };
}

async function countStaleHits(hits: Array<{path: string; startLine: number; endLine: number; content: string}>): Promise<number> {
  let stale = 0;
  for (const hit of hits) {
    try {
      const current = (await readFile(hit.path, 'utf8')).split('\n').slice(hit.startLine - 1, hit.endLine).join('\n');
      if (current !== hit.content) stale += 1;
    } catch {
      stale += 1;
    }
  }
  return stale;
}

function recallAt(paths: string[], relevant: Set<string>, limit: number): number {
  const matched = new Set(paths.slice(0, limit).filter((path) => relevant.has(path)));
  return matched.size / relevant.size;
}

function normalizePath(path: string): string {
  return path.replaceAll(sep, '/').replace(/^\.\//u, '');
}

function mean(rows: Array<Record<string, unknown>>, key: string): number {
  const values = rows.map((row) => Number(row[key] ?? 0));
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0);
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
