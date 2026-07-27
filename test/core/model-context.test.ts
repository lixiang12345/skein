import {describe, expect, it} from 'vitest';
import {DEFAULT_MODEL_CONTEXT_TOKENS, modelContextWindowTokens} from '../../src/agent/model-context.js';
import {defaultConfig} from '../../src/config.js';

describe('model context windows', () => {
  it('uses the 500k product fallback independently from retrieval tokens', () => {
    const config = defaultConfig('/tmp/workspace');
    config.context.maxTokens = 12_000;

    expect(modelContextWindowTokens(config)).toBe(DEFAULT_MODEL_CONTEXT_TOKENS);
    expect(modelContextWindowTokens(config)).toBe(500_000);
  });

  it('honors explicit metadata for the selected connection model', () => {
    const config = defaultConfig('/tmp/workspace');
    config.model.model = 'relay-model';
    config.activeConnection = {
      id: 'relay', provider: 'compatible', protocol: 'openai-responses', source: 'user',
      endpoint: 'https://relay.example/v1', modelsEndpoint: 'https://relay.example/v1/models',
      authType: 'env', authStatus: 'configured', complete: true, issues: [], catalogIssues: [],
    };
    config.connections = {profiles: {
      relay: {
        provider: 'compatible',
        models: [{id: 'relay-model', contextLength: 640_000}],
      },
    }};

    expect(modelContextWindowTokens(config)).toBe(640_000);
  });
});
