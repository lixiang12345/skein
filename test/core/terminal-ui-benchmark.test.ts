import {describe, expect, it} from 'vitest';
import {runTerminalUiBenchmark} from '../../scripts/benchmark-terminal-ui.js';

describe('terminal UI benchmark', () => {
  it('keeps input processing and bounded streaming renders within executable budgets', () => {
    const report = runTerminalUiBenchmark();
    expect(report.fixtureVersion).toBe('terminal-ui-benchmark-v1');
    expect(report.measurement).toBe('single-process-local-render');
    expect(report.input.samples).toBe(120);
    expect(report.streamingRender.samples).toBe(40);
    expect(report.input.p95).toBeLessThanOrEqual(report.budgetsMs.inputP95);
    expect(report.streamingRender.p95).toBeLessThanOrEqual(report.budgetsMs.streamingRenderP95);
    expect(report.finalFrame.widest).toBeLessThanOrEqual(report.finalFrame.width);
    expect(report.finalFrame.containsFinalChunk).toBe(true);
  });
});
