import {afterEach, describe, expect, it, vi} from 'vitest';
import {AnthropicProvider} from '../../src/providers/anthropic.js';
import {GeminiProvider} from '../../src/providers/gemini.js';
import {OpenAIProvider} from '../../src/providers/openai.js';
import {parseServerSentEvents, ProviderError} from '../../src/providers/provider.js';
import {ResponsesProvider} from '../../src/providers/responses.js';
import {createProvider} from '../../src/providers/index.js';

afterEach(() => vi.unstubAllGlobals());

describe('provider streaming helpers', () => {
  it('uses OpenAI-compatible endpoint, bearer auth, and message format for compatible relays', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://relay.example/v1/chat/completions');
      expect(init?.headers).toMatchObject({authorization: 'Bearer relay-key', 'content-type': 'application/json'});
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({model: 'relay-model', messages: [], max_tokens: 1024});
      return new Response(JSON.stringify({
        choices: [{message: {content: 'ok'}, finish_reason: 'stop'}],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 7,
          prompt_tokens_details: {cached_tokens: 12},
          completion_tokens_details: {reasoning_tokens: 3},
        },
      }), {
        headers: {'content-type': 'application/json'},
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAIProvider({
      provider: 'compatible', model: 'relay-model', baseUrl: 'https://relay.example/v1', apiKey: 'relay-key', maxTokens: 1024,
    });
    await expect(provider.complete([], [])).resolves.toMatchObject({
      content: 'ok',
      usage: {inputTokens: 20, outputTokens: 7, cachedInputTokens: 12, reasoningTokens: 3},
    });
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
      return new Response(JSON.stringify({
        content: [{type: 'text', text: 'ok'}],
        usage: {
          input_tokens: 8,
          output_tokens: 2,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 1,
        },
      }), {
        headers: {'content-type': 'application/json'},
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new AnthropicProvider({
      provider: 'anthropic', model: 'relay-claude', baseUrl: 'https://relay.example/v1', apiKey: 'relay-key', maxTokens: 2048,
    });
    await expect(provider.complete([], [])).resolves.toMatchObject({
      content: 'ok',
      usage: {inputTokens: 8, outputTokens: 2, cachedInputTokens: 5, cacheWriteInputTokens: 1},
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('routes compatible transports explicitly without cross-protocol guessing', () => {
    expect(createProvider({
      provider: 'compatible', protocol: 'openai-responses', model: 'test', baseUrl: 'https://relay.example/v1',
    })).toBeInstanceOf(ResponsesProvider);
    expect(createProvider({
      provider: 'compatible', protocol: 'openai-chat', model: 'test', baseUrl: 'https://relay.example/v1',
    })).toBeInstanceOf(OpenAIProvider);
    expect(createProvider({
      provider: 'compatible', protocol: 'anthropic-messages', model: 'test', baseUrl: 'https://relay.example',
    })).toBeInstanceOf(AnthropicProvider);
  });

  it('uses stateless Responses items, bearer auth, tool definitions, and usage', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://relay.example/v1/responses');
      expect(init?.headers).toMatchObject({authorization: 'Bearer relay-key', 'content-type': 'application/json'});
      const body = JSON.parse(String(init?.body)) as {
        store?: boolean;
        stream?: boolean;
        temperature?: number;
        input?: Array<Record<string, unknown>>;
        tools?: Array<Record<string, unknown>>;
      };
      expect(body.store).toBe(false);
      expect(body.stream).toBe(false);
      expect(body).not.toHaveProperty('temperature');
      expect(body.input).toEqual([
        {type: 'message', role: 'system', content: 'Be precise.'},
        {type: 'message', role: 'user', content: 'Inspect it.'},
        {type: 'message', role: 'assistant', content: 'Checking.'},
        {type: 'function_call', call_id: 'call-old', name: 'read_file', arguments: '{"path":"a.ts"}'},
        {type: 'function_call_output', call_id: 'call-old', output: 'contents'},
      ]);
      expect(body.tools).toEqual([expect.objectContaining({
        type: 'function', name: 'read_file', strict: false, parameters: {type: 'object'},
      })]);
      return new Response(JSON.stringify({
        status: 'completed',
        output: [
          {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Done.'}]},
          {type: 'function_call', call_id: 'call-new', name: 'list_files', arguments: '{"path":"."}'},
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          input_tokens_details: {cached_tokens: 7},
          output_tokens_details: {reasoning_tokens: 2},
        },
      }), {headers: {'content-type': 'application/json'}});
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ResponsesProvider({
      provider: 'compatible', protocol: 'openai-responses', model: 'coder',
      baseUrl: 'https://relay.example/v1', apiKey: 'relay-key', maxTokens: 1024, temperature: 0.2,
    });
    const messages = [
      {id: '1', role: 'system' as const, content: 'Be precise.', createdAt: '2026-01-01T00:00:00.000Z'},
      {id: '2', role: 'user' as const, content: 'Inspect it.', createdAt: '2026-01-01T00:00:01.000Z'},
      {
        id: '3', role: 'assistant' as const, content: 'Checking.', createdAt: '2026-01-01T00:00:02.000Z',
        toolCalls: [{id: 'call-old', name: 'read_file', arguments: {path: 'a.ts'}}],
      },
      {
        id: '4', role: 'tool' as const, content: 'contents', createdAt: '2026-01-01T00:00:03.000Z',
        toolCallId: 'call-old', name: 'read_file',
      },
    ];
    const tools = [{name: 'read_file', description: 'Read a file', category: 'read' as const, inputSchema: {type: 'object'}}];

    await expect(provider.complete(messages, tools)).resolves.toMatchObject({
      content: 'Done.',
      toolCalls: [{id: 'call-new', name: 'list_files', arguments: {path: '.'}}],
      usage: {inputTokens: 12, outputTokens: 4, cachedInputTokens: 7, reasoningTokens: 2},
      stopReason: 'tool_calls',
    });
  });

  it('uses the Anthropic relay base convention and bearer authentication', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://relay.example/anthropic/v1/messages');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer relay-key',
        'anthropic-version': '2023-06-01',
      });
      expect(init?.headers).not.toHaveProperty('x-api-key');
      return new Response(JSON.stringify({content: [{type: 'text', text: 'ok'}]}), {
        headers: {'content-type': 'application/json'},
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new AnthropicProvider({
      provider: 'compatible', protocol: 'anthropic-messages', model: 'relay-claude',
      baseUrl: 'https://relay.example/anthropic', apiKey: 'relay-key',
    });

    await expect(provider.complete([], [])).resolves.toMatchObject({content: 'ok'});
  });

  it('replays exact Responses output items for stateless reasoning and tool continuation', async () => {
    const priorOutput = [
      {id: 'rs-1', type: 'reasoning', encrypted_content: 'opaque-reasoning', summary: []},
      {id: 'fc-1', type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}'},
    ];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {input: unknown[]};
      expect(body.input).toEqual([
        ...priorOutput,
        {type: 'function_call_output', call_id: 'call-1', output: 'contents'},
      ]);
      return new Response(JSON.stringify({status: 'completed', output: []}), {
        headers: {'content-type': 'application/json'},
      });
    }));
    const provider = new ResponsesProvider({
      provider: 'compatible', protocol: 'openai-responses', model: 'coder', baseUrl: 'https://relay.example/v1',
    });

    await provider.complete([
      {
        id: '1', role: 'assistant', content: '', createdAt: '2026-01-01T00:00:00.000Z',
        toolCalls: [{id: 'call-1', name: 'read_file', arguments: {path: 'a.ts'}}],
        providerMetadata: {responses: {outputItems: priorOutput}},
      },
      {
        id: '2', role: 'tool', content: 'contents', createdAt: '2026-01-01T00:00:01.000Z',
        toolCallId: 'call-1', name: 'read_file',
      },
    ], []);
  });

  it('redacts relay credentials and unsafe URLs from Responses failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {
        message: 'Authorization: Bearer relay-key api_key=sk-abcdefghijklmnopqrstuvwxyz123456 at https://user:password@relay.example/v1?token=secret',
      },
    }), {status: 401, headers: {'content-type': 'application/json'}})));
    const provider = new ResponsesProvider({
      provider: 'compatible', protocol: 'openai-responses', model: 'coder',
      baseUrl: 'https://relay.example/v1', apiKey: 'relay-key',
    });

    let failure: ProviderError | undefined;
    try {
      await provider.complete([], []);
    } catch (error) {
      failure = error as ProviderError;
    }
    expect(failure).toBeInstanceOf(ProviderError);
    const diagnostic = `${failure?.message}\n${failure?.details}`;
    expect(diagnostic).toContain('[redacted');
    expect(diagnostic).toContain('https://<redacted>@relay.example/v1?<redacted>');
    expect(diagnostic).not.toMatch(/relay-key|abcdefghijklmnopqrstuvwxyz123456|password|token=secret/u);
  });

  it('falls back safely when an untrusted provider returns a non-string error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {message: {unexpected: 'shape'}},
    }), {status: 502, headers: {'content-type': 'application/json'}})));
    const provider = new ResponsesProvider({
      provider: 'compatible', protocol: 'openai-responses', model: 'coder', baseUrl: 'https://relay.example/v1',
    });

    await expect(provider.complete([], [])).rejects.toMatchObject({
      name: 'ProviderError',
      message: 'Model API request failed (502)',
      status: 502,
    });
  });

  it('rejects oversized Responses replay state before persisting a session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 'completed',
      output: [{id: 'rs-oversized', type: 'reasoning', encrypted_content: 'x'.repeat(4 * 1024 * 1024)}],
    }), {headers: {'content-type': 'application/json'}})));
    const provider = new ResponsesProvider({
      provider: 'compatible', protocol: 'openai-responses', model: 'coder', baseUrl: 'https://relay.example/v1',
    });

    await expect(provider.complete([], [])).rejects.toThrow('larger than the 4 MiB safety limit');
  });

  it('normalizes Gemini non-streaming usage and preserves explicit zero counts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      candidates: [{content: {parts: [{text: 'ok'}]}, finishReason: 'STOP'}],
      usageMetadata: {
        promptTokenCount: 9,
        candidatesTokenCount: 2,
        cachedContentTokenCount: 0,
        thoughtsTokenCount: 0,
      },
    }), {headers: {'content-type': 'application/json'}})));
    const provider = new GeminiProvider({provider: 'gemini', model: 'test', apiKey: 'key'});

    await expect(provider.complete([], [])).resolves.toMatchObject({
      content: 'ok',
      usage: {inputTokens: 9, outputTokens: 2, cachedInputTokens: 0, reasoningTokens: 0},
    });
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
      {choices: [{finish_reason: 'tool_calls'}], usage: {
        prompt_tokens: 7,
        completion_tokens: 3,
        prompt_tokens_details: {cached_tokens: 4},
        completion_tokens_details: {reasoning_tokens: 2},
      }},
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
          usage: {inputTokens: 7, outputTokens: 3, cachedInputTokens: 4, reasoningTokens: 2},
        }),
      }),
    ]);
  });

  it('normalizes Responses SSE text, function arguments, usage, and the final result', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {store?: boolean; stream?: boolean};
      expect(body).toMatchObject({store: false, stream: true});
      return sse([
        {type: 'response.created', response: {status: 'in_progress'}},
        {type: 'response.output_text.delta', delta: 'Hello '},
        {type: 'response.output_text.delta', delta: 'world'},
        {type: 'response.output_item.added', output_index: 1, item: {
          id: 'fc-1', type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '',
        }},
        {type: 'response.function_call_arguments.delta', item_id: 'fc-1', output_index: 1, delta: '{"path":"a.ts"}'},
        {type: 'response.output_item.done', output_index: 1, item: {
          id: 'fc-1', type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}',
        }},
        {type: 'response.completed', response: {
          status: 'completed',
          output: [{id: 'fc-1', type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}'}],
          usage: {
            input_tokens: 9, output_tokens: 3,
            input_tokens_details: {cached_tokens: 4}, output_tokens_details: {reasoning_tokens: 2},
          },
        }},
      ]);
    }));
    const provider = new ResponsesProvider({
      provider: 'compatible', protocol: 'openai-responses', model: 'test', baseUrl: 'http://127.0.0.1:1234/v1',
    });

    const chunks = await collect(provider.stream?.([], []) ?? []);

    expect(chunks).toEqual([
      {type: 'text_delta', content: 'Hello '},
      {type: 'text_delta', content: 'world'},
      expect.objectContaining({
        type: 'result',
        response: expect.objectContaining({
          content: 'Hello world',
          toolCalls: [{id: 'call-1', name: 'read_file', arguments: {path: 'a.ts'}}],
          usage: {inputTokens: 9, outputTokens: 3, cachedInputTokens: 4, reasoningTokens: 2},
          stopReason: 'tool_calls',
        }),
      }),
    ]);
  });

  it('normalizes Anthropic SSE text and streamed JSON tool input', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      {type: 'message_start', message: {usage: {
        input_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 1,
      }}},
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
          usage: {inputTokens: 5, outputTokens: 2, cachedInputTokens: 3, cacheWriteInputTokens: 1},
          stopReason: 'tool_use',
        }),
      }),
    ]);
  });

  it('normalizes Gemini SSE text, function calls, and usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      {candidates: [{content: {parts: [{text: 'Hello'}]}}], usageMetadata: {
        promptTokenCount: 4, cachedContentTokenCount: 2,
      }},
      {candidates: [{content: {parts: [{functionCall: {name: 'list_files', args: {path: '.'}}}]}, finishReason: 'STOP'}], usageMetadata: {
        candidatesTokenCount: 1, thoughtsTokenCount: 3,
      }},
    ])));
    const provider = new GeminiProvider({provider: 'gemini', model: 'test', apiKey: 'key'});

    const chunks = await collect(provider.stream?.([], []));

    expect(chunks[0]).toEqual({type: 'text_delta', content: 'Hello'});
    expect(chunks.at(-1)).toMatchObject({
      type: 'result',
      response: {
        content: 'Hello',
        toolCalls: [expect.objectContaining({name: 'list_files', arguments: {path: '.'}})],
        usage: {inputTokens: 4, outputTokens: 1, cachedInputTokens: 2, reasoningTokens: 3},
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
