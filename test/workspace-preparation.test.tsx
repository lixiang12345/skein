import React from 'react';
import {renderToString} from 'ink';
import {describe, expect, it} from 'vitest';
import {prepareWorkspace, WorkspacePreparationView} from '../src/ui/workspace-preparation.js';
import {displayWidth} from '../src/ui/text.js';
import {resolveThemeWithColor, ThemeProvider} from '../src/ui/theme.js';

const testTheme = resolveThemeWithColor('graphite', false);

describe('workspace preparation', () => {
  it('turns a validated engine result into a shared readiness snapshot', async () => {
    const readiness = await prepareWorkspace({
      prepare: async () => ({
        rebuilt: true,
        validated: true,
        files: 4,
        chunks: 9,
        reused: 2,
        durationMs: 12,
        generation: 'generation-1',
        path: '/tmp/.skein/index.json',
      }),
    });

    expect(readiness).toMatchObject({engine: 'local', validated: true, files: 4, chunks: 9});
    expect(Date.parse(readiness.preparedAt)).not.toBeNaN();
  });

  it.each([20, 40, 80, 120])('keeps live and ready states within %i columns', (width) => {
    const variants = [
      <WorkspacePreparationView
        key="live"
        progress={{phase: 'index', completed: 12, total: 42, path: 'src/一个很长的多语言文件名称.ts'}}
        workspace="/tmp/a-very-long-workspace-name"
        model="compatible/a-very-long-model-name"
        width={width}
      />,
      <WorkspacePreparationView
        key="ready"
        progress={{phase: 'done', completed: 42, total: 42}}
        readiness={{
          engine: 'local', rebuilt: true, validated: true, files: 42, chunks: 108, reused: 20,
          durationMs: 120, generation: 'abc', path: '/tmp/.skein/index.json', preparedAt: new Date().toISOString(),
        }}
        workspace="/tmp/a-very-long-workspace-name"
        model="compatible/a-very-long-model-name"
        width={width}
      />,
    ];

    for (const variant of variants) {
      const output = renderToString(<ThemeProvider theme={testTheme}>{variant}</ThemeProvider>, {columns: width});
      for (const line of output.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('renders a bounded retry path when validation fails', () => {
    const output = renderToString(
      <ThemeProvider theme={testTheme}>
        <WorkspacePreparationView
          progress={{phase: 'validate', completed: 2, total: 2}}
          error="The persisted index does not match the prepared workspace snapshot."
          workspace="/tmp/project"
          model="openai/test"
          width={40}
        />
      </ThemeProvider>,
      {columns: 40},
    );
    expect(output).toContain('preparation failed');
    expect(output).toContain('Enter retry');
    expect(output).toContain('Esc exit');
  });
});
