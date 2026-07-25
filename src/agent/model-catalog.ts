import {createHash} from 'node:crypto';
import type {AgentConnectionConfig} from '../types.js';

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
): Promise<ModelCatalogEntry[]> {
  if (connection.provider !== 'compatible' && connection.provider !== 'openai') {
    throw new Error(`Model discovery is currently supported for compatible and openai connections, not ${connection.provider}.`);
  }
  if (connection.protocol === 'anthropic-messages' && !connection.modelsBaseUrl) {
    throw new Error('Anthropic relay model discovery requires an explicit modelsBaseUrl.');
  }
  const baseUrl = connection.modelsBaseUrl ?? connection.baseUrl ?? 'https://api.openai.com/v1';
  const endpoint = baseUrl.endsWith('/models') ? baseUrl : `${baseUrl.replace(/\/+$/u, '')}/models`;
  const apiKeyHeader = connection.modelsAuthHeader ??
    (connection.auth?.type === 'env' ? connection.auth.header : undefined) ?? 'bearer';
  const apiKey = apiKeyHeader === 'none' ? undefined : connectionApiKey(connection, environment);
  const cacheKey = catalogFingerprint(
    endpoint,
    `${connection.auth?.type ?? (apiKey ? 'legacy-env' : 'none')}:${apiKeyHeader}`,
    apiKey,
  );
  const cached = modelCatalogCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    touchCacheEntry(cacheKey, cached);
    return copyModels(cached.models);
  }
  const response = await fetch(endpoint, {
    redirect: 'error',
    headers: {
      accept: 'application/json',
      ...(apiKey ? apiKeyHeader === 'x-api-key'
        ? {'x-api-key': apiKey}
        : {authorization: `Bearer ${apiKey}`} : {}),
      ...(cached?.etag ? {'if-none-match': cached.etag} : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 304 && cached) {
    const refreshed = {...cached, lastSuccessAt: now, expiresAt: now + MODEL_CATALOG_TTL_MS};
    touchCacheEntry(cacheKey, refreshed);
    return copyModels(refreshed.models);
  }
  if (response.status === 401 || response.status === 403) modelCatalogCache.delete(cacheKey);
  const body = await response.text();
  if (!response.ok) throw new Error(`Model discovery failed (${response.status}).`);
  if (body.length > 2_000_000) throw new Error('Model discovery response is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error('Model discovery returned invalid JSON.');
  }
  const data = parsed && typeof parsed === 'object' && Array.isArray((parsed as {data?: unknown}).data)
    ? (parsed as {data: unknown[]}).data
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as {models?: unknown}).models)
      ? (parsed as {models: unknown[]}).models
    : Array.isArray(parsed) ? parsed : [];
  const models = data.flatMap((value) => {
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
  }).sort((left, right) => left.id.localeCompare(right.id));
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

function connectionApiKey(connection: AgentConnectionConfig, environment: NodeJS.ProcessEnv): string | undefined {
  if (connection.auth?.type === 'env') {
    const value = environment[connection.auth.name];
    if (!value) throw new Error(`Connection credential environment ${connection.auth.name} is not set.`);
    return value;
  }
  if (connection.auth?.type === 'none') return undefined;
  if (connection.apiKeyEnv) {
    const value = environment[connection.apiKeyEnv];
    if (!value) throw new Error(`Connection credential environment ${connection.apiKeyEnv} is not set.`);
    return value;
  }
  if (connection.provider === 'openai' && connection.baseUrl &&
      connection.baseUrl.replace(/\/+$/u, '') !== 'https://api.openai.com/v1') {
    throw new Error('Custom OpenAI model endpoints require explicit connection auth.');
  }
  return defaultConnectionApiKey(connection.provider, environment);
}

function defaultConnectionApiKey(provider: AgentConnectionConfig['provider'], environment: NodeJS.ProcessEnv): string | undefined {
  if (provider === 'openai') return environment.OPENAI_API_KEY;
  if (provider === 'compatible') return environment.SKEIN_API_KEY ?? environment.MOSAIC_API_KEY;
  return undefined;
}
