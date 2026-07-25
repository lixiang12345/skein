import type {AgentEvent, MosaicConfig, Session, ToolCategory, ToolDefinition} from '../types.js';
import type {
  ContextDegradation,
  ContextHit,
  ContextPackOptions,
  DuplicationBaseline,
  PackedContext,
} from '../types.js';
import type {ToolArtifactStore} from '../session/tool-artifacts.js';
import type {WorkspaceAccess} from './workspace.js';

export interface ContextProvider {
  pack(query: string, options?: ContextPackOptions): Promise<PackedContext>;
  search(query: string, topK?: number): Promise<ContextHit[]>;
  /** Mark known workspace mutations dirty without performing I/O. */
  invalidate?(paths: string[]): void;
  /** Make dirty paths queryable before the next retrieval boundary. */
  flushDirty?(): Promise<ContextRefreshResult>;
  /** Last retrieval degradation, when the provider can expose it without I/O. */
  lastDegradation?(): ContextDegradation | undefined;
  /** Content-free function fingerprints bound to the current index generation. */
  functionFingerprints?(): Promise<DuplicationBaseline>;
}

export type ContextRefreshResult =
  | {status: 'current'; generation?: string; paths: number}
  | {status: 'degraded'; detail: string; paths: number};

export interface ToolExecutionContext {
  readonly config: MosaicConfig;
  readonly workspace: WorkspaceAccess;
  readonly session: Session;
  readonly contextEngine?: ContextProvider;
  /** Session-bound overflow output retained outside the model transcript. */
  readonly toolArtifactStore?: ToolArtifactStore;
  readonly signal?: AbortSignal;
  readonly emit?: (event: AgentEvent) => void | Promise<void>;
  /** Pre-write checkpoint captured by the parent runner, when enabled. */
  readonly checkpointId?: string;
  /** Runtime tool-call id for content-free session-local receipts. */
  readonly toolCallId?: string;
}

export interface ToolExecution {
  ok?: boolean;
  content: string;
  metadata?: Record<string, unknown>;
  changedFiles?: string[];
}

export interface AgentTool {
  readonly definition: ToolDefinition;
  execute(
    arguments_: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecution>;
  permissionCategories?(
    arguments_: Record<string, unknown>,
  ): ToolCategory[];
  affectedPaths?(
    arguments_: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<string[]>;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

export function jsonSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}
