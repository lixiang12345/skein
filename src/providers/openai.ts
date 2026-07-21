import {randomUUID} from 'node:crypto';
import type {
  ChatMessage,
  ModelConfig,
  ModelResponse,
  ToolDefinition,
} from '../types.js';
import {
  joinUrl,
  parseErrorResponse,
  parseServerSentEvents,
  requireApiKey,
  safeJsonArguments,
  type ModelStreamChunk,
  type ModelProvider,
} from './provider.js';

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: {name?: string; arguments?: string};
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {prompt_tokens?: number; completion_tokens?: number};
}

interface OpenAIStreamResponse {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: {name?: string; arguments?: string};
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {prompt_tokens?: number; completion_tokens?: number};
}

export class OpenAIProvider implements ModelProvider {
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
    const apiKey = this.config.provider === 'compatible'
      ? this.config.apiKey
      : requireApiKey(this.config);
    if (this.config.provider === 'compatible' && !this.config.baseUrl) {
      throw new Error('OpenAI-compatible providers require a baseUrl.');
    }
    const base = this.config.baseUrl ?? 'https://api.openai.com/v1';
    const endpoint = base.endsWith('/chat/completions')
      ? base
      : joinUrl(base, 'chat/completions');
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map(toOpenAIMessage),
      tools: tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      tool_choice: tools.length ? 'auto' : undefined,
      ...(this.config.provider === 'compatible'
        ? {max_tokens: maxOutputTokens ?? this.config.maxTokens}
        : {max_completion_tokens: maxOutputTokens ?? this.config.maxTokens}),
    };
    if (!this.config.model.startsWith('gpt-5')) {
      body.temperature = this.config.temperature;
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...(apiKey ? {authorization: `Bearer ${apiKey}`} : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      ...(signal ? {signal} : {}),
    });
    if (!response.ok) return parseErrorResponse(response);
    const data = await response.json() as OpenAIResponse;
    return normalizeOpenAIResponse(data);
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    maxOutputTokens?: number,
  ): AsyncIterable<ModelStreamChunk> {
    const apiKey = this.config.provider === 'compatible'
      ? this.config.apiKey
      : requireApiKey(this.config);
    if (this.config.provider === 'compatible' && !this.config.baseUrl) {
      throw new Error('OpenAI-compatible providers require a baseUrl.');
    }
    const base = this.config.baseUrl ?? 'https://api.openai.com/v1';
    const endpoint = base.endsWith('/chat/completions')
      ? base
      : joinUrl(base, 'chat/completions');
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map(toOpenAIMessage),
      tools: tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      tool_choice: tools.length ? 'auto' : undefined,
      stream: true,
      ...(this.config.provider === 'compatible' ? {} : {stream_options: {include_usage: true}}),
      ...(this.config.provider === 'compatible'
        ? {max_tokens: maxOutputTokens ?? this.config.maxTokens}
        : {max_completion_tokens: maxOutputTokens ?? this.config.maxTokens}),
    };
    if (!this.config.model.startsWith('gpt-5')) body.temperature = this.config.temperature;
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...(apiKey ? {authorization: `Bearer ${apiKey}`} : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      ...(signal ? {signal} : {}),
    });
    if (!response.ok) {
      if (this.config.provider === 'compatible' && [400, 404, 415].includes(response.status)) {
        const fallback = await this.complete(messages, tools, signal, maxOutputTokens);
        if (fallback.content) yield {type: 'text_delta', content: fallback.content};
        yield {type: 'result', response: fallback};
        return;
      }
      return parseErrorResponse(response);
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const data = await response.json() as OpenAIResponse;
      const normalized = normalizeOpenAIResponse(data);
      if (normalized.content) yield {type: 'text_delta', content: normalized.content};
      yield {type: 'result', response: normalized};
      return;
    }

    let content = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: string | undefined;
    const calls = new Map<number, {id: string; name: string; arguments: string}>();
    for await (const event of parseServerSentEvents(response)) {
      if (event.data === '[DONE]') break;
      const chunk = JSON.parse(event.data) as OpenAIStreamResponse;
      if (chunk.usage?.prompt_tokens !== undefined) inputTokens = chunk.usage.prompt_tokens;
      if (chunk.usage?.completion_tokens !== undefined) outputTokens = chunk.usage.completion_tokens;
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      const delta = choice?.delta;
      if (delta?.content) {
        content += delta.content;
        yield {type: 'text_delta', content: delta.content};
      }
      for (const fragment of delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const current = calls.get(index) ?? {id: randomUUID(), name: '', arguments: ''};
        if (fragment.id) current.id = fragment.id;
        if (fragment.function?.name) current.name += fragment.function.name;
        if (fragment.function?.arguments) current.arguments += fragment.function.arguments;
        calls.set(index, current);
      }
    }
    yield {
      type: 'result',
      response: {
        content,
        toolCalls: [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({
          id: call.id,
          name: call.name || 'unknown',
          arguments: safeJsonArguments(call.arguments),
        })),
        usage: {
          ...(inputTokens !== undefined ? {inputTokens} : {}),
          ...(outputTokens !== undefined ? {outputTokens} : {}),
        },
        ...(stopReason ? {stopReason} : {}),
      },
    };
  }
}

function normalizeOpenAIResponse(data: OpenAIResponse): ModelResponse {
  const choice = data.choices?.[0];
  const message = choice?.message;
  if (!message) throw new Error('Model API returned no response message.');
  return {
    content: message.content ?? '',
    toolCalls: (message.tool_calls ?? []).map((call) => ({
      id: call.id ?? randomUUID(),
      name: call.function?.name ?? 'unknown',
      arguments: safeJsonArguments(call.function?.arguments),
    })),
    usage: {
      ...(data.usage?.prompt_tokens !== undefined ? {inputTokens: data.usage.prompt_tokens} : {}),
      ...(data.usage?.completion_tokens !== undefined ? {outputTokens: data.usage.completion_tokens} : {}),
    },
    ...(choice?.finish_reason ? {stopReason: choice.finish_reason} : {}),
  };
}

function toOpenAIMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
      name: message.name,
    };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    };
  }
  return {role: message.role, content: message.content};
}
