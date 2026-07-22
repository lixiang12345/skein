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
          baseUrl: 'https://relay.example/v1',
          apiKeyEnv: 'TEAM_RELAY_API_KEY',
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
      defaultModel: 'coder',
    }));
    expect(merged.defaultConnection).toBe('relay');
    expect(merged.routes).toEqual({frontend: {model: 'frontend-model'}});
    expect(Object.keys(merged.connections ?? {})).toEqual(['local', 'relay']);
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
  });
});
