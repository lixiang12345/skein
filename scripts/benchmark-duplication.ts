import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {auditChangedFunctions} from '../src/agent/duplication-audit.js';
import {extractFunctionFingerprints} from '../src/context/function-fingerprint.js';
import type {DuplicationAuditReceipt, FunctionFingerprint} from '../src/types.js';

export type DuplicationExpectation = 'type-1-or-2' | 'type-3' | 'none';

export interface DuplicationBenchmarkCase {
  id: string;
  baseline: string;
  current: string;
  destination: string;
  expected: DuplicationExpectation;
}

export interface DuplicationThresholdReport {
  threshold: number;
  expectedPositiveCases: number;
  truePositiveCases: number;
  correctlyClassifiedCases: number;
  falsePositiveCases: number;
  recall: number;
  precision: number;
  falsePositiveRate: number;
  warningCount: number;
  latencyMs: {p50: number; p95: number};
  results: Array<{
    id: string;
    expected: DuplicationExpectation;
    actual: DuplicationExpectation;
    matches: number;
    latencyMs: number;
  }>;
}

export interface DuplicationBenchmarkReport {
  fixtureVersion: string;
  caseCount: number;
  thresholds: DuplicationThresholdReport[];
  recommendation: {
    threshold: number;
    precisionTarget: number;
    decision: 'type-1-2-blocking' | 'insufficient-precision';
  };
}

interface ManifestCase extends DuplicationBenchmarkCase {
  baselineDestination: string;
}

const defaultManifest = resolve('test/fixtures/duplication-benchmark/manifest.json');
const thresholdValues = [0.55, 0.6, 0.65, 0.7];
const PRECISION_TARGET = 0.95;

if (process.argv[1]?.endsWith('benchmark-duplication.ts')) {
  const manifest = process.argv[2] ? resolve(process.argv[2]) : defaultManifest;
  const report = await runDuplicationBenchmark(manifest);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export async function runDuplicationBenchmark(manifestPath = defaultManifest): Promise<DuplicationBenchmarkReport> {
  const fixtureRoot = resolve(manifestPath, '..');
  const cases = await loadManifest(manifestPath);
  const thresholds: DuplicationThresholdReport[] = [];
  for (const threshold of thresholdValues) {
    thresholds.push(await runThreshold(fixtureRoot, cases, threshold));
  }
  const calibrated = thresholds.find((report) =>
    report.precision >= PRECISION_TARGET && report.recall >= 1 && report.falsePositiveRate === 0,
  );
  return {
    fixtureVersion: 'duplication-benchmark-v1',
    caseCount: cases.length,
    thresholds,
    recommendation: calibrated
      ? {threshold: calibrated.threshold, precisionTarget: PRECISION_TARGET, decision: 'type-1-2-blocking'}
      : {threshold: thresholdValues.at(-1) ?? 0.7, precisionTarget: PRECISION_TARGET, decision: 'insufficient-precision'},
  };
}

async function runThreshold(
  fixtureRoot: string,
  cases: ManifestCase[],
  threshold: number,
): Promise<DuplicationThresholdReport> {
  const results: DuplicationThresholdReport['results'] = [];
  for (const [index, benchmarkCase] of cases.entries()) {
    const root = join(tmpdir(), `skein-duplication-benchmark-${process.pid}-${Date.now()}-${index}`);
    try {
      const baselineFunctions = await materializeBaseline(fixtureRoot, root, cases);
      const changedPath = await materializeCurrent(fixtureRoot, root, benchmarkCase);
      const startedAt = performance.now();
      const receipt = await auditChangedFunctions({
        baseline: {generation: 'duplication-benchmark-v1', functions: baselineFunctions},
        changedFiles: [changedPath],
        changeSequence: index + 1,
        nearCloneThreshold: threshold,
      });
      const latencyMs = round(performance.now() - startedAt);
      results.push({
        id: benchmarkCase.id,
        expected: benchmarkCase.expected,
        actual: actualKind(receipt),
        matches: receipt?.matches.length ?? 0,
        latencyMs,
      });
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }
  const expectedPositive = results.filter((result) => result.expected !== 'none');
  const negatives = results.filter((result) => result.expected === 'none');
  const truePositives = expectedPositive.filter((result) => result.actual !== 'none').length;
  const correctlyClassified = expectedPositive.filter((result) => result.actual === result.expected).length;
  const falsePositives = negatives.filter((result) => result.actual !== 'none').length;
  const warningCount = results.reduce((sum, result) => sum + result.matches, 0);
  const positiveMatches = results.filter((result) => result.actual !== 'none').length;
  const latencies = results.map((result) => result.latencyMs);
  return {
    threshold,
    expectedPositiveCases: expectedPositive.length,
    truePositiveCases: truePositives,
    correctlyClassifiedCases: correctlyClassified,
    falsePositiveCases: falsePositives,
    recall: ratio(truePositives, expectedPositive.length),
    precision: ratio(truePositives, positiveMatches),
    falsePositiveRate: ratio(results.filter((result) => result.expected === 'none' && result.actual !== 'none').length, negatives.length),
    warningCount,
    latencyMs: {p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95)},
    results,
  };
}

async function materializeBaseline(
  fixtureRoot: string,
  root: string,
  cases: ManifestCase[],
): Promise<FunctionFingerprint[]> {
  const files = new Map<string, string>();
  for (const benchmarkCase of cases) {
    if (files.has(benchmarkCase.baselineDestination)) continue;
    files.set(benchmarkCase.baselineDestination, await readFile(join(fixtureRoot, benchmarkCase.baseline), 'utf8'));
  }
  await Promise.all([...files.entries()].map(async ([destination, content]) => {
    const path = join(root, destination);
    await mkdir(resolve(path, '..'), {recursive: true});
    await writeFile(path, content);
  }));
  return [...files.entries()].flatMap(([destination, content]) =>
    extractFunctionFingerprints(join(root, destination), content)
      .map(({normalizedTokens: _tokens, ...fingerprint}) => fingerprint),
  );
}

async function materializeCurrent(
  fixtureRoot: string,
  root: string,
  benchmarkCase: ManifestCase,
): Promise<string> {
  const path = join(root, benchmarkCase.destination);
  await mkdir(resolve(path, '..'), {recursive: true});
  await writeFile(path, await readFile(join(fixtureRoot, benchmarkCase.current), 'utf8'));
  return path;
}

async function loadManifest(path: string): Promise<ManifestCase[]> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('Duplication benchmark manifest must be a non-empty array.');
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Fixture ${index + 1} must be an object.`);
    const value = entry as Partial<DuplicationBenchmarkCase>;
    if (typeof value.id !== 'string' || typeof value.baseline !== 'string' ||
      typeof value.current !== 'string' || typeof value.destination !== 'string' ||
      !['type-1-or-2', 'type-3', 'none'].includes(String(value.expected))) {
      throw new Error(`Fixture ${index + 1} is invalid.`);
    }
    const id = value.id;
    const baseline = value.baseline;
    const current = value.current;
    const destination = value.destination;
    const expected = value.expected as DuplicationExpectation;
    const baselineDestination = `src/${baseline.split('/').at(-1)}`;
    return {id, baseline, current, destination, expected, baselineDestination};
  });
}

function actualKind(receipt: DuplicationAuditReceipt | undefined): DuplicationExpectation {
  const match = receipt?.matches[0];
  if (!match) return 'none';
  return match.kind;
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? round(numerator / denominator) : 0;
}

function percentile(values: number[], ratioValue: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratioValue) - 1)] ?? 0);
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
