import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {RequestOptions} from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {Tool as McpSdkTool} from '@modelcontextprotocol/sdk/types.js';
import stripAnsi from 'strip-ansi';
import type {McpConfig, McpServerConfig} from '../types.js';
import type {ToolRegistry, AgentTool} from '../tools/index.js';
import {ToolInputError} from '../tools/types.js';
import {estimateTokens} from '../utils/tokens.js';
import {
  createMcpToolAdapter,
  disambiguateMcpToolName,
  isUsableRemoteTool,
  makeMcpToolName,
  type McpCallTool,
  type McpRemoteTool,
} from './tool.js';
import {
  assertMcpServerName,
  validateHttpConfig,
  validateStdioConfig,
  type McpValidationOptions,
  type ValidatedHttpConfig,
  type ValidatedStdioConfig,
} from './validation.js';
import {
  buildMcpCapabilityManifest,
  capabilityFingerprint,
  declaredToolCapability,
  searchMcpCapabilities,
  type McpCapabilityManifest,
  type McpCapabilitySearchResult,
} from './capabilities.js';
import {McpTrustStore, type McpTrustState} from './trust-store.js';

const MAX_SERVERS = 32;
const MAX_TOOLS_PER_SERVER = 256;
const MAX_LIST_PAGES = 16;
const DEFAULT_CONNECT_TIMEOUT = 12_000;
const DEFAULT_TOOL_TIMEOUT = 60_000;
const LAZY_SCHEMA_LIMIT = 8;

export type McpServerState =
  | 'disabled'
  | 'untrusted'
  | 'revoked'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'closed';

export interface McpServerStatus {
  name: string;
  state: McpServerState;
  transport: 'stdio' | 'http';
  toolCount: number;
  required: boolean;
  trust: McpTrustState;
  connectedAt?: string;
  serverVersion?: string;
  error?: string;
}

export interface McpConnectResult {
  name: string;
  ok: boolean;
  status: McpServerStatus;
  skippedTools: number;
}

export interface McpActivationResult extends McpConnectResult {
  registeredTools: string[];
  availableTools: number;
  deferredTools: number;
  schemaBudget?: {
    eagerTokens: number;
    loadedTokens: number;
    savedTokens: number;
    topMatch: string | null;
    queryMatched: boolean;
  };
}

export interface McpManagerOptions extends McpValidationOptions {
  clientName?: string;
  clientVersion?: string;
  logger?: (message: string, details?: Record<string, unknown>) => void;
  trustStore?: McpTrustStore;
  /** Test-only compatibility escape hatch; production runtimes require trust. */
  requireTrust?: boolean;
  /** Injectable factories keep lifecycle tests independent of child processes/network. */
  clientFactory?: (name: string) => McpClientLike;
  transportFactory?: (
    name: string,
    config: McpServerConfig,
    validated: ValidatedStdioConfig | ValidatedHttpConfig,
  ) => Promise<Transport> | Transport;
}

export interface McpClientLike {
  connect: Client['connect'];
  listTools: Client['listTools'];
  callTool: Client['callTool'];
  close: Client['close'];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  getServerVersion?: Client['getServerVersion'];
}

interface Connection {
  name: string;
  client: McpClientLike;
  transport: Transport;
  tools: Map<string, AgentTool>;
  remoteTools: McpRemoteTool[];
}

/**
 * Owns MCP transports and exposes their tools as ordinary Skein AgentTools.
 * Every external tool remains in the `network` permission category, and a
 * failed server is represented in status rather than rejecting the whole run.
 */
export class McpManager {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, Promise<McpConnectResult>>();
  private readonly connectionControllers = new Map<string, AbortController>();
  private readonly statuses = new Map<string, McpServerStatus>();
  private readonly toolOwners = new Map<string, string>();
  private readonly stableAdapters = new Map<string, AgentTool>();
  private readonly registries = new Set<ToolRegistry>();
  private readonly options: McpManagerOptions;
  private readonly trustStore: McpTrustStore;
  private readonly workspace: string;
  private readonly requireTrust: boolean;
  private readonly shutdownController = new AbortController();
  private trustLoaded = false;
  private closed = false;

  constructor(
    private readonly config: McpConfig,
    options: McpManagerOptions = {},
  ) {
    this.options = options;
    this.trustStore = options.trustStore ?? new McpTrustStore();
    this.workspace = options.cwd ?? process.cwd();
    this.requireTrust = options.requireTrust !== false;
    const entries = Object.entries(config.servers ?? {});
    for (const [index, [name, server]] of entries.entries()) {
      const transport = server.transport ?? 'stdio';
      if (index >= MAX_SERVERS) {
        this.statuses.set(name, {
          name,
          state: 'error',
          transport,
          toolCount: 0,
          required: server.required === true,
          trust: 'untrusted',
          error: `MCP server limit exceeded (maximum ${MAX_SERVERS})`,
        });
        continue;
      }
      const disabled = config.enabled === false || server.enabled === false;
      const state: McpServerState = disabled
        ? 'disabled' : this.requireTrust ? 'untrusted' : 'disconnected';
      this.statuses.set(name, {
        name,
        state,
        transport,
        toolCount: 0,
        required: server.required === true,
        trust: disabled ? 'disabled' : this.requireTrust ? 'untrusted' : 'trusted',
      });
    }
  }

  /** Load persisted trust and prove availability for explicitly required servers. */
  async initialize(signal?: AbortSignal): Promise<void> {
    await this.ensureTrustLoaded();
    const required = [...this.statuses.values()]
      .filter((status) => status.required && status.state !== 'disabled')
      .map((status) => status.name);
    const failures: string[] = [];
    for (const name of required) {
      const status = this.statuses.get(name);
      if (status?.trust !== 'trusted') {
        failures.push(`${name}: capability manifest is ${status?.trust ?? 'untrusted'}`);
        continue;
      }
      const result = await this.connect(name, signal);
      if (!result.ok) failures.push(`${name}: ${result.status.error ?? result.status.state}`);
    }
    if (failures.length) {
      throw new Error(`Required MCP server unavailable: ${failures.join('; ')}`);
    }
  }

  /** Refresh local trust state without connecting; used by status and review UIs. */
  async loadTrust(): Promise<void> {
    await this.ensureTrustLoaded();
  }

  /** Compact, no-network capability controls advertised before remote schemas. */
  catalogTools(registry: ToolRegistry): AgentTool[] {
    const names = this.catalogServerNames();
    if (!names.length) return [];
    const search: AgentTool = {
      definition: {
        name: 'mcp_search',
        description: 'Search configured MCP capability manifests without connecting to a server or loading remote schemas.',
        category: 'read',
        source: 'mcp',
        permissionCategories: ['read'],
        activation: 'catalog',
        inputSchema: {
          type: 'object',
          properties: {
            query: {type: 'string', maxLength: 500, description: 'Capability, tool, permission, or server to find.'},
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      permissionCategories: () => ['read'],
      execute: async (arguments_) => {
        const query = typeof arguments_.query === 'string' ? arguments_.query.trim() : '';
        if (query.length > 500) throw new ToolInputError('MCP search query must be at most 500 characters');
        await this.ensureTrustLoaded();
        const results = this.search(query);
        return {
          content: results.length
            ? results.map((result) => `${result.name}: ${result.description} (${result.trust}, ${result.declaredTools || 'dynamic'} tools)`).join('\n')
            : 'No configured MCP capability matched the query.',
          metadata: {mcpSearch: results},
        };
      },
    };
    const inspect: AgentTool = {
      definition: {
        name: 'mcp_inspect',
        description: 'Inspect one redacted declarative MCP capability manifest and its local trust state without connecting.',
        category: 'read',
        source: 'mcp',
        permissionCategories: ['read'],
        activation: 'catalog',
        inputSchema: {
          type: 'object',
          properties: {
            server: {type: 'string', enum: names, description: 'Configured MCP server to inspect.'},
          },
          required: ['server'],
          additionalProperties: false,
        },
      },
      permissionCategories: () => ['read'],
      execute: async (arguments_) => {
        const server = typeof arguments_.server === 'string' ? arguments_.server : '';
        if (!names.includes(server)) throw new ToolInputError('MCP server is not available for inspection');
        await this.ensureTrustLoaded();
        const manifest = this.inspect(server);
        return {
          content: JSON.stringify({manifest, trust: this.status(server)?.trust ?? 'untrusted'}, null, 2),
          metadata: {
            mcpServer: server,
            trust: this.status(server)?.trust ?? 'untrusted',
            manifestFingerprint: this.fingerprint(server),
          },
        };
      },
    };
    const activation = this.activationTool(registry);
    return activation ? [search, inspect, activation] : [search, inspect];
  }

  /** Compact model-visible catalog; transport and remote discovery stay lazy. */
  activationTool(registry: ToolRegistry): AgentTool | undefined {
    const names = this.catalogServerNames();
    if (!names.length) return;
    const catalog = names.map((name) => {
      const server = this.config.servers[name];
      const description = sanitizeCatalogText(server?.description) ||
        `${server?.transport ?? 'stdio'} MCP server`;
      return `${name}: ${description}`;
    }).join('; ');
    return {
      definition: {
        name: 'mcp_activate',
        description: `Activate one already trusted MCP capability after mcp_search and mcp_inspect, then load at most ${LAZY_SCHEMA_LIMIT} relevant schemas. This tool cannot grant trust. Available servers: ${catalog}`,
        category: 'network',
        source: 'mcp',
        permissionCategories: ['network'],
        activation: 'catalog',
        inputSchema: {
          type: 'object',
          properties: {
            server: {type: 'string', enum: names, description: 'Configured MCP server to activate.'},
            query: {type: 'string', minLength: 1, maxLength: 500, description: 'Capability needed from that server.'},
          },
          required: ['server', 'query'],
          additionalProperties: false,
        },
      },
      permissionCategories: () => ['network'],
      execute: async (arguments_, context) => {
        const server = typeof arguments_.server === 'string' ? arguments_.server : '';
        const query = typeof arguments_.query === 'string' ? arguments_.query.trim() : '';
        if (!names.includes(server)) throw new ToolInputError('MCP server is not available for activation');
        if (!query || query.length > 500) {
          throw new ToolInputError('MCP activation query must contain 1 to 500 characters');
        }
        const result = await this.activate(server, query, registry, context.signal);
        if (!result.ok) {
          const trust = result.status.trust;
          return {
            ok: false,
            content: trust !== 'trusted'
              ? `MCP server ${server} is ${trust}. Review it with mcp_inspect; only the user can trust it with the CLI or /mcp trust confirmation flow.`
              : `MCP server ${server} could not be activated: ${result.status.error ?? result.status.state}`,
            metadata: activationMetadata(result),
          };
        }
        const loaded = result.registeredTools.length
          ? result.registeredTools.join(', ')
          : 'no matching tool schemas';
        const deferred = result.deferredTools
          ? ` ${result.deferredTools} additional schemas remain deferred; activate again with a narrower query if needed.`
          : '';
        return {
          content: `Activated MCP server ${server}. Loaded: ${loaded}.${deferred}`,
          metadata: activationMetadata(result),
        };
      },
    };
  }

  /** Connect/discover one server, then register only request-relevant schemas. */
  async activate(
    name: string,
    query: string,
    registry: ToolRegistry,
    signal?: AbortSignal,
  ): Promise<McpActivationResult> {
    await this.ensureTrustLoaded();
    const connected = await this.connect(name, signal);
    if (!connected.ok) {
      return {...connected, registeredTools: [], availableTools: 0, deferredTools: 0};
    }
    const connection = this.connections.get(name);
    if (!connection) {
      return {...connected, ok: false, registeredTools: [], availableTools: 0, deferredTools: 0};
    }
    const tools = [...connection.tools.values()];
    const selected = tools.length <= LAZY_SCHEMA_LIMIT
      ? tools
      : selectRelevantTools(tools, query, LAZY_SCHEMA_LIMIT);
    this.registerSelectedTools(registry, selected);
    const ranked = rankRelevantTools(tools, query);
    const eagerTokens = estimateTokens(JSON.stringify(tools.map((tool) => tool.definition)));
    const loadedTokens = estimateTokens(JSON.stringify(selected.map((tool) => tool.definition)));
    return {
      ...connected,
      registeredTools: selected.map((tool) => tool.definition.name),
      availableTools: tools.length,
      deferredTools: Math.max(0, tools.length - selected.length),
      schemaBudget: {
        eagerTokens,
        loadedTokens,
        savedTokens: Math.max(0, eagerTokens - loadedTokens),
        topMatch: ranked[0]?.tool.definition.name ?? null,
        queryMatched: (ranked[0]?.score ?? 0) > 0,
      },
    };
  }

  /** Connect enabled servers with a small concurrency bound. */
  async connectAll(signal?: AbortSignal): Promise<McpConnectResult[]> {
    if (this.closed) throw new Error('MCP manager is closed');
    await this.ensureTrustLoaded();
    const configuredNames = Object.keys(this.config.servers ?? {});
    const names = configuredNames.slice(0, MAX_SERVERS);
    if (this.config.enabled === false) {
      return configuredNames.map((name) => this.resultFor(name, false, 0));
    }
    const results: McpConnectResult[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < names.length) {
        const name = names[cursor++];
        if (name === undefined) return;
        results.push(await this.connect(name, signal));
      }
    };
    await Promise.all(Array.from({length: Math.min(4, names.length)}, () => worker()));
    return configuredNames.map((name) => results.find((result) => result.name === name) ??
      this.resultFor(name, false, 0));
  }

  /** Connect one configured server. Connection errors are captured in status. */
  async connect(name: string, signal?: AbortSignal): Promise<McpConnectResult> {
    if (this.closed) throw new Error('MCP manager is closed');
    await this.ensureTrustLoaded();
    const status = this.statuses.get(name);
    if (status?.state === 'error' && status.error?.includes('server limit exceeded')) {
      return this.resultFor(name, false, 0);
    }
    if (this.requireTrust && status?.trust !== 'trusted') {
      return this.resultFor(name, false, 0);
    }
    const existing = this.pending.get(name);
    if (existing) return existing;
    const connectionController = new AbortController();
    this.connectionControllers.set(name, connectionController);
    const effectiveSignal = signal
      ? AbortSignal.any([signal, this.shutdownController.signal, connectionController.signal])
      : AbortSignal.any([this.shutdownController.signal, connectionController.signal]);
    const promise = this.connectInternal(name, effectiveSignal);
    this.pending.set(name, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(name);
      this.connectionControllers.delete(name);
    }
  }

  async disconnect(name: string): Promise<McpServerStatus> {
    this.connectionControllers.get(name)?.abort(new Error(`MCP server disconnected: ${name}`));
    const pending = this.pending.get(name);
    if (pending) await pending;
    const connection = this.connections.get(name);
    if (connection) {
      this.connections.delete(name);
      await closeQuietly(connection.client);
    }
    const current = this.statuses.get(name);
    if (!current) throw new Error(`Unknown MCP server: ${name}`);
    const status: McpServerStatus = {
      name,
      state: current.state === 'disabled' || current.state === 'revoked' || current.state === 'untrusted'
        ? current.state : 'disconnected',
      transport: current.transport,
      toolCount: 0,
      required: current.required,
      trust: current.trust,
    };
    this.statuses.set(name, status);
    return status;
  }

  /** Re-read a server's tool catalog after a list-changed notification or config edit. */
  async refresh(name: string, signal?: AbortSignal): Promise<McpConnectResult> {
    if (this.closed) throw new Error('MCP manager is closed');
    const status = this.statuses.get(name);
    if (!status) throw new Error(`Unknown MCP server: ${name}`);
    if (status.state === 'disabled' || status.state === 'revoked' || status.state === 'untrusted') {
      return this.resultFor(name, false, 0);
    }
    const pending = this.pending.get(name);
    if (pending) await pending;
    await this.disconnect(name);
    return this.connect(name, signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.shutdownController.abort(new Error('MCP manager closed'));
    const connections = [...this.connections.values()];
    this.connections.clear();
    this.toolOwners.clear();
    this.stableAdapters.clear();
    await Promise.all(connections.map((connection) => closeQuietly(connection.client)));
    // A connection may finish its handshake between the first cleanup pass and
    // the shutdown abort. Wait for those promises, then close late arrivals.
    await Promise.allSettled([...this.pending.values()]);
    const lateConnections = [...this.connections.values()];
    this.connections.clear();
    this.toolOwners.clear();
    this.stableAdapters.clear();
    await Promise.all(lateConnections.map((connection) => closeQuietly(connection.client)));
    for (const [name, status] of this.statuses) {
      this.statuses.set(name, {
        name,
        state: status.state === 'disabled' || status.state === 'revoked' || status.state === 'untrusted'
          ? status.state : 'closed',
        transport: status.transport,
        toolCount: 0,
        required: status.required,
        trust: status.trust,
      });
    }
  }

  list(): McpServerStatus[] {
    return [...this.statuses.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  status(name: string): McpServerStatus | undefined {
    const status = this.statuses.get(name);
    return status ? {...status} : undefined;
  }

  search(query = ''): Array<McpCapabilitySearchResult & {state: McpServerState; trust: McpTrustState}> {
    return searchMcpCapabilities(this.config, query).map((result) => {
      const status = this.statuses.get(result.name);
      return {
        ...result,
        state: status?.state ?? 'error',
        trust: status?.trust ?? 'untrusted',
      };
    });
  }

  inspect(name: string): McpCapabilityManifest {
    const server = this.config.servers?.[name];
    if (!server) throw new Error(`Unknown MCP server: ${name}`);
    return buildMcpCapabilityManifest(name, server, this.workspace);
  }

  fingerprint(name: string): string {
    const server = this.config.servers?.[name];
    if (!server) throw new Error(`Unknown MCP server: ${name}`);
    return capabilityFingerprint(name, server, this.workspace);
  }

  async trust(name: string): Promise<McpServerStatus> {
    const server = this.config.servers?.[name];
    if (!server) throw new Error(`Unknown MCP server: ${name}`);
    if (this.config.enabled === false || server.enabled === false) {
      throw new Error(`MCP server is disabled by configuration: ${name}`);
    }
    if (this.inspect(name).dynamicTools) {
      throw new Error(`MCP capability ${name} cannot be trusted until its tools and effects are declared.`);
    }
    await this.trustStore.trust(this.workspace, name, this.fingerprint(name));
    this.trustLoaded = true;
    return this.setStatus(name, {
      state: 'disconnected',
      trust: 'trusted',
      required: server.required === true,
      transport: server.transport ?? 'stdio',
      toolCount: 0,
    });
  }

  async disable(name: string): Promise<McpServerStatus> {
    const server = this.config.servers?.[name];
    if (!server) throw new Error(`Unknown MCP server: ${name}`);
    await this.disconnect(name);
    this.unregisterServerTools(name);
    await this.trustStore.disable(this.workspace, name, this.fingerprint(name));
    return this.setStatus(name, {
      state: 'disabled',
      trust: 'disabled',
      required: server.required === true,
      toolCount: 0,
    });
  }

  async revoke(name: string): Promise<McpServerStatus> {
    const server = this.config.servers?.[name];
    if (!server) throw new Error(`Unknown MCP server: ${name}`);
    await this.disconnect(name);
    this.unregisterServerTools(name);
    await this.trustStore.revoke(this.workspace, name, this.fingerprint(name));
    return this.setStatus(name, {
      state: 'revoked',
      trust: 'revoked',
      required: server.required === true,
      toolCount: 0,
    });
  }

  tools(): AgentTool[] {
    return [...this.connections.values()]
      .flatMap((connection) => [...connection.tools.values()])
      .sort((a, b) => a.definition.name.localeCompare(b.definition.name));
  }

  getTools(): AgentTool[] {
    return this.tools();
  }

  /** Register connected MCP tools, preserving idempotency for the same adapter. */
  registerTools(registry: ToolRegistry): string[] {
    return this.registerSelectedTools(registry, this.tools());
  }

  private registerSelectedTools(registry: ToolRegistry, tools: AgentTool[]): string[] {
    this.registries.add(registry);
    const registered: string[] = [];
    for (const tool of tools) {
      const existing = registry.get(tool.definition.name);
      if (existing) {
        if (existing !== tool) {
          throw new Error(`MCP tool name collides with an existing tool: ${tool.definition.name}`);
        }
        continue;
      }
      registry.register(tool);
      registered.push(tool.definition.name);
    }
    return registered;
  }

  private unregisterServerTools(name: string): void {
    for (const [identity, tool] of this.stableAdapters) {
      if (!identity.startsWith(`${name}\u0000`)) continue;
      for (const registry of this.registries) {
        registry.unregister(tool.definition.name, tool);
      }
    }
  }

  private catalogServerNames(): string[] {
    return [...this.statuses.values()]
      .filter((status) => !status.error?.includes('server limit exceeded'))
      .map((status) => status.name)
      .sort((left, right) => left.localeCompare(right));
  }

  private async ensureTrustLoaded(): Promise<void> {
    if (this.trustLoaded) return;
    for (const [name, server] of Object.entries(this.config.servers ?? {}).slice(0, MAX_SERVERS)) {
      const current = this.statuses.get(name);
      if (!current) continue;
      if (this.config.enabled === false || server.enabled === false) {
        this.setStatus(name, {state: 'disabled', trust: 'disabled', toolCount: 0});
        continue;
      }
      if (!this.requireTrust) {
        this.setStatus(name, {state: 'disconnected', trust: 'trusted', toolCount: 0});
        continue;
      }
      const trust = await this.trustStore.state(this.workspace, name, this.fingerprint(name));
      this.setStatus(name, {
        state: trust === 'trusted' ? 'disconnected' : trust,
        trust,
        toolCount: 0,
      });
    }
    this.trustLoaded = true;
  }

  private async connectInternal(name: string, signal?: AbortSignal): Promise<McpConnectResult> {
    const configured = this.config.servers?.[name];
    if (!configured) throw new Error(`Unknown MCP server: ${name}`);
    const transportKind = configured.transport ?? 'stdio';
    if (transportKind !== 'stdio' && transportKind !== 'http') {
      const status = this.setStatus(name, {
        state: 'error',
        transport: 'stdio',
        toolCount: 0,
        error: `Unsupported MCP transport: ${String(transportKind)}`,
      });
      return {name, ok: false, status, skippedTools: 0};
    }
    if (this.config.enabled === false || configured.enabled === false) {
      const status = this.setStatus(name, {
        state: 'disabled',
        trust: 'disabled',
        transport: transportKind,
        toolCount: 0,
      });
      return {name, ok: false, status, skippedTools: 0};
    }
    if (this.connections.has(name)) {
      return this.resultFor(name, true, 0);
    }
    this.setStatus(name, {state: 'connecting', transport: transportKind, toolCount: 0});

    let client: McpClientLike | undefined;
    let transport: Transport | undefined;
    let closedDuringConnect = false;
    try {
      assertMcpServerName(name);
    } catch (error) {
      const status = this.setStatus(name, {
        state: 'error',
        transport: transportKind,
        toolCount: 0,
        error: errorMessage(error),
      });
      return {name, ok: false, status, skippedTools: 0};
    }
    try {
      const validated = transportKind === 'stdio'
        ? await validateStdioConfig(configured, this.options)
        : validateHttpConfig(configured, this.options);
      transport = await this.createTransport(name, configured, validated);
      client = this.options.clientFactory?.(name) ?? new Client(
        {
          name: this.options.clientName ?? 'skein',
          version: this.options.clientVersion ?? '0.1.0',
        },
        {capabilities: {}},
      );
      client.onclose = () => {
        closedDuringConnect = true;
        this.handleUnexpectedClose(name);
      };
      client.onerror = (error) => {
        this.options.logger?.(`MCP server ${name} reported an error`, {error: errorMessage(error)});
      };
      const timeoutMs = boundedTimeout(
        configured.timeoutMs ?? this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT,
        DEFAULT_CONNECT_TIMEOUT,
      );
      await withTimeout(
        client.connect(transport, requestOptions(timeoutMs, signal)),
        timeoutMs,
        signal,
      );
      const listed = await this.listRemoteTools(client, timeoutMs, signal);
      if (closedDuringConnect) throw new Error('MCP server closed during connection setup');
      const toolMap = this.buildAdapters(name, configured, listed.tools);
      const undeclaredTools = configured.tools?.length
        ? listed.tools.filter((tool) => !configured.tools?.some((declared) => declared.name === tool.name)).length
        : 0;
      const connection: Connection = {
        name,
        client,
        transport,
        tools: toolMap,
        remoteTools: listed.tools,
      };
      this.connections.set(name, connection);
      const version = client.getServerVersion?.();
      const statusPatch: Partial<McpServerStatus> = {
        state: 'connected',
        transport: transportKind,
        toolCount: toolMap.size,
        connectedAt: new Date().toISOString(),
      };
      if (version) {
        statusPatch.serverVersion = sanitizeStatusText(
          [version.name, version.version].filter(Boolean).join(' '),
        );
      }
      const status = this.setStatus(name, statusPatch);
      return {
        name,
        ok: true,
        status,
        skippedTools: listed.skippedTools + listed.truncatedTools + undeclaredTools,
      };
    } catch (error) {
      if (client) await closeQuietly(client);
      else if (transport) await closeTransportQuietly(transport);
      const status = this.setStatus(name, {
        state: 'error',
        transport: transportKind,
        toolCount: 0,
        error: errorMessage(error),
      });
      this.options.logger?.(`MCP server ${name} failed to connect`, {error: status.error ?? 'unknown error'});
      return {name, ok: false, status, skippedTools: 0};
    }
  }

  private async createTransport(
    name: string,
    config: McpServerConfig,
    validated: ValidatedStdioConfig | ValidatedHttpConfig,
  ): Promise<Transport> {
    if (this.options.transportFactory) {
      return this.options.transportFactory(name, config, validated);
    }
    if (config.transport === 'http') {
      const http = validated as ValidatedHttpConfig;
      return new StreamableHTTPClientTransport(http.url, {
        requestInit: {headers: http.headers},
        reconnectionOptions: {
          maxReconnectionDelay: 2_000,
          initialReconnectionDelay: 100,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 0,
        },
      }) as unknown as Transport;
    }
    const stdio = validated as ValidatedStdioConfig;
    const transport = new StdioClientTransport({
      command: stdio.command,
      args: stdio.args,
      cwd: stdio.cwd,
      env: stdio.env,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString()).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .trim();
      if (text) this.options.logger?.(`MCP ${name} stderr`, {text: text.slice(0, 2_000)});
    });
    return transport;
  }

  private async listRemoteTools(
    client: McpClientLike,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{tools: McpRemoteTool[]; skippedTools: number; truncatedTools: number}> {
    const tools: McpRemoteTool[] = [];
    const remoteNames = new Set<string>();
    let skippedTools = 0;
    let listedTools = 0;
    let cursor: string | undefined;
    let hitPageLimit = true;
    for (let page = 0; page < MAX_LIST_PAGES && tools.length < MAX_TOOLS_PER_SERVER; page += 1) {
      const response = await withTimeout(
        client.listTools(cursor ? {cursor} : undefined, requestOptions(timeoutMs, signal)),
        timeoutMs,
        signal,
      );
      for (const tool of response.tools as McpSdkTool[]) {
        listedTools += 1;
        if (tools.length >= MAX_TOOLS_PER_SERVER) continue;
        if (!isUsableRemoteTool(tool) || remoteNames.has(tool.name)) {
          skippedTools += 1;
          continue;
        }
        tools.push(tool);
        remoteNames.add(tool.name);
      }
      const next = response.nextCursor;
      if (!next || next === cursor) {
        hitPageLimit = false;
        break;
      }
      cursor = next;
    }
    return {
      tools,
      skippedTools,
      truncatedTools: hitPageLimit || listedTools > MAX_TOOLS_PER_SERVER
        ? Math.max(0, listedTools - tools.length - skippedTools)
        : 0,
    };
  }

  private buildAdapters(
    serverName: string,
    config: McpServerConfig,
    remoteTools: McpRemoteTool[],
  ): Map<string, AgentTool> {
    const namespace = config.toolPrefix ?? serverName;
    const result = new Map<string, AgentTool>();
    const seen = new Set<string>();
    const timeoutMs = boundedTimeout(
      config.timeoutMs ?? this.config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT,
      DEFAULT_TOOL_TIMEOUT,
    );
    for (const remoteTool of remoteTools) {
      const capability = declaredToolCapability(config, remoteTool.name, this.workspace);
      // Once a manifest names tools, schemas injected by the server are not
      // silently promoted into the reviewed capability set.
      if (config.tools?.length && !capability) continue;
      let exposedName = makeMcpToolName(namespace, remoteTool.name);
      const identity = `${serverName}\u0000${remoteTool.name}`;
      if (seen.has(exposedName) || this.isToolNameOwnedByAnother(exposedName, identity)) {
        exposedName = disambiguateMcpToolName(exposedName, serverName, remoteTool.name);
      }
      let collision = 0;
      while (seen.has(exposedName) || this.isToolNameOwnedByAnother(exposedName, identity)) {
        collision += 1;
        exposedName = disambiguateMcpToolName(
          `${makeMcpToolName(namespace, remoteTool.name)}_${collision}`,
          serverName,
          `${remoteTool.name}_${collision}`,
        );
      }
      const callTool: McpCallTool = (params, options) => {
        const active = this.connections.get(serverName);
        if (!active) throw new Error(`MCP server is not connected: ${serverName}`);
        if (!active.remoteTools.some((tool) => tool.name === params.name)) {
          throw new Error(`MCP tool is no longer available: ${serverName}/${params.name}`);
        }
        return active.client.callTool(params, undefined, options);
      };
      let adapter = this.stableAdapters.get(identity);
      if (!adapter) {
        adapter = createMcpToolAdapter({
          serverName,
          exposedName,
          remoteTool,
          timeoutMs,
          callTool,
          ...(capability ? {capability} : {}),
        });
        this.stableAdapters.set(identity, adapter);
      }
      result.set(exposedName, adapter);
      seen.add(exposedName);
      this.toolOwners.set(exposedName, identity);
    }
    return result;
  }

  private isToolNameOwnedByAnother(toolName: string, identity: string): boolean {
    const owner = this.toolOwners.get(toolName);
    return owner !== undefined && owner !== identity;
  }

  private handleUnexpectedClose(name: string): void {
    const connection = this.connections.get(name);
    if (!connection) return;
    this.connections.delete(name);
    const current = this.statuses.get(name);
    if (current && current.state !== 'closed') {
      this.setStatus(name, {
        state: 'disconnected',
        transport: current.transport,
        toolCount: 0,
        error: 'MCP server closed the connection',
      });
    }
  }

  private setStatus(name: string, patch: Partial<McpServerStatus>): McpServerStatus {
    const current = this.statuses.get(name);
    const status: McpServerStatus = {
      name,
      state: patch.state ?? current?.state ?? 'disconnected',
      transport: patch.transport ?? current?.transport ?? 'stdio',
      toolCount: patch.toolCount ?? current?.toolCount ?? 0,
      required: patch.required ?? current?.required ?? false,
      trust: patch.trust ?? current?.trust ?? 'untrusted',
      ...(patch.connectedAt !== undefined ? {connectedAt: patch.connectedAt} :
        current?.connectedAt !== undefined ? {connectedAt: current.connectedAt} : {}),
      ...(patch.serverVersion !== undefined ? {serverVersion: patch.serverVersion} :
        current?.serverVersion !== undefined ? {serverVersion: current.serverVersion} : {}),
      ...(patch.error !== undefined ? {error: patch.error} : {}),
    };
    this.statuses.set(name, status);
    return status;
  }

  private resultFor(name: string, ok: boolean, skippedTools: number): McpConnectResult {
    const status = this.statuses.get(name);
    if (!status) throw new Error(`Unknown MCP server: ${name}`);
    return {name, ok, status: {...status}, skippedTools};
  }
}

function activationMetadata(result: McpActivationResult): Record<string, unknown> {
  return {
    mcpServer: result.name,
    state: result.status.state,
    availableTools: result.availableTools,
    loadedTools: result.registeredTools,
    deferredTools: result.deferredTools,
    skippedTools: result.skippedTools,
    ...(result.schemaBudget ? {schemaBudget: result.schemaBudget} : {}),
  };
}

function selectRelevantTools(tools: AgentTool[], query: string, limit: number): AgentTool[] {
  return rankRelevantTools(tools, query).slice(0, limit).map(({tool}) => tool);
}

export function rankRelevantTools(
  tools: AgentTool[],
  query: string,
): Array<{tool: AgentTool; score: number}> {
  const terms = new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);
  return tools.map((tool) => {
    const searchable = `${tool.definition.name.replaceAll('_', ' ')} ${tool.definition.description}`
      .toLocaleLowerCase();
    let score = 0;
    for (const term of terms) if (searchable.includes(term)) score += term.length;
    return {tool, score};
  }).sort((left, right) => right.score - left.score ||
    left.tool.definition.name.localeCompare(right.tool.definition.name));
}

function sanitizeCatalogText(value: string | undefined): string {
  return value ? stripAnsi(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) : '';
}

function requestOptions(timeoutMs: number, signal?: AbortSignal): RequestOptions {
  return {
    timeout: timeoutMs,
    maxTotalTimeout: timeoutMs,
    ...(signal ? {signal} : {}),
  };
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? abortError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs);
    onAbort = () => reject(signal?.reason ?? abortError());
    signal?.addEventListener('abort', onAbort, {once: true});
  });
  try {
    return await Promise.race([operation, abort]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(100, Math.min(300_000, Math.floor(value)));
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeStatusText(message) || 'Unknown MCP error';
}

function sanitizeStatusText(value: string): string {
  return stripAnsi(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1_000);
}

function timeoutError(timeoutMs: number): Error {
  const error = new Error(`MCP request timed out after ${timeoutMs} ms`);
  error.name = 'TimeoutError';
  return error;
}

function abortError(): Error {
  const error = new Error('MCP request aborted');
  error.name = 'AbortError';
  return error;
}

async function closeQuietly(client: Pick<McpClientLike, 'close'>): Promise<void> {
  try {
    await client.close();
  } catch {
    // Cleanup must not mask the original connection error.
  }
}

async function closeTransportQuietly(transport: Transport): Promise<void> {
  try {
    await transport.close();
  } catch {
    // Cleanup must not mask the original connection error.
  }
}
