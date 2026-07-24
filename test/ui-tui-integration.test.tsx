import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import React from 'react';
import {render, type Instance} from 'ink';
import stripAnsi from 'strip-ansi';
import {describe, expect, it, vi} from 'vitest';
import type {AgentRunner} from '../src/agent/index.js';
import {defaultConfig} from '../src/config.js';
import type {ExtensionRuntime} from '../src/runtime/index.js';
import {createSession} from '../src/session/index.js';
import {SkeinApp} from '../src/ui/tui.js';
import type {AgentEvent, ChatMessage, ContextHit, Session} from '../src/types.js';

describe('SkeinApp completion flows', () => {
  it('keeps a fresh-session composer next to an actionable local-context summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-fresh-session-ui-'));
    const session = testSession(root);
    const {runner} = mockRunner(root, session);
    const harness = await mountApp(runner, root);

    try {
      const frame = harness.lastFrame();
      const lines = frame.split('\n');
      const summaryRow = lines.findIndex((line) => line.includes('context runs automatically'));
      const composerRow = lines.findIndex((line) => line.includes('Type a request'));
      expect(summaryRow).toBeGreaterThanOrEqual(0);
      expect(composerRow).toBeGreaterThan(summaryRow);
      expect(composerRow - summaryRow).toBeLessThanOrEqual(4);
      expect(composerRow).toBeLessThan(10);
      expect(lines.length).toBeLessThan(16);
      expect(frame).toContain('@file pins');
      expect(frame).toContain('/help commands');
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });

  it('shows a branded factual workspace rail on wide fresh sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-workspace-panel-ui-'));
    const session = testSession(root);
    const {runner} = mockRunner(root, session, [], {toolCount: 9});
    const readiness = {
      engine: 'local' as const,
      rebuilt: true,
      validated: true as const,
      files: 28,
      chunks: 71,
      reused: 8,
      durationMs: 42,
      generation: 'test-generation',
      path: join(root, '.skein', 'index.json'),
      preparedAt: new Date().toISOString(),
    };
    const harness = await mountApp(runner, root, undefined, readiness);

    try {
      const frame = harness.lastFrame();
      expect(frame).toContain('SKEIN');
      expect(frame).toContain('WORKSPACE');
      expect(frame).toContain('context ready');
      expect(frame).toContain('28 files');
      expect(frame).toContain('71 chunks');
      expect(frame).toContain('9 tools');
      expect(frame).toContain('guarded');
      expect(frame).toContain('Type a request');
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });

  it('switches between Ask and Build mode without restarting the TUI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-mode-ui-'));
    const session = testSession(root);
    const {runner, run} = mockRunner(root, session);
    const harness = await mountApp(runner, root);

    try {
      harness.stdin.write('/mode ask\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Ask mode enabled.'));
      harness.stdin.write('inspect the workspace\r');
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(run.mock.calls[0]?.[0]).toBe('inspect the workspace');
      expect(run.mock.calls[0]?.[1]).toMatchObject({askMode: true});

      await settleRender(harness.instance);
      harness.stdin.write('/mode build\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Build mode enabled.'));
      harness.stdin.write('update the workspace\r');
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      expect(run.mock.calls[1]?.[0]).toBe('update the workspace');
      expect(run.mock.calls[1]?.[1]).toMatchObject({askMode: false});
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });

  it('offers an explicit read-only Plan mode before Build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-plan-ui-'));
    const session = testSession(root);
    const {runner, run} = mockRunner(root, session);
    const harness = await mountApp(runner, root);

    try {
      harness.stdin.write('/mode plan\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Plan mode enabled.'));
      harness.stdin.write('design the migration\r');
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(run.mock.calls[0]?.[1]).toMatchObject({askMode: true});
      expect(run.mock.calls[0]?.[1]?.turnInstructions).toContain('Plan mode is active');
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });

  it('filters and cycles resumed prompt history with Ctrl+R before submitting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-history-ui-'));
    const session = testSession(root);
    session.messages.push(
      userMessage('history-1', 'deploy release'),
      userMessage('history-2', 'inspect tests'),
      userMessage('history-3', 'deploy docs'),
    );
    const {runner, run} = mockRunner(root, session);
    const harness = await mountApp(runner, root);

    try {
      harness.stdin.write('deploy');
      await settleRender(harness.instance);
      // Exercise the real batched-input case: repeated Ctrl+R can arrive before
      // React commits the first history-search state update.
      harness.stdin.write('\u0012');
      await settle();
      harness.stdin.write('\u0012');
      await settleRender(harness.instance);
      // Repeating Ctrl+R moves from the newest match to the older match.
      await vi.waitFor(() => expect(harness.output()).toContain('History search: deploy'));
      harness.stdin.write('\t');
      await settleRender(harness.instance);
      harness.stdin.write('\r');

      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(run.mock.calls[0]?.[0]).toBe('deploy release');
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });

  it('completes an active @file token from the workspace and submits the attachment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-mention-ui-'));
    const sourcePath = join(root, 'src', 'agent.ts');
    await mkdir(join(root, 'src'), {recursive: true});
    await writeFile(sourcePath, 'export const agent = true;\n');
    await writeFile(join(root, 'src', 'other.ts'), 'export const other = true;\n');

    const session = testSession(root);
    const hit: ContextHit = {
      path: sourcePath,
      startLine: 1,
      endLine: 1,
      content: 'export const agent = true;',
      score: 1,
      source: 'test',
    };
    const {runner, run, search} = mockRunner(root, session, [hit]);
    const harness = await mountApp(runner, root);

    try {
      harness.stdin.write('review @src/age');
      await vi.waitFor(() => expect(search).toHaveBeenCalledWith('src/age', 12), {timeout: 1_000});
      await vi.waitFor(() => expect(harness.output()).toContain('@src/agent.ts'), {timeout: 1_000});
      harness.stdin.write('\t');
      await settleRender(harness.instance);
      harness.stdin.write('\r');

      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(run.mock.calls[0]?.[0]).toBe('review @src/agent.ts');
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });

  it('keeps a file-completion draft intact when Escape dismisses the palette', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-escape-ui-'));
    await mkdir(join(root, 'src'), {recursive: true});
    await writeFile(join(root, 'src', 'agent.ts'), 'export const agent = true;\n');
    const session = testSession(root);
    const {runner, run} = mockRunner(root, session);
    const harness = await mountApp(runner, root);

    try {
      harness.stdin.write('review @src/age');
      await vi.waitFor(() => expect(harness.output()).toContain('@src/agent.ts'));
      harness.stdin.write('\u001B');
      await new Promise((resolve) => setTimeout(resolve, 100));
      await settleRender(harness.instance);
      harness.stdin.write('\r');

      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(run.mock.calls[0]?.[0]).toBe('review @src/age');
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });

  it('dismisses busy file completion before Escape interrupts the active run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-busy-escape-ui-'));
    await mkdir(join(root, 'src'), {recursive: true});
    await writeFile(join(root, 'src', 'agent.ts'), 'export const agent = true;\n');
    const session = testSession(root);
    let aborted = false;
    const {runner, run} = mockRunner(root, session, [], {
      run: async (_input, options) => new Promise<Session>((_resolve, reject) => {
        const stop = () => {
          aborted = true;
          reject(options?.signal?.reason ?? new Error('aborted'));
        };
        if (options?.signal?.aborted) stop();
        else options?.signal?.addEventListener('abort', stop, {once: true});
      }),
    });
    const harness = await mountApp(runner, root);

    try {
      harness.stdin.write('start a long task\r');
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      harness.stdin.write('review @src/age');
      await vi.waitFor(() => expect(harness.output()).toContain('@src/agent.ts'));

      harness.stdin.write('\u001B');
      await new Promise((resolve) => setTimeout(resolve, 100));
      await settleRender(harness.instance);
      expect(aborted).toBe(false);
      expect(harness.output()).not.toContain('Interrupt requested.');

      harness.stdin.write('\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Queued follow-up 1.'));
      harness.stdin.write('\u001B');
      await vi.waitFor(() => expect(aborted).toBe(true));
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });

  it('keeps a multiline mention cursor stable while palette arrows select a file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-arrow-ui-'));
    await mkdir(join(root, 'src'), {recursive: true});
    await writeFile(join(root, 'src', 'agent.ts'), 'export const agent = true;\n');
    await writeFile(join(root, 'src', 'other.ts'), 'export const other = true;\n');
    const session = testSession(root);
    const {runner, run} = mockRunner(root, session);
    const harness = await mountApp(runner, root);

    try {
      harness.stdin.write('first line\u000areview @src/age');
      await vi.waitFor(() => expect(harness.output()).toContain('@src/agent.ts'));
      harness.stdin.write('\u001B[A');
      await settleRender(harness.instance);
      harness.stdin.write('\t');
      await settleRender(harness.instance);
      harness.stdin.write('\r');

      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(run.mock.calls[0]?.[0]).toBe('first line\nreview @src/agent.ts');
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });

  it('defers compaction until an active agent turn has settled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-queue-ui-'));
    const session = testSession(root);
    let finishTurn: ((value: Session) => void) | undefined;
    const {runner, run, compactContext} = mockRunner(root, session, [], {
      run: async () => new Promise<Session>((resolve) => { finishTurn = resolve; }),
      compactContext: async () => ({omittedMessages: 2, summaryTokens: 120}),
    });
    const harness = await mountApp(runner, root);

    try {
      harness.stdin.write('start a long task\r');
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      harness.stdin.write('/compact\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Queued command 1.'));
      expect(compactContext).not.toHaveBeenCalled();

      finishTurn?.(session);
      await vi.waitFor(() => expect(compactContext).toHaveBeenCalledTimes(1));
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });

  it('lists, removes, and discards queued follow-ups during a long run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-follow-up-queue-ui-'));
    const session = testSession(root);
    const {runner, run} = mockRunner(root, session, [], {
      run: async (_input, options) => new Promise<Session>((_resolve, reject) => {
        const stop = () => reject(options?.signal?.reason ?? new Error('aborted'));
        if (options?.signal?.aborted) stop();
        else options?.signal?.addEventListener('abort', stop, {once: true});
      }),
    });
    const harness = await mountApp(runner, root);

    try {
      harness.stdin.write('start a long task\r');
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

      harness.stdin.write('verify tests\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Queued follow-up 1.'));
      harness.stdin.write('summarize risks\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Queued follow-up 2.'));
      expect(harness.output()).toContain('2 queued');

      harness.stdin.write('/queue\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Queued follow-ups'));
      expect(harness.output()).toContain('verify tests');
      expect(harness.output()).toContain('summarize risks');

      harness.stdin.write('/queue drop 1\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Removed queued follow-up 1: verify tests'));
      harness.stdin.write('\u001B');
      await vi.waitFor(() => expect(harness.output()).toContain('Interrupt requested; 1 queued follow-up will be discarded.'));
      await vi.waitFor(() => expect(harness.output()).toContain('Discarded 1 queued follow-up.'));
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });

  it('refreshes the visible short-term memory as a context event streams', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-context-ui-'));
    const session = testSession(root);
    const {runner, run} = mockRunner(root, session, [], {
      run: async (_input, options) => {
        session.workingMemory = {
          goal: 'Ship the terminal client',
          focus: 'Keep the composer visible',
          constraints: [],
          decisions: [],
          openQuestions: [],
          relevantFiles: [],
          lastUpdatedAt: new Date().toISOString(),
        };
        options?.onEvent?.({
          type: 'context',
          packed: {text: '', hits: [], estimatedTokens: 0, engine: 'local', truncated: false},
        });
        return session;
      },
    });
    const harness = await mountApp(runner, root);

    try {
      harness.stdin.write('/context\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Context'));
      harness.stdin.write('continue\r');

      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(harness.output()).toContain('Keep the composer visible'));
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });

  it('opens and navigates the Team Workbench from the live input stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-workbench-ui-'));
    const session = testSession(root);
    session.tasks = [{id: 'task-1', title: 'Verify delivery', status: 'in_progress'}];
    const {runner} = mockRunner(root, session, [], {
      run: async (_input, options) => {
        options?.onEvent?.({type: 'team_start', id: 'run-1', objective: 'Review the delivery'});
        options?.onEvent?.({type: 'agent_start', id: 'agent-1', profile: 'architect', provider: 'anthropic', model: 'claude', task: 'Inspect boundaries', phase: 'work'});
        options?.onEvent?.({type: 'agent_update', id: 'agent-1', profile: 'architect', stage: 'response', detail: 'final report ready', inputTokens: 120, outputTokens: 40});
        options?.onEvent?.({type: 'agent_done', id: 'agent-1', profile: 'architect', ok: true, summary: 'Boundary report ready.', provider: 'anthropic', model: 'claude', phase: 'work', durationMs: 12, usage: {inputTokens: 120, outputTokens: 40}, toolCalls: 2});
        options?.onEvent?.({type: 'team_done', id: 'run-1', accepted: true, reviewRounds: 1});
        return session;
      },
    });
    const harness = await mountApp(runner, root);

    try {
      harness.stdin.write('review the delivery\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Team run run-1 accepted'));
      harness.stdin.write('\u0014');
      await vi.waitFor(() => expect(harness.output()).toContain('TEAM WORKBENCH'));
      harness.stdin.write('\u001B[C');
      await vi.waitFor(() => expect(harness.output()).toContain('[tasks]'));
      harness.stdin.write('\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Verify delivery'));
      harness.stdin.write('\u001B');
      await settleRender(harness.instance);
      expect(harness.output()).toContain('Type a request');
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });

  it('routes Workbench retry controls to the active delegation manager', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-workbench-control-ui-'));
    const session = testSession(root);
    let finishTurn: ((value: Session) => void) | undefined;
    const {runner} = mockRunner(root, session, [], {
      run: async (_input, options) => {
        options?.onEvent?.({type: 'team_start', id: 'run-control', objective: 'Control the agent'});
        options?.onEvent?.({type: 'agent_start', id: 'agent-control', profile: 'backend', provider: 'openai', model: 'gpt', task: 'Inspect the API', phase: 'work'});
        return new Promise<Session>((resolve) => { finishTurn = resolve; });
      },
    });
    const retryAgent = vi.fn(() => true);
    const extensions = {
      listWorkflows: () => [],
      mcpStatus: () => [],
      memoryStats: () => undefined,
      retryAgent,
      cancelAgent: vi.fn(() => true),
    } as unknown as ExtensionRuntime;
    const harness = await mountApp(runner, root, extensions);

    try {
      harness.stdin.write('inspect the API\r');
      await vi.waitFor(() => expect(harness.output()).toContain('backend'));
      harness.stdin.write('\u0014');
      await vi.waitFor(() => expect(harness.output()).toContain('TEAM WORKBENCH'));
      harness.stdin.write('r');
      await vi.waitFor(() => expect(retryAgent).toHaveBeenCalledWith('agent-control'));
      expect(harness.output()).toContain('Retry requested for backend.');
      finishTurn?.(session);
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });
});

type MockInput = PassThrough & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode(mode: boolean): MockInput;
  ref(): MockInput;
  unref(): MockInput;
};

type MockOutput = PassThrough & {
  isTTY: boolean;
  columns: number;
  rows: number;
  captured: string;
};

function mockInput(): MockInput {
  const stream = new PassThrough() as MockInput;
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = (mode: boolean) => {
    stream.isRaw = mode;
    return stream;
  };
  stream.ref = () => stream;
  stream.unref = () => stream;
  return stream;
}

function mockOutput(): MockOutput {
  const stream = new PassThrough() as MockOutput;
  stream.isTTY = true;
  stream.columns = 100;
  stream.rows = 32;
  stream.captured = '';
  stream.on('data', (chunk: Buffer) => {
    stream.captured += chunk.toString();
  });
  return stream;
}

async function mountApp(
  runner: AgentRunner,
  root: string,
  extensions?: ExtensionRuntime,
  workspaceReadiness?: import('../src/ui/workspace-preparation.js').WorkspaceReadiness,
): Promise<{
  stdin: MockInput;
  instance: Instance;
  output(): string;
  lastFrame(): string;
  cleanup(): Promise<void>;
}> {
  const stdin = mockInput();
  const stdout = mockOutput();
  const stderr = mockOutput();
  const base = defaultConfig(root);
  const config = {
    ...base,
    model: {provider: 'compatible' as const, model: 'test-model', baseUrl: 'http://localhost'},
    context: {...base.context},
    ui: {...base.ui, color: false, compact: true},
  };
  const instance = render(<SkeinApp
    runner={runner}
    config={config}
    {...(extensions ? {extensions} : {})}
    {...(workspaceReadiness ? {workspaceReadiness} : {})}
  />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await instance.waitUntilRenderFlush();
  return {
    stdin,
    instance,
    output: () => stdout.captured,
    lastFrame: () => lastSynchronizedFrame(stdout.captured),
    async cleanup() {
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}

function lastSynchronizedFrame(output: string): string {
  const start = output.lastIndexOf('\u001B[?2026h');
  const end = output.indexOf('\u001B[?2026l', Math.max(0, start));
  const frame = start >= 0 && end > start
    ? output.slice(start + '\u001B[?2026h'.length, end)
    : output;
  return stripAnsi(frame).replace(/\r/g, '');
}

interface MockRunnerOptions {
  run?: (input: string, options?: {onEvent?: (event: AgentEvent) => void; turnInstructions?: string; askMode?: boolean; signal?: AbortSignal}) => Promise<Session>;
  compactContext?: (instructions?: string) => Promise<{omittedMessages: number; summaryTokens: number}>;
  toolCount?: number;
}

function mockRunner(root: string, session: Session, hits: ContextHit[] = [], options: MockRunnerOptions = {}) {
  const run = vi.fn(options.run ?? (async (_input: string, _options?: unknown) => session));
  const search = vi.fn(async (_query: string, _topK?: number) => hits);
  const compactContext = vi.fn(options.compactContext ?? (async () => ({omittedMessages: 0, summaryTokens: 0})));
  const runner = {
    workspace: {roots: [root]},
    contextEngine: {search},
    tools: {definitions: () => Array.from({length: options.toolCount ?? 0}, (_, index) => ({name: `tool_${index}`}))},
    getSession: () => session,
    getContextStatus: () => ({
      activeTokens: 0,
      summaryTokens: 0,
      toolTokens: 0,
      messageCount: session.messages.length,
      compactedMessages: 0,
      pressure: 0,
    }),
    run,
    compactContext,
    steer: vi.fn(() => false),
    listContextSources: vi.fn(() => session.contextSources ?? []),
    pinContextSource: vi.fn(async (path: string) => ({path, state: 'pinned' as const, tokens: 0, addedAt: new Date().toISOString()})),
    unpinContextSource: vi.fn(async (path: string) => path),
    toggleMuteContextSource: vi.fn(async (path: string) => ({path, state: 'muted' as const, tokens: 0, addedAt: new Date().toISOString()})),
    checkpointStore: {list: vi.fn(async () => []), restore: vi.fn(async () => [])},
  } as unknown as AgentRunner;
  return {runner, run, search, compactContext};
}

function testSession(root: string): Session {
  return createSession({
    id: `test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    workspace: root,
    model: 'test-model',
    provider: 'compatible',
  });
}

function userMessage(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function settleRender(instance: Instance): Promise<void> {
  await settle();
  await instance.waitUntilRenderFlush();
  await settle();
}
