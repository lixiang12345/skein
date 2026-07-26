import {createHash, randomUUID} from 'node:crypto';
import type {
  ChatMessage,
  ModelConfig,
  ModelResponse,
  ProviderHostedToolEvent,
  ProviderSource,
  ToolDefinition,
} from '../types.js';
import {
  apiKeyHeaders,
  joinUrl,
  parseErrorResponse,
  parseServerSentEvents,
  requireApiKey,
  safeJsonArguments,
  sanitizeProviderErrorText,
  ProviderError,
  type ModelProvider,
  type ModelStreamChunk,
} from './provider.js';

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: {cached_tokens?: number};
  output_tokens_details?: {reasoning_tokens?: number};
}

interface ResponsesOutputItem {
  id?: string;
  type?: string;
  status?: string;
  role?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  action?: {
    sources?: Array<{type?: string; url?: string; title?: string}>;
  };
  content?: Array<{
    type?: string;
    text?: string;
    annotations?: Array<{type?: string; url?: string; title?: string}>;
  }>;
}

interface ResponsesResponse {
  status?: string;
  output_text?: string;
  output?: ResponsesOutputItem[];
  usage?: ResponsesUsage;
  incomplete_details?: {reason?: string};
}

interface ResponsesStreamEvent {
  type?: string;
  delta?: string;
  item_id?: string;
  output_index?: number;
  item?: ResponsesOutputItem;
  response?: ResponsesResponse & {error?: {message?: string}};
  error?: {message?: string};
}

interface StreamedFunctionCall {
  id: string;
  name: string;
  arguments: string;
}

const MAX_RESPONSES_OUTPUT_ITEMS = 128;
const MAX_RESPONSES_REPLAY_BYTES = 4 * 1024 * 1024;

/** Stateless OpenAI Responses transport for third-party compatible relays. */
export class ResponsesProvider implements ModelProvider {
  readonly name: string;

  constructor(private readonly config: ModelConfig) {
    this.name = config.provider === 'compatible' ? 'compatible' : 'openai';
  }

  async complete(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    maxOutputTokens?: number,
  ): Promise<ModelResponse> {
    const response = await this.request(messages, tools, false, signal, maxOutputTokens);
    if (!response.ok) return parseErrorResponse(response, [this.config.apiKey]);
    return normalizeResponsesResponse(await response.json() as ResponsesResponse);
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    maxOutputTokens?: number,
  ): AsyncIterable<ModelStreamChunk> {
    const response = await this.request(messages, tools, true, signal, maxOutputTokens);
    if (!response.ok) return parseErrorResponse(response, [this.config.apiKey]);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const normalized = normalizeResponsesResponse(await response.json() as ResponsesResponse);
      if (normalized.content) yield {type: 'text_delta', content: normalized.content};
      yield {type: 'result', response: normalized};
      return;
    }

    let content = '';
    let completed: ResponsesResponse | undefined;
    const calls = new Map<string, StreamedFunctionCall>();
    for await (const event of parseServerSentEvents(response)) {
      if (event.data === '[DONE]') break;
      const chunk = JSON.parse(event.data) as ResponsesStreamEvent;
      const eventType = chunk.type ?? event.event;
      if (eventType === 'response.output_text.delta' && chunk.delta) {
        content += chunk.delta;
        yield {type: 'text_delta', content: chunk.delta};
      }
      if (eventType === 'response.output_item.added' && chunk.item?.type === 'function_call') {
        const key = streamCallKey(chunk);
        calls.set(key, {
          id: chunk.item.call_id ?? chunk.item.id ?? randomUUID(),
          name: chunk.item.name ?? 'unknown',
          arguments: chunk.item.arguments ?? '',
        });
      }
      if (eventType === 'response.function_call_arguments.delta') {
        const key = streamCallKey(chunk);
        const call = calls.get(key) ?? {id: chunk.item_id ?? randomUUID(), name: 'unknown', arguments: ''};
        call.arguments += chunk.delta ?? '';
        calls.set(key, call);
      }
      if (eventType === 'response.output_item.done' && chunk.item?.type === 'function_call') {
        const key = streamCallKey(chunk);
        const existing = calls.get(key);
        calls.set(key, {
          id: chunk.item.call_id ?? existing?.id ?? chunk.item.id ?? randomUUID(),
          name: chunk.item.name ?? existing?.name ?? 'unknown',
          arguments: chunk.item.arguments ?? existing?.arguments ?? '',
        });
      }
      if (eventType === 'response.completed' || eventType === 'response.incomplete') {
        completed = chunk.response;
      }
      if (eventType === 'error' || eventType === 'response.failed') {
        throw new ProviderError(sanitizeProviderErrorText(
          chunk.error?.message ?? chunk.response?.error?.message ?? 'Model API stream failed.',
          [this.config.apiKey],
        ));
      }
    }

    const normalized = completed ? normalizeResponsesResponse(completed) : emptyResponsesResult();
    const streamedCalls = [...calls.values()].map((call) => ({
      id: call.id,
      name: call.name,
      arguments: safeJsonArguments(call.arguments),
    }));
    yield {
      type: 'result',
      response: {
        ...normalized,
        content: content || normalized.content,
        toolCalls: normalized.toolCalls.length ? normalized.toolCalls : streamedCalls,
      },
    };
  }

  private async request(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    stream: boolean,
    signal?: AbortSignal,
    maxOutputTokens?: number,
  ): Promise<Response> {
    const apiKey = this.config.provider === 'compatible'
      ? this.config.apiKey
      : requireApiKey(this.config);
    if (this.config.provider === 'compatible' && !this.config.baseUrl) {
      throw new ProviderError('Responses-compatible providers require a baseUrl.');
    }
    const base = this.config.baseUrl ?? 'https://api.openai.com/v1';
    const endpoint = base.endsWith('/responses') ? base : joinUrl(base, 'responses');
    return fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...apiKeyHeaders(apiKey, this.config.apiKeyHeader, 'bearer'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        input: messages.flatMap(toResponsesInput),
        tools: [
          ...tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: false,
          })),
          ...(this.config.hostedTools ?? []).map((tool) => ({type: tool})),
        ],
        tool_choice: tools.length || this.config.hostedTools?.length ? 'auto' : undefined,
        include: this.config.hostedTools?.includes('web_search')
          ? ['web_search_call.action.sources']
          : undefined,
        store: false,
        stream,
        max_output_tokens: maxOutputTokens ?? this.config.maxTokens,
      }),
      ...(signal ? {signal} : {}),
    });
  }
}

function toResponsesInput(message: ChatMessage): Record<string, unknown>[] {
  if (message.role === 'tool') {
    return [{
      type: 'function_call_output',
      call_id: message.toolCallId,
      output: message.content,
    }];
  }
  const storedOutput = message.providerMetadata?.responses?.outputItems;
  if (message.role === 'assistant' && storedOutput?.length) return storedOutput;
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return [
      ...(message.content ? [{type: 'message', role: 'assistant', content: message.content}] : []),
      ...message.toolCalls.map((call) => ({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      })),
    ];
  }
  return [{type: 'message', role: message.role, content: message.content}];
}

function normalizeResponsesResponse(data: ResponsesResponse): ModelResponse {
  if (data.output !== undefined && !Array.isArray(data.output)) {
    throw new ProviderError('Model API returned an invalid Responses output array.');
  }
  const output = data.output ?? [];
  if (output.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new ProviderError('Model API returned an invalid Responses output item.');
  }
  const toolCalls = output.filter((item) => item.type === 'function_call').map((item) => ({
    id: item.call_id ?? item.id ?? randomUUID(),
    name: item.name ?? 'unknown',
    arguments: safeJsonArguments(item.arguments),
  }));
  const outputText = output.flatMap((item) => item.type === 'message'
    ? (item.content ?? []).flatMap((part) => part.type === 'output_text' && typeof part.text === 'string' ? [part.text] : [])
    : []).join('');
  const hostedTools = normalizeHostedTools(output);
  const sources = normalizeSources(output);
  const providerMetadata = {
    ...(output.length ? {responses: {outputItems: boundedOutputItems(output)}} : {}),
    ...(hostedTools.length ? {hostedTools} : {}),
    ...(sources.length ? {sources} : {}),
  };
  return {
    content: data.output_text ?? outputText,
    toolCalls,
    usage: normalizeResponsesUsage(data.usage),
    ...(Object.keys(providerMetadata).length ? {providerMetadata} : {}),
    ...(toolCalls.length
      ? {stopReason: 'tool_calls'}
      : data.incomplete_details?.reason
        ? {stopReason: data.incomplete_details.reason}
        : data.status ? {stopReason: data.status} : {}),
  };
}

function normalizeHostedTools(output: ResponsesOutputItem[]): ProviderHostedToolEvent[] {
  return output.flatMap((item, index) => item.type === 'web_search_call'
    ? [{
        id: hostedToolId(item.id, index),
        tool: 'web_search' as const,
        status: hostedToolStatus(item.status),
      }]
    : []);
}

function hostedToolId(value: string | undefined, index: number): string {
  if (value && /^[A-Za-z0-9._:-]{1,256}$/u.test(value)) return value;
  if (value) return `web-search:${createHash('sha256').update(value).digest('hex')}`;
  return `web-search:${index}`;
}

function hostedToolStatus(value: string | undefined): ProviderHostedToolEvent['status'] {
  if (value === 'completed' || value === 'incomplete' || value === 'failed') return value;
  return 'unknown';
}

function normalizeSources(output: ResponsesOutputItem[]): ProviderSource[] {
  const candidates = output.flatMap((item) => [
    ...(item.action?.sources ?? []),
    ...(item.content ?? []).flatMap((part) => part.annotations ?? []),
  ]);
  const sources = new Map<string, ProviderSource>();
  for (const candidate of candidates) {
    if (candidate.type !== undefined && candidate.type !== 'url_citation' && candidate.type !== 'url') continue;
    const source = providerSource(candidate.url, candidate.title);
    if (source) sources.set(source.id, source);
  }
  return [...sources.values()].slice(0, 256);
}

function providerSource(rawUrl: string | undefined, rawTitle: string | undefined): ProviderSource | undefined {
  if (!rawUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  const urlSha256 = createHash('sha256').update(rawUrl).digest('hex');
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  const url = parsed.toString();
  if (url.length > 4_000) return undefined;
  const title = rawTitle?.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim().slice(0, 500);
  return {
    id: `source:${urlSha256}`,
    type: 'url_citation',
    url,
    urlSha256,
    ...(title ? {title} : {}),
  };
}

function boundedOutputItems(output: ResponsesOutputItem[]): Record<string, unknown>[] {
  if (output.length > MAX_RESPONSES_OUTPUT_ITEMS) {
    throw new ProviderError(`Model API returned more than ${MAX_RESPONSES_OUTPUT_ITEMS} Responses output items.`);
  }
  const serialized = JSON.stringify(output);
  if (new TextEncoder().encode(serialized).byteLength > MAX_RESPONSES_REPLAY_BYTES) {
    throw new ProviderError('Model API returned Responses replay state larger than the 4 MiB safety limit.');
  }
  return JSON.parse(serialized) as Record<string, unknown>[];
}

function normalizeResponsesUsage(usage: ResponsesUsage | undefined): NonNullable<ModelResponse['usage']> {
  return {
    ...(usage?.input_tokens !== undefined ? {inputTokens: usage.input_tokens} : {}),
    ...(usage?.output_tokens !== undefined ? {outputTokens: usage.output_tokens} : {}),
    ...(usage?.input_tokens_details?.cached_tokens !== undefined
      ? {cachedInputTokens: usage.input_tokens_details.cached_tokens} : {}),
    ...(usage?.output_tokens_details?.reasoning_tokens !== undefined
      ? {reasoningTokens: usage.output_tokens_details.reasoning_tokens} : {}),
  };
}

function emptyResponsesResult(): ModelResponse {
  return {content: '', toolCalls: [], usage: {}};
}

function streamCallKey(chunk: Pick<ResponsesStreamEvent, 'item_id' | 'output_index' | 'item'>): string {
  return chunk.item_id ?? chunk.item?.id ?? `output:${chunk.output_index ?? 0}`;
}
