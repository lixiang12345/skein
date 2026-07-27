import type {AgentModelRoute, AgentTeamConfig, ConnectionApiKeyHeader} from '../types.js';
import {resolveExecutableRuntime, runProcess, type ProcessResult} from '../utils/process.js';
import {resolveConnectionHeaders, withoutConnectionCredentialHeader} from './connection-auth.js';

export type ExternalAgentRuntime = Exclude<NonNullable<AgentModelRoute['runtime']>, 'api'>;
export type ExternalAgentAccess = 'read-only' | 'workspace-write';

export interface ExternalAgentProgress {
  stage: 'tool';
  tool: string;
  toolCalls: number;
}

export interface ExternalProviderEnvironment {
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKeyHeader?: ConnectionApiKeyHeader;
  /** Runtime-only resolved credential; never persisted or logged. */
  credential?: string;
  /** Explicit no-auth connection; suppresses ambient Anthropic credentials. */
  authNone?: boolean;
  /** Runtime-only non-credential headers resolved from the named connection. */
  customHeaders?: Record<string, string>;
}

export interface ExternalAgentRequest {
  runtime: ExternalAgentRuntime;
  model: string;
  workspace: string;
  prompt: string;
  access?: ExternalAgentAccess;
  timeoutMs?: number;
  costBudgetUsd?: number;
  providerEnvironment?: ExternalProviderEnvironment;
  signal?: AbortSignal;
  onProgress?: (progress: ExternalAgentProgress) => void;
}

export interface ExternalAgentResult {
  content: string;
  runtime: ExternalAgentRuntime;
  model: string;
  durationMs: number;
  usage?: {inputTokens: number; outputTokens: number};
  toolCalls?: number;
}

/** Resolve one configured external route without exposing credential values to callers or logs. */
export async function resolveExternalProviderEnvironment(
  route: AgentModelRoute | undefined,
  connections: AgentTeamConfig['connections'],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ExternalProviderEnvironment | undefined> {
  if (!route) return undefined;
  const connection = route.connection ? connections?.[route.connection] : undefined;
  if (route.connection && !connection) {
    throw new Error(`Unknown agent model connection: ${route.connection}`);
  }
  const connectionAuth = connection?.auth;
  const baseUrl = route.baseUrl ?? connection?.baseUrl;
  const apiKeyEnv = route.apiKeyEnv ?? connection?.apiKeyEnv;
  if (connectionAuth?.type !== 'none' && connectionAuth?.placement) {
    throw new Error('External Claude routes support bearer or x-api-key credential placement, not a custom header.');
  }
  const apiKeyHeader = connectionAuth?.type !== 'none' ? connectionAuth?.header : undefined;
  const credentialAuth = apiKeyEnv
    ? {type: 'env' as const, name: apiKeyEnv, ...(apiKeyHeader ? {header: apiKeyHeader} : {})}
    : connectionAuth;
  const credentialResolution = credentialAuth && credentialAuth.type !== 'none'
    ? await resolveConnectionHeaders(credentialAuth, connection?.headers, {environment})
    : connection?.headers ? await resolveConnectionHeaders({type: 'none'}, connection.headers, {environment})
      : undefined;
  const customHeaders = credentialResolution && credentialAuth
    ? withoutConnectionCredentialHeader(credentialAuth, credentialResolution.headers)
    : credentialResolution?.headers;
  const authNone = connectionAuth?.type === 'none' && !apiKeyEnv;
  if (!baseUrl && !apiKeyEnv && !apiKeyHeader && !credentialResolution && !authNone) return undefined;
  return {
    ...(baseUrl ? {baseUrl} : {}),
    ...(apiKeyHeader ? {apiKeyHeader} : {}),
    ...(credentialResolution?.value ? {credential: credentialResolution.value} : {}),
    ...(authNone ? {authNone: true} : {}),
    ...(customHeaders && Object.keys(customHeaders).length ? {customHeaders} : {}),
  };
}

export async function runExternalAgent(request: ExternalAgentRequest): Promise<ExternalAgentResult> {
  const command = externalAgentCommand(request);
  const executable = await resolveExecutableRuntime(command.binary, request.workspace, [request.workspace]);
  if (!executable) throw new Error(`${command.binary} CLI is not installed or resolves inside the workspace.`);
  const progress = createExternalAgentProgressObserver(request.runtime, request.onProgress);
  const result = await runProcess(executable.executable, command.args, {
    cwd: request.workspace,
    inheritEnv: false,
    env: externalRuntimeEnvironment(request.runtime, executable.path, process.env, request.providerEnvironment),
    timeoutMs: request.timeoutMs ?? 180_000,
    maxOutputBytes: 2_000_000,
    ...(request.signal ? {signal: request.signal} : {}),
    ...(progress ? {onStdout: progress.onChunk} : {}),
  });
  progress?.flush();
  const failure = externalAgentFailure(request.runtime, result);
  if (failure) throw failure;
  const content = parseExternalAgentOutput(request.runtime, result.stdout);
  if (!content) throw new Error(`${request.runtime} agent returned no final report.`);
  const telemetry = parseExternalAgentTelemetry(result.stdout);
  return {
    content: content.slice(0, 20_000),
    runtime: request.runtime,
    model: request.model,
    durationMs: result.durationMs,
    usage: telemetry.usage,
    toolCalls: telemetry.toolCalls,
  };
}

export function externalAgentFailure(runtime: ExternalAgentRuntime, result: ProcessResult): Error | undefined {
  if (result.timedOut) {
    return new Error(`${runtime} agent timed out after ${result.durationMs}ms; partial output was not accepted as complete.`);
  }
  if (result.exitCode !== 0) return new Error(`${runtime} agent failed: ${cleanFailure(result)}`);
  return undefined;
}

/** Pass only runtime facts plus the exact provider environment selected for this child. */
export function externalRuntimeEnvironment(
  runtime: ExternalAgentRuntime,
  safePath: string,
  environment: NodeJS.ProcessEnv = process.env,
  provider?: ExternalProviderEnvironment,
): NodeJS.ProcessEnv {
  const allowed = [
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NO_COLOR',
    'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  ];
  if (runtime === 'codex') allowed.push('CODEX_HOME');
  if (runtime === 'claude') allowed.push('CLAUDE_CONFIG_DIR');
  const selected: NodeJS.ProcessEnv = {PATH: safePath};
  for (const name of allowed) {
    if (environment[name] !== undefined) selected[name] = environment[name];
  }
  if (runtime === 'claude') addClaudeProviderEnvironment(selected, environment, provider);
  return selected;
}

function addClaudeProviderEnvironment(
  selected: NodeJS.ProcessEnv,
  environment: NodeJS.ProcessEnv,
  provider?: ExternalProviderEnvironment,
): void {
  const baseUrl = provider?.baseUrl ?? environment.ANTHROPIC_BASE_URL;
  if (baseUrl) selected.ANTHROPIC_BASE_URL = baseUrl;
  if (provider?.customHeaders && Object.keys(provider.customHeaders).length) {
    selected.ANTHROPIC_CUSTOM_HEADERS = Object.entries(provider.customHeaders)
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n');
  }

  if (provider?.apiKeyEnv) {
    const credential = environment[provider.apiKeyEnv];
    if (!credential) throw new Error(`External Claude credential environment ${provider.apiKeyEnv} is not set.`);
    if (provider.apiKeyHeader === 'bearer') selected.ANTHROPIC_AUTH_TOKEN = credential;
    else selected.ANTHROPIC_API_KEY = credential;
    return;
  }

  if (provider?.credential) {
    if (provider.apiKeyHeader === 'bearer') selected.ANTHROPIC_AUTH_TOKEN = provider.credential;
    else selected.ANTHROPIC_API_KEY = provider.credential;
    return;
  }

  if (provider?.authNone) return;

  if (environment.ANTHROPIC_API_KEY) selected.ANTHROPIC_API_KEY = environment.ANTHROPIC_API_KEY;
  if (environment.ANTHROPIC_AUTH_TOKEN) selected.ANTHROPIC_AUTH_TOKEN = environment.ANTHROPIC_AUTH_TOKEN;
}

export function externalAgentCommand(request: ExternalAgentRequest): {binary: string; args: string[]} {
  const prompt = request.prompt.slice(0, 60_000);
  const access = request.access ?? 'read-only';
  if (access === 'workspace-write' && request.runtime !== 'claude') {
    throw new Error('External writer mode currently supports the Claude CLI only.');
  }
  if (access === 'workspace-write' &&
      (request.costBudgetUsd === undefined || !Number.isFinite(request.costBudgetUsd) || request.costBudgetUsd <= 0)) {
    throw new Error('External Claude writers require an explicit USD cost budget.');
  }
  switch (request.runtime) {
    case 'codex':
      return {
        binary: 'codex',
        args: ['exec', '--ephemeral', '--json', '--sandbox', 'read-only', '--ignore-rules', '-C', request.workspace, '--model', request.model, prompt],
      };
    case 'claude':
      return {
        binary: 'claude',
        args: [
          '--print', '--output-format', 'stream-json', '--verbose',
          '--permission-mode', access === 'workspace-write' ? 'acceptEdits' : 'plan',
          '--tools', access === 'workspace-write' ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep',
          '--no-session-persistence', '--safe-mode',
          ...(request.costBudgetUsd ? ['--max-budget-usd', String(request.costBudgetUsd)] : []),
          '--model', request.model, prompt,
        ],
      };
    case 'grok':
      return {
        binary: 'grok',
        args: ['--single', prompt, '--output-format', 'json', '--permission-mode', 'plan', '--no-memory', '--no-subagents', '--cwd', request.workspace, '--model', request.model],
      };
  }
}

export function createExternalAgentProgressObserver(
  runtime: ExternalAgentRuntime,
  onProgress?: (progress: ExternalAgentProgress) => void,
): {onChunk: (chunk: string) => void; flush: () => void} | undefined {
  if (runtime !== 'claude' || !onProgress) return undefined;
  let pending = '';
  const toolIds = new Set<string>();
  const handle = (line: string) => {
    let value: unknown;
    try { value = JSON.parse(line) as unknown; } catch { return; }
    walk(value, (record) => {
      if (record.type !== 'tool_use' || typeof record.name !== 'string') return;
      const id = typeof record.id === 'string' ? record.id : `${toolIds.size}:${record.name}`;
      if (toolIds.has(id)) return;
      toolIds.add(id);
      onProgress({stage: 'tool', tool: record.name.slice(0, 128), toolCalls: toolIds.size});
    });
  };
  return {
    onChunk(chunk) {
      pending += chunk;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? '';
      for (const line of lines) handle(line);
    },
    flush() {
      if (pending) handle(pending);
      pending = '';
    },
  };
}

export function parseExternalAgentOutput(runtime: ExternalAgentRuntime, stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  const values = trimmed.split(/\r?\n/u).flatMap((line) => {
    try { return [JSON.parse(line) as unknown]; } catch { return []; }
  });
  if (!values.length) return trimmed;
  if (runtime === 'codex') {
    for (const value of values.reverse()) {
      const text = deepText(value, ['text', 'message', 'content']);
      if (text) return text;
    }
  }
  const last = values.at(-1);
  return deepText(last, ['result', 'content', 'text', 'message', 'response']) || trimmed;
}

export function parseExternalAgentTelemetry(stdout: string): {
  usage: {inputTokens: number; outputTokens: number};
  toolCalls: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  const toolIds = new Set<string>();
  for (const [index, line] of stdout.trim().split(/\r?\n/u).entries()) {
    let value: unknown;
    try { value = JSON.parse(line) as unknown; } catch { continue; }
    walk(value, (record) => {
      inputTokens = Math.max(inputTokens, numeric(record.input_tokens, record.inputTokens, record.prompt_tokens));
      outputTokens = Math.max(outputTokens, numeric(record.output_tokens, record.outputTokens, record.completion_tokens));
      const type = typeof record.type === 'string' ? record.type : '';
      if (/tool|command_execution|mcp/iu.test(type)) {
        const id = typeof record.id === 'string' ? record.id : `${index}:${type}`;
        toolIds.add(id);
      }
    });
  }
  return {usage: {inputTokens, outputTokens}, toolCalls: toolIds.size};
}

function deepText(value: unknown, keys: string[]): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const key of ['item', 'data', 'output']) {
    const nested = record[key];
    const text = deepText(nested, keys);
    if (text) return text;
  }
  return '';
}

function cleanFailure(result: ProcessResult): string {
  const detail = (result.stderr || result.stdout || `exit ${result.exitCode}`)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .trim();
  return detail.slice(0, 2_000) || `exit ${result.exitCode}`;
}

function walk(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const record = value as Record<string, unknown>;
  visit(record);
  for (const nested of Object.values(record)) walk(nested, visit);
}

function numeric(...values: unknown[]): number {
  for (const value of values) if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  return 0;
}
