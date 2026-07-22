export type ProviderName = 'openai' | 'anthropic' | 'gemini' | 'compatible';

export type PermissionLevel = 'allow' | 'ask' | 'deny';

/** Interactive grant scope. Session grants live only on the active runner. */
export type PermissionGrant = boolean | 'session';

export type ToolCategory = 'read' | 'write' | 'shell' | 'git' | 'network';

export interface ModelConfig {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface PermissionConfig {
  read: PermissionLevel;
  write: PermissionLevel;
  shell: PermissionLevel;
  git: PermissionLevel;
  network: PermissionLevel;
  allowCommands: string[];
  denyCommands: string[];
}

export interface HookConfig {
  beforeTool?: string[];
  afterTool?: string[];
  afterTurn?: string[];
}

export type MemoryScope = 'user' | 'workspace' | 'session' | 'agent';

export interface SkillConfig {
  enabled: boolean;
  directories: string[];
  autoActivate: boolean;
  maxActive: number;
  maxCharsPerSkill: number;
}

export interface MemoryConfig {
  enabled: boolean;
  databasePath?: string;
  retrievalLimit: number;
  maxPromptTokens: number;
}

export interface AgentTeamConfig {
  enabled: boolean;
  maxConcurrent: number;
  maxDelegations: number;
  defaultProfile: string;
  /** Default named connection inherited by profiles without an explicit provider or connection. */
  defaultConnection?: string;
  /** Default model inherited by profiles without an explicit model override. */
  defaultModel?: string;
  /** Optional role-to-model routing. Credentials are referenced by env name, never stored here. */
  routes?: Record<string, AgentModelRoute>;
  /** Named API connections let many routes share one endpoint and credential reference. */
  connections?: Record<string, AgentConnectionConfig>;
  reviewerProfile?: string;
  maxReviewRounds?: number;
  cockpit?: boolean;
  persistBoard?: boolean;
  maxAgentTokens?: number;
  maxAgentToolCalls?: number;
  agentTimeoutMs?: number;
  budgetMode?: 'observe' | 'guard' | 'strict';
}

export interface AgentConnectionConfig {
  provider: ProviderName;
  baseUrl?: string;
  apiKeyEnv?: string;
}

export interface AgentModelRoute {
  runtime?: 'api' | 'codex' | 'claude' | 'grok';
  connection?: string;
  provider?: ProviderName;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  temperature?: number;
  maxTokens?: number;
  tokenBudget?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  budgetMode?: 'observe' | 'guard' | 'strict';
}

export type McpTransport = 'stdio' | 'http';

export interface McpServerConfig {
  enabled: boolean;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  toolPrefix?: string;
}

export interface McpConfig {
  enabled: boolean;
  connectTimeoutMs: number;
  toolTimeoutMs: number;
  servers: Record<string, McpServerConfig>;
}

export interface MosaicConfig {
  model: ModelConfig;
  workspaceRoots: string[];
  context: {
    engine: 'auto' | 'contextengine' | 'local';
    maxTokens: number;
    topK: number;
    contextEngineCommand: string;
  };
  permissions: PermissionConfig;
  hooks: HookConfig;
  agent: {
    maxTurns: number;
    maxSessionTokens: number;
    autoVerify: boolean;
    verifyCommands: string[];
    checkpointBeforeWrite: boolean;
  };
  ui: {
    color: boolean;
    compact: boolean;
    theme?: string;
  };
  skills?: SkillConfig;
  memory?: MemoryConfig;
  agents?: AgentTeamConfig;
  mcp?: McpConfig;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  stopReason?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: Record<string, unknown>;
}

export interface ContextHit {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  source: string;
  symbol?: string;
}

export interface PackedContext {
  text: string;
  hits: ContextHit[];
  estimatedTokens: number;
  engine: string;
  truncated: boolean;
  degradation?: ContextDegradation;
}

export interface ContextDegradation {
  code: string;
  summary: string;
  detail?: string;
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface SessionTask {
  id: string;
  title: string;
  status: TaskStatus;
}

export interface SessionAuditEvent {
  id: string;
  createdAt: string;
  type: 'permission' | 'tool';
  toolCallId: string;
  tool: string;
  category?: ToolCategory;
  outcome: 'allow' | 'deny' | 'success' | 'failure';
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkingMemory {
  goal: string;
  focus: string;
  constraints: string[];
  decisions: string[];
  openQuestions: string[];
  relevantFiles: string[];
  lastUpdatedAt: string;
}

/**
 * A user-controlled context source. Unlike retrieved code (which is compacted
 * away as the conversation grows), a pinned source is read fresh from disk and
 * re-injected on every turn until the user unpins it. Muted sources stay in the
 * list for one-key re-activation but cost zero tokens.
 */
export interface ContextSource {
  /** Workspace-relative path, used as the stable identity for pin/unpin/mute. */
  path: string;
  /** Pinned survives compaction; muted is listed but not injected. */
  state: 'pinned' | 'muted';
  /** Token cost of the last successful read, for the budget meter. */
  tokens: number;
  addedAt: string;
}

export interface Session {
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  provider: ProviderName;
  messages: ChatMessage[];
  tasks: SessionTask[];
  changedFiles: string[];
  audit?: SessionAuditEvent[];
  contextSummary?: string;
  contextCompactions?: number;
  compactedThroughMessageId?: string;
  workingMemory?: WorkingMemory;
  contextSources?: ContextSource[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export type AgentEvent =
  | {type: 'thinking'; turn: number}
  | {type: 'context'; packed: PackedContext}
  | {type: 'prompt'; intent: string; sections: string[]; estimatedTokens: number}
  | {type: 'assistant_delta'; id: string; content: string}
  | {type: 'assistant'; content: string; id?: string}
  | {type: 'tool_start'; call: ToolCall; category: ToolCategory}
  | {type: 'tool_result'; result: ToolResult}
  | {type: 'permission'; call: ToolCall; category: ToolCategory}
  | {type: 'tasks'; tasks: SessionTask[]}
  | {type: 'skill'; name: string; description: string}
  | {type: 'memory'; count: number; scope: string}
  | {type: 'agent_start'; id: string; profile: string; task: string; provider?: string; model?: string; phase?: 'work' | 'review' | 'revision'; retryOf?: string}
  | {type: 'agent_message'; id: string; from: string; to: string; content: string}
  | {type: 'agent_update'; id: string; profile: string; stage: 'context' | 'thinking' | 'tool' | 'response' | 'review'; detail?: string; tool?: string; toolCalls?: number; inputTokens?: number; outputTokens?: number}
  | {type: 'team_start'; id: string; objective: string}
  | {type: 'team_done'; id: string; accepted: boolean; reviewRounds: number}
  | {type: 'agent_done'; id: string; profile: string; ok: boolean; summary: string; provider?: string; model?: string; phase?: 'work' | 'review' | 'revision'; durationMs?: number; toolCalls?: number; usage?: {inputTokens: number; outputTokens: number}}
  | {type: 'workflow'; name: string; step: string; status: TaskStatus}
  | {type: 'context_compacted'; omittedMessages: number; summaryTokens: number}
  | {type: 'usage'; inputTokens: number; outputTokens: number}
  | {type: 'error'; error: Error}
  | {type: 'done'; reason: string};

export interface RunOptions {
  maxTurns?: number;
  askMode?: boolean;
  /** Ephemeral per-turn instructions that are sent to the model but not stored as user text. */
  turnInstructions?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  requestPermission?: (
    call: ToolCall,
    category: ToolCategory,
  ) => Promise<PermissionGrant>;
}
