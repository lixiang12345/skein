import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {lstat, mkdir, readFile, realpath} from 'node:fs/promises';
import {parse as parseYaml} from 'yaml';
import {z} from 'zod';
import {defaultMemoryPath} from './memory/store.js';
import type {
  AgentCapabilityConfig,
  AgentTeamConfig,
  McpConfig,
  MemoryConfig,
  ModelConfig,
  MosaicConfig,
  PermissionConfig,
  ProviderName,
  SkillConfig,
} from './types.js';
import {atomicWrite} from './tools/write.js';
import {assertNoSymlinkPath, ensureWorkspaceStorageDirectory} from './utils/storage.js';
import {isInside} from './utils/path.js';
import {preferredEnv} from './brand.js';
import {
  assertActiveHomeNamespacePath,
  homeNamespacePaths,
  projectNamespacePaths,
  resolveHomeNamespace,
  resolveProjectNamespaceSync,
} from './utils/namespace.js';
import {withNamespaceLease} from './utils/namespace-lease.js';

const permissionSchema = z.enum(['allow', 'ask', 'deny']);

const uiPreferenceSchema = z.object({
  theme: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
  compact: z.boolean().optional(),
}).strict().refine((value) => value.theme !== undefined || value.compact !== undefined, {
  message: 'At least one UI preference is required.',
});

const skillConfigSchema = z.object({
  enabled: z.boolean().optional(),
  directories: z.array(z.string()).optional(),
  autoActivate: z.boolean().optional(),
  maxActive: z.number().int().positive().max(32).optional(),
  maxCharsPerSkill: z.number().int().positive().max(200_000).optional(),
}).partial();

const memoryConfigSchema = z.object({
  enabled: z.boolean().optional(),
  databasePath: z.string().optional(),
  retrievalLimit: z.number().int().positive().max(100).optional(),
  maxPromptTokens: z.number().int().positive().max(20_000).optional(),
}).partial();

const agentConnectionNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const agentProfileNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const capabilityRouteReferenceSchema = z.union([
  agentProfileNameSchema,
  z.enum(['@parent', '@default']),
]);
const connectionAuthSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('env'), name: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)}).strict(),
  z.object({type: z.literal('none')}).strict(),
]);
const connectionUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return /^https?:$/i.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, {
  message: 'connection URL must use http or https without credentials, query parameters, or fragments',
});
const agentConnectionSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'gemini', 'compatible']),
  label: z.string().min(1).max(128).optional(),
  protocol: z.enum(['openai-responses', 'openai-chat', 'anthropic-messages', 'gemini']).optional(),
  baseUrl: connectionUrlSchema.optional(),
  modelsBaseUrl: connectionUrlSchema.optional(),
  defaultModel: z.string().min(1).max(256).optional(),
  auth: connectionAuthSchema.optional(),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).optional(),
}).strict().refine((value) => !(value.auth && value.apiKeyEnv), {
  message: 'agent connection auth and apiKeyEnv are mutually exclusive',
});

const agentTeamConfigSchema = z.object({
  enabled: z.boolean().optional(),
  maxConcurrent: z.number().int().positive().max(16).optional(),
  maxDelegations: z.number().int().positive().max(32).optional(),
  defaultProfile: agentProfileNameSchema.optional(),
  defaultConnection: agentConnectionNameSchema.optional(),
  defaultModel: z.string().min(1).max(256).optional(),
  reviewerProfile: agentProfileNameSchema.optional(),
  maxReviewRounds: z.number().int().min(0).max(3).optional(),
  cockpit: z.boolean().optional(),
  persistBoard: z.boolean().optional(),
  maxAgentTokens: z.number().int().positive().max(1_000_000).optional(),
  maxAgentToolCalls: z.number().int().positive().max(1_000).optional(),
  agentTimeoutMs: z.number().int().positive().max(1_800_000).optional(),
  budgetMode: z.enum(['observe', 'guard', 'strict']).optional(),
  writerEnabled: z.boolean().optional(),
  writerProfile: agentProfileNameSchema.optional(),
  writerReviewerProfile: agentProfileNameSchema.optional(),
  maxWriterPatchBytes: z.number().int().positive().max(120_000).optional(),
  connections: z.record(agentConnectionNameSchema, agentConnectionSchema).optional(),
  routes: z.record(agentProfileNameSchema, z.object({
    runtime: z.enum(['api', 'codex', 'claude', 'grok']).optional(),
    connection: agentConnectionNameSchema.optional(),
    provider: z.enum(['openai', 'anthropic', 'gemini', 'compatible']).optional(),
    model: z.string().min(1).max(256).optional(),
    baseUrl: z.string().url().refine((value) => /^https?:$/i.test(new URL(value).protocol), {
      message: 'agent route baseUrl must use http or https',
    }).optional(),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(200_000).optional(),
    tokenBudget: z.number().int().positive().max(1_000_000).optional(),
    maxToolCalls: z.number().int().positive().max(1_000).optional(),
    timeoutMs: z.number().int().positive().max(1_800_000).optional(),
    budgetMode: z.enum(['observe', 'guard', 'strict']).optional(),
  }).strict()).optional(),
  capability: z.object({
    mode: z.enum(['off', 'shadow']).optional(),
    halfLifeDays: z.number().positive().min(1).max(365).optional(),
    minimumSamples: z.number().int().positive().max(1_000).optional(),
    priors: z.record(agentProfileNameSchema, z.record(capabilityRouteReferenceSchema, z.object({
      successRate: z.number().min(0).max(1),
      strength: z.number().min(0).max(1_000),
    }).strict())).optional(),
  }).strict().optional(),
}).partial();

const mcpServerSchema = z.object({
  enabled: z.boolean().optional(),
  required: z.boolean().optional(),
  transport: z.enum(['stdio', 'http']).optional(),
  description: z.string().min(1).max(500).optional(),
  version: z.string().min(1).max(128).optional(),
  tools: z.array(z.object({
    name: z.string().min(1).max(256),
    description: z.string().min(1).max(500).optional(),
    permissions: z.array(z.enum(['read', 'write', 'shell', 'git', 'network']))
      .min(1).max(5),
    network: z.array(z.string().min(1).max(500)).max(32).optional(),
    commands: z.array(z.string().min(1).max(500)).max(32).optional(),
    paths: z.array(z.string().min(1).max(4_000)).max(64).optional(),
    sensitiveFields: z.array(z.string().min(1).max(256)).max(64).optional(),
    background: z.boolean().optional(),
    processTree: z.boolean().optional(),
    completionEvidence: z.enum(['full', 'partial', 'none']).optional(),
  }).strict()).max(256).optional(),
  command: z.string().min(1).max(512).optional(),
  args: z.array(z.string().max(4_000)).max(64).optional(),
  cwd: z.string().max(4_000).optional(),
  env: z.record(z.string(), z.string().max(20_000)).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string().max(20_000)).optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  toolPrefix: z.string().regex(/^[a-z][a-z0-9_-]{0,24}$/).optional(),
}).strict().superRefine((server, context) => {
  const names = new Set<string>();
  for (const [index, tool] of (server.tools ?? []).entries()) {
    if (names.has(tool.name)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tools', index, 'name'],
        message: `duplicate MCP capability tool: ${tool.name}`,
      });
    }
    names.add(tool.name);
    if (tool.permissions.includes('shell') && !tool.commands?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tools', index, 'commands'],
        message: 'MCP shell capability must declare command scopes',
      });
    }
    if (tool.permissions.includes('write') && !tool.paths?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tools', index, 'paths'],
        message: 'MCP write capability must declare path scopes',
      });
    }
  }
});

const mcpConfigSchema = z.object({
  enabled: z.boolean().optional(),
  connectTimeoutMs: z.number().int().positive().max(300_000).optional(),
  toolTimeoutMs: z.number().int().positive().max(300_000).optional(),
  servers: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), mcpServerSchema).optional(),
}).partial();

const partialConfigSchema = z.object({
  model: z.object({
    provider: z.enum(['openai', 'anthropic', 'gemini', 'compatible']).optional(),
    model: z.string().optional(),
    apiKey: z.string().optional(),
    baseUrl: z.string().url().refine((value) => /^https?:$/i.test(new URL(value).protocol), {
      message: 'baseUrl must use http or https',
    }).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().positive().optional(),
  }).partial().optional(),
  workspaceRoots: z.array(z.string()).optional(),
  context: z.object({
    maxTokens: z.number().positive().optional(),
    topK: z.number().int().positive().optional(),
  }).partial().optional(),
  permissions: z.object({
    read: permissionSchema.optional(),
    write: permissionSchema.optional(),
    shell: permissionSchema.optional(),
    git: permissionSchema.optional(),
    network: permissionSchema.optional(),
    allowCommands: z.array(z.string()).optional(),
    denyCommands: z.array(z.string()).optional(),
  }).partial().optional(),
  hooks: z.object({
    beforeTool: z.array(z.string()).optional(),
    afterTool: z.array(z.string()).optional(),
    afterTurn: z.array(z.string()).optional(),
  }).partial().optional(),
  agent: z.object({
    maxTurns: z.number().int().positive().optional(),
    maxEpochTokens: z.number().int().positive().optional(),
    maxSessionTokens: z.number().int().positive().optional(),
    autoVerify: z.boolean().optional(),
    verifyCommands: z.array(z.string()).optional(),
    checkpointBeforeWrite: z.boolean().optional(),
  }).partial().optional(),
  ui: z.object({
    color: z.boolean().optional(),
    compact: z.boolean().optional(),
    theme: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
  }).partial().optional(),
  skills: skillConfigSchema.optional(),
  memory: memoryConfigSchema.optional(),
  agents: agentTeamConfigSchema.optional(),
  mcp: mcpConfigSchema.optional(),
}).partial();

type PartialConfig = z.infer<typeof partialConfigSchema>;
type AgentTeamConfigUpdate = NonNullable<PartialConfig['agents']>;
type AgentCapabilityConfigUpdate = NonNullable<AgentTeamConfigUpdate['capability']>;

const modelTrustRegistrySchema = z.object({
  version: z.literal(1),
  entries: z.array(z.object({
    workspace: z.string(),
    configPath: z.string(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    trustedAt: z.string(),
  }).strict()).max(500),
}).strict();

type ModelTrustRegistry = z.infer<typeof modelTrustRegistrySchema>;

const envKeysForProvider: Record<ProviderName, readonly string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
  compatible: ['SKEIN_API_KEY', 'MOSAIC_API_KEY'],
};

/** Preferred environment variable a user should set to supply a provider's API key. */
export function providerApiKeyEnv(provider: ProviderName): string {
  return envKeysForProvider[provider][0] as string;
}

export const defaultPermissions: PermissionConfig = {
  read: 'allow',
  write: 'ask',
  shell: 'ask',
  git: 'ask',
  network: 'ask',
  allowCommands: [
    'git status',
    'git diff',
    'git log',
    'npm test',
    'npm run test',
    'npm run typecheck',
    'npm run build',
  ],
  denyCommands: [
    'rm -rf /',
    'git reset --hard',
    'git clean -fd',
    'git checkout --',
    'sudo ',
  ],
};

export function defaultConfig(workspace = process.cwd()): MosaicConfig {
  const provider = parseProvider(preferredEnv('SKEIN_PROVIDER', 'MOSAIC_PROVIDER'));
  const model = preferredEnv('SKEIN_MODEL', 'MOSAIC_MODEL');
  const baseUrl = preferredEnv('SKEIN_BASE_URL', 'MOSAIC_BASE_URL');
  const apiKey = shouldUseProviderEnvironmentKey(provider, baseUrl)
    ? providerApiKey(provider)
    : undefined;
  return {
    model: {
      provider,
      model: model ?? defaultModelForProvider(provider),
      ...(apiKey ? {apiKey} : {}),
      ...(baseUrl ? {baseUrl} : {}),
      temperature: 0.2,
      maxTokens: 8192,
    },
    workspaceRoots: [resolve(workspace)],
    context: {
      maxTokens: 12_000,
      topK: 12,
    },
    permissions: {...defaultPermissions},
    hooks: {},
    agent: {
      maxTurns: 24,
      maxEpochTokens: 250_000,
      maxSessionTokens: 1_000_000,
      autoVerify: true,
      verifyCommands: [],
      checkpointBeforeWrite: true,
    },
    ui: {
      color: !process.env.NO_COLOR,
      compact: false,
      theme: 'auto',
    },
    skills: {
      enabled: true,
      directories: [],
      autoActivate: true,
      maxActive: 3,
      maxCharsPerSkill: 32_000,
    },
    memory: {
      enabled: true,
      retrievalLimit: 8,
      maxPromptTokens: 1_200,
    },
    agents: {
      enabled: true,
      maxConcurrent: 3,
      maxDelegations: 6,
      defaultProfile: 'reviewer',
      reviewerProfile: 'reviewer',
      maxReviewRounds: 1,
      cockpit: true,
      persistBoard: true,
      budgetMode: 'observe',
      writerEnabled: false,
      writerProfile: 'implementer',
      writerReviewerProfile: 'reviewer',
      maxWriterPatchBytes: 60_000,
      connections: {},
      routes: {},
      capability: {
        mode: 'shadow',
        halfLifeDays: 30,
        minimumSamples: 5,
        priors: {},
      },
    },
    mcp: {
      enabled: false,
      connectTimeoutMs: 12_000,
      toolTimeoutMs: 60_000,
      servers: {},
    },
  };
}

function parseProvider(value: string | undefined): ProviderName {
  if (value === 'anthropic' || value === 'gemini' || value === 'compatible' || value === 'openai') {
    return value;
  }
  return 'openai';
}

export function defaultModelForProvider(provider: ProviderName): string {
  switch (provider) {
    case 'anthropic': return 'claude-sonnet-4-5';
    case 'gemini': return 'gemini-2.5-pro';
    case 'compatible': return 'default';
    default: return 'gpt-5';
  }
}

export function resolveRuntimeModel(
  current: ModelConfig,
  overrides: {provider?: ProviderName; model?: string; baseUrl?: string},
  environment: NodeJS.ProcessEnv = process.env,
): ModelConfig {
  const provider = overrides.provider ?? current.provider;
  const providerChanged = provider !== current.provider;
  const baseUrlChanged = overrides.baseUrl !== undefined && overrides.baseUrl !== current.baseUrl;
  const transportChanged = providerChanged || baseUrlChanged;
  const {apiKey: _apiKey, baseUrl: _baseUrl, ...portable} = current;
  const inherited = transportChanged ? portable : current;
  const resolvedBaseUrl = overrides.baseUrl ?? (transportChanged ? undefined : current.baseUrl);
  const apiKey = transportChanged
    ? shouldUseProviderEnvironmentKey(provider, resolvedBaseUrl)
      ? providerApiKey(provider, environment)
      : undefined
    : current.apiKey ?? providerApiKey(provider, environment);
  return {
    ...inherited,
    provider,
    model: overrides.model ?? (providerChanged
      ? defaultModelForProvider(provider)
      : current.model),
    ...(apiKey ? {apiKey} : {}),
    ...(overrides.baseUrl ? {baseUrl: overrides.baseUrl} : {}),
  };
}

function mergeConfig(base: MosaicConfig, update: PartialConfig): MosaicConfig {
  const provider = update.model?.provider ?? base.model.provider;
  const model = update.model?.model ?? (
    update.model?.provider ? defaultModelForProvider(provider) : base.model.model
  );
  const providerChanged = update.model?.provider !== undefined &&
    update.model.provider !== base.model.provider;
  const baseUrlChanged = update.model?.baseUrl !== undefined &&
    update.model.baseUrl !== base.model.baseUrl;
  const {apiKey: _apiKey, baseUrl: _baseUrl, ...portableModel} = base.model;
  const inheritedModel = providerChanged || baseUrlChanged ? portableModel : base.model;
  return {
    ...base,
    ...update,
    model: {...inheritedModel, ...update.model, provider, model},
    context: {...base.context, ...update.context},
    permissions: {...base.permissions, ...update.permissions},
    hooks: {...base.hooks, ...update.hooks},
    agent: {...base.agent, ...update.agent},
    ui: {...base.ui, ...update.ui},
    skills: {...base.skills, ...update.skills} as SkillConfig,
    memory: {...base.memory, ...update.memory} as MemoryConfig,
    agents: mergeAgentConfig(base.agents, update.agents),
    mcp: {
      ...base.mcp,
      ...update.mcp,
      servers: {...base.mcp?.servers, ...update.mcp?.servers},
    } as McpConfig,
    workspaceRoots: update.workspaceRoots ?? base.workspaceRoots,
  } as MosaicConfig;
}

function mergeAgentConfig(
  base: AgentTeamConfig | AgentTeamConfigUpdate | undefined,
  update: AgentTeamConfigUpdate | undefined,
): AgentTeamConfig {
  const capability = mergeCapabilityConfig(base?.capability, update?.capability);
  return {
    ...base,
    ...update,
    ...(capability ? {capability} : {}),
  } as AgentTeamConfig;
}

function mergeCapabilityConfig(
  base: AgentCapabilityConfig | AgentCapabilityConfigUpdate | undefined,
  update: AgentCapabilityConfigUpdate | undefined,
): AgentCapabilityConfig | undefined {
  if (!base && !update) return undefined;
  const priors: NonNullable<AgentCapabilityConfig['priors']> = {};
  for (const [profile, configured] of Object.entries(base?.priors ?? {})) {
    priors[profile] = {...configured};
  }
  for (const [profile, configured] of Object.entries(update?.priors ?? {})) {
    priors[profile] = {...priors[profile], ...configured};
  }
  const mode = update?.mode ?? base?.mode;
  const halfLifeDays = update?.halfLifeDays ?? base?.halfLifeDays;
  const minimumSamples = update?.minimumSamples ?? base?.minimumSamples;
  return {
    ...(mode !== undefined ? {mode} : {}),
    ...(halfLifeDays !== undefined ? {halfLifeDays} : {}),
    ...(minimumSamples !== undefined ? {minimumSamples} : {}),
    ...(base?.priors !== undefined || update?.priors !== undefined ? {priors} : {}),
  };
}

async function readConfigFile(path: string): Promise<PartialConfig> {
  if (!existsSync(path)) return {};
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) return {};
  if (info.size > 1_000_000) throw new Error(`Configuration file is too large: ${path}`);
  const raw = await readFile(path, 'utf8');
  const value = path.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
  return partialConfigSchema.parse(value ?? {});
}

function mosaicHome(): string {
  return resolveHomeNamespace();
}

function modelTrustPath(home = mosaicHome()): string {
  return join(home, 'trusted-model-configs.json');
}

function configFingerprint(config: PartialConfig): string {
  return createHash('sha256').update(JSON.stringify(config.model ?? null)).digest('hex');
}

async function readModelTrustRegistry(home = mosaicHome()): Promise<ModelTrustRegistry> {
  const path = modelTrustPath(home);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) {
      return {version: 1, entries: []};
    }
    return modelTrustRegistrySchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch {
    // A missing, corrupted, or redirected registry must fail closed.
    return {version: 1, entries: []};
  }
}

async function isProjectModelConfigTrusted(
  workspace: string,
  config: PartialConfig,
): Promise<boolean> {
  const resolvedWorkspace = await realpath(resolve(workspace)).catch(() => resolve(workspace));
  const registry = await readModelTrustRegistry();
  const fingerprint = configFingerprint(config);
  return registry.entries.some((entry) =>
    entry.workspace === resolvedWorkspace &&
    entry.fingerprint === fingerprint,
  );
}

/** Persist trust only for the model routing fields created by `skein init`. */
export async function trustProjectModelConfig(
  workspace: string,
  configPath = join(resolveProjectNamespaceSync(resolve(workspace)).active, 'config.json'),
): Promise<void> {
  return withNamespaceLease(homeNamespacePaths().canonical, 'shared', async () => {
    const home = mosaicHome();
    assertActiveHomeNamespacePath(home);
    const resolvedWorkspace = await realpath(resolve(workspace)).catch(() => resolve(workspace));
    const resolvedConfigPath = await realpath(resolve(configPath)).catch(() => resolve(configPath));
    const config = await readConfigFile(resolvedConfigPath);
    const registry = await readModelTrustRegistry(home);
    const entries = registry.entries.filter((entry) =>
      entry.workspace !== resolvedWorkspace || entry.configPath !== resolvedConfigPath,
    );
    entries.push({
      workspace: resolvedWorkspace,
      configPath: resolvedConfigPath,
      fingerprint: configFingerprint(config),
      trustedAt: new Date().toISOString(),
    });
    await mkdir(home, {recursive: true, mode: 0o700});
    await atomicWrite(
      modelTrustPath(home),
      `${JSON.stringify({version: 1, entries: entries.slice(-500)}, null, 2)}\n`,
      0o600,
    );
  });
}

export async function loadConfig(
  workspace = process.cwd(),
  explicitPath?: string,
  options: {trustProjectConfig?: boolean} = {},
): Promise<MosaicConfig> {
  let config = defaultConfig(workspace);
  const activeProjectNamespace = resolveProjectNamespaceSync(resolve(workspace)).active;
  const candidates = explicitPath
    ? [resolve(explicitPath)]
    : [
        join(mosaicHome(), 'config.yaml'),
        join(mosaicHome(), 'config.json'),
        join(activeProjectNamespace, 'config.yaml'),
        join(activeProjectNamespace, 'config.json'),
  ];
  for (const path of candidates) {
    const projectConfig = explicitPath === undefined &&
      (path.startsWith(join(resolve(workspace), '.mosaic')) ||
        path.startsWith(join(resolve(workspace), '.skein')));
    if (projectConfig) {
      try {
        await assertNoSymlinkPath(resolve(workspace), dirname(path));
      } catch {
        continue;
      }
    }
    const rawUpdate = await readConfigFile(path);
    const modelTransportTrusted = projectConfig && !options.trustProjectConfig
      ? await isProjectModelConfigTrusted(workspace, rawUpdate)
      : false;
    const update = projectConfig && !options.trustProjectConfig
      ? sanitizeProjectConfig(rawUpdate, config.model.provider, modelTransportTrusted)
      : rawUpdate;
    config = mergeConfig(
      config,
      projectConfig ? await constrainProjectRoots(update, resolve(workspace)) : update,
    );
  }
  const envApiKey = shouldUseProviderEnvironmentKey(config.model.provider, config.model.baseUrl)
    ? providerApiKey(config.model.provider)
    : undefined;
  if (!config.model.apiKey && envApiKey) config.model.apiKey = envApiKey;
  const uiPreference = await readUiPreference();
  if (uiPreference) config = mergeConfig(config, {ui: uiPreference});
  validateAgentConnections(config.agents);
  config.workspaceRoots = [...new Set([
    resolve(workspace),
    ...config.workspaceRoots.map((root) => resolve(workspace, root)),
  ])];
  return config;
}

function validateAgentConnections(agents: AgentTeamConfig | undefined): void {
  if (agents?.defaultConnection && !agents.connections?.[agents.defaultConnection]) {
    throw new Error(`Agent defaults reference unknown connection ${agents.defaultConnection}.`);
  }
  for (const [name, connection] of Object.entries(agents?.connections ?? {})) {
    if (connection.protocol && connection.provider !== 'compatible') {
      throw new Error(`Agent connection ${name} must use provider compatible when protocol is explicit.`);
    }
    if (connection.provider === 'compatible' && connection.protocol === 'gemini') {
      throw new Error(`Agent connection ${name} cannot use the Gemini transport.`);
    }
    if (connection.protocol === 'anthropic-messages' && !connection.modelsBaseUrl) {
      throw new Error(`Agent connection ${name} requires modelsBaseUrl for Anthropic transport.`);
    }
  }
  for (const [profile, route] of Object.entries(agents?.routes ?? {})) {
    if (route.connection && !agents?.connections?.[route.connection]) {
      throw new Error(`Agent route ${profile} references unknown connection ${route.connection}.`);
    }
  }
  for (const [taskProfile, priors] of Object.entries(agents?.capability?.priors ?? {})) {
    for (const routeRef of Object.keys(priors)) {
      if (routeRef === '@parent') continue;
      if (routeRef === '@default') {
        if (agents?.defaultConnection === undefined && agents?.defaultModel === undefined) {
          throw new Error(`Capability prior ${taskProfile} references @default without an agent default route.`);
        }
        continue;
      }
      if (!agents?.routes?.[routeRef]) {
        throw new Error(`Capability prior ${taskProfile} references unknown route ${routeRef}.`);
      }
    }
  }
}

export async function saveUiPreference(update: {theme?: string; compact?: boolean}): Promise<void> {
  const preference = uiPreferenceSchema.parse(update);
  return withNamespaceLease(homeNamespacePaths().canonical, 'shared', async () => {
    const home = mosaicHome();
    assertActiveHomeNamespacePath(home);
    await mkdir(home, {recursive: true, mode: 0o700});
    const existing = await readUiPreference(home);
    const merged = uiPreferenceSchema.parse({...existing, ...preference});
    await atomicWrite(join(home, 'ui.json'), `${JSON.stringify(merged, null, 2)}\n`, 0o600);
  });
}

async function readUiPreference(home = mosaicHome()): Promise<z.infer<typeof uiPreferenceSchema> | undefined> {
  try {
    return uiPreferenceSchema.parse(JSON.parse(await readFile(join(home, 'ui.json'), 'utf8')));
  } catch {
    return undefined;
  }
}

async function constrainProjectRoots(update: PartialConfig, workspace: string): Promise<PartialConfig> {
  if (!update.workspaceRoots) return update;
  const realWorkspace = await realpath(workspace);
  const roots: string[] = [];
  for (const configured of update.workspaceRoots) {
    const root = resolve(workspace, configured);
    if (!isInside(workspace, root)) continue;
    try {
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const resolved = await realpath(root);
      if (isInside(realWorkspace, resolved)) roots.push(root);
    } catch {
      // A project config cannot grant access to a path that does not exist yet.
    }
  }
  return {...update, workspaceRoots: roots};
}

function sanitizeProjectConfig(
  update: PartialConfig,
  currentProvider: ProviderName,
  modelTransportTrusted = false,
): PartialConfig {
  // Permissions and hooks are executable policy, so a repository must be
  // explicitly trusted before it can change them.
  const {
    permissions: _permissions,
    hooks: _hooks,
    mcp: _mcp,
    skills: _skills,
    ...safeUpdate
  } = update;
  const model = update.model ? {...update.model} : undefined;
  const requestedProvider = model?.provider ?? currentProvider;
  const localCompatibleEndpoint = requestedProvider === 'compatible' &&
    isLoopbackEndpoint(model?.baseUrl);
  if (model && !modelTransportTrusted && !localCompatibleEndpoint) {
    // A cloned repository must not redirect an environment-provided API key or
    // workspace source to an endpoint selected by the repository. Loopback
    // compatible endpoints remain usable for the common local-model workflow.
    delete model.apiKey;
    delete model.baseUrl;
    if (model.provider && model.provider !== currentProvider) {
      delete model.provider;
      delete model.model;
    }
  }
  const context = update.context ? {...update.context} : undefined;
  const memory = update.memory ? {...update.memory} : undefined;
  if (memory) delete memory.databasePath;
  const agent = update.agent ? {...update.agent} : undefined;
  if (agent) {
    delete agent.verifyCommands;
    delete agent.checkpointBeforeWrite;
  }
  const skills = update.skills ? {...update.skills} : undefined;
  if (skills) {
    // Skill search paths can read and inject local files. Repository-owned
    // configuration may tune activation, but cannot add directories until the
    // user explicitly trusts the project configuration.
    delete skills.directories;
  }
  const agents = update.agents ? {...update.agents} : undefined;
  if (agents) {
    // Model routes can redirect credentials and source context to arbitrary
    // endpoints. Repository-owned config cannot activate them without trust.
    delete agents.routes;
    delete agents.connections;
    delete agents.defaultConnection;
    delete agents.defaultModel;
    delete agents.writerEnabled;
    delete agents.writerProfile;
    delete agents.writerReviewerProfile;
    delete agents.maxWriterPatchBytes;
    delete agents.capability;
  }
  return {
    ...safeUpdate,
    ...(model ? {model} : {}),
    ...(context ? {context} : {}),
    ...(memory ? {memory} : {}),
    ...(agent ? {agent} : {}),
    ...(skills ? {skills} : {}),
    ...(agents ? {agents} : {}),
  };
}

function isLoopbackEndpoint(endpoint?: string): boolean {
  if (!endpoint) return false;
  try {
    const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/g, '').toLocaleLowerCase();
    return hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

export async function saveProjectConfig(
  workspace: string,
  config: PartialConfig,
): Promise<string> {
  const root = resolve(workspace);
  return withNamespaceLease(projectNamespacePaths(root).canonical, 'shared', async () => {
    const namespace = resolveProjectNamespaceSync(root);
    const path = join(namespace.active, 'config.json');
    const parsed = partialConfigSchema.parse(config);
    await ensureWorkspaceStorageDirectory(root, dirname(path), {requireActiveNamespace: true});
    await atomicWrite(path, `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
    return path;
  });
}

/** Merge trusted user-owned settings without discarding unrelated preferences. */
export async function saveUserConfig(config: PartialConfig): Promise<string> {
  return withNamespaceLease(homeNamespacePaths().canonical, 'shared', async () => {
    const home = mosaicHome();
    assertActiveHomeNamespacePath(home);
    const path = join(home, 'config.json');
    const existing = await readConfigFile(path);
    const agents = existing.agents || config.agents ? {
      ...mergeAgentConfig(existing.agents as AgentTeamConfig | undefined, config.agents),
      connections: {...existing.agents?.connections, ...config.agents?.connections},
      routes: {...existing.agents?.routes, ...config.agents?.routes},
    } : undefined;
    const merged = partialConfigSchema.parse({
      ...existing,
      ...config,
      ...(agents ? {agents} : {}),
    });
    await mkdir(home, {recursive: true, mode: 0o700});
    await atomicWrite(path, `${JSON.stringify(merged, null, 2)}\n`, 0o600);
    return path;
  });
}

export function configSummary(config: MosaicConfig): Record<string, unknown> {
  return {
    model: `${config.model.provider}/${config.model.model}`,
    endpoint: redactEndpoint(config.model.baseUrl),
    apiKey: config.model.apiKey ? 'configured' : 'missing',
    activeConnection: config.activeConnection,
    connectionCatalog: config.connectionCatalog,
    context: {
      maxTokens: config.context.maxTokens,
      topK: config.context.topK,
    },
    workspaceRoots: config.workspaceRoots,
    permissions: config.permissions,
    maxTurns: config.agent.maxTurns,
    maxEpochTokens: config.agent.maxEpochTokens,
    maxSessionTokens: config.agent.maxSessionTokens,
    autoVerify: config.agent.autoVerify,
    skills: config.skills ? {
      enabled: config.skills.enabled,
      autoActivate: config.skills.autoActivate,
      maxActive: config.skills.maxActive,
    } : undefined,
    memory: config.memory ? {
      enabled: config.memory.enabled,
      retrievalLimit: config.memory.retrievalLimit,
      databasePath: config.memory.databasePath ?? defaultMemoryPath(),
    } : undefined,
    agents: config.agents ? {
      enabled: config.agents.enabled,
      maxConcurrent: config.agents.maxConcurrent,
      maxDelegations: config.agents.maxDelegations,
      defaultProfile: config.agents.defaultProfile,
      defaultConnection: config.agents.defaultConnection,
      defaultModel: config.agents.defaultModel,
      reviewerProfile: config.agents.reviewerProfile,
      maxReviewRounds: config.agents.maxReviewRounds,
      cockpit: config.agents.cockpit,
      persistBoard: config.agents.persistBoard,
      maxAgentTokens: config.agents.maxAgentTokens,
      maxAgentToolCalls: config.agents.maxAgentToolCalls,
      agentTimeoutMs: config.agents.agentTimeoutMs,
      budgetMode: config.agents.budgetMode,
      writerEnabled: config.agents.writerEnabled,
      writerProfile: config.agents.writerProfile,
      writerReviewerProfile: config.agents.writerReviewerProfile,
      maxWriterPatchBytes: config.agents.maxWriterPatchBytes,
      capability: config.agents.capability ? {
        mode: config.agents.capability.mode ?? 'shadow',
        halfLifeDays: config.agents.capability.halfLifeDays ?? 30,
        minimumSamples: config.agents.capability.minimumSamples ?? 5,
        configuredPriorTasks: Object.keys(config.agents.capability.priors ?? {}).length,
      } : undefined,
      connections: Object.fromEntries(Object.entries(config.agents.connections ?? {}).map(([name, connection]) => [name, {
        provider: connection.provider,
        protocol: connection.protocol,
        defaultModel: connection.defaultModel,
        endpoint: redactEndpoint(connection.baseUrl),
        modelsEndpoint: redactEndpoint(connection.modelsBaseUrl ?? connection.baseUrl),
        credentials: connection.auth?.type === 'env'
          ? `env:${connection.auth.name}`
          : connection.auth?.type ?? (connection.apiKeyEnv ? `env:${connection.apiKeyEnv}` : 'provider default environment'),
      }])),
      routes: Object.fromEntries(Object.entries(config.agents.routes ?? {}).map(([profile, route]) => [profile, {
        runtime: route.runtime ?? 'api',
        connection: route.connection,
        provider: route.provider ?? (route.connection ? config.agents?.connections?.[route.connection]?.provider : undefined),
        model: route.model,
        endpoint: redactEndpoint(route.baseUrl),
        credentials: route.apiKeyEnv ? `env:${route.apiKeyEnv}` : 'inherited when compatible',
        tokenBudget: route.tokenBudget,
        maxToolCalls: route.maxToolCalls,
        timeoutMs: route.timeoutMs,
        budgetMode: route.budgetMode,
      }])),
    } : undefined,
    mcp: config.mcp ? {
      enabled: config.mcp.enabled,
      servers: Object.keys(config.mcp.servers),
    } : undefined,
  };
}

export function redactEndpoint(endpoint?: string): string {
  if (!endpoint) return 'provider default';
  try {
    const url = new URL(endpoint);
    const authentication = url.username || url.password ? '<redacted>@' : '';
    const query = url.search ? '?<redacted>' : '';
    const fragment = url.hash ? '#<redacted>' : '';
    return `${url.protocol}//${authentication}${url.host}${url.pathname}${query}${fragment}`;
  } catch {
    return 'configured endpoint';
  }
}

function providerApiKey(
  provider: ProviderName,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of envKeysForProvider[provider]) {
    const value = environment[name];
    if (value) return value;
  }
  return undefined;
}

/**
 * Official provider environment keys are safe only with that provider's own
 * endpoint. A custom OpenAI/Anthropic/Gemini base URL is a separate trust
 * boundary and must carry an explicit relay credential in user-owned config.
 * Compatible providers use the relay-specific SKEIN_API_KEY namespace.
 */
function shouldUseProviderEnvironmentKey(provider: ProviderName, baseUrl?: string): boolean {
  if (provider === 'compatible' || !baseUrl) return true;
  const official: Record<Exclude<ProviderName, 'compatible'>, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
  };
  return baseUrl.replace(/\/+$/u, '') === official[provider];
}
