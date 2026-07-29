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
  it('opens ordinary sessions on the flight mark with one readiness receipt', () => {
    const wide = renderBanner(80, {files: 279, chunks: 1204, rebuilt: false, workspace: '/tmp/demo', model: 'openai/gpt-test', trust: 'guarded'});
    expect(wide).toContain('__\\●▶');
    expect(wide).toContain('SKEIN');
    expect(wide).toContain('context-first coding agent · v0.3.47');
    expect(wide).toContain('local context · 279 files · 1,204 chunks · reused');
    // Workspace / model / trust stay in /status, not the resting banner.
    expect(wide).not.toContain('workspace');
    expect(wide).not.toContain('openai/gpt-test');
    expect(wide).not.toContain('guarded permissions');
    expect(wide).not.toContain('███████ ██');
    expect(wide).toContain('/help');
  });

  it('reports a rebuilt index with its build duration', () => {
    const wide = renderBanner(80, {files: 28, chunks: 71, rebuilt: true, durationMs: 42});
    expect(wide).toContain('28 files · 71 chunks · indexed in 42ms');
  });

  it('keeps the three-row goose for wide terminals only', () => {
    const ultra = renderBanner(120, {files: 279, chunks: 1204, rebuilt: false});
    expect(ultra).toContain('▄█●▶');
    expect(ultra).toContain('SKEIN');
    expect(ultra).toContain('local context · 279 files');
    // Block-letter wordmark stays retired; goose body uses denser cells that
    // would false-positive a bare `███` check.
    expect(ultra).not.toContain('███████');
  });

  it('drops to the text wordmark before the goose can overflow narrow terminals', () => {
    const narrow = renderBanner(40, {files: 279});
    expect(narrow).not.toContain('█');
    expect(narrow).toContain('SKEIN');
    expect(narrow).toContain('279 files');
    const tiny = renderBanner(24);
    expect(tiny).toContain('SKEIN');
    expect(tiny).toContain('ready');
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
      [120, {files: 279, chunks: 1204}],
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
