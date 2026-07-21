import {stat, realpath} from 'node:fs/promises';
import {isAbsolute, resolve} from 'node:path';
import type {McpServerConfig} from '../types.js';
import {isInside} from '../utils/path.js';

const SERVER_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const UNSAFE_ENV_NAMES = new Set([
  'BASH_ENV',
  'ENV',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'PYTHONHOME',
  'PYTHONPATH',
  'PERL5OPT',
  'PROMPT_COMMAND',
  'RUBYOPT',
  'SHELLOPTS',
  'BASHOPTS',
  'SSH_ASKPASS',
  'PS4',
  'ZDOTDIR',
]);
const UNSAFE_HTTP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'mcp-protocol-version',
  'mcp-session-id',
  'transfer-encoding',
]);

export interface McpValidationOptions {
  cwd?: string;
  workspaceRoots?: string[];
  allowInsecureHttp?: boolean;
}

export interface ValidatedStdioConfig {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface ValidatedHttpConfig {
  url: URL;
  headers: Record<string, string>;
}

export function assertMcpServerName(name: string): void {
  if (!SERVER_NAME.test(name)) {
    throw new Error(`Invalid MCP server name: ${name}`);
  }
}

export async function validateStdioConfig(
  config: McpServerConfig,
  options: McpValidationOptions = {},
): Promise<ValidatedStdioConfig> {
  const command = config.command?.trim();
  if (!command) throw new Error('stdio MCP server requires a command');
  if (command.length > 512 || CONTROL_CHARACTERS.test(command)) {
    throw new Error('MCP command contains invalid characters or is too long');
  }

  const args = config.args ?? [];
  if (args.length > 64 || args.some((argument) =>
    argument.length > 4_000 || CONTROL_CHARACTERS.test(argument))) {
    throw new Error('MCP command arguments are invalid or exceed configured limits');
  }

  const cwd = await validateCwd(config.cwd, options);
  const env = validateEnvironment(config.env ?? {});
  return {command, args: [...args], cwd, env};
}

export function validateHttpConfig(
  config: McpServerConfig,
  options: McpValidationOptions = {},
): ValidatedHttpConfig {
  if (!config.url) throw new Error('HTTP MCP server requires a URL');
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error('HTTP MCP server URL is invalid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('HTTP MCP server URL must use http or https');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('HTTP MCP server URL cannot contain credentials or a fragment');
  }
  if (url.protocol === 'http:' && !options.allowInsecureHttp && !isLoopbackHost(url.hostname)) {
    throw new Error('Plain HTTP MCP connections are limited to loopback addresses');
  }
  return {url, headers: validateHeaders(config.headers ?? {})};
}

async function validateCwd(
  configured: string | undefined,
  options: McpValidationOptions,
): Promise<string> {
  if (configured !== undefined &&
    (configured.length > 4_000 || CONTROL_CHARACTERS.test(configured))) {
    throw new Error('MCP working directory is invalid or too long');
  }
  const defaultCwd = resolve(options.cwd ?? process.cwd());
  const candidate = configured
    ? (isAbsolute(configured) ? resolve(configured) : resolve(defaultCwd, configured))
    : defaultCwd;
  const roots = options.workspaceRoots?.length
    ? options.workspaceRoots.map((root) => resolve(root))
    : [defaultCwd];
  const resolvedCandidate = await realpath(candidate).catch(() => {
    throw new Error(`MCP working directory does not exist: ${candidate}`);
  });
  const info = await stat(resolvedCandidate).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new Error(`MCP working directory is not a directory: ${candidate}`);
  }
  const resolvedRoots = await Promise.all(roots.map(async (root) =>
    realpath(root).catch(() => root)));
  if (!resolvedRoots.some((root) => isInside(root, resolvedCandidate))) {
    throw new Error(`MCP working directory is outside configured workspace roots: ${candidate}`);
  }
  return resolvedCandidate;
}

function validateEnvironment(environment: Record<string, string>): Record<string, string> {
  const entries = Object.entries(environment);
  if (entries.length > 128) throw new Error('MCP environment has too many entries');
  const validated: Record<string, string> = {};
  for (const [name, value] of entries) {
    const upperName = name.toUpperCase();
    if (!ENV_NAME.test(name) || name.length > 128) {
      throw new Error(`Invalid MCP environment variable name: ${name}`);
    }
    if (UNSAFE_ENV_NAMES.has(upperName) || upperName.startsWith('LD_') ||
      upperName.startsWith('DYLD_') || upperName.startsWith('GIT_')) {
      throw new Error(`Unsafe MCP environment variable is not allowed: ${name}`);
    }
    if (value.length > 20_000 || CONTROL_CHARACTERS.test(value)) {
      throw new Error(`Invalid MCP environment variable value: ${name}`);
    }
    validated[name] = value;
  }
  return validated;
}

function validateHeaders(headers: Record<string, string>): Record<string, string> {
  const entries = Object.entries(headers);
  if (entries.length > 64) throw new Error('MCP HTTP request has too many headers');
  const validated: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name) || name.length > 128) {
      throw new Error(`Invalid MCP HTTP header name: ${name}`);
    }
    if (UNSAFE_HTTP_HEADERS.has(name.toLowerCase())) {
      throw new Error(`MCP HTTP header is reserved: ${name}`);
    }
    if (value.length > 20_000 || /[\r\n\u0000]/.test(value)) {
      throw new Error(`Invalid MCP HTTP header value: ${name}`);
    }
    validated[name] = value;
  }
  return validated;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4Loopback = normalized.split('.');
  const isIpv4Loopback = ipv4Loopback.length === 4 && ipv4Loopback[0] === '127' &&
    ipv4Loopback.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
  return normalized === 'localhost' || normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' || isIpv4Loopback;
}
