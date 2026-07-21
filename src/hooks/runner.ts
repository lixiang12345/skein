import type {HookConfig} from '../types.js';
import {runShell} from '../utils/process.js';
import type {WorkspaceAccess} from '../tools/workspace.js';

export type HookStage = 'beforeTool' | 'afterTool' | 'afterTurn';

export interface HookResult {
  stage: HookStage;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class HookError extends Error {
  constructor(
    message: string,
    readonly result: HookResult,
  ) {
    super(message);
    this.name = 'HookError';
  }
}

export class HookRunner {
  constructor(
    private readonly config: HookConfig,
    private readonly workspace: WorkspaceAccess,
  ) {}

  async run(
    stage: HookStage,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HookResult[]> {
    const commands = this.config[stage] ?? [];
    const results: HookResult[] = [];
    for (const command of commands) {
      const processResult = await runShell(command, this.workspace.primaryRoot, {
        timeoutMs: 60_000,
        maxOutputBytes: 500_000,
        stdin: `${JSON.stringify(payload)}\n`,
        env: {
          SKEIN_HOOK_STAGE: stage,
          SKEIN_WORKSPACE: this.workspace.primaryRoot,
          MOSAIC_HOOK_STAGE: stage,
          MOSAIC_WORKSPACE: this.workspace.primaryRoot,
        },
        ...(signal ? {signal} : {}),
      });
      const result: HookResult = {
        stage,
        command,
        exitCode: processResult.exitCode,
        stdout: processResult.stdout,
        stderr: processResult.stderr,
        durationMs: processResult.durationMs,
      };
      results.push(result);
      if (result.exitCode !== 0) {
        throw new HookError(
          `${stage} hook failed (${result.exitCode}): ${command}\n` +
          (result.stderr || result.stdout),
          result,
        );
      }
    }
    return results;
  }
}
