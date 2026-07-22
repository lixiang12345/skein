import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {access, lstat, realpath} from 'node:fs/promises';
import {delimiter, isAbsolute, join, resolve} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {isInside} from './path.js';

export interface ProcessResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecutableRuntime {
  executable: string;
  path: string;
}

export async function resolveExecutableRuntime(
  command: string,
  cwd: string,
  excludedRoots: string[] = [],
): Promise<ExecutableRuntime | undefined> {
  const realRoots = await Promise.all(excludedRoots.map(async (root) => {
    try {
      return await realpath(root);
    } catch {
      return resolve(root);
    }
  }));
  const pathEntries = (process.env.PATH ?? process.env.Path ?? '')
    .split(delimiter)
    .filter(Boolean);
  const safeDirectories: string[] = [];
  let executable: string | undefined;
  const explicit = isAbsolute(command) || command.includes('/') || command.includes('\\');
  const explicitPath = explicit ? resolve(cwd, command) : undefined;

  for (const entry of pathEntries) {
    let directory: string;
    try {
      directory = await realpath(resolve(cwd, entry));
      if (!(await lstat(directory)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (realRoots.some((root) => isInside(root, directory))) continue;
    let contaminated = false;
    if (!explicit) {
      for (const name of executableNames(command)) {
        const candidate = join(directory, name);
        const resolvedCandidate = await usableExecutable(candidate);
        if (!resolvedCandidate) continue;
        if (realRoots.some((root) => isInside(root, resolvedCandidate))) {
          contaminated = true;
          continue;
        }
        executable ??= resolvedCandidate;
      }
    }
    if (!contaminated && !safeDirectories.includes(directory)) safeDirectories.push(directory);
  }

  if (explicitPath) executable = await usableExecutable(explicitPath);
  if (!executable) return undefined;
  return {executable, path: safeDirectories.join(delimiter)};
}

async function usableExecutable(candidate: string): Promise<string | undefined> {
  try {
    await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    const resolvedCandidate = await realpath(candidate);
    return (await lstat(resolvedCandidate)).isFile() ? resolvedCandidate : undefined;
  } catch {
    return undefined;
  }
}

function executableNames(command: string): string[] {
  if (process.platform !== 'win32') return [command];
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension}`)];
}

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    unsetEnv?: string[];
    unsetEnvPrefixes?: string[];
    stdin?: string;
    maxOutputBytes?: number;
    signal?: AbortSignal;
    inheritEnv?: boolean;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const environment = options.inheritEnv === false ? {} : {...process.env};
    for (const name of options.unsetEnv ?? []) delete environment[name];
    for (const name of Object.keys(environment)) {
      if (options.unsetEnvPrefixes?.some((prefix) => name.startsWith(prefix))) {
        delete environment[name];
      }
    }
    Object.assign(environment, options.env);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
    });
    const maxBytes = options.maxOutputBytes ?? 1_000_000;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let callbackError: unknown;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const stdoutCallbackDecoder = new StringDecoder('utf8');
    const stderrCallbackDecoder = new StringDecoder('utf8');
    const append = (
      decoder: StringDecoder,
      chunk: Buffer,
      usedBytes: number,
    ): {text: string; usedBytes: number} => {
      if (usedBytes >= maxBytes) return {text: '', usedBytes};
      const selected = chunk.subarray(0, maxBytes - usedBytes);
      return {text: decoder.write(selected), usedBytes: usedBytes + selected.length};
    };
    const notify = (
      callback: ((chunk: string) => void) | undefined,
      decoder: StringDecoder,
      chunk: Buffer,
    ): void => {
      if (!callback || callbackError) return;
      try {
        const decoded = decoder.write(chunk);
        if (decoded) callback(decoded);
      } catch (error) {
        callbackError = error;
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      const appended = append(stdoutDecoder, chunk, stdoutBytes);
      stdout += appended.text;
      stdoutBytes = appended.usedBytes;
      notify(options.onStdout, stdoutCallbackDecoder, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const appended = append(stderrDecoder, chunk, stderrBytes);
      stderr += appended.text;
      stderrBytes = appended.usedBytes;
      notify(options.onStderr, stderrCallbackDecoder, chunk);
    });
    child.on('error', reject);
    const timeoutMs = options.timeoutMs ?? 120_000;
    const timeout = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, timeoutMs) : undefined;
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stdoutTail) <= maxBytes) stdout += stdoutTail;
      if (Buffer.byteLength(stderr) + Buffer.byteLength(stderrTail) <= maxBytes) stderr += stderrTail;
      try {
        const stdoutCallbackTail = stdoutCallbackDecoder.end();
        const stderrCallbackTail = stderrCallbackDecoder.end();
        if (stdoutCallbackTail && options.onStdout && !callbackError) options.onStdout(stdoutCallbackTail);
        if (stderrCallbackTail && options.onStderr && !callbackError) options.onStderr(stderrCallbackTail);
      } catch (error) {
        callbackError = error;
      }
      if (callbackError) {
        reject(callbackError);
        return;
      }
      resolve({
        command: [command, ...args].join(' '),
        exitCode: code ?? (timedOut ? 124 : 1),
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

export function runShell(
  command: string,
  cwd: string,
  options: Omit<Parameters<typeof runProcess>[2], 'cwd'> = {},
): Promise<ProcessResult> {
  const shell = process.platform === 'win32'
    ? process.env.COMSPEC ?? 'cmd.exe'
    : process.env.SHELL ?? '/bin/sh';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', command]
    : ['-lc', command];
  return runProcess(shell, args, {...options, cwd});
}
