import React from 'react';
import {renderToString} from 'ink';
import stripAnsi from 'strip-ansi';
import {describe, expect, it} from 'vitest';

import {Timeline} from '../../src/ui/components.js';
import {resolveThemeWithColor, ThemeProvider} from '../../src/ui/theme.js';
import {estimateTimelineItemRows} from '../../src/ui/viewport.js';

const theme = resolveThemeWithColor(undefined, false);

function renderBanner(width: number, extras: Record<string, unknown> = {}): string {
  return stripAnsi(renderToString(
    <ThemeProvider theme={theme}>
      <Timeline width={width} items={[
        {id: 'b', kind: 'banner', engine: 'local', status: 'ready', version: '0.3.47', ...extras},
      ]} />
    </ThemeProvider>,
    {columns: width},
  ));
}

describe('fresh-session banner', () => {
  it('opens wide sessions on the block wordmark with a persistent readiness receipt', () => {
    const wide = renderBanner(80, {files: 279, chunks: 1204, rebuilt: false, workspace: '/tmp/demo', model: 'openai/gpt-test', trust: 'guarded'});
    expect(wide).toContain('███');
    expect(wide).toContain('context-first coding agent · v0.3.47');
    expect(wide).toContain('local context · 279 files · 1,204 chunks · reused');
    expect(wide).toContain('workspace');
    expect(wide).toContain('openai/gpt-test');
    expect(wide).toContain('guarded permissions');
    expect(wide).toContain('try "explain this codebase"');
  });

  it('reports a rebuilt index with its build duration', () => {
    const wide = renderBanner(80, {files: 28, chunks: 71, rebuilt: true, durationMs: 42});
    expect(wide).toContain('28 files · 71 chunks · indexed in 42ms');
  });

  it('drops to the text wordmark before the logo can overflow narrow terminals', () => {
    const narrow = renderBanner(40, {files: 279});
    expect(narrow).not.toContain('█');
    expect(narrow).toContain('SKEIN');
    expect(narrow).toContain('279 files');
    const tiny = renderBanner(24);
    expect(tiny).toContain('ready');
    expect(tiny).not.toContain('SKEIN');
    expect(stripAnsi(tiny).trimEnd().split('\n')).toHaveLength(1);
  });

  it('keeps prior-session content out of the resting frame', () => {
    const resume = {title: 'fix webhook retry', updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString()};
    const wide = renderBanner(80, {resume});
    expect(wide).not.toContain('last session');
    expect(wide).not.toContain('fix webhook retry');
    expect(wide).not.toContain('skein --continue');
  });

  it('estimates the exact banner height the renderer produces', () => {
    const base = {id: 'b', kind: 'banner', engine: 'local', status: 'ready', version: '0'} as const;
    for (const [width, extras] of [
      [80, {}],
      [80, {files: 279, chunks: 1204, workspace: '/tmp/demo', model: 'openai/gpt-test', trust: 'guarded'}],
      [48, {files: 279}],
      [40, {files: 279}],
      [24, {}],
    ] as const) {
      const item = {...base, ...extras};
      const rendered = stripAnsi(renderToString(
        <ThemeProvider theme={theme}><Timeline width={width} items={[item]} /></ThemeProvider>,
        {columns: width},
      ));
      // The trailing transcript gap is the one blank row trimEnd removes.
      const renderedRows = rendered.replace(/\n$/, '').trimEnd().split('\n').length + 1;
      expect(
        estimateTimelineItemRows(item, {width, rows: 40}),
        `estimate drifted from render at ${width} columns`,
      ).toBe(renderedRows);
    }
  });
});
