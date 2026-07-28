import React from 'react';
import {renderToString} from 'ink';
import stripAnsi from 'strip-ansi';
import {describe, expect, it} from 'vitest';

import {ActivityLine, Timeline} from '../../src/ui/components.js';
import {resolveThemeWithColor, ThemeProvider} from '../../src/ui/theme.js';
import {estimateTimelineItemRows, fitTimelineToRows} from '../../src/ui/viewport.js';

const theme = resolveThemeWithColor(undefined, false);

const turnItem = {
  id: 'turn-1', kind: 'turn', turn: 2, model: 'claude-opus-5',
  durationMs: 6_100, inputTokens: 9_800, outputTokens: 640,
} as const;

describe('per-interaction telemetry', () => {
  it('settles each model interaction into one quiet receipt row', () => {
    const output = stripAnsi(renderToString(
      <ThemeProvider theme={theme}><Timeline width={100} items={[turnItem]} /></ThemeProvider>,
      {columns: 100},
    ));
    expect(output).toContain('turn 2');
    expect(output).toContain('claude-opus-5');
    expect(output).toContain('↑9.8k ↓640 tok');
    expect(output.trimEnd().split('\n')).toHaveLength(1);
    expect(estimateTimelineItemRows(turnItem, {width: 100, rows: 24})).toBe(1);
  });

  it('keeps the receipt inside a one-row budget and ASCII glyph sets', () => {
    const fitted = fitTimelineToRows([turnItem], {width: 100, rows: 1});
    expect(fitted).toHaveLength(1);
    const ascii = stripAnsi(renderToString(
      <ThemeProvider theme={theme}><Timeline width={100} glyphMode="ascii" items={[turnItem]} /></ThemeProvider>,
      {columns: 100},
    ));
    expect(ascii).toContain('up9.8k dn640 tok');
    expect(ascii).not.toMatch(/[↑↓◇]/u);
  });

  it('shows the run clock and token flow beside the live activity label', () => {
    const output = stripAnsi(renderToString(
      <ThemeProvider theme={theme}>
        <ActivityLine
          activity={{label: 'Weaving the reply', startedAt: Date.now(), turn: 2}}
          frame="◉"
          width={100}
          run={{startedAt: Date.now() - 12_000, inputTokens: 12_400, outputTokens: 1_150}}
        />
      </ThemeProvider>,
      {columns: 100},
    ));
    expect(output).toContain('Weaving the reply');
    expect(output).toContain('turn 2');
    expect(output).toContain('12s');
    expect(output).toContain('↑12k ↓1.1k tok');
    expect(output).toContain('esc interrupts');
  });

  it('hides zero-token flow instead of printing an empty counter', () => {
    const output = stripAnsi(renderToString(
      <ThemeProvider theme={theme}>
        <ActivityLine
          activity={{label: 'Gathering threads', startedAt: Date.now()}}
          frame="◉"
          width={100}
          run={{startedAt: Date.now(), inputTokens: 0, outputTokens: 0}}
        />
      </ThemeProvider>,
      {columns: 100},
    ));
    expect(output).toContain('Gathering threads');
    expect(output).not.toContain('tok');
  });
});
