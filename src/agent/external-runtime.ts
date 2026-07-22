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
  return {content: content.slice(0, 20_000), runtime: request.runtime, model: request.model, durationMs: result.durationMs};
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
