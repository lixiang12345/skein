import type {AgentModelRoute, AgentTeamConfig, ModelConfig} from '../types.js';

export type AgentRouteSource = 'profile' | 'default' | 'parent';

export interface ResolvedAgentRoute {
  route?: AgentModelRoute;
  source: AgentRouteSource;
}

/** Resolve profile overrides without materializing credentials. */
export function resolveAgentModelRoute(
  team: AgentTeamConfig | undefined,
  parent: ModelConfig,
  profile: string,
): ResolvedAgentRoute {
  const configured = team?.routes?.[profile];
  const hasDefaults = team?.defaultConnection !== undefined || team?.defaultModel !== undefined;
  if (!configured && !hasDefaults) return {source: 'parent'};

  const connection = configured?.connection ?? (configured?.provider ? undefined : team?.defaultConnection);
  const route: AgentModelRoute = {
    ...configured,
    model: configured?.model ?? team?.defaultModel ?? parent.model,
    ...(connection ? {connection} : {}),
  };
  if (!route.connection && !route.provider) route.provider = parent.provider;
  return {route, source: configured ? 'profile' : 'default'};
}
