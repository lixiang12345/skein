import React from 'react';
import {renderToString} from 'ink';
import {describe, expect, it} from 'vitest';
import {defaultConfig} from '../src/config.js';
import {
  buildOnboardingConfig,
  createOnboardingState,
  needsFirstRunOnboarding,
  onboardingReducer,
  OnboardingScreen,
  validateRelayBaseUrl,
  type OnboardingState,
} from '../src/ui/onboarding.js';
import {displayWidth} from '../src/ui/text.js';

function missingConfig() {
  const config = defaultConfig('/tmp/onboarding');
  config.model = {provider: 'openai', model: 'gpt-5'};
  config.ui = {...config.ui, color: false};
  return config;
}

function configuredDraft(overrides: Partial<OnboardingState['draft']> = {}): OnboardingState['draft'] {
  return {
    relayProtocol: 'openai-responses',
    baseUrl: 'https://relay.example/v1',
    modelsBaseUrl: '',
    model: 'relay-coder',
    auth: 'none',
    authHeader: 'bearer',
    modelsAuthHeader: 'bearer',
    apiKeyEnv: '',
    ...overrides,
  };
}

describe('first-run onboarding state machine', () => {
  it('runs only when the resolved interactive model configuration is incomplete', () => {
    const official = missingConfig();
    expect(needsFirstRunOnboarding(official)).toBe(true);
    expect(needsFirstRunOnboarding({...official, model: {...official.model, apiKey: 'key'}})).toBe(false);
    expect(needsFirstRunOnboarding({...official, model: {provider: 'compatible', model: 'local'}})).toBe(true);
    expect(needsFirstRunOnboarding({
      ...official,
      model: {provider: 'compatible', model: 'local', baseUrl: 'http://127.0.0.1:11434/v1'},
    })).toBe(false);
  });

  it('persists an explicit Anthropic SDK x-api-key header without probing', () => {
    const state: OnboardingState = {
      step: 'confirm',
      history: [],
      selected: 0,
      error: undefined,
      draft: configuredDraft({
        relayProtocol: 'anthropic-messages',
        modelsBaseUrl: 'https://relay.example/v1',
        auth: 'env',
        authHeader: 'x-api-key',
        modelsAuthHeader: 'x-api-key',
        apiKeyEnv: 'RELAY_API_KEY',
      }),
    };
    expect(buildOnboardingConfig(state).agents.connections?.['primary-relay']).toMatchObject({
      auth: {type: 'env', name: 'RELAY_API_KEY', header: 'x-api-key'},
      modelsAuthHeader: 'x-api-key',
    });
  });

  it('can keep inference authenticated while guaranteeing a public model catalog receives no key', () => {
    const state: OnboardingState = {
      step: 'confirm',
      history: [],
      selected: 0,
      error: undefined,
      draft: configuredDraft({
        modelsBaseUrl: 'https://ai-gateway.example/v1',
        auth: 'env',
        authHeader: 'bearer',
        modelsAuthHeader: 'none',
        apiKeyEnv: 'RELAY_API_KEY',
      }),
    };
    expect(buildOnboardingConfig(state).agents.connections?.['primary-relay']).toMatchObject({
      auth: {type: 'env', name: 'RELAY_API_KEY', header: 'bearer'},
      modelsAuthHeader: 'none',
    });
  });

  it('builds an explicit Anthropic relay with a separate model catalog and no secret value', () => {
    let state = createOnboardingState(missingConfig());
    state = onboardingReducer(state, {type: 'MOVE', delta: 1, count: 3});
    state = onboardingReducer(state, {type: 'MOVE', delta: 1, count: 3});
    state = onboardingReducer(state, {type: 'SELECT'}); // Anthropic Messages
    state = onboardingReducer(state, {type: 'SUBMIT_INPUT', field: 'baseUrl', value: 'https://relay.example/anthropic/'});
    state = onboardingReducer(state, {type: 'SUBMIT_INPUT', field: 'modelsBaseUrl', value: 'https://relay.example/v1/'});
    state = onboardingReducer(state, {type: 'SUBMIT_INPUT', field: 'model', value: 'claude-relay-model'});
    state = onboardingReducer(state, {type: 'MOVE', delta: 1, count: 2});
    state = onboardingReducer(state, {type: 'SELECT'}); // no auth

    expect(state.step).toBe('confirm');
    expect(buildOnboardingConfig(state)).toEqual({
      agents: {
        defaultConnection: 'primary-relay',
        defaultModel: 'claude-relay-model',
        connections: {
          'primary-relay': {
            provider: 'compatible',
            protocol: 'anthropic-messages',
            baseUrl: 'https://relay.example/anthropic',
            modelsBaseUrl: 'https://relay.example/v1',
            defaultModel: 'claude-relay-model',
            auth: {type: 'none'},
          },
        },
      },
    });
  });

  it('defaults to Responses and supports explicit keyless relay authentication', () => {
    let state = createOnboardingState(missingConfig());
    state = onboardingReducer(state, {type: 'SELECT'});
    state = onboardingReducer(state, {type: 'SUBMIT_INPUT', field: 'baseUrl', value: 'http://127.0.0.1:11434/v1'});
    state = onboardingReducer(state, {type: 'SUBMIT_INPUT', field: 'modelsBaseUrl', value: ''});
    state = onboardingReducer(state, {type: 'SUBMIT_INPUT', field: 'model', value: 'qwen-coder'});
    state = onboardingReducer(state, {type: 'MOVE', delta: 1, count: 2});
    state = onboardingReducer(state, {type: 'SELECT'});

    expect(state.step).toBe('confirm');
    expect(buildOnboardingConfig(state)).toMatchObject({
      agents: {
        defaultConnection: 'primary-relay',
        connections: {'primary-relay': {
          provider: 'compatible', protocol: 'openai-responses', auth: {type: 'none'},
        }},
      },
    });
  });

  it('requires an existing environment credential by name without reading it into state', () => {
    const previous = process.env.RELAY_API_KEY;
    process.env.RELAY_API_KEY = 'secret-never-copied';
    try {
      const state: OnboardingState = {
        step: 'api-key-env',
        history: ['relay-protocol', 'endpoint', 'models-endpoint', 'model', 'auth'],
        selected: 0,
        draft: configuredDraft({auth: 'env', apiKeyEnv: ''}),
        error: undefined,
      };
      const submitted = onboardingReducer(state, {type: 'SUBMIT_INPUT', field: 'apiKeyEnv', value: 'RELAY_API_KEY'});
      expect(submitted.step).toBe('confirm');
      expect(submitted.draft.apiKeyEnv).toBe('RELAY_API_KEY');
      expect(JSON.stringify(submitted)).not.toContain('secret-never-copied');
    } finally {
      if (previous === undefined) delete process.env.RELAY_API_KEY;
      else process.env.RELAY_API_KEY = previous;
    }
  });

  it('navigates the inference and catalog authentication menus without collapsing them into detection', () => {
    const previous = process.env.RELAY_API_KEY;
    process.env.RELAY_API_KEY = 'secret-never-copied';
    try {
      let state: OnboardingState = {
        step: 'auth',
        history: ['relay-protocol', 'endpoint', 'models-endpoint', 'model'],
        selected: 0,
        draft: configuredDraft({auth: undefined, apiKeyEnv: 'RELAY_API_KEY'}),
        error: undefined,
      };
      state = onboardingReducer(state, {type: 'SELECT'});
      expect(state.step).toBe('auth-header');
      state = onboardingReducer(state, {type: 'MOVE', delta: 1, count: 2});
      state = onboardingReducer(state, {type: 'SELECT'});
      expect(state).toMatchObject({step: 'models-auth', draft: {authHeader: 'x-api-key', modelsAuthHeader: 'x-api-key'}});
      state = onboardingReducer(state, {type: 'MOVE', delta: -1, count: 3});
      state = onboardingReducer(state, {type: 'SELECT'});
      expect(state).toMatchObject({step: 'api-key-env', draft: {modelsAuthHeader: 'none'}});
      state = onboardingReducer(state, {type: 'SUBMIT_INPUT', field: 'apiKeyEnv', value: 'RELAY_API_KEY'});
      expect(state.step).toBe('confirm');
      expect(JSON.stringify(state)).not.toContain('secret-never-copied');
      state = onboardingReducer(state, {type: 'BACK'});
      expect(state.step).toBe('api-key-env');
    } finally {
      if (previous === undefined) delete process.env.RELAY_API_KEY;
      else process.env.RELAY_API_KEY = previous;
    }
  });

  it('keeps required model-catalog and missing credential failures in place with actionable errors', () => {
    const catalogState: OnboardingState = {
      step: 'models-endpoint',
      history: ['relay-protocol', 'endpoint'],
      selected: 0,
      draft: configuredDraft({relayProtocol: 'anthropic-messages', modelsBaseUrl: ''}),
      error: undefined,
    };
    const missingCatalog = onboardingReducer(catalogState, {
      type: 'SUBMIT_INPUT', field: 'modelsBaseUrl', value: '',
    });
    expect(missingCatalog.step).toBe('models-endpoint');
    expect(missingCatalog.error).toContain('requires an OpenAI-style models base URL');

    delete process.env.MISSING_RELAY_KEY;
    const credentialState: OnboardingState = {
      step: 'api-key-env',
      history: ['relay-protocol', 'endpoint', 'models-endpoint', 'model', 'auth'],
      selected: 0,
      draft: configuredDraft({auth: 'env', apiKeyEnv: ''}),
      error: undefined,
    };
    const missingCredential = onboardingReducer(credentialState, {
      type: 'SUBMIT_INPUT', field: 'apiKeyEnv', value: 'MISSING_RELAY_KEY',
    });
    expect(missingCredential.step).toBe('api-key-env');
    expect(missingCredential.error).toContain('Export it, then restart Skein');
  });

  it('returns save failures to review without losing the configured draft', () => {
    const state: OnboardingState = {
      step: 'saving',
      history: ['relay-protocol', 'endpoint', 'models-endpoint', 'model', 'auth', 'confirm'],
      selected: 0,
      draft: configuredDraft(),
      error: undefined,
    };
    const failed = onboardingReducer(state, {type: 'SAVE_ERROR'});
    expect(failed).toMatchObject({step: 'confirm', draft: state.draft});
    expect(failed.error).toContain('Could not save');
  });

  it('supports back navigation within the relay-only flow', () => {
    let state = createOnboardingState(missingConfig());
    state = onboardingReducer(state, {type: 'SELECT'});
    expect(state.step).toBe('endpoint');
    state = onboardingReducer(state, {type: 'BACK'});
    expect(state.step).toBe('relay-protocol');
  });
});

describe('relay URL validation', () => {
  it('accepts HTTPS remote bases and loopback HTTP bases', () => {
    expect(validateRelayBaseUrl('https://relay.example/v1/')).toEqual({
      ok: true, value: 'https://relay.example/v1', loopback: false,
    });
    expect(validateRelayBaseUrl('http://localhost:11434/v1')).toEqual({
      ok: true, value: 'http://localhost:11434/v1', loopback: true,
    });
  });

  it.each([
    'http://relay.example/v1',
    'https://user:pass@relay.example/v1',
    'https://relay.example/v1?key=secret',
    'https://relay.example/v1#fragment',
    'https://relay.example/v1/responses',
    'https://relay.example/v1/chat/completions',
    'https://relay.example/v1/messages',
  ])('rejects unsafe or final endpoint URL %s', (value) => {
    expect(validateRelayBaseUrl(value).ok).toBe(false);
  });
});

describe('onboarding presentation', () => {
  it('offers only explicit third-party relay transports and recommends Responses', () => {
    const output = renderToString(
      <OnboardingScreen state={createOnboardingState(missingConfig())} dispatch={() => undefined} width={80} />,
      {columns: 80},
    );
    expect(output).toContain('third-party relays only');
    expect(output).toContain('OpenAI Responses');
    expect(output).toContain('Recommended');
    expect(output).toContain('Anthropic Messages');
    expect(output).not.toContain('Provider API key');
    expect(output).not.toContain('Official');
  });

  it('shows only the credential variable name and stays within a narrow terminal', () => {
    process.env.RELAY_API_KEY = 'super-secret-value';
    try {
      const state: OnboardingState = {
        step: 'api-key-env',
        history: ['relay-protocol', 'endpoint', 'models-endpoint', 'model', 'auth'],
        selected: 0,
        draft: configuredDraft({auth: 'env', apiKeyEnv: 'RELAY_API_KEY'}),
        error: undefined,
      };
      const output = renderToString(
        <OnboardingScreen state={state} dispatch={() => undefined} width={36} />,
        {columns: 36},
      );
      expect(output).toContain('RELAY_API_KEY');
      expect(output).not.toContain('super-secret-value');
      for (const line of output.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(36);
    } finally {
      delete process.env.RELAY_API_KEY;
    }
  });

  it('collapses nonessential copy for short terminal heights', () => {
    const state = createOnboardingState(missingConfig());
    const output = renderToString(
      <OnboardingScreen state={state} dispatch={() => undefined} width={40} compact />,
      {columns: 40},
    );
    expect(output.split('\n').length).toBeLessThanOrEqual(14);
    expect(output).toContain('SETUP 1/5');
    expect(output).toContain('OpenAI Responses');
    expect(output).toContain('Anthropic Messages');
  });

  it.each([20, 32, 40, 80])('keeps the transport menu inside %i columns', (width) => {
    const state = createOnboardingState(missingConfig());
    const output = renderToString(
      <OnboardingScreen state={state} dispatch={() => undefined} width={width} />,
      {columns: width},
    );

    expect(output).toContain('SKEIN');
    expect(output).toContain('TRANSPORT');
    for (const line of output.split('\n')) {
      expect(displayWidth(line), `${width}-column onboarding row overflowed: ${JSON.stringify(line)}`)
        .toBeLessThanOrEqual(width);
    }
  });

  it.each([20, 32, 40, 80])('keeps credential references and review inside %i columns', (width) => {
    const credential: OnboardingState = {
      step: 'api-key-env',
      history: ['relay-protocol', 'endpoint', 'models-endpoint', 'model', 'auth'],
      selected: 0,
      draft: configuredDraft({auth: 'env', apiKeyEnv: 'A_LONG_RELAY_API_KEY_VARIABLE'}),
      error: undefined,
    };
    const confirm = {...credential, step: 'confirm' as const};

    for (const state of [credential, confirm]) {
      const output = renderToString(
        <OnboardingScreen state={state} dispatch={() => undefined} width={width} />,
        {columns: width},
      );
      for (const line of output.split('\n')) {
        expect(displayWidth(line), `${width}-column onboarding row overflowed: ${JSON.stringify(line)}`)
          .toBeLessThanOrEqual(width);
      }
    }

    const credentialOutput = renderToString(
      <OnboardingScreen state={credential} dispatch={() => undefined} width={width} />,
      {columns: width},
    );
    expect(credentialOutput).toContain('Enter');
    expect(credentialOutput.split('\n').filter((line) => /[╭╰]/u.test(line))).toHaveLength(2);
  });

  it.each([20, 32, 40, 80])('keeps both authentication menus inside %i columns', (width) => {
    const base: OnboardingState = {
      step: 'auth-header',
      history: ['relay-protocol', 'endpoint', 'models-endpoint', 'model', 'auth'],
      selected: 1,
      draft: configuredDraft({auth: 'env', apiKeyEnv: 'RELAY_API_KEY'}),
      error: undefined,
    };
    for (const state of [base, {...base, step: 'models-auth' as const, selected: 2}]) {
      const output = renderToString(
        <OnboardingScreen state={state} dispatch={() => undefined} width={width} />,
        {columns: width},
      );
      for (const line of output.split('\n')) {
        expect(displayWidth(line), `${width}-column authentication row overflowed: ${JSON.stringify(line)}`)
          .toBeLessThanOrEqual(width);
      }
      expect(output).toContain('AUTH');
      expect(output).toContain(state.step === 'auth-header' ? 'x-api-key' : 'No model');
      expect(output).toContain('Enter');
    }
  });

  it('fits new authentication, review, validation, and saving states inside a 40x10 terminal', () => {
    const base: OnboardingState = {
      step: 'auth-header',
      history: [],
      selected: 1,
      draft: configuredDraft({
        modelsBaseUrl: 'https://relay.example/v1', auth: 'env', authHeader: 'x-api-key',
        modelsAuthHeader: 'none', apiKeyEnv: 'RELAY_API_KEY',
      }),
      error: undefined,
    };
    const states: OnboardingState[] = [
      base,
      {...base, step: 'models-auth', selected: 2},
      {...base, step: 'confirm', error: 'Example validation error.'},
      {...base, step: 'saving'},
    ];
    for (const state of states) {
      const output = renderToString(
        <OnboardingScreen state={state} dispatch={() => undefined} width={40} compact />,
        {columns: 40},
      );
      expect(output.split('\n').length, `${state.step} exceeded 40x10:\n${output}`).toBeLessThanOrEqual(10);
      for (const line of output.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(40);
    }
  });
});
