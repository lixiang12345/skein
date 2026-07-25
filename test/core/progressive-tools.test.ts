import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {AgentRunner} from '../../src/agent/runner.js';
import type {ModelProvider} from '../../src/providers/provider.js';
import {ToolRegistry} from '../../src/tools/registry.js';
import type {AgentTool, ContextProvider} from '../../src/tools/types.js';
import type {ChatMessage, ModelResponse, MosaicConfig} from '../../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

const context: ContextProvider = {
  async pack() { return {text: '', hits: [], estimatedTokens: 0, engine: 'test', truncated: false}; },
  async search() { return []; },
};

function config(root: string): MosaicConfig {
  return {
    model: {provider: 'compatible', model: 'test-model', apiKey: 'test'},
    workspaceRoots: [root],
    context: {maxTokens: 2_000, topK: 4},
    permissions: {
      read: 'allow', write: 'deny', shell: 'deny', git: 'deny', network: 'allow',
      allowCommands: [], denyCommands: [],
    },
    hooks: {},
    agent: {maxTurns: 4, maxSessionTokens: 20_000, autoVerify: false, verifyCommands: [], checkpointBeforeWrite: true},
    ui: {color: false, compact: true},
  };
}

class ProgressiveProvider implements ModelProvider {
  readonly name = 'compatible';
  readonly calls: string[][] = [];
  private response = 0;

  async complete(_messages: ChatMessage[], tools: Parameters<ModelProvider['complete']>[1]): Promise<ModelResponse> {
    this.calls.push(tools.map((tool) => tool.name));
    this.response += 1;
    if (this.response === 1) {
      return {
        content: '',
        toolCalls: [{id: 'progressive-call', name: 'progressive_alpha', arguments: {}}],
      };
    }
    return {content: 'Done.', toolCalls: []};
  }
}

function progressiveTool(name: string, description: string): AgentTool {
  return {
    definition: {
      name,
      description,
      category: 'network',
      inputSchema: {type: 'object', properties: {}, additionalProperties: false},
      progressive: true,
    },
    permissionCategories: () => ['network'],
    async execute() { return {content: 'ok'}; },
  };
}

describe('progressive tool disclosure', () => {
  it('loads at most eight relevant tools and keeps selected schemas for later turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-progressive-tools-'));
    roots.push(root);
    const provider = new ProgressiveProvider();
    const tools = Array.from({length: 10}, (_, index) => progressiveTool(
      `progressive_${index === 0 ? 'alpha' : `tool_${index}`}`,
      index === 0 ? 'Inspect alpha records.' : `Remote operation ${index}.`,
    ));
    const runner = new AgentRunner({
      config: config(root), provider, contextEngine: context, toolRegistry: new ToolRegistry(tools),
    });

    const session = await runner.run('inspect alpha records');
    const firstCall = provider.calls[0] ?? [];

    expect(provider.calls).toHaveLength(2);
    expect(firstCall).toHaveLength(8);
    expect(firstCall).toContain('progressive_alpha');
    expect(firstCall.every((name) => name.startsWith('progressive_'))).toBe(true);
    expect(provider.calls[1]).toEqual(firstCall);
    expect(session.tokenLedger?.[0]?.tools).toMatchObject({deferredCount: 2});
    expect(session.tokenLedger?.[1]?.tools).toMatchObject({deferredCount: 2});
  });

  it('does not defer small progressive catalogs or change their permission category', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-progressive-small-'));
    roots.push(root);
    const provider: ModelProvider = {
      name: 'compatible',
      async complete(_messages, tools) {
        expect(tools).toHaveLength(3);
        expect(tools.every((tool) => tool.name.startsWith('progressive_'))).toBe(true);
        expect(tools.every((tool) => tool.category === 'network')).toBe(true);
        return {content: 'Done.', toolCalls: []};
      },
    };
    const runner = new AgentRunner({
      config: config(root), provider, contextEngine: context,
      toolRegistry: new ToolRegistry([
        progressiveTool('progressive_one', 'One.'),
        progressiveTool('progressive_two', 'Two.'),
        progressiveTool('progressive_three', 'Three.'),
      ]),
    });

    const session = await runner.run('inspect remote data');

    expect(session.tokenLedger?.[0]?.tools).toMatchObject({deferredCount: 0});
  });
});
