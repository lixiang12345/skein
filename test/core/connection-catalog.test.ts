import {describe, expect, it} from 'vitest';
import {
  connectionEnvironmentTypos,
  connectionIssues,
  connectionRuntimeInfo,
  discoverConnectionCatalog,
  legacyConnectionRuntimeInfo,
  parseEnvironmentConnections,
  planConnectionSelection,
  resolveConnectionModel,
} from '../../src/agent/connection-catalog.js';
import {defaultConfig} from '../../src/config.js';

describe('model connection discovery and selection', () => {
  it('automatically selects one complete environment connection', () => {
    const environment = {
      SKEIN_CONNECTIONS: 'local',
      SKEIN_CONNECTION_LOCAL_PROVIDER: 'compatible',
      SKEIN_CONNECTION_LOCAL_BASE_URL: 'http://127.0.0.1:11434/v1',
      SKEIN_CONNECTION_LOCAL_AUTH: 'none',
      SKEIN_CONNECTION_LOCAL_MODEL: 'coder-local',
    };
    const catalog = discoverConnectionCatalog(defaultConfig('/tmp'), environment);
    const selection = planConnectionSelection(catalog, environment);

    expect(selection).toMatchObject({kind: 'selected', profile: {id: 'local', source: 'environment'}});
    if (selection.kind !== 'selected') throw new Error('Expected one selected connection.');
    expect(resolveConnectionModel(defaultConfig('/tmp').model, selection.profile, {}, environment)).toMatchObject({
      model: {
        provider: 'compatible',
        protocol: 'openai-responses',
        model: 'coder-local',
        baseUrl: 'http://127.0.0.1:11434/v1',
      },
      activeConnection: {id: 'local', authType: 'none', authStatus: 'none', complete: true},
    });
  });

  it('requires a separate model directory for Anthropic relay environment profiles', () => {
    const incompleteEnvironment = {
      SKEIN_CONNECTIONS: 'anthropic-relay',
      SKEIN_CONNECTION_ANTHROPIC_RELAY_PROTOCOL: 'anthropic-messages',
      SKEIN_CONNECTION_ANTHROPIC_RELAY_BASE_URL: 'https://relay.example/anthropic',
      SKEIN_CONNECTION_ANTHROPIC_RELAY_AUTH: 'none',
    };
    const incomplete = discoverConnectionCatalog(defaultConfig('/tmp'), incompleteEnvironment).profiles[0]!;
    expect(connectionIssues(incomplete, incompleteEnvironment)).toContain(
      'anthropic relay transport requires an explicit models base URL',
    );

    const completeEnvironment = {
      ...incompleteEnvironment,
      SKEIN_CONNECTION_ANTHROPIC_RELAY_MODELS_BASE_URL: 'https://relay.example/v1',
    };
    expect(planConnectionSelection(
      discoverConnectionCatalog(defaultConfig('/tmp'), completeEnvironment),
      completeEnvironment,
    )).toMatchObject({kind: 'selected', profile: {protocol: 'anthropic-messages'}});
  });

  it('keeps inference and model-directory credential headers explicit in environment profiles', () => {
    const environment = {
      SKEIN_CONNECTIONS: 'native',
      SKEIN_CONNECTION_NATIVE_PROTOCOL: 'anthropic-messages',
      SKEIN_CONNECTION_NATIVE_BASE_URL: 'https://relay.example',
      SKEIN_CONNECTION_NATIVE_MODELS_BASE_URL: 'https://relay.example/v1',
      SKEIN_CONNECTION_NATIVE_AUTH: 'env',
      SKEIN_CONNECTION_NATIVE_API_KEY_ENV: 'RELAY_KEY',
      SKEIN_CONNECTION_NATIVE_AUTH_HEADER: 'x-api-key',
      SKEIN_CONNECTION_NATIVE_MODELS_AUTH_HEADER: 'bearer',
      RELAY_KEY: 'not-persisted',
    };
    const profile = discoverConnectionCatalog(defaultConfig('/tmp'), environment).profiles[0]!;
    expect(profile).toMatchObject({
      auth: {type: 'env', name: 'RELAY_KEY', header: 'x-api-key'},
      modelsAuthHeader: 'bearer',
    });
    expect(resolveConnectionModel(defaultConfig('/tmp').model, profile, {}, environment).model)
      .toMatchObject({apiKeyHeader: 'x-api-key'});
    expect(connectionRuntimeInfo(profile, environment)).toMatchObject({
      authHeader: 'x-api-key', modelsAuthHeader: 'bearer', complete: true,
    });
    expect(() => parseEnvironmentConnections({
      ...environment,
      SKEIN_CONNECTION_NATIVE_AUTH_HEADER: 'cookie',
    })).toThrow('must be bearer or x-api-key');
  });

  it('keeps public model-directory authentication independent from inference credentials', () => {
    const environment = {
      SKEIN_CONNECTIONS: 'public-catalog',
      SKEIN_CONNECTION_PUBLIC_CATALOG_BASE_URL: 'https://relay.example/v1',
      SKEIN_CONNECTION_PUBLIC_CATALOG_MODELS_BASE_URL: 'https://catalog.example/v1',
      SKEIN_CONNECTION_PUBLIC_CATALOG_AUTH: 'env',
      SKEIN_CONNECTION_PUBLIC_CATALOG_API_KEY_ENV: 'RELAY_KEY',
      SKEIN_CONNECTION_PUBLIC_CATALOG_MODELS_AUTH_HEADER: 'none',
      RELAY_KEY: 'not-persisted',
    };
    const profile = discoverConnectionCatalog(defaultConfig('/tmp'), environment).profiles[0]!;
    expect(profile.modelsAuthHeader).toBe('none');
    expect(connectionRuntimeInfo(profile, environment)).toMatchObject({
      authHeader: 'bearer', modelsAuthHeader: 'none', complete: true,
    });
    expect(() => parseEnvironmentConnections({
      ...environment,
      SKEIN_CONNECTION_PUBLIC_CATALOG_MODELS_AUTH_HEADER: 'cookie',
    })).toThrow('must be bearer, x-api-key, or none');
  });

  it('reports multiple complete connections in stable id order', () => {
    const environment = {
      SKEIN_CONNECTIONS: 'zeta,alpha',
      SKEIN_CONNECTION_ZETA_PROVIDER: 'compatible',
      SKEIN_CONNECTION_ZETA_BASE_URL: 'http://127.0.0.1:11435/v1',
      SKEIN_CONNECTION_ZETA_AUTH: 'none',
      SKEIN_CONNECTION_ALPHA_PROVIDER: 'compatible',
      SKEIN_CONNECTION_ALPHA_BASE_URL: 'http://127.0.0.1:11434/v1',
      SKEIN_CONNECTION_ALPHA_AUTH: 'none',
    };
    const selection = planConnectionSelection(
      discoverConnectionCatalog(defaultConfig('/tmp'), environment),
      environment,
    );

    expect(selection.kind).toBe('ambiguous');
    if (selection.kind !== 'ambiguous') throw new Error('Expected ambiguous connections.');
    expect(selection.profiles.map(({id}) => id)).toEqual(['alpha', 'zeta']);
  });

  it('rejects duplicate and normalization-colliding environment ids', () => {
    expect(() => parseEnvironmentConnections({SKEIN_CONNECTIONS: 'local,local'})).toThrow(
      'Duplicate SKEIN_CONNECTIONS id local',
    );
    expect(() => parseEnvironmentConnections({SKEIN_CONNECTIONS: 'team-a,team_a'})).toThrow(
      'collide after environment normalization',
    );
  });

  it('does not pair an endpoint and credential across incomplete connections', () => {
    const environment = {
      SKEIN_CONNECTIONS: 'endpoint-only,key-only',
      SKEIN_CONNECTION_ENDPOINT_ONLY_PROVIDER: 'compatible',
      SKEIN_CONNECTION_ENDPOINT_ONLY_BASE_URL: 'https://relay.example/v1',
      SKEIN_CONNECTION_ENDPOINT_ONLY_API_KEY_ENV: 'ENDPOINT_KEY',
      SKEIN_CONNECTION_KEY_ONLY_PROVIDER: 'compatible',
      SKEIN_CONNECTION_KEY_ONLY_API_KEY_ENV: 'OTHER_KEY',
      OTHER_KEY: 'credential-for-the-other-profile',
    };
    const catalog = discoverConnectionCatalog(defaultConfig('/tmp'), environment);

    expect(planConnectionSelection(catalog, environment)).toEqual({kind: 'legacy'});
    expect(connectionIssues(catalog.profiles[0]!, environment)).toContain('credential environment ENDPOINT_KEY is not set');
    expect(connectionIssues(catalog.profiles[1]!, environment)).toContain('compatible provider requires base URL');
  });

  it('uses explicit selection before the configured default and rejects unknown ids', () => {
    const config = defaultConfig('/tmp');
    config.agents = {
      ...config.agents!,
      defaultConnection: 'alpha',
      connections: {
        alpha: {provider: 'compatible', baseUrl: 'http://127.0.0.1:11434/v1', auth: {type: 'none'}},
        beta: {provider: 'compatible', baseUrl: 'http://127.0.0.1:11435/v1', auth: {type: 'none'}},
      },
    };
    const catalog = discoverConnectionCatalog(config, {});

    expect(planConnectionSelection(catalog, {}, 'beta')).toMatchObject({kind: 'selected', profile: {id: 'beta'}});
    expect(planConnectionSelection(catalog, {})).toMatchObject({kind: 'selected', profile: {id: 'alpha'}});
    expect(() => planConnectionSelection(catalog, {}, 'missing')).toThrow('Unknown connection missing');
  });

  it('does not inherit an official provider key for a custom endpoint without explicit auth', () => {
    const config = defaultConfig('/tmp');
    config.agents = {
      ...config.agents!,
      connections: {
        relay: {provider: 'openai', baseUrl: 'https://relay.example/v1'},
      },
    };
    const environment = {OPENAI_API_KEY: 'official-secret'};
    const profile = discoverConnectionCatalog(config, environment).profiles[0]!;

    expect(connectionIssues(profile, environment)).toContain('custom provider endpoint requires explicit connection auth');
    expect(planConnectionSelection({profiles: [profile]}, environment)).toEqual({kind: 'legacy'});
  });

  it('diagnoses only misspelled variable names and never returns their values', () => {
    const result = connectionEnvironmentTypos({
      SEKIN_API: 'secret-one',
      SKEIN_BASEURL: 'https://user:secret-two@example.test/v1?token=three',
    });

    expect(result).toEqual([
      {name: 'SEKIN_API', replacement: 'SKEIN_API_KEY'},
      {name: 'SKEIN_BASEURL', replacement: 'SKEIN_BASE_URL'},
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret-one|secret-two|token=three/u);
  });

  it('does not report a remote legacy compatible endpoint ready without credentials', () => {
    expect(legacyConnectionRuntimeInfo({
      provider: 'compatible', protocol: 'openai-responses', model: 'coder', baseUrl: 'https://relay.example/v1',
    })).toMatchObject({
      protocol: 'openai-responses', authType: 'env', authStatus: 'missing', complete: false,
      issues: ['remote compatible provider credential is not configured'],
    });
    expect(legacyConnectionRuntimeInfo({
      provider: 'compatible', model: 'local', baseUrl: 'http://127.0.0.1:11434/v1',
    })).toMatchObject({authType: 'none', authStatus: 'none', complete: true});
  });
});
