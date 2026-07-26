import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {readFile, stat} from 'node:fs/promises';
import {extname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {z} from 'zod';
import type {LspConfig, LspServerConfig} from '../types.js';
import {resolveExecutableRuntime} from '../utils/process.js';
import {jsonSchema, type AgentTool, type ToolExecutionContext} from './types.js';

const MAX_PROTOCOL_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const inputSchema = z.object({
  operation: z.enum(['definition', 'references', 'diagnostics']),
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  character: z.number().int().nonnegative().optional(),
}).strict().superRefine((value, context) => {
  if (value.operation !== 'diagnostics' && value.line === undefined) {
    context.addIssue({code: 'custom', path: ['line'], message: 'line is required for definition and references'});
  }
});

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {code?: number; message?: string};
}

interface LspPosition {line: number; character: number}
interface LspRange {start: LspPosition; end: LspPosition}
interface LspLocation {uri?: string; range?: LspRange; targetUri?: string; targetRange?: LspRange; targetSelectionRange?: LspRange}
interface LspDiagnostic {range?: LspRange; severity?: number; code?: string | number; source?: string; message?: string}

export function createLspTool(config: LspConfig): AgentTool {
  return {
    definition: {
      name: 'lsp_query',
      description: 'Query an explicitly configured local language server for definitions, references, or diagnostics. Read-only and optional.',
      category: 'read',
      inputSchema: jsonSchema({
        operation: {type: 'string', enum: ['definition', 'references', 'diagnostics']},
        path: {type: 'string', description: 'Workspace-relative source file.'},
        line: {type: 'integer', minimum: 1, description: 'One-based line; required for definition and references.'},
        character: {type: 'integer', minimum: 0, description: 'Zero-based UTF-16 character offset.'},
      }, ['operation', 'path']),
    },
    async execute(arguments_, context) {
      const input = inputSchema.parse(arguments_);
      const path = await context.workspace.resolvePath(input.path, {expect: 'file'});
      const info = await stat(path);
      if (info.size > MAX_FILE_BYTES) throw new Error('LSP source file exceeds the 2 MiB safety limit.');
      const server = serverForPath(config, path);
      if (!server) throw new Error(`No enabled LSP server is configured for ${extname(path) || 'this file type'}.`);
      const executable = await resolveExecutableRuntime(server.command, context.workspace.primaryRoot, context.workspace.roots);
      if (!executable) throw new Error(`LSP server ${server.command} is unavailable or resolves inside the workspace.`);
      const text = await readFile(path, 'utf8');
      if (text.includes('\u0000')) throw new Error('LSP source file must be UTF-8 text.');
      const client = new LspClient({
        command: executable.executable,
        args: server.args,
        path: executable.path,
        cwd: context.workspace.primaryRoot,
        timeoutMs: config.timeoutMs,
        ...(context.signal ? {signal: context.signal} : {}),
      });
      try {
        const capabilities = await client.initialize(context.workspace.primaryRoot);
        const uri = pathToFileURL(path).href;
        client.notify('textDocument/didOpen', {
          textDocument: {uri, languageId: server.languageId, version: 1, text},
        });
        if (input.operation === 'diagnostics') {
          const diagnostics = await diagnosticsFor(client, capabilities, uri, config.timeoutMs);
          return {
            content: formatDiagnostics(context.workspace.display(path), diagnostics),
            metadata: {operation: input.operation, server: server.name, count: diagnostics.length},
          };
        }
        const position = {line: (input.line as number) - 1, character: input.character ?? 0};
        const method = input.operation === 'definition'
          ? 'textDocument/definition'
          : 'textDocument/references';
        const params = input.operation === 'references'
          ? {textDocument: {uri}, position, context: {includeDeclaration: true}}
          : {textDocument: {uri}, position};
        const response = await client.request(method, params);
        const locations = await normalizeLocations(response, context);
        return {
          content: formatLocations(input.operation, context.workspace.display(path), input.line as number, position.character, locations.items, locations.discarded),
          metadata: {
            operation: input.operation,
            server: server.name,
            count: locations.items.length,
            discarded: locations.discarded,
          },
        };
      } finally {
        await client.close();
      }
    },
  };
}

function serverForPath(config: LspConfig, path: string): (LspServerConfig & {name: string}) | undefined {
  const extension = extname(path).toLocaleLowerCase();
  for (const [name, server] of Object.entries(config.servers)) {
    if (server.extensions.some((candidate) => candidate.toLocaleLowerCase() === extension)) {
      return {...server, name};
    }
  }
  return undefined;
}

async function diagnosticsFor(
  client: LspClient,
  capabilities: Record<string, unknown>,
  uri: string,
  timeoutMs: number,
): Promise<LspDiagnostic[]> {
  if (capabilities.diagnosticProvider) {
    const response = await client.request('textDocument/diagnostic', {textDocument: {uri}});
    if (response && typeof response === 'object' && !Array.isArray(response)) {
      const items = (response as Record<string, unknown>).items;
      if (Array.isArray(items)) return items.filter(isDiagnostic).slice(0, 200);
    }
  }
  const notification = await client.waitForNotification('textDocument/publishDiagnostics', (params) =>
    Boolean(params && typeof params === 'object' && (params as Record<string, unknown>).uri === uri), timeoutMs);
  const diagnostics = notification && typeof notification === 'object'
    ? (notification as Record<string, unknown>).diagnostics
    : undefined;
  return Array.isArray(diagnostics) ? diagnostics.filter(isDiagnostic).slice(0, 200) : [];
}

async function normalizeLocations(
  value: unknown,
  context: ToolExecutionContext,
): Promise<{items: Array<{path: string; range: LspRange}>; discarded: number}> {
  const candidates = (Array.isArray(value) ? value : value ? [value] : [])
    .filter((item): item is LspLocation => Boolean(item && typeof item === 'object'));
  const items: Array<{path: string; range: LspRange}> = [];
  let discarded = 0;
  for (const candidate of candidates.slice(0, 200)) {
    const uri = candidate.uri ?? candidate.targetUri;
    const range = candidate.range ?? candidate.targetSelectionRange ?? candidate.targetRange;
    if (!uri || !range || !validRange(range)) {
      discarded += 1;
      continue;
    }
    try {
      const path = fileURLToPath(uri);
      const resolved = await context.workspace.resolvePath(path, {expect: 'file'});
      if (items.length < 100) items.push({path: context.workspace.display(resolved), range});
      else discarded += 1;
    } catch {
      discarded += 1;
    }
  }
  return {items, discarded};
}

function formatLocations(
  operation: 'definition' | 'references',
  source: string,
  line: number,
  character: number,
  items: Array<{path: string; range: LspRange}>,
  discarded: number,
): string {
  const heading = `LSP ${operation} ${source}:${line}:${character}`;
  if (!items.length) return `${heading}\nNo workspace locations returned.${discarded ? ` ${discarded} unsafe or excess location(s) omitted.` : ''}`;
  return [heading, ...items.map((item) =>
    `- ${item.path}:${item.range.start.line + 1}:${item.range.start.character}-${item.range.end.line + 1}:${item.range.end.character}`),
  ...(discarded ? [`${discarded} unsafe or excess location(s) omitted.`] : [])].join('\n');
}

function formatDiagnostics(path: string, diagnostics: LspDiagnostic[]): string {
  const heading = `LSP diagnostics ${path}`;
  if (!diagnostics.length) return `${heading}\nNo diagnostics returned.`;
  return [heading, ...diagnostics.map((item) => {
    const range = item.range && validRange(item.range) ? item.range : {start: {line: 0, character: 0}, end: {line: 0, character: 0}};
    const severity = ['unknown', 'error', 'warning', 'information', 'hint'][item.severity ?? 0] ?? 'unknown';
    const message = sanitizeMessage(item.message ?? 'Diagnostic without a message');
    const code = item.code === undefined ? '' : ` ${sanitizeMessage(String(item.code)).slice(0, 80)}`;
    const source = item.source ? ` ${sanitizeMessage(item.source).slice(0, 80)}` : '';
    return `- ${severity} ${range.start.line + 1}:${range.start.character}${source}${code} ${message}`;
  })].join('\n');
}

function isDiagnostic(value: unknown): value is LspDiagnostic {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validRange(value: LspRange): boolean {
  return validPosition(value.start) && validPosition(value.end);
}

function validPosition(value: LspPosition): boolean {
  return Number.isInteger(value?.line) && value.line >= 0 && Number.isInteger(value?.character) && value.character >= 0;
}

function sanitizeMessage(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 500);
}

class LspClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private observedBytes = 0;
  private nextId = 1;
  private stderr = '';
  private closed = false;
  private readonly pending = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout}>();
  private readonly notifications = new Map<string, unknown[]>();
  private readonly waiters = new Map<string, Array<{predicate: (params: unknown) => boolean; resolve: (params: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout}>>();

  constructor(private readonly options: {
    command: string;
    args: string[];
    path: string;
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }) {}

  async initialize(workspace: string): Promise<Record<string, unknown>> {
    await this.start();
    const rootUri = pathToFileURL(workspace).href;
    const response = await this.request('initialize', {
      processId: null,
      rootUri,
      workspaceFolders: [{uri: rootUri, name: workspace.split(/[\\/]/u).at(-1) ?? 'workspace'}],
      capabilities: {
        textDocument: {definition: {}, references: {}, diagnostic: {}},
        workspace: {configuration: false, workspaceFolders: true},
      },
    });
    this.notify('initialized', {});
    if (!response || typeof response !== 'object' || Array.isArray(response)) return {};
    const capabilities = (response as Record<string, unknown>).capabilities;
    return capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)
      ? capabilities as Record<string, unknown>
      : {};
  }

  request(method: string, params: unknown, timeoutMs = this.options.timeoutMs): Promise<unknown> {
    if (!this.child || this.closed) return Promise.reject(new Error('LSP server is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`LSP request timed out: ${method}`);
        this.terminateChild();
        this.failAll(error);
      }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      this.send({jsonrpc: '2.0', id, method, params});
    });
  }

  notify(method: string, params: unknown): void {
    if (this.child && !this.closed) this.send({jsonrpc: '2.0', method, params});
  }

  waitForNotification(
    method: string,
    predicate: (params: unknown) => boolean,
    timeoutMs: number,
  ): Promise<unknown> {
    const existing = this.notifications.get(method) ?? [];
    const index = existing.findIndex(predicate);
    if (index >= 0) return Promise.resolve(existing.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.waiters.get(method) ?? [];
        this.waiters.set(method, waiters.filter((waiter) => waiter.resolve !== resolve));
        reject(new Error(`LSP notification timed out: ${method}`));
      }, timeoutMs);
      this.waiters.set(method, [...(this.waiters.get(method) ?? []), {predicate, resolve, reject, timer}]);
    });
  }

  async close(): Promise<void> {
    if (!this.child || this.closed) return;
    try {
      await this.request('shutdown', null, Math.min(1_000, this.options.timeoutMs));
      this.notify('exit', null);
    } catch {
      // A failed language server is still terminated below.
    }
    this.closed = true;
    this.terminateChild();
  }

  private start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        env: lspEnvironment(this.options.path),
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(this.options.signal ? {signal: this.options.signal} : {}),
      });
      this.child = child;
      child.once('spawn', resolve);
      child.once('error', (error) => {
        this.failAll(error);
        reject(error);
      });
      child.stdin.on('error', (error) => {
        this.terminateChild();
        this.failAll(error);
      });
      child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        if (this.stderr.length < 4_000) this.stderr += chunk.toString('utf8').slice(0, 4_000 - this.stderr.length);
      });
      child.on('close', (code) => this.failAll(new Error(
        `LSP server exited with status ${code ?? 1}${this.stderr.trim() ? `: ${sanitizeMessage(this.stderr)}` : ''}`,
      )));
    });
  }

  private receive(chunk: Buffer): void {
    this.observedBytes += chunk.length;
    if (this.observedBytes > MAX_PROTOCOL_BYTES) {
      this.terminateChild();
      this.failAll(new Error('LSP server exceeded the 4 MiB protocol output limit.'));
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/iu);
      const length = match?.[1] ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PROTOCOL_BYTES) {
        this.terminateChild();
        this.failAll(new Error('LSP server returned an invalid Content-Length header.'));
        return;
      }
      const frameEnd = headerEnd + 4 + length;
      if (this.buffer.length < frameEnd) return;
      const body = this.buffer.subarray(headerEnd + 4, frameEnd).toString('utf8');
      this.buffer = this.buffer.subarray(frameEnd);
      try {
        this.handle(JSON.parse(body) as JsonRpcMessage);
      } catch {
        this.terminateChild();
        this.failAll(new Error('LSP server returned malformed JSON-RPC.'));
        return;
      }
    }
  }

  private handle(message: JsonRpcMessage): void {
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`LSP error ${message.error.code ?? ''}: ${sanitizeMessage(message.error.message ?? 'unknown error')}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) {
      this.send({jsonrpc: '2.0', id: message.id, result: message.method === 'workspace/configuration' ? [] : null});
      return;
    }
    if (!message.method) return;
    const waiters = this.waiters.get(message.method) ?? [];
    const waiter = waiters.find((candidate) => candidate.predicate(message.params));
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.set(message.method, waiters.filter((candidate) => candidate !== waiter));
      waiter.resolve(message.params);
    } else {
      const retained = [...(this.notifications.get(message.method) ?? []), message.params].slice(-16);
      this.notifications.set(message.method, retained);
    }
  }

  private send(message: JsonRpcMessage): void {
    const content = JSON.stringify(message);
    try {
      this.child?.stdin.write(
        `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`,
        (error) => {
          if (error) {
            this.terminateChild();
            this.failAll(error);
          }
        },
      );
    } catch (error) {
      this.terminateChild();
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private failAll(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiters of this.waiters.values()) for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private terminateChild(): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1_000);
    force.unref();
    child.once('close', () => clearTimeout(force));
  }
}

function lspEnvironment(path: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {PATH: path};
  for (const name of [
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SystemRoot', 'WINDIR', 'PATHEXT',
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}
