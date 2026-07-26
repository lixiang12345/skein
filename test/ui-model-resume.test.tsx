import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import React from 'react';
import {render, type Instance} from 'ink';
import stripAnsi from 'strip-ansi';
import {afterEach, describe, expect, it, vi} from 'vitest';

import type {AgentRunner} from '../src/agent/index.js';
import {defaultConfig} from '../src/config.js';
import {createSession} from '../src/session/index.js';
import {SkeinApp} from '../src/ui/tui.js';
import type {Session} from '../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('/model and /resume', () => {
  it('shows the active route and switches the model for the session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-model-cmd-'));
    roots.push(root);
    const session = testSession(root);
    const switchModel = vi.fn(async (id: string) => {
      session.model = id;
    });
    const harness = await mountApp(makeRunner(root, session, {switchModel}), root);
    try {
      harness.stdin.write('/model\r');
      await vi.waitFor(() => expect(stripAnsi(harness.output())).toContain('Model route'));
      expect(stripAnsi(harness.output())).toContain('compatible/test-model');

      harness.stdin.write('/model faster-model\r');
      await vi.waitFor(() => expect(stripAnsi(harness.output())).toContain('Model switched to compatible/faster-model'));
      expect(switchModel).toHaveBeenCalledWith('faster-model');
    } finally {
      await harness.cleanup();
    }
  });

  it('lists recent sessions and switches to a prefix match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-resume-cmd-'));
    roots.push(root);
    const session = testSession(root);
    const other: Session = {
      ...testSession(root),
      id: 'feedbeef-0000-4000-8000-000000000000',
      title: 'earlier work',
    };
    other.messages.push({
      id: 'm1', role: 'user', content: 'earlier request', createdAt: new Date().toISOString(),
    });
    const switchSession = vi.fn((target: Session) => {
      Object.assign(session, target);
    });
    const runner = makeRunner(root, session, {
      switchSession,
      summaries: [
        {id: other.id, title: other.title, workspace: root, model: 'test-model', provider: 'compatible', createdAt: other.createdAt, updatedAt: other.updatedAt, messageCount: 1, changedFileCount: 0},
        {id: session.id, title: session.title, workspace: root, model: 'test-model', provider: 'compatible', createdAt: session.createdAt, updatedAt: session.updatedAt, messageCount: 0, changedFileCount: 0},
      ],
      load: async () => other,
    });
    const harness = await mountApp(runner, root);
    try {
      harness.stdin.write('/resume\r');
      await vi.waitFor(() => expect(stripAnsi(harness.output())).toContain('Recent sessions'));
      expect(stripAnsi(harness.output())).toContain('feedbeef');
      expect(stripAnsi(harness.output())).toContain('(current)');

      harness.stdin.write('/resume feedbeef\r');
      await vi.waitFor(() => expect(stripAnsi(harness.output())).toContain('Resumed session feedbeef'));
      expect(switchSession).toHaveBeenCalledTimes(1);
      expect(stripAnsi(harness.output())).toContain('earlier request');
    } finally {
      await harness.cleanup();
    }
  });

  it('rejects ambiguous and unknown session prefixes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-resume-bad-'));
    roots.push(root);
    const session = testSession(root);
    const runner = makeRunner(root, session, {
      summaries: [
        {id: 'aa11', title: 'one', workspace: root, model: 'm', provider: 'compatible', createdAt: session.createdAt, updatedAt: session.updatedAt, messageCount: 1, changedFileCount: 0},
        {id: 'aa22', title: 'two', workspace: root, model: 'm', provider: 'compatible', createdAt: session.createdAt, updatedAt: session.updatedAt, messageCount: 1, changedFileCount: 0},
      ],
    });
    const harness = await mountApp(runner, root);
    try {
      harness.stdin.write('/resume aa\r');
      await vi.waitFor(() => expect(stripAnsi(harness.output())).toContain('ambiguous'));
      harness.stdin.write('/resume zz\r');
      await vi.waitFor(() => expect(stripAnsi(harness.output())).toContain('No session id starts with zz'));
    } finally {
      await harness.cleanup();
    }
  });
});

interface RunnerExtras {
  switchModel?: (id: string) => Promise<void>;
  switchSession?: (session: Session) => void;
  summaries?: Array<Record<string, unknown>>;
  load?: (id: string) => Promise<Session>;
}

function makeRunner(root: string, session: Session, extras: RunnerExtras = {}): AgentRunner {
  return {
    workspace: {primaryRoot: root, roots: [root]},
    contextEngine: {search: vi.fn(async () => [])},
    tools: {definitions: () => []},
    getSession: () => session,
    getContextStatus: () => ({
      activeTokens: 0, summaryTokens: 0, toolTokens: 0,
      messageCount: session.messages.length, compactedMessages: 0, pressure: 0,
    }),
    run: vi.fn(async () => session),
    compactContext: vi.fn(async () => ({omittedMessages: 0, summaryTokens: 0})),
    steer: vi.fn(() => false),
    listContextSources: vi.fn(() => []),
    checkpointStore: {list: vi.fn(async () => []), restore: vi.fn(async () => [])},
    sessionStore: {
      list: vi.fn(async () => extras.summaries ?? []),
      load: vi.fn(extras.load ?? (async () => session)),
    },
    switchModel: vi.fn(extras.switchModel ?? (async () => undefined)),
    switchSession: vi.fn(extras.switchSession ?? (() => undefined)),
  } as unknown as AgentRunner;
}

function testSession(root: string): Session {
  return createSession({
    id: `test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    workspace: root,
    model: 'test-model',
    provider: 'compatible',
  });
}

type MockInput = PassThrough & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: (mode: boolean) => MockInput;
  ref: () => MockInput;
  unref: () => MockInput;
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

async function mountApp(runner: AgentRunner, root: string): Promise<{
  stdin: MockInput;
  instance: Instance;
  output(): string;
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
  const instance = render(<SkeinApp runner={runner} config={config} />, {
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
    async cleanup() {
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}
