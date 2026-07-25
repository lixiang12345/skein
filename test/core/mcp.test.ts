import {lstat, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {McpManager, rankRelevantTools, type McpClientLike} from '../../src/mcp/manager.js';
import {createMcpToolAdapter, isUsableRemoteTool, makeMcpToolName} from '../../src/mcp/tool.js';
import {McpTrustStore} from '../../src/mcp/trust-store.js';
import {redactToolCallForDisplay} from '../../src/agent/runner.js';
import {validateHttpConfig, validateStdioConfig} from '../../src/mcp/validation.js';
import {ExtensionRuntime} from '../../src/runtime/extensions.js';
import {ToolRegistry} from '../../src/tools/registry.js';
import type {ToolExecutionContext} from '../../src/tools/types.js';
import type {McpConfig, McpServerConfig, MosaicConfig} from '../../src/types.js';

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
    expect(tool.definition.progressive).toBe(true);
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

  it('leaves complete MCP output for the runner-level token firewall', async () => {
    const content = `${'head '.repeat(20_000)}TAIL_STATUS`;
    const tool = createMcpToolAdapter({
      serverName: 'logs',
      exposedName: 'mcp_logs_read',
      remoteTool: {name: 'read', inputSchema: {type: 'object', properties: {}}},
      timeoutMs: 1_000,
      callTool: async () => ({content: [{type: 'text', text: content}]}),
    });

    const execution = await tool.execute({}, {
      config: {} as never,
      workspace: {} as never,
      session: {} as never,
    });
    expect(execution.content).toBe(content);
    expect(execution.content).toContain('TAIL_STATUS');
    expect(execution.metadata).toMatchObject({sourceTruncated: false});
  });

  it('bounds hostile MCP output while preserving head, tail, and source telemetry', async () => {
    const content = `HEAD_STATUS\n${'x'.repeat(6 * 1024 * 1024)}\nTAIL_STATUS`;
    const tool = createMcpToolAdapter({
      serverName: 'logs',
      exposedName: 'mcp_logs_read',
      remoteTool: {name: 'read', inputSchema: {type: 'object', properties: {}}},
      timeoutMs: 1_000,
      callTool: async () => ({content: [{type: 'text', text: content}]}),
    });

    const execution = await tool.execute({}, {
      config: {} as never,
      workspace: {} as never,
      session: {} as never,
    });
    expect(Buffer.byteLength(execution.content)).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(execution.content).toContain('HEAD_STATUS');
    expect(execution.content).toContain('TAIL_STATUS');
    expect(execution.metadata).toMatchObject({sourceTruncated: true});
    expect(execution.metadata?.sourceBytes).toBeGreaterThan(5 * 1024 * 1024);
  });

  it('fails closed on hostile schemas and redacts declared sensitive fields from events', () => {
    const cyclic: Record<string, unknown> = {type: 'object'};
    cyclic.self = cyclic;
    expect(isUsableRemoteTool({name: 'safe', inputSchema: cyclic as never})).toBe(false);
    expect(isUsableRemoteTool({name: 'bad\u0000name', inputSchema: {type: 'object'}})).toBe(false);
    expect(isUsableRemoteTool({
      name: 'oversize',
      inputSchema: {type: 'object', description: 'x'.repeat(100_001)},
    })).toBe(false);

    const display = redactToolCallForDisplay({
      id: 'call',
      name: 'mcp_docs_search',
      arguments: {query: 'public', token: 'top-secret', nested: {password: 'hidden'}},
    }, ['token', 'nested.password']);
    expect(JSON.stringify(display)).not.toContain('top-secret');
    expect(JSON.stringify(display)).not.toContain('hidden');
    expect(display.arguments).toEqual({
      query: 'public',
      token: '<redacted>',
      nested: {password: '<redacted>'},
    });
  });

  it('requires verifiable receipts before external mutations receive complete change tracking', async () => {
    const unsupported = createMcpToolAdapter({
      serverName: 'files',
      exposedName: 'mcp_files_replace',
      remoteTool: {name: 'replace', inputSchema: {type: 'object', properties: {}}},
      capability: {
        name: 'replace',
        permissions: ['write', 'network'],
        network: [], commands: [], paths: ['src/**'], sensitiveFields: [],
        background: false, processTree: false, completionEvidence: 'none',
      },
      timeoutMs: 1_000,
      callTool: async () => ({content: [{type: 'text', text: 'changed'}]}),
    });
    const unsupportedResult = await unsupported.execute({}, {
      config: {} as never,
      workspace: {} as never,
      session: {} as never,
    });
    expect(unsupported.permissionCategories?.({})).toEqual(['write', 'network']);
    expect(unsupportedResult.metadata).toMatchObject({
      changeTracking: 'unresolved',
      completionEvidenceVerified: false,
    });

    const supportedCall = vi.fn(async () => ({
      structuredContent: {
        skeinEvidence: {
          changedFiles: ['src/a.ts'],
          checkpointId: 'checkpoint-1',
          artifactReceipts: ['artifact:patch'],
          completionEvidence: ['test:focused'],
        },
      },
    }));
    const supported = createMcpToolAdapter({
      serverName: 'files',
      exposedName: 'mcp_files_replace',
      remoteTool: {name: 'replace', inputSchema: {type: 'object', properties: {}}},
      capability: {
        name: 'replace',
        permissions: ['write', 'network'],
        network: [], commands: [], paths: ['src/**'], sensitiveFields: ['token'],
        background: false, processTree: false, completionEvidence: 'full',
      },
      timeoutMs: 1_000,
      callTool: supportedCall,
    });
    const supportedResult = await supported.execute({}, {
      config: {} as never,
      workspace: {resolvePath: async (path: string) => `/workspace/${path}`} as never,
      session: {} as never,
      checkpointId: 'checkpoint-1',
    });
    expect(supportedResult.changedFiles).toEqual(['/workspace/src/a.ts']);
    expect(supportedResult.metadata).toMatchObject({
      changeTracking: 'complete',
      completionEvidenceVerified: true,
      checkpointId: 'checkpoint-1',
    });
    expect(supportedCall).toHaveBeenCalledWith(
      {name: 'replace', arguments: {_skein: {checkpointId: 'checkpoint-1'}}},
      expect.any(Object),
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
  it('enforces inspectable fingerprint trust, persistent disable, and revocation before activation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-mcp-trust-'));
    temporaryDirectories.push(root);
    const trustPath = join(root, 'trust.json');
    const connect = vi.fn(async () => undefined);
    const mcp = config({
      version: '1.2.3',
      url: 'https://example.com/mcp?token=must-not-leak',
      headers: {Authorization: 'Bearer must-not-leak'},
      tools: [{
        name: 'search',
        permissions: ['read'],
        network: ['https://api.example.com/search?token=must-not-leak'],
        sensitiveFields: ['token'],
        completionEvidence: 'none',
      }],
    });
    const manager = new McpManager(mcp, {
      cwd: root,
      trustStore: new McpTrustStore({path: trustPath}),
      clientFactory: () => fakeClient({
        connect,
        listTools: vi.fn(async () => ({
          tools: [{name: 'search', inputSchema: {type: 'object', properties: {token: {type: 'string'}}}}],
        })),
      }),
      transportFactory: () => fakeTransport(),
    });
    await manager.loadTrust();
    expect(manager.status('docs')).toMatchObject({state: 'untrusted', trust: 'untrusted'});
    expect(manager.inspect('docs').target).toBe('https://example.com/mcp');
    expect(JSON.stringify(manager.inspect('docs'))).not.toContain('must-not-leak');
    await expect(manager.activate('docs', 'search', new ToolRegistry())).resolves.toMatchObject({ok: false});
    expect(connect).not.toHaveBeenCalled();

    await manager.trust('docs');
    const registry = new ToolRegistry();
    await expect(manager.activate('docs', 'search', registry)).resolves.toMatchObject({ok: true});
    expect(connect).toHaveBeenCalledOnce();
    expect(registry.get('mcp_docs_search')?.definition.sensitiveFields).toEqual(['token']);
    await manager.disable('docs');
    expect(registry.get('mcp_docs_search')).toBeUndefined();
    expect(manager.status('docs')).toMatchObject({state: 'disabled', trust: 'disabled'});

    const stored = await readFile(trustPath, 'utf8');
    expect(stored).not.toContain('must-not-leak');
    expect((await lstat(trustPath)).mode & 0o777).toBe(0o600);
    await manager.trust('docs');
    await manager.revoke('docs');
    expect(manager.status('docs')).toMatchObject({state: 'revoked', trust: 'revoked'});

    const reloaded = new McpManager(mcp, {
      cwd: root,
      trustStore: new McpTrustStore({path: trustPath}),
      clientFactory: () => fakeClient({connect}),
      transportFactory: () => fakeTransport(),
    });
    await reloaded.loadTrust();
    expect(reloaded.status('docs')).toMatchObject({state: 'revoked', trust: 'revoked'});
  });

  it('keeps legacy dynamic manifests inspectable but refuses to trust an undeclared tool set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-mcp-dynamic-trust-'));
    temporaryDirectories.push(root);
    const manager = new McpManager(config(), {
      cwd: root,
      trustStore: new McpTrustStore({path: join(root, 'trust.json')}),
    });
    expect(manager.inspect('docs').dynamicTools).toBe(true);
    await expect(manager.trust('docs')).rejects.toThrow('until its tools and effects are declared');
  });

  it('rejects undeclared server-injected tools and never trusts annotations to lower permissions', async () => {
    const declared = config({
      tools: [{
        name: 'replace',
        permissions: ['write', 'shell'],
        commands: ['node'],
        paths: ['src/**'],
        completionEvidence: 'partial',
      }],
    });
    const manager = new McpManager(declared, {
      requireTrust: false,
      clientFactory: () => fakeClient({
        listTools: vi.fn(async () => ({tools: [
          {name: 'replace', annotations: {readOnlyHint: true}, inputSchema: {type: 'object', properties: {}}},
          {name: 'injected_admin', annotations: {readOnlyHint: true}, inputSchema: {type: 'object', properties: {}}},
        ]})),
      }),
      transportFactory: () => fakeTransport(),
    });
    const result = await manager.connect('docs');
    expect(result.skippedTools).toBe(1);
    expect(manager.getTools()).toHaveLength(1);
    expect(manager.getTools()[0]?.permissionCategories?.({})).toEqual(['write', 'shell', 'network']);
    expect(manager.getTools()[0]?.definition.completionEvidence).toBe('partial');
  });

  it('blocks only required server failures during initialization', async () => {
    const connect = vi.fn(async () => {
      throw new Error('offline');
    });
    const optional = new McpManager(config(), {
      requireTrust: false,
      clientFactory: () => fakeClient({connect}),
      transportFactory: () => fakeTransport(),
    });
    await expect(optional.initialize()).resolves.toBeUndefined();
    expect(connect).not.toHaveBeenCalled();

    const required = new McpManager(config({required: true}), {
      requireTrust: false,
      clientFactory: () => fakeClient({connect}),
      transportFactory: () => fakeTransport(),
    });
    await expect(required.initialize()).rejects.toThrow('Required MCP server unavailable: docs: offline');

    const untrusted = new McpManager(config({required: true}), {
      clientFactory: () => fakeClient({connect}),
      transportFactory: () => fakeTransport(),
    });
    await expect(untrusted.initialize()).rejects.toThrow('capability manifest is untrusted');
  });

  it('measures lazy schema savings and ranks the intended tool first across fixed queries', async () => {
    const tools = ['search_docs', 'read_logs', 'create_issue', 'query_database'].map((name) => ({
      definition: {
        name,
        description: name.replaceAll('_', ' '),
        category: 'read' as const,
        inputSchema: {type: 'object', properties: {query: {type: 'string'}}},
      },
      execute: async () => ({content: ''}),
    }));
    const cases = [
      ['search documentation', 'search_docs'],
      ['read logs', 'read_logs'],
      ['create issue', 'create_issue'],
      ['query database', 'query_database'],
    ] as const;
    const correct = cases.filter(([query, expected]) =>
      rankRelevantTools(tools, query)[0]?.tool.definition.name === expected).length;
    expect(correct / cases.length).toBe(1);
  });

  it('keeps chat startup lazy and activates only request-relevant schemas', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-mcp-lazy-'));
    temporaryDirectories.push(root);
    const connect = vi.fn(async () => undefined);
    const listTools = vi.fn(async () => ({
      tools: Array.from({length: 10}, (_, index) => ({
        name: index === 9 ? 'alpha_search' : `remote_${index}`,
        description: index === 9 ? 'Inspect alpha records.' : `Remote operation ${index}.`,
        inputSchema: {type: 'object' as const, properties: {}},
      })),
    }));
    const manager = new McpManager(config({
      description: 'Search internal documentation.',
    }), {
      requireTrust: false,
      clientFactory: () => fakeClient({connect, listTools}),
      transportFactory: () => fakeTransport(),
    });
    const registry = new ToolRegistry();
    const runtimeConfig = extensionConfig(root, config({
      description: 'Search internal documentation.',
    }));
    const runtime = await ExtensionRuntime.create(runtimeConfig, registry, {mcpManager: manager});
    try {
      expect(connect).not.toHaveBeenCalled();
      expect(listTools).not.toHaveBeenCalled();
      expect(manager.status('docs')).toMatchObject({state: 'disconnected', toolCount: 0});
      const activation = registry.get('mcp_activate');
      expect(activation?.definition).toMatchObject({category: 'network'});
      expect(activation?.definition.description).toContain('docs: Search internal documentation.');
      expect(activation?.definition.description).not.toContain('127.0.0.1');
      expect(activation?.permissionCategories?.({server: 'docs', query: 'alpha'})).toEqual(['network']);

      const first = await activation?.execute({server: 'docs', query: 'inspect alpha records'}, {
        config: runtimeConfig,
        workspace: {} as never,
        session: {} as never,
      });
      expect(connect).toHaveBeenCalledOnce();
      expect(listTools).toHaveBeenCalledOnce();
      expect(first).toMatchObject({
        metadata: {
          mcpServer: 'docs',
          state: 'connected',
          availableTools: 10,
          loadedTools: expect.arrayContaining(['mcp_docs_alpha_search']),
          deferredTools: 2,
          schemaBudget: {
            savedTokens: expect.any(Number),
            topMatch: 'mcp_docs_alpha_search',
            queryMatched: true,
          },
        },
      });
      expect((first?.metadata?.schemaBudget as {savedTokens: number}).savedTokens).toBeGreaterThan(0);
      expect(registry.get('mcp_docs_alpha_search')).toBeDefined();
      expect(registry.definitions().filter((tool) => tool.name.startsWith('mcp_docs_')))
        .toHaveLength(8);

      await activation?.execute({server: 'docs', query: 'inspect alpha records'}, {
        config: runtimeConfig,
        workspace: {} as never,
        session: {} as never,
      });
      expect(connect).toHaveBeenCalledOnce();
      expect(listTools).toHaveBeenCalledOnce();
      expect(registry.definitions().filter((tool) => tool.name.startsWith('mcp_docs_')))
        .toHaveLength(8);
    } finally {
      await runtime.close();
    }
  });

  it('returns activation failures as tool results without registering schemas', async () => {
    const client = fakeClient({
      connect: vi.fn(async () => {
        throw new Error('server unavailable');
      }),
    });
    const manager = new McpManager(config(), {
      requireTrust: false,
      clientFactory: () => client,
      transportFactory: () => fakeTransport(),
    });
    const registry = new ToolRegistry();
    const activation = manager.activationTool(registry);

    const result = await activation?.execute({server: 'docs', query: 'search docs'}, {
      config: extensionConfig('/tmp', config()),
      workspace: {} as never,
      session: {} as never,
    });

    expect(result).toMatchObject({
      ok: false,
      metadata: {mcpServer: 'docs', state: 'error', availableTools: 0, loadedTools: []},
    });
    expect(result?.content).toContain('server unavailable');
    expect(registry.definitions()).toEqual([]);
  });

  it('keeps servers beyond the configured limit out of the activation catalog', async () => {
    const servers = Object.fromEntries(Array.from({length: 33}, (_, index) => [
      `server_${String(index).padStart(2, '0')}`,
      server({transport: 'http', url: `http://127.0.0.1:${3_000 + index}/mcp`}),
    ]));
    const manager = new McpManager({
      enabled: true,
      connectTimeoutMs: 1_000,
      toolTimeoutMs: 2_000,
      servers,
    }, {requireTrust: false});
    const activation = manager.activationTool(new ToolRegistry());
    const schema = activation?.definition.inputSchema as {
      properties?: {server?: {enum?: string[]}};
    };

    expect(schema.properties?.server?.enum).toHaveLength(32);
    expect(schema.properties?.server?.enum).not.toContain('server_32');
    expect(manager.status('server_32')).toMatchObject({
      state: 'error',
      error: 'MCP server limit exceeded (maximum 32)',
    });
    await expect(manager.connect('server_32')).resolves.toMatchObject({ok: false});
  });

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
      requireTrust: false,
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
      requireTrust: false,
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
      requireTrust: false,
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
      requireTrust: false,
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
      requireTrust: false,
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

function config(update: Partial<McpServerConfig> = {}): McpConfig {
  return {
    enabled: true,
    connectTimeoutMs: 1_000,
    toolTimeoutMs: 2_000,
    servers: {
      docs: server({transport: 'http', url: 'http://127.0.0.1:3000/mcp', ...update}),
    },
  };
}

function extensionConfig(root: string, mcp: McpConfig): MosaicConfig {
  return {
    model: {provider: 'compatible', model: 'test', apiKey: 'test'},
    workspaceRoots: [root],
    context: {maxTokens: 2_000, topK: 4},
    permissions: {
      read: 'allow', write: 'deny', shell: 'deny', git: 'deny', network: 'allow',
      allowCommands: [], denyCommands: [],
    },
    hooks: {},
    agent: {
      maxTurns: 4,
      maxSessionTokens: 20_000,
      autoVerify: false,
      verifyCommands: [],
      checkpointBeforeWrite: true,
    },
    ui: {color: false, compact: true},
    mcp,
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
