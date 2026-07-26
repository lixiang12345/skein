import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {AgentRunner} from '../../src/agent/runner.js';
import type {ContextProvider} from '../../src/tools/types.js';
import type {ModelProvider} from '../../src/providers/provider.js';
import type {AgentEvent, MosaicConfig} from '../../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

function config(root: string, shell: 'allow' | 'ask' | 'deny'): MosaicConfig {
  return {
    model: {provider: 'compatible', model: 'test-model', apiKey: 'test'},
    workspaceRoots: [root],
    context: {maxTokens: 2_000, topK: 4},
    permissions: {
      read: 'allow', write: 'allow', shell, git: 'deny', network: 'deny',
      allowCommands: [], denyCommands: [],
    },
    hooks: {},
    agent: {maxTurns: 2, maxSessionTokens: 100_000, autoVerify: false, verifyCommands: [], checkpointBeforeWrite: true},
    ui: {color: false, compact: true},
  };
}

const context: ContextProvider = {
  async pack() { return {text: '', hits: [], estimatedTokens: 0, engine: 'test', truncated: false}; },
  async search() { return []; },
};

const provider: ModelProvider = {
  name: 'compatible',
  async complete() { throw new Error('The user shell escape must never call the model.'); },
};

async function makeRunner(shell: 'allow' | 'ask' | 'deny'): Promise<AgentRunner> {
  const root = await mkdtemp(join(tmpdir(), 'skein-user-shell-'));
  roots.push(root);
  return new AgentRunner({config: config(root, shell), provider, contextEngine: context, persistSession: false});
}

describe('runUserShellCommand', () => {
  it('runs an allowed command through the tool pipeline without a model turn', async () => {
    const runner = await makeRunner('allow');
    const events: AgentEvent[] = [];
    const {result} = await runner.runUserShellCommand('echo user-shell-ok', {
      onEvent: (event) => { events.push(event); },
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('user-shell-ok');
    expect(events.some((event) => event.type === 'tool_result')).toBe(true);
  });

  it('respects an explicit permission denial', async () => {
    const runner = await makeRunner('ask');
    const {result} = await runner.runUserShellCommand('echo should-not-run', {
      requestPermission: async () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.content).not.toContain('should-not-run');
  });

  it('fails closed under a deny policy', async () => {
    const runner = await makeRunner('deny');
    const {result} = await runner.runUserShellCommand('echo denied-path', {
      requestPermission: async () => true,
    });
    expect(result.ok).toBe(false);
    expect(result.content).not.toContain('denied-path');
  });
});
