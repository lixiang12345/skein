import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import type {
  ConnectionAuth,
  ConnectionHeaderSources,
  ConnectionProtocol,
  ProviderName,
} from '../types.js';

const DEFAULT_HELPER_TIMEOUT_MS = 5_000;
const DEFAULT_HELPER_REFRESH_MS = 300_000;
const MAX_HELPER_OUTPUT_BYTES = 16 * 1024;
const credentialCache = new Map<string, {value: string; expiresAt: number}>();

export interface ResolvedConnectionCredential {
  value?: string;
  reference: string;
  headers: Record<string, string>;
}

export interface ResolveConnectionAuthOptions {
  environment?: NodeJS.ProcessEnv;
  now?: number;
  signal?: AbortSignal;
}

/** Resolve one credential source without persisting or logging its value. */
export async function resolveConnectionCredential(
  auth: ConnectionAuth,
  options: ResolveConnectionAuthOptions = {},
): Promise<ResolvedConnectionCredential> {
  const environment = options.environment ?? process.env;
  if (auth.type === 'none') return {reference: 'none', headers: {}};
  if (auth.type === 'env') {
    const value = environment[auth.name];
    if (!value) throw new Error(`Connection credential environment ${auth.name} is not set.`);
    if (/\r|\n/u.test(value)) throw new Error(`Connection credential environment ${auth.name} contains a newline.`);
    return {
      value,
      reference: `env:${auth.name}`,
      headers: credentialHeaders(auth, value),
    };
  }

  const now = options.now ?? Date.now();
  const cacheKey = commandCacheKey(auth, environment);
  const cached = credentialCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return {
      value: cached.value,
      reference: commandReference(auth.command),
      headers: credentialHeaders(auth, cached.value),
    };
  }
  const value = await runCredentialHelper(auth, environment, options.signal);
  const refreshIntervalMs = auth.refreshIntervalMs ?? DEFAULT_HELPER_REFRESH_MS;
  if (refreshIntervalMs > 0) {
    credentialCache.set(cacheKey, {value, expiresAt: now + refreshIntervalMs});
  }
  return {
    value,
    reference: commandReference(auth.command),
    headers: credentialHeaders(auth, value),
  };
}

/** Resolve literal/env-backed headers and merge one credential placement without ambiguity. */
export async function resolveConnectionHeaders(
  auth: ConnectionAuth,
  sources: ConnectionHeaderSources | undefined,
  options: ResolveConnectionAuthOptions = {},
): Promise<ResolvedConnectionCredential> {
  const environment = options.environment ?? process.env;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(sources?.static ?? {})) {
    setUniqueHeader(headers, name, value);
  }
  for (const [name, envName] of Object.entries(sources?.env ?? {})) {
    const value = environment[envName];
    if (!value) throw new Error(`Connection header environment ${envName} is not set.`);
    setUniqueHeader(headers, name, value);
  }
  const credential = await resolveConnectionCredential(auth, options);
  for (const [name, value] of Object.entries(credential.headers)) {
    setUniqueHeader(headers, name, value);
  }
  return {...credential, headers};
}

export function connectionAuthReference(auth: ConnectionAuth): string {
  if (auth.type === 'env') return `env:${auth.name}`;
  if (auth.type === 'command') return commandReference(auth.command);
  return 'none';
}

/** Content-free identity used to invalidate route evidence when auth wiring changes. */
export function connectionAuthFingerprint(auth: ConnectionAuth): string {
  return createHash('sha256').update(JSON.stringify(auth)).digest('hex');
}

export function connectionAuthConfigured(
  auth: ConnectionAuth,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return auth.type === 'none' || auth.type === 'command' || Boolean(environment[auth.name]);
}

export function clearConnectionCredentialCache(): void {
  credentialCache.clear();
}

/** Apply a provider's standard credential convention only when the user did not choose one. */
export function withDefaultCredentialPlacement(
  auth: ConnectionAuth,
  provider: ProviderName,
  protocol: ConnectionProtocol,
): ConnectionAuth {
  if (auth.type === 'none' || auth.header || auth.placement) return auth;
  if (provider === 'anthropic' && protocol === 'anthropic-messages') {
    return {...auth, header: 'x-api-key'};
  }
  return auth;
}

/** Remove the auth-owned header while preserving independent static and env-backed headers. */
export function withoutConnectionCredentialHeader(
  auth: ConnectionAuth,
  headers: Record<string, string>,
): Record<string, string> {
  if (auth.type === 'none') return {...headers};
  const credentialName = auth.placement?.name ?? (auth.header === 'x-api-key' ? 'x-api-key' : 'authorization');
  return Object.fromEntries(Object.entries(headers).filter(([name]) =>
    name.toLowerCase() !== credentialName.toLowerCase(),
  ));
}

/** Validate case-insensitive header ownership without reading any credential values. */
export function connectionHeaderConfigurationIssues(
  auth: ConnectionAuth,
  sources: ConnectionHeaderSources | undefined,
): string[] {
  const issues: string[] = [];
  const seen = new Map<string, string>();
  for (const name of [...Object.keys(sources?.static ?? {}), ...Object.keys(sources?.env ?? {})]) {
    const normalized = name.toLowerCase();
    const existing = seen.get(normalized);
    if (existing) issues.push(`headers ${existing} and ${name} collide case-insensitively`);
    else seen.set(normalized, name);
  }
  if (auth.type !== 'none') {
    const credentialName = auth.placement?.name ?? (auth.header === 'x-api-key' ? 'x-api-key' : 'authorization');
    const collided = seen.get(credentialName.toLowerCase());
    if (collided) issues.push(`header ${collided} conflicts with credential placement ${credentialName}`);
  }
  return issues;
}

function credentialHeaders(
  auth: Exclude<ConnectionAuth, {type: 'none'}>,
  value: string,
): Record<string, string> {
  if (auth.placement) {
    return {[auth.placement.name]: `${auth.placement.prefix ?? ''}${value}`};
  }
  return auth.header === 'x-api-key'
    ? {'x-api-key': value}
    : {authorization: `Bearer ${value}`};
}

function setUniqueHeader(headers: Record<string, string>, name: string, value: string): void {
  if (/\r|\n/u.test(value)) throw new Error(`Connection header ${name} contains a newline.`);
  const collided = Object.keys(headers).find((existing) => existing.toLowerCase() === name.toLowerCase());
  if (collided) throw new Error(`Connection header ${name} is configured more than once.`);
  headers[name] = value;
}

function runCredentialHelper(
  auth: Extract<ConnectionAuth, {type: 'command'}>,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(auth.command, auth.args ?? [], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: helperEnvironment(auth.passEnv ?? [], environment),
    });
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value as string);
    };
    const abort = (): void => {
      child.kill('SIGKILL');
      finish(new Error('Connection credential helper was cancelled.'));
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Connection credential helper timed out after ${auth.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS}ms.`));
    }, auth.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS);
    timeout.unref();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, {once: true});
    child.once('error', (error) => finish(new Error(`Connection credential helper could not start: ${error.message}`)));
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (stdout.length + chunk.length > MAX_HELPER_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error(`Connection credential helper output exceeds ${MAX_HELPER_OUTPUT_BYTES} bytes.`));
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_HELPER_OUTPUT_BYTES) child.stderr.pause();
    });
    child.once('close', (code, closeSignal) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`Connection credential helper failed (${closeSignal ? `signal ${closeSignal}` : `exit ${code ?? 'unknown'}`}).`));
        return;
      }
      const value = stdout.toString('utf8').trim();
      if (!value) {
        finish(new Error('Connection credential helper returned an empty credential.'));
        return;
      }
      if (/\r|\n/u.test(value)) {
        finish(new Error('Connection credential helper returned more than one line.'));
        return;
      }
      finish(undefined, value);
    });
  });
}

function helperEnvironment(names: string[], environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const defaults = process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE']
    : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'];
  return Object.fromEntries([...new Set([...defaults, ...names])].flatMap((name) => {
    const value = environment[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

function commandCacheKey(
  auth: Extract<ConnectionAuth, {type: 'command'}>,
  environment: NodeJS.ProcessEnv,
): string {
  const env = Object.fromEntries((auth.passEnv ?? []).map((name) => [name, environment[name] ?? null]));
  return createHash('sha256').update(JSON.stringify({auth, env})).digest('hex');
}

function commandReference(command: string): string {
  const name = command.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'helper';
  return `command:${name}`;
}
