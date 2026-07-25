import type {
  ChatMessage,
  ModelConfig,
  ModelResponse,
  ToolDefinition,
} from '../types.js';
import {PRODUCT_COMMAND} from '../brand.js';

export interface ModelProvider {
  readonly name: string;
  complete(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    maxOutputTokens?: number,
  ): Promise<ModelResponse>;
  stream?(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    maxOutputTokens?: number,
  ): AsyncIterable<ModelStreamChunk>;
}

export type ModelStreamChunk =
  | {type: 'text_delta'; content: string}
  | {type: 'result'; response: ModelResponse};

export interface ServerSentEvent {
  event?: string;
  data: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function requireApiKey(config: ModelConfig): string {
  if (!config.apiKey) {
    const env = config.provider === 'anthropic'
      ? 'ANTHROPIC_API_KEY'
      : config.provider === 'gemini'
        ? 'GEMINI_API_KEY'
        : config.provider === 'openai'
          ? 'OPENAI_API_KEY'
          : 'SKEIN_API_KEY';
    throw new ProviderError(
      `No API key configured for ${config.provider}. Set ${env} or run \`${PRODUCT_COMMAND} config show\`.`,
    );
  }
  return config.apiKey;
}

export async function parseErrorResponse(
  response: Response,
  secrets: Array<string | undefined> = [],
): Promise<never> {
  const rawDetails = await response.text();
  const details = sanitizeProviderErrorText(rawDetails, secrets, 2_000);
  let message = `Model API request failed (${response.status})`;
  try {
    const body = JSON.parse(rawDetails) as {error?: {message?: string} | string};
    if (typeof body.error === 'string') message = body.error;
    else if (body.error && typeof body.error === 'object' && typeof body.error.message === 'string') {
      message = body.error.message;
    }
  } catch {
    if (rawDetails.trim()) message = `${message}: ${rawDetails}`;
  }
  throw new ProviderError(
    sanitizeProviderErrorText(message, secrets, 500),
    response.status,
    details,
  );
}

/** Bounds and redacts untrusted provider diagnostics before they reach any UI or structured output. */
export function sanitizeProviderErrorText(
  input: string,
  secrets: Array<string | undefined> = [],
  maxLength = 500,
): string {
  let value = input
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/gu, '[redacted-secret]')
    .replace(/\b(authorization\s*:\s*(?:bearer\s+|basic\s+)?)\S+/giu, '$1[redacted]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|authorization|cookie|password|client[_-]?secret)\s*[:=]\s*)(?:"[^"]+"|'[^']+'|\S+)/giu, '$1[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/giu, (candidate) => redactDiagnosticUrl(candidate));
  for (const secret of secrets) {
    if (!secret) continue;
    value = value.split(secret).join('[redacted-secret]');
  }
  const normalized = value.trim();
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1))}…` : normalized;
}

function redactDiagnosticUrl(candidate: string): string {
  try {
    const url = new URL(candidate);
    const authentication = url.username || url.password ? '<redacted>@' : '';
    return `${url.protocol}//${authentication}${url.host}${url.pathname}${url.search ? '?<redacted>' : ''}${url.hash ? '#<redacted>' : ''}`;
  } catch {
    return 'configured endpoint';
  }
}

export function safeJsonArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {_raw: value};
  }
}

export function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/$/, '')}/${suffix.replace(/^\//, '')}`;
}

/** Parse an SSE response incrementally, including multi-line data fields and a final unterminated event. */
export async function* parseServerSentEvents(response: Response): AsyncGenerator<ServerSentEvent> {
  if (!response.body) throw new ProviderError('Model API returned an empty streaming response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const {done, value} = await reader.read();
    buffer += decoder.decode(value, {stream: !done}).replace(/\r\n?/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseEventBlock(block);
      if (event) yield event;
      boundary = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
  const finalEvent = parseEventBlock(buffer);
  if (finalEvent) yield finalEvent;
}

function parseEventBlock(block: string): ServerSentEvent | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  if (!data.length) return undefined;
  return {data: data.join('\n'), ...(event ? {event} : {})};
}
