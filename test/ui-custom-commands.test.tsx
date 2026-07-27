import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
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

describe('workspace slash commands', () => {
  it('expands a template into the run input while displaying the invocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-ui-custom-'));
    roots.push(root);
    await mkdir(join(root, '.agents', 'commands'), {recursive: true});
    await writeFile(join(root, '.agents', 'commands', 'ship.md'), '# Ship checklist\n\nRun release checks for $ARGUMENTS.', 'utf8');
    const session = testSession(root);
    const {runner, run} = makeRunner(root, session);
    const harness = await mountApp(runner, root);
    try {
      harness.stdin.write('/ship v1.2\r');
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(run.mock.calls[0]?.[0]).toBe('# Ship checklist\n\nRun release checks for v1.2.');
      await vi.waitFor(() => {
        const output = stripAnsi(harness.output());
        expect(output).toContain('/ship v1.2');
        expect(output).toContain('Expanded .agents/commands/ship.md');
      });
    } finally {
      await harness.cleanup();
    }
  });

  it('keeps built-ins unshadowed and reports genuinely unknown commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-ui-custom-unknown-'));
    roots.push(root);
    await mkdir(join(root, '.agents', 'commands'), {recursive: true});
    await writeFile(join(root, '.agents', 'commands', 'help.md'), 'shadow attempt', 'utf8');
    const session = testSession(root);
    const {runner, run} = makeRunner(root, session);
    const harness = await mountApp(runner, root);
    try {
      harness.stdin.write('/help\r');
      await vi.waitFor(() => expect(stripAnsi(harness.output())).toContain('Commands'));
      expect(stripAnsi(harness.output())).not.toContain('shadow attempt');

      harness.stdin.write('/nosuchcmd\r');
      await vi.waitFor(() => expect(stripAnsi(harness.output())).toContain('Unknown command: /nosuchcmd'));
      expect(run).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });
});

function makeRunner(root: string, session: Session): {runner: AgentRunner; run: ReturnType<typeof vi.fn>} {
  const run = vi.fn(async () => session);
  const runner = {
    workspace: {primaryRoot: root, roots: [root]},
    contextEngine: {search: vi.fn(async () => [])},
    tools: {definitions: () => []},
    getSession: () => session,
    getContextStatus: () => ({
      promptTokens: 0, promptSource: 'none', contextWindowTokens: 500_000,
      activeTokens: 0, summaryTokens: 0, toolTokens: 0,
      messageCount: session.messages.length, compactedMessages: 0, pressure: 0,
    }),
    run,
    compactContext: vi.fn(async () => ({omittedMessages: 0, summaryTokens: 0})),
    steer: vi.fn(() => false),
    listContextSources: vi.fn(() => []),
    checkpointStore: {list: vi.fn(async () => []), restore: vi.fn(async () => [])},
    sessionStore: {list: vi.fn(async () => []), load: vi.fn(async () => session)},
  } as unknown as AgentRunner;
  return {runner, run};
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
    async cleanup() {
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}
