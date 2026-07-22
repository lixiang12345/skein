import {afterEach, describe, expect, it, vi} from 'vitest';
import {listConnectionModels} from '../../src/agent/model-catalog.js';

describe('model connection catalog', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists and normalizes compatible endpoint models without persisting credentials', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://relay.example/v1/models');
      expect(init?.headers).toMatchObject({authorization: 'Bearer relay-secret'});
      return new Response(JSON.stringify({data: [
        {id: 'z-model', owned_by: 'z', context_length: 32_000},
        {id: 'a-model', ownedBy: 'a'},
        {ignored: true},
      ]}), {status: 200});
    });
    vi.stubGlobal('fetch', fetch);

    await expect(listConnectionModels({provider: 'compatible', baseUrl: 'https://relay.example/v1', apiKeyEnv: 'RELAY_KEY'}, {RELAY_KEY: 'relay-secret'})).resolves.toEqual([
      {id: 'a-model', ownedBy: 'a'},
      {id: 'z-model', ownedBy: 'z', contextLength: 32_000},
    ]);
  });

  it('rejects unsupported native provider discovery instead of guessing an API shape', async () => {
    await expect(listConnectionModels({provider: 'anthropic'})).rejects.toThrow('currently supported');
  });
});
