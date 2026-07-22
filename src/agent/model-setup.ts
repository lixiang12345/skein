import type {AgentConnectionConfig, AgentTeamConfig, ProviderName} from '../types.js';

export interface AgentConnectionSetupInput {
  name: string;
  provider: ProviderName;
  baseUrl?: string;
  apiKeyEnv?: string;
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
  const baseUrl = input.baseUrl?.trim() || undefined;
  if (input.provider === 'compatible' && !baseUrl) {
    throw new Error('OpenAI-compatible connections require a base URL.');
  }
  if (baseUrl) {
    let protocol: string;
    try {
      protocol = new URL(baseUrl).protocol;
    } catch {
      throw new Error('Connection base URL must be a valid http or https URL.');
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error('Connection base URL must use http or https.');
    }
  }
  const apiKeyEnv = input.apiKeyEnv?.trim() || undefined;
  if (apiKeyEnv && !/^[A-Z][A-Z0-9_]{0,127}$/.test(apiKeyEnv)) {
    throw new Error('Credential environment variable must use uppercase letters, numbers, and underscores.');
  }
  return {
    defaultConnection: name,
    defaultModel,
    connections: {
      [name]: {
        provider: input.provider,
        ...(baseUrl ? {baseUrl} : {}),
        ...(apiKeyEnv ? {apiKeyEnv} : {}),
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
