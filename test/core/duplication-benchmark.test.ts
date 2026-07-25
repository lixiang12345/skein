import {describe, expect, it} from 'vitest';
import {runDuplicationBenchmark} from '../../scripts/benchmark-duplication.js';

describe('duplication benchmark fixtures', () => {
  it('keeps planted clone recall and legitimate-boundary precision deterministic', async () => {
    const report = await runDuplicationBenchmark();
    expect(report.fixtureVersion).toBe('duplication-benchmark-v1');
    expect(report.caseCount).toBe(7);
    const calibrated = report.thresholds.find((threshold) => threshold.threshold === report.recommendation.threshold);
    expect(calibrated).toBeDefined();
    expect(calibrated?.recall).toBe(1);
    expect(calibrated?.precision).toBe(1);
    expect(calibrated?.correctlyClassifiedCases).toBe(2);
    expect(calibrated?.falsePositiveRate).toBe(0);
    expect(report.recommendation.decision).toBe('type-1-2-blocking');
    expect(report.thresholds.every((threshold) => threshold.results.length === 7)).toBe(true);
  }, 15_000);
});
