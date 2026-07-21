import {createHash} from 'node:crypto';
import type {RequestOptions} from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {Tool as McpSdkTool} from '@modelcontextprotocol/sdk/types.js';
import stripAnsi from 'strip-ansi';
import type {AgentTool, ToolExecution} from '../tools/types.js';
import {ToolInputError} from '../tools/types.js';

const MAX_ARGUMENT_BYTES = 256_000;
const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_RESULT_LENGTH = 80_000;
const MAX_SCHEMA_BYTES = 100_000;

export type McpRemoteTool = Pick<
  McpSdkTool,
  'name' | 'description' | 'inputSchema' | 'annotations' | 'execution' | 'title'
>;

export type McpCallTool = (
  params: {name: string; arguments?: Record<string, unknown>},
  options: RequestOptions,
) => Promise<unknown>;

export interface McpToolAdapterOptions {
  serverName: string;
  exposedName: string;
  remoteTool: McpRemoteTool;
  timeoutMs: number;
  callTool: McpCallTool;
}

export function createMcpToolAdapter(options: McpToolAdapterOptions): AgentTool {
  const {remoteTool} = options;
  const inputSchema = copyInputSchema(remoteTool.inputSchema);
  return {
    definition: {
      name: options.exposedName,
      description: describeTool(options.serverName, remoteTool),
      // MCP servers are an external trust boundary. Read-only annotations are
      // hints from that server and must not lower the local permission level.
      category: 'network',
      inputSchema,
    },
    permissionCategories: () => ['network'],
    async execute(arguments_, context): Promise<ToolExecution> {
      assertArguments(arguments_);
      const result = await options.callTool({
        name: remoteTool.name,
        arguments: arguments_,
      }, {
        timeout: options.timeoutMs,
        maxTotalTimeout: options.timeoutMs,
        ...(context.signal ? {signal: context.signal} : {}),
      });
      const normalized = normalizeCallResult(result);
      return {
        ok: !normalized.isError,
        content: normalized.content,
        metadata: {
          mcpServer: options.serverName,
          mcpTool: remoteTool.name,
          ...(normalized.isError ? {mcpError: true} : {}),
        },
      };
    },
  };
}

export function makeMcpToolName(namespace: string, remoteName: string): string {
  const prefix = normalizeToolSegment(namespace, 'server');
  const tool = normalizeToolSegment(remoteName, 'tool');
  return fitToolName(`mcp_${prefix}_${tool}`, `${namespace}\u0000${remoteName}`);
}

export function disambiguateMcpToolName(
  baseName: string,
  serverName: string,
  remoteName: string,
): string {
  return fitToolName(
    `${baseName}_${shortHash(`${serverName}\u0000${remoteName}`)}`,
    `${serverName}\u0000${remoteName}`,
  );
}

export function isUsableRemoteTool(tool: McpRemoteTool): boolean {
  if (!tool.name || tool.name.length > 256 || /[\u0000-\u001f\u007f]/.test(tool.name)) {
    return false;
  }
  // Required task execution needs the experimental polling API. Hiding those
  // tools is safer than advertising an adapter that cannot complete the call.
  if (tool.execution?.taskSupport === 'required') return false;
  try {
    return JSON.stringify(tool.inputSchema).length <= MAX_SCHEMA_BYTES;
  } catch {
    return false;
  }
}

function describeTool(serverName: string, tool: McpRemoteTool): string {
  const label = stripAnsi(tool.title?.trim() || tool.name)
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
  const description = tool.description ? stripAnsi(tool.description)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim().slice(0, MAX_DESCRIPTION_LENGTH)
    : undefined;
  return description
    ? `[MCP ${serverName}/${label}] ${description}`
    : `Call the ${label} tool provided by the ${serverName} MCP server.`;
}

function copyInputSchema(schema: McpRemoteTool['inputSchema']): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  } catch {
    return {type: 'object', properties: {}};
  }
}

function assertArguments(arguments_: Record<string, unknown>): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(arguments_);
  } catch {
    throw new ToolInputError('MCP tool arguments must be JSON serializable');
  }
  if (serialized.length > MAX_ARGUMENT_BYTES) {
    throw new ToolInputError('MCP tool arguments exceed the 256 KB limit');
  }
}

function normalizeCallResult(result: unknown): {content: string; isError: boolean} {
  if (!isRecord(result)) {
    return {content: truncateResult(safeJson(result)), isError: false};
  }
  const isError = result.isError === true;
  const sections: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) sections.push(formatContentBlock(block));
  }
  if (result.structuredContent !== undefined) {
    sections.push(`Structured result:\n${safeJson(result.structuredContent)}`);
  }
  if (result.toolResult !== undefined) {
    sections.push(`Task result:\n${safeJson(result.toolResult)}`);
  }
  const content = sections.filter(Boolean).join('\n\n') ||
    (isError ? 'The MCP tool reported an error.' : 'The MCP tool completed without output.');
  return {content: truncateResult(content), isError};
}

function formatContentBlock(block: unknown): string {
  if (!isRecord(block) || typeof block.type !== 'string') return safeJson(block);
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? sanitizeOutputText(block.text) : '[invalid text content]';
    case 'image':
    case 'audio': {
      const mimeType = typeof block.mimeType === 'string'
        ? sanitizeInlineText(block.mimeType)
        : 'unknown';
      const bytes = typeof block.data === 'string' ? Math.floor(block.data.length * 0.75) : 0;
      return `[${block.type}: ${mimeType}, approximately ${bytes} bytes]`;
    }
    case 'resource':
      return formatEmbeddedResource(block.resource);
    case 'resource_link': {
      const name = typeof block.name === 'string' ? sanitizeInlineText(block.name) : 'resource';
      const uri = typeof block.uri === 'string' ? sanitizeInlineText(block.uri) : 'unknown URI';
      return `[resource link: ${name} (${uri})]`;
    }
    default:
      return safeJson(block);
  }
}

function formatEmbeddedResource(resource: unknown): string {
  if (!isRecord(resource)) return '[invalid embedded resource]';
  const uri = typeof resource.uri === 'string' ? sanitizeInlineText(resource.uri) : 'unknown URI';
  if (typeof resource.text === 'string') {
    return `Resource ${uri}:\n${sanitizeOutputText(resource.text)}`;
  }
  if (typeof resource.blob === 'string') {
    const mimeType = typeof resource.mimeType === 'string'
      ? sanitizeInlineText(resource.mimeType)
      : 'unknown';
    return `[embedded resource: ${uri}, ${mimeType}, approximately ${Math.floor(resource.blob.length * 0.75)} bytes]`;
  }
  return `[embedded resource: ${uri}]`;
}

function normalizeToolSegment(value: string, fallback: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) return fallback;
  return /^[a-z]/.test(normalized) ? normalized : `${fallback}_${normalized}`;
}

function fitToolName(name: string, identity: string): string {
  if (name.length <= 64) return name;
  const suffix = `_${shortHash(identity)}`;
  return `${name.slice(0, 64 - suffix.length).replace(/_+$/g, '')}${suffix}`;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function truncateResult(content: string): string {
  if (content.length <= MAX_RESULT_LENGTH) return content;
  return `${content.slice(0, MAX_RESULT_LENGTH)}\n... MCP result truncated`;
}

function sanitizeOutputText(value: string): string {
  return stripAnsi(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function sanitizeInlineText(value: string): string {
  return sanitizeOutputText(value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 2_000);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
