import {defaultModelForProvider, providerApiKeyEnv} from '../config.js';
import {
  connectionAuthConfigured,
  connectionAuthReference,
  connectionHeaderConfigurationIssues,
  resolveConnectionHeaders,
  withDefaultCredentialPlacement,
  withoutConnectionCredentialHeader,
  type ResolveConnectionAuthOptions,
} from './connection-auth.js';
import type {
  AgentConnectionConfig,
  ConnectionAuth,
  ConnectionCatalogRuntime,
  ConnectionApiKeyHeader,
  ConnectionDeclaredModel,
  ConnectionHeaderSources,
  ConnectionModelAuth,
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
  providerId: string;
  protocol: ConnectionProtocol;
  baseUrl?: string;
  modelsBaseUrl?: string;
  modelDiscovery?: boolean;
  modelsPath?: string;
  modelsAuthHeader?: ConnectionModelAuth;
  modelsAuth?: ConnectionAuth;
  headers?: ConnectionHeaderSources;
  modelsHeaders?: ConnectionHeaderSources;
  models?: ConnectionDeclaredModel[];
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
  const configuredConnections = Object.keys(config.connections?.profiles ?? {}).length
    ? config.connections?.profiles
    : config.agents?.connections;
  for (const [id, connection] of Object.entries(configuredConnections ?? {})) {
    byId.set(id, normalizeProfile(id, connection, 'user', environment));
  }
  const environmentCatalog = parseEnvironmentConnections(environment);
  for (const profile of environmentCatalog.profiles) {
    if (byId.has(profile.id)) {
      throw new Error(`Connection ${profile.id} is defined in both user configuration and SKEIN_CONNECTIONS.`);
    }
    byId.set(profile.id, profile);
  }
  const defaultConnection = config.connections?.defaultConnection ?? config.agents?.defaultConnection ??
    environmentCatalog.defaultConnection;
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
    const providerId = parseProviderIdField(environment[`${prefix}PROVIDER`], `${prefix}PROVIDER`);
    const provider = providerForId(providerId);
    const protocol = parseProtocolField(environment[`${prefix}PROTOCOL`], provider, `${prefix}PROTOCOL`);
    const baseUrl = optionalUrl(environment[`${prefix}BASE_URL`], `${prefix}BASE_URL`);
    const modelsBaseUrl = optionalUrl(environment[`${prefix}MODELS_BASE_URL`], `${prefix}MODELS_BASE_URL`);
    const apiKeyEnv = optionalEnvironmentName(environment[`${prefix}API_KEY_ENV`], `${prefix}API_KEY_ENV`);
    const authHeader = optionalApiKeyHeader(environment[`${prefix}AUTH_HEADER`], `${prefix}AUTH_HEADER`);
    const modelsAuthHeader = optionalModelAuth(
      environment[`${prefix}MODELS_AUTH_HEADER`],
      `${prefix}MODELS_AUTH_HEADER`,
    );
    const authValue = environment[`${prefix}AUTH`]?.trim().toLowerCase();
    if (authValue && authValue !== 'env' && authValue !== 'none') {
      throw new Error(`${prefix}AUTH must be env or none.`);
    }
    if (authValue === 'none' && apiKeyEnv) {
      throw new Error(`${prefix}AUTH=none cannot be combined with ${prefix}API_KEY_ENV.`);
    }
    if (authValue === 'none' && (authHeader || (modelsAuthHeader && modelsAuthHeader !== 'none'))) {
      throw new Error(`${prefix}AUTH=none cannot be combined with credential header settings.`);
    }
    if (authValue === 'env' && !apiKeyEnv) {
      throw new Error(`${prefix}AUTH=env requires ${prefix}API_KEY_ENV.`);
    }
    if ((authHeader || (modelsAuthHeader && modelsAuthHeader !== 'none')) && !apiKeyEnv) {
      throw new Error(`${prefix}AUTH_HEADER settings require ${prefix}API_KEY_ENV.`);
    }
    const label = environment[`${prefix}LABEL`]?.trim();
    const defaultModel = environment[`${prefix}MODEL`]?.trim();
    const config: AgentConnectionConfig = {
      provider,
      providerId,
      protocol,
      ...(label ? {label} : {}),
      ...(baseUrl ? {baseUrl} : {}),
      ...(modelsBaseUrl ? {modelsBaseUrl} : {}),
      ...(modelsAuthHeader ? {modelsAuthHeader} : {}),
      ...(defaultModel ? {defaultModel} : {}),
      ...(authValue === 'none'
        ? {auth: {type: 'none'}}
        : apiKeyEnv ? {auth: {type: 'env', name: apiKeyEnv, ...(authHeader ? {header: authHeader} : {})}} : {}),
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

export async function resolveConnectionModel(
  current: ModelConfig,
  profile: ConnectionProfile,
  overrides: {model?: string} = {},
  environment: NodeJS.ProcessEnv = process.env,
  authOptions: Omit<ResolveConnectionAuthOptions, 'environment'> = {},
): Promise<{model: ModelConfig; activeConnection: ConnectionRuntimeInfo}> {
  const issues = connectionIssues(profile, environment);
  if (issues.length) throw new Error(`Connection ${profile.id} is incomplete: ${issues.join('; ')}`);
  const credential = await resolveConnectionHeaders(profile.auth, profile.headers, {
    ...authOptions,
    environment,
  });
  const nativeGeminiQueryAuth = profile.provider === 'gemini' && profile.protocol === 'gemini' &&
    profile.auth.type !== 'none' && !profile.auth.header && !profile.auth.placement;
  const runtimeProvider = nativeGeminiQueryAuth
    ? 'gemini'
    : profile.provider !== 'compatible' && !profile.baseUrl ? profile.provider : 'compatible';
  const requestHeaders = runtimeProvider === 'compatible'
    ? credential.headers
    : withoutConnectionCredentialHeader(profile.auth, credential.headers);
  const model: ModelConfig = {
    provider: runtimeProvider,
    protocol: profile.protocol,
    model: overrides.model ?? profile.defaultModel ?? defaultModelForProvider('compatible'),
    ...(current.temperature !== undefined ? {temperature: current.temperature} : {}),
    ...(current.maxTokens !== undefined ? {maxTokens: current.maxTokens} : {}),
    ...(profile.baseUrl ? {baseUrl: profile.baseUrl} : {}),
    ...(profile.auth.type !== 'none' && profile.auth.header ? {apiKeyHeader: profile.auth.header} : {}),
    ...(runtimeProvider !== 'compatible' && credential.value ? {apiKey: credential.value} : {}),
    ...(Object.keys(requestHeaders).length ? {requestHeaders} : {}),
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
  const catalogIssues = connectionCatalogIssues(profile, environment);
  const authStatus = profile.auth.type === 'none'
    ? 'none' as const
    : connectionAuthConfigured(profile.auth, environment) ? 'configured' as const : 'missing' as const;
  const modelsAuth = profile.modelsAuth;
  return {
    id: profile.id,
    ...(profile.label ? {label: profile.label} : {}),
    provider: profile.provider,
    providerId: profile.providerId,
    protocol: profile.protocol,
    source: profile.source,
    endpoint: redactConnectionEndpoint(profile.baseUrl),
    modelsEndpoint: redactConnectionEndpoint(profile.modelsBaseUrl ?? profile.baseUrl),
    ...(profile.defaultModel ? {defaultModel: profile.defaultModel} : {}),
    authType: profile.auth.type,
    modelsAuthType: modelsAuth?.type ?? (profile.modelsAuthHeader === 'none' ? 'none' : 'inherit'),
    ...(profile.auth.type !== 'none' && !profile.auth.placement &&
      !(profile.provider === 'gemini' && profile.protocol === 'gemini' && !profile.auth.header)
      ? {authHeader: profile.auth.header ?? 'bearer'} : {}),
    ...catalogAuthHeader(profile, modelsAuth),
    authStatus,
    complete: issues.length === 0,
    issues,
    ...(catalogIssues.length ? {catalogIssues} : {}),
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
    providerId: model.provider,
    protocol: model.protocol ?? defaultProtocol(model.provider),
    source: 'legacy',
    endpoint: redactConnectionEndpoint(model.baseUrl),
    modelsEndpoint: redactConnectionEndpoint(model.baseUrl),
    defaultModel: model.model,
    authType: authExpected ? 'env' : 'none',
    modelsAuthType: 'inherit',
    ...(authExpected ? {
      authHeader: model.apiKeyHeader ?? (model.provider === 'anthropic' ? 'x-api-key' : 'bearer'),
      modelsAuthHeader: model.apiKeyHeader ?? (model.provider === 'anthropic' ? 'x-api-key' : 'bearer'),
    } : {}),
    authStatus: model.apiKey ? 'configured' : authExpected ? 'missing' : 'none',
    complete: issues.length === 0,
    issues,
  };
}

export function connectionCredentialReference(profile: ConnectionProfile): string {
  const placement = profile.auth.type !== 'none' ? connectionAuthPlacement(profile) : undefined;
  return `${connectionAuthReference(profile.auth)}${placement ? `/${placement}` : ''}`;
}

export function connectionAuthPlacement(profile: ConnectionProfile): string {
  if (profile.auth.type === 'none') return 'none';
  if (profile.auth.placement) return profile.auth.placement.name;
  if (profile.auth.header) return profile.auth.header;
  if (profile.provider === 'gemini' && profile.protocol === 'gemini') return 'query:key';
  return 'bearer';
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
  if (profile.provider === 'compatible' && !profile.baseUrl) issues.push('compatible provider requires base URL');
  if (profile.provider !== 'compatible' && !profile.baseUrl && profile.auth.type === 'none') {
    issues.push('official provider endpoint requires authentication');
  }
  if (!profile.baseUrl && !providerSupportsDefaultEndpoint(profile.provider, profile.protocol)) {
    issues.push('provider and wire protocol require an explicit base URL');
  }
  if (!profile.baseUrl && profile.auth.type !== 'none' && profile.auth.placement) {
    issues.push('custom credential placement requires an explicit base URL');
  }
  if (!profile.baseUrl && profile.provider === 'gemini' && profile.protocol === 'gemini' &&
      profile.auth.type !== 'none' && profile.auth.header) {
    issues.push('header-based Gemini authentication requires an explicit base URL');
  }
  if (![...relayProtocols, 'gemini'].includes(profile.protocol)) {
    issues.push('connection transport is unsupported');
  }
  if (profile.auth.type === 'env' && !connectionAuthConfigured(profile.auth, environment)) {
    issues.push(`credential environment ${profile.auth.name} is not set`);
  }
  for (const envName of Object.values(profile.headers?.env ?? {})) {
    if (!environment[envName]) issues.push(`connection header environment ${envName} is not set`);
  }
  issues.push(...connectionHeaderConfigurationIssues(profile.auth, profile.headers));
  if (!profile.explicitAuth && profile.provider !== 'compatible' && profile.baseUrl && !isOfficialProviderEndpoint(profile.provider, profile.baseUrl)) {
    issues.push('custom provider endpoint requires explicit connection auth');
  }
  return issues;
}

/** Catalog readiness is diagnostic only and never blocks inference selection. */
export function connectionCatalogIssues(
  profile: ConnectionProfile,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  if (profile.modelDiscovery === false) return [];
  const issues: string[] = [];
  if (!profile.modelsBaseUrl && (profile.protocol === 'anthropic-messages' || profile.protocol === 'gemini') &&
      !profile.models?.length) {
    issues.push('model catalog is not configured; declare models or set modelsBaseUrl');
  }
  if (profile.modelsAuth?.type === 'env' && !connectionAuthConfigured(profile.modelsAuth, environment)) {
    issues.push(`model catalog credential environment ${profile.modelsAuth.name} is not set`);
  }
  for (const envName of Object.values(profile.modelsHeaders?.env ?? {})) {
    if (!environment[envName]) issues.push(`model catalog header environment ${envName} is not set`);
  }
  issues.push(...connectionHeaderConfigurationIssues(catalogDiagnosticAuth(profile), profile.modelsHeaders)
    .map((issue) => `model catalog ${issue}`));
  if (profile.modelsAuthHeader && profile.modelsAuthHeader !== 'none' && profile.auth.type === 'none' && !profile.modelsAuth) {
    issues.push('legacy models authentication header requires reusable authentication');
  }
  return issues;
}

function catalogDiagnosticAuth(profile: ConnectionProfile): ConnectionAuth {
  if (profile.modelsAuth) return profile.modelsAuth;
  if (profile.modelsAuthHeader === 'none') return {type: 'none'};
  if (!profile.modelsAuthHeader || profile.auth.type === 'none') return profile.auth;
  if (profile.auth.type === 'env') {
    return {type: 'env', name: profile.auth.name, header: profile.modelsAuthHeader};
  }
  return {
    type: 'command',
    command: profile.auth.command,
    ...(profile.auth.args ? {args: profile.auth.args} : {}),
    ...(profile.auth.timeoutMs !== undefined ? {timeoutMs: profile.auth.timeoutMs} : {}),
    ...(profile.auth.refreshIntervalMs !== undefined ? {refreshIntervalMs: profile.auth.refreshIntervalMs} : {}),
    ...(profile.auth.passEnv ? {passEnv: profile.auth.passEnv} : {}),
    header: profile.modelsAuthHeader,
  };
}

function normalizeProfile(
  id: string,
  connection: AgentConnectionConfig,
  source: ConnectionSource,
  environment: NodeJS.ProcessEnv,
): ConnectionProfile {
  const explicitAuth = Boolean(connection.auth || connection.apiKeyEnv);
  const protocol = connection.protocol ?? defaultProtocol(connection.provider);
  const configuredAuth = connection.auth ?? (connection.apiKeyEnv
    ? {type: 'env', name: connection.apiKeyEnv} as const
    : defaultAuth(connection.provider, connection.baseUrl, environment));
  const auth = withDefaultCredentialPlacement(configuredAuth, connection.provider, protocol);
  return {
    id,
    ...(connection.label ? {label: connection.label} : {}),
    provider: connection.provider,
    providerId: connection.providerId ?? connection.provider,
    protocol,
    ...(connection.baseUrl ? {baseUrl: connection.baseUrl} : {}),
    ...(connection.modelsBaseUrl ? {modelsBaseUrl: connection.modelsBaseUrl} : {}),
    ...(connection.modelDiscovery !== undefined ? {modelDiscovery: connection.modelDiscovery} : {}),
    ...(connection.modelsPath ? {modelsPath: connection.modelsPath} : {}),
    ...(connection.modelsAuthHeader ? {modelsAuthHeader: connection.modelsAuthHeader} : {}),
    ...(connection.modelsAuth ? {modelsAuth: connection.modelsAuth} : {}),
    ...(connection.headers ? {headers: connection.headers} : {}),
    ...(connection.modelsHeaders ? {modelsHeaders: connection.modelsHeaders} : {}),
    ...(connection.models ? {models: connection.models} : {}),
    ...(connection.defaultModel ? {defaultModel: connection.defaultModel} : {}),
    auth,
    source,
    explicitAuth,
  };
}

function providerSupportsDefaultEndpoint(provider: ProviderName, protocol: ConnectionProtocol): boolean {
  if (provider === 'openai') return protocol === 'openai-responses' || protocol === 'openai-chat';
  if (provider === 'anthropic') return protocol === 'anthropic-messages';
  if (provider === 'gemini') return protocol === 'gemini';
  return false;
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

function parseProviderIdField(value: string | undefined, name: string): string {
  const providerId = value?.trim().toLowerCase() || 'compatible';
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(providerId)) {
    throw new Error(`${name} must be a lowercase provider label using letters, numbers, ., _, or -.`);
  }
  return providerId;
}

function providerForId(providerId: string): ProviderName {
  return providerId === 'openai' || providerId === 'anthropic' || providerId === 'gemini'
    ? providerId
    : 'compatible';
}

function parseProtocolField(value: string | undefined, provider: ProviderName, name: string): ConnectionProtocol {
  if (!value?.trim()) return provider === 'compatible' ? 'openai-responses' : defaultProtocol(provider);
  const protocol = value.trim().toLowerCase() as ConnectionProtocol;
  if (![...relayProtocols, 'gemini'].includes(protocol)) {
    throw new Error(`${name} must be openai-responses, openai-chat, anthropic-messages, or gemini.`);
  }
  return protocol;
}

function catalogAuthHeader(
  profile: ConnectionProfile,
  modelsAuth: ConnectionAuth | undefined,
): Pick<ConnectionRuntimeInfo, 'modelsAuthHeader'> | Record<string, never> {
  if (profile.modelsAuthHeader) return {modelsAuthHeader: profile.modelsAuthHeader};
  const auth = modelsAuth ?? profile.auth;
  if (auth.type === 'none' || auth.placement) return {};
  return {modelsAuthHeader: auth.header ?? 'bearer'};
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

function optionalApiKeyHeader(value: string | undefined, name: string): ConnectionApiKeyHeader | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized !== 'bearer' && normalized !== 'x-api-key') {
    throw new Error(`${name} must be bearer or x-api-key.`);
  }
  return normalized;
}

function optionalModelAuth(value: string | undefined, name: string): ConnectionModelAuth | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized !== 'bearer' && normalized !== 'x-api-key' && normalized !== 'none') {
    throw new Error(`${name} must be bearer, x-api-key, or none.`);
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
