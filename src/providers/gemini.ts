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

interface GeminiResponse {
  candidates?: Array<{
    content?: {parts?: Array<{
      text?: string;
      functionCall?: {name?: string; args?: unknown};
    }>};
    finishReason?: string;
  }>;
  usageMetadata?: {promptTokenCount?: number; candidatesTokenCount?: number};
}

export class GeminiProvider implements ModelProvider {
  readonly name = 'gemini';

  constructor(private readonly config: ModelConfig) {}

  async complete(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    maxOutputTokens?: number,
  ): Promise<ModelResponse> {
    const apiKey = requireApiKey(this.config);
    const base = this.config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    const endpoint = `${joinUrl(base, `models/${this.config.model}:generateContent`)}?key=${encodeURIComponent(apiKey)}`;
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        systemInstruction: system ? {parts: [{text: system}]} : undefined,
        contents: messages
          .filter((message) => message.role !== 'system')
          .map(toGeminiMessage),
        tools: tools.length ? [{
          functionDeclarations: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        }] : undefined,
        generationConfig: {
          temperature: this.config.temperature,
          maxOutputTokens: maxOutputTokens ?? this.config.maxTokens,
        },
      }),
      ...(signal ? {signal} : {}),
    });
    if (!response.ok) return parseErrorResponse(response);
    const data = await response.json() as GeminiResponse;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    return {
      content: parts.map((part) => part.text ?? '').filter(Boolean).join('\n'),
      toolCalls: parts
        .filter((part) => part.functionCall)
        .map((part) => ({
          id: randomUUID(),
          name: part.functionCall?.name ?? 'unknown',
          arguments: safeJsonArguments(part.functionCall?.args),
        })),
      usage: {
        ...(data.usageMetadata?.promptTokenCount !== undefined
          ? {inputTokens: data.usageMetadata.promptTokenCount}
          : {}),
        ...(data.usageMetadata?.candidatesTokenCount !== undefined
          ? {outputTokens: data.usageMetadata.candidatesTokenCount}
          : {}),
      },
      ...(candidate?.finishReason ? {stopReason: candidate.finishReason} : {}),
    };
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    maxOutputTokens?: number,
  ): AsyncIterable<ModelStreamChunk> {
    const apiKey = requireApiKey(this.config);
    const base = this.config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    const endpoint = `${joinUrl(base, `models/${this.config.model}:streamGenerateContent`)}?alt=sse&key=${encodeURIComponent(apiKey)}`;
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        systemInstruction: system ? {parts: [{text: system}]} : undefined,
        contents: messages.filter((message) => message.role !== 'system').map(toGeminiMessage),
        tools: tools.length ? [{
          functionDeclarations: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        }] : undefined,
        generationConfig: {
          temperature: this.config.temperature,
          maxOutputTokens: maxOutputTokens ?? this.config.maxTokens,
        },
      }),
      ...(signal ? {signal} : {}),
    });
    if (!response.ok) return parseErrorResponse(response);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const normalized = normalizeGeminiResponse(await response.json() as GeminiResponse);
      if (normalized.content) yield {type: 'text_delta', content: normalized.content};
      yield {type: 'result', response: normalized};
      return;
    }

    let content = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: string | undefined;
    const toolCalls: ModelResponse['toolCalls'] = [];
    for await (const event of parseServerSentEvents(response)) {
      if (event.data === '[DONE]') break;
      const chunk = JSON.parse(event.data) as GeminiResponse;
      if (chunk.usageMetadata?.promptTokenCount !== undefined) {
        inputTokens = chunk.usageMetadata.promptTokenCount;
      }
      if (chunk.usageMetadata?.candidatesTokenCount !== undefined) {
        outputTokens = chunk.usageMetadata.candidatesTokenCount;
      }
      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason) stopReason = candidate.finishReason;
      for (const part of candidate?.content?.parts ?? []) {
        if (part.text) {
          content += part.text;
          yield {type: 'text_delta', content: part.text};
        }
        if (part.functionCall) {
          toolCalls.push({
            id: randomUUID(),
            name: part.functionCall.name ?? 'unknown',
            arguments: safeJsonArguments(part.functionCall.args),
          });
        }
      }
    }
    yield {
      type: 'result',
      response: {
        content,
        toolCalls,
        usage: {
          ...(inputTokens !== undefined ? {inputTokens} : {}),
          ...(outputTokens !== undefined ? {outputTokens} : {}),
        },
        ...(stopReason ? {stopReason} : {}),
      },
    };
  }
}

function normalizeGeminiResponse(data: GeminiResponse): ModelResponse {
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  return {
    content: parts.map((part) => part.text ?? '').filter(Boolean).join('\n'),
    toolCalls: parts.filter((part) => part.functionCall).map((part) => ({
      id: randomUUID(),
      name: part.functionCall?.name ?? 'unknown',
      arguments: safeJsonArguments(part.functionCall?.args),
    })),
    usage: {
      ...(data.usageMetadata?.promptTokenCount !== undefined
        ? {inputTokens: data.usageMetadata.promptTokenCount}
        : {}),
      ...(data.usageMetadata?.candidatesTokenCount !== undefined
        ? {outputTokens: data.usageMetadata.candidatesTokenCount}
        : {}),
    },
    ...(candidate?.finishReason ? {stopReason: candidate.finishReason} : {}),
  };
}

function toGeminiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'user',
      parts: [{functionResponse: {
        name: message.name,
        response: {result: message.content, toolCallId: message.toolCallId},
      }}],
    };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'model',
      parts: [
        ...(message.content ? [{text: message.content}] : []),
        ...message.toolCalls.map((call) => ({
          functionCall: {name: call.name, args: call.arguments},
        })),
      ],
    };
  }
  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{text: message.content}],
  };
}
