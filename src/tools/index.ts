import type {BackgroundJobsConfig, LspConfig} from '../types.js';
import {createBackgroundJobTools} from './background.js';
import type {ContextProvider} from './types.js';
import {applyPatchTool} from './apply-patch.js';
import {gitTool} from './git.js';
import {listFilesTool} from './list.js';
import {createLspTool} from './lsp.js';
import {readFileTool} from './read.js';
import {readToolArtifactTool} from './read-artifact.js';
import {ToolRegistry} from './registry.js';
import {searchCodeTool} from './search.js';
import {shellTool} from './shell.js';
import {taskTool} from './task.js';
import {taskContractTool} from './task-contract.js';
import {workingMemoryTool} from './working-memory.js';
import {duplicationTool} from './duplication.js';
import {writeFileTool} from './write.js';

export interface DefaultToolRegistryOptions {
  /** Reserved for callers that want the registry to document its ranked retrieval. */
  contextEngine?: ContextProvider;
  /** Explicit, user-trusted language-server configuration. */
  lsp?: LspConfig;
  /** Explicit, user-trusted durable local subprocess configuration. */
  backgroundJobs?: BackgroundJobsConfig;
}

export function createDefaultToolRegistry(
  options: DefaultToolRegistryOptions = {},
): ToolRegistry {
  const tools = [
    readFileTool,
    readToolArtifactTool,
    listFilesTool,
    searchCodeTool,
    writeFileTool,
    applyPatchTool,
    shellTool,
    gitTool,
    taskTool,
    taskContractTool,
    duplicationTool,
    workingMemoryTool,
  ];
  if (options.lsp?.enabled && Object.keys(options.lsp.servers).length > 0) {
    tools.push(createLspTool(options.lsp));
  }
  if (options.backgroundJobs?.enabled) tools.push(...createBackgroundJobTools(options.backgroundJobs));
  return new ToolRegistry(tools);
}

export {ToolRegistry} from './registry.js';
export {WorkspaceAccess} from './workspace.js';
export {evaluatePermission, commandForCall, liveHumanApprovalCategories, permissionKey, permissionTarget, requiresLiveHumanApproval} from './permissions.js';
export type {
  AgentTool,
  ToolExecution,
  ToolExecutionContext,
  ContextProvider,
} from './types.js';
export {ToolExecutionError, ToolInputError} from './types.js';
export {
  readFileTool,
  readToolArtifactTool,
  listFilesTool,
  searchCodeTool,
  writeFileTool,
  applyPatchTool,
  shellTool,
  gitTool,
  taskTool,
  taskContractTool,
  workingMemoryTool,
  createLspTool,
  createBackgroundJobTools,
};
