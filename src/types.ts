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
  /** Explicit opt-in for the isolated writer lane. Repository config cannot enable it. */
  writerEnabled?: boolean;
  /** Writable built-in or user profile used by writer_run. */
  writerProfile?: string;
  /** Read-only profile that must accept a writer patch before integration. */
  writerReviewerProfile?: string;
  /** Hard UTF-8 byte limit for a persisted Git patch. Oversize patches are rejected. */
  maxWriterPatchBytes?: number;
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
    maxTokens: number;
    topK: number;
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

export type TokenMeasurementSource = 'actual' | 'estimated' | 'mixed' | 'unknown';

export interface SessionTokenUsage {
  /** Backward-compatible total used for session caps. May combine actual and estimated values. */
  inputTokens: number;
  /** Backward-compatible total used for session caps. May combine actual and estimated values. */
  outputTokens: number;
  source?: TokenMeasurementSource;
  inputSource?: TokenMeasurementSource;
  outputSource?: TokenMeasurementSource;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

/**
 * Privacy-safe accounting for one model request. Content, prompts, schemas,
 * tool arguments, and tool results never belong in this receipt.
 */
export interface TokenLedgerEntry {
  requestId: string;
  turn: number;
  recordedAt: string;
  estimated: PromptTokenBreakdown & {outputTokens: number};
  actual: {
    inputTokens?: number;
    outputTokens?: number;
  };
  inputSource: 'actual' | 'estimated';
  outputSource: 'actual' | 'estimated';
  tools: {
    loaded: string[];
    deferredCount: number;
  };
  retrieval: {
    engine: string;
    budgetTier?: ContextBudgetTier;
    budgetTokens?: number;
    candidateHits?: number;
    selectedHits?: number;
    duplicateHits?: number;
    incrementalEvidenceTokens?: number;
    discarded: Array<{reason: 'overlapping-span' | 'budget-cap'; count: number}>;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: Record<string, unknown>;
  /** Extension tools may be disclosed progressively when the catalog is large. */
  progressive?: boolean;
}

export interface ContextHit {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  source: string;
  symbol?: string;
  /** Bounded, content-free ranking evidence for diagnostics and `/context --json`. */
  provenance?: ContextHitProvenance;
}

export interface ContextScoreBreakdown {
  bm25: number;
  path: number;
  symbol: number;
  phrase: number;
  graph: number;
  recency: number;
  total: number;
}

export interface ContextHitProvenance {
  generation: string;
  contentHash: string;
  matchedTerms: string[];
  expandedTerms: string[];
  score: ContextScoreBreakdown;
}

export type ReuseDecision = 'reuse' | 'extend' | 'new' | 'unresolved';
export type ReuseReceiptStatus = 'warning' | 'skipped' | 'unresolved';

/**
 * Content-free runtime evidence captured before a substantive new write.
 * The receipt is deliberately bounded so it can be persisted in audit/session
 * metadata without retaining prompts, source text, or credentials.
 */
export interface ReuseReceipt {
  requestId: string;
  queryHash: string;
  targetPaths: string[];
  trigger: 'new-file' | 'new-symbol';
  decision: ReuseDecision;
  candidates: Array<{
    path: string;
    symbol?: string;
    score: number;
    read: 'current' | 'unreadable';
  }>;
  selectedPath?: string;
  selectedSymbol?: string;
  rationale: string;
  indexGeneration?: string;
  changeSequence: number;
  status: ReuseReceiptStatus;
  warningOnly: true;
}

export interface FunctionFingerprint {
  path: string;
  symbol: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
  exactHash: string;
  fingerprints: string[];
}

/** Ephemeral pre-write baseline. It contains hashes and locations, never source. */
export interface DuplicationBaseline {
  generation: string;
  functions: FunctionFingerprint[];
}

export interface DuplicationAuditReceipt {
  baselineGeneration: string;
  changeSequence: number;
  status: 'clear' | 'warning' | 'unresolved';
  warningOnly: boolean;
  enforcement?: 'warning' | 'blocking';
  checkedFunctions: number;
  skippedSmallFunctions: number;
  matches: Array<{
    /** Added in session schema 0.3.16; older 0.3.15 receipts omit it. */
    matchId?: string;
    changedPath: string;
    changedSymbol: string;
    candidatePath: string;
    candidateSymbol: string;
    kind: 'type-1-or-2' | 'type-3';
    similarity: number;
  }>;
  rationale: string;
}

export interface DuplicationSuppressionReceipt {
  matchId: string;
  reasonCode: 'separate-boundary' | 'protocol-required' | 'generated-contract' | 'false-positive' | 'other';
  reason: string;
  createdAt: string;
  toolCallId: string;
}

export interface DuplicationCompletionSummary {
  enforcement: 'warning' | 'blocking';
  status: 'clear' | 'warning' | 'unresolved' | 'suppressed';
  warningCount: number;
  unresolvedCount: number;
  suppressedCount: number;
  matches: Array<DuplicationAuditReceipt['matches'][number] & {matchId: string}>;
}

export type ContextBudgetTier = 'none' | 'focused' | 'standard' | 'broad' | 'maximum';

export interface ContextPackOptions {
  intent?: 'explain' | 'review' | 'debug' | 'refactor' | 'test' | 'implement';
  trivial?: boolean;
  /** Optional caller ceiling. The adaptive policy may select less. */
  maxTokens?: number;
  /** Optional caller result ceiling. The adaptive policy may select less. */
  topK?: number;
}

export interface PackedContext {
  text: string;
  hits: ContextHit[];
  estimatedTokens: number;
  engine: string;
  truncated: boolean;
  budgetTier?: ContextBudgetTier;
  budgetTokens?: number;
  baseBudgetTokens?: number;
  incrementalBudgetTokens?: number;
  budgetReason?: string;
  candidateHits?: number;
  selectedHits?: number;
  duplicateHits?: number;
  /** Selected evidence above the focused 2k base, not a model-quality claim. */
  incrementalEvidenceTokens?: number;
  degradation?: ContextDegradation;
}

export interface PromptTokenBreakdown {
  stableTokens: number;
  dynamicTokens: number;
  conversationTokens: number;
  toolResultTokens: number;
  retrievedTokens: number;
  toolSchemaTokens: number;
  estimatedInputTokens: number;
  outputAllowanceTokens: number;
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

export type TaskContractState = 'draft' | 'active' | 'satisfied' | 'blocked';

export type TaskContractCriterionStatus = 'pending' | 'satisfied' | 'blocked';

export interface TaskContractCriterion {
  id: string;
  description: string;
  required: boolean;
  status: TaskContractCriterionStatus;
  evidenceRefs: string[];
  note?: string;
}

/** Durable acceptance state for a complex executable request. */
export interface TaskContract {
  version: 1;
  state: TaskContractState;
  objective: string;
  scope: string[];
  constraints: string[];
  nonGoals: string[];
  acceptanceCriteria: TaskContractCriterion[];
  verificationRequirements: string[];
  createdAt: string;
  updatedAt: string;
  /** Final audit event before creation; avoids reusing same-timestamp evidence. */
  auditBoundaryId?: string;
}

export type ToolFailureClass =
  | 'schema_input'
  | 'unknown_tool'
  | 'permission_denied'
  | 'command_exit'
  | 'timeout'
  | 'cancelled'
  | 'hook'
  | 'execution'
  | 'no_progress'
  | 'contract_required';

export interface ToolFailureReceipt {
  class: ToolFailureClass;
  retryable: boolean;
  repairHint: string;
  attempt: number;
  remaining: number;
  circuitOpen: boolean;
  signature: string;
}

export type CompletionStatus =
  | 'no_changes'
  | 'verified'
  | 'unverified'
  | 'verification_failed';

export type VerificationKind =
  | 'configured'
  | 'test'
  | 'typecheck'
  | 'lint'
  | 'build'
  | 'diff'
  | 'check';

export interface VerificationEvidence {
  toolCallId: string;
  tool: 'shell' | 'git';
  command: string;
  kind: VerificationKind;
  ok: boolean;
}

export interface RunCompletion {
  status: CompletionStatus;
  changedFiles: string[];
  checks: VerificationEvidence[];
  detail: string;
  mutationTracking?: 'complete' | 'unknown';
  duplication?: DuplicationCompletionSummary;
  acceptance?: {
    state: TaskContractState;
    total: number;
    satisfied: number;
    pending: number;
    blocked: number;
    missingVerification: string[];
    unresolved: Array<{
      id: string;
      description: string;
      status: TaskContractCriterionStatus;
    }>;
  };
}

export interface SessionRunRecord extends RunCompletion {
  reason: string;
  finishedAt: string;
}

export type AgentPhase = 'work' | 'review' | 'revision' | 'write';

export type WriterLaneStatus =
  | 'ready'
  | 'conflict'
  | 'integrated'
  | 'rejected'
  | 'failed'
  | 'cancelled';

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

/** A redacted oversized tool result retained outside the model transcript. */
export interface ToolArtifactReference {
  toolCallId: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  expiresAt: string;
  redacted: boolean;
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
  toolArtifacts?: ToolArtifactReference[];
  taskContract?: TaskContract;
  duplicationSuppressions?: DuplicationSuppressionReceipt[];
  lastRun?: SessionRunRecord;
  /** Recent privacy-safe request receipts; no prompt or source text is retained. */
  tokenLedger?: TokenLedgerEntry[];
  usage: SessionTokenUsage;
}

export type AgentEvent =
  | {type: 'thinking'; turn: number}
  | {type: 'context'; packed: PackedContext}
  | {type: 'prompt'; intent: string; sections: string[]; estimatedTokens: number; breakdown?: PromptTokenBreakdown}
  | {type: 'assistant_delta'; id: string; content: string}
  | {type: 'assistant'; content: string; id?: string}
  | {type: 'tool_start'; call: ToolCall; category: ToolCategory}
  | {type: 'tool_result'; result: ToolResult}
  | {type: 'permission'; call: ToolCall; category: ToolCategory}
  | {type: 'tasks'; tasks: SessionTask[]}
  | {type: 'contract'; contract: TaskContract}
  | {type: 'skill'; name: string; description: string}
  | {type: 'memory'; count: number; scope: string}
  | {type: 'agent_queued'; id: string; profile: string; task: string; phase?: AgentPhase}
  | {type: 'agent_start'; id: string; profile: string; task: string; provider?: string; model?: string; phase?: AgentPhase; retryOf?: string}
  | {type: 'agent_message'; id: string; from: string; to: string; content: string}
  | {type: 'agent_update'; id: string; profile: string; stage: 'context' | 'thinking' | 'tool' | 'response' | 'review'; detail?: string; tool?: string; toolCalls?: number; inputTokens?: number; outputTokens?: number}
  | {type: 'agent_cancelled'; id: string; profile: string; phase?: AgentPhase; reason: string; queued: boolean}
  | {type: 'team_start'; id: string; objective: string}
  | {type: 'team_done'; id: string; accepted: boolean; reviewRounds: number}
  | {type: 'agent_done'; id: string; profile: string; ok: boolean; summary: string; provider?: string; model?: string; phase?: AgentPhase; durationMs?: number; toolCalls?: number; usage?: {inputTokens: number; outputTokens: number}}
  | {type: 'writer_lane'; id: string; status: WriterLaneStatus; detail: string; files?: string[]; checkpointId?: string}
  | {type: 'workflow'; name: string; step: string; status: TaskStatus}
  | {type: 'context_compacted'; omittedMessages: number; summaryTokens: number}
  | {type: 'usage'; inputTokens: number; outputTokens: number; source?: TokenMeasurementSource; inputSource?: TokenMeasurementSource; outputSource?: TokenMeasurementSource; actual?: {inputTokens: number; outputTokens: number}; estimated?: {inputTokens: number; outputTokens: number}; receipt?: TokenLedgerEntry}
  | {type: 'error'; error: Error}
  | {type: 'done'; reason: string; completion?: RunCompletion};

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
