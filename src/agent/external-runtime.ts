import type {AgentModelRoute} from '../types.js';
import {resolveExecutableRuntime, runProcess, type ProcessResult} from '../utils/process.js';

export type ExternalAgentRuntime = Exclude<NonNullable<AgentModelRoute['runtime']>, 'api'>;

export interface ExternalAgentRequest {
  runtime: ExternalAgentRuntime;
  model: string;
  workspace: string;
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExternalAgentResult {
  content: string;
  runtime: ExternalAgentRuntime;
  model: string;
  durationMs: number;
  usage?: {inputTokens: number; outputTokens: number};
  toolCalls?: number;
}

export async function runExternalAgent(request: ExternalAgentRequest): Promise<ExternalAgentResult> {
  const command = externalAgentCommand(request);
  const executable = await resolveExecutableRuntime(command.binary, request.workspace, [request.workspace]);
  if (!executable) throw new Error(`${command.binary} CLI is not installed or resolves inside the workspace.`);
  const result = await runProcess(executable.executable, command.args, {
    cwd: request.workspace,
    timeoutMs: request.timeoutMs ?? 180_000,
    maxOutputBytes: 2_000_000,
    ...(request.signal ? {signal: request.signal} : {}),
  });
  if (result.exitCode !== 0) {
    const detail = cleanFailure(result);
    throw new Error(`${request.runtime} agent failed${result.timedOut ? ' (timeout)' : ''}: ${detail}`);
  }
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

export function externalAgentCommand(request: ExternalAgentRequest): {binary: string; args: string[]} {
  const prompt = request.prompt.slice(0, 60_000);
  switch (request.runtime) {
    case 'codex':
      return {
        binary: 'codex',
        args: ['exec', '--ephemeral', '--json', '--sandbox', 'read-only', '--ignore-rules', '-C', request.workspace, '--model', request.model, prompt],
      };
    case 'claude':
      return {
        binary: 'claude',
        args: ['--print', '--output-format', 'json', '--permission-mode', 'plan', '--no-session-persistence', '--safe-mode', '--model', request.model, prompt],
      };
    case 'grok':
      return {
        binary: 'grok',
        args: ['--single', prompt, '--output-format', 'json', '--permission-mode', 'plan', '--no-memory', '--no-subagents', '--cwd', request.workspace, '--model', request.model],
      };
  }
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
