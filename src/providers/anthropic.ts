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

interface AnthropicResponse {
  content?: Array<{
    type: 'text' | 'tool_use';
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  stop_reason?: string;
  usage?: {input_tokens?: number; output_tokens?: number};
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  message?: {usage?: {input_tokens?: number; output_tokens?: number}};
  content_block?: {
    type?: 'text' | 'tool_use';
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: {input_tokens?: number; output_tokens?: number};
}

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';

  constructor(private readonly config: ModelConfig) {}

  async complete(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    maxOutputTokens?: number,
  ): Promise<ModelResponse> {
    const apiKey = requireApiKey(this.config);
    const base = this.config.baseUrl ?? 'https://api.anthropic.com/v1';
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const response = await fetch(joinUrl(base, 'messages'), {
      method: 'POST',
      redirect: 'error',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        system,
        messages: messages
          .filter((message) => message.role !== 'system')
          .map(toAnthropicMessage),
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        })),
        max_tokens: maxOutputTokens ?? this.config.maxTokens ?? 8192,
        temperature: this.config.temperature,
      }),
      ...(signal ? {signal} : {}),
    });
    if (!response.ok) return parseErrorResponse(response);
    const data = await response.json() as AnthropicResponse;
    const blocks = data.content ?? [];
    return {
      content: blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n'),
      toolCalls: blocks
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({
          id: block.id ?? randomUUID(),
          name: block.name ?? 'unknown',
          arguments: safeJsonArguments(block.input),
        })),
      usage: {
        ...(data.usage?.input_tokens !== undefined
          ? {inputTokens: data.usage.input_tokens}
          : {}),
        ...(data.usage?.output_tokens !== undefined
          ? {outputTokens: data.usage.output_tokens}
          : {}),
      },
      ...(data.stop_reason ? {stopReason: data.stop_reason} : {}),
    };
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    maxOutputTokens?: number,
  ): AsyncIterable<ModelStreamChunk> {
    const apiKey = requireApiKey(this.config);
    const base = this.config.baseUrl ?? 'https://api.anthropic.com/v1';
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const response = await fetch(joinUrl(base, 'messages'), {
      method: 'POST',
      redirect: 'error',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        system,
        messages: messages.filter((message) => message.role !== 'system').map(toAnthropicMessage),
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        })),
        max_tokens: maxOutputTokens ?? this.config.maxTokens ?? 8192,
        temperature: this.config.temperature,
        stream: true,
      }),
      ...(signal ? {signal} : {}),
    });
    if (!response.ok) return parseErrorResponse(response);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const normalized = normalizeAnthropicResponse(await response.json() as AnthropicResponse);
      if (normalized.content) yield {type: 'text_delta', content: normalized.content};
      yield {type: 'result', response: normalized};
      return;
    }

    let content = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: string | undefined;
    const calls = new Map<number, {
      id: string;
      name: string;
      input: unknown;
      partialJson: string;
    }>();
    for await (const event of parseServerSentEvents(response)) {
      const chunk = JSON.parse(event.data) as AnthropicStreamEvent;
      if (chunk.message?.usage?.input_tokens !== undefined) {
        inputTokens = chunk.message.usage.input_tokens;
      }
      if (chunk.usage?.input_tokens !== undefined) inputTokens = chunk.usage.input_tokens;
      if (chunk.usage?.output_tokens !== undefined) outputTokens = chunk.usage.output_tokens;
      if (chunk.delta?.stop_reason) stopReason = chunk.delta.stop_reason;
      const index = chunk.index ?? 0;
      if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'text') {
        const initial = chunk.content_block.text ?? '';
        if (initial) {
          content += initial;
          yield {type: 'text_delta', content: initial};
        }
      }
      if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
        calls.set(index, {
          id: chunk.content_block.id ?? randomUUID(),
          name: chunk.content_block.name ?? 'unknown',
          input: chunk.content_block.input,
          partialJson: '',
        });
      }
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta' && chunk.delta.text) {
        content += chunk.delta.text;
        yield {type: 'text_delta', content: chunk.delta.text};
      }
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'input_json_delta') {
        const call = calls.get(index) ?? {id: randomUUID(), name: 'unknown', input: undefined, partialJson: ''};
        call.partialJson += chunk.delta.partial_json ?? '';
        calls.set(index, call);
      }
    }
    yield {
      type: 'result',
      response: {
        content,
        toolCalls: [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({
          id: call.id,
          name: call.name,
          arguments: safeJsonArguments(call.partialJson || call.input),
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

function normalizeAnthropicResponse(data: AnthropicResponse): ModelResponse {
  const blocks = data.content ?? [];
  return {
    content: blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n'),
    toolCalls: blocks.filter((block) => block.type === 'tool_use').map((block) => ({
      id: block.id ?? randomUUID(),
      name: block.name ?? 'unknown',
      arguments: safeJsonArguments(block.input),
    })),
    usage: {
      ...(data.usage?.input_tokens !== undefined ? {inputTokens: data.usage.input_tokens} : {}),
      ...(data.usage?.output_tokens !== undefined ? {outputTokens: data.usage.output_tokens} : {}),
    },
    ...(data.stop_reason ? {stopReason: data.stop_reason} : {}),
  };
}

function toAnthropicMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
      }],
    };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: [
        ...(message.content ? [{type: 'text', text: message.content}] : []),
        ...message.toolCalls.map((call) => ({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments,
        })),
      ],
    };
  }
  return {role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content};
}
