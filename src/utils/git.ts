import type {ExecutableRuntime} from './process.js';
import {runProcess} from './process.js';

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
  GIT_NO_REPLACE_OBJECTS: '1',
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

export function runIsolatedGit(
  runtime: ExecutableRuntime,
  args: string[],
  cwd: string,
  options: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    stopOnOutputLimit?: boolean;
    stdin?: string;
    signal?: AbortSignal;
  } = {},
) {
  return runProcess(runtime.executable, args, {
    cwd,
    timeoutMs: options.timeoutMs ?? 15_000,
    maxOutputBytes: options.maxOutputBytes ?? 2_000_000,
    ...(options.stopOnOutputLimit !== undefined
      ? {stopOnOutputLimit: options.stopOnOutputLimit}
      : {}),
    env: {...isolatedGitEnvironment, PATH: runtime.path},
    unsetEnv: unsafeInheritedGitEnvironment,
    unsetEnvPrefixes: ['GIT_'],
    ...(options.stdin !== undefined ? {stdin: options.stdin} : {}),
    ...(options.signal ? {signal: options.signal} : {}),
  });
}
