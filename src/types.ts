export type ProviderName = 'openai' | 'anthropic' | 'gemini' | 'compatible';

export type PermissionLevel = 'allow' | 'ask' | 'deny';

/** Interactive grant scope. Session grants live only on the active runner. */
export type PermissionGrant = boolean | 'session';

export type ToolCategory = 'read' | 'write' | 'shell' | 'git' | 'network';

export type ToolSource = 'builtin' | 'memory' | 'workflow' | 'agent' | 'mcp';

export type CompletionEvidenceSupport = 'full' | 'partial' | 'none';

/** Common declarative trust vocabulary shared by current and future extensions. */
export interface CapabilityManifestTool {
  name: string;
  description?: string;
  permissions: ToolCategory[];
  network: string[];
  commands: string[];
  paths: string[];
  sensitiveFields: string[];
  background: boolean;
  processTree: boolean;
  completionEvidence: CompletionEvidenceSupport;
}

export interface CapabilityManifest {
  schemaVersion: 1;
  id: string;
  source: {kind: ToolSource; owner: string};
  name: string;
  version: string;
  tools: CapabilityManifestTool[];
}

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

/**
 * User-authored effects for one remote MCP tool. Server annotations are never
 * allowed to reduce these local permission requirements.
 */
export interface McpToolCapabilityConfig {
  name: string;
  description?: string;
  permissions: ToolCategory[];
  network?: string[];
  commands?: string[];
  paths?: string[];
  sensitiveFields?: string[];
  background?: boolean;
  processTree?: boolean;
  completionEvidence?: CompletionEvidenceSupport;
}

export interface McpServerConfig {
  enabled: boolean;
  /** Required servers are availability dependencies and may block startup. */
  required?: boolean;
  transport: McpTransport;
  description?: string;
  /** Declarative capability version reviewed by the user before activation. */
  version?: string;
  tools?: McpToolCapabilityConfig[];
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
    /** Per-epoch model budget. Reaching it creates a deterministic handoff. */
    maxEpochTokens?: number;
    /** Lifetime budget for the user-visible session across all epochs. */
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
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    reasoningTokens?: number;
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
  actualCachedInputTokens?: number;
  actualCacheWriteInputTokens?: number;
  actualReasoningTokens?: number;
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
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    reasoningTokens?: number;
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

export type ContextCompactionMode = 'automatic' | 'manual';
export type ContextCompactionStatus = 'compacted' | 'skipped';
export type ContextCompactionReason =
  | 'compacted'
  | 'insufficient-history'
  | 'non-positive-net-savings';

/**
 * Privacy-safe accounting for a context compaction model request. The receipt
 * contains only counts, decisions, and provider usage, never transcript text.
 */
export interface ContextCompactionReceipt {
  id: string;
  recordedAt: string;
  mode: ContextCompactionMode;
  status: ContextCompactionStatus;
  reason: ContextCompactionReason;
  omittedMessages: number;
  compactedThroughMessageId?: string;
  predictedReuses: number;
  estimated: {
    inputTokens: number;
    outputTokens: number;
    predictedOutputTokens: number;
    outputAllowanceTokens: number;
    omittedTokens: number;
    priorSummaryTokens: number;
    factsTokens: number;
    projectedGrossSavingsTokens: number;
    projectedNetSavingsTokens: number;
  };
  actual: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    reasoningTokens?: number;
  };
  inputSource: 'actual' | 'estimated' | 'none';
  outputSource: 'actual' | 'estimated' | 'none';
  narrative: 'present' | 'empty' | 'not-requested';
}

export type ContextEpochHandoffReason = 'token_budget' | 'context_pressure' | 'manual';

/**
 * Content-free checkpoint between bounded model-context epochs. Full messages,
 * Task Contract state, and audit evidence remain authoritative elsewhere in
 * the session; this receipt only proves what was checked at the boundary.
 */
export interface ContextEpochHandoff {
  reason: ContextEpochHandoffReason;
  createdAt: string;
  compactionReceiptId?: string;
  compactedThroughMessageId?: string;
  contract?: {
    state: TaskContractState;
    required: Array<{
      id: string;
      status: TaskContractCriterionStatus;
      evidenceRefs: string[];
    }>;
  };
  unresolvedFailures: Array<{
    signature: string;
    class: ToolFailureClass;
    circuitOpen: boolean;
  }>;
  changedFiles: string[];
  checks: VerificationEvidence[];
}

export interface ContextEpoch {
  id: string;
  index: number;
  startedAt: string;
  finishedAt?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  handoff?: ContextEpochHandoff;
}

export type IntentSufficiencyRoute =
  | 'direct_execute'
  | 'inspect_then_execute'
  | 'needs_input'
  | 'permission_required';

export type IntentSufficiencyReason =
  | 'simple_explicit_request'
  | 'workspace_inference_available'
  | 'explicit_user_choice_missing'
  | 'public_api_compatibility_missing'
  | 'runtime_permission_separate'
  | 'clarification_resolved';

export interface IntentAssessment {
  version: 1;
  route: IntentSufficiencyRoute;
  reasons: IntentSufficiencyReason[];
  assessedAt: string;
  retrievalHits: number;
}

export interface PendingInputOption {
  id: string;
  label: string;
  impact: string;
  recommended: boolean;
}

/** User-facing clarification state. It never stores hidden model reasoning. */
export interface PendingInput {
  id: string;
  runId: string;
  createdAt: string;
  originalRequest: string;
  question: string;
  options: PendingInputOption[];
  reason: Extract<IntentSufficiencyReason,
    'explicit_user_choice_missing' | 'public_api_compatibility_missing'>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: Record<string, unknown>;
  /** Extension tools may be disclosed progressively when the catalog is large. */
  progressive?: boolean;
  /** Content-free provenance used by `/tools`; providers do not receive it. */
  source?: ToolSource;
  /** Static upper-bound permission categories for capability review. */
  permissionCategories?: ToolCategory[];
  /** Whether an extension is only a catalog control or an activated tool. */
  activation?: 'always' | 'catalog' | 'active';
  /** Remote mutation evidence support claimed by the reviewed manifest. */
  completionEvidence?: CompletionEvidenceSupport;
  /** Argument fields redacted from terminal, JSON events, and approval UIs. */
  sensitiveFields?: string[];
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
  diagnostic: number;
  total: number;
}

/** A bounded, session-local path signal from a failed verification process. */
export interface ContextDiagnosticUpdate {
  commandKey: string;
  paths: string[];
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
  /** Recent content-free receipts for compaction decisions and model cost. */
  contextCompactionReceipts?: ContextCompactionReceipt[];
  /** Bounded reasoning epochs within one durable, user-visible session. */
  contextEpochs?: ContextEpoch[];
  intentAssessment?: IntentAssessment;
  pendingInput?: PendingInput;
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
  | {type: 'permission'; call: ToolCall; category: ToolCategory; reason: string}
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
  | {type: 'context_compacted'; omittedMessages: number; summaryTokens: number; status: ContextCompactionStatus; reason: ContextCompactionReason; receipt: ContextCompactionReceipt}
  | {type: 'context_epoch'; index: number; previousIndex: number; reason: ContextEpochHandoffReason; inputTokens: number; outputTokens: number; handoff: ContextEpochHandoff}
  | {type: 'intent'; assessment: IntentAssessment}
  | {type: 'needs_input'; pending: PendingInput}
  | {type: 'input_resolved'; pendingId: string; runId: string; answer: string}
  | {type: 'usage'; inputTokens: number; outputTokens: number; source?: TokenMeasurementSource; inputSource?: TokenMeasurementSource; outputSource?: TokenMeasurementSource; actual?: {inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; reasoningTokens?: number}; estimated?: {inputTokens: number; outputTokens: number}; receipt?: TokenLedgerEntry}
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
    reason?: string,
  ) => Promise<PermissionGrant>;
}
