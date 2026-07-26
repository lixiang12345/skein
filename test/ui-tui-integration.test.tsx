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
import {routeCostReceipt} from '../src/agent/route-cost.js';
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
      expect(frame).toContain('grounded coding workspace');
      expect(frame).toContain('WORKSPACE');
      expect(frame).toContain('CONTEXT');
      expect(frame).toContain('local index ready');
      expect(frame).toContain('28 files');
      expect(frame).toContain('71 chunks');
      expect(frame).toContain('RUNTIME');
      expect(frame).toContain('EXTENSIONS');
      expect(frame).toContain('9 tools');
      expect(frame).toContain('guarded');
      expect(frame).toContain('Type a request');
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });

  it('shows redacted connection source, protocol, auth state, default, and active status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-connections-ui-'));
    const session = testSession(root);
    const {runner} = mockRunner(root, session);
    const config = defaultConfig(root);
    config.model = {provider: 'compatible', model: 'coder', baseUrl: 'https://relay.example/v1', apiKey: 'runtime-secret'};
    config.ui = {...config.ui, color: false, compact: true};
    config.connectionCatalog = {
      defaultConnection: 'work',
      profiles: [
        {
          id: 'work', provider: 'compatible', protocol: 'openai-chat', source: 'environment',
          endpoint: 'https://relay.example/v1?<redacted>', modelsEndpoint: 'https://relay.example/v1', defaultModel: 'coder',
          authType: 'env', authStatus: 'configured', complete: true, issues: [],
        },
        {
          id: 'backup', provider: 'openai', protocol: 'openai-chat', source: 'user',
          endpoint: 'provider default', modelsEndpoint: 'provider default', authType: 'env', authStatus: 'missing', complete: false,
          issues: ['credential environment BACKUP_KEY is not set'],
        },
      ],
    };
    config.activeConnection = config.connectionCatalog!.profiles[0]!;
    const harness = await mountApp(runner, root, undefined, undefined, config);

    try {
      harness.stdin.write('/connections\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Model connections'));
      const output = stripAnsi(harness.output());
      expect(output).toContain('work compatible environme');
      expect(output).toContain('openai-chat');
      expect(output).toContain('env/configured');
      expect(output).toContain('default');
      expect(output).toContain('active');
      expect(output).toContain('backup openai user');
      expect(output).toContain('env/missing');
      expect(output).not.toContain('runtime-secret');
      expect(output).not.toContain('BACKUP_KEY');
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

  it('runs /review with a fixed scope, a redacted ephemeral bundle, and read-only tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-review-ui-'));
    const session = testSession(root);
    session.changedFiles = [join(root, 'src/api.ts')];
    const {runner, run} = mockRunner(root, session);
    const harness = await mountApp(runner, root);

    try {
      harness.stdin.write('/review working-tree\r');
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(run.mock.calls[0]?.[0]).toBe('Review the current working tree changes.');
      expect(run.mock.calls[0]?.[1]).toMatchObject({askMode: true});
      expect(run.mock.calls[0]?.[1]?.turnInstructions).toContain('<redacted-review-bundle>');
      expect(run.mock.calls[0]?.[1]?.turnInstructions).toContain('"changedFiles": [');
      expect(run.mock.calls[0]?.[1]?.turnInstructions).not.toContain('messages');
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });

  it('joins failure, checkpoint, diff, rollback, audit, retry, and resume in /recover', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-recover-ui-'));
    const session = testSession(root);
    session.changedFiles = [join(root, 'src/api.ts')];
    session.lastRun = {
      status: 'verification_failed',
      changedFiles: [...session.changedFiles],
      checks: [],
      detail: 'Tests failed after the latest change.',
      reason: 'verification_failed',
      finishedAt: '2026-07-25T00:00:00.000Z',
    };
    session.audit = [{
      id: 'failure-audit', createdAt: '2026-07-25T00:00:00.000Z', type: 'tool',
      toolCallId: 'failed-shell', tool: 'shell', category: 'shell', outcome: 'failure',
      metadata: {failure: {class: 'command_exit', repairHint: 'Inspect the failing assertion.', retryable: true}},
    }];
    const {runner, run} = mockRunner(root, session);
    vi.mocked(runner.checkpointStore.list).mockResolvedValue([{
      version: 1,
      id: 'checkpoint-1234567890',
      sessionId: session.id,
      createdAt: '2026-07-25T00:00:00.000Z',
      reason: 'before write_file',
      entries: [{path: join(root, 'src/api.ts'), relativePath: 'src/api.ts', existed: true, blob: 'blob.bin'}],
    }]);
    const harness = await mountApp(runner, root);

    try {
      harness.stdin.write('/recover\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Recovery Center'));
      const output = harness.output();
      expect(output).toContain('Last run verification_fai');
      expect(output).toContain('Inspect the failing assertion.');
      expect(output).toContain('checkpoint-1');
      expect(output).toContain('/recover retry');
      expect(output).toContain('/recover resume');
      expect(output).toContain('/recover diff');
      expect(output).toContain('/recover audit');
      expect(output).toContain('/recover rollback');

      harness.stdin.write('/recover retry\r');
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(run.mock.calls[0]?.[0]).toContain('Retry the most recent failed shell operation');
      expect(run.mock.calls[0]?.[1]?.turnInstructions).toContain('recorded failure receipt');

      session.pendingInput = pendingInput();
      harness.stdin.write('/recover resume\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Answer the pending clarification in the composer'));
      expect(run).toHaveBeenCalledTimes(1);
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

  it('pauses queued follow-ups for clarification and resumes them after the answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-clarification-queue-ui-'));
    const session = testSession(root);
    let finishFirst: (() => void) | undefined;
    let finishQueued: (() => void) | undefined;
    let firstOptions: {onEvent?: (event: AgentEvent) => void} | undefined;
    const {runner, run} = mockRunner(root, session, [], {
      run: async (input, options) => {
        if (input === 'change the public API') {
          firstOptions = options;
          return new Promise<Session>((resolve) => {
            finishFirst = () => {
              session.pendingInput = pendingInput();
              firstOptions?.onEvent?.({type: 'needs_input', pending: session.pendingInput});
              resolve(session);
            };
          });
        }
        if (input === '1') delete session.pendingInput;
        if (input === 'verify tests') {
          return new Promise<Session>((resolve) => { finishQueued = () => resolve(session); });
        }
        return session;
      },
    });
    const harness = await mountApp(runner, root);

    try {
      harness.stdin.write('change the public API\r');
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      harness.stdin.write('verify tests\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Queued follow-up 1.'));

      finishFirst?.();
      await vi.waitFor(() => expect(harness.output()).toContain('Paused 1 queued follow-up'));
      expect(run).toHaveBeenCalledTimes(1);

      harness.stdin.write('1\r');
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
      expect(run.mock.calls.map((call) => call[0])).toEqual([
        'change the public API',
        '1',
        'verify tests',
      ]);
      await vi.waitFor(() => expect(harness.output()).toContain('resolved; resuming 1 queued follow-up.'));
      finishQueued?.();
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
        const cost = routeCostReceipt({inputTokens: 120, outputTokens: 40, source: 'actual'});
        options?.onEvent?.({type: 'team_start', id: 'run-1', objective: 'Review the delivery'});
        options?.onEvent?.({type: 'agent_start', id: 'agent-1', profile: 'architect', provider: 'anthropic', model: 'claude', task: 'Inspect boundaries', phase: 'work'});
        options?.onEvent?.({type: 'agent_update', id: 'agent-1', profile: 'architect', stage: 'response', detail: 'provider search 1 call; 2 sources', inputTokens: 120, outputTokens: 40, cost, hostedToolCalls: 1, sourceCount: 2});
        options?.onEvent?.({type: 'agent_done', id: 'agent-1', profile: 'architect', ok: true, summary: 'Boundary report ready.', provider: 'anthropic', model: 'claude', phase: 'work', durationMs: 12, usage: {inputTokens: 120, outputTokens: 40}, cost, hostedToolCalls: 1, sourceCount: 2, toolCalls: 2});
        options?.onEvent?.({
          type: 'team_done', id: 'run-1', accepted: true, reviewRounds: 1,
          review: {decision: 'accept', pass: 3, fail: 0, unknown: 0},
        });
        return session;
      },
    });
    const harness = await mountApp(runner, root);

    try {
      harness.stdin.write('review the delivery\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Team run run-1 accepted'));
      await vi.waitFor(() => expect(harness.output()).toContain('judge accept 3 pass 0 fail 0 unknown'));
      harness.stdin.write('\u0014');
      await vi.waitFor(() => expect(harness.output()).toContain('TEAM WORKBENCH'));
      await vi.waitFor(() => expect(harness.output()).toContain('unpriced'));
      await vi.waitFor(() => expect(harness.output()).toContain('2 sources'));
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

  it('renders redacted MCP trust review and requires destructive confirmations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-mcp-trust-ui-'));
    const session = testSession(root);
    const {runner} = mockRunner(root, session);
    const trust = vi.fn(async () => ({
      name: 'docs', state: 'disconnected', transport: 'http', toolCount: 0,
      required: false, trust: 'trusted',
    }));
    const revoke = vi.fn(async () => ({
      name: 'docs', state: 'revoked', transport: 'http', toolCount: 0,
      required: false, trust: 'revoked',
    }));
    const extensions = {
      listWorkflows: () => [],
      mcpStatus: () => [{
        name: 'docs', state: 'untrusted', transport: 'http', toolCount: 0,
        required: false, trust: 'untrusted',
      }],
      mcpInspect: () => ({
        schemaVersion: 1,
        id: 'mcp:docs',
        source: {kind: 'mcp', owner: 'user-config'},
        name: 'docs',
        version: '1.0.0',
        required: false,
        transport: 'http',
        target: 'https://example.com/mcp',
        dynamicTools: false,
        tools: [{
          name: 'search', permissions: ['read', 'network'],
          network: ['https://api.example.com/search'], commands: [], paths: [],
          sensitiveFields: ['token'], background: false, processTree: false,
          completionEvidence: 'none',
        }],
      }),
      mcpTrust: trust,
      mcpRevoke: revoke,
      memoryStats: () => undefined,
    } as unknown as ExtensionRuntime;
    const harness = await mountApp(runner, root, extensions);

    try {
      harness.stdin.write('/mcp trust docs\r');
      await vi.waitFor(() => expect(harness.output()).toContain('MCP trust review · docs'));
      expect(harness.output()).toContain('https://example.com/mcp');
      expect(harness.output()).toContain('sensitive fields');
      expect(harness.output()).toContain('token');
      expect(harness.output()).toContain('/mcp trust docs --confirm');
      expect(trust).not.toHaveBeenCalled();

      harness.stdin.write('/mcp trust docs --confirm\r');
      await vi.waitFor(() => expect(trust).toHaveBeenCalledWith('docs'));
      await vi.waitFor(() => expect(harness.output()).toContain('Activation remains explicit'));

      harness.stdin.write('/mcp revoke docs\r');
      await vi.waitFor(() => expect(harness.output()).toContain('/mcp revoke docs --confirm'));
      expect(revoke).not.toHaveBeenCalled();
      harness.stdin.write('/mcp revoke docs --confirm\r');
      await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('docs'));
      await vi.waitFor(() => expect(harness.output()).toContain('Re-inspection and trust are required'));
    } finally {
      await harness.cleanup();
      await rm(root, {recursive: true, force: true});
    }
  });

  it('renders content-free memory privacy and explicit Skill/workflow trust metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-governance-ui-'));
    const session = testSession(root);
    const {runner} = mockRunner(root, session);
    const privateContent = 'Never print this retained memory content.';
    const privateDatabasePath = join(root, '.private', 'memory.sqlite');
    const extensions = {
      memory: {},
      memoryStats: () => ({active: 2, archived: 1, candidates: 1, path: privateDatabasePath}),
      memoryPrivacyReview: async () => ({
        schemaVersion: 1 as const,
        generatedAt: '2026-07-26T00:00:00.000Z',
        contentIncluded: false as const,
        scopeKeysIncluded: false as const,
        databasePathIncluded: false as const,
        storage: {
          kind: 'local-sqlite' as const,
          journalMode: 'wal' as const,
          encryptedAtRest: false as const,
          ownerOnly: true,
          filesChecked: 3,
        },
        totals: {
          records: 3, active: 2, archived: 1,
          candidates: {pending: 1, approved: 0, rejected: 0},
        },
        recordsByScope: {user: 1, workspace: 2, session: 0, agent: 0},
        recordsByKind: {semantic: 2, episodic: 0, procedural: 1},
        lifecycle: {
          expiring: 1, expired: 0, neverExpires: 2, unverified: 0, directInferred: 0, superseding: 0,
        },
        findings: [{
          code: 'unencrypted-local-store', severity: 'info' as const, count: 3,
          action: 'Protect the device and backups; the SQLite store is not encrypted by Skein.',
        }],
      }),
      listSkills: () => [{
        name: 'workspace-release',
        description: 'Review release artifacts.',
        path: join(root, '.agents', 'skills', 'release', 'SKILL.md'),
        scope: 'workspace' as const,
        trusted: false,
        trust: 'changed' as const,
        trustSource: 'none' as const,
        effect: 'blocked' as const,
        fingerprint: 'a'.repeat(64),
      }],
      listWorkflows: () => [{
        name: 'review', description: 'Review without mutating the catalog.', steps: [],
        source: 'builtin' as const, trusted: true as const, catalogAccess: 'read-only' as const,
        execution: 'read-only' as const,
      }],
      mcpStatus: () => [],
    } as unknown as ExtensionRuntime;
    const harness = await mountApp(runner, root, extensions);

    try {
      harness.stdin.write('/memory privacy\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Memory privacy'));
      const privacyOutput = stripAnsi(harness.output());
      expect(privacyOutput).toContain('content-free');
      expect(privacyOutput).toContain('3 retained records');
      expect(privacyOutput).toContain('not encrypted by Skein');
      expect(privacyOutput).toContain('No content, tags, scope k');
      expect(privacyOutput).not.toContain(privateContent);
      expect(privacyOutput).not.toContain(privateDatabasePath);

      harness.stdin.write('/skills\r');
      await vi.waitFor(() => expect(harness.output()).toContain('workspace-release'));
      const skillsOutput = stripAnsi(harness.output());
      expect(skillsOutput).toContain('workspace');
      expect(skillsOutput).toContain('changed');
      expect(skillsOutput).toContain('blocked');
      expect(skillsOutput).toContain('aaaaaaaaaaaa');

      harness.stdin.write('/workflow\r');
      await vi.waitFor(() => expect(harness.output()).toContain('Review without mutating'));
      const workflowOutput = stripAnsi(harness.output());
      expect(workflowOutput).toContain('review');
      expect(workflowOutput).toContain('builtin');
      expect(workflowOutput).toContain('trusted');
      expect(workflowOutput).toContain('read-only catalog');
      expect(workflowOutput).toContain('read-only execution');
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
  providedConfig?: import('../src/types.js').MosaicConfig,
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
  const config = providedConfig ?? {
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
    workspace: {primaryRoot: root, roots: [root]},
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

function pendingInput(): NonNullable<Session['pendingInput']> {
  return {
    id: '00000000-0000-4000-8000-000000000040',
    runId: '00000000-0000-4000-8000-000000000041',
    createdAt: '2026-07-25T00:00:00.000Z',
    originalRequest: 'change the public API',
    question: 'Which compatibility policy?',
    options: [
      {id: 'compatible', label: 'Compatible', impact: 'Keep callers working.', recommended: true},
      {id: 'breaking', label: 'Breaking', impact: 'Require migration.', recommended: false},
    ],
    reason: 'public_api_compatibility_missing',
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
