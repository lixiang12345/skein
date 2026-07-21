import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {McpManager, type McpClientLike} from '../../src/mcp/manager.js';
import {createMcpToolAdapter, makeMcpToolName} from '../../src/mcp/tool.js';
import {validateHttpConfig, validateStdioConfig} from '../../src/mcp/validation.js';
import {ToolRegistry} from '../../src/tools/registry.js';
import type {ToolExecutionContext} from '../../src/tools/types.js';
import type {McpConfig, McpServerConfig} from '../../src/types.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, {recursive: true, force: true})));
});

describe('MCP validation and tool adapters', () => {
  it('keeps generated tool names readable, valid, and bounded', () => {
    expect(makeMcpToolName('docs-server', 'search/repository')).toBe(
      'mcp_docs_server_search_repository',
    );
    const longName = makeMcpToolName('server', 'x'.repeat(200));
    expect(longName).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    expect(longName).toHaveLength(64);
  });

  it('treats every MCP tool as a network operation and forwards abort/timeouts', async () => {
    const signal = new AbortController().signal;
    const callTool = vi.fn(async () => ({
      content: [{type: 'text', text: 'remote \u001b[31mresult\u001b[0m'}],
      structuredContent: {matches: 2},
    }));
    const tool = createMcpToolAdapter({
      serverName: 'docs',
      exposedName: 'mcp_docs_search',
      remoteTool: {
        name: 'search',
        description: 'Search documentation.',
        inputSchema: {type: 'object', properties: {query: {type: 'string'}}},
      },
      timeoutMs: 1_234,
      callTool,
    });

    expect(tool.definition.category).toBe('network');
    expect(tool.permissionCategories?.({query: 'mcp'})).toEqual(['network']);
    const execution = await tool.execute({query: 'mcp'}, {
      signal,
      config: {} as never,
      workspace: {} as never,
      session: {} as never,
    } satisfies ToolExecutionContext);
    expect(execution.content).toContain('remote result');
    expect(execution.content).not.toContain('\u001b');
    expect(execution.content).toContain('"matches": 2');
    expect(callTool).toHaveBeenCalledWith(
      {name: 'search', arguments: {query: 'mcp'}},
      expect.objectContaining({signal, timeout: 1_234, maxTotalTimeout: 1_234}),
    );
  });

  it('limits insecure HTTP and stdio environment/workspace escapes', async () => {
    expect(() => validateHttpConfig(server({
      transport: 'http',
      url: 'http://example.com/mcp',
    }))).toThrow('loopback');
    expect(() => validateHttpConfig(server({
      transport: 'http',
      url: 'http://127.0.0.1.attacker.example/mcp',
    }))).toThrow('loopback');
    expect(validateHttpConfig(server({
      transport: 'http',
      url: 'http://127.0.0.1:3000/mcp',
    })).url.hostname).toBe('127.0.0.1');
    expect(() => validateHttpConfig(server({
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: {'X-Test': 'ok\r\ninjected: true'},
    }))).toThrow('header value');

    const workspace = await mkdtemp(join(tmpdir(), 'skein-mcp-workspace-'));
    const outside = await mkdtemp(join(tmpdir(), 'skein-mcp-outside-'));
    temporaryDirectories.push(workspace, outside);
    await expect(validateStdioConfig(server({
      transport: 'stdio',
      command: 'node',
      cwd: outside,
    }), {cwd: workspace, workspaceRoots: [workspace]})).rejects.toThrow('outside');
    await expect(validateStdioConfig(server({
      transport: 'stdio',
      command: 'node',
      env: {NODE_OPTIONS: '--require ./inject.js'},
    }), {cwd: workspace, workspaceRoots: [workspace]})).rejects.toThrow('Unsafe');
  });
});

describe('McpManager', () => {
  it('interoperates with the real MCP SDK client protocol', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server(
      {name: 'sdk-fixture', version: '1.0.0'},
      {capabilities: {tools: {}}},
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{
        name: 'ping',
        description: 'Return pong.',
        inputSchema: {type: 'object', properties: {}},
      }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => ({
      content: [{type: 'text', text: request.params.name === 'ping' ? 'pong' : 'unknown'}],
    }));
    await server.connect(serverTransport as unknown as Transport);
    const manager = new McpManager(config(), {
      transportFactory: () => clientTransport as unknown as Transport,
    });
    try {
      await expect(manager.connect('docs')).resolves.toMatchObject({ok: true});
      expect(manager.status('docs')?.serverVersion).toBe('sdk-fixture 1.0.0');
      const tool = manager.getTools()[0];
      expect(tool?.definition.name).toBe('mcp_docs_ping');
      const result = await tool?.execute({}, {
        config: {} as never,
        workspace: {} as never,
        session: {} as never,
      });
      expect(result?.content).toBe('pong');
    } finally {
      await manager.close();
      await server.close().catch(() => undefined);
    }
  });

  it('connects, namespaces, registers, invokes, and closes remote tools', async () => {
    const calls: unknown[] = [];
    const client = fakeClient({
      listTools: vi.fn(async () => ({
        tools: [{
          name: 'search',
          description: 'Search the remote corpus.',
          inputSchema: {type: 'object' as const, properties: {query: {type: 'string'}}},
        }],
      })),
      callTool: vi.fn(async (params: unknown) => {
        calls.push(params);
        return {content: [{type: 'text', text: 'found'}]};
      }),
      getServerVersion: () => ({name: 'fixture', version: '1.0.0'}),
    });
    const manager = new McpManager(config(), {
      clientFactory: () => client,
      transportFactory: () => fakeTransport(),
    });

    const connected = await manager.connectAll();
    expect(connected).toHaveLength(1);
    expect(connected[0]?.ok).toBe(true);
    expect(manager.status('docs')).toMatchObject({state: 'connected', toolCount: 1});
    expect(manager.status('docs')?.serverVersion).toBe('fixture 1.0.0');
    const registry = new ToolRegistry();
    expect(manager.registerTools(registry)).toEqual(['mcp_docs_search']);
    const tool = registry.get('mcp_docs_search');
    expect(tool).toBeDefined();
    const execution = await tool?.execute({query: 'status'}, {
      config: {} as never,
      workspace: {} as never,
      session: {} as never,
    });
    expect(execution?.content).toBe('found');
    expect(calls).toEqual([{name: 'search', arguments: {query: 'status'}}]);

    await manager.close();
    expect(manager.status('docs')).toMatchObject({state: 'closed', toolCount: 0});
  });

  it('reports connection failures without rejecting connectAll', async () => {
    const client = fakeClient({
      connect: vi.fn(async () => {
        throw new Error('server unavailable');
      }),
    });
    const manager = new McpManager(config(), {
      clientFactory: () => client,
      transportFactory: () => fakeTransport(),
    });
    const [result] = await manager.connectAll();
    expect(result).toMatchObject({ok: false, status: {state: 'error'}});
    expect(result?.status.error).toContain('server unavailable');
    expect(manager.tools()).toEqual([]);
  });

  it('keeps registered proxy tools usable after a server refresh', async () => {
    const catalog = vi.fn(async () => ({
      tools: [{
        name: 'search',
        inputSchema: {type: 'object' as const, properties: {}},
      }],
    }));
    const clients = [
      fakeClient({
        listTools: catalog,
        callTool: vi.fn(async () => ({content: [{type: 'text', text: 'first'}]})),
      }),
      fakeClient({
        listTools: catalog,
        callTool: vi.fn(async () => ({content: [{type: 'text', text: 'second'}]})),
      }),
    ];
    const manager = new McpManager(config(), {
      clientFactory: () => clients.shift() as McpClientLike,
      transportFactory: () => fakeTransport(),
    });
    await manager.connect('docs');
    const registry = new ToolRegistry();
    manager.registerTools(registry);
    const registered = registry.get('mcp_docs_search');
    await manager.refresh('docs');
    expect(manager.registerTools(registry)).toEqual([]);
    expect(registry.get('mcp_docs_search')).toBe(registered);
    const execution = await registered?.execute({}, {
      config: {} as never,
      workspace: {} as never,
      session: {} as never,
    });
    expect(execution?.content).toBe('second');
  });

  it('aborts an in-flight handshake when the manager closes', async () => {
    const client = fakeClient({
      connect: vi.fn(async (_transport: unknown, options: {signal?: AbortSignal} | undefined) =>
        new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
        })),
    });
    const manager = new McpManager(config(), {
      clientFactory: () => client,
      transportFactory: () => fakeTransport(),
    });
    const connection = manager.connect('docs');
    await vi.waitFor(() => expect(manager.status('docs')?.state).toBe('connecting'));
    await manager.close();
    await expect(connection).resolves.toMatchObject({ok: false});
    expect(manager.status('docs')).toMatchObject({state: 'closed', toolCount: 0});
  });
});

function server(update: Partial<McpServerConfig>): McpServerConfig {
  return {
    enabled: true,
    transport: 'stdio',
    ...update,
  };
}

function config(): McpConfig {
  return {
    enabled: true,
    connectTimeoutMs: 1_000,
    toolTimeoutMs: 2_000,
    servers: {
      docs: server({transport: 'http', url: 'http://127.0.0.1:3000/mcp'}),
    },
  };
}

function fakeTransport(): Transport {
  return {
    start: async () => undefined,
    send: async () => undefined,
    close: async () => undefined,
  };
}

function fakeClient(update: Record<string, unknown> = {}): McpClientLike {
  return {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({tools: []})),
    callTool: vi.fn(async () => ({content: []})),
    close: vi.fn(async () => undefined),
    ...update,
  } as unknown as McpClientLike;
}
