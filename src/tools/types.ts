import type {AgentEvent, MosaicConfig, Session, ToolCategory, ToolDefinition} from '../types.js';
import type {ContextHit, PackedContext} from '../types.js';
import type {WorkspaceAccess} from './workspace.js';

export interface ContextProvider {
  pack(query: string): Promise<PackedContext>;
  search(query: string, topK?: number): Promise<ContextHit[]>;
}

export interface ToolExecutionContext {
  readonly config: MosaicConfig;
  readonly workspace: WorkspaceAccess;
  readonly session: Session;
  readonly contextEngine?: ContextProvider;
  readonly signal?: AbortSignal;
  readonly emit?: (event: AgentEvent) => void | Promise<void>;
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
