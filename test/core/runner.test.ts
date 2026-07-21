import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {AgentRunner} from '../../src/agent/runner.js';
import {createSession, SessionStore} from '../../src/session/store.js';
import {CheckpointStore} from '../../src/checkpoint/store.js';
import type {ContextProvider} from '../../src/tools/types.js';
import type {ModelProvider} from '../../src/providers/provider.js';
import type {AgentEvent, ChatMessage, MosaicConfig, ModelResponse, ToolResult} from '../../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

function config(root: string): MosaicConfig {
  return {
    model: {provider: 'compatible', model: 'test-model', apiKey: 'test'},
    workspaceRoots: [root],
    context: {engine: 'local', maxTokens: 2_000, topK: 4, contextEngineCommand: 'missing'},
    permissions: {
      read: 'allow', write: 'allow', shell: 'deny', git: 'deny', network: 'deny',
      allowCommands: [], denyCommands: [],
    },
    hooks: {},
    agent: {maxTurns: 4, maxSessionTokens: 10_000, autoVerify: false, verifyCommands: [], checkpointBeforeWrite: true},
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

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(messages: ChatMessage[]): Promise<ModelResponse> {
    this.calls.push(messages);
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

describe('AgentRunner', () => {
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
    expect((await store.load(session.id)).audit?.length).toBe(session.audit?.length);
    expect((await checkpoint.list(session.id)).length).toBe(1);
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
    expect(session.usage).toEqual({inputTokens: 3, outputTokens: 2});
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
    expect(session.messages.at(-1)?.role).toBe('tool');
    expect(session.usage.inputTokens + session.usage.outputTokens).toBe(10_500);
  });
});
