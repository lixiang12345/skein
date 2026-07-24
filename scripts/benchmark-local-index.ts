import {readFile, rm} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {relative, resolve, sep} from 'node:path';
import {LocalContextIndex} from '../src/context/local-index.js';

interface BenchmarkCase {
  id: string;
  query: string;
  relevant: string[];
}

interface ParsedArguments {
  workspace: string;
  cases: string;
  topK: number;
  freshIndex: boolean;
}

const args = parseArguments(process.argv.slice(2));
const cases = await loadCases(args.cases);
const index = new LocalContextIndex([args.workspace]);
if (args.freshIndex) await rm(index.indexPath, {force: true});

const coldStartedAt = performance.now();
const coldIndex = await index.build();
const coldIndexMs = performance.now() - coldStartedAt;
const queryLatencies: number[] = [];
const rows: Array<Record<string, unknown>> = [];
let staleHits = 0;
let totalHits = 0;
let usefulTokens = 0;
let totalTokens = 0;

for (const benchmark of cases) {
  const startedAt = performance.now();
  const hits = await index.search(benchmark.query, args.topK);
  const durationMs = performance.now() - startedAt;
  queryLatencies.push(durationMs);
  const relevant = new Set(benchmark.relevant.map(normalizePath));
  const paths = hits.map((hit) => normalizePath(relative(args.workspace, hit.path)));
  const firstRelevant = paths.findIndex((path) => relevant.has(path));
  const tokenCount = hits.reduce((sum, hit) => sum + estimateTokens(hit.content), 0);
  const useful = hits
    .filter((hit) => relevant.has(normalizePath(relative(args.workspace, hit.path))))
    .reduce((sum, hit) => sum + estimateTokens(hit.content), 0);
  const stale = await countStaleHits(hits);
  staleHits += stale;
  totalHits += hits.length;
  usefulTokens += useful;
  totalTokens += tokenCount;
  rows.push({
    id: benchmark.id,
    query: benchmark.query,
    relevant: benchmark.relevant,
    returned: paths,
    recallAt5: recallAt(paths, relevant, 5),
    recallAt10: recallAt(paths, relevant, 10),
    recallAt20: recallAt(paths, relevant, 20),
    reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    usefulTokenRatio: tokenCount ? useful / tokenCount : 0,
    staleHits: stale,
    latencyMs: round(durationMs),
  });
}

const incrementalStartedAt = performance.now();
const incrementalIndex = await index.build();
const incrementalIndexMs = performance.now() - incrementalStartedAt;

process.stdout.write(`${JSON.stringify({
  workspace: args.workspace,
  caseFile: args.cases,
  topK: args.topK,
  index: {
    cold: {...coldIndex, durationMs: round(coldIndexMs)},
    incremental: {...incrementalIndex, durationMs: round(incrementalIndexMs)},
  },
  aggregate: {
    recallAt5: mean(rows, 'recallAt5'),
    recallAt10: mean(rows, 'recallAt10'),
    recallAt20: mean(rows, 'recallAt20'),
    meanReciprocalRank: mean(rows, 'reciprocalRank'),
    usefulTokenRatio: totalTokens ? usefulTokens / totalTokens : 0,
    staleHitRate: totalHits ? staleHits / totalHits : 0,
    warmQueryLatencyMs: {
      p50: percentile(queryLatencies, 0.5),
      p95: percentile(queryLatencies, 0.95),
    },
  },
  results: rows,
}, null, 2)}\n`);

function parseArguments(values: string[]): ParsedArguments {
  const defaults: ParsedArguments = {
    workspace: process.cwd(),
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

async function loadCases(path: string): Promise<BenchmarkCase[]> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('Benchmark cases must be a non-empty JSON array.');
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Case ${index + 1} must be an object.`);
    const value = entry as Partial<BenchmarkCase>;
    if (typeof value.id !== 'string' || !value.id ||
      typeof value.query !== 'string' || !value.query ||
      !Array.isArray(value.relevant) || !value.relevant.length ||
      value.relevant.some((path) => typeof path !== 'string' || !path)) {
      throw new Error(`Case ${index + 1} requires id, query, and one or more relevant paths.`);
    }
    return {id: value.id, query: value.query, relevant: value.relevant};
  });
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

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
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
