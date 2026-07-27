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

describe('composer draft recovery and exit confirmation', () => {
  it('recovers an Escape-cleared draft through ArrowUp history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-draft-recovery-'));
    roots.push(root);
    const harness = await mountApp(makeRunner(root, testSession(root)), root);
    try {
      const draft = 'a long draft that must not vanish';
      harness.stdin.write(draft);
      await vi.waitFor(() => expect(stripAnsi(harness.output())).toContain(draft));

      harness.stdin.write('');
      await vi.waitFor(() => expect(stripAnsi(harness.output())).toContain('Draft cleared. Press ArrowUp to restore it.'));

      harness.stdin.write('[A');
      await vi.waitFor(() => expect(stripAnsi(harness.lastFrame())).toContain(draft));
    } finally {
      await harness.cleanup();
    }
  });

  it('requires a second Ctrl+C within the window to exit an idle empty composer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-exit-confirm-'));
    roots.push(root);
    const harness = await mountApp(makeRunner(root, testSession(root)), root);
    let exited = false;
    void harness.instance.waitUntilExit().then(() => { exited = true; });
    try {
      harness.stdin.write('');
      await vi.waitFor(() => expect(stripAnsi(harness.output())).toContain('Press Ctrl+C again to exit.'));
      expect(exited).toBe(false);

      harness.stdin.write('');
      await vi.waitFor(() => expect(exited).toBe(true));
    } finally {
      await harness.cleanup();
    }
  });
});

function makeRunner(root: string, session: Session): AgentRunner {
  return {
    workspace: {primaryRoot: root, roots: [root]},
    contextEngine: {search: vi.fn(async () => [])},
    tools: {definitions: () => []},
    getSession: () => session,
    getContextStatus: () => ({
      promptTokens: 0, promptSource: 'none', contextWindowTokens: 500_000,
      activeTokens: 0, summaryTokens: 0, toolTokens: 0,
      messageCount: session.messages.length, compactedMessages: 0, pressure: 0,
    }),
    run: vi.fn(async () => session),
    compactContext: vi.fn(async () => ({omittedMessages: 0, summaryTokens: 0})),
    steer: vi.fn(() => false),
    listContextSources: vi.fn(() => []),
    checkpointStore: {list: vi.fn(async () => []), restore: vi.fn(async () => [])},
    sessionStore: {list: vi.fn(async () => []), load: vi.fn(async () => session)},
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

async function mountApp(runner: AgentRunner, root: string): Promise<{
  stdin: MockInput;
  instance: Instance;
  output(): string;
  lastFrame(): string;
  cleanup(): Promise<void>;
}> {
  const stdin = mockInput();
  const stdout = Object.assign(new PassThrough(), {isTTY: true, columns: 100, rows: 32, captured: ''});
  const stderr = Object.assign(new PassThrough(), {isTTY: true, columns: 100, rows: 32});
  stdout.on('data', (chunk: Buffer) => { stdout.captured += chunk.toString(); });
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
    lastFrame: () => {
      const captured = stdout.captured;
      const start = captured.lastIndexOf('[?2026h');
      const end = captured.indexOf('[?2026l', Math.max(0, start));
      const frame = start >= 0 && end > start ? captured.slice(start + 8, end) : captured;
      return stripAnsi(frame).replace(/\r/g, '');
    },
    async cleanup() {
      instance.unmount();
      await instance.waitUntilExit().catch(() => undefined);
    },
  };
}
