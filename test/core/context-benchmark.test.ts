import {cp, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {runLocalIndexBenchmark} from '../../scripts/benchmark-local-index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('local Context Engine benchmark', () => {
  it('locks multilingual recall, provenance, freshness, and latency thresholds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-context-benchmark-'));
    roots.push(root);
    await cp(resolve('test/fixtures/context-benchmark'), root, {recursive: true});

    const report = await runLocalIndexBenchmark({
      workspace: root,
      cases: resolve('test/fixtures/context-benchmark.json'),
      topK: 20,
      freshIndex: true,
    });

    expect(report.fixtureVersion).toBe('context-benchmark-v2');
    expect(report.caseCount).toBe(8);
    expect(report.languages).toEqual(['cjk', 'markdown', 'mixed', 'python', 'sql', 'typescript']);
    expect(report.thresholdsPassed).toBe(true);
    expect(report.thresholdChecks).toEqual({
      recallAt5: true,
      recallAt10: true,
      meanReciprocalRank: true,
      usefulTokenRatio: true,
      staleHitRate: true,
      warmQueryP95Ms: true,
      incrementalIndexMs: true,
    });
    expect(report.aggregate.staleHitRate).toBe(0);
    expect(report.results.find((result) => result.id === 'typescript-import-adjacency'))
      .toMatchObject({recallAt5: 1, graphHits: expect.any(Number)});
    expect(report.results.find((result) => result.id === 'typescript-import-adjacency')?.graphHits)
      .toBeGreaterThan(0);
    expect(report.index.incremental).toMatchObject({
      reused: report.index.cold.files,
      generation: report.index.cold.generation,
    });
  });
});
