import {defaultModelForProvider, providerApiKeyEnv} from '../config.js';
import type {
  AgentConnectionConfig,
  ConnectionAuth,
  ConnectionCatalogRuntime,
  ConnectionProtocol,
  ConnectionRuntimeInfo,
  ConnectionSource,
  ModelConfig,
  MosaicConfig,
  ProviderName,
} from '../types.js';

export interface ConnectionProfile {
  id: string;
  label?: string;
  provider: ProviderName;
  protocol: ConnectionProtocol;
  baseUrl?: string;
  modelsBaseUrl?: string;
  defaultModel?: string;
  auth: ConnectionAuth;
  source: ConnectionSource;
  explicitAuth: boolean;
}

export interface ConnectionCatalog {
  profiles: ConnectionProfile[];
  defaultConnection?: string;
}

export type ConnectionSelectionPlan =
  | {kind: 'selected'; profile: ConnectionProfile}
  | {kind: 'ambiguous'; profiles: ConnectionProfile[]}
  | {kind: 'legacy'};

const relayProtocols: ConnectionProtocol[] = ['openai-responses', 'openai-chat', 'anthropic-messages'];

/** Discover user-owned shared connections and the strict named environment format. */
export function discoverConnectionCatalog(
  config: MosaicConfig,
  environment: NodeJS.ProcessEnv = process.env,
): ConnectionCatalog {
  const byId = new Map<string, ConnectionProfile>();
  for (const [id, connection] of Object.entries(config.agents?.connections ?? {})) {
    byId.set(id, normalizeProfile(id, connection, 'user', environment));
  }
  const environmentCatalog = parseEnvironmentConnections(environment);
  for (const profile of environmentCatalog.profiles) {
    if (byId.has(profile.id)) {
      throw new Error(`Connection ${profile.id} is defined in both user configuration and SKEIN_CONNECTIONS.`);
    }
    byId.set(profile.id, profile);
  }
  const defaultConnection = config.agents?.defaultConnection ?? environmentCatalog.defaultConnection;
  if (defaultConnection && !byId.has(defaultConnection)) {
    throw new Error(`Default connection ${defaultConnection} is not present in the discovered connection catalog.`);
  }
  return {
    profiles: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
    ...(defaultConnection ? {defaultConnection} : {}),
  };
}

/** Parse isolated per-connection fields without ever reading a secret value. */
export function parseEnvironmentConnections(
  environment: NodeJS.ProcessEnv = process.env,
): ConnectionCatalog {
  const rawIds = environment.SKEIN_CONNECTIONS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  const ids = new Set<string>();
  const suffixes = new Map<string, string>();
  for (const id of rawIds) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(id)) {
      throw new Error(`Invalid SKEIN_CONNECTIONS id ${JSON.stringify(id)}; use lowercase shell-safe names.`);
    }
    if (ids.has(id)) throw new Error(`Duplicate SKEIN_CONNECTIONS id ${id}.`);
    ids.add(id);
    const suffix = id.toUpperCase().replace(/-/gu, '_');
    const collided = suffixes.get(suffix);
    if (collided) {
      throw new Error(`Connection ids ${collided} and ${id} collide after environment normalization (${suffix}).`);
    }
    suffixes.set(suffix, id);
  }
  const profiles: ConnectionProfile[] = rawIds.map((id) => {
    const suffix = id.toUpperCase().replace(/-/gu, '_');
    const prefix = `SKEIN_CONNECTION_${suffix}_`;
    const provider = parseProviderField(environment[`${prefix}PROVIDER`], `${prefix}PROVIDER`);
    const protocol = parseProtocolField(environment[`${prefix}PROTOCOL`], provider, `${prefix}PROTOCOL`);
    const baseUrl = optionalUrl(environment[`${prefix}BASE_URL`], `${prefix}BASE_URL`);
    const modelsBaseUrl = optionalUrl(environment[`${prefix}MODELS_BASE_URL`], `${prefix}MODELS_BASE_URL`);
    const apiKeyEnv = optionalEnvironmentName(environment[`${prefix}API_KEY_ENV`], `${prefix}API_KEY_ENV`);
    const authValue = environment[`${prefix}AUTH`]?.trim().toLowerCase();
    if (authValue && authValue !== 'env' && authValue !== 'none') {
      throw new Error(`${prefix}AUTH must be env or none.`);
    }
    if (authValue === 'none' && apiKeyEnv) {
      throw new Error(`${prefix}AUTH=none cannot be combined with ${prefix}API_KEY_ENV.`);
    }
    if (authValue === 'env' && !apiKeyEnv) {
      throw new Error(`${prefix}AUTH=env requires ${prefix}API_KEY_ENV.`);
    }
    const label = environment[`${prefix}LABEL`]?.trim();
    const defaultModel = environment[`${prefix}MODEL`]?.trim();
    const config: AgentConnectionConfig = {
      provider,
      protocol,
      ...(label ? {label} : {}),
      ...(baseUrl ? {baseUrl} : {}),
      ...(modelsBaseUrl ? {modelsBaseUrl} : {}),
      ...(defaultModel ? {defaultModel} : {}),
      ...(authValue === 'none'
        ? {auth: {type: 'none'}}
        : apiKeyEnv ? {auth: {type: 'env', name: apiKeyEnv}} : {}),
    };
    return normalizeProfile(id, config, 'environment', environment);
  });
  const defaultConnection = environment.SKEIN_DEFAULT_CONNECTION?.trim();
  if (defaultConnection && !ids.has(defaultConnection)) {
    throw new Error(`SKEIN_DEFAULT_CONNECTION references undiscovered connection ${defaultConnection}.`);
  }
  return {profiles, ...(defaultConnection ? {defaultConnection} : {})};
}

export function planConnectionSelection(
  catalog: ConnectionCatalog,
  environment: NodeJS.ProcessEnv = process.env,
  explicitConnection?: string,
): ConnectionSelectionPlan {
  if (explicitConnection) {
    const selected = catalog.profiles.find((profile) => profile.id === explicitConnection);
    if (!selected) throw new Error(`Unknown connection ${explicitConnection}. Use ${catalog.profiles.map(({id}) => id).join(', ') || 'a configured name'}.`);
    return {kind: 'selected', profile: selected};
  }
  if (catalog.defaultConnection) {
    const selected = catalog.profiles.find((profile) => profile.id === catalog.defaultConnection);
    if (!selected) throw new Error(`Default connection ${catalog.defaultConnection} is unavailable.`);
    return {kind: 'selected', profile: selected};
  }
  const complete = catalog.profiles.filter((profile) => connectionIssues(profile, environment).length === 0);
  if (complete.length === 1) return {kind: 'selected', profile: complete[0] as ConnectionProfile};
  if (complete.length > 1) return {kind: 'ambiguous', profiles: complete};
  return {kind: 'legacy'};
}

export function resolveConnectionModel(
  current: ModelConfig,
  profile: ConnectionProfile,
  overrides: {model?: string} = {},
  environment: NodeJS.ProcessEnv = process.env,
): {model: ModelConfig; activeConnection: ConnectionRuntimeInfo} {
  const issues = connectionIssues(profile, environment);
  if (issues.length) throw new Error(`Connection ${profile.id} is incomplete: ${issues.join('; ')}`);
  const apiKey = profile.auth.type === 'env' ? environment[profile.auth.name] : undefined;
  const model: ModelConfig = {
    provider: profile.provider,
    protocol: profile.protocol,
    model: overrides.model ?? profile.defaultModel ?? defaultModelForProvider(profile.provider),
    ...(current.temperature !== undefined ? {temperature: current.temperature} : {}),
    ...(current.maxTokens !== undefined ? {maxTokens: current.maxTokens} : {}),
    ...(profile.baseUrl ? {baseUrl: profile.baseUrl} : {}),
    ...(apiKey ? {apiKey} : {}),
  };
  return {model, activeConnection: connectionRuntimeInfo(profile, environment)};
}

export function connectionRuntimeCatalog(
  catalog: ConnectionCatalog,
  environment: NodeJS.ProcessEnv = process.env,
): ConnectionCatalogRuntime {
  return {
    ...(catalog.defaultConnection ? {defaultConnection: catalog.defaultConnection} : {}),
    profiles: catalog.profiles.map((profile) => connectionRuntimeInfo(profile, environment)),
  };
}

export function connectionRuntimeInfo(
  profile: ConnectionProfile,
  environment: NodeJS.ProcessEnv = process.env,
): ConnectionRuntimeInfo {
  const issues = connectionIssues(profile, environment);
  const authStatus = profile.auth.type === 'none'
    ? 'none' as const
    : environment[profile.auth.name] ? 'configured' as const : 'missing' as const;
  return {
    id: profile.id,
    ...(profile.label ? {label: profile.label} : {}),
    provider: profile.provider,
    protocol: profile.protocol,
    source: profile.source,
    endpoint: redactConnectionEndpoint(profile.baseUrl),
    modelsEndpoint: redactConnectionEndpoint(profile.modelsBaseUrl ?? profile.baseUrl),
    ...(profile.defaultModel ? {defaultModel: profile.defaultModel} : {}),
    authType: profile.auth.type,
    authStatus,
    complete: issues.length === 0,
    issues,
  };
}

export function legacyConnectionRuntimeInfo(model: ModelConfig): ConnectionRuntimeInfo {
  const remoteCompatibleMissingCredential = model.provider === 'compatible' && Boolean(model.baseUrl) &&
    !isLoopbackEndpoint(model.baseUrl as string) && !model.apiKey;
  const issues = [
    ...(model.provider === 'compatible' && !model.baseUrl ? ['compatible provider requires base URL'] : []),
    ...(remoteCompatibleMissingCredential ? ['remote compatible provider credential is not configured'] : []),
    ...(model.provider !== 'compatible' && !model.apiKey ? ['provider credential is not configured'] : []),
  ];
  const authExpected = model.provider !== 'compatible' || remoteCompatibleMissingCredential || Boolean(model.apiKey);
  return {
    id: 'legacy',
    provider: model.provider,
    protocol: model.protocol ?? defaultProtocol(model.provider),
    source: 'legacy',
    endpoint: redactConnectionEndpoint(model.baseUrl),
    modelsEndpoint: redactConnectionEndpoint(model.baseUrl),
    defaultModel: model.model,
    authType: authExpected ? 'env' : 'none',
    authStatus: model.apiKey ? 'configured' : authExpected ? 'missing' : 'none',
    complete: issues.length === 0,
    issues,
  };
}

export function connectionCredentialReference(profile: ConnectionProfile): string {
  if (profile.auth.type === 'env') return `env:${profile.auth.name}`;
  return 'none';
}

export function connectionEnvironmentTypos(
  environment: NodeJS.ProcessEnv = process.env,
): Array<{name: string; replacement: string}> {
  return [
    {name: 'SEKIN_API', replacement: 'SKEIN_API_KEY'},
    {name: 'SKEIN_BASEURL', replacement: 'SKEIN_BASE_URL'},
  ].filter(({name}) => Object.hasOwn(environment, name));
}

export function connectionIssues(
  profile: ConnectionProfile,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const issues: string[] = [];
  if (profile.provider !== 'compatible') {
    issues.push('named primary connections support compatible relay providers only');
  }
  if (profile.provider === 'compatible' && !profile.baseUrl) issues.push('compatible provider requires base URL');
  if (profile.provider === 'compatible' && !relayProtocols.includes(profile.protocol)) {
    issues.push('relay transport must use openai-responses, openai-chat, or anthropic-messages');
  }
  if (profile.protocol === 'anthropic-messages' && !profile.modelsBaseUrl) {
    issues.push('anthropic relay transport requires an explicit models base URL');
  }
  if (profile.auth.type === 'env' && !environment[profile.auth.name]) {
    issues.push(`credential environment ${profile.auth.name} is not set`);
  }
  if (!profile.explicitAuth && profile.provider !== 'compatible' && profile.baseUrl && !isOfficialProviderEndpoint(profile.provider, profile.baseUrl)) {
    issues.push('custom provider endpoint requires explicit connection auth');
  }
  return issues;
}

function normalizeProfile(
  id: string,
  connection: AgentConnectionConfig,
  source: ConnectionSource,
  environment: NodeJS.ProcessEnv,
): ConnectionProfile {
  const explicitAuth = Boolean(connection.auth || connection.apiKeyEnv);
  const auth = connection.auth ?? (connection.apiKeyEnv
    ? {type: 'env', name: connection.apiKeyEnv} as const
    : defaultAuth(connection.provider, connection.baseUrl, environment));
  return {
    id,
    ...(connection.label ? {label: connection.label} : {}),
    provider: connection.provider,
    protocol: connection.protocol ?? defaultProtocol(connection.provider),
    ...(connection.baseUrl ? {baseUrl: connection.baseUrl} : {}),
    ...(connection.modelsBaseUrl ? {modelsBaseUrl: connection.modelsBaseUrl} : {}),
    ...(connection.defaultModel ? {defaultModel: connection.defaultModel} : {}),
    auth,
    source,
    explicitAuth,
  };
}

function defaultAuth(
  provider: ProviderName,
  baseUrl: string | undefined,
  environment: NodeJS.ProcessEnv,
): ConnectionAuth {
  if (provider === 'compatible' && baseUrl && isLoopbackEndpoint(baseUrl)) return {type: 'none'};
  if (provider === 'compatible') {
    return {type: 'env', name: environment.SKEIN_API_KEY ? 'SKEIN_API_KEY' : environment.MOSAIC_API_KEY ? 'MOSAIC_API_KEY' : 'SKEIN_API_KEY'};
  }
  return {type: 'env', name: providerApiKeyEnv(provider)};
}

function defaultProtocol(provider: ProviderName): ConnectionProtocol {
  if (provider === 'anthropic') return 'anthropic-messages';
  if (provider === 'gemini') return 'gemini';
  return 'openai-chat';
}

function parseProviderField(value: string | undefined, name: string): ProviderName {
  const provider = value?.trim().toLowerCase() || 'compatible';
  if (provider !== 'compatible') throw new Error(`${name} must be compatible for named relay connections.`);
  return 'compatible';
}

function parseProtocolField(value: string | undefined, provider: ProviderName, name: string): ConnectionProtocol {
  if (!value?.trim()) return provider === 'compatible' ? 'openai-responses' : defaultProtocol(provider);
  const protocol = value.trim().toLowerCase() as ConnectionProtocol;
  if (!relayProtocols.includes(protocol)) throw new Error(`${name} must be openai-responses, openai-chat, or anthropic-messages.`);
  return protocol;
}

function optionalUrl(value: string | undefined, name: string): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    if (url.username || url.password || url.search || url.hash) throw new Error('unsafe URL components');
    return url.toString().replace(/\/$/u, '');
  } catch {
    throw new Error(`${name} must be an http or https URL.`);
  }
}

function optionalEnvironmentName(value: string | undefined, name: string): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim();
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(normalized)) {
    throw new Error(`${name} must name an uppercase environment variable.`);
  }
  return normalized;
}

export function isOfficialProviderEndpoint(
  provider: Exclude<ProviderName, 'compatible'>,
  endpoint: string,
): boolean {
  const official: Record<Exclude<ProviderName, 'compatible'>, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
  };
  return endpoint.replace(/\/+$/u, '') === official[provider];
}

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  } catch {
    return false;
  }
}

function redactConnectionEndpoint(endpoint?: string): string {
  if (!endpoint) return 'provider default';
  try {
    const url = new URL(endpoint);
    const authentication = url.username || url.password ? '<redacted>@' : '';
    return `${url.protocol}//${authentication}${url.host}${url.pathname}${url.search ? '?<redacted>' : ''}${url.hash ? '#<redacted>' : ''}`;
  } catch {
    return 'configured endpoint';
  }
}
