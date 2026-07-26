import type {
  AgentConnectionConfig,
  AgentTeamConfig,
  ConnectionApiKeyHeader,
  ConnectionAuth,
  ConnectionModelAuth,
  ConnectionProtocol,
  ProviderHostedTool,
  ProviderName,
  RouteTokenPricing,
} from '../types.js';

export interface AgentConnectionSetupInput {
  name: string;
  provider: ProviderName;
  protocol?: ConnectionProtocol;
  baseUrl?: string;
  modelsBaseUrl?: string;
  auth?: ConnectionAuth['type'];
  authHeader?: ConnectionApiKeyHeader;
  modelsAuthHeader?: ConnectionModelAuth;
  apiKeyEnv?: string;
  hostedTools?: ProviderHostedTool[];
  pricing?: RouteTokenPricing;
  defaultModel: string;
}

export interface AgentConnectionSetupPatch {
  defaultConnection: string;
  defaultModel: string;
  connections: Record<string, AgentConnectionConfig>;
}

export function createAgentConnectionSetup(input: AgentConnectionSetupInput): AgentConnectionSetupPatch {
  const name = input.name.trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) {
    throw new Error('Connection name must start with a lowercase letter and use only lowercase letters, numbers, _ or -.');
  }
  const defaultModel = input.defaultModel.trim();
  if (!defaultModel || defaultModel.length > 256) {
    throw new Error('Default model must contain between 1 and 256 characters.');
  }
  if (input.provider !== 'compatible') {
    throw new Error('Named primary connections support third-party compatible relays only.');
  }
  const protocol = input.protocol ?? 'openai-responses';
  if (protocol === 'gemini') throw new Error('Relay protocol must use openai-responses, openai-chat, or anthropic-messages.');
  const hostedTools = [...new Set(input.hostedTools ?? [])];
  if (hostedTools.some((tool) => tool !== 'web_search')) {
    throw new Error('Only the web_search provider-hosted tool is supported.');
  }
  if (hostedTools.length && protocol !== 'openai-responses') {
    throw new Error('Provider-hosted tools require the openai-responses protocol.');
  }
  if (input.pricing && Object.values(input.pricing).some((value) =>
    value !== undefined && (!Number.isFinite(value) || value < 0))) {
    throw new Error('Relay token prices must be finite, non-negative USD amounts per million tokens.');
  }
  const baseUrl = input.baseUrl?.trim() || undefined;
  if (!baseUrl) throw new Error('Compatible relay connections require an inference base URL.');
  const modelsBaseUrl = input.modelsBaseUrl?.trim() || undefined;
  if (protocol === 'anthropic-messages' && !modelsBaseUrl) {
    throw new Error('Anthropic relay connections require a separate models base URL.');
  }
  for (const [label, value] of [['Connection base URL', baseUrl], ['Models base URL', modelsBaseUrl]] as const) {
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${label} must be a valid http or https URL.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`${label} must use http or https.`);
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error(`${label} cannot contain credentials, query parameters, or fragments.`);
    }
  }
  const apiKeyEnv = input.apiKeyEnv?.trim() || undefined;
  if (apiKeyEnv && !/^[A-Z][A-Z0-9_]{0,127}$/.test(apiKeyEnv)) {
    throw new Error('Credential environment variable must use uppercase letters, numbers, and underscores.');
  }
  const auth = input.auth ?? (apiKeyEnv ? 'env' : 'none');
  if (auth === 'env' && !apiKeyEnv) {
    throw new Error('Environment authentication requires a credential environment variable.');
  }
  if (auth === 'none' && apiKeyEnv) {
    throw new Error('Unauthenticated connections cannot include a credential environment variable.');
  }
  if (auth === 'none' && (input.authHeader || (input.modelsAuthHeader && input.modelsAuthHeader !== 'none'))) {
    throw new Error('Unauthenticated connections cannot include credential header settings.');
  }
  return {
    defaultConnection: name,
    defaultModel,
    connections: {
      [name]: {
        provider: input.provider,
        protocol,
        defaultModel,
        baseUrl,
        ...(modelsBaseUrl ? {modelsBaseUrl} : {}),
        ...(input.modelsAuthHeader ? {modelsAuthHeader: input.modelsAuthHeader} : {}),
        ...(hostedTools.length ? {hostedTools} : {}),
        ...(input.pricing ? {pricing: input.pricing} : {}),
        auth: auth === 'env'
          ? {type: 'env', name: apiKeyEnv as string, ...(input.authHeader ? {header: input.authHeader} : {})}
          : {type: 'none'},
      },
    },
  };
}

export function mergeAgentSetup(
  existing: Partial<AgentTeamConfig> | undefined,
  setup: AgentConnectionSetupPatch,
): Partial<AgentTeamConfig> {
  return {
    ...existing,
    ...setup,
    connections: {...existing?.connections, ...setup.connections},
  };
}
