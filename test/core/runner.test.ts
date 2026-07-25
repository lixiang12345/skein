import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {AgentRunner} from '../../src/agent/runner.js';
import {createSession, SessionStore} from '../../src/session/store.js';
import {CheckpointStore} from '../../src/checkpoint/store.js';
import type {ContextProvider} from '../../src/tools/types.js';
import type {ModelProvider} from '../../src/providers/provider.js';
import type {
  AgentEvent,
  ChatMessage,
  DuplicationBaseline,
  MosaicConfig,
  ModelResponse,
  ToolResult,
} from '../../src/types.js';
import {extractFunctionFingerprints} from '../../src/context/function-fingerprint.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

function config(root: string): MosaicConfig {
  return {
    model: {provider: 'compatible', model: 'test-model', apiKey: 'test'},
    workspaceRoots: [root],
    context: {maxTokens: 2_000, topK: 4},
    permissions: {
      read: 'allow', write: 'allow', shell: 'deny', git: 'deny', network: 'deny',
      allowCommands: [], denyCommands: [],
    },
    hooks: {},
    agent: {maxTurns: 4, maxSessionTokens: 100_000, autoVerify: false, verifyCommands: [], checkpointBeforeWrite: true},
    ui: {color: false, compact: true},
  };
}

class ScriptedProvider implements ModelProvider {
  readonly name = 'compatible';
  calls = 0;
  seenToolCounts: number[] = [];
  async complete(_messages: Parameters<ModelProvider['complete']>[0], tools: Parameters<ModelProvider['complete']>[1]): Promise<ModelResponse> {
    this.calls += 1;
    this.seenToolCounts.push(tools.length);
    if (this.calls === 1 && tools.some((tool) => tool.name === 'write_file')) {
      return {
        content: 'I will make the change.',
        toolCalls: [{
          id: 'write-1', name: 'write_file',
          arguments: {path: 'result.txt', content: 'done\n'},
        }],
        usage: {inputTokens: 10, outputTokens: 5},
      };
    }
    return {content: 'Completed and verified.', toolCalls: [], usage: {inputTokens: 8, outputTokens: 4}};
  }
}

class QueueProvider implements ModelProvider {
  readonly name = 'compatible';
  readonly calls: ChatMessage[][] = [];
  readonly seenTools: string[][] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(messages: ChatMessage[], tools: Parameters<ModelProvider['complete']>[1]): Promise<ModelResponse> {
    this.calls.push(messages);
    this.seenTools.push(tools.map((tool) => tool.name));
    const response = this.responses.shift();
    if (!response) throw new Error('No scripted response remaining.');
    return response;
  }
}

class SteeringProvider implements ModelProvider {
  readonly name = 'compatible';
  readonly calls: ChatMessage[][] = [];
  readonly started: Promise<void>;
  private readonly firstResponse: Promise<void>;
  private markStarted!: () => void;
  private releaseFirst!: () => void;

  constructor() {
    this.started = new Promise((resolve) => { this.markStarted = resolve; });
    this.firstResponse = new Promise((resolve) => { this.releaseFirst = resolve; });
  }

  release(): void {
    this.releaseFirst();
  }

  async complete(messages: ChatMessage[]): Promise<ModelResponse> {
    this.calls.push(messages);
    if (this.calls.length === 1) {
      this.markStarted();
      await this.firstResponse;
      return {content: 'Initial direction.', toolCalls: []};
    }
    return {content: 'Adjusted direction.', toolCalls: []};
  }
}

class StreamingProvider implements ModelProvider {
  readonly name = 'compatible';

  async complete(): Promise<ModelResponse> {
    throw new Error('The runner should prefer stream() when it is available.');
  }

  async *stream() {
    yield {type: 'text_delta' as const, content: 'Streaming '};
    yield {type: 'text_delta' as const, content: 'works.'};
    yield {
      type: 'result' as const,
      response: {content: 'Streaming works.', toolCalls: [], usage: {inputTokens: 3, outputTokens: 2}},
    };
  }
}

const context: ContextProvider = {
  async pack() { return {text: '', hits: [], estimatedTokens: 0, engine: 'test', truncated: false}; },
  async search() { return []; },
};

function addCompactionHistory(session: ReturnType<typeof createSession>): void {
  for (let index = 0; index < 7; index += 1) {
    session.messages.push({
      id: `compaction-user-${index}`, role: 'user', content: `request ${index}`,
      createdAt: '2026-07-25T00:00:00.000Z',
    });
    session.messages.push({
      id: `compaction-assistant-${index}`, role: 'assistant', content: `${'x'.repeat(400)} ${index}`,
      createdAt: '2026-07-25T00:00:00.000Z',
    });
  }
}

describe('AgentRunner', () => {
  it('rotates a context epoch without ending the durable session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-runner-epoch-'));
    roots.push(root);
    const session = createSession({workspace: root, model: 'test-model', provider: 'compatible'});
    session.contextEpochs![0]!.usage = {inputTokens: 5_000, outputTokens: 1_000};
    session.usage = {inputTokens: 5_000, outputTokens: 1_000};
    const provider = new QueueProvider([{content: 'Continued.', toolCalls: [], usage: {inputTokens: 5, outputTokens: 2}}]);
    const runnerConfig = config(root);
    runnerConfig.agent.maxEpochTokens = 5_000;
    runnerConfig.agent.maxSessionTokens = 100_000;
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({config: runnerConfig, provider, contextEngine: context, session, persistSession: false});

    const result = await runner.run('continue this same session', {onEvent: (event) => { events.push(event); }});

    expect(result.id).toBe(session.id);
    expect(result.contextEpochs).toHaveLength(2);
    expect(result.contextEpochs?.[0]).toMatchObject({finishedAt: expect.any(String), handoff: {reason: 'token_budget'}});
    expect(result.contextEpochs?.[1]).toMatchObject({index: 2, usage: {inputTokens: 5, outputTokens: 2}});
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({type: 'context_epoch', index: 2})]));
  });

  it('pauses a complex ambiguous API change and resumes after the user decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-runner-intent-'));
    roots.push(root);
    const request = `Refactor the public API and rename every exported entry across modules. ${'Update callers and tests safely. '.repeat(8)}`;
    const provider = new QueueProvider([{content: 'Applied the compatibility decision.', toolCalls: [], usage: {inputTokens: 5, outputTokens: 2}}]);
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({config: config(root), provider, contextEngine: context, persistSession: false});

    const paused = await runner.run(request, {onEvent: (event) => { events.push(event); }});
    expect(provider.calls).toHaveLength(0);
    expect(paused.lastRun?.reason).toBe('needs_input');
    expect(paused.pendingInput).toMatchObject({reason: 'public_api_compatibility_missing'});
    const runId = paused.pendingInput?.runId;

    const resumed = await runner.run('1', {maxTurns: 1, onEvent: (event) => { events.push(event); }});
    expect(provider.calls).toHaveLength(1);
    expect(resumed.pendingInput).toBeUndefined();
    expect(resumed.intentAssessment).toMatchObject({route: 'direct_execute', reasons: ['clarification_resolved']});
    expect(resumed.taskContract?.constraints.join('\n')).toContain('Preserve compatibility');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'needs_input', pending: expect.objectContaining({runId})}),
      expect.objectContaining({type: 'input_resolved', runId}),
    ]));
  });

  it('executes a tool, persists usage, and creates a checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-runner-'));
    roots.push(root);
    const provider = new ScriptedProvider();
    const store = new SessionStore(root);
    const checkpoint = new CheckpointStore(root);
    const runner = new AgentRunner({config: config(root), provider, contextEngine: context, sessionStore: store, checkpointStore: checkpoint});
    const events: string[] = [];
    const session = await runner.run('create result', {
      onEvent: (event) => { events.push(event.type); },
      requestPermission: async () => true,
    });
    expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('done\n');
    expect(session.changedFiles).toContain(join(root, 'result.txt'));
    expect(session.usage.outputTokens).toBe(9);
    expect(events).toContain('tool_start');
    expect(session.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'permission', tool: 'write_file', outcome: 'allow'}),
      expect.objectContaining({type: 'tool', tool: 'write_file', outcome: 'success'}),
    ]));
    const persisted = await store.load(session.id);
    expect(persisted.audit?.length).toBe(session.audit?.length);
    expect(session.tokenLedger).toHaveLength(2);
    expect(session.tokenLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({
        turn: 1,
        inputSource: 'actual',
        outputSource: 'actual',
        estimated: expect.objectContaining({toolResultTokens: 0}),
        retrieval: expect.objectContaining({engine: 'test', discarded: []}),
      }),
      expect.objectContaining({
        turn: 2,
        estimated: expect.objectContaining({toolResultTokens: expect.any(Number)}),
      }),
    ]));
    expect(JSON.stringify(session.tokenLedger)).not.toContain('create result');
    expect(persisted.tokenLedger).toEqual(session.tokenLedger);
    expect((await checkpoint.list(session.id)).length).toBe(1);
  });

  it('refreshes the context provider immediately after reported workspace changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-runner-context-refresh-'));
    roots.push(root);
    const provider = new ScriptedProvider();
    const invalidated: string[][] = [];
    let flushes = 0;
    const refreshingContext: ContextProvider = {
      ...context,
      invalidate(paths) { invalidated.push(paths); },
      async flushDirty() {
        flushes += 1;
        return {status: 'current', generation: 'fresh-generation', paths: 1};
      },
    };
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({config: config(root), provider, contextEngine: refreshingContext});

    await runner.run('create result', {onEvent: (event) => { events.push(event); }});

    expect(invalidated).toEqual([[join(root, 'result.txt')]]);
    expect(flushes).toBe(1);
    const result = events.find((event): event is Extract<AgentEvent, {type: 'tool_result'}> =>
      event.type === 'tool_result' && event.result.name === 'write_file',
    );
    expect(result?.result.metadata).toMatchObject({
      contextRefresh: {status: 'current', generation: 'fresh-generation', paths: 1},
    });
  });

  it('accounts actual and estimated context compaction usage with content-free receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-runner-compaction-usage-'));
    roots.push(root);
    const actualSession = createSession({workspace: root, model: 'test-model', provider: 'compatible'});
    addCompactionHistory(actualSession);
    const actualProvider = new QueueProvider([{
      content: 'Narrative handoff.', toolCalls: [],
      usage: {inputTokens: 120, outputTokens: 18, cachedInputTokens: 12, reasoningTokens: 4},
    }]);
    const actualRunner = new AgentRunner({
      config: config(root), provider: actualProvider, contextEngine: context,
      session: actualSession, persistSession: false,
    });

    const actual = await actualRunner.compactContext();

    expect(actual.receipt).toMatchObject({
      status: 'compacted', inputSource: 'actual', outputSource: 'actual',
      actual: {inputTokens: 120, outputTokens: 18, cachedInputTokens: 12, reasoningTokens: 4},
    });
    expect(actualSession.usage).toMatchObject({
      inputTokens: 120, outputTokens: 18, actualInputTokens: 120, actualOutputTokens: 18,
      actualCachedInputTokens: 12, actualReasoningTokens: 4,
      inputSource: 'actual', outputSource: 'actual', source: 'actual',
    });
    expect(JSON.stringify(actualSession.contextCompactionReceipts)).not.toContain('Narrative handoff');

    const estimatedSession = createSession({workspace: root, model: 'test-model', provider: 'compatible'});
    addCompactionHistory(estimatedSession);
    const estimatedRunner = new AgentRunner({
      config: config(root),
      provider: new QueueProvider([{content: 'Estimated handoff.', toolCalls: []}]),
      contextEngine: context,
      session: estimatedSession,
      persistSession: false,
    });

    const estimated = await estimatedRunner.compactContext();

    expect(estimated.receipt).toMatchObject({inputSource: 'estimated', outputSource: 'estimated'});
    expect(estimatedSession.usage).toMatchObject({
      inputTokens: estimated.receipt.estimated.inputTokens,
      outputTokens: estimated.receipt.estimated.outputTokens,
      estimatedInputTokens: estimated.receipt.estimated.inputTokens,
      estimatedOutputTokens: estimated.receipt.estimated.outputTokens,
      inputSource: 'estimated', outputSource: 'estimated', source: 'estimated',
    });
  });

  it('reports prompt partitions from the post-compaction state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-runner-auto-compaction-prompt-'));
    roots.push(root);
    const session = createSession({workspace: root, model: 'test-model', provider: 'compatible'});
    for (let index = 0; index < 7; index += 1) {
      session.messages.push({
        id: `auto-user-${index}`, role: 'user', content: `request ${index} ${'u'.repeat(8_000)}`,
        createdAt: '2026-07-25T00:00:00.000Z',
      });
      session.messages.push({
        id: `auto-assistant-${index}`, role: 'assistant', content: `response ${index} ${'a'.repeat(8_000)}`,
        createdAt: '2026-07-25T00:00:00.000Z',
      });
    }
    session.taskContract = {
      version: 1, state: 'active', objective: 'Complete the long task.',
      scope: ['workspace'], constraints: [], nonGoals: [],
      acceptanceCriteria: [{
        id: 'done', description: 'Task is complete.', required: true,
        status: 'pending', evidenceRefs: [],
      }],
      verificationRequirements: [],
      createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
    };
    const provider = new QueueProvider([
      {content: 'Compacted narrative.', toolCalls: [], usage: {inputTokens: 100, outputTokens: 10}},
      {content: 'Current response.', toolCalls: [], usage: {inputTokens: 80, outputTokens: 8}},
    ]);
    const events: AgentEvent[] = [];
    const runnerConfig = config(root);
    runnerConfig.agent.maxSessionTokens = 100_000;
    const runner = new AgentRunner({
      config: runnerConfig, provider, contextEngine: context, session, persistSession: false,
    });

    await runner.run('continue the long task', {
      maxTurns: 1,
      onEvent: (event) => { events.push(event); },
    });

    const prompt = events.find((event): event is Extract<AgentEvent, {type: 'prompt'}> =>
      event.type === 'prompt');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'context_compacted'}),
    ]));
    expect(prompt?.sections).toContain('compaction-facts');
    expect(prompt?.sections).toContain('session-summary');
    expect(prompt?.sections).not.toContain('task-contract');
  });

  it('attaches a warning-only reuse receipt to the first substantive write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-runner-reuse-'));
    roots.push(root);
    const helper = join(root, 'helper.ts');
    await writeFile(helper, 'export function parseThing(value: string) { return value.trim(); }\n');
    const provider = new QueueProvider([
      {content: '', toolCalls: [{id: 'reuse-write', name: 'write_file', arguments: {
        path: 'parser.ts', content: 'export function parseThing(value: string) { return value.trim(); }\n',
      }}]},
      {content: 'Done.', toolCalls: []},
    ]);
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({
      config: config(root), provider,
      contextEngine: {
        ...context,
        async search() { return [{path: helper, startLine: 1, endLine: 1, content: 'private', score: 0.9, source: 'local', symbol: 'parseThing'}]; },
        async flushDirty() { return {status: 'current', generation: 'g-runner', paths: 0}; },
      },
    });
    await runner.run('add parser helper', {onEvent: (event) => { events.push(event); }});
    const result = events.find((event): event is Extract<AgentEvent, {type: 'tool_result'}> =>
      event.type === 'tool_result' && event.result.name === 'write_file');
    expect(result?.result.metadata?.reuseReceipt).toMatchObject({decision: 'reuse', warningOnly: true});
    expect(result?.result.content).toContain('Reuse check (warning-only)');
    expect(runner.getSession().audit).toEqual(expect.arrayContaining([
      expect.objectContaining({metadata: expect.objectContaining({reuseReceipt: expect.objectContaining({warningOnly: true})})}),
    ]));
  });

  it('attaches a warning-only post-write duplication receipt before index refresh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-runner-duplicate-'));
    roots.push(root);
    const source = `export function original(input: number[]) {
  const values = [];
  for (const item of input) { if (item > 10) values.push(item * 2); else values.push(item + 1); }
  const total = values.reduce((sum, item) => sum + item, 0);
  if (total < 0) throw new Error('invalid total');
  return {values, total};
}\n`;
    const originalPath = join(root, 'original.ts');
    await writeFile(originalPath, source);
    const extracted = extractFunctionFingerprints(originalPath, source)[0]!;
    const {normalizedTokens: _tokens, ...fingerprint} = extracted;
    const baseline: DuplicationBaseline = {generation: 'g-before', functions: [fingerprint]};
    const provider = new QueueProvider([
      {content: '', toolCalls: [{id: 'duplicate-write', name: 'write_file', arguments: {
        path: 'copy.ts', content: source.replace('original', 'copy').replaceAll('values', 'output').replace('10', '42'),
      }}]},
      {content: 'Done.', toolCalls: []},
    ]);
    let invalidated = false;
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({
      config: config(root), provider,
      contextEngine: {
        ...context,
        async functionFingerprints() { expect(invalidated).toBe(false); return baseline; },
        invalidate() { invalidated = true; },
        async flushDirty() { return {status: 'current', generation: 'g-after', paths: 1}; },
      },
    });
    await runner.run('add copied implementation', {onEvent: (event) => { events.push(event); }});
    const result = events.find((event): event is Extract<AgentEvent, {type: 'tool_result'}> =>
      event.type === 'tool_result' && event.result.name === 'write_file');
    expect(result?.result.metadata?.duplicationAudit).toMatchObject({
      status: 'warning', baselineGeneration: 'g-before', warningOnly: false,
      matches: [{
        matchId: expect.stringMatching(/^[a-f0-9]{24}$/),
        kind: 'type-1-or-2', candidateSymbol: 'original', changedSymbol: 'copy',
      }],
    });
    expect(result?.result.content).toContain('Duplication audit (completion-blocking Type-1/2)');
    expect(runner.getSession().lastRun?.duplication).toMatchObject({
      enforcement: 'blocking', status: 'warning', warningCount: 1,
    });
    expect(provider.seenTools[0]).not.toContain('duplication_audit');
    expect(provider.seenTools[1]).toContain('duplication_audit');
  });

  it('does not emit a duplication receipt or refresh the index after a failed write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-runner-duplicate-failed-'));
    roots.push(root);
    const path = join(root, 'existing.ts');
    await writeFile(path, 'export const existing = true;\n');
    const provider = new QueueProvider([
      {content: '', toolCalls: [{id: 'duplicate-failed-write', name: 'write_file', arguments: {
        path: 'existing.ts', overwrite: false, content: 'export const replacement = true;\n',
      }}]},
      {content: 'The write was rejected.', toolCalls: []},
    ]);
    let baselines = 0;
    let invalidations = 0;
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({
      config: config(root), provider,
      contextEngine: {
        ...context,
        async functionFingerprints() { baselines += 1; return {generation: 'g-before', functions: []}; },
        invalidate() { invalidations += 1; },
      },
    });

    await runner.run('replace without overwrite', {onEvent: (event) => { events.push(event); }});

    const result = events.find((event): event is Extract<AgentEvent, {type: 'tool_result'}> =>
      event.type === 'tool_result' && event.result.name === 'write_file');
    expect(result?.result).toMatchObject({ok: false});
    expect(result?.result.metadata?.duplicationAudit).toBeUndefined();
    expect(await readFile(path, 'utf8')).toBe('export const existing = true;\n');
    expect(baselines).toBe(1);
    expect(invalidations).toBe(0);
  });

  it('marks an auditable write unresolved when the pre-write baseline fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-runner-duplicate-degraded-'));
    roots.push(root);
    const source = `export function created(input: number[]) {
  const values = [];
  for (const item of input) { if (item > 10) values.push(item * 2); else values.push(item + 1); }
  const total = values.reduce((sum, item) => sum + item, 0);
  if (total < 0) throw new Error('private provider detail');
  return {values, total};
}\n`;
    const provider = new QueueProvider([
      {content: '', toolCalls: [{id: 'duplicate-degraded-write', name: 'write_file', arguments: {
        path: 'created.ts', content: source,
      }}]},
      {content: 'Done.', toolCalls: []},
    ]);
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({
      config: config(root), provider,
      contextEngine: {
        ...context,
        async functionFingerprints() { throw new Error('raw index failure'); },
      },
    });
    await runner.run('create implementation', {onEvent: (event) => { events.push(event); }});
    const result = events.find((event): event is Extract<AgentEvent, {type: 'tool_result'}> =>
      event.type === 'tool_result' && event.result.name === 'write_file');
    expect(result?.result.metadata?.duplicationAudit).toMatchObject({
      status: 'unresolved', baselineGeneration: 'unavailable', checkedFunctions: 0,
    });
    expect(JSON.stringify(result?.result.metadata?.duplicationAudit)).not.toContain('raw index failure');
    expect(JSON.stringify(result?.result.metadata?.duplicationAudit)).not.toContain('private provider detail');
  });

  it('does not expose mutation tools in ask mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-ask-'));
    roots.push(root);
    const provider = new ScriptedProvider();
    const runner = new AgentRunner({config: config(root), provider, contextEngine: context});
    const session = await runner.run('inspect only', {askMode: true});
    expect(provider.seenToolCounts[0]).toBe(5);
    expect(session.changedFiles).toHaveLength(0);
  });

  it('keeps task_contract hidden for short executable requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-contract-short-'));
    roots.push(root);
    const provider = new QueueProvider([{content: 'Done.', toolCalls: []}]);
    const runner = new AgentRunner({config: config(root), provider, contextEngine: context});

    const session = await runner.run('create result.txt');

    expect(provider.seenTools[0]).not.toContain('task_contract');
    expect(session.taskContract).toBeUndefined();
  });

  it('does not carry a satisfied Contract into a later short request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-contract-finished-'));
    roots.push(root);
    const session = createSession({workspace: root, model: 'test-model', provider: 'compatible'});
    session.taskContract = {
      version: 1, state: 'satisfied', objective: 'Previous work', scope: ['workspace'],
      constraints: [], nonGoals: [], verificationRequirements: ['npm test'],
      acceptanceCriteria: [{
        id: 'done', description: 'Previous work done', required: true,
        status: 'satisfied', evidenceRefs: ['old-write'],
      }],
      createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T01:00:00.000Z',
    };
    const provider = new QueueProvider([{content: 'Hello.', toolCalls: []}]);
    const runner = new AgentRunner({config: config(root), provider, contextEngine: context, session});

    const completed = await runner.run('hello');

    expect(provider.seenTools[0]).not.toContain('task_contract');
    expect(completed.lastRun).toMatchObject({status: 'no_changes', reason: 'completed'});
    expect(completed.lastRun?.acceptance).toBeUndefined();
  });

  it('rejects a hidden task_contract call remembered from session history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-contract-hidden-call-'));
    roots.push(root);
    const provider = new QueueProvider([
      {content: '', toolCalls: [{id: 'hidden-contract', name: 'task_contract', arguments: {action: 'show'}}]},
      {content: 'Used only visible tools.', toolCalls: []},
    ]);
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({config: config(root), provider, contextEngine: context});

    await runner.run('hello', {onEvent: (event) => { events.push(event); }});

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_result',
        result: expect.objectContaining({
          ok: false,
          content: expect.stringContaining('not exposed for this turn'),
          metadata: expect.objectContaining({
            failure: expect.objectContaining({class: 'unknown_tool'}),
            evidenceReceipt: expect.objectContaining({outcome: 'failure'}),
          }),
        }),
      }),
    ]));
  });

  it('creates a draft Contract and blocks mutation until it is activated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-contract-required-'));
    roots.push(root);
    const provider = new QueueProvider([
      {
        content: '',
        toolCalls: [{
          id: 'write-before-contract', name: 'write_file',
          arguments: {path: 'result.txt', content: 'unsafe\n'},
        }],
      },
      {content: 'Blocked.', toolCalls: []},
      {content: 'Still blocked.', toolCalls: []},
    ]);
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({config: config(root), provider, contextEngine: context});
    const request = 'Refactor the command runtime across the provider, session, and UI modules; preserve backward compatibility; add deterministic tests; verify typecheck and build; and keep unrelated files unchanged.';

    const session = await runner.run(request, {onEvent: (event) => { events.push(event); }});

    await expect(readFile(join(root, 'result.txt'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    expect(provider.seenTools[0]).toContain('task_contract');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'contract', contract: expect.objectContaining({state: 'draft'})}),
      expect.objectContaining({
        type: 'tool_result',
        result: expect.objectContaining({
          ok: false,
          metadata: expect.objectContaining({
            failure: expect.objectContaining({class: 'contract_required'}),
            evidenceReceipt: expect.objectContaining({outcome: 'failure'}),
          }),
        }),
      }),
    ]));
    expect(session.taskContract?.state).toBe('draft');
    expect(session.lastRun).toMatchObject({status: 'unverified', acceptance: {pending: 2}});
  });

  it('activates a Contract, records real evidence, and completes accepted work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-contract-complete-'));
    roots.push(root);
    const provider = new QueueProvider([
      {content: '', toolCalls: [{id: 'activate', name: 'task_contract', arguments: {action: 'activate'}}]},
      {content: '', toolCalls: [{
        id: 'write-contract-result', name: 'write_file',
        arguments: {path: 'result.txt', content: 'done\n'},
      }]},
      {content: '', toolCalls: [{
        id: 'verify-contract-result', name: 'shell',
        arguments: {command: 'node --test'},
      }]},
      {content: '', toolCalls: [
        {id: 'accept-outcome', name: 'task_contract', arguments: {
          action: 'update_criterion', id: 'requested-outcome-fixed', status: 'satisfied',
          evidence_refs: ['write-contract-result'],
        }},
        {id: 'accept-verification', name: 'task_contract', arguments: {
          action: 'update_criterion', id: 'verification-fixed', status: 'satisfied',
          evidence_refs: ['verify-contract-result'],
        }},
      ]},
      {content: 'Accepted and verified.', toolCalls: []},
    ]);
    const runnerConfig = config(root);
    runnerConfig.agent.maxTurns = 6;
    runnerConfig.agent.maxSessionTokens = 100_000;
    runnerConfig.permissions.shell = 'allow';
    runnerConfig.permissions.network = 'allow';
    const session = createSession({workspace: root, model: 'test-model', provider: 'compatible'});
    session.taskContract = {
      version: 1,
      state: 'draft',
      objective: 'Implement a verified cross-module change',
      scope: ['workspace'],
      constraints: [],
      nonGoals: [],
      acceptanceCriteria: [
        {id: 'requested-outcome-fixed', description: 'Implement outcome', required: true, status: 'pending', evidenceRefs: []},
        {id: 'verification-fixed', description: 'Verify outcome', required: true, status: 'pending', evidenceRefs: []},
      ],
      verificationRequirements: ['node --test'],
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    };
    const runner = new AgentRunner({config: runnerConfig, provider, contextEngine: context, session});

    const completed = await runner.run('Continue the active complex implementation and finish every required acceptance criterion with deterministic evidence.');

    expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('done\n');
    expect(completed.taskContract?.state).toBe('satisfied');
    expect(completed.lastRun).toMatchObject({
      status: 'verified',
      acceptance: {pending: 0, blocked: 0, satisfied: 2},
    });
  });

  it('rejects forged Contract evidence and keeps acceptance pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-contract-forged-'));
    roots.push(root);
    const session = createSession({workspace: root, model: 'test-model', provider: 'compatible'});
    session.taskContract = {
      version: 1, state: 'active', objective: 'Verified work', scope: ['workspace'],
      constraints: [], nonGoals: [], verificationRequirements: [],
      acceptanceCriteria: [{
        id: 'criterion-1', description: 'Real evidence', required: true,
        status: 'pending', evidenceRefs: [],
      }],
      createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
    };
    const provider = new QueueProvider([
      {content: '', toolCalls: [{id: 'forge', name: 'task_contract', arguments: {
        action: 'update_criterion', id: 'criterion-1', status: 'satisfied',
        evidence_refs: ['invented-tool-result'],
      }}]},
      {content: 'Unable to prove acceptance.', toolCalls: []},
      {content: 'Still unable to prove acceptance.', toolCalls: []},
    ]);
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({config: config(root), provider, contextEngine: context, session});

    const completed = await runner.run('Continue the active contract and complete it with valid evidence.', {
      onEvent: (event) => { events.push(event); },
    });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_result',
        result: expect.objectContaining({ok: false, content: expect.stringContaining('Unknown or unsuccessful evidence refs')}),
      }),
    ]));
    expect(completed.taskContract?.acceptanceCriteria[0]?.status).toBe('pending');
    expect(completed.lastRun).toMatchObject({status: 'unverified', acceptance: {pending: 1}});
  });

  it('injects steering received while a provider response is in flight', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-steering-'));
    roots.push(root);
    const provider = new SteeringProvider();
    const runner = new AgentRunner({config: config(root), provider, contextEngine: context});
    const run = runner.run('inspect the current implementation');
    await provider.started;
    expect(runner.steer('Focus on the permission boundary instead.')).toBe(true);
    provider.release();
    const session = await run;
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.some((message) =>
      message.role === 'user' && message.content.includes('Focus on the permission boundary'))).toBe(true);
    expect(session.messages.at(-1)?.content).toBe('Adjusted direction.');
    expect(runner.steer('too late')).toBe(false);
  });

  it('emits transient assistant deltas while persisting only the completed response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-streaming-'));
    roots.push(root);
    const runner = new AgentRunner({config: config(root), provider: new StreamingProvider(), contextEngine: context});
    const events: AgentEvent[] = [];

    const session = await runner.run('stream a response', {onEvent: (event) => { events.push(event); }});

    expect(events.filter((event) => event.type === 'assistant_delta').map((event) =>
      event.type === 'assistant_delta' ? event.content : '',
    )).toEqual(['Streaming ', 'works.']);
    const completed = events.find((event) => event.type === 'assistant');
    expect(completed).toMatchObject({type: 'assistant', content: 'Streaming works.'});
    expect(session.messages.filter((message) => message.role === 'assistant')).toEqual([
      expect.objectContaining({content: 'Streaming works.'}),
    ]);
    expect(session.usage).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      source: 'actual',
      inputSource: 'actual',
      outputSource: 'actual',
      actualInputTokens: 3,
      actualOutputTokens: 2,
    });
  });

  it('marks provider usage actual and exposes content-free prompt partitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-usage-actual-'));
    roots.push(root);
    const provider = new QueueProvider([{
      content: 'Done.', toolCalls: [], usage: {
        inputTokens: 17,
        outputTokens: 4,
        cachedInputTokens: 9,
        cacheWriteInputTokens: 2,
        reasoningTokens: 3,
      },
    }]);
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({config: config(root), provider, contextEngine: context});

    const session = await runner.run('explain src/parser.ts', {
      onEvent: (event) => { events.push(event); },
    });

    expect(session.usage).toMatchObject({
      inputTokens: 17, outputTokens: 4, source: 'actual',
      inputSource: 'actual', outputSource: 'actual',
      actualInputTokens: 17, actualOutputTokens: 4,
      actualCachedInputTokens: 9, actualCacheWriteInputTokens: 2, actualReasoningTokens: 3,
    });
    const prompt = events.find((event) => event.type === 'prompt');
    expect(prompt).toMatchObject({
      type: 'prompt',
      breakdown: {
        stableTokens: expect.any(Number), dynamicTokens: expect.any(Number),
        conversationTokens: expect.any(Number), retrievedTokens: expect.any(Number),
        toolSchemaTokens: expect.any(Number), estimatedInputTokens: expect.any(Number),
        outputAllowanceTokens: expect.any(Number),
      },
    });
    expect(JSON.stringify(prompt)).not.toContain('explain src/parser.ts');
    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      type: 'usage',
      receipt: {
        inputSource: 'actual', outputSource: 'actual',
        actual: {
          inputTokens: 17,
          outputTokens: 4,
          cachedInputTokens: 9,
          cacheWriteInputTokens: 2,
          reasoningTokens: 3,
        },
        estimated: expect.objectContaining({toolResultTokens: expect.any(Number)}),
      },
    });
    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      type: 'usage',
      actual: {cachedInputTokens: 9, cacheWriteInputTokens: 2, reasoningTokens: 3},
    });
  });

  it('marks missing provider usage estimated instead of actual', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-usage-estimated-'));
    roots.push(root);
    const provider = new QueueProvider([{content: 'Done.', toolCalls: []}]);
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({config: config(root), provider, contextEngine: context});

    const session = await runner.run('explain the parser', {
      onEvent: (event) => { events.push(event); },
    });

    expect(session.usage).toMatchObject({
      source: 'estimated', inputSource: 'estimated', outputSource: 'estimated',
      estimatedInputTokens: expect.any(Number), estimatedOutputTokens: expect.any(Number),
    });
    expect(session.usage.actualInputTokens).toBeUndefined();
    expect(session.usage.actualOutputTokens).toBeUndefined();
    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      type: 'usage', source: 'estimated', inputSource: 'estimated', outputSource: 'estimated',
    });
  });

  it('marks partial provider usage mixed and preserves legacy unknown totals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-usage-mixed-'));
    roots.push(root);
    const session = createSession({workspace: root, model: 'test-model', provider: 'compatible'});
    session.usage = {inputTokens: 30, outputTokens: 5};
    const provider = new QueueProvider([{
      content: 'Done.', toolCalls: [], usage: {inputTokens: 7},
    }]);
    const runner = new AgentRunner({config: config(root), provider, contextEngine: context, session});

    const completed = await runner.run('explain the parser');

    expect(completed.usage).toMatchObject({
      source: 'mixed', inputSource: 'mixed', outputSource: 'mixed',
      actualInputTokens: 7, estimatedOutputTokens: expect.any(Number),
    });
    expect(completed.usage.inputTokens).toBe(37);
    expect(completed.usage.outputTokens).toBeGreaterThan(5);
  });

  it('turns malformed permission arguments into a tool result and continues', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-invalid-tool-'));
    roots.push(root);
    const provider = new QueueProvider([
      {
        content: '',
        toolCalls: [{id: 'bad-shell', name: 'shell', arguments: {}}],
      },
      {content: 'Recovered after invalid arguments.', toolCalls: []},
    ]);
    const toolResults: ToolResult[] = [];
    const runner = new AgentRunner({config: config(root), provider, contextEngine: context});
    const session = await runner.run('run a command', {
      onEvent: (event) => {
        if (event.type === 'tool_result') toolResults.push(event.result);
      },
    });
    expect(provider.calls).toHaveLength(2);
    expect(toolResults[0]).toMatchObject({
      toolCallId: 'bad-shell',
      name: 'shell',
      ok: false,
    });
    expect(toolResults[0]?.content).toContain('Invalid tool arguments');
    expect(session.messages.at(-1)?.content).toBe('Recovered after invalid arguments.');
  });

  it('opens the identical-call circuit before a third malformed tool execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-identical-tool-circuit-'));
    roots.push(root);
    const malformed = {name: 'write_file', arguments: {path: 'missing-content.txt'}};
    const provider = new QueueProvider([
      {content: '', toolCalls: [{id: 'bad-one', ...malformed}]},
      {content: '', toolCalls: [{id: 'bad-two', ...malformed}]},
      {content: '', toolCalls: [{id: 'bad-three', ...malformed}]},
      {content: 'Stopped retrying the identical call.', toolCalls: []},
    ]);
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({config: config(root), provider, contextEngine: context});

    await runner.run('write a file', {onEvent: (event) => { events.push(event); }});

    expect(events.filter((event) => event.type === 'tool_start')).toHaveLength(2);
    const failures = events.filter((event): event is Extract<AgentEvent, {type: 'tool_result'}> =>
      event.type === 'tool_result',
    );
    expect(failures).toHaveLength(3);
    expect(failures[1]?.result.metadata).toMatchObject({
      failure: {class: 'schema_input', attempt: 2, circuitOpen: true},
    });
    expect(failures[2]?.result.content).toContain('rejected by the recovery circuit');
    expect(failures[2]?.result.content.startsWith('Failure: schema_input')).toBe(true);
  });

  it('opens the no-progress circuit before a third identical empty search', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-empty-search-circuit-'));
    roots.push(root);
    const search = {name: 'search_code', arguments: {query: 'definitely-missing', path: '.'}};
    const provider = new QueueProvider([
      {content: '', toolCalls: [{id: 'search-one', ...search}]},
      {content: '', toolCalls: [{id: 'search-two', ...search}]},
      {content: '', toolCalls: [{id: 'search-three', ...search}]},
      {content: 'No matching evidence exists.', toolCalls: []},
    ]);
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({config: config(root), provider, contextEngine: context});

    await runner.run('find definitely-missing', {onEvent: (event) => { events.push(event); }});

    expect(events.filter((event) => event.type === 'tool_start')).toHaveLength(2);
    const failures = events.filter((event): event is Extract<AgentEvent, {type: 'tool_result'}> =>
      event.type === 'tool_result' && !event.result.ok,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.result.metadata).toMatchObject({
      failure: {class: 'no_progress', circuitOpen: true, retryable: false},
    });
  });

  it('allows a corrected retry after a schema failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-corrected-tool-retry-'));
    roots.push(root);
    const provider = new QueueProvider([
      {content: '', toolCalls: [{
        id: 'invalid-write', name: 'write_file', arguments: {path: 'result.txt'},
      }]},
      {content: '', toolCalls: [{
        id: 'corrected-write', name: 'write_file',
        arguments: {path: 'result.txt', content: 'corrected\n'},
      }]},
      {content: 'Corrected.', toolCalls: []},
    ]);
    const runner = new AgentRunner({config: config(root), provider, contextEngine: context});

    await runner.run('write result.txt');

    expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('corrected\n');
  });

  it('does not execute a tool after its permission request is aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-abort-tool-'));
    roots.push(root);
    const provider = new QueueProvider([{
      content: '',
      toolCalls: [{
        id: 'write-after-abort',
        name: 'write_file',
        arguments: {path: 'should-not-exist.txt', content: 'unsafe'},
      }],
    }]);
    const runnerConfig = config(root);
    runnerConfig.permissions.write = 'ask';
    const controller = new AbortController();
    const runner = new AgentRunner({config: runnerConfig, provider, contextEngine: context});
    const session = await runner.run('write a file', {
      signal: controller.signal,
      requestPermission: async () => {
        controller.abort();
        return true;
      },
    });
    await expect(readFile(join(root, 'should-not-exist.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(session.messages.some((message) => message.role === 'tool')).toBe(false);
  });

  it('reuses a session approval only for the same tool resource', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-session-approval-'));
    roots.push(root);
    const provider = new QueueProvider([
      {
        content: '',
        toolCalls: [
          {id: 'write-one', name: 'write_file', arguments: {path: 'shared.txt', content: 'one\n'}},
          {id: 'write-two', name: 'write_file', arguments: {path: 'shared.txt', content: 'two\n'}},
        ],
      },
      {content: 'Both writes completed.', toolCalls: []},
    ]);
    const runnerConfig = config(root);
    runnerConfig.permissions.write = 'ask';
    let requests = 0;
    const runner = new AgentRunner({config: runnerConfig, provider, contextEngine: context});
    const session = await runner.run('write the file twice', {
      requestPermission: async () => {
        requests += 1;
        return 'session';
      },
    });
    expect(requests).toBe(1);
    expect(await readFile(join(root, 'shared.txt'), 'utf8')).toBe('two\n');
    expect(session.audit?.filter((event) =>
      event.type === 'permission' && event.reason === 'Approved for this session.')).toHaveLength(2);
  });

  it('marks non-zero shell exits as failed tool results without aborting the turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-shell-result-'));
    roots.push(root);
    const provider = new QueueProvider([
      {
        content: '',
        toolCalls: [{
          id: 'failed-shell',
          name: 'shell',
          arguments: {command: 'node -e "process.exit(3)"'},
        }],
      },
      {content: 'The command failed as expected.', toolCalls: []},
    ]);
    const runnerConfig = config(root);
    runnerConfig.permissions.shell = 'allow';
    const results: ToolResult[] = [];
    const runner = new AgentRunner({config: runnerConfig, provider, contextEngine: context});
    await runner.run('run the check', {
      onEvent: (event) => {
        if (event.type === 'tool_result') results.push(event.result);
      },
    });
    expect(results[0]).toMatchObject({name: 'shell', ok: false});
    expect(provider.calls).toHaveLength(2);
  });

  it('runs automatic verification when an already changed file is modified again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-repeat-change-'));
    roots.push(root);
    const path = join(root, 'existing.txt');
    await writeFile(path, 'before\n');
    const session = createSession({
      workspace: root,
      model: 'test-model',
      provider: 'compatible',
    });
    session.changedFiles.push(path);
    const provider = new QueueProvider([
      {
        content: 'Updating the existing file.',
        toolCalls: [{
          id: 'repeat-write',
          name: 'write_file',
          arguments: {path: 'existing.txt', content: 'after\n'},
        }],
      },
      {content: 'I will verify this change.', toolCalls: []},
      {content: 'Verified.', toolCalls: []},
    ]);
    const runnerConfig = config(root);
    runnerConfig.agent.autoVerify = true;
    runnerConfig.agent.verifyCommands = ['node -e "process.stdout.write(\'verified\')"'];
    runnerConfig.permissions.shell = 'allow';
    runnerConfig.permissions.network = 'allow';
    const runner = new AgentRunner({
      config: runnerConfig,
      provider,
      contextEngine: context,
      session,
    });
    await runner.run('update existing file');
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[2]?.some((message) =>
      message.content.includes('<automatic-verification>'))).toBe(true);
    expect(runner.getSession().lastRun).toMatchObject({status: 'verified', reason: 'completed'});
  });

  it('gives an unverified medium model one bounded recovery turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-completion-recovery-'));
    roots.push(root);
    const provider = new QueueProvider([
      {
        content: 'Writing the requested file.',
        toolCalls: [{
          id: 'write-before-gate',
          name: 'write_file',
          arguments: {path: 'result.txt', content: 'done\n'},
        }],
      },
      {content: 'Done.', toolCalls: []},
      {
        content: 'Running a focused check.',
        toolCalls: [{id: 'verify-after-gate', name: 'shell', arguments: {command: 'node --test'}}],
      },
      {content: 'The focused check passed.', toolCalls: []},
    ]);
    const runnerConfig = config(root);
    runnerConfig.agent.autoVerify = true;
    runnerConfig.permissions = {
      ...runnerConfig.permissions,
      shell: 'allow', write: 'allow', network: 'allow',
    };
    const events: AgentEvent[] = [];
    const store = new SessionStore(root);
    const runner = new AgentRunner({config: runnerConfig, provider, contextEngine: context, sessionStore: store});

    const session = await runner.run('create and verify result', {
      onEvent: (event) => { events.push(event); },
    });

    expect(provider.calls).toHaveLength(4);
    expect(provider.calls[2]?.some((item) => item.content.includes('<runtime-completion-gate'))).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      reason: 'completed',
      completion: {status: 'verified', checks: [expect.objectContaining({toolCallId: 'verify-after-gate'})]},
    });
    expect(session.lastRun).toMatchObject({status: 'verified', reason: 'completed'});
    expect((await store.load(session.id)).lastRun).toEqual(session.lastRun);
  });

  it('reports unverified when the model ignores the bounded recovery directive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-completion-unverified-'));
    roots.push(root);
    const provider = new QueueProvider([
      {
        content: '',
        toolCalls: [{id: 'write-unverified', name: 'write_file', arguments: {path: 'result.txt', content: 'done\n'}}],
      },
      {content: 'Completed and verified.', toolCalls: []},
      {content: 'Still completed and verified.', toolCalls: []},
    ]);
    const runnerConfig = config(root);
    runnerConfig.agent.autoVerify = true;
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({config: runnerConfig, provider, contextEngine: context});

    const session = await runner.run('create result without skipping verification', {
      onEvent: (event) => { events.push(event); },
    });

    expect(provider.calls).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      reason: 'unverified',
      completion: {status: 'unverified', checks: []},
    });
    expect(session.lastRun).toMatchObject({status: 'unverified', reason: 'unverified'});
  });

  it('persists completion state when the provider fails after a partial change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-completion-provider-error-'));
    roots.push(root);
    const provider = new QueueProvider([{
      content: '',
      toolCalls: [{id: 'write-before-provider-error', name: 'write_file', arguments: {path: 'partial.txt', content: 'partial\n'}}],
    }]);
    const runnerConfig = config(root);
    const store = new SessionStore(root);
    const runner = new AgentRunner({config: runnerConfig, provider, contextEngine: context, sessionStore: store});

    await expect(runner.run('write then fail')).rejects.toThrow('No scripted response remaining.');

    const session = runner.getSession();
    expect(session.lastRun).toMatchObject({
      status: 'unverified',
      reason: 'error',
      changedFiles: [join(root, 'partial.txt')],
    });
    expect((await store.load(session.id)).lastRun).toEqual(session.lastRun);
  });

  it('does not let a later summary hide failed current verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-completion-failed-'));
    roots.push(root);
    const provider = new QueueProvider([
      {
        content: '',
        toolCalls: [{id: 'write-before-failure', name: 'write_file', arguments: {path: 'result.txt', content: 'done\n'}}],
      },
      {content: 'Done.', toolCalls: []},
      {
        content: '',
        toolCalls: [{
          id: 'failed-verification',
          name: 'shell',
          arguments: {command: 'node --test missing.test.js'},
        }],
      },
      {content: 'Everything passed.', toolCalls: []},
    ]);
    const runnerConfig = config(root);
    runnerConfig.agent.autoVerify = true;
    runnerConfig.permissions = {
      ...runnerConfig.permissions,
      shell: 'allow', write: 'allow', network: 'allow',
    };
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({config: runnerConfig, provider, contextEngine: context});

    const session = await runner.run('create result and verify it', {
      onEvent: (event) => { events.push(event); },
    });

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      reason: 'verification_failed',
      completion: {
        status: 'verification_failed',
        checks: [expect.objectContaining({toolCallId: 'failed-verification', ok: false})],
      },
    });
    expect(session.lastRun).toMatchObject({status: 'verification_failed', reason: 'verification_failed'});
  });

  it('passes failed configured verification locations to the current-run context provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-runner-diagnostics-'));
    roots.push(root);
    const command = 'node -e "console.error(\'diagnostic.ts:1:1: error forced\'); process.exit(1)"';
    const provider = new QueueProvider([
      {
        content: '',
        toolCalls: [{id: 'write-diagnostic', name: 'write_file', arguments: {
          path: 'diagnostic.ts', content: 'export const diagnostic = true;\n',
        }}],
      },
      {
        content: '',
        toolCalls: [{id: 'failed-configured-verification', name: 'shell', arguments: {command}}],
      },
      {content: 'The verification failed.', toolCalls: []},
    ]);
    const runnerConfig = config(root);
    runnerConfig.agent.verifyCommands = [command];
    runnerConfig.permissions = {
      ...runnerConfig.permissions,
      shell: 'allow', write: 'allow', network: 'allow',
    };
    const updates: Array<{commandKey: string; paths: string[]}> = [];
    let resets = 0;
    const diagnosticContext: ContextProvider = {
      ...context,
      resetDiagnostics() { resets += 1; },
      recordDiagnostics(update) { updates.push(update); },
    };
    const runner = new AgentRunner({config: runnerConfig, provider, contextEngine: diagnosticContext});

    const session = await runner.run('create and verify diagnostic evidence');

    expect(resets).toBe(1);
    expect(session.lastRun).toMatchObject({status: 'verification_failed'});
    expect(updates).toEqual([expect.objectContaining({
      paths: [join(root, 'diagnostic.ts')],
    })]);
  });

  it('accepts one verification after a multi-file edit batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-completion-multifile-'));
    roots.push(root);
    const provider = new QueueProvider([
      {
        content: '',
        toolCalls: [{
          id: 'write-two-files',
          name: 'apply_patch',
          arguments: {patch: '*** Begin Patch\n*** Add File: one.txt\n+one\n*** Add File: two.txt\n+two\n*** End Patch'},
        }],
      },
      {
        content: '',
        toolCalls: [{id: 'verify-two-files', name: 'shell', arguments: {command: 'node --test'}}],
      },
      {content: 'Verified both files.', toolCalls: []},
    ]);
    const runnerConfig = config(root);
    runnerConfig.agent.autoVerify = true;
    runnerConfig.permissions = {
      ...runnerConfig.permissions,
      shell: 'allow', write: 'allow', network: 'allow',
    };
    const runner = new AgentRunner({config: runnerConfig, provider, contextEngine: context});

    const session = await runner.run('create and verify two files');

    expect(session.lastRun).toMatchObject({
      status: 'verified',
      changedFiles: expect.arrayContaining([join(root, 'one.txt'), join(root, 'two.txt')]),
      checks: [expect.objectContaining({toolCallId: 'verify-two-files'})],
    });
  });

  it('does not execute returned mutations after a provider overshoots the token budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-budget-overshoot-'));
    roots.push(root);
    const provider = new QueueProvider([{
      content: 'I need to write this file.',
      toolCalls: [{
        id: 'over-budget-write',
        name: 'write_file',
        arguments: {path: 'must-not-exist.txt', content: 'blocked'},
      }],
      usage: {inputTokens: 9_500, outputTokens: 1_000},
    }]);
    const events: ToolResult[] = [];
    const runnerConfig = config(root);
    runnerConfig.agent.maxSessionTokens = 10_000;
    const runner = new AgentRunner({config: runnerConfig, provider, contextEngine: context});
    const session = await runner.run('write a file', {
      onEvent: (event) => {
        if (event.type === 'tool_result') events.push(event.result);
      },
    });
    await expect(readFile(join(root, 'must-not-exist.txt'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    expect(events[0]?.content).toContain('token budget');
    expect(events[0]?.metadata).toMatchObject({
      evidenceReceipt: {toolCallId: 'over-budget-write', tool: 'write_file', outcome: 'failure'},
    });
    expect(session.messages.at(-1)?.role).toBe('tool');
    expect(session.usage.inputTokens + session.usage.outputTokens).toBe(10_500);
  });
});
