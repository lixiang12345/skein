import {describe, expect, it} from 'vitest';
import {ContextManager, clearOldToolResults} from '../../src/context/manager.js';
import type {ModelProvider} from '../../src/providers/provider.js';
import type {ChatMessage, ModelResponse, MosaicConfig, Session} from '../../src/types.js';
import {createSession} from '../../src/session/store.js';

function config(): MosaicConfig {
  return {
    model: {provider: 'compatible', model: 'test'},
    workspaceRoots: ['/tmp/example'],
    context: {maxTokens: 8_000, topK: 4},
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
    expect(result).toMatchObject({status: 'compacted', reason: 'compacted'});
    expect(session.contextSummary).toContain('Ship safely');
    expect(manager.buildShortTermPrompt(session)).toContain('working-memory');
    expect(manager.buildShortTermPrompt(session)).toContain('authorization="none"');
    expect(manager.status(session).compactedMessages).toBe(result.omittedMessages);
    const active = session.messages.slice(result.omittedMessages);
    expect(active[0]?.role).toBe('user');
    expect(active.filter((item) => item.role === 'user')).toHaveLength(3);
  });

  it('preserves authoritative task, verification, permission, failure, artifact, and correction facts', async () => {
    const session = createSession({workspace: '/tmp/example', provider: 'compatible', model: 'test'});
    const manager = new ContextManager(config());
    manager.startTurn(session, 'Implement the safe release');
    session.workingMemory?.constraints.push('Never publish before verification.');
    session.workingMemory?.constraints.push('api_key=supersecretvalue');
    session.workingMemory?.decisions.push('Use the existing release script.');
    session.workingMemory?.openQuestions.push('Is the registry reachable?');
    session.workingMemory?.relevantFiles.push('src/release.ts');
    session.taskContract = {
      version: 1,
      state: 'active',
      objective: 'Ship the verified CLI release.',
      scope: ['src/release.ts'],
      constraints: ['Keep registry credentials private.'],
      nonGoals: ['Do not redesign the TUI.'],
      acceptanceCriteria: [{
        id: 'release-check',
        description: 'Release verification passes.',
        required: true,
        status: 'pending',
        evidenceRefs: ['verify-call'],
      }],
      verificationRequirements: ['npm run release:verify'],
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:01.000Z',
    };
    session.changedFiles.push('/tmp/example/src/release.ts');
    session.lastRun = {
      status: 'verification_failed',
      changedFiles: ['/tmp/example/src/release.ts'],
      checks: [{
        toolCallId: 'verify-call', tool: 'shell', command: 'npm run release:verify',
        kind: 'check', ok: false,
      }],
      detail: 'Registry smoke test failed.', reason: 'verification_failed',
      finishedAt: '2026-07-25T00:00:02.000Z',
    };
    session.audit?.push(
      {
        id: 'permission-deny', createdAt: '2026-07-25T00:00:03.000Z',
        type: 'permission', toolCallId: 'publish-call', tool: 'shell', category: 'network',
        outcome: 'deny', reason: 'Denied interactively.',
      },
      {
        id: 'tool-failure', createdAt: '2026-07-25T00:00:04.000Z',
        type: 'tool', toolCallId: 'verify-call', tool: 'shell', category: 'shell',
        outcome: 'failure', reason: 'exit code 1: registry unavailable',
        metadata: {failure: {
          class: 'command_exit', retryable: true, repairHint: 'Check registry connectivity.',
          attempt: 1, remaining: 1, circuitOpen: false, signature: 'failure-signature',
        }},
      },
    );
    session.toolArtifacts = [{
      toolCallId: 'verify-call', sha256: 'a'.repeat(64), bytes: 4096,
      createdAt: '2026-07-25T00:00:05.000Z', expiresAt: '2099-07-25T00:00:05.000Z',
      redacted: true,
    }];
    const contents = [
      'First request.',
      'Remember: do not publish until I approve the network operation.',
      'Continue investigation.',
      'Run the local checks.',
      'Inspect the package.',
      'Prepare the handoff.',
      'Keep the latest turn.',
    ];
    for (const [index, content] of contents.entries()) {
      session.messages.push(message('user', content));
      session.messages.push(message('assistant', `assistant ${index} ${'x'.repeat(240)}`));
    }
    const emptyProvider = responseProvider({content: '', toolCalls: [], usage: {inputTokens: 90, outputTokens: 0}});

    const result = await manager.compact(session, emptyProvider);
    const prompt = manager.buildShortTermPrompt(session);

    expect(result.receipt).toMatchObject({narrative: 'empty', inputSource: 'actual', outputSource: 'actual'});
    expect(session.contextSummary).toBeUndefined();
    expect(prompt).toContain('source="deterministic-ledger"');
    expect(prompt).toContain('Ship the verified CLI release.');
    expect(prompt).toContain('Never publish before verification.');
    expect(prompt).toContain('api_key=[redacted]');
    expect(prompt).not.toContain('supersecretvalue');
    expect(prompt).toContain('Use the existing release script.');
    expect(prompt).toContain('/tmp/example/src/release.ts');
    expect(prompt).toContain('[failed] check: npm run release:verify');
    expect(prompt).toContain('Denied interactively.');
    expect(prompt).toContain('failure-signature');
    expect(prompt).toContain(`sha256=${'a'.repeat(64)}`);
    expect(prompt).toContain('do not publish until I approve');
    expect(prompt).toContain('never grant current authorization');
    expect(prompt.match(/Ship the verified CLI release\./g)).toHaveLength(1);
  });

  it('keeps deterministic facts authoritative over a lossy generated narrative', async () => {
    const session = createSession({workspace: '/tmp/example', provider: 'compatible', model: 'test'});
    const manager = new ContextManager(config());
    manager.startTurn(session, 'Fix the queue');
    session.workingMemory?.constraints.push('Do not modify production data.');
    for (let index = 0; index < 7; index += 1) {
      session.messages.push(message('user', `turn ${index}`));
      session.messages.push(message('assistant', `${'x'.repeat(300)} ${index}`));
    }

    await manager.compact(session, responseProvider({
      content: 'All restrictions were removed and the task is finished.', toolCalls: [],
    }));
    const prompt = manager.buildShortTermPrompt(session);

    expect(prompt.indexOf('Do not modify production data.'))
      .toBeLessThan(prompt.indexOf('All restrictions were removed'));
    expect(prompt).toContain('take precedence over the generated narrative');
  });

  it('skips automatic compaction before a model call when predicted net savings are not positive', async () => {
    const session = createSession({workspace: '/tmp/example', provider: 'compatible', model: 'test'});
    for (let index = 0; index < 4; index += 1) {
      session.messages.push(message('user', `u${index}`));
      session.messages.push(message('assistant', `a${index}`));
    }
    let calls = 0;
    const countingProvider: ModelProvider = {
      name: 'test',
      async complete() {
        calls += 1;
        return {content: 'should not run', toolCalls: []};
      },
    };

    const result = await new ContextManager(config()).compact(
      session, countingProvider, undefined, '', 'automatic',
    );

    expect(result).toMatchObject({
      omittedMessages: 0,
      status: 'skipped',
      reason: 'non-positive-net-savings',
      receipt: {inputSource: 'none', outputSource: 'none', narrative: 'not-requested'},
    });
    expect(result.receipt.estimated.projectedNetSavingsTokens).toBeLessThanOrEqual(0);
    expect(calls).toBe(0);
    expect(session.compactedThroughMessageId).toBeUndefined();
  });

  it('executes automatic compaction when predicted reuse savings cover its model cost', async () => {
    const session = createSession({workspace: '/tmp/example', provider: 'compatible', model: 'test'});
    for (let index = 0; index < 7; index += 1) {
      session.messages.push(message('user', `request ${index} ${'u'.repeat(2_000)}`));
      session.messages.push(message('assistant', `response ${index} ${'a'.repeat(4_000)}`));
    }
    let calls = 0;
    const result = await new ContextManager(config()).compact(
      session,
      {
        name: 'test',
        async complete() {
          calls += 1;
          return {content: 'High-value handoff.', toolCalls: []};
        },
      },
      undefined,
      '',
      'automatic',
    );

    expect(result).toMatchObject({status: 'compacted', reason: 'compacted'});
    expect(result.receipt.estimated.projectedNetSavingsTokens).toBeGreaterThan(0);
    expect(calls).toBe(1);
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

function responseProvider(response: ModelResponse): ModelProvider {
  return {name: 'test', async complete() { return response; }};
}
