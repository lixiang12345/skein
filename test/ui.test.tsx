import React from 'react';
import {renderToString} from 'ink';
import {describe, expect, it} from 'vitest';
import {CommandPalette, ContextInspector, Footer, Header, PermissionCard, PromptBar, TaskRail, TeamCockpit, TeamWorkbench, Timeline} from '../src/ui/components.js';
import {displayWidth, sanitizeTerminalText} from '../src/ui/text.js';
import {detectTerminalAppearance, resolveTheme, resolveThemeWithColor} from '../src/ui/theme.js';
import {resolveKittyKeyboardConfig} from '../src/ui/terminal-capabilities.js';
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
    expect(output).toContain('◇ context');
    expect(output).toContain('Local retrieval unavailable');
    expect(output).toContain('✓ read_file');
    expect(output).toContain('Fix the queue');
    expect(output).toContain('Run tests');
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
    expect(output).toContain('◆ SKEIN');
    expect(output).toContain('● ASK');
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
          {id: 'context', kind: 'context', engine: 'local', hits: 12, tokens: 8400},
          {id: 'prompt', kind: 'prompt', intent: 'debug', sections: ['working-memory', 'code:local'], tokens: 9300},
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
    expect(output).toContain('● ASK');
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

  it('renders an actionable permission state with semantic controls', () => {
    const call: ToolCall = {
      id: 'call-1',
      name: 'shell',
      arguments: {command: 'npm test'},
    };
    const output = renderToString(<PermissionCard call={call} category="shell" />);
    expect(output).toContain('Permission required');
    expect(output).toContain('npm test');
    expect(output).toContain('y');
    expect(output).toContain('n');
    expect(output).not.toMatch(/[┌┐└┘╭╮╰╯│]/u);
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

  it('renders routed agents and peer handoffs in the team cockpit', () => {
    const output = renderToString(<TeamCockpit width={40} items={[
      {id: 'worker', kind: 'agent', profile: 'architect', provider: 'anthropic', model: 'claude', phase: 'work', task: 'Map boundaries', state: 'ok'},
      {id: 'message', kind: 'agent-message', from: 'architect', to: 'reviewer', text: 'Boundary report ready.'},
      {id: 'reviewer', kind: 'agent', profile: 'reviewer', provider: 'openai', model: 'gpt', phase: 'review', task: 'Review evidence', state: 'running'},
    ]} />, {columns: 40});
    expect(output).toContain('TEAM COCKPIT');
    expect(output).toContain('anthropic/claude');
    expect(output).toContain('openai/gpt');
    expect(output).toContain('architect→reviewer');
  });

  it('surfaces queued and cancelled agent states in the team cockpit', () => {
    const output = renderToString(<TeamCockpit width={48} items={[
      {id: 'queued', kind: 'agent', profile: 'analyst', task: 'Await a scheduler slot', state: 'queued'},
      {id: 'cancelled', kind: 'agent', profile: 'reviewer', phase: 'review', task: 'Review evidence', state: 'cancelled', cancelReason: 'Cleared from queue after an agent timeout: worker exceeded budget'},
    ]} />, {columns: 48});
    expect(output).toContain('analyst');
    expect(output).toContain('reviewer');
    expect(output).toContain('Cleared from queue');
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

  it.each([20, 40, 80])('renders a bounded interactive team workbench at %i columns', (columns) => {
    const items = [
      {id: 'worker', kind: 'agent' as const, profile: 'architect', provider: 'anthropic', model: 'claude', phase: 'work' as const, task: 'Map 跨模块 boundaries and verify ownership', state: 'ok' as const, durationMs: 42_000, inputTokens: 12_000, outputTokens: 2_000, toolCalls: 7, summary: 'Architecture report ready.', alerts: ['soft token threshold exceeded (10000); continuing']},
      {id: 'reviewer', kind: 'agent' as const, profile: 'reviewer', provider: 'openai', model: 'gpt', phase: 'review' as const, task: 'Review evidence', state: 'running' as const, startedAt: Date.now() - 2_000},
      {id: 'message', kind: 'agent-message' as const, from: 'architect', to: 'reviewer', text: 'Boundary report ready.'},
    ];
    const output = renderToString(<TeamWorkbench
      items={items}
      tasks={[{id: 'task', title: 'Verify delivery', status: 'in_progress'}]}
      width={columns}
      selectedIndex={0}
      expanded
      run={{id: 'run', objective: 'Deliver the multi-agent workbench', startedAt: Date.now() - 10_000, reviewRounds: 1}}
    />, {columns});

    expect(output).toContain('TEAM WORKBENCH');
    expect(output).toContain('[agents]');
    expect(output).toContain('architect');
    expect(output).toContain('soft token');
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
    expect(rows[0]).toContain('Context 42%');
    expect(rows[1]).toContain('working Keep the composer visible');
    expect(output).not.toContain('long-term');
    expect(output).not.toContain('connections');
    for (const line of rows) {
      expect(displayWidth(line), `40-column minimal context row overflowed: ${JSON.stringify(line)}`).toBeLessThanOrEqual(40);
    }
  });

  it('keeps an empty transcript linear instead of drawing a large viewport card', () => {
    const output = renderToString(<Timeline items={[]} />);
    expect(output).toContain('Start with a request, @file, or /help.');
    expect(output.trimEnd().split('\n')).toHaveLength(1);
    expect(output).not.toMatch(/[┌┐└┘╭╮╰╯│]/u);
  });

  it.each([20, 40, 80])('keeps the fresh-session summary compact at %i columns', (columns) => {
    const output = renderToString(<Timeline width={columns} items={[{
      id: 'banner',
      kind: 'banner',
      model: 'compatible/local-model',
      engine: 'local',
      workspace: '/workspace/with/a/long/project-name',
      version: '0.3.5',
    }]} />, {columns});

    expect(output).toContain(columns < 28 ? 'New ' : 'New session');
    expect(output).toContain('v0.3.5');
    expect(output).toContain('cwd ');
    expect(output.trimEnd().split('\n')).toHaveLength(2);
    expect(output).not.toMatch(/[┌┐└┘╭╮╰╯│█]/u);
    for (const line of output.split('\n')) {
      expect(displayWidth(line), `${columns}-column session summary overflowed: ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns);
    }
  });

  it('offers a deterministic ASCII fallback for terminals with unsafe glyph widths', () => {
    const output = renderToString(
      <>
        <Header config={config} askMode glyphMode="ascii" />
        <Timeline glyphMode="ascii" items={[
          {id: 'tool', kind: 'tool', name: 'read_file', detail: 'src/queue.ts', state: 'ok'},
        ]} />
        <Footer busy tokens={800} maxTokens={10_000} changedFiles={0} glyphMode="ascii" />
      </>,
    );
    expect(output).toContain('* SKEIN');
    expect(output).toContain('o ASK');
    expect(output).toContain('+ read_file');
    expect(output).toContain('~ working');
    expect(output).not.toMatch(/[◆●✓◌]/u);
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
  });
});
