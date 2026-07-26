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
  it('shows real index size on wide terminals only', () => {
    const wide = renderBanner(80, {files: 279});
    expect(wide).toContain('279 files');
    const narrow = renderBanner(48, {files: 279});
    expect(narrow).not.toContain('279 files');
  });

  it('offers a resume pointer for the latest prior session', () => {
    const resume = {title: 'fix webhook retry', updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString()};
    const wide = renderBanner(80, {resume});
    expect(wide).toContain('last session "fix webhook retry"');
    expect(wide).toContain('2h ago');
    expect(wide).toContain('skein --continue');
  });

  it('hides the resume pointer on narrow terminals and keeps one-line banners', () => {
    const resume = {title: 'fix webhook retry', updatedAt: new Date().toISOString()};
    const narrow = renderBanner(40, {resume});
    expect(narrow).not.toContain('last session');
    expect(estimateTimelineItemRows({id: 'b', kind: 'banner', engine: 'local', status: 'ready', version: '0'}, {width: 80, rows: 24})).toBe(2);
    expect(estimateTimelineItemRows({id: 'b', kind: 'banner', engine: 'local', status: 'ready', version: '0', resume}, {width: 80, rows: 24})).toBe(3);
    expect(estimateTimelineItemRows({id: 'b', kind: 'banner', engine: 'local', status: 'ready', version: '0', resume}, {width: 40, rows: 24})).toBe(2);
  });
});
