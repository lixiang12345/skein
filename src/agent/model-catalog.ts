import {createHash} from 'node:crypto';
import {providerApiKeyEnv} from '../config.js';
import type {AgentConnectionConfig, ConnectionAuth} from '../types.js';
import {resolveConnectionHeaders, withDefaultCredentialPlacement} from './connection-auth.js';

export interface ModelCatalogEntry {
  id: string;
  ownedBy?: string;
  contextLength?: number;
}

interface ModelCatalogCacheEntry {
  models: ModelCatalogEntry[];
  etag?: string;
  lastSuccessAt: number;
  expiresAt: number;
}

const MODEL_CATALOG_TTL_MS = 15 * 60 * 1_000;
const MODEL_CATALOG_CACHE_LIMIT = 32;
const modelCatalogCache = new Map<string, ModelCatalogCacheEntry>();

export async function listConnectionModels(
  connection: AgentConnectionConfig,
  environment: NodeJS.ProcessEnv = process.env,
  options: {strictCatalog?: boolean} = {},
): Promise<ModelCatalogEntry[]> {
  const declared = declaredModels(connection);
  if (connection.modelDiscovery === false) {
    if (declared.length) return declared;
    throw new Error('Model discovery is disabled and no models are declared.');
  }
  const baseUrl = catalogBaseUrl(connection);
  if (!baseUrl) {
    if (declared.length) return declared;
    throw new Error('No model catalog is configured; declare models manually or set modelsBaseUrl.');
  }
  const endpoint = catalogEndpoint(baseUrl, connection.modelsPath);
  const auth = catalogAuth(connection, environment);
  const resolved = await resolveConnectionHeaders(auth, connection.modelsHeaders, {environment});
  const cacheKey = catalogFingerprint(
    endpoint,
    `${auth.type}:${JSON.stringify(resolved.headers)}`,
    resolved.value,
  );
  const cached = modelCatalogCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    touchCacheEntry(cacheKey, cached);
    return copyModels(cached.models);
  }
  let response: Response;
  try {
    response = await fetch(endpoint, {
      redirect: 'error',
      headers: {
        accept: 'application/json',
        ...resolved.headers,
        ...(cached?.etag ? {'if-none-match': cached.etag} : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (declared.length && !options.strictCatalog) return declared;
    throw error;
  }
  if (response.status === 304 && cached) {
    const refreshed = {...cached, lastSuccessAt: now, expiresAt: now + MODEL_CATALOG_TTL_MS};
    touchCacheEntry(cacheKey, refreshed);
    return copyModels(refreshed.models);
  }
  if (response.status === 401 || response.status === 403) modelCatalogCache.delete(cacheKey);
  const body = await response.text();
  if (!response.ok) {
    if (declared.length && !options.strictCatalog) return declared;
    throw new Error(`Model discovery failed (${response.status}).`);
  }
  if (body.length > 2_000_000) {
    if (declared.length && !options.strictCatalog) return declared;
    throw new Error('Model discovery response is too large.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    if (declared.length && !options.strictCatalog) return declared;
    throw new Error('Model discovery returned invalid JSON.');
  }
  const data = parsed && typeof parsed === 'object' && Array.isArray((parsed as {data?: unknown}).data)
    ? (parsed as {data: unknown[]}).data
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as {models?: unknown}).models)
      ? (parsed as {models: unknown[]}).models
    : Array.isArray(parsed) ? parsed : [];
  const discovered = data.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const candidate = value as {id?: unknown; model_id?: unknown};
    const id = typeof candidate.id === 'string' ? candidate.id : typeof candidate.model_id === 'string' ? candidate.model_id : undefined;
    if (!id) return [];
    const item = value as {owned_by?: unknown; ownedBy?: unknown; context_length?: unknown; contextLength?: unknown};
    const contextLength = typeof item.context_length === 'number'
      ? item.context_length
      : typeof item.contextLength === 'number' ? item.contextLength : undefined;
    return [{
      id,
      ...(typeof item.owned_by === 'string' ? {ownedBy: item.owned_by} : typeof item.ownedBy === 'string' ? {ownedBy: item.ownedBy} : {}),
      ...(contextLength !== undefined ? {contextLength} : {}),
    }];
  });
  const models = mergeModels(declared, discovered);
  touchCacheEntry(cacheKey, {
    models,
    ...(response.headers.get('etag') ? {etag: response.headers.get('etag') as string} : {}),
    lastSuccessAt: now,
    expiresAt: now + MODEL_CATALOG_TTL_MS,
  });
  trimModelCatalogCache();
  return copyModels(models);
}

/** Clear process-local discovery metadata, for explicit refreshes and deterministic tests. */
export function clearModelCatalogCache(): void {
  modelCatalogCache.clear();
}

function catalogFingerprint(endpoint: string, authType: string, apiKey: string | undefined): string {
  return createHash('sha256')
    .update(endpoint)
    .update('\0')
    .update(authType)
    .update('\0')
    .update(apiKey ?? '')
    .digest('hex');
}

function touchCacheEntry(key: string, entry: ModelCatalogCacheEntry): void {
  modelCatalogCache.delete(key);
  modelCatalogCache.set(key, entry);
}

function trimModelCatalogCache(): void {
  while (modelCatalogCache.size > MODEL_CATALOG_CACHE_LIMIT) {
    const oldest = modelCatalogCache.keys().next().value as string | undefined;
    if (!oldest) return;
    modelCatalogCache.delete(oldest);
  }
}

function copyModels(models: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return models.map((model) => ({...model}));
}

function declaredModels(connection: AgentConnectionConfig): ModelCatalogEntry[] {
  return (connection.models ?? []).map((model) => ({
    id: model.id,
    ...(model.contextLength ? {contextLength: model.contextLength} : {}),
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function catalogBaseUrl(connection: AgentConnectionConfig): string | undefined {
  if (connection.modelsBaseUrl) return connection.modelsBaseUrl;
  if (connection.protocol === 'anthropic-messages' || connection.protocol === 'gemini') return undefined;
  if (connection.baseUrl) return connection.baseUrl;
  return connection.provider === 'openai' ? 'https://api.openai.com/v1' : undefined;
}

function catalogEndpoint(baseUrl: string, path = '/models'): string {
  if (baseUrl.endsWith(path)) return baseUrl;
  return `${baseUrl.replace(/\/+$/u, '')}/${path.replace(/^\/+/, '')}`;
}

function catalogAuth(
  connection: AgentConnectionConfig,
  environment: NodeJS.ProcessEnv,
): ConnectionAuth {
  if (connection.modelsAuth) return connection.modelsAuth;
  if (connection.modelsAuthHeader === 'none') return {type: 'none'};
  if (!connection.auth && !connection.apiKeyEnv && connection.provider !== 'compatible' &&
      connection.baseUrl && !isOfficialProviderEndpoint(connection.provider, connection.baseUrl)) {
    throw new Error('Custom provider model endpoints require explicit connection auth.');
  }
  const inference = withDefaultCredentialPlacement(connection.auth ?? (connection.apiKeyEnv
    ? {type: 'env', name: connection.apiKeyEnv} as const
    : defaultConnectionAuth(connection, environment)), connection.provider, connection.protocol ?? defaultProtocol(connection.provider));
  if (inference.type !== 'env' && inference.type !== 'command') return inference;
  if (!connection.modelsAuthHeader) return inference;
  if (inference.type === 'env') {
    return {type: 'env', name: inference.name, header: connection.modelsAuthHeader};
  }
  return {
    type: 'command',
    command: inference.command,
    ...(inference.args ? {args: inference.args} : {}),
    ...(inference.timeoutMs !== undefined ? {timeoutMs: inference.timeoutMs} : {}),
    ...(inference.refreshIntervalMs !== undefined ? {refreshIntervalMs: inference.refreshIntervalMs} : {}),
    ...(inference.passEnv ? {passEnv: inference.passEnv} : {}),
    header: connection.modelsAuthHeader,
  };
}

function isOfficialProviderEndpoint(provider: AgentConnectionConfig['provider'], endpoint: string): boolean {
  const official: Partial<Record<AgentConnectionConfig['provider'], string>> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
  };
  return endpoint.replace(/\/+$/u, '') === official[provider];
}

function defaultConnectionAuth(
  connection: AgentConnectionConfig,
  environment: NodeJS.ProcessEnv,
): ConnectionAuth {
  if (connection.provider === 'compatible') {
    const name = environment.SKEIN_API_KEY ? 'SKEIN_API_KEY' : environment.MOSAIC_API_KEY
      ? 'MOSAIC_API_KEY' : 'SKEIN_API_KEY';
    return {type: 'env', name};
  }
  return {type: 'env', name: providerApiKeyEnv(connection.provider)};
}

function defaultProtocol(provider: AgentConnectionConfig['provider']): NonNullable<AgentConnectionConfig['protocol']> {
  if (provider === 'anthropic') return 'anthropic-messages';
  if (provider === 'gemini') return 'gemini';
  return 'openai-chat';
}

function mergeModels(
  declared: ModelCatalogEntry[],
  discovered: ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const models = new Map(declared.map((model) => [model.id, model]));
  for (const model of discovered) models.set(model.id, {...models.get(model.id), ...model});
  return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
}
