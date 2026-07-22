import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {lstat, mkdir, readFile, realpath} from 'node:fs/promises';
import {parse as parseYaml} from 'yaml';
import {z} from 'zod';
import {defaultMemoryPath} from './memory/store.js';
import type {
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
import {resolveHomeNamespace, resolveProjectNamespaceSync} from './utils/namespace.js';

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

const agentTeamConfigSchema = z.object({
  enabled: z.boolean().optional(),
  maxConcurrent: z.number().int().positive().max(16).optional(),
  maxDelegations: z.number().int().positive().max(32).optional(),
  defaultProfile: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  reviewerProfile: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  maxReviewRounds: z.number().int().min(0).max(3).optional(),
  cockpit: z.boolean().optional(),
  routes: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), z.object({
    runtime: z.enum(['api', 'codex', 'claude', 'grok']).optional(),
    provider: z.enum(['openai', 'anthropic', 'gemini', 'compatible']),
    model: z.string().min(1).max(256),
    baseUrl: z.string().url().refine((value) => /^https?:$/i.test(new URL(value).protocol), {
      message: 'agent route baseUrl must use http or https',
    }).optional(),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(200_000).optional(),
  }).strict()).optional(),
}).partial();

const mcpServerSchema = z.object({
  enabled: z.boolean().optional(),
  transport: z.enum(['stdio', 'http']).optional(),
  command: z.string().min(1).max(512).optional(),
  args: z.array(z.string().max(4_000)).max(64).optional(),
  cwd: z.string().max(4_000).optional(),
  env: z.record(z.string(), z.string().max(20_000)).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string().max(20_000)).optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  toolPrefix: z.string().regex(/^[a-z][a-z0-9_-]{0,24}$/).optional(),
}).strict();

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
    engine: z.enum(['auto', 'contextengine', 'local']).optional(),
    maxTokens: z.number().positive().optional(),
    topK: z.number().int().positive().optional(),
    contextEngineCommand: z.string().optional(),
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
  const apiKey = providerApiKey(provider);
  const model = preferredEnv('SKEIN_MODEL', 'MOSAIC_MODEL');
  const baseUrl = preferredEnv('SKEIN_BASE_URL', 'MOSAIC_BASE_URL');
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
      engine: 'auto',
      maxTokens: 12_000,
      topK: 12,
      contextEngineCommand: 'contextengine',
    },
    permissions: {...defaultPermissions},
    hooks: {},
    agent: {
      maxTurns: 24,
      maxSessionTokens: 250_000,
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
      routes: {},
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
  const {apiKey: _apiKey, baseUrl: _baseUrl, ...portable} = current;
  const inherited = providerChanged ? portable : current;
  const apiKey = providerChanged
    ? providerApiKey(provider, environment)
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
  const {apiKey: _apiKey, baseUrl: _baseUrl, ...portableModel} = base.model;
  const inheritedModel = providerChanged ? portableModel : base.model;
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
    agents: {...base.agents, ...update.agents} as AgentTeamConfig,
    mcp: {
      ...base.mcp,
      ...update.mcp,
      servers: {...base.mcp?.servers, ...update.mcp?.servers},
    } as McpConfig,
    workspaceRoots: update.workspaceRoots ?? base.workspaceRoots,
  } as MosaicConfig;
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

function modelTrustPath(): string {
  return join(mosaicHome(), 'trusted-model-configs.json');
}

function configFingerprint(config: PartialConfig): string {
  return createHash('sha256').update(JSON.stringify(config.model ?? null)).digest('hex');
}

async function readModelTrustRegistry(): Promise<ModelTrustRegistry> {
  const path = modelTrustPath();
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
  configPath: string,
  config: PartialConfig,
): Promise<boolean> {
  const resolvedWorkspace = await realpath(resolve(workspace)).catch(() => resolve(workspace));
  const resolvedConfigPath = await realpath(resolve(configPath)).catch(() => resolve(configPath));
  const registry = await readModelTrustRegistry();
  const fingerprint = configFingerprint(config);
  return registry.entries.some((entry) =>
    entry.workspace === resolvedWorkspace &&
    entry.configPath === resolvedConfigPath &&
    entry.fingerprint === fingerprint,
  );
}

/** Persist trust only for the model routing fields created by `skein init`. */
export async function trustProjectModelConfig(
  workspace: string,
  configPath = join(resolveProjectNamespaceSync(resolve(workspace)).active, 'config.json'),
): Promise<void> {
  const resolvedWorkspace = await realpath(resolve(workspace)).catch(() => resolve(workspace));
  const resolvedConfigPath = await realpath(resolve(configPath)).catch(() => resolve(configPath));
  const config = await readConfigFile(resolvedConfigPath);
  const registry = await readModelTrustRegistry();
  const entries = registry.entries.filter((entry) =>
    entry.workspace !== resolvedWorkspace || entry.configPath !== resolvedConfigPath,
  );
  entries.push({
    workspace: resolvedWorkspace,
    configPath: resolvedConfigPath,
    fingerprint: configFingerprint(config),
    trustedAt: new Date().toISOString(),
  });
  const home = mosaicHome();
  await mkdir(home, {recursive: true, mode: 0o700});
  await atomicWrite(
    modelTrustPath(),
    `${JSON.stringify({version: 1, entries: entries.slice(-500)}, null, 2)}\n`,
    0o600,
  );
}

export async function loadConfig(
  workspace = process.cwd(),
  explicitPath?: string,
  options: {trustProjectConfig?: boolean} = {},
): Promise<MosaicConfig> {
  let config = defaultConfig(workspace);
  const candidates = explicitPath
    ? [resolve(explicitPath)]
    : [
        join(mosaicHome(), 'config.yaml'),
        join(resolveProjectNamespaceSync(resolve(workspace)).canonical, 'config.yaml'),
        join(resolveProjectNamespaceSync(resolve(workspace)).canonical, 'config.json'),
        join(resolve(workspace), '.mosaic', 'config.yaml'),
        join(resolve(workspace), '.mosaic', 'config.json'),
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
      ? await isProjectModelConfigTrusted(workspace, path, rawUpdate)
      : false;
    const update = projectConfig && !options.trustProjectConfig
      ? sanitizeProjectConfig(rawUpdate, config.model.provider, modelTransportTrusted)
      : rawUpdate;
    config = mergeConfig(
      config,
      projectConfig ? await constrainProjectRoots(update, resolve(workspace)) : update,
    );
  }
  const envApiKey = providerApiKey(config.model.provider);
  if (!config.model.apiKey && envApiKey) config.model.apiKey = envApiKey;
  const uiPreference = await readUiPreference();
  if (uiPreference) config = mergeConfig(config, {ui: uiPreference});
  config.workspaceRoots = [...new Set([
    resolve(workspace),
    ...config.workspaceRoots.map((root) => resolve(workspace, root)),
  ])];
  return config;
}

export async function saveUiPreference(update: {theme?: string; compact?: boolean}): Promise<void> {
  const preference = uiPreferenceSchema.parse(update);
  const home = mosaicHome();
  await mkdir(home, {recursive: true, mode: 0o700});
  const existing = await readUiPreference();
  const merged = uiPreferenceSchema.parse({...existing, ...preference});
  await atomicWrite(join(home, 'ui.json'), `${JSON.stringify(merged, null, 2)}\n`, 0o600);
}

async function readUiPreference(): Promise<z.infer<typeof uiPreferenceSchema> | undefined> {
  try {
    return uiPreferenceSchema.parse(JSON.parse(await readFile(join(mosaicHome(), 'ui.json'), 'utf8')));
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
  if (context) delete context.contextEngineCommand;
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
  const namespace = resolveProjectNamespaceSync(resolve(workspace));
  const path = join(namespace.active, 'config.json');
  const parsed = partialConfigSchema.parse(config);
  await ensureWorkspaceStorageDirectory(resolve(workspace), dirname(path));
  await atomicWrite(path, `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
  return path;
}

export function configSummary(config: MosaicConfig): Record<string, unknown> {
  return {
    model: `${config.model.provider}/${config.model.model}`,
    endpoint: redactEndpoint(config.model.baseUrl),
    apiKey: config.model.apiKey ? 'configured' : 'missing',
    contextEngine: config.context.engine,
    workspaceRoots: config.workspaceRoots,
    permissions: config.permissions,
    maxTurns: config.agent.maxTurns,
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
      reviewerProfile: config.agents.reviewerProfile,
      maxReviewRounds: config.agents.maxReviewRounds,
      cockpit: config.agents.cockpit,
      routes: Object.fromEntries(Object.entries(config.agents.routes ?? {}).map(([profile, route]) => [profile, {
        runtime: route.runtime ?? 'api',
        provider: route.provider,
        model: route.model,
        endpoint: redactEndpoint(route.baseUrl),
        credentials: route.apiKeyEnv ? `env:${route.apiKeyEnv}` : 'inherited when compatible',
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
