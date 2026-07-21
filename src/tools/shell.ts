import {lstat} from 'node:fs/promises';
import {z} from 'zod';
import {runShell} from '../utils/process.js';
import type {AgentTool} from './types.js';
import {jsonSchema} from './types.js';

const inputSchema = z.object({
  command: z.string().min(1).max(100_000),
  cwd: z.string().min(1).optional(),
  timeout_ms: z.number().int().min(100).max(600_000).optional(),
  max_output_bytes: z.number().int().min(1_000).max(5_000_000).optional(),
  env: z.record(z.string(), z.string()).optional(),
  stdin: z.string().max(5_000_000).optional(),
}).strict();

export const shellTool: AgentTool = {
  definition: {
    name: 'shell',
    description: 'Run an approved shell command with its working directory constrained to the workspace.',
    category: 'shell',
    inputSchema: jsonSchema({
      command: {type: 'string'},
      cwd: {type: 'string', default: '.'},
      timeout_ms: {type: 'integer', minimum: 100, maximum: 600000, default: 120000},
      max_output_bytes: {type: 'integer', minimum: 1000, maximum: 5000000, default: 1000000},
      env: {type: 'object', additionalProperties: {type: 'string'}},
      stdin: {type: 'string'},
    }, ['command']),
  },

  permissionCategories(arguments_) {
    const input = inputSchema.parse(arguments_);
    validateEnvironment(input.env);
    return [
      'shell' as const,
      ...(appearsToInvokeGit(input.command) ? ['git' as const] : []),
      ...(appearsToModifyWorkspace(input.command) ? ['write' as const] : []),
      ...(appearsToUseNetwork(input.command) ? ['network' as const] : []),
    ];
  },

  async affectedPaths(arguments_, context) {
    const input = inputSchema.parse(arguments_);
    if (!appearsToModifyWorkspace(input.command)) return [];
    return collectAffectedPaths(input.command, input.cwd ?? '.', context);
  },

  async execute(arguments_, context) {
    const input = inputSchema.parse(arguments_);
    validateEnvironment(input.env);
    const cwd = await context.workspace.resolveDirectory(input.cwd ?? '.');
    const candidates = appearsToModifyWorkspace(input.command)
      ? await collectAffectedPaths(input.command, input.cwd ?? '.', context)
      : [];
    const before = await snapshotPaths(candidates);
    const result = await runShell(input.command, cwd, {
      timeoutMs: input.timeout_ms ?? 120_000,
      maxOutputBytes: input.max_output_bytes ?? 1_000_000,
      ...(input.env ? {env: input.env} : {}),
      ...(input.stdin !== undefined ? {stdin: input.stdin} : {}),
      ...(context.signal ? {signal: context.signal} : {}),
    });
    const changedFiles = await changedPaths(candidates, before);
    const sections = [
      `Command: ${input.command}`,
      `Exit code: ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`,
      result.stdout ? `stdout:\n${result.stdout}` : '',
      result.stderr ? `stderr:\n${result.stderr}` : '',
    ].filter(Boolean);
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      content: sections.join('\n'),
      metadata: {
        cwd,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        changeTracking: candidates.length ? 'targeted' : appearsToModifyWorkspace(input.command) ? 'unresolved' : 'read-only',
      },
      ...(changedFiles.length ? {changedFiles} : {}),
    };
  },
};

const commandBoundary = '(?:^|[\\s;&|()`])';
const executablePath = '(?:[^\\s;&|()`]+[\\\\/])?';

function executable(names: string): string {
  return `${commandBoundary}${executablePath}(?:${names})`;
}

function appearsToUseNetwork(command: string): boolean {
  return new RegExp(`${executable('curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp|ping|dig|nslookup')}(?=\\s|$)`, 'i').test(command) ||
    appearsToRunPackageCode(command) ||
    new RegExp(`${executable('npm|pnpm|yarn|bun')}\\s+(?:install|add|update|upgrade|publish|login)(?=\\s|$)`, 'i').test(command) ||
    new RegExp(`${executable('pip|pip3|cargo|go')}\\s+(?:install|get)(?=\\s|$)`, 'i').test(command) ||
    new RegExp(`${executable('git')}\\s+(?:clone|fetch|pull|push|ls-remote|submodule)(?=\\s|$)`, 'i').test(command) ||
    new RegExp(`${executable('docker|podman')}\\s+(?:pull|push|login|buildx)(?=\\s|$)`, 'i').test(command) ||
    appearsToRunInterpreter(command);
}

function appearsToModifyWorkspace(command: string): boolean {
  return /(?:^|[^<>])>>?\s*[^&]/.test(command) ||
    new RegExp(`${executable('rm|mv|cp|install|touch|mkdir|rmdir|truncate|chmod|chown|tee|patch')}(?=\\s|$)`, 'i').test(command) ||
    new RegExp(`${executable('sed')}\\s+(?:[^;&|]*\\s)?-i(?:[^\\s;&|]*)?(?=\\s|$)`, 'i').test(command) ||
    new RegExp(`${executable('perl')}\\s+(?:[^;&|]*\\s)?-[a-z]*i(?:[^\\s;&|]*)?(?=\\s|$)`, 'i').test(command) ||
    new RegExp(`${executable('git')}\\s+(?:add|apply|am|branch|checkout|cherry-pick|clean|clone|commit|fetch|init|merge|mv|pull|push|rebase|remote|reset|restore|revert|rm|stash|switch|tag|worktree)(?=\\s|$)`, 'i').test(command) ||
    new RegExp(`${executable('npm|pnpm|yarn|bun')}\\s+(?:install|add|update|upgrade)(?=\\s|$)`, 'i').test(command) ||
    appearsToRunPackageCode(command) ||
    appearsToRunInterpreter(command);
}

function appearsToInvokeGit(command: string): boolean {
  return new RegExp(`${executable('git')}(?=\\s|$)`, 'i').test(command);
}

function appearsToRunPackageCode(command: string): boolean {
  return new RegExp(
    `${executable('npm|pnpm|yarn|bun|npx|pnpx|bunx|make|just|gradle|gradlew|mvn|mvnw|task')}` +
    '(?=\\s|$)(?!\\s+(?:--version|-v|--help|help)(?=\\s|$))',
    'i',
  ).test(command);
}

function appearsToRunInterpreter(command: string): boolean {
  return new RegExp(
    `${executable('python(?:\\d+(?:\\.\\d+)*)?|node|ruby|perl|php|deno|java|sh|bash|zsh|fish|dash|ksh|pwsh|powershell|source')}` +
    '\\b(?!\\s+(?:--version|-v|--help)(?:\\s|$))',
    'i',
  ).test(command);
}

function validateEnvironment(environment?: Record<string, string>): void {
  for (const name of Object.keys(environment ?? {})) {
    if (/^(?:PATH|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT|BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|PS4|SSH_ASKPASS)$/i.test(name) ||
      /^(?:LD_|DYLD_|GIT_)/i.test(name)) {
      throw new Error(`Shell environment variable is not allowed: ${name}`);
    }
  }
}

async function collectAffectedPaths(
  command: string,
  cwdInput: string,
  context: Parameters<NonNullable<typeof shellTool.affectedPaths>>[1],
): Promise<string[]> {
  const cwd = await context.workspace.resolveDirectory(cwdInput);
  const raw = new Set<string>();
  for (const match of command.matchAll(/(?:^|[^>])>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) {
    const candidate = match[1] ?? match[2] ?? match[3];
    if (candidate) raw.add(candidate);
  }
  const pathCommand = new RegExp(
    `${executable('touch|rm|mv|cp|install|truncate|chmod|chown|tee')}\\s+([^;&|]+)`,
    'gi',
  );
  for (const match of command.matchAll(pathCommand)) {
    for (const token of shellWords(match[1] ?? '')) {
      if (!token.startsWith('-')) raw.add(token);
    }
  }
  const paths: string[] = [];
  for (const candidate of raw) {
    if (!candidate || candidate === '/dev/null' || candidate.includes('$') || candidate.includes('*') || candidate.includes('?')) continue;
    try {
      const path = await context.workspace.resolvePath(candidate.startsWith('/') ? candidate : `${cwd}/${candidate}`, {
        allowMissing: true,
      });
      try {
        if ((await lstat(path)).isDirectory()) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      paths.push(path);
    } catch {
      // Shell approval remains the boundary for dynamic or out-of-root paths.
    }
  }
  return [...new Set(paths)];
}

function shellWords(value: string): string[] {
  return [...value.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
    .filter(Boolean);
}

interface PathSnapshot {exists: boolean; size?: number; mtimeMs?: number}

async function snapshotPaths(paths: string[]): Promise<Map<string, PathSnapshot>> {
  return new Map(await Promise.all(paths.map(async (path) => [path, await snapshotPath(path)] as const)));
}

async function changedPaths(paths: string[], before: Map<string, PathSnapshot>): Promise<string[]> {
  const changed: string[] = [];
  for (const path of paths) {
    if (JSON.stringify(before.get(path)) !== JSON.stringify(await snapshotPath(path))) changed.push(path);
  }
  return changed;
}

async function snapshotPath(path: string): Promise<PathSnapshot> {
  try {
    const info = await lstat(path);
    return {exists: true, size: info.size, mtimeMs: info.mtimeMs};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {exists: false};
    throw error;
  }
}
