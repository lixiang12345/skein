import {afterEach, describe, expect, it, vi} from 'vitest';
import {clearModelCatalogCache, listConnectionModels} from '../../src/agent/model-catalog.js';

describe('model connection catalog', () => {
  afterEach(() => {
    clearModelCatalogCache();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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

    await expect(listConnectionModels({
      provider: 'compatible',
      baseUrl: 'https://relay.example/v1',
      auth: {type: 'env', name: 'RELAY_KEY'},
    }, {RELAY_KEY: 'relay-secret'})).resolves.toEqual([
      {id: 'a-model', ownedBy: 'a'},
      {id: 'z-model', ownedBy: 'z', contextLength: 32_000},
    ]);
  });

  it('omits authorization for an explicitly unauthenticated connection', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toEqual({accept: 'application/json'});
      return new Response(JSON.stringify({data: []}), {status: 200});
    });
    vi.stubGlobal('fetch', fetch);

    await expect(listConnectionModels({
      provider: 'compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      auth: {type: 'none'},
    }, {OPENAI_API_KEY: 'unrelated-secret'})).resolves.toEqual([]);
  });

  it('does not inherit the official key for a custom OpenAI endpoint', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(listConnectionModels({
      provider: 'openai',
      baseUrl: 'https://relay.example/v1',
    }, {OPENAI_API_KEY: 'official-secret'})).rejects.toThrow('require explicit connection auth');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not echo a remote error body that may contain credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('token=remote-secret', {status: 401})));

    const result = listConnectionModels({
      provider: 'compatible',
      baseUrl: 'https://relay.example/v1',
      auth: {type: 'env', name: 'RELAY_KEY'},
    }, {RELAY_KEY: 'local-secret'});
    await expect(result).rejects.toThrow('Model discovery failed (401).');
    await expect(result).rejects.not.toThrow(/remote-secret|local-secret/u);
  });

  it('requires an explicit catalog or declared models instead of guessing a provider API shape', async () => {
    await expect(listConnectionModels({provider: 'anthropic'})).rejects.toThrow('No model catalog is configured');
  });

  it('uses declared models without a catalog and falls back to them when discovery is unavailable', async () => {
    await expect(listConnectionModels({
      provider: 'compatible',
      protocol: 'anthropic-messages',
      baseUrl: 'https://relay.example',
      auth: {type: 'none'},
      models: [{id: 'manual-b', contextLength: 128_000}, {id: 'manual-a'}],
    })).resolves.toEqual([
      {id: 'manual-a'},
      {id: 'manual-b', contextLength: 128_000},
    ]);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', {status: 503})));
    const connection = {
      provider: 'compatible' as const,
      baseUrl: 'https://relay.example/v1',
      auth: {type: 'none' as const},
      models: [{id: 'manual-model'}],
    };
    await expect(listConnectionModels(connection)).resolves.toEqual([{id: 'manual-model'}]);
    await expect(listConnectionModels(connection, process.env, {strictCatalog: true}))
      .rejects.toThrow('Model discovery failed (503)');
  });

  it('supports independent command auth and environment-backed catalog headers', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer catalog-secret',
        'X-Tenant': 'tenant-a',
      });
      expect(init?.headers).not.toHaveProperty('x-api-key');
      return new Response(JSON.stringify({data: [{id: 'catalog-model'}]}), {status: 200});
    });
    vi.stubGlobal('fetch', fetch);

    await expect(listConnectionModels({
      provider: 'compatible',
      baseUrl: 'https://inference.example/v1',
      modelsBaseUrl: 'https://catalog.example/v1',
      auth: {type: 'env', name: 'INFERENCE_KEY', header: 'x-api-key'},
      modelsAuth: {
        type: 'command', command: process.execPath, args: ['-e', "console.log('catalog-secret')"],
        refreshIntervalMs: 0,
      },
      modelsHeaders: {env: {'X-Tenant': 'TENANT_ID'}},
    }, {INFERENCE_KEY: 'must-not-send', TENANT_ID: 'tenant-a'})).resolves.toEqual([{id: 'catalog-model'}]);
  });

  it('caches model metadata for 15 minutes and revalidates expired ETags', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'));
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({data: [{id: 'cached-model'}]}), {
        status: 200,
        headers: {etag: '"catalog-v1"'},
      }))
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({'if-none-match': '"catalog-v1"'});
        return new Response(null, {status: 304});
      });
    vi.stubGlobal('fetch', fetch);
    const connection = {
      provider: 'compatible' as const,
      protocol: 'openai-responses' as const,
      baseUrl: 'https://relay.example/v1',
      auth: {type: 'env' as const, name: 'RELAY_KEY'},
    };

    await expect(listConnectionModels(connection, {RELAY_KEY: 'relay-secret'})).resolves.toEqual([{id: 'cached-model'}]);
    await expect(listConnectionModels(connection, {RELAY_KEY: 'relay-secret'})).resolves.toEqual([{id: 'cached-model'}]);
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-07-26T00:15:01.000Z'));
    await expect(listConnectionModels(connection, {RELAY_KEY: 'relay-secret'})).resolves.toEqual([{id: 'cached-model'}]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('isolates cache entries by endpoint and rotated credential without storing stale auth success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'));
    const fetch = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({
      data: [{id: String(input).includes('other') ? 'other-model' : 'relay-model'}],
    }), {status: 200}));
    vi.stubGlobal('fetch', fetch);
    const connection = {
      provider: 'compatible' as const,
      baseUrl: 'https://relay.example/v1',
      auth: {type: 'env' as const, name: 'RELAY_KEY'},
    };

    await listConnectionModels(connection, {RELAY_KEY: 'first-secret'});
    await listConnectionModels(connection, {RELAY_KEY: 'rotated-secret'});
    await listConnectionModels({...connection, baseUrl: 'https://other.example/v1'}, {RELAY_KEY: 'rotated-secret'});
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('invalidates expired cache metadata on authentication failure and never serves it as success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'));
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({data: [{id: 'old-model'}]}), {status: 200}))
      .mockResolvedValueOnce(new Response('denied', {status: 401}))
      .mockResolvedValueOnce(new Response(JSON.stringify({data: [{id: 'new-model'}]}), {status: 200}));
    vi.stubGlobal('fetch', fetch);
    const connection = {
      provider: 'compatible' as const,
      baseUrl: 'https://relay.example/v1',
      auth: {type: 'env' as const, name: 'RELAY_KEY'},
    };

    await expect(listConnectionModels(connection, {RELAY_KEY: 'relay-secret'})).resolves.toEqual([{id: 'old-model'}]);
    vi.setSystemTime(new Date('2026-07-26T00:15:01.000Z'));
    await expect(listConnectionModels(connection, {RELAY_KEY: 'relay-secret'})).rejects.toThrow('Model discovery failed (401).');
    await expect(listConnectionModels(connection, {RELAY_KEY: 'relay-secret'})).resolves.toEqual([{id: 'new-model'}]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('uses a separate OpenAI-style model directory for Anthropic transport', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://relay.example/openai/v1/models');
      return new Response(JSON.stringify({models: [{model_id: 'claude-relay'}]}), {status: 200});
    });
    vi.stubGlobal('fetch', fetch);

    await expect(listConnectionModels({
      provider: 'compatible',
      protocol: 'anthropic-messages',
      baseUrl: 'https://relay.example/anthropic',
      modelsBaseUrl: 'https://relay.example/openai/v1',
      auth: {type: 'none'},
    })).resolves.toEqual([{id: 'claude-relay'}]);
  });

  it('uses the independently configured model-directory authentication header', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({authorization: 'Bearer relay-secret'});
      expect(init?.headers).not.toHaveProperty('x-api-key');
      return new Response(JSON.stringify({data: [{id: 'claude-relay'}]}), {status: 200});
    });
    vi.stubGlobal('fetch', fetch);

    await listConnectionModels({
      provider: 'compatible',
      protocol: 'anthropic-messages',
      baseUrl: 'https://relay.example',
      modelsBaseUrl: 'https://relay.example/v1',
      modelsAuthHeader: 'bearer',
      auth: {type: 'env', name: 'RELAY_KEY', header: 'x-api-key'},
    }, {RELAY_KEY: 'relay-secret'});
  });

  it('does not read or send the inference credential for an explicitly public model directory', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({accept: 'application/json'});
      expect(init?.headers).not.toHaveProperty('authorization');
      expect(init?.headers).not.toHaveProperty('x-api-key');
      return new Response(JSON.stringify({data: [{id: 'public-model'}]}), {status: 200});
    });
    vi.stubGlobal('fetch', fetch);

    await expect(listConnectionModels({
      provider: 'compatible',
      protocol: 'openai-responses',
      baseUrl: 'https://relay.example/v1',
      modelsBaseUrl: 'https://catalog.example/v1',
      modelsAuthHeader: 'none',
      auth: {type: 'env', name: 'MISSING_RELAY_KEY'},
    }, {})).resolves.toEqual([{id: 'public-model'}]);
  });

  it('bounds process-local catalog metadata and evicts the least recently used endpoint', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({
      data: [{id: String(input)}],
    }), {status: 200}));
    vi.stubGlobal('fetch', fetch);

    for (let index = 0; index < 33; index += 1) {
      await listConnectionModels({
        provider: 'compatible',
        baseUrl: `https://relay-${index}.example/v1`,
        auth: {type: 'none'},
      });
    }
    await listConnectionModels({
      provider: 'compatible',
      baseUrl: 'https://relay-0.example/v1',
      auth: {type: 'none'},
    });

    expect(fetch).toHaveBeenCalledTimes(34);
  });
});
