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

  it('builds an explicit Anthropic-compatible relay without protocol guessing', () => {
    let state = createOnboardingState(missingConfig());
    state = onboardingReducer(state, {type: 'MOVE', delta: 1, count: 2});
    state = onboardingReducer(state, {type: 'SELECT'}); // relay
    state = onboardingReducer(state, {type: 'MOVE', delta: 1, count: 2});
    state = onboardingReducer(state, {type: 'SELECT'}); // Anthropic-compatible
    state = onboardingReducer(state, {type: 'SUBMIT_INPUT', field: 'baseUrl', value: 'https://relay.example/v1/'});
    state = onboardingReducer(state, {type: 'SUBMIT_INPUT', field: 'model', value: 'claude-relay-model'});
    state = onboardingReducer(state, {type: 'SUBMIT_INPUT', field: 'apiKey', value: 'relay-secret'});

    expect(state.step).toBe('confirm');
    expect(buildOnboardingConfig(state)).toEqual({
      model: {
        provider: 'anthropic',
        model: 'claude-relay-model',
        baseUrl: 'https://relay.example/v1',
        apiKey: 'relay-secret',
      },
    });
  });

  it('allows a keyless loopback OpenAI-compatible server but requires keys remotely', () => {
    const base: OnboardingState = {
      step: 'api-key',
      history: ['method', 'relay-protocol', 'endpoint', 'model'],
      selected: 0,
      draft: {
        method: 'relay',
        provider: 'compatible',
        relayProtocol: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen-coder',
        apiKey: '',
      },
      error: undefined,
    };
    const local = onboardingReducer(base, {type: 'SUBMIT_INPUT', field: 'apiKey', value: ''});
    expect(local.step).toBe('confirm');
    expect(buildOnboardingConfig(local)).toEqual({
      model: {provider: 'compatible', model: 'qwen-coder', baseUrl: 'http://127.0.0.1:11434/v1'},
    });

    const remote = {...base, draft: {...base.draft, baseUrl: 'https://relay.example/v1'}};
    const rejected = onboardingReducer(remote, {type: 'SUBMIT_INPUT', field: 'apiKey', value: ''});
    expect(rejected.step).toBe('api-key');
    expect(rejected.error).toContain('API key');
  });

  it('supports back navigation without exposing a dead-end CLI login choice', () => {
    let state = createOnboardingState(missingConfig());
    state = onboardingReducer(state, {type: 'MOVE', delta: 1, count: 2});
    state = onboardingReducer(state, {type: 'SELECT'});
    expect(state.step).toBe('relay-protocol');
    state = onboardingReducer(state, {type: 'BACK'});
    expect(state.step).toBe('method');
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
    'https://relay.example/v1/chat/completions',
    'https://relay.example/v1/messages',
  ])('rejects unsafe or final endpoint URL %s', (value) => {
    expect(validateRelayBaseUrl(value).ok).toBe(false);
  });
});

describe('onboarding presentation', () => {
  it('masks credentials and stays within a narrow terminal', () => {
    const state: OnboardingState = {
      step: 'api-key',
      history: ['method', 'official-provider', 'model'],
      selected: 0,
      draft: {
        method: 'official',
        provider: 'openai',
        relayProtocol: undefined,
        baseUrl: '',
        model: 'gpt-5',
        apiKey: 'super-secret-value',
      },
      error: undefined,
    };
    const output = renderToString(
      <OnboardingScreen state={state} dispatch={() => undefined} width={36} />,
      {columns: 36},
    );
    expect(output).not.toContain('super-secret-value');
    expect(output).toMatch(/[•*]{4}/u);
    for (const line of output.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(36);
  });

  it('collapses nonessential copy for short terminal heights', () => {
    const state = createOnboardingState(missingConfig());
    const output = renderToString(
      <OnboardingScreen state={state} dispatch={() => undefined} width={40} compact />,
      {columns: 40},
    );
    expect(output.split('\n').length).toBeLessThanOrEqual(14);
    expect(output).toContain('SETUP 1/4');
    expect(output).toContain('Provider API key');
    expect(output).toContain('Compatible endpoint');
    expect(output).not.toContain('signed in to a CLI');
  });

  it.each([20, 32, 40, 80])('keeps the connection menu inside %i columns', (width) => {
    const state = createOnboardingState(missingConfig());
    const output = renderToString(
      <OnboardingScreen state={state} dispatch={() => undefined} width={width} />,
      {columns: width},
    );

    expect(output).toContain('SKEIN');
    expect(output).toContain('CONNECTION');
    for (const line of output.split('\n')) {
      expect(displayWidth(line), `${width}-column onboarding row overflowed: ${JSON.stringify(line)}`)
        .toBeLessThanOrEqual(width);
    }
  });

  it.each([20, 32, 40, 80])('keeps credentials and review inside %i columns', (width) => {
    const apiKey: OnboardingState = {
      step: 'api-key',
      history: ['method', 'official-provider', 'model'],
      selected: 0,
      draft: {
        method: 'official',
        provider: 'openai',
        relayProtocol: undefined,
        baseUrl: '',
        model: 'gpt-5',
        apiKey: 'a-secret-longer-than-the-narrow-input',
      },
      error: undefined,
    };
    const confirm = {...apiKey, step: 'confirm' as const};

    for (const state of [apiKey, confirm]) {
      const output = renderToString(
        <OnboardingScreen state={state} dispatch={() => undefined} width={width} />,
        {columns: width},
      );
      expect(output).not.toContain(apiKey.draft.apiKey);
      for (const line of output.split('\n')) {
        expect(displayWidth(line), `${width}-column onboarding row overflowed: ${JSON.stringify(line)}`)
          .toBeLessThanOrEqual(width);
      }
    }

    const keyOutput = renderToString(
      <OnboardingScreen state={apiKey} dispatch={() => undefined} width={width} />,
      {columns: width},
    );
    expect(keyOutput.match(/[•*]+/u)?.[0]).toBeTruthy();
    expect(keyOutput).toContain('Enter');
    expect(keyOutput.split('\n').filter((line) => /[╭╰]/u.test(line))).toHaveLength(2);
  });
});
