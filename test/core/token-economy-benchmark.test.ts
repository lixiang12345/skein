import {describe, expect, it} from 'vitest';
import {runTokenEconomyBenchmark} from '../../scripts/benchmark-token-economy.js';

describe('Token Economy benchmark', () => {
  it('reduces replayed input without dropping required evidence or recovery boundaries', async () => {
    const report = await runTokenEconomyBenchmark();
    expect(report.fixtureVersion).toBe('token-economy-benchmark-v1');
    expect(report.measurement).toBe('deterministic-budget-replay');
    expect(report.caseCount).toBe(7);
    expect(report.aggregate.evidenceCoverage).toBe(1);
    expect(report.aggregate.firewallCoverage).toBe(1);
    expect(report.aggregate.noProgressCircuitCoverage).toBe(1);
    expect(report.aggregate.optimizedInputTokens).toBeLessThan(report.aggregate.baselineInputTokens);
    expect(report.aggregate.savingsRatio).toBeGreaterThan(0.25);
    expect(report.results.every((result) => result.tierMatches)).toBe(true);
  });
});
