import {join} from 'node:path';
import {z} from 'zod';
import {
  resolveExecutableRuntime,
  runProcess,
  type ExecutableRuntime,
} from '../utils/process.js';
import type {AgentTool} from './types.js';
import {jsonSchema} from './types.js';

const inputSchema = z.object({
  args: z.array(z.string().max(10_000)).min(1).max(200),
  cwd: z.string().min(1).optional(),
  timeout_ms: z.number().int().min(100).max(600_000).optional(),
  stdin: z.string().max(5_000_000).optional(),
}).strict();

const networkCommands = new Set([
  'clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule', 'remote',
]);

const readOnlyCommands = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'grep', 'blame',
  'describe', 'shortlog', 'whatchanged', 'verify-commit', 'verify-tag',
  'check-ignore', 'check-attr', 'ls-tree', 'cat-file',
]);

const workspaceMutationCommands = new Set([
  'checkout', 'switch', 'restore', 'reset', 'clean', 'rm', 'mv', 'merge',
  'rebase', 'cherry-pick', 'revert', 'stash', 'apply', 'am', 'worktree',
  'add', 'commit', 'update-index', 'bisect', 'notes', 'init', 'branch', 'tag',
  'remote', 'clone', 'fetch', 'pull', 'push',
]);

const worktreeTrackingCommands = new Set([
  'checkout', 'switch', 'restore', 'reset', 'clean', 'rm', 'mv', 'merge',
  'rebase', 'cherry-pick', 'revert', 'stash', 'apply', 'am', 'pull', 'add',
  'commit', 'update-index', 'bisect', 'notes',
]);

const externalHelperCommands = new Set([
  'clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule', 'remote',
  'checkout', 'switch', 'restore', 'reset', 'merge', 'rebase',
  'cherry-pick', 'revert', 'stash', 'am', 'worktree', 'commit', 'tag',
  'verify-commit', 'verify-tag',
]);

const knownCommands = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'grep', 'blame',
  'branch', 'tag', 'describe', 'shortlog', 'whatchanged', 'verify-commit',
  'verify-tag', 'check-ignore', 'check-attr', 'ls-tree', 'cat-file',
  'init',
  ...networkCommands,
  ...workspaceMutationCommands,
]);

const unsafeInheritedGitEnvironment = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_EXTERNAL_DIFF',
  'GIT_DIFF_OPTS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_PROXY_COMMAND',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_QUARANTINE_PATH',
  'Path',
];

const isolatedGitEnvironment: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_PAGER: 'cat',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'core.fsmonitor',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_CONFIG_KEY_2: 'credential.helper',
  GIT_CONFIG_VALUE_2: '',
  GIT_CONFIG_KEY_3: 'protocol.ext.allow',
  GIT_CONFIG_VALUE_3: 'never',
};

const diffCommands = new Set(['diff', 'log', 'show', 'whatchanged']);

export const gitTool: AgentTool = {
  definition: {
    name: 'git',
    description: 'Run Git directly (without a shell) in a repository inside the workspace.',
    category: 'git',
    inputSchema: jsonSchema({
      args: {type: 'array', items: {type: 'string'}, minItems: 1},
      cwd: {type: 'string', default: '.'},
      timeout_ms: {type: 'integer', minimum: 100, maximum: 600000, default: 120000},
      stdin: {type: 'string'},
    }, ['args']),
  },

  permissionCategories(arguments_) {
    const input = inputSchema.parse(arguments_);
    validateGitArguments(input.args);
    const command = firstGitCommand(input.args);
    validateGitCommand(command);
    return [
      'git' as const,
      ...(externalHelperCommands.has(command) ? ['shell' as const] : []),
      ...(!readOnlyCommands.has(command) ? ['write' as const] : []),
      ...(networkCommands.has(command) ? ['network' as const] : []),
    ];
  },

  async affectedPaths(arguments_, context) {
    const input = inputSchema.parse(arguments_);
    validateGitArguments(input.args);
    validateGitCommand(firstGitCommand(input.args));
    const command = firstGitCommand(input.args);
    if (!workspaceMutationCommands.has(command)) {
      return [];
    }
    const cwd = await context.workspace.resolveDirectory(input.cwd ?? '.');
    await validateGitWorkspaceArguments(input.args, command, cwd, context);
    const paths = new Set<string>();
    const separator = input.args.indexOf('--');
    const explicit = separator >= 0 ? input.args.slice(separator + 1) : [];
    for (const candidate of explicit) {
      if (!candidate || candidate.startsWith('-')) continue;
      try {
        paths.add(await context.workspace.resolvePath(join(cwd, candidate), {allowMissing: true}));
      } catch {
        // Git reports invalid paths during execution; do not widen the boundary here.
      }
    }
    // Snapshot dirty and untracked files before broad mutations such as reset,
    // clean, checkout, and pull. Clean files changed by a branch switch are
    // intentionally not guessed; the checkpoint remains explicit about paths.
    const runtime = await resolveExecutableRuntime('git', cwd, context.workspace.roots);
    if (!runtime) throw new Error('Git executable was not found outside the configured workspace roots.');
    const status = await runProcess(runtime.executable, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd,
      timeoutMs: 15_000,
      maxOutputBytes: 2_000_000,
      env: {...isolatedGitEnvironment, PATH: runtime.path},
      unsetEnv: unsafeInheritedGitEnvironment,
      unsetEnvPrefixes: ['GIT_'],
    });
    if (status.exitCode === 0) {
      for (const record of status.stdout.split('\0')) {
        if (record.length < 4) continue;
        const candidate = record.slice(3);
        const candidates = candidate.includes(' -> ')
          ? candidate.split(' -> ')
          : [candidate];
        for (const value of candidates) {
          try {
            paths.add(await context.workspace.resolvePath(join(cwd, value), {allowMissing: true}));
          } catch {
            // Ignore stale status entries.
          }
        }
      }
    }
    return [...paths];
  },

  async execute(arguments_, context) {
    const input = inputSchema.parse(arguments_);
    validateGitArguments(input.args);
    const cwd = await context.workspace.resolveDirectory(input.cwd ?? '.');
    const command = firstGitCommand(input.args);
    validateGitCommand(command);
    await validateGitWorkspaceArguments(input.args, command, cwd, context);
    const runtime = await resolveExecutableRuntime('git', cwd, context.workspace.roots);
    if (!runtime) throw new Error('Git executable was not found outside the configured workspace roots.');
    const before = worktreeTrackingCommands.has(command)
      ? await captureGitState(runtime, cwd)
      : undefined;
    const result = await runProcess(runtime.executable, protectedGitArguments(input.args, command), {
      cwd,
      timeoutMs: input.timeout_ms ?? 120_000,
      maxOutputBytes: 2_000_000,
      ...(input.stdin !== undefined ? {stdin: input.stdin} : {}),
      ...(context.signal ? {signal: context.signal} : {}),
      env: {...isolatedGitEnvironment, PATH: runtime.path},
      unsetEnv: unsafeInheritedGitEnvironment,
      unsetEnvPrefixes: ['GIT_'],
    });
    const changedFiles = before
      ? await collectGitChanges(before, await captureGitState(runtime, cwd), runtime, cwd, context)
      : [];
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      content: [
        `git ${input.args.join(' ')}`,
        `Exit code: ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`,
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : '',
      ].filter(Boolean).join('\n'),
      metadata: {
        cwd,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      },
      ...(changedFiles.length ? {changedFiles} : {}),
    };
  },
};

interface GitState {
  head?: string;
  status: Map<string, string>;
}

async function captureGitState(runtime: ExecutableRuntime, cwd: string): Promise<GitState> {
  const [head, status] = await Promise.all([
    runIsolatedGit(runtime, ['rev-parse', '--verify', 'HEAD'], cwd),
    runIsolatedGit(runtime, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd),
  ]);
  return {
    ...(head.exitCode === 0 && head.stdout.trim() ? {head: head.stdout.trim()} : {}),
    status: status.exitCode === 0 ? parsePorcelainStatus(status.stdout) : new Map(),
  };
}

async function collectGitChanges(
  before: GitState,
  after: GitState,
  runtime: ExecutableRuntime,
  cwd: string,
  context: Parameters<AgentTool['execute']>[1],
): Promise<string[]> {
  const candidates = new Set<string>();
  for (const path of new Set([...before.status.keys(), ...after.status.keys()])) {
    if (before.status.get(path) !== after.status.get(path)) candidates.add(path);
  }
  if (before.head && after.head && before.head !== after.head) {
    const diff = await runIsolatedGit(runtime, [
      'diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', before.head, after.head,
    ], cwd);
    if (diff.exitCode === 0) {
      for (const path of diff.stdout.split('\0').filter(Boolean)) candidates.add(path);
    }
  }
  const paths: string[] = [];
  for (const candidate of [...candidates].slice(0, 2_000)) {
    try {
      paths.push(await context.workspace.resolvePath(join(cwd, candidate), {allowMissing: true}));
    } catch {
      // Ignore stale or malicious path records from repository metadata.
    }
  }
  return [...new Set(paths)];
}

function parsePorcelainStatus(output: string): Map<string, string> {
  const status = new Map<string, string>();
  const records = output.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    if (record.length < 4) continue;
    const state = record.slice(0, 2);
    const path = record.slice(3);
    if (path) status.set(path, state);
    if (/[RC]/.test(state)) {
      const original = records[index + 1] ?? '';
      if (original) status.set(original, state);
      index += 1;
    }
  }
  return status;
}

function runIsolatedGit(runtime: ExecutableRuntime, args: string[], cwd: string) {
  return runProcess(runtime.executable, args, {
    cwd,
    timeoutMs: 15_000,
    maxOutputBytes: 2_000_000,
    env: {...isolatedGitEnvironment, PATH: runtime.path},
    unsetEnv: unsafeInheritedGitEnvironment,
    unsetEnvPrefixes: ['GIT_'],
  });
}

function validateGitArguments(args: string[]): void {
  for (const argument of args) {
    if (argument.includes('\0') || argument.includes('\n') || argument.includes('\r')) {
      throw new Error('Git arguments cannot contain control characters.');
    }
    if (isUnsafeGitOption(argument)) {
      throw new Error(`Git configuration or workspace override is not allowed: ${argument}`);
    }
  }
  const command = firstGitCommand(args);
  if (command === 'clone' && args.some((argument) => argument === '-u' || /^-u.+/.test(argument))) {
    throw new Error('Git clone upload-pack overrides are not allowed.');
  }
  if (command === 'rebase' && args.some((argument) => argument === '-x' || /^-x.+/.test(argument))) {
    throw new Error('Git rebase exec commands are not allowed.');
  }
  const strategyOverride = args.some((argument) =>
    argument === '--strategy' || argument.startsWith('--strategy=')) ||
    (new Set(['merge', 'rebase']).has(command) &&
      args.some((argument) => argument === '-s' || /^-s.+/.test(argument)));
  if (new Set(['merge', 'rebase', 'cherry-pick', 'revert']).has(command) && strategyOverride) {
    throw new Error('Git strategy overrides can execute external programs and are not allowed.');
  }
  const operation = positionalArguments(args, command)[0];
  if ((command === 'bisect' && operation === 'run') ||
    (command === 'submodule' && operation === 'foreach')) {
    throw new Error(`Git ${command} ${operation} can execute arbitrary commands and is not allowed.`);
  }
}

function validateGitCommand(command: string): void {
  if (!command || !knownCommands.has(command)) {
    throw new Error(`Git subcommand is not allowed (aliases and extensions are disabled): ${command || '(missing)'}`);
  }
}

function isUnsafeGitOption(argument: string): boolean {
  if (argument === '-c' || (argument.startsWith('-c') && argument.length > 2)) return true;
  if (argument === '-C' || (argument.startsWith('-C') && argument.length > 2)) return true;
  return [
    '--config-env',
    '--config',
    '--exec-path',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--super-prefix',
    '--upload-pack',
    '--receive-pack',
    '--exec',
    '--separate-git-dir',
    '--template',
    '--reference',
    '--reference-if-able',
    '--bundle-uri',
    '--repo',
    '--repository',
    '--ext-diff',
    '--textconv',
    '--show-signature',
    '--filters',
    '--unsafe-paths',
    '--pathspec-from-file',
    '--open-files-in-pager',
    '--contents',
    '--exclude-from',
    '--output',
    '--directory',
  ].some((option) => argument === option || argument.startsWith(`${option}=`));
}

function firstGitCommand(args: string[]): string {
  for (const argument of args) {
    if (!argument.startsWith('-')) return argument;
  }
  return '';
}

async function validateGitWorkspaceArguments(
  args: string[],
  command: string,
  cwd: string,
  context: Parameters<NonNullable<typeof gitTool.affectedPaths>>[1],
): Promise<void> {
  const positional = positionalArguments(args, command);
  const candidates = command === 'clone'
    ? positional
    : command === 'init'
      ? positional
    : command === 'worktree'
      ? positional.slice(Math.max(0, positional.indexOf('add') + 1))
      : positional;
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate || candidate.startsWith('-')) continue;
    if (/^(?:file:|[a-z][a-z0-9+.-]*::)/i.test(candidate)) {
      throw new Error(`Git URL is outside the workspace boundary or can execute a command: ${candidate}`);
    }
    if (/^(?:[a-z]+:\/\/|[a-z]+@[^:]+:)/i.test(candidate)) continue;
    // A clone source may be a local path; validate it just like a destination.
    if (command === 'clone' && index === 0 && !candidate) continue;
    await context.workspace.resolvePath(
      candidate.startsWith('/') ? candidate : join(cwd, candidate),
      {allowMissing: true},
    );
  }
}

function protectedGitArguments(args: string[], command: string): string[] {
  if (!diffCommands.has(command)) return args;
  const commandIndex = args.indexOf(command);
  return [
    ...args.slice(0, commandIndex + 1),
    '--no-ext-diff',
    '--no-textconv',
    ...args.slice(commandIndex + 1),
  ];
}

function positionalArguments(args: string[], command: string): string[] {
  const commandIndex = args.indexOf(command);
  const values: string[] = [];
  const valueOptions = new Set([
    '-b', '-B', '-c', '-C', '-m', '-o', '-t', '-u', '-f', '-j',
    '--branch', '--depth', '--origin', '--reference', '--template',
    '--separate-git-dir', '--message', '--file', '--format', '--jobs',
  ]);
  for (let index = commandIndex + 1; index < args.length; index += 1) {
    const value = args[index] as string;
    if (valueOptions.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith('-')) continue;
    values.push(value);
  }
  return values;
}
