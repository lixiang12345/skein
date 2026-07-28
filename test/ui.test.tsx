import React from 'react';
import chalk from 'chalk';
import {renderToString, Text} from 'ink';
import stripAnsi from 'strip-ansi';
import {describe, expect, it} from 'vitest';
import {CommandPalette, ContextInspector, Footer, Header, PermissionCard, prepareTimelineItems, PromptBar, TaskRail, TeamSummary, TeamWorkbench, Timeline, WorkspacePanel} from '../src/ui/components.js';
import {toolMetaSummary} from '../src/ui/timeline-reducers.js';
import {displayWidth, sanitizeTerminalText} from '../src/ui/text.js';
import {detectTerminalAppearance, resolveTheme, resolveThemeWithColor, ThemeProvider} from '../src/ui/theme.js';
import {parseTerminalMouseInput, resolveKittyKeyboardConfig, resolveTerminalAccessibility} from '../src/ui/terminal-capabilities.js';
import {routeCostReceipt} from '../src/agent/route-cost.js';
import type {MosaicConfig, ToolCall} from '../src/types.js';

const config: MosaicConfig = {
  model: {provider: 'compatible', model: 'local'},
  workspaceRoots: ['/tmp/example'],
  context: {maxTokens: 12000, topK: 12},
  permissions: {
    read: 'allow', write: 'ask', shell: 'ask', git: 'ask', network: 'ask',
    allowCommands: [], denyCommands: [],
  },
  hooks: {},
  agent: {maxTurns: 24, maxSessionTokens: 250_000, autoVerify: true, verifyCommands: [], checkpointBeforeWrite: true},
  ui: {color: true, compact: false},
};

describe('terminal presentation', () => {
  it('parses wheel reports and classifies other mouse input for safe suppression', () => {
    expect(parseTerminalMouseInput('[<64;10;5M')).toBe('wheel-up');
    expect(parseTerminalMouseInput('[<65;10;5M')).toBe('wheel-down');
    expect(parseTerminalMouseInput('[<0;10;5M')).toBe('other');
    expect(parseTerminalMouseInput('ordinary input')).toBeUndefined();
  });
  it('surfaces only degraded context refresh metadata', () => {
    expect(toolMetaSummary({contextRefresh: {status: 'current', paths: 1}})).toBeUndefined();
    expect(toolMetaSummary({
      contextRefresh: {status: 'degraded', detail: 'index write failed'},
    })).toContain('context refresh degraded: index write failed');
  });

  it('does not probe unknown terminals for Kitty keyboard support', () => {
    expect(resolveKittyKeyboardConfig({TERM: 'xterm-256color'}).mode).toBe('disabled');
    expect(resolveKittyKeyboardConfig({TERM_PROGRAM: 'Apple_Terminal'}).mode).toBe('disabled');
    expect(resolveKittyKeyboardConfig({KITTY_WINDOW_ID: '1'}).mode).toBe('enabled');
    expect(resolveKittyKeyboardConfig({WEZTERM_PANE: '2'}).mode).toBe('enabled');
    expect(resolveKittyKeyboardConfig({
      KITTY_WINDOW_ID: '1',
      SKEIN_KITTY_KEYBOARD: 'off',
    }).mode).toBe('disabled');
    expect(resolveKittyKeyboardConfig({SKEIN_KITTY_KEYBOARD: 'on'}).mode).toBe('enabled');
  });

  it('resolves dumb and screen-reader terminals to stable monochrome output', () => {
    expect(resolveTerminalAccessibility({TERM: 'xterm-256color'})).toEqual({
      screenReader: false,
      reducedMotion: false,
      ascii: false,
      color: true,
      incrementalRendering: true,
    });
    expect(resolveTerminalAccessibility({TERM: 'dumb'})).toMatchObject({
      screenReader: false,
      reducedMotion: true,
      ascii: true,
      color: false,
      incrementalRendering: false,
    });
    expect(resolveTerminalAccessibility({
      TERM: 'xterm-256color',
      SKEIN_SCREEN_READER: '1',
    })).toMatchObject({
      screenReader: true,
      reducedMotion: true,
      ascii: true,
      color: false,
      incrementalRendering: false,
    });
  });

  it.each([
    ['unicode', {TERM: 'xterm-256color'}],
    ['no-color', {TERM: 'xterm-256color', NO_COLOR: '1'}],
    ['ascii', {TERM: 'xterm-256color', SKEIN_GLYPHS: 'ascii'}],
    ['dumb', {TERM: 'dumb'}],
    ['screen-reader', {TERM: 'xterm-256color', SKEIN_SCREEN_READER: '1'}],
  ])('keeps %s ready, permission, and error frames deterministic across terminal widths', (_profile, environment) => {
    const accessibility = resolveTerminalAccessibility(environment);
    const glyphMode = accessibility.ascii ? 'ascii' as const : 'auto' as const;
    const theme = resolveThemeWithColor('graphite', accessibility.color);
    for (const columns of [20, 24, 40, 80, 120]) {
      const frames = [
        renderToString(
          <ThemeProvider theme={theme}>
            <Header config={config} askMode={false} width={columns} glyphMode={glyphMode} />
            <Timeline width={columns} glyphMode={glyphMode} items={[
              {id: 'user', kind: 'user', text: '修复终端 🧪 final frame'},
              {id: 'assistant', kind: 'assistant', text: 'Ready with verified evidence.'},
            ]} />
            <PromptBar busy={false} value="" placeholder="Type a request" width={columns} glyphMode={glyphMode}>
              <Text>inspect</Text>
            </PromptBar>
            <Footer busy={false} tokens={0} maxTokens={250_000} changedFiles={0} width={columns} glyphMode={glyphMode} />
          </ThemeProvider>,
          {columns},
        ),
        renderToString(
          <ThemeProvider theme={theme}>
            <PermissionCard
              call={{id: 'permission', name: 'shell', arguments: {command: 'printf terminal-check'}}}
              category="shell"
              reason="Confirm the local verification command."
              width={columns}
              glyphMode={glyphMode}
              compact={columns <= 24}
            />
          </ThemeProvider>,
          {columns},
        ),
        renderToString(
          <ThemeProvider theme={theme}>
            <Timeline width={columns} glyphMode={glyphMode} items={[
              {id: 'error', kind: 'notice', tone: 'error', wrapWidth: columns, text: '运行失败 🧪 error evidence retained'},
            ]} />
          </ThemeProvider>,
          {columns},
        ),
      ];
      const visibleFrames = frames.map((frame) => stripAnsi(frame));
      expect(visibleFrames[0]).toContain('修复终端 🧪');
      expect(visibleFrames[0]).toContain('ready');
      expect(visibleFrames[1]).toContain('Permission requir');
      expect(visibleFrames[2]).toContain('运行失败 🧪');
      for (const frame of visibleFrames) {
        expect(frame).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u);
        for (const line of frame.split('\n')) {
          expect(displayWidth(line), `${_profile} ${columns}-column final frame overflowed: ${JSON.stringify(line)}`)
            .toBeLessThanOrEqual(columns);
        }
        if (accessibility.ascii) expect(frame).not.toMatch(/[⌁●✓◌◇▎─]/u);
      }
    }
  });

  it('renders the branded header, timeline, and plan without throwing', () => {
    const output = renderToString(
      <>
        <Header config={config} askMode={false} />
        <Timeline items={[
          {id: '1', kind: 'user', text: 'Fix the queue'},
          {
            id: '2',
            kind: 'context',
            engine: 'local',
            hits: 3,
            tokens: 420,
            degradation: {
              code: 'local-retrieval-failed',
              summary: 'Local retrieval unavailable',
            },
          },
          {id: '3', kind: 'tool', name: 'read_file', detail: 'src/queue.ts', state: 'ok'},
          {id: '4', kind: 'assistant', text: 'Done.'},
        ]} />
        <TaskRail tasks={[{id: 't1', title: 'Run tests', status: 'in_progress'}]} />
      </>,
    );
    expect(output).toContain('SKEIN');
    // Retrieval that worked stays out of the transcript; only the degradation
    // earns a row, and it says what went wrong rather than counting spans.
    expect(output).toContain('context/unavailable');
    expect(output).toContain('Local retrieval unavailable');
    expect(output).not.toContain('3 spans');
    // A tool that succeeded is a quiet aligned row with no status glyph.
    expect(output).toContain('read_file');
    expect(output).not.toContain('✓ read_file');
    expect(output).toContain('Fix the queue');
    expect(output).toContain('Run tests');
  });

  it('renders a factual workspace side panel without overflowing', () => {
    for (const width of [32, 38]) {
      const output = renderToString(<WorkspacePanel width={width} glyphMode="ascii" status={{
        model: 'compatible/a-medium-model',
        mode: 'build',
        context: 'ready',
        files: 142,
        chunks: 381,
        permissions: 'guarded',
        tools: 11,
        skills: 3,
        mcpConnected: 1,
        mcpTotal: 2,
        memory: 'on',
      }} />, {columns: width});
      expect(output).toContain('WORKSPACE');
      expect(output).toContain('local index ready');
      expect(output).toContain('CONTEXT');
      expect(output).toContain('RUNTIME');
      expect(output).toContain('EXTENSIONS');
      expect(output).toContain('guarded');
      for (const line of output.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it.each([20, 40, 80])('keeps completion evidence within %i columns', (columns) => {
    const output = renderToString(
      <Timeline
        width={columns}
        glyphMode="ascii"
        items={[
          {id: 'verified', kind: 'notice', tone: 'success', wrapWidth: columns, text: 'Verified | 2 current verification checks passed for 3 workspace files | npm run check'},
          {id: 'unverified', kind: 'notice', tone: 'warning', wrapWidth: columns, text: 'Unverified | No successful verification was recorded after the last change to 1 workspace file.'},
          {id: 'failed', kind: 'notice', tone: 'error', wrapWidth: columns, text: 'Verification failed | 1 of 2 current verification checks failed | npm test'},
        ]}
      />,
    );
    for (const line of output.split('\n')) {
      expect(displayWidth(line), `${columns}-column completion row overflowed: ${JSON.stringify(line)}`)
        .toBeLessThanOrEqual(columns);
    }
  });

  it('keeps context fallback reason and remediation visible at narrow widths', () => {
    for (const width of [20, 40, 80]) {
      const output = renderToString(
        <Timeline
          width={width}
          items={[{
            id: `context-${width}`,
            kind: 'context',
            engine: 'local',
            hits: 4,
            tokens: 640,
            degradation: {
              code: 'local-retrieval-failed',
              summary: 'Local index is unavailable for this workspace.',
              detail: 'Run `skein index` to build the local index.',
            },
          }]}
        />,
        {columns: width},
      );

      expect(output).toContain('context/');
      expect(output).toContain('Run');
      for (const line of output.split('\n')) {
        expect(displayWidth(line), `${width}-column context row overflowed: ${JSON.stringify(line)}`)
          .toBeLessThanOrEqual(width);
      }
    }
  });

  it('labels the explicit planning mode in the header', () => {
    const output = renderToString(<Header config={config} askMode planMode />);
    expect(output).toContain('PLAN');
  });

  it('keeps a long model identifier on one bounded header row', () => {
    const output = renderToString(<Header config={{
      ...config,
      model: {provider: 'compatible', model: 'a-very-long-model-name-that-must-not-wrap-opus-4-8'},
    }} askMode={false} width={80} />, {columns: 80});

    const rows = output.trimEnd().split('\n');
    expect(rows).toHaveLength(1);
    expect(displayWidth(rows[0] ?? '')).toBeLessThanOrEqual(80);
    expect(output).not.toContain('\n4-8');
  });

  it('keeps the fresh identity to one quiet row without terminal art or marketing copy', () => {
    const output = renderToString(<Header config={{
      ...config,
      workspaceRoots: ['/work/skein'],
      model: {provider: 'compatible', model: 'gpt-5.6-sol'},
    }} askMode={false} width={118} expanded />, {columns: 118});

    const rows = output.trimEnd().split('\n');
    // A one-cell product mark carries identity without turning the work surface
    // into an illustration.
    expect(rows).toHaveLength(1);
    expect(output).toContain('SKEIN');
    expect(output).toContain('BUILD');
    expect(output).toContain('⌁ SKEIN');
    expect(output).not.toMatch(/╭────────╮|________/u);
    expect(output).not.toContain('context in formation');
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(118);
  });

  it.each([72, 80, 120])('labels the active named connection without overflowing at %i columns', (columns) => {
    const output = renderToString(<Header config={{
      ...config,
      activeConnection: {
        id: 'team-relay-with-a-long-name',
        provider: 'compatible',
        protocol: 'openai-chat',
        source: 'environment',
        endpoint: 'https://relay.example/v1',
        modelsEndpoint: 'https://relay.example/v1',
        defaultModel: 'a-long-coding-model',
        authType: 'env',
        authStatus: 'configured',
        complete: true,
        issues: [],
      },
      model: {provider: 'compatible', model: 'a-long-coding-model'},
    }} askMode={false} width={columns} glyphMode="ascii" />, {columns});

    const rows = output.trimEnd().split('\n');
    expect(rows).toHaveLength(1);
    if (columns >= 80) expect(output).toContain('@team-relay');
    for (const row of rows) {
      expect(displayWidth(row), `${columns}-column connection header overflowed: ${JSON.stringify(row)}`)
        .toBeLessThanOrEqual(columns);
    }
  });

  it('reveals bounded tool output without allowing ANSI or control-sequence injection', () => {
    const output = renderToString(
      <Timeline showToolOutput items={[{
        id: 'tool-output',
        kind: 'tool',
        name: 'shell',
        detail: 'npm test',
        state: 'ok',
        output: '\u001B[31mPASS\u001B[0m\nline two\u0007',
      }]} />,
    );
    expect(output).toContain('PASS');
    expect(output).not.toContain('\u001B[31m');
    expect(output).not.toContain('\u0007');
    expect(sanitizeTerminalText('\u001B[2Jclear\u0007')).toBe('clear');
  });

  it('renders every tool state on one quiet aligned row, marking only what needs attention', () => {
    const items = prepareTimelineItems([
      {id: 'queued', kind: 'tool', name: 'queued_tool', detail: 'waiting', state: 'queued'},
      {id: 'running', kind: 'tool', name: 'running_tool', detail: 'working', state: 'running'},
      {id: 'success', kind: 'tool', name: 'read_file', detail: 'src/ui/tui.tsx', state: 'ok', output: 'read'},
      {id: 'failed', kind: 'tool', name: 'shell', detail: 'npm test', state: 'error', errorDetail: 'exit 1', output: 'failed'},
      {id: 'cancelled', kind: 'tool', name: 'search', detail: 'workspace', state: 'cancelled', errorDetail: 'Interrupted'},
    ], undefined, false);
    const output = renderToString(<Timeline items={items} width={80} glyphMode="ascii" />, {columns: 80});
    const rows = output.split('\n').filter((line) => line.trim());

    // Every call is one row: no group header, and no second detail line.
    expect(rows).toHaveLength(5);
    expect(output).not.toContain('Tools');
    expect(output).not.toContain('5 calls');
    for (const [name, detail] of [
      ['queued_tool', 'waiting'], ['running_tool', 'working'],
      ['read_file', 'src/ui/tui.tsx'], ['shell', 'exit 1'], ['search', 'Interrupted'],
    ]) {
      const row = rows.find((line) => line.includes(name as string));
      expect(row, `missing row for ${name}`).toBeDefined();
      expect(row).toContain(detail);
    }
    // Success and queued rows stay silent; only running, failed, and cancelled
    // claim the gutter. In ASCII those glyphs are `~`, `x`, and `!`.
    expect(rows.find((line) => line.includes('read_file'))?.startsWith(' ')).toBe(true);
    expect(rows.find((line) => line.includes('queued_tool'))?.startsWith(' ')).toBe(true);
    expect(rows.find((line) => line.includes('running_tool'))?.startsWith('~')).toBe(true);
    expect(rows.find((line) => line.includes('exit 1'))?.startsWith('x')).toBe(true);
    expect(rows.find((line) => line.includes('Interrupted'))?.startsWith('!')).toBe(true);
    for (const line of output.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });

  it('keeps running tools static when reduced motion is requested', () => {
    const previous = process.env.SKEIN_REDUCE_MOTION;
    process.env.SKEIN_REDUCE_MOTION = '1';
    try {
      const output = renderToString(<Timeline items={[
        {id: 'running', kind: 'tool', name: 'shell', detail: 'npm test', state: 'running'},
      ]} width={80} />);
      expect(output).toContain('◌');
      expect(output).not.toContain('⠋');
    } finally {
      if (previous === undefined) delete process.env.SKEIN_REDUCE_MOTION;
      else process.env.SKEIN_REDUCE_MOTION = previous;
    }
  });

  it("strips terminal capability-probe responses without eating normal bracketed text", () => {
    // Kitty keyboard / device-attribute probes get echoed back to stdin; Ink swallows
    // the ESC and leaks the tail (e.g. [?0u, [?62;c). Those must never reach output.
    expect(sanitizeTerminalText("[?0uhello")).toBe("hello");
    expect(sanitizeTerminalText("[?0uhello")).toBe("hello");
    expect(sanitizeTerminalText("done[?62;1;6c")).toBe("done");
    // Ordinary bracketed text must survive untouched.
    expect(sanitizeTerminalText("array[i] = [note]")).toBe("array[i] = [note]");
    expect(sanitizeTerminalText("[text](url) list[0].name")).toBe("[text](url) list[0].name");
  });

  it('keeps the narrow layout legible without squeezing metadata together', () => {
    const output = renderToString(
      <>
        <Header config={{
          ...config,
          workspaceRoots: ['/a/very/long/project/path'],
          model: {provider: 'compatible', model: 'a-model-with-a-long-name'},
        }} askMode width={40} />
        <Timeline width={40} items={[
          {id: 'tool', kind: 'tool', name: 'apply_patch', detail: 'src/queue/worker.ts', state: 'ok'},
        ]} />
        <Footer busy={false} tokens={1200} maxTokens={250_000} changedFiles={2} width={40} />
      </>,
      {columns: 40},
    );
    expect(output).toContain('SKEIN');
    expect(output).toContain('ASK');
    expect(output).toContain('apply_patch');
    expect(output).toContain('2 changed');
    expect(output).not.toContain('session active');
    expect(output).not.toContain('context-first coding agent');
  });

  it.each([20, 32, 48, 80])('renders update highlights without overflowing at %i columns', (columns) => {
    const output = renderToString(
      <Timeline width={columns} items={[{
        id: 'update',
        kind: 'update',
        current: '0.2.3',
        latest: '0.3.0',
        command: 'npm i -g @skein-code/cli',
        highlights: ['Guided first-run provider setup', 'Protocol-aware third-party relay routing'],
      }]} />,
      {columns},
    );
    expect(output).toContain('0.2.3');
    expect(output).toContain('Guided');
    for (const line of output.split('\n')) {
      expect(displayWidth(line), `${columns}-column update row overflowed: ${JSON.stringify(line)}`)
        .toBeLessThanOrEqual(columns);
    }
  });

  it.each([20, 24, 32, 40, 50])('progressively collapses every live row at %i columns', (columns) => {
    const suggestions = Array.from({length: 6}, (_, index) => ({
      value: `/command-${index}`,
      label: `/command-${index}`,
      description: `Description for command ${index}`,
    }));
    const output = renderToString(
      <>
        <Header config={{
          ...config,
          workspaceRoots: ['/a/very/long/project/path'],
          model: {provider: 'compatible', model: 'a-model-with-a-very-long-name'},
          context: {...config.context},
        }} askMode width={columns} />
        <Timeline width={columns} items={[
          {
            id: 'context', kind: 'context', engine: 'local', hits: 12, tokens: 8400,
            budgetTier: 'broad', truncated: true,
          },
          {
            id: 'prompt', kind: 'prompt', intent: 'debug', sections: ['working-memory', 'code:local'], tokens: 9300,
            breakdown: {
              stableTokens: 1_500, dynamicTokens: 400, conversationTokens: 2_000,
              toolResultTokens: 1_000, retrievedTokens: 2_500, toolSchemaTokens: 1_900,
              estimatedInputTokens: 9_300, outputAllowanceTokens: 2_048,
            },
          },
          {id: 'tool', kind: 'tool', name: 'apply_patch', detail: 'src/a/very/long/path/worker.ts', state: 'ok', durationMs: 123},
          {id: 'agent', kind: 'agent', profile: 'security-reviewer', task: 'Inspect all trust boundaries', state: 'ok', durationMs: 55},
        ]} />
        <CommandPalette suggestions={suggestions} selected={5} width={columns} />
        <Footer
          busy
          tokens={14_200}
          maxTokens={250_000}
          changedFiles={2}
          width={columns}
          contextPressure={0.82}
          queueCount={2}
          frame="◎"
        />
      </>,
      {columns},
    );

    for (const line of output.split('\n')) {
      expect(displayWidth(line), `${columns}-column row overflowed: ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns);
    }
    expect(output).toContain('ASK');
    expect(output).toContain('apply_patch');
    expect(output).toContain('/command-5');
    expect(output).not.toContain('contexcontext');
    expect(output).not.toMatch(/workin\n|change\n|apply_\npatch/);
  });

  it.each([20, 40, 80])('keeps stop controls and queued work visible while busy at %i columns', (columns) => {
    const output = renderToString(
      <PromptBar
        busy
        value=""
        placeholder=""
        width={columns}
        queueCount={2}
        queuePreview="verify the long-running migration and summarize risks"
      >
        <></>
      </PromptBar>,
      {columns},
    );

    expect(output).toContain('esc stop');
    expect(output).toContain('2 queued');
    if (columns >= 80) expect(output).toContain('/queue manage');
    for (const line of output.split('\n')) {
      expect(displayWidth(line), `${columns}-column busy composer overflowed: ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns);
    }
  });

  it.each([20, 40, 80])('shows a stable disabled composer while the external editor owns input at %i columns', (columns) => {
    const output = renderToString(
      <PromptBar busy={false} disabled focused={false} value="draft" placeholder="" width={columns}>
        <Text>draft</Text>
      </PromptBar>,
      {columns},
    );
    // The composer states its mode once, in the hint row. A labelled rule said
    // the same thing again in the loudest position in the frame.
    expect(output).toContain('input paused');
    if (columns >= 40) expect(output).toContain('external editor active');
    expect(output).not.toContain('Editor');
    for (const line of output.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(columns);
  });

  it('renders an actionable permission state with semantic controls', () => {
    const call: ToolCall = {
      id: 'call-1',
      name: 'shell',
      arguments: {command: 'npm test'},
    };
    const output = renderToString(<PermissionCard call={call} category="shell" reason="Shell tools require approval by policy." />);
    expect(output).toContain('Permission required');
    expect(output).toContain('npm test');
    expect(output).toContain('reason Shell tools require approval by policy.');
    expect(output).toContain('risk a local process may read or change workspace state');
    expect(output).toContain('y');
    expect(output).toContain('n');
    expect(output).not.toMatch(/[┌┐└┘╭╮╰╯│]/u);
  });

  it('distinguishes live-human approval and removes the session-grant affordance', () => {
    const output = renderToString(<PermissionCard
      call={{id: 'publish', name: 'shell', arguments: {command: 'npm publish --access public'}}}
      category="network"
      humanOnly
      reason="High-risk action requires a live human approval."
      width={80}
    />, {columns: 80});
    expect(output).toContain('Live human approval required');
    expect(output).toContain('[y]');
    expect(output).toContain('[n]');
    expect(output).not.toContain('[a]');
    expect(output).not.toContain('session');
  });

  it('renders direct Git arguments as a readable permission command', () => {
    const call: ToolCall = {
      id: 'call-git',
      name: 'git',
      arguments: {args: ['diff', '--']},
    };
    const output = renderToString(<PermissionCard call={call} category="git" />);
    expect(output).toContain('command git diff --');
    expect(output).not.toContain('{"args"');
  });

  it('redacts credentials embedded in readable permission commands', () => {
    const output = renderToString(<>
      <PermissionCard
        call={{id: 'git-secret', name: 'git', arguments: {args: ['fetch', 'https://user:password@example.com/repo.git']}}}
        category="network"
      />
      <PermissionCard
        call={{id: 'shell-secret', name: 'shell', arguments: {command: 'deploy --token super-secret-token'}}}
        category="shell"
      />
    </>);
    expect(output).toContain('https://[redacted]@example.com/repo.git');
    expect(output).toContain('--token [redacted]');
    expect(output).not.toContain('user:password');
    expect(output).not.toContain('super-secret-token');
  });

  it('surfaces approval and active experts in the stable footer', () => {
    const output = renderToString(
      <Footer busy approval tokens={1_200} maxTokens={10_000} changedFiles={1} activeAgents={2} width={80} />,
    );
    expect(output).toContain('approval required');
    expect(output).toContain('@2');
  });

  it('keeps routine telemetry hidden but surfaces context pressure when it becomes actionable', () => {
    const routine = renderToString(<Footer busy={false} tokens={12_000} maxTokens={100_000} changedFiles={0} contextPressure={0.42} width={80} />);
    const pressured = renderToString(<Footer busy={false} tokens={82_000} maxTokens={100_000} changedFiles={0} contextPressure={0.82} width={80} />);
    expect(routine).not.toContain('ctx ');
    expect(routine).not.toContain('tokens');
    expect(pressured).toContain('context 82%');
  });

  it('can suppress the decorative composer rule for linear screen-reader output', () => {
    const output = renderToString(<PromptBar busy={false} value="" placeholder="Type a request" width={40} showRule={false}><></></PromptBar>);
    expect(output).toContain('Type a request');
    expect(output).not.toMatch(/[-─]{10}/u);
  });

  it('compresses active agents into a two-line summary instead of a permanent cockpit', () => {
    const output = renderToString(<TeamSummary width={64} items={[
      {id: 'worker', kind: 'agent', profile: 'architect', provider: 'anthropic', model: 'claude', phase: 'work', task: 'Map boundaries', state: 'ok'},
      {id: 'message', kind: 'agent-message', from: 'architect', to: 'reviewer', text: 'Boundary report ready.'},
      {id: 'reviewer', kind: 'agent', profile: 'reviewer', provider: 'openai', model: 'gpt', phase: 'review', task: 'Review evidence', state: 'running'},
    ]} />, {columns: 64});
    expect(output).toContain('1 agent');
    expect(output).toContain('1 running');
    expect(output).toContain('1 review');
    expect(output).toContain('reviewer');
    expect(output).not.toContain('TEAM COCKPIT');
    expect(output).not.toContain('openai/gpt');
    expect(output).not.toContain('architect→reviewer');
    expect(output.trimEnd().split('\n')).toHaveLength(2);
  });

  it('shows only actionable queued or running agents in the compact team summary', () => {
    const output = renderToString(<TeamSummary width={64} items={[
      {id: 'queued', kind: 'agent', profile: 'analyst', task: 'Await a scheduler slot', state: 'queued'},
      {id: 'cancelled', kind: 'agent', profile: 'reviewer', phase: 'review', task: 'Review evidence', state: 'cancelled', cancelReason: 'Cleared from queue after an agent timeout: worker exceeded budget'},
    ]} />, {columns: 64});
    expect(output).toContain('1 agent');
    expect(output).toContain('1 queued');
    expect(output).toContain('analyst');
    expect(output).not.toContain('reviewer');
    expect(output).not.toContain('Cleared from queue');
  });

  it('surfaces queued and cancelled agents in the workbench without overflow', () => {
    const items = [
      {id: 'queued', kind: 'agent' as const, profile: 'analyst', task: 'Await a scheduler slot', state: 'queued' as const},
      {id: 'cancelled', kind: 'agent' as const, profile: 'reviewer', phase: 'review' as const, task: 'Review evidence', state: 'cancelled' as const, cancelReason: 'Cleared from queue after parent cancellation: operator stopped the run'},
    ];
    const output = renderToString(<TeamWorkbench items={items} tasks={[]} width={60} selectedIndex={1} expanded view="agents" />, {columns: 60});
    expect(output).toContain('analyst');
    expect(output).toContain('Cleared from queue');
    for (const line of output.split('\n')) {
      expect(displayWidth(line), `workbench row overflowed: ${JSON.stringify(line)}`).toBeLessThanOrEqual(60);
    }
  });

  it('renders team needs_review as a warning state instead of a rejection', () => {
    const output = renderToString(<TeamWorkbench
      items={[]}
      tasks={[]}
      width={80}
      run={{
        id: 'run', objective: 'Review a bound patch', accepted: false, needsReview: true,
        unresolvedCriteria: ['writer-safety', 'writer-verification'], reviewRounds: 0,
      }}
    />, {columns: 80});
    expect(output).toContain('needs review');
    expect(output).toContain('2 unresolved');
    expect(output).not.toContain('rejected');
  });

  it.each([20, 40, 80, 120])('renders a bounded interactive team workbench at %i columns', (columns) => {
    const items = [
      {id: 'worker', kind: 'agent' as const, profile: 'architect', provider: 'anthropic', model: 'claude', phase: 'work' as const, task: 'Map 跨模块 boundaries and verify ownership', state: 'ok' as const, durationMs: 42_000, inputTokens: 12_000, outputTokens: 2_000, toolCalls: 7, cost: routeCostReceipt({inputTokens: 12_000, outputTokens: 2_000, source: 'actual'}, {protocol: 'anthropic-messages', pricingSource: 'route', pricing: {inputPerMillionUsd: 3, outputPerMillionUsd: 15}}), hostedToolCalls: 1, sourceCount: 3, summary: 'Architecture report ready.', alerts: ['soft token threshold exceeded (10000); continuing']},
      {id: 'reviewer', kind: 'agent' as const, profile: 'reviewer', provider: 'openai', model: 'gpt', phase: 'review' as const, task: 'Review evidence', state: 'running' as const, startedAt: Date.now() - 2_000, cost: routeCostReceipt({inputTokens: 0, outputTokens: 0, source: 'unknown'}), hostedToolCalls: 0, sourceCount: 0},
      {id: 'message', kind: 'agent-message' as const, from: 'architect', to: 'reviewer', text: 'Boundary report ready.'},
    ];
    const output = renderToString(<TeamWorkbench
      items={items}
      tasks={[{id: 'task', title: 'Verify delivery', status: 'in_progress'}]}
      width={columns}
      selectedIndex={0}
      expanded
      run={{
        id: 'run', objective: 'Deliver the multi-agent workbench', startedAt: Date.now() - 10_000,
        accepted: false, reviewRounds: 1,
        review: {decision: 'escalate', pass: 2, fail: 1, unknown: 3},
      }}
    />, {columns});

    expect(output).toContain('TEAM WORKBENCH');
    expect(output).toContain('[agents]');
    expect(output).toContain('architect');
    expect(output).toContain('soft token');
    if (columns >= 80) {
      expect(output).toContain('judge escalate 2/1/3');
      expect(output).toContain('$0.066000');
      expect(output).toContain('unpriced');
      expect(output).toContain('3 sources');
    }
    for (const line of output.split('\n')) {
      expect(displayWidth(line), `${columns}-column workbench row overflowed: ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns);
    }
  });

  it('switches the workbench presentation between tasks and peer messages', () => {
    const items = [
      {id: 'agent', kind: 'agent' as const, profile: 'backend', task: 'Inspect API', state: 'ok' as const},
      {id: 'message', kind: 'agent-message' as const, from: 'backend', to: 'reviewer', text: 'API evidence ready.'},
    ];
    const tasks = [{id: 'task', title: 'Run acceptance checks', status: 'in_progress' as const}];
    const taskOutput = renderToString(<TeamWorkbench items={items} tasks={tasks} width={60} view="tasks" />);
    const messageOutput = renderToString(<TeamWorkbench items={items} tasks={tasks} width={60} view="messages" />);

    expect(taskOutput).toContain('[tasks]');
    expect(taskOutput).toContain('Run acceptance checks');
    expect(messageOutput).toContain('[messages]');
    expect(messageOutput).toContain('backend→reviewer');
  });

  it('keeps cost and source telemetry readable in the ASCII accessibility mode', () => {
    const output = renderToString(<TeamWorkbench
      glyphMode="ascii"
      width={72}
      items={[{
        id: 'researcher', kind: 'agent', profile: 'researcher', task: 'Research APIs', state: 'ok',
        inputTokens: 100, outputTokens: 20, toolCalls: 0,
        cost: routeCostReceipt({inputTokens: 100, outputTokens: 20, source: 'actual'}),
        hostedToolCalls: 1, sourceCount: 2,
      }]}
      tasks={[]}
    />, {columns: 72});
    expect(output).toContain('unpriced');
    expect(output).toContain('1 hosted');
    expect(output).toContain('2 sources');
    expect(output).not.toMatch(/[✓◌·→]/u);
    for (const line of output.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(72);
  });

  it.each([20, 50, 72])('renders each permission shortcut once at %i columns', (columns) => {
    const call: ToolCall = {id: 'call-responsive', name: 'shell', arguments: {command: 'npm test'}};
    const output = renderToString(<PermissionCard call={call} category="shell" width={columns} />, {columns});

    for (const shortcut of ['[y]', '[a]', '[n]', '[Esc]']) {
      expect(output.split(shortcut)).toHaveLength(2);
    }
    for (const line of output.split('\n')) {
      expect(displayWidth(line), `${columns}-column permission row overflowed: ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns);
    }
  });

  it('compresses narrow permission shortcuts to two rows when height is constrained', () => {
    const call: ToolCall = {id: 'call-compact', name: 'shell', arguments: {command: 'npm test'}};
    const output = renderToString(
      <PermissionCard call={call} category="shell" width={20} compact />,
      {columns: 20},
    );
    const shortcutRows = output.split('\n').filter((line) => line.includes('['));

    expect(shortcutRows).toHaveLength(2);
    expect(shortcutRows[0]).toContain('[y] once');
    expect(shortcutRows[0]).toContain('[a] sess');
    expect(shortcutRows[1]).toContain('[n] no');
    expect(shortcutRows[1]).toContain('[Esc] stop');
    for (const line of output.split('\n')) {
      expect(displayWidth(line), `20-column compact permission row overflowed: ${JSON.stringify(line)}`).toBeLessThanOrEqual(20);
    }
  });

  it('renders the minimal context inspector as exactly two bounded rows', () => {
    const output = renderToString(
      <ContextInspector
        status={{
          pressure: 0.42,
          promptTokens: 210_000,
          promptSource: 'actual',
          contextWindowTokens: 500_000,
          messageCount: 8,
          activeTokens: 3200,
          summaryTokens: 900,
          toolTokens: 700,
          compactedMessages: 4,
        }}
        working={{
          goal: 'Ship the terminal client',
          focus: 'Keep the composer\nvisible\u0007',
          constraints: [],
          decisions: [],
          openQuestions: [],
          relevantFiles: [],
          lastUpdatedAt: new Date().toISOString(),
        }}
        summary="Older work was compacted"
        memory="12 active"
        connections="18 tools"
        width={40}
        minimal
      />,
      {columns: 40},
    );
    const rows = output.split('\n');

    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('window 42%');
    expect(rows[1]).toContain('working Keep the composer visible');
    expect(output).not.toContain('long-term');
    expect(output).not.toContain('connections');
    for (const line of rows) {
      expect(displayWidth(line), `40-column minimal context row overflowed: ${JSON.stringify(line)}`).toBeLessThanOrEqual(40);
    }
  });

  it('shows a facts-only handoff when compaction succeeds without a narrative', () => {
    const output = renderToString(
      <ContextInspector
        status={{
          pressure: 0.3, promptTokens: 150_000, promptSource: 'estimated', contextWindowTokens: 500_000,
          messageCount: 6, activeTokens: 1200,
          summaryTokens: 420, toolTokens: 100, compactedMessages: 8,
        }}
        working={undefined}
        width={40}
      />,
      {columns: 40},
    );

    expect(output).toContain('facts');
    expect(output).not.toContain('not created');
    for (const line of output.split('\n')) {
      expect(displayWidth(line), `40-column facts-only context row overflowed: ${JSON.stringify(line)}`)
        .toBeLessThanOrEqual(40);
    }
  });

  it('shows epoch and lifetime usage as separate context facts', () => {
    const output = renderToString(<ContextInspector
      status={{
        pressure: 0.4, promptTokens: 200_000, promptSource: 'actual', contextWindowTokens: 500_000,
        messageCount: 4, activeTokens: 900, summaryTokens: 200,
        toolTokens: 100, compactedMessages: 2, epochIndex: 3, epochCount: 3,
        epochTokens: 125_000, epochBudget: 250_000,
        lifetimeTokens: 410_000, lifetimeBudget: 1_000_000,
      }}
      working={undefined}
      width={80}
    />, {columns: 80});

    expect(output).toContain('epoch');
    expect(output).toContain('#3 125k/250k');
    expect(output).toContain('lifetime 410k/1.0m');
  });

  it.each([20, 40, 80])('renders a clarification with bounded keyboard-answerable options at %i columns', (columns) => {
    const output = renderToString(<Timeline width={columns} items={[{
      id: 'clarification',
      kind: 'clarification',
      pending: {
        id: '00000000-0000-4000-8000-000000000030',
        runId: '00000000-0000-4000-8000-000000000031',
        createdAt: '2026-07-25T00:00:00.000Z',
        originalRequest: 'Change the UI.',
        question: 'Modal or inline?',
        options: [
          {id: 'modal', label: 'Modal', impact: 'Use a blocking dialog.', recommended: true},
          {id: 'inline', label: 'Inline', impact: 'Keep editing in context.', recommended: false},
        ],
        reason: 'explicit_user_choice_missing',
      },
    }]} />, {columns});

    expect(output).toContain('Modal or inline?');
    expect(output).toContain('1. Modal');
    expect(output).toContain('2. Inline');
    const linearized = output.replace(/\s+/gu, ' ');
    expect(linearized).toContain('blocking dialog');
    expect(linearized).toContain('editing in context');
    for (const line of output.split('\n')) {
      expect(displayWidth(line), `${columns}-column clarification overflowed: ${JSON.stringify(line)}`)
        .toBeLessThanOrEqual(columns);
    }
  });

  it('keeps an empty transcript linear instead of drawing a large viewport card', () => {
    const output = renderToString(<Timeline items={[]} />);
    expect(output).toContain('No messages yet.');
    expect(output.trimEnd().split('\n')).toHaveLength(1);
    expect(output).not.toMatch(/[┌┐└┘╭╮╰╯│]/u);
  });

  it.each([20, 40])('keeps the fresh-session summary compact at %i columns', (columns) => {
    const output = renderToString(<Timeline width={columns} items={[{
      id: 'banner',
      kind: 'banner',
      engine: 'local',
      status: 'ready',
      version: '0.3.5',
    }]} />, {columns});

    expect(output).toContain(columns < 30 ? 'ready' : 'local context');
    expect(output).toContain('v0.3.5');
    expect(output.trimEnd().split('\n')).toHaveLength(columns < 30 ? 1 : 3);
    expect(output).not.toContain('S K E I N');
    expect(output).not.toContain('cwd ');
    expect(output).not.toMatch(/[┌┐└┘╭╮╰╯│█]/u);
    for (const line of output.split('\n')) {
      expect(displayWidth(line), `${columns}-column session summary overflowed: ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns);
    }
  });

  it('opens wide fresh sessions on the block wordmark without boxed chrome', () => {
    const output = renderToString(<Timeline width={80} items={[{
      id: 'banner',
      kind: 'banner',
      engine: 'local',
      status: 'ready',
      version: '0.3.5',
    }]} />, {columns: 80});

    expect(output).toContain('███');
    expect(output).toContain('context-first coding agent · v0.3.5');
    expect(output).toContain('local context');
    expect(output).not.toContain('cwd ');
    expect(output).not.toMatch(/[┌┐└┘╭╮╰╯]/u);
    for (const line of output.split('\n')) {
      expect(displayWidth(line), `80-column banner overflowed: ${JSON.stringify(line)}`).toBeLessThanOrEqual(80);
    }
  });

  it.each([
    ['empty', 'empty workspace'],
    ['blocked', 'setup required'],
  ] as const)('keeps the %s entry state explicit without restoring dashboard chrome', (status, expected) => {
    const output = renderToString(<Timeline width={80} glyphMode="ascii" items={[{
      id: `banner-${status}`,
      kind: 'banner',
      engine: 'local',
      status,
      version: '0.3.40',
    }]} />, {columns: 80});

    expect(output).toContain(expected);
    expect(output).toContain('v0.3.40');
    // ASCII terminals keep the text wordmark: no block art, no boxes.
    expect(output).not.toContain('█');
    expect(output).toContain('SKEIN');
    expect(output.trimEnd().split('\n')).toHaveLength(3);
    expect(output).not.toContain('WORKSPACE');
    expect(output).not.toContain('S K E I N');
  });

  it('offers a deterministic ASCII fallback for terminals with unsafe glyph widths', () => {
    const output = renderToString(
      <>
        <Header config={config} askMode glyphMode="ascii" />
        <Timeline glyphMode="ascii" items={[
          {id: 'tool', kind: 'tool', name: 'read_file', detail: 'src/queue.ts', state: 'ok'},
          {id: 'failed', kind: 'tool', name: 'shell', detail: 'npm test', state: 'error', errorDetail: 'exit 1'},
        ]} />
        <Footer busy tokens={800} maxTokens={10_000} changedFiles={0} glyphMode="ascii" />
      </>,
    );
    expect(output).toContain('SKEIN');
    expect(output).toContain('ASK');
    // A tool that worked claims no glyph in either glyph set; a failure does.
    expect(output).toContain('  read_file');
    expect(output).toContain('x shell');
    expect(output).toContain('~ working');
    expect(output).not.toMatch(/[⌁●✓◌]/u);
  });

  it('redacts sensitive permission arguments before rendering them', () => {
    const call: ToolCall = {
      id: 'call-secret',
      name: 'http_request',
      arguments: {headers: {authorization: 'Bearer do-not-render'}},
    };
    const output = renderToString(<PermissionCard call={call} category="network" />);
    expect(output).toContain('[redacted]');
    expect(output).not.toContain('do-not-render');
  });

  it('maps role aliases back to the restrained semantic palette', () => {
    const theme = resolveTheme('graphite');
    expect(theme.tool).toBe(theme.text);
    expect(theme.memory).toBe(theme.muted);
    expect(theme.skill).toBe(theme.muted);
    expect(theme.agent).toBe(theme.muted);
    expect(theme.selectedBackground).toBe(theme.selection);
    expect(resolveTheme('cinder').name).toBe('cinder');
    expect(resolveTheme('mono').name).toBe('mono');
  });

  it('keeps light palettes opt-in through auto detection and supports true monochrome output', () => {
    expect(detectTerminalAppearance({SKEIN_APPEARANCE: 'light'})).toBe('light');
    expect(resolveTheme('auto', {SKEIN_APPEARANCE: 'dark'})).toBe(resolveTheme('graphite'));
    expect(resolveTheme('auto', {COLORFGBG: '15;15'} as NodeJS.ProcessEnv).name).toBe('paper');
    expect(resolveTheme('auto', {COLORFGBG: '7;8'} as NodeJS.ProcessEnv).name).toBe('graphite');
    expect(resolveTheme('auto', {COLORFGBG: '7;9'} as NodeJS.ProcessEnv).name).toBe('graphite');
    const monochrome = resolveThemeWithColor('graphite', false);
    expect(monochrome.accent).toBe('');
    expect(monochrome.warning).toBe('');
    expect(monochrome.border).toBe('');
    expect(monochrome.codeLiteral).toBe('');
  });

  it('keeps syntax highlighting out of the status colours', () => {
    // Strings used to render in `success` and numbers in `warning`, so every
    // code block competed with real status rows for the same two colours.
    const theme = resolveTheme('graphite');
    for (const name of ['code', 'codeLiteral'] as const) {
      for (const status of ['success', 'warning', 'error'] as const) {
        expect(theme[name], `${name} must not reuse ${status}`).not.toBe(theme[status]);
      }
    }
    const output = withTrueColor(() => renderToString(
      <Timeline width={80} items={[{
        id: 'reply',
        kind: 'assistant',
        text: '```ts\nconst total = 42; // sum\n```',
      }]} />,
      {columns: 80},
    ));
    const colorOf = (needle: string) => output.match(
      new RegExp(`\\u001B\\[38;2;(\\d+;\\d+;\\d+)m${needle}`, 'u'))?.[1];
    expect(colorOf('42')).toBe(trueColorParameters(theme.codeLiteral));
    expect(colorOf('42')).not.toBe(trueColorParameters(theme.warning));
  });

  it('reserves each semantic colour for one meaning across a mixed frame', () => {
    // A frame where three tools succeed and one fails must not paint three
    // green ticks: only the failure earns a status colour, so the eye lands on
    // the one row that needs attention.
    const theme = resolveTheme('graphite');
    const output = withTrueColor(() => renderToString(
      <Timeline width={80} items={[
        {id: 'ok1', kind: 'tool', name: 'read_file', detail: 'a.ts', state: 'ok'},
        {id: 'ok2', kind: 'tool', name: 'grep', detail: 'pattern', state: 'ok'},
        {id: 'ok3', kind: 'tool', name: 'apply_patch', detail: 'b.ts', state: 'ok'},
        {id: 'bad', kind: 'tool', name: 'shell', detail: 'npm test', state: 'error', errorDetail: 'exit 1'},
      ]} />,
      {columns: 80},
    ));
    expect(output).not.toContain(`38;2;${trueColorParameters(theme.success)}`);
    expect(output).toContain(`38;2;${trueColorParameters(theme.error)}`);
  });
});

/**
 * Render with 24-bit colour regardless of whether the test runner has a TTY, so
 * a colour assertion cannot silently pass by finding no colour at all. Ink and
 * these tests share the one chalk instance, so setting its level is enough.
 */
function withTrueColor<T>(render: () => T): T {
  const previous = chalk.level;
  chalk.level = 3;
  try {
    return render();
  } finally {
    chalk.level = previous;
  }
}

function trueColorParameters(hex: string): string {
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)).join(';');
}
