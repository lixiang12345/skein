import {describe, expect, it} from 'vitest';
import {ContextManager, clearOldToolResults} from '../../src/context/manager.js';
import type {ModelProvider} from '../../src/providers/provider.js';
import type {ChatMessage, MosaicConfig, Session} from '../../src/types.js';
import {createSession} from '../../src/session/store.js';

function config(): MosaicConfig {
  return {
    model: {provider: 'compatible', model: 'test'},
    workspaceRoots: ['/tmp/example'],
    context: {engine: 'local', maxTokens: 8_000, topK: 4, contextEngineCommand: 'contextengine'},
    permissions: {read: 'allow', write: 'deny', shell: 'deny', git: 'deny', network: 'deny', allowCommands: [], denyCommands: []},
    hooks: {},
    agent: {maxTurns: 4, maxSessionTokens: 100_000, autoVerify: false, verifyCommands: [], checkpointBeforeWrite: false},
    ui: {color: false, compact: false},
  };
}

const provider: ModelProvider = {
  name: 'test',
  async complete() {
    return {content: '# Goal\nShip safely.\n\n# Next Actions\nRun tests.', toolCalls: []};
  },
};

describe('ContextManager', () => {
  it('maintains working memory and compacts old messages while keeping recent context', async () => {
    const session = createSession({workspace: '/tmp/example', provider: 'compatible', model: 'test'});
    const manager = new ContextManager(config());
    manager.startTurn(session, 'Ship the release safely');
    for (let index = 0; index < 16; index += 1) {
      session.messages.push(message(index % 2 ? 'assistant' : 'user', `message ${index} ${'x'.repeat(200)}`));
    }
    const result = await manager.compact(session, provider);
    expect(result.omittedMessages).toBeGreaterThan(0);
    expect(session.contextSummary).toContain('Ship safely');
    expect(manager.buildShortTermPrompt(session)).toContain('working-memory');
    expect(manager.buildShortTermPrompt(session)).toContain('authorization="none"');
    expect(manager.status(session).compactedMessages).toBe(result.omittedMessages);
    const active = session.messages.slice(result.omittedMessages);
    expect(active[0]?.role).toBe('user');
    expect(active.filter((item) => item.role === 'user')).toHaveLength(3);
  });

  it('replaces bulky old tool results with evidence receipts without mutating recent turns', () => {
    const old = message('tool', `running tests\nsrc/queue.ts:12 error: assertion failed\nexit code 1\n${'x'.repeat(2_000)}`);
    old.name = 'shell';
    old.toolCallId = 'call-1';
    const recent = message('tool', `recent\n${'y'.repeat(2_000)}`);
    const output = clearOldToolResults([old, ...Array.from({length: 8}, () => message('user', 'x')), recent]);
    expect(output[0]?.content).toContain('structured receipt');
    expect(output[0]?.content).toContain('tool: shell');
    expect(output[0]?.content).toContain('status: failure (exit 1)');
    expect(output[0]?.content).toContain('src/queue.ts:12');
    expect(output.at(-1)?.content).toBe(recent.content);
  });
});

function message(role: ChatMessage['role'], content: string): ChatMessage {
  return {id: `${role}-${Math.random()}`, role, content, createdAt: new Date().toISOString()};
}
