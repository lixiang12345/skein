import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {basename, isAbsolute, relative, resolve} from 'node:path';
import stripAnsi from 'strip-ansi';
import type {
  CapabilityManifest,
  CapabilityManifestTool,
  McpConfig,
  McpServerConfig,
  McpToolCapabilityConfig,
  ToolCategory,
} from '../types.js';

export interface McpCapabilityTool extends CapabilityManifestTool {}

export interface McpCapabilityManifest extends CapabilityManifest {
  source: {kind: 'mcp'; owner: 'user-config'};
  required: boolean;
  transport: 'stdio' | 'http';
  target: string;
  tools: McpCapabilityTool[];
  dynamicTools: boolean;
}

export interface McpCapabilitySearchResult {
  name: string;
  description: string;
  version: string;
  required: boolean;
  transport: 'stdio' | 'http';
  declaredTools: number;
  score: number;
}

export function buildMcpCapabilityManifest(
  name: string,
  config: McpServerConfig,
  workspace = process.cwd(),
): McpCapabilityManifest {
  const tools = (config.tools ?? []).map((tool) => normalizeTool(tool, workspace));
  return {
    schemaVersion: 1,
    id: `mcp:${sanitizeIdentifier(name, 'server')}`,
    source: {kind: 'mcp', owner: 'user-config'},
    name: sanitizeText(name, 64),
    version: sanitizeText(config.version ?? 'unversioned', 128),
    required: config.required === true,
    transport: config.transport ?? 'stdio',
    target: redactTransportTarget(config),
    tools,
    dynamicTools: tools.length === 0,
  };
}

export function capabilityFingerprint(
  name: string,
  config: McpServerConfig,
  workspace = process.cwd(),
): string {
  const manifest = buildMcpCapabilityManifest(name, config, workspace);
  // Credential values and URL query strings never enter the review artifact.
  // Capability-changing arguments still invalidate trust through one-way hashes.
  const privateTransport = {
    command: config.command ?? null,
    args: config.args ?? [],
    cwd: config.cwd ? resolve(workspace, config.cwd) : null,
    url: config.url ? redactUrl(config.url) : null,
    envNames: Object.keys(config.env ?? {}).sort(),
    headerNames: Object.keys(config.headers ?? {}).map((key) => key.toLocaleLowerCase()).sort(),
  };
  return createHash('sha256')
    .update(stableJson({manifest, privateTransport}))
    .digest('hex');
}

export function searchMcpCapabilities(
  config: McpConfig,
  query: string,
): McpCapabilitySearchResult[] {
  const terms = new Set(sanitizeText(query, 500).toLocaleLowerCase()
    .match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);
  return Object.entries(config.servers ?? {}).map(([name, server]) => {
    const description = sanitizeText(server.description ?? `${server.transport ?? 'stdio'} MCP server`, 200);
    const searchable = [name, description, server.version, ...(server.tools ?? []).flatMap((tool) => [
      tool.name,
      tool.description,
      ...tool.permissions,
      ...(tool.commands ?? []),
      ...(tool.network ?? []),
    ])].filter(Boolean).join(' ').toLocaleLowerCase();
    let score = 0;
    for (const term of terms) if (searchable.includes(term)) score += term.length;
    return {
      name,
      description,
      version: sanitizeText(server.version ?? 'unversioned', 128),
      required: server.required === true,
      transport: server.transport ?? 'stdio',
      declaredTools: server.tools?.length ?? 0,
      score,
    };
  }).filter((result) => terms.size === 0 || result.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
}

export function declaredToolCapability(
  config: McpServerConfig,
  remoteName: string,
  workspace = process.cwd(),
): McpCapabilityTool | undefined {
  const declaration = config.tools?.find((tool) => tool.name === remoteName);
  return declaration ? normalizeTool(declaration, workspace) : undefined;
}

function normalizeTool(tool: McpToolCapabilityConfig, workspace: string): McpCapabilityTool {
  const permissions = uniquePermissions(['network', ...tool.permissions]);
  return {
    name: sanitizeText(tool.name, 256),
    ...(tool.description ? {description: sanitizeText(tool.description, 500)} : {}),
    permissions,
    network: unique(tool.network ?? []).map(redactNetworkTarget),
    commands: unique(tool.commands ?? []).map(redactCommand),
    paths: unique(tool.paths ?? []).map((path) => redactPath(path, workspace)),
    sensitiveFields: unique(tool.sensitiveFields ?? []).map((field) => sanitizeText(field, 256)),
    background: tool.background === true,
    processTree: tool.processTree === true,
    completionEvidence: tool.completionEvidence ?? 'none',
  };
}

function redactTransportTarget(config: McpServerConfig): string {
  if (config.transport === 'http') return config.url ? redactUrl(config.url) : '<unconfigured HTTP endpoint>';
  return config.command
    ? `<stdio command:${sanitizeText(basename(config.command), 128)}>`
    : '<unconfigured stdio command>';
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<invalid URL>';
  }
}

function redactNetworkTarget(value: string): string {
  if (/^https?:\/\//iu.test(value)) return redactUrl(value);
  return sanitizeText(value, 500).replace(/([?&](?:key|token|secret|password)=)[^&\s]*/giu, '$1<redacted>');
}

function redactCommand(value: string): string {
  const command = sanitizeText(value, 500).split(/\s+/u)[0];
  return command ? basename(command) : '<redacted command>';
}

function redactPath(value: string, workspace: string): string {
  const clean = sanitizeText(value, 4_000);
  if (!isAbsolute(clean)) return clean;
  const absolute = resolve(clean);
  const workspaceRelative = relative(resolve(workspace), absolute);
  if (!workspaceRelative.startsWith('..') && !isAbsolute(workspaceRelative)) {
    return `<workspace>/${workspaceRelative || '.'}`;
  }
  const homeRelative = relative(homedir(), absolute);
  if (!homeRelative.startsWith('..') && !isAbsolute(homeRelative)) return `~/${homeRelative}`;
  return `<absolute>/${basename(absolute)}`;
}

function uniquePermissions(values: ToolCategory[]): ToolCategory[] {
  const order: ToolCategory[] = ['read', 'write', 'shell', 'git', 'network'];
  const present = new Set(values);
  return order.filter((category) => present.has(category));
}

function unique(values: string[]): string[] {
  return [...new Set(values)].slice(0, 256);
}

function sanitizeIdentifier(value: string, fallback: string): string {
  return sanitizeText(value, 64).toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '') || fallback;
}

function sanitizeText(value: string, maxLength: number): string {
  return stripAnsi(value)
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
