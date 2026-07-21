import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {RequestOptions} from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {Tool as McpSdkTool} from '@modelcontextprotocol/sdk/types.js';
import stripAnsi from 'strip-ansi';
import type {McpConfig, McpServerConfig} from '../types.js';
import type {ToolRegistry, AgentTool} from '../tools/index.js';
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

const MAX_SERVERS = 32;
const MAX_TOOLS_PER_SERVER = 256;
const MAX_LIST_PAGES = 16;
const DEFAULT_CONNECT_TIMEOUT = 12_000;
const DEFAULT_TOOL_TIMEOUT = 60_000;

export type McpServerState = 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'error' | 'closed';

export interface McpServerStatus {
  name: string;
  state: McpServerState;
  transport: 'stdio' | 'http';
  toolCount: number;
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

export interface McpManagerOptions extends McpValidationOptions {
  clientName?: string;
  clientVersion?: string;
  logger?: (message: string, details?: Record<string, unknown>) => void;
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
  private readonly options: McpManagerOptions;
  private readonly shutdownController = new AbortController();
  private closed = false;

  constructor(
    private readonly config: McpConfig,
    options: McpManagerOptions = {},
  ) {
    this.options = options;
    for (const [name, server] of Object.entries(config.servers ?? {})) {
      const transport = server.transport ?? 'stdio';
      const state: McpServerState = config.enabled === false || server.enabled === false
        ? 'disabled'
        : 'disconnected';
      this.statuses.set(name, {name, state, transport, toolCount: 0});
    }
  }

  /** Connect enabled servers with a small concurrency bound. */
  async connectAll(signal?: AbortSignal): Promise<McpConnectResult[]> {
    if (this.closed) throw new Error('MCP manager is closed');
    const configuredNames = Object.keys(this.config.servers ?? {});
    const names = configuredNames.slice(0, MAX_SERVERS);
    if (this.config.enabled === false) {
      return configuredNames.map((name) => this.resultFor(name, false, 0));
    }
    for (const name of configuredNames.slice(MAX_SERVERS)) {
      const server = this.config.servers[name];
      this.setStatus(name, {
        state: 'error',
        transport: server?.transport ?? 'stdio',
        toolCount: 0,
        error: `MCP server limit exceeded (maximum ${MAX_SERVERS})`,
      });
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
      state: current.state === 'disabled' ? 'disabled' : 'disconnected',
      transport: current.transport,
      toolCount: 0,
    };
    this.statuses.set(name, status);
    return status;
  }

  /** Re-read a server's tool catalog after a list-changed notification or config edit. */
  async refresh(name: string, signal?: AbortSignal): Promise<McpConnectResult> {
    if (this.closed) throw new Error('MCP manager is closed');
    const status = this.statuses.get(name);
    if (!status) throw new Error(`Unknown MCP server: ${name}`);
    if (status.state === 'disabled') return this.resultFor(name, false, 0);
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
        state: status.state === 'disabled' ? 'disabled' : 'closed',
        transport: status.transport,
        toolCount: 0,
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
    const registered: string[] = [];
    for (const tool of this.tools()) {
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
      const status = this.setStatus(name, {state: 'disabled', transport: transportKind, toolCount: 0});
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
      return {name, ok: true, status, skippedTools: listed.skippedTools + listed.truncatedTools};
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
