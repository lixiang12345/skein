import type {
  AgentCapabilityConfig,
  AgentModelRoute,
  ConnectionProtocol,
  MosaicConfig,
  ProviderName,
} from '../types.js';
import {createDefaultToolRegistry} from '../tools/index.js';
import {canonicalJson} from '../utils/canonical-json.js';
import {resolveExecutableRuntime} from '../utils/process.js';
import {isOfficialProviderEndpoint} from './connection-catalog.js';
import type {AgentProfile} from './profiles.js';
import {
  capabilitySha256,
  capabilityRouteFingerprint,
  DEFAULT_CAPABILITY_HALF_LIFE_DAYS,
  type CapabilityObservationAggregate,
  type CapabilityRegistrySnapshot,
  type CapabilityRouteEpochInput,
} from './capability-registry.js';
import {resolveAgentModelRoute} from './model-route.js';
import {
  capabilityRouteHealthIntegrityValid,
  type CapabilityHealthFailure,
  type CapabilityHealthStatus,
} from './capability-health.js';

export const DEFAULT_CAPABILITY_MINIMUM_SAMPLES = 5;

export interface CapabilityRouteCandidate extends CapabilityRouteEpochInput {
  ref: string;
  aliases: string[];
  current: boolean;
  runtime: NonNullable<AgentModelRoute['runtime']>;
  connection?: string;
  provider: ProviderName;
  protocol: ConnectionProtocol;
  model: string;
  endpointSha256: string;
  authReferenceSha256: string;
  modelSha256: string;
  promptSha256: string;
  toolCatalogSha256: string;
  generationSha256: string;
  eligible: boolean;
  ineligibleReasons: string[];
}

export interface CapabilityInterval {
  mean: number;
  lower: number;
  upper: number;
  samples: number;
}

export interface CapabilityCandidateScore extends CapabilityRouteCandidate {
  epoch: number;
  health: CapabilityHealthStatus;
  healthFailure?: CapabilityHealthFailure;
  healthSignals: number;
  recoveryCanaryPasses: number;
  configured?: CapabilityInterval;
  observed?: CapabilityInterval & {
    status: 'unobserved' | 'uncertain' | 'calibrated';
    averageTokens: number;
    averageLatencyMs: number;
    toolFailureRate: number;
  };
  conservative: CapabilityInterval;
  utility: number;
}

export interface CapabilityShadowReport {
  schemaVersion: 2;
  mode: 'off' | 'shadow';
  profile: string;
  taskFingerprintSha256: string;
  current: string;
  suggested: string;
  changed: boolean;
  pinned: 'none' | 'active' | 'stale' | 'ineligible';
  reason: string;
  candidates: CapabilityCandidateScore[];
}

export interface CapabilityCandidateOptions {
  config: MosaicConfig;
  profile: AgentProfile;
  environment?: NodeJS.ProcessEnv;
  externalRuntimeAvailable?: (runtime: 'codex' | 'claude' | 'grok') => boolean | Promise<boolean>;
}

/** Build a privacy-safe candidate set without changing the live route resolver. */
export async function buildCapabilityCandidates(
  options: CapabilityCandidateOptions,
): Promise<CapabilityRouteCandidate[]> {
  const team = options.config.agents;
  const parent = options.config.model;
  const environment = options.environment ?? process.env;
  const taskFingerprintSha256 = taskFingerprint(options.profile);
  const promptSha256 = promptFingerprint(options.profile);
  const toolCatalogSha256 = toolCatalogFingerprint(options.config, options.profile);
  const currentRef = team?.routes?.[options.profile.name]
    ? options.profile.name
    : team?.defaultConnection !== undefined || team?.defaultModel !== undefined
      ? '@default'
      : '@parent';
  const refs = [
    '@parent',
    ...(team?.defaultConnection !== undefined || team?.defaultModel !== undefined ? ['@default'] : []),
    ...Object.keys(team?.routes ?? {}).sort(),
  ];
  if (!refs.includes(currentRef)) refs.push(currentRef);
  const resolved = await Promise.all(refs.map(async (ref) => {
    const materialized = materializeRoute(options.config, ref);
    const runtime = materialized.runtime;
    const ineligibleReasons = routeIneligibleReasons({
      config: options.config,
      profile: options.profile,
      route: materialized,
      environment,
    });
    if (runtime !== 'api' && !ineligibleReasons.length) {
      const available = options.externalRuntimeAvailable
        ? await options.externalRuntimeAvailable(runtime)
        : Boolean(await resolveExecutableRuntime(runtime, options.config.workspaceRoots[0] ?? process.cwd(), options.config.workspaceRoots));
      if (!available) ineligibleReasons.push(`${runtime} runtime is not installed outside the workspace`);
    }
    const endpointSha256 = capabilitySha256(`endpoint\0${materialized.endpointIdentity}`);
    const authReferenceSha256 = capabilitySha256(`auth-reference\0${materialized.authReference}`);
    const modelSha256 = capabilitySha256(canonicalJson({
      version: 1,
      runtime,
      provider: materialized.provider,
      protocol: materialized.protocol,
      model: materialized.model,
    }));
    const routeIdentitySha256 = capabilitySha256(canonicalJson({
      version: 2,
      logicalRoute: ref,
    }));
    const generationSha256 = capabilitySha256(canonicalJson({
      version: 1,
      temperature: materialized.route.temperature ?? null,
      maxTokens: materialized.route.maxTokens ?? null,
      tokenBudget: materialized.route.tokenBudget ?? null,
      maxToolCalls: materialized.route.maxToolCalls ?? null,
      timeoutMs: materialized.route.timeoutMs ?? null,
      budgetMode: materialized.route.budgetMode ?? team?.budgetMode ?? 'observe',
    }));
    const components = {
      modelSha256,
      endpointSha256,
      authSha256: authReferenceSha256,
      promptSha256,
      toolCatalogSha256,
      generationSha256,
    };
    const routeFingerprintSha256 = capabilityRouteFingerprint({routeIdentitySha256, components});
    return {
      ref,
      aliases: [ref],
      current: ref === currentRef,
      runtime,
      ...(materialized.connection ? {connection: materialized.connection} : {}),
      provider: materialized.provider,
      protocol: materialized.protocol,
      model: materialized.model,
      endpointSha256,
      authReferenceSha256,
      modelSha256,
      promptSha256,
      toolCatalogSha256,
      generationSha256,
      taskFingerprintSha256,
      routeIdentitySha256,
      routeFingerprintSha256,
      components,
      eligible: ineligibleReasons.length === 0,
      ineligibleReasons,
    } satisfies CapabilityRouteCandidate;
  }));
  return deduplicateCandidates(resolved, currentRef);
}

export function evaluateCapabilityShadow(input: {
  config: MosaicConfig;
  profile: AgentProfile;
  candidates: CapabilityRouteCandidate[];
  registry: CapabilityRegistrySnapshot;
  now?: Date;
}): CapabilityShadowReport {
  if (!input.candidates.length) throw new Error(`No capability routes are configured for ${input.profile.name}.`);
  const capability = input.config.agents?.capability;
  const mode = capability?.mode ?? 'shadow';
  const halfLifeDays = capability?.halfLifeDays ?? DEFAULT_CAPABILITY_HALF_LIFE_DAYS;
  const minimumSamples = capability?.minimumSamples ?? DEFAULT_CAPABILITY_MINIMUM_SAMPLES;
  const now = input.now ?? new Date();
  const scores = input.candidates.map((candidate) => scoreCandidate({
    candidate,
    taskProfile: input.profile.name,
    capability,
    registry: input.registry,
    halfLifeDays,
    minimumSamples,
    now,
  }));
  normalizeUtilities(scores);
  const current = scores.find((candidate) => candidate.current) ?? scores[0] as CapabilityCandidateScore;
  const pin = input.registry.pins.find((entry) => entry.taskFingerprintSha256 === current.taskFingerprintSha256);
  let pinned: CapabilityShadowReport['pinned'] = 'none';
  let suggested = current;
  let reason: string;
  if (mode === 'off') {
    reason = 'Capability routing is disabled; current static route retained.';
  } else if (pin) {
    const pinnedCandidate = scores.find((candidate) => candidate.routeFingerprintSha256 === pin.routeFingerprintSha256);
    if (!pinnedCandidate) {
      pinned = 'stale';
      reason = 'Pinned route fingerprint is stale after a route epoch change; current static route retained.';
    } else if (!pinnedCandidate.eligible) {
      pinned = 'ineligible';
      reason = 'Pinned route no longer satisfies hard constraints; current static route retained.';
    } else {
      pinned = 'active';
      suggested = pinnedCandidate;
      reason = `Pinned shadow route ${pinnedCandidate.ref} selected.`;
    }
  } else {
    const eligible = scores.filter((candidate) => candidate.eligible).sort(compareScores);
    suggested = eligible[0] ?? current;
    const status = suggested.observed?.status ?? 'unobserved';
    reason = eligible.length
      ? `Conservative shadow utility selected ${suggested.ref}; observed evidence is ${status}.`
      : 'No candidate satisfies hard constraints; current static route retained.';
  }
  return {
    schemaVersion: 2,
    mode,
    profile: input.profile.name,
    taskFingerprintSha256: current.taskFingerprintSha256,
    current: current.ref,
    suggested: suggested.ref,
    changed: suggested.routeFingerprintSha256 !== current.routeFingerprintSha256,
    pinned,
    reason,
    candidates: scores.sort((left, right) => left.ref.localeCompare(right.ref)),
  };
}

function materializeRoute(config: MosaicConfig, ref: string): {
  route: AgentModelRoute;
  runtime: NonNullable<AgentModelRoute['runtime']>;
  connection?: string;
  provider: ProviderName;
  protocol: ConnectionProtocol;
  model: string;
  endpointIdentity: string;
  authReference: string;
} {
  const team = config.agents;
  if (ref === '@parent') {
    return {
      route: {
        provider: config.model.provider,
        model: config.model.model,
        ...(config.model.baseUrl ? {baseUrl: config.model.baseUrl} : {}),
      },
      runtime: 'api',
      provider: config.model.provider,
      protocol: config.model.protocol ?? defaultProtocol(config.model.provider),
      model: config.model.model,
      endpointIdentity: config.model.baseUrl ?? `provider-default:${config.model.provider}`,
      authReference: `${config.model.apiKey ? 'parent-runtime-key' : `provider-default:${config.model.provider}`}` +
        `:${config.model.apiKeyHeader ?? 'provider-default-header'}`,
    };
  }
  const resolved = ref === '@default'
    ? resolveAgentModelRoute(team ? {...team, routes: {}} : undefined, config.model, '__capability_default__')
    : resolveAgentModelRoute(team, config.model, ref);
  const route = resolved.route ?? {provider: config.model.provider, model: config.model.model};
  const connection = route.connection ? team?.connections?.[route.connection] : undefined;
  const provider = route.provider ?? connection?.provider ?? config.model.provider;
  const protocol = connection?.protocol ?? defaultProtocol(provider);
  const baseUrl = route.baseUrl ?? connection?.baseUrl;
  const authReference = route.apiKeyEnv
    ? `env:${route.apiKeyEnv}:bearer`
    : connection?.auth?.type === 'env'
      ? `env:${connection.auth.name}:${connection.auth.header ?? 'bearer'}`
      : connection?.apiKeyEnv
        ? `env:${connection.apiKeyEnv}:bearer`
        : connection?.auth?.type === 'none'
          ? 'none'
          : `provider-default:${provider}`;
  return {
    route,
    runtime: route.runtime ?? 'api',
    ...(route.connection ? {connection: route.connection} : {}),
    provider,
    protocol,
    model: route.model ?? config.model.model,
    endpointIdentity: baseUrl ?? `provider-default:${provider}`,
    authReference,
  };
}

function routeIneligibleReasons(input: {
  config: MosaicConfig;
  profile: AgentProfile;
  route: ReturnType<typeof materializeRoute>;
  environment: NodeJS.ProcessEnv;
}): string[] {
  const reasons: string[] = [];
  const {profile, route, config, environment} = input;
  if (!route.model.trim()) reasons.push('model is not configured');
  if (!profile.readOnly && route.runtime !== 'api' && route.runtime !== 'claude') {
    reasons.push('external writer profiles currently require the Claude runtime');
  }
  if (!profile.readOnly && route.runtime === 'claude' &&
      route.route.costBudgetUsd === undefined && config.agents?.maxAgentCostUsd === undefined) {
    reasons.push('external Claude writers require an explicit USD cost budget');
  }
  if (!profile.readOnly && profile.source === 'workspace') reasons.push('workspace-authored profiles cannot receive writer authority');
  const connection = route.connection ? config.agents?.connections?.[route.connection] : undefined;
  const explicitEnv = route.route.apiKeyEnv ?? connection?.apiKeyEnv ??
    (connection?.auth?.type === 'env' ? connection.auth.name : undefined);
  if (route.runtime === 'claude') {
    if (route.connection && !connection) reasons.push('named connection is unavailable');
    if (explicitEnv && !environment[explicitEnv]) reasons.push(`credential environment ${explicitEnv} is not set`);
    return reasons;
  }
  if (route.runtime !== 'api') return reasons;
  if (route.connection && !connection) reasons.push('named connection is unavailable');
  const baseUrl = route.route.baseUrl ?? connection?.baseUrl;
  if (route.provider === 'compatible' && !baseUrl) reasons.push('compatible API route has no base URL');
  if (explicitEnv && !environment[explicitEnv]) reasons.push(`credential environment ${explicitEnv} is not set`);
  if (connection?.auth?.type === 'none') return reasons;
  if (explicitEnv) return reasons;
  const inheritsParent = route.provider === config.model.provider && baseUrl === config.model.baseUrl && Boolean(config.model.apiKey);
  if (inheritsParent || (route.provider === 'compatible' && baseUrl && isLoopback(baseUrl))) return reasons;
  if (route.provider !== 'compatible' && baseUrl &&
    !isOfficialProviderEndpoint(route.provider, baseUrl)) {
    reasons.push('custom provider endpoint requires explicit connection auth');
    return reasons;
  }
  const defaultKey = providerEnvironmentKey(route.provider).some((name) => Boolean(environment[name]));
  if (!defaultKey && !(route.provider === config.model.provider && config.model.apiKey)) {
    reasons.push(`${route.provider} credential is not configured`);
  }
  return reasons;
}

function taskFingerprint(profile: AgentProfile): string {
  return capabilitySha256(canonicalJson({
    version: 1,
    profile: profile.name,
    role: profile.readOnly ? 'reader' : 'writer',
    source: profile.source,
  }));
}

function promptFingerprint(profile: AgentProfile): string {
  return capabilitySha256(canonicalJson({
    version: 1,
    prompt: profile.prompt,
    readOnly: profile.readOnly,
    maxTurns: profile.maxTurns,
    source: profile.source,
  }));
}

function toolCatalogFingerprint(config: MosaicConfig, profile: AgentProfile): string {
  const allowed = profile.tools ? new Set(profile.tools) : undefined;
  const writerNames = new Set(['read_file', 'list_files', 'search_code', 'write_file', 'apply_patch']);
  const builtIn = createDefaultToolRegistry().definitions().filter((definition) => {
    if (profile.readOnly && definition.category !== 'read') return false;
    if (!profile.readOnly && !writerNames.has(definition.name)) return false;
    return !allowed || allowed.has(definition.name);
  }).map((definition) => ({
    name: definition.name,
    category: definition.category,
    inputSchema: definition.inputSchema,
    completionEvidence: definition.completionEvidence ?? 'none',
    humanApproval: definition.humanApproval ?? false,
  }));
  const mcp = profile.readOnly && config.mcp?.enabled
    ? Object.entries(config.mcp.servers).flatMap(([server, value]) => value.enabled === false
      ? []
      : (value.tools ?? []).filter((tool) => !allowed || allowed.has(tool.name)).map((tool) => ({
        server,
        version: value.version ?? 'unversioned',
        toolPrefix: value.toolPrefix ?? null,
        tool: {
          ...tool,
          permissions: [...tool.permissions].sort(),
          network: [...(tool.network ?? [])].sort(),
          commands: [...(tool.commands ?? [])].sort(),
          paths: [...(tool.paths ?? [])].sort(),
          sensitiveFields: [...(tool.sensitiveFields ?? [])].sort(),
          completionEvidence: tool.completionEvidence ?? 'none',
        },
      })))
    : [];
  return capabilitySha256(canonicalJson({version: 1, builtIn, mcp}));
}

function deduplicateCandidates(candidates: CapabilityRouteCandidate[], currentRef: string): CapabilityRouteCandidate[] {
  const byFingerprint = new Map<string, CapabilityRouteCandidate>();
  for (const candidate of candidates) {
    const existing = byFingerprint.get(candidate.routeFingerprintSha256);
    if (!existing) {
      byFingerprint.set(candidate.routeFingerprintSha256, candidate);
      continue;
    }
    const aliases = [...new Set([...existing.aliases, candidate.ref])].sort();
    const preferred = candidate.ref === currentRef ? candidate : existing;
    byFingerprint.set(candidate.routeFingerprintSha256, {
      ...preferred,
      aliases,
      current: existing.current || candidate.current,
    });
  }
  return [...byFingerprint.values()].sort((left, right) => left.ref.localeCompare(right.ref));
}

function scoreCandidate(input: {
  candidate: CapabilityRouteCandidate;
  taskProfile: string;
  capability: AgentCapabilityConfig | undefined;
  registry: CapabilityRegistrySnapshot;
  halfLifeDays: number;
  minimumSamples: number;
  now: Date;
}): CapabilityCandidateScore {
  const epoch = input.registry.epochs.find((entry) =>
    entry.taskFingerprintSha256 === input.candidate.taskFingerprintSha256 &&
    entry.routeFingerprintSha256 === input.candidate.routeFingerprintSha256)?.epoch ?? 1;
  const prior = configuredPrior(input.capability, input.taskProfile, input.candidate);
  const configured = prior && prior.strength > 0
    ? wilson(prior.successRate * prior.strength, (1 - prior.successRate) * prior.strength)
    : undefined;
  const aggregate = input.registry.observations.find((entry) =>
    entry.taskFingerprintSha256 === input.candidate.taskFingerprintSha256 &&
    entry.routeFingerprintSha256 === input.candidate.routeFingerprintSha256);
  const decayed = aggregate ? decayForRead(aggregate, input.now, input.halfLifeDays) : undefined;
  const observed = decayed && decayed.samples > 0
    ? {
      ...wilson(decayed.verifiedSuccess, decayed.verifiedFailure),
      status: decayed.samples >= input.minimumSamples ? 'calibrated' as const : 'uncertain' as const,
      averageTokens: decayed.tokenTotal / decayed.samples,
      averageLatencyMs: decayed.latencyMsTotal / decayed.samples,
      toolFailureRate: Math.min(1, decayed.toolFailures / decayed.samples),
    }
    : undefined;
  const configuredSuccess = prior ? prior.successRate * prior.strength : 0;
  const configuredFailure = prior ? (1 - prior.successRate) * prior.strength : 0;
  const conservative = wilson(
    configuredSuccess + (decayed?.verifiedSuccess ?? 0),
    configuredFailure + (decayed?.verifiedFailure ?? 0),
  );
  const health = input.registry.health.find((entry) =>
    entry.taskFingerprintSha256 === input.candidate.taskFingerprintSha256 &&
    entry.routeFingerprintSha256 === input.candidate.routeFingerprintSha256);
  if (health && !capabilityRouteHealthIntegrityValid(health)) {
    throw new Error('Capability route health integrity check failed.');
  }
  const quarantined = health?.status === 'quarantined';
  return {
    ...input.candidate,
    eligible: input.candidate.eligible && !quarantined,
    ineligibleReasons: quarantined
      ? [...input.candidate.ineligibleReasons, 'route is quarantined pending recovery canaries']
      : input.candidate.ineligibleReasons,
    epoch,
    health: health?.status ?? 'healthy',
    ...(health?.lastFailure ? {healthFailure: health.lastFailure} : {}),
    healthSignals: health?.signals ?? 0,
    recoveryCanaryPasses: health?.recoveryCanaryPasses ?? 0,
    ...(configured ? {configured} : {}),
    ...(observed ? {observed} : {}),
    conservative,
    utility: conservative.lower,
  };
}

function configuredPrior(
  capability: AgentCapabilityConfig | undefined,
  taskProfile: string,
  candidate: CapabilityRouteCandidate,
): {successRate: number; strength: number} | undefined {
  const priors = capability?.priors?.[taskProfile];
  if (!priors) return undefined;
  for (const ref of [candidate.ref, ...candidate.aliases]) {
    const prior = priors[ref];
    if (prior) return prior;
  }
  return undefined;
}

function decayForRead(
  aggregate: CapabilityObservationAggregate,
  now: Date,
  halfLifeDays: number,
): CapabilityObservationAggregate['decayed'] {
  const elapsedMs = Math.max(0, now.getTime() - Date.parse(aggregate.decayed.updatedAt));
  const factor = Math.exp(-Math.LN2 * elapsedMs / (halfLifeDays * 86_400_000));
  return {
    samples: aggregate.decayed.samples * factor,
    verifiedSuccess: aggregate.decayed.verifiedSuccess * factor,
    verifiedFailure: aggregate.decayed.verifiedFailure * factor,
    tokenTotal: aggregate.decayed.tokenTotal * factor,
    latencyMsTotal: aggregate.decayed.latencyMsTotal * factor,
    toolFailures: aggregate.decayed.toolFailures * factor,
    updatedAt: now.toISOString(),
  };
}

function wilson(success: number, failure: number): CapabilityInterval {
  const samples = Math.max(0, success + failure);
  if (!samples) return {mean: 0.5, lower: 0, upper: 1, samples: 0};
  const mean = success / samples;
  const z = 1.959963984540054;
  const denominator = 1 + z * z / samples;
  const centre = mean + z * z / (2 * samples);
  const margin = z * Math.sqrt((mean * (1 - mean) + z * z / (4 * samples)) / samples);
  return {
    mean,
    lower: Math.max(0, (centre - margin) / denominator),
    upper: Math.min(1, (centre + margin) / denominator),
    samples,
  };
}

function normalizeUtilities(scores: CapabilityCandidateScore[]): void {
  const maxTokens = Math.max(0, ...scores.map((score) => score.observed?.averageTokens ?? 0));
  const maxLatency = Math.max(0, ...scores.map((score) => score.observed?.averageLatencyMs ?? 0));
  for (const score of scores) {
    const tokenPenalty = maxTokens ? (score.observed?.averageTokens ?? 0) / maxTokens * 0.03 : 0;
    const latencyPenalty = maxLatency ? (score.observed?.averageLatencyMs ?? 0) / maxLatency * 0.03 : 0;
    const toolPenalty = (score.observed?.toolFailureRate ?? 0) * 0.05;
    const healthPenalty = score.health === 'degraded' ? 0.15 : 0;
    score.utility = score.eligible
      ? score.conservative.lower - tokenPenalty - latencyPenalty - toolPenalty - healthPenalty
      : Number.NEGATIVE_INFINITY;
  }
}

function compareScores(left: CapabilityCandidateScore, right: CapabilityCandidateScore): number {
  if (right.utility !== left.utility) return right.utility - left.utility;
  if (left.current !== right.current) return left.current ? -1 : 1;
  return left.ref.localeCompare(right.ref);
}

function defaultProtocol(provider: ProviderName): ConnectionProtocol {
  if (provider === 'anthropic') return 'anthropic-messages';
  if (provider === 'gemini') return 'gemini';
  return 'openai-chat';
}

function providerEnvironmentKey(provider: ProviderName): string[] {
  if (provider === 'anthropic') return ['ANTHROPIC_API_KEY'];
  if (provider === 'gemini') return ['GEMINI_API_KEY'];
  if (provider === 'compatible') return ['SKEIN_API_KEY', 'MOSAIC_API_KEY'];
  return ['OPENAI_API_KEY'];
}

function isLoopback(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' ||
      /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  } catch {
    return false;
  }
}
