import {afterEach, describe, expect, it, vi} from 'vitest';
import {AnthropicProvider} from '../../src/providers/anthropic.js';
import {GeminiProvider} from '../../src/providers/gemini.js';
import {OpenAIProvider} from '../../src/providers/openai.js';
import {parseServerSentEvents} from '../../src/providers/provider.js';

afterEach(() => vi.unstubAllGlobals());

describe('provider streaming helpers', () => {
  it('uses OpenAI-compatible endpoint, bearer auth, and message format for compatible relays', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://relay.example/v1/chat/completions');
      expect(init?.headers).toMatchObject({authorization: 'Bearer relay-key', 'content-type': 'application/json'});
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({model: 'relay-model', messages: [], max_tokens: 1024});
      return new Response(JSON.stringify({choices: [{message: {content: 'ok'}, finish_reason: 'stop'}]}), {
        headers: {'content-type': 'application/json'},
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAIProvider({
      provider: 'compatible', model: 'relay-model', baseUrl: 'https://relay.example/v1', apiKey: 'relay-key', maxTokens: 1024,
    });
    expect((await provider.complete([], [])).content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses Anthropic Messages endpoint and headers for Anthropic-compatible relays', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://relay.example/v1/messages');
      expect(init?.headers).toMatchObject({
        'x-api-key': 'relay-key',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({model: 'relay-claude', messages: [], max_tokens: 2048});
      return new Response(JSON.stringify({content: [{type: 'text', text: 'ok'}]}), {
        headers: {'content-type': 'application/json'},
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new AnthropicProvider({
      provider: 'anthropic', model: 'relay-claude', baseUrl: 'https://relay.example/v1', apiKey: 'relay-key', maxTokens: 2048,
    });
    expect((await provider.complete([], [])).content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('parses incremental SSE payloads, comments, multiline data, and a final unterminated event', async () => {
    const response = new Response([
      ': keep-alive\n',
      'event: message\n',
      'data: {"part":"one"}\n\n',
      'data: first\n',
      'data: second\n\n',
      'data: final',
    ].join(''), {headers: {'content-type': 'text/event-stream'}});

    const events = [] as Array<{event?: string; data: string}>;
    for await (const event of parseServerSentEvents(response)) events.push(event);

    expect(events).toEqual([
      {event: 'message', data: '{"part":"one"}'},
      {data: 'first\nsecond'},
      {data: 'final'},
    ]);
  });

  it('normalizes OpenAI-compatible SSE text, tool calls, usage, and the final result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      {choices: [{delta: {content: 'Hello '}}]},
      {choices: [{delta: {content: 'world'}}]},
      {choices: [{delta: {tool_calls: [{index: 0, id: 'call-1', function: {name: 'read_file', arguments: '{"path":"a.ts"}'}}]}}]},
      {choices: [{finish_reason: 'tool_calls'}], usage: {prompt_tokens: 7, completion_tokens: 3}},
      '[DONE]',
    ])));
    const provider = new OpenAIProvider({provider: 'compatible', model: 'test', baseUrl: 'http://127.0.0.1:1234'});

    const chunks = await collect(provider.stream?.([], []) ?? []);

    expect(chunks).toEqual([
      {type: 'text_delta', content: 'Hello '},
      {type: 'text_delta', content: 'world'},
      expect.objectContaining({
        type: 'result',
        response: expect.objectContaining({
          content: 'Hello world',
          toolCalls: [{id: 'call-1', name: 'read_file', arguments: {path: 'a.ts'}}],
          usage: {inputTokens: 7, outputTokens: 3},
        }),
      }),
    ]);
  });

  it('normalizes Anthropic SSE text and streamed JSON tool input', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      {type: 'message_start', message: {usage: {input_tokens: 5}}},
      {type: 'content_block_start', index: 0, content_block: {type: 'text'}},
      {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'Done.'}},
      {type: 'content_block_start', index: 1, content_block: {type: 'tool_use', id: 'tool-1', name: 'read_file', input: {}}},
      {type: 'content_block_delta', index: 1, delta: {type: 'input_json_delta', partial_json: '{"path":"a.ts"}'}},
      {type: 'message_delta', delta: {stop_reason: 'tool_use'}, usage: {output_tokens: 2}},
    ])));
    const provider = new AnthropicProvider({provider: 'anthropic', model: 'test', apiKey: 'key'});

    const chunks = await collect(provider.stream?.([], []) ?? []);

    expect(chunks).toEqual([
      {type: 'text_delta', content: 'Done.'},
      expect.objectContaining({
        type: 'result',
        response: expect.objectContaining({
          content: 'Done.',
          toolCalls: [{id: 'tool-1', name: 'read_file', arguments: {path: 'a.ts'}}],
          usage: {inputTokens: 5, outputTokens: 2},
          stopReason: 'tool_use',
        }),
      }),
    ]);
  });

  it('normalizes Gemini SSE text, function calls, and usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      {candidates: [{content: {parts: [{text: 'Hello'}]}}], usageMetadata: {promptTokenCount: 4}},
      {candidates: [{content: {parts: [{functionCall: {name: 'list_files', args: {path: '.'}}}]}, finishReason: 'STOP'}], usageMetadata: {candidatesTokenCount: 1}},
    ])));
    const provider = new GeminiProvider({provider: 'gemini', model: 'test', apiKey: 'key'});

    const chunks = await collect(provider.stream?.([], []));

    expect(chunks[0]).toEqual({type: 'text_delta', content: 'Hello'});
    expect(chunks.at(-1)).toMatchObject({
      type: 'result',
      response: {
        content: 'Hello',
        toolCalls: [expect.objectContaining({name: 'list_files', arguments: {path: '.'}})],
        usage: {inputTokens: 4, outputTokens: 1},
        stopReason: 'STOP',
      },
    });
  });
});

function sse(events: Array<Record<string, unknown> | string>): Response {
  return new Response(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), {
    headers: {'content-type': 'text/event-stream'},
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
