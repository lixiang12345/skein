import {createHash} from 'node:crypto';
import {mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {AgentRunner} from '../../src/agent/runner.js';
import {dynamicToolOutputBudget, estimateToolOutputTokens, protectToolOutput} from '../../src/agent/tool-output.js';
import type {ModelProvider} from '../../src/providers/provider.js';
import {ToolArtifactStore} from '../../src/session/tool-artifacts.js';
import {ToolRegistry} from '../../src/tools/registry.js';
import {readToolArtifactTool} from '../../src/tools/read-artifact.js';
import type {AgentTool, ContextProvider} from '../../src/tools/types.js';
import type {AgentEvent, ChatMessage, MosaicConfig, ModelResponse} from '../../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

const context: ContextProvider = {
  async pack() { return {text: '', hits: [], estimatedTokens: 0, engine: 'test', truncated: false}; },
  async search() { return []; },
};

describe('tool output firewall', () => {
  it('uses a CJK-aware estimate and derives bounded dynamic budgets', () => {
    expect(estimateToolOutputTokens('x'.repeat(400))).toBe(100);
    expect(estimateToolOutputTokens('中'.repeat(400))).toBe(400);
    expect(estimateToolOutputTokens('🙂'.repeat(400))).toBe(800);
    expect(estimateToolOutputTokens('é'.repeat(400))).toBe(800);
    expect(dynamicToolOutputBudget(24_000, 2_000, 100_000)).toBe(7_699);
    expect(dynamicToolOutputBudget(24_000, 23_900, 1_500)).toBe(1_024);
  });

  it('retains oversize failures with head/tail evidence and redacts credentials', async () => {
    const root = await workspace('skein-tool-output-receipt-');
    const artifacts = new ToolArtifactStore(root);
    const content = [
      'Command: npm test',
      'Exit code: 2',
      'api_key=sk-abcdefghijklmnopqrstuvwxyz123456',
      ...Array.from({length: 8_000}, (_, index) => `log line ${index}`),
      'FINAL FAILURE: integration test still fails',
    ].join('\n');
    const output = await protectToolOutput({
      content,
      sessionId: 'session-1',
      toolCallId: 'failed-test',
      tool: 'shell',
      ok: false,
      budgetTokens: 1_024,
      metadata: {
        exitCode: 2,
        sourceTruncated: true,
        changedFiles: ['/workspace/one.ts', '/workspace/two.ts'],
        failure: {
          class: 'command_exit', retryable: true, repairHint: 'Inspect output.',
          attempt: 1, remaining: 2, circuitOpen: false, signature: 'abc',
        },
      },
      artifacts,
    });

    expect(output.metadata).toMatchObject({truncated: true, redacted: true, artifact: {toolCallId: 'failed-test'}});
    expect(estimateToolOutputTokens(output.content)).toBeLessThanOrEqual(1_024);
    expect(output.content).toContain('exit-code: 2');
    expect(output.content).toContain('source-truncated: true');
    expect(output.content).toContain('changed-files: /workspace/one.ts, /workspace/two.ts');
    expect(output.content).toContain('FINAL FAILURE: integration test still fails');
    expect(output.content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    const retained = await artifacts.read('session-1', 'failed-test', {maxLines: 20});
    expect(retained.content).toContain('api_key=[redacted-secret]');
    expect(retained.content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });

  it('keeps the receipt inside its hard token budget with maximal ids and metadata', async () => {
    const root = await workspace('skein-tool-output-budget-');
    const output = await protectToolOutput({
      content: 'x'.repeat(100_000),
      sessionId: 'session-1',
      toolCallId: '调'.repeat(512),
      tool: `mcp_${'t'.repeat(60)}`,
      ok: false,
      budgetTokens: 1_024,
      metadata: {
        changedFiles: [
          `/workspace/${'甲'.repeat(500)}`,
          `/workspace/${'乙'.repeat(500)}`,
          `/workspace/${'丙'.repeat(500)}`,
        ],
        failure: {
          class: 'execution', retryable: true, repairHint: 'Inspect output.',
          attempt: 1, remaining: 2, circuitOpen: false, signature: 'abc',
        },
      },
      artifacts: new ToolArtifactStore(root),
    });

    expect(estimateToolOutputTokens(output.content)).toBeLessThanOrEqual(1_024);
    expect(output.content).toContain('read_tool_artifact');
    expect(output.content).toContain('changed-files:');
    expect(output.content).toContain('tool-call-id:');
    expect(output.content).toContain('…');
  });

  it('preserves ordinary source-code token variables and strips terminal controls', async () => {
    const root = await workspace('skein-tool-output-source-');
    const content = '\u001b[31mconst token = process.env.AUTH_TOKEN;\u001b[0m\nconst secret = buildSecret();';
    const output = await protectToolOutput({
      content,
      sessionId: 'session-1', toolCallId: 'source-read', tool: 'read_file', ok: true,
      budgetTokens: 2_000, metadata: {}, artifacts: new ToolArtifactStore(root),
    });

    expect(output.content).toBe('const token = process.env.AUTH_TOKEN;\nconst secret = buildSecret();');
    expect(output.metadata).toMatchObject({truncated: false, redacted: false, sanitized: true});
  });

  it('routes an oversized result through the runner and allows only its session to read it back', async () => {
    const root = await workspace('skein-tool-output-runner-');
    const largeContent = [
      'FIRST: source scan',
      'token=sk-abcdefghijklmnopqrstuvwxyz123456',
      ...Array.from({length: 8_000}, (_, index) => `line ${index} ${'x'.repeat(12)}`),
      'LAST: relevant failure at end of result',
    ].join('\n');
    const retainedContent = largeContent.replace('sk-abcdefghijklmnopqrstuvwxyz123456', '[redacted-secret]');
    const retainedSha = createHash('sha256').update(retainedContent).digest('hex');
    const largeTool: AgentTool = {
      definition: {
        name: 'large_result', description: 'Returns a deliberately large read-only result.', category: 'read',
        inputSchema: {type: 'object', properties: {}, additionalProperties: false},
      },
      async execute() {
        return {content: largeContent};
      },
    };
    const provider = new QueueProvider([
      {content: '', toolCalls: [{id: 'large-call', name: 'large_result', arguments: {}}]},
      {content: '', toolCalls: [{id: 'read-call', name: 'read_tool_artifact', arguments: {sha256: retainedSha, max_lines: 3}}]},
      {content: 'Done.', toolCalls: []},
    ]);
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({
      config: runnerConfig(root),
      provider,
      contextEngine: context,
      toolRegistry: new ToolRegistry([largeTool, readToolArtifactTool]),
      toolArtifactStore: new ToolArtifactStore(root),
    });

    const session = await runner.run('inspect the large result', {
      onEvent: (event) => { events.push(event); },
    });
    const firstResult = events.find((event): event is Extract<AgentEvent, {type: 'tool_result'}> =>
      event.type === 'tool_result' && event.result.toolCallId === 'large-call',
    )?.result;
    const readResult = events.find((event): event is Extract<AgentEvent, {type: 'tool_result'}> =>
      event.type === 'tool_result' && event.result.toolCallId === 'read-call',
    )?.result;

    expect(firstResult?.content).toContain('LAST: relevant failure at end of result');
    expect(firstResult?.content).toContain('read_tool_artifact');
    expect(firstResult?.content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(firstResult?.metadata).toMatchObject({toolOutput: {truncated: true, artifact: {toolCallId: 'large-call'}}});
    expect(readResult?.content).toContain('token=[redacted-secret]');
    expect(provider.calls[1]?.some((message) => message.role === 'tool' && message.content.includes('sk-abcdefghijklmnopqrstuvwxyz123456'))).toBe(false);
    await expect(new ToolArtifactStore(root).read('other-session', 'large-call')).rejects.toThrow('No retained tool output');
    expect(session.messages.some((message) => message.toolCallId === 'read-call')).toBe(true);
  });

  it('rejects a guessed tool-call id even when a matching file exists on disk', async () => {
    const root = await workspace('skein-tool-output-guessed-');
    const store = new ToolArtifactStore(root);
    await store.archive('session-1', 'secret-call', 'private output', {redacted: false});
    const tool = readToolArtifactTool;

    await expect(tool.execute({sha256: 'a'.repeat(64)}, {
      config: runnerConfig(root),
      workspace: {primaryRoot: root} as never,
      session: {
        id: 'session-1', toolArtifacts: [],
      } as never,
      toolArtifactStore: store,
    })).rejects.toThrow('current session');
  });

  it('reconciles persisted receipts with live session artifacts before exposing readback', async () => {
    const root = await workspace('skein-tool-output-reconcile-');
    const artifacts = new ToolArtifactStore(root);
    const archived = await artifacts.archive('session-1', 'live-call', 'retained output', {redacted: false});
    if (!archived.stored) throw new Error('Expected test artifact to be retained.');
    const session = {
      id: 'session-1', title: 'Resume', workspace: root,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      model: 'test', provider: 'compatible' as const, messages: [], tasks: [], changedFiles: [], audit: [],
      toolArtifacts: [
        {...archived.artifact, redacted: false},
        {toolCallId: 'missing-call', sha256: 'a'.repeat(64), bytes: 10, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), redacted: false},
      ],
      usage: {inputTokens: 0, outputTokens: 0},
    };
    const provider = new QueueProvider([{content: 'Ready.', toolCalls: []}]);
    const registry = new ToolRegistry([readToolArtifactTool]);
    const runner = new AgentRunner({
      config: runnerConfig(root), provider, contextEngine: context, toolRegistry: registry,
      toolArtifactStore: artifacts, session,
    });

    const resumed = await runner.run('continue');

    expect(resumed.toolArtifacts).toEqual([{...archived.artifact, redacted: false}]);
    expect(provider.toolCalls[0]).toContain('read_tool_artifact');
  });

  it('applies the same output firewall when a tool throws an oversized error', async () => {
    const root = await workspace('skein-tool-output-thrown-');
    const failingTool: AgentTool = {
      definition: {
        name: 'failing_tool', description: 'Throws a deliberately oversized error.', category: 'read',
        inputSchema: {type: 'object', properties: {}, additionalProperties: false},
      },
      async execute() {
        throw new Error(`ERROR_HEAD\n${'failure detail\n'.repeat(20_000)}ERROR_TAIL`);
      },
    };
    const provider = new QueueProvider([
      {content: '', toolCalls: [{id: 'thrown-call', name: 'failing_tool', arguments: {}}]},
      {content: 'Handled.', toolCalls: []},
    ]);
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({
      config: runnerConfig(root), provider, contextEngine: context,
      toolRegistry: new ToolRegistry([failingTool, readToolArtifactTool]),
    });

    await runner.run('exercise the failing tool', {onEvent: (event) => { events.push(event); }});
    const result = events.find((event): event is Extract<AgentEvent, {type: 'tool_result'}> =>
      event.type === 'tool_result' && event.result.toolCallId === 'thrown-call',
    )?.result;

    expect(result?.ok).toBe(false);
    expect(result?.content).toContain('ERROR_HEAD');
    expect(result?.content).toContain('ERROR_TAIL');
    expect(result?.metadata).toMatchObject({
      toolOutput: {truncated: true, artifact: {toolCallId: 'thrown-call'}},
      evidenceReceipt: {toolCallId: 'thrown-call', tool: 'failing_tool', outcome: 'failure'},
    });
  });

  it('fails closed on corrupt artifact storage without blocking the coding session', async () => {
    const root = await workspace('skein-tool-output-corrupt-resume-');
    const artifacts = new ToolArtifactStore(root);
    const archived = await artifacts.archive('session-1', 'corrupt-call', 'retained output', {redacted: false});
    if (!archived.stored) throw new Error('Expected test artifact to be retained.');
    const artifactRoot = join(root, '.skein', 'tool-artifacts');
    const [sessionDirectory] = await readdir(artifactRoot);
    if (!sessionDirectory) throw new Error('Expected a session artifact directory.');
    const directory = join(artifactRoot, sessionDirectory);
    const [file] = await readdir(directory);
    if (!file) throw new Error('Expected a retained artifact.');
    await writeFile(join(directory, file), '{"version":1}\n');
    const session = {
      id: 'session-1', title: 'Resume', workspace: root,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      model: 'test', provider: 'compatible' as const, messages: [], tasks: [], changedFiles: [], audit: [],
      toolArtifacts: [{...archived.artifact, redacted: false}],
      usage: {inputTokens: 0, outputTokens: 0},
    };
    const provider = new QueueProvider([{content: 'Continued safely.', toolCalls: []}]);
    const runner = new AgentRunner({
      config: runnerConfig(root), provider, contextEngine: context,
      toolRegistry: new ToolRegistry([readToolArtifactTool]), toolArtifactStore: artifacts, session,
    });

    const resumed = await runner.run('continue');

    expect(resumed.toolArtifacts).toEqual([]);
    expect(provider.toolCalls[0]).not.toContain('read_tool_artifact');
  });

  it('pages a giant single-line artifact without creating recursive overflow', async () => {
    const root = await workspace('skein-tool-output-byte-read-');
    const artifacts = new ToolArtifactStore(root);
    const archived = await artifacts.archive('session-1', 'giant-line', `HEAD${'中'.repeat(4_000)}TAIL`, {redacted: false});
    if (!archived.stored) throw new Error('Expected test artifact to be retained.');

    const execution = await readToolArtifactTool.execute({sha256: archived.artifact.sha256}, {
      config: runnerConfig(root),
      workspace: {primaryRoot: root} as never,
      session: {id: 'session-1', toolArtifacts: [{...archived.artifact, redacted: false}]} as never,
      toolArtifactStore: artifacts,
    });

    expect(estimateToolOutputTokens(execution.content)).toBeLessThan(1_024);
    expect(execution.content).toContain('HEAD');
    expect(execution.content).toContain('continue with start_byte=');
    expect(execution.content).not.toContain('Tool output retained outside');
  });
});

class QueueProvider implements ModelProvider {
  readonly name = 'compatible';
  readonly calls: ChatMessage[][] = [];
  readonly toolCalls: string[][] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(messages: ChatMessage[], tools: Array<{name: string}> = []): Promise<ModelResponse> {
    this.calls.push(messages.map((message) => ({...message})));
    this.toolCalls.push(tools.map((tool) => tool.name));
    const response = this.responses.shift();
    if (!response) throw new Error('No scripted response remaining.');
    return response;
  }
}

function runnerConfig(root: string): MosaicConfig {
  return {
    model: {provider: 'compatible', model: 'test', apiKey: 'test'},
    workspaceRoots: [root],
    context: {maxTokens: 2_000, topK: 4},
    permissions: {read: 'allow', write: 'deny', shell: 'deny', git: 'deny', network: 'deny', allowCommands: [], denyCommands: []},
    hooks: {},
    agent: {maxTurns: 4, maxSessionTokens: 100_000, autoVerify: false, verifyCommands: [], checkpointBeforeWrite: false},
    ui: {color: false, compact: true},
  };
}

async function workspace(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
