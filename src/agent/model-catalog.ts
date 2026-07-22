import type {AgentConnectionConfig} from '../types.js';

export interface ModelCatalogEntry {
  id: string;
  ownedBy?: string;
  contextLength?: number;
}

export async function listConnectionModels(
  connection: AgentConnectionConfig,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ModelCatalogEntry[]> {
  if (connection.provider !== 'compatible' && connection.provider !== 'openai') {
    throw new Error(`Model discovery is currently supported for compatible and openai connections, not ${connection.provider}.`);
  }
  const baseUrl = connection.baseUrl ?? 'https://api.openai.com/v1';
  const endpoint = `${baseUrl.replace(/\/+$/u, '')}/models`;
  const apiKey = connection.apiKeyEnv
    ? environment[connection.apiKeyEnv]
    : defaultConnectionApiKey(connection.provider, environment);
  const response = await fetch(endpoint, {
    headers: {
      accept: 'application/json',
      ...(apiKey ? {authorization: `Bearer ${apiKey}`} : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Model discovery failed (${response.status}): ${body.replace(/\s+/gu, ' ').slice(0, 240)}`);
  if (body.length > 2_000_000) throw new Error('Model discovery response is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error('Model discovery returned invalid JSON.');
  }
  const data = parsed && typeof parsed === 'object' && Array.isArray((parsed as {data?: unknown}).data)
    ? (parsed as {data: unknown[]}).data
    : Array.isArray(parsed) ? parsed : [];
  return data.flatMap((value) => {
    if (!value || typeof value !== 'object' || typeof (value as {id?: unknown}).id !== 'string') return [];
    const item = value as {id: string; owned_by?: unknown; ownedBy?: unknown; context_length?: unknown; contextLength?: unknown};
    const contextLength = typeof item.context_length === 'number'
      ? item.context_length
      : typeof item.contextLength === 'number' ? item.contextLength : undefined;
    return [{
      id: item.id,
      ...(typeof item.owned_by === 'string' ? {ownedBy: item.owned_by} : typeof item.ownedBy === 'string' ? {ownedBy: item.ownedBy} : {}),
      ...(contextLength !== undefined ? {contextLength} : {}),
    }];
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function defaultConnectionApiKey(provider: AgentConnectionConfig['provider'], environment: NodeJS.ProcessEnv): string | undefined {
  if (provider === 'openai') return environment.OPENAI_API_KEY;
  if (provider === 'compatible') return environment.SKEIN_API_KEY ?? environment.MOSAIC_API_KEY;
  return undefined;
}
