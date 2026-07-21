import type {ContextProvider} from './types.js';
import {applyPatchTool} from './apply-patch.js';
import {gitTool} from './git.js';
import {listFilesTool} from './list.js';
import {readFileTool} from './read.js';
import {ToolRegistry} from './registry.js';
import {searchCodeTool} from './search.js';
import {shellTool} from './shell.js';
import {taskTool} from './task.js';
import {workingMemoryTool} from './working-memory.js';
import {writeFileTool} from './write.js';

export interface DefaultToolRegistryOptions {
  /** Reserved for callers that want the registry to document its semantic engine. */
  contextEngine?: ContextProvider;
}

export function createDefaultToolRegistry(
  _options: DefaultToolRegistryOptions = {},
): ToolRegistry {
  return new ToolRegistry([
    readFileTool,
    listFilesTool,
    searchCodeTool,
    writeFileTool,
    applyPatchTool,
    shellTool,
    gitTool,
    taskTool,
    workingMemoryTool,
  ]);
}

export {ToolRegistry} from './registry.js';
export {WorkspaceAccess} from './workspace.js';
export {evaluatePermission, commandForCall, permissionKey, permissionTarget} from './permissions.js';
export type {
  AgentTool,
  ToolExecution,
  ToolExecutionContext,
  ContextProvider,
} from './types.js';
export {ToolExecutionError, ToolInputError} from './types.js';
export {
  readFileTool,
  listFilesTool,
  searchCodeTool,
  writeFileTool,
  applyPatchTool,
  shellTool,
  gitTool,
  taskTool,
  workingMemoryTool,
};
