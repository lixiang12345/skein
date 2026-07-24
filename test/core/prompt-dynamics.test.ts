import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {AgentRunner} from '../../src/agent/runner.js';
import {
  buildSessionStatePrompt,
  buildStableSystemPrompt,
  buildTurnDirective,
  classifyTurnIntent,
  isTrivialTurn,
} from '../../src/agent/prompt.js';
import {createSession} from '../../src/session/store.js';
import type {ModelProvider} from '../../src/providers/provider.js';
import type {ChatMessage, MosaicConfig} from '../../src/types.js';
import type {ContextProvider} from '../../src/tools/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('dynamic prompt assembly', () => {
  it('classifies English and Chinese task intent into stable prompt modes', () => {
    expect(classifyTurnIntent('Review this change for regressions')).toBe('review');
    expect(classifyTurnIntent('排查这个崩溃并修复')).toBe('debug');
    expect(classifyTurnIntent('解释一下请求链路')).toBe('explain');
    expect(buildTurnDirective('重构这个模块').text).toContain('intent="refactor"');
  });

  it('injects optional orchestration guidance only when agent tools are enabled', () => {
    const direct = buildTurnDirective('Implement the parser');
    expect(direct.text).toContain('Use only tools exposed for this turn');
    expect(direct.text).not.toContain('team_run');

    const orchestrated = buildTurnDirective('Implement the parser', {agents: true});
    expect(orchestrated.text).toContain('team_run');
    expect(orchestrated.text).toContain('keep workspace mutation in the main agent');
  });

  it('treats greetings and acknowledgements as trivial turns', () => {
    for (const trivial of ['hi', 'Hello!', '你好', '嗨~', '谢谢', 'ok', '收到', 'thanks', 'gm', 'ping', '在吗？']) {
      expect(isTrivialTurn(trivial), trivial).toBe(true);
    }
    for (const real of ['fix the crash', '重构这个模块', 'explain @src/agent/runner.ts', 'add pagination to /users', 'hi, can you refactor the parser for me please']) {
      expect(isTrivialTurn(real), real).toBe(false);
    }
  });

  it('keeps mutable plan state outside the cacheable system prefix', () => {
    const root = '/tmp/skein-prompt-cache';
    const session = createSession({workspace: root, provider: 'compatible', model: 'test'});
    const stable = buildStableSystemPrompt(config(root), 'workspace rule', 'reviewer');
    expect(stable).toContain('workspace rule');
    expect(stable).toContain('reviewer');
    expect(stable).toContain('memory_propose');
    expect(stable).toContain('Preserve user work');
    expect(stable).toContain("Match the user's language");
    expect(stable).not.toContain('Current saved plan');

    session.tasks.push({id: 'task-1', title: 'Verify the parser', status: 'in_progress'});
    const state = buildSessionStatePrompt(session);
    expect(state).toContain('Verify the parser');
    expect(state).toContain('authorization="none"');
    expect(buildStableSystemPrompt(config(root), 'workspace rule', 'reviewer')).toBe(stable);
  });

  it('keeps workflow instructions ephemeral while preserving visible user input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-prompt-'));
    roots.push(root);
    const calls: ChatMessage[][] = [];
    const provider: ModelProvider = {
      name: 'test',
      async complete(messages) {
        calls.push(messages);
        return {content: 'Done.', toolCalls: []};
      },
    };
    const context: ContextProvider = {
      async pack() { return {text: '', hits: [], estimatedTokens: 0, engine: 'test', truncated: false}; },
      async search() { return []; },
    };
    const runner = new AgentRunner({
      config: config(root),
      provider,
      contextEngine: context,
      persistSession: false,
    });
    const events: string[] = [];
    const visible = '/workflow debug fix the crash';
    const directive = '<workflow name="debug">internal steps</workflow>';
    const session = await runner.run(visible, {
      turnInstructions: directive,
      onEvent: (event) => { events.push(event.type); },
    });

    expect(session.messages.find((message) => message.role === 'user')?.content).toBe(visible);
    expect(session.title).toBe(visible);
    expect(session.messages.some((message) => message.content.includes('internal steps'))).toBe(false);
    expect(calls[0]?.some((message) => message.role === 'system' && message.content.includes(directive))).toBe(true);
    expect(events).toContain('prompt');
  });
});

function config(root: string): MosaicConfig {
  return {
    model: {provider: 'compatible', model: 'test', apiKey: 'test'},
    workspaceRoots: [root],
    context: {maxTokens: 4_000, topK: 4},
    permissions: {read: 'allow', write: 'deny', shell: 'deny', git: 'deny', network: 'deny', allowCommands: [], denyCommands: []},
    hooks: {},
    agent: {maxTurns: 2, maxSessionTokens: 20_000, autoVerify: false, verifyCommands: [], checkpointBeforeWrite: false},
    ui: {color: false, compact: true},
  };
}
