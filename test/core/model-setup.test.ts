import {describe, expect, it} from 'vitest';
import {createAgentConnectionSetup, mergeAgentSetup} from '../../src/agent/model-setup.js';

describe('shared connection setup', () => {
  it('creates a compact default connection patch without a secret value', () => {
    const setup = createAgentConnectionSetup({
      name: 'team-relay',
      provider: 'compatible',
      baseUrl: 'https://relay.example/v1',
      apiKeyEnv: 'TEAM_RELAY_API_KEY',
      defaultModel: 'openai/coding-model',
    });
    expect(setup).toEqual({
      defaultConnection: 'team-relay',
      defaultModel: 'openai/coding-model',
      connections: {
        'team-relay': {
          provider: 'compatible',
          protocol: 'openai-responses',
          baseUrl: 'https://relay.example/v1',
          defaultModel: 'openai/coding-model',
          auth: {type: 'env', name: 'TEAM_RELAY_API_KEY'},
        },
      },
    });
    expect(JSON.stringify(setup)).not.toContain('secret');
  });

  it('preserves existing team routes when updating one connection', () => {
    const merged = mergeAgentSetup({
      enabled: true,
      defaultProfile: 'reviewer',
      routes: {frontend: {model: 'frontend-model'}},
      connections: {local: {provider: 'compatible', baseUrl: 'http://127.0.0.1:11434/v1'}},
    }, createAgentConnectionSetup({
      name: 'relay',
      provider: 'compatible',
      baseUrl: 'https://relay.example/v1',
      auth: 'none',
      defaultModel: 'coder',
    }));
    expect(merged.defaultConnection).toBe('relay');
    expect(merged.routes).toEqual({frontend: {model: 'frontend-model'}});
    expect(Object.keys(merged.connections ?? {})).toEqual(['local', 'relay']);
  });

  it('keeps inference and model-directory authentication headers explicit', () => {
    expect(createAgentConnectionSetup({
      name: 'native-messages',
      provider: 'compatible',
      protocol: 'anthropic-messages',
      baseUrl: 'https://relay.example',
      modelsBaseUrl: 'https://relay.example/v1',
      auth: 'env',
      authHeader: 'x-api-key',
      modelsAuthHeader: 'bearer',
      apiKeyEnv: 'RELAY_KEY',
      defaultModel: 'anthropic/claude',
    }).connections['native-messages']).toMatchObject({
      auth: {type: 'env', name: 'RELAY_KEY', header: 'x-api-key'},
      modelsAuthHeader: 'bearer',
    });
  });

  it('supports an authenticated inference endpoint with a public model directory', () => {
    expect(createAgentConnectionSetup({
      name: 'public-catalog',
      provider: 'compatible',
      baseUrl: 'https://relay.example/v1',
      modelsBaseUrl: 'https://catalog.example/v1',
      auth: 'env',
      authHeader: 'bearer',
      modelsAuthHeader: 'none',
      apiKeyEnv: 'RELAY_KEY',
      defaultModel: 'relay-coder',
    }).connections['public-catalog']).toMatchObject({
      auth: {type: 'env', name: 'RELAY_KEY', header: 'bearer'},
      modelsAuthHeader: 'none',
    });
  });

  it('persists explicit Responses hosted capabilities and user relay prices', () => {
    expect(createAgentConnectionSetup({
      name: 'research',
      provider: 'compatible',
      protocol: 'openai-responses',
      baseUrl: 'https://relay.example/v1',
      auth: 'none',
      hostedTools: ['web_search'],
      pricing: {
        inputPerMillionUsd: 2,
        outputPerMillionUsd: 8,
        cachedInputPerMillionUsd: 0.5,
      },
      defaultModel: 'research-model',
    }).connections.research).toMatchObject({
      hostedTools: ['web_search'],
      pricing: {inputPerMillionUsd: 2, outputPerMillionUsd: 8, cachedInputPerMillionUsd: 0.5},
    });
    expect(() => createAgentConnectionSetup({
      name: 'messages',
      provider: 'compatible',
      protocol: 'anthropic-messages',
      baseUrl: 'https://relay.example',
      modelsBaseUrl: 'https://relay.example/v1',
      auth: 'none',
      hostedTools: ['web_search'],
      defaultModel: 'model',
    })).toThrow('require the openai-responses protocol');
  });

  it('rejects unsafe or incomplete setup values', () => {
    expect(() => createAgentConnectionSetup({
      name: 'Team Relay', provider: 'compatible', baseUrl: 'https://relay.example/v1', defaultModel: 'coder',
    })).toThrow('Connection name');
    expect(() => createAgentConnectionSetup({
      name: 'relay', provider: 'compatible', apiKeyEnv: 'team_key', defaultModel: 'coder',
    })).toThrow('base URL');
    expect(() => createAgentConnectionSetup({
      name: 'relay', provider: 'compatible', baseUrl: 'https://relay.example/v1', apiKeyEnv: 'team_key', defaultModel: 'coder',
    })).toThrow('environment variable');
    expect(() => createAgentConnectionSetup({
      name: 'relay', provider: 'compatible', baseUrl: 'https://relay.example/v1', auth: 'env', defaultModel: 'coder',
    })).toThrow('requires a credential environment variable');
    expect(() => createAgentConnectionSetup({
      name: 'relay', provider: 'compatible', baseUrl: 'https://relay.example/v1', auth: 'none', apiKeyEnv: 'TEAM_KEY', defaultModel: 'coder',
    })).toThrow('cannot include');
    expect(() => createAgentConnectionSetup({
      name: 'relay', provider: 'compatible', baseUrl: 'https://relay.example/v1', auth: 'none', authHeader: 'x-api-key', defaultModel: 'coder',
    })).toThrow('credential header');
    expect(() => createAgentConnectionSetup({
      name: 'relay', provider: 'compatible', baseUrl: 'https://user:secret@relay.example/v1?key=value', auth: 'none', defaultModel: 'coder',
    })).toThrow('cannot contain credentials');
  });
});
