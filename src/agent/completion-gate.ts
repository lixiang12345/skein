import {createHash} from 'node:crypto';
import type {
  RunCompletion,
  ToolCall,
  ToolResult,
  VerificationEvidence,
  VerificationKind,
} from '../types.js';
import {commandForCall} from '../tools/permissions.js';

export interface CapturedVerification extends VerificationEvidence {
  changeSequence: number;
  commandKey: string;
}

export function captureVerification(
  call: ToolCall,
  result: ToolResult,
  changeSequence: number,
  configuredCommands: string[],
): CapturedVerification | undefined {
  if (call.name !== 'shell' && call.name !== 'git') return undefined;
  const command = commandForCall(call);
  if (!command) return undefined;
  const normalized = normalizeCommand(command);
  const configured = new Set(configuredCommands.map(normalizeCommand));
  const kind = configured.has(normalized)
    ? 'configured'
    : classifyVerificationCommand(normalized);
  if (!kind) return undefined;
  return {
    toolCallId: call.id,
    tool: call.name,
    command: redactCommand(command),
    kind,
    ok: result.ok,
    changeSequence,
    commandKey: createHash('sha256').update(normalized).digest('hex'),
  };
}

export function buildRunCompletion(
  changedFiles: Iterable<string>,
  evidence: CapturedVerification[],
  currentChangeSequence: number,
  mutationTracking: 'complete' | 'unknown' = 'complete',
): RunCompletion {
  const files = [...new Set(changedFiles)];
  if (mutationTracking === 'unknown') {
    return {
      status: 'unverified',
      changedFiles: files,
      checks: [],
      detail: files.length
        ? `Workspace changes were observed, but a dynamic shell command prevented complete mutation tracking for ${fileCount(files.length)}.`
        : 'A dynamic shell command may have changed workspace files, but reliable mutation tracking was unavailable.',
      mutationTracking,
    };
  }
  if (!files.length) {
    return {
      status: 'no_changes',
      changedFiles: [],
      checks: [],
      detail: 'No workspace files changed in this run.',
    };
  }

  const latestByCommand = new Map<string, CapturedVerification>();
  for (const item of evidence) {
    if (item.changeSequence === currentChangeSequence) {
      latestByCommand.set(item.commandKey, item);
    }
  }
  const checks = [...latestByCommand.values()].map(publicEvidence);
  if (!checks.length) {
    return {
      status: 'unverified',
      changedFiles: files,
      checks,
      detail: `No successful verification was recorded after the last change to ${fileCount(files.length)}.`,
    };
  }
  const failures = checks.filter((check) => !check.ok);
  if (failures.length) {
    return {
      status: 'verification_failed',
      changedFiles: files,
      checks,
      detail: `${failures.length} of ${checks.length} current verification ${checks.length === 1 ? 'check' : 'checks'} failed.`,
    };
  }
  return {
    status: 'verified',
    changedFiles: files,
    checks,
    detail: `${checks.length} current verification ${checks.length === 1 ? 'check' : 'checks'} passed for ${fileCount(files.length)}.`,
  };
}

export function completionRecoveryDirective(completion: RunCompletion): string {
  if (completion.status === 'verification_failed') {
    const failed = completion.checks
      .filter((check) => !check.ok)
      .map((check) => `- ${check.command} (tool call ${check.toolCallId})`)
      .join('\n');
    return `<runtime-completion-gate status="verification_failed" authorization="none">
The run cannot be marked complete because current verification failed:
${failed}
Inspect the recorded tool output, correct the underlying problem, and rerun the smallest relevant check. Do not repeat the final summary or claim success without a new successful tool result. If the failure cannot be resolved safely, state the exact blocker and leave the result unverified.
</runtime-completion-gate>`;
  }
  const changeSummary = completion.mutationTracking === 'unknown'
    ? 'A dynamic shell command could not be mapped to a complete set of workspace changes.'
    : `The run changed ${fileCount(completion.changedFiles.length)}, but no successful verification command was recorded after the last change.`;
  return `<runtime-completion-gate status="unverified" authorization="none">
${changeSummary}
Run the smallest relevant test, typecheck, lint, build, or git diff --check now. Do not repeat the final summary or claim a check passed without a successful tool result. If verification cannot be run safely, state the exact reason and leave the result unverified.
</runtime-completion-gate>`;
}

export function classifyVerificationCommand(command: string): VerificationKind | undefined {
  const normalized = normalizeCommand(command).toLocaleLowerCase();
  const segments = normalized.split(/\s*(?:&&|\|\||;)\s*/u).filter(Boolean);
  if (segments.length > 1) {
    const kinds = segments.map(classifySingleVerificationCommand);
    if (kinds.every((kind): kind is VerificationKind => kind !== undefined)) {
      return kinds.every((kind) => kind === kinds[0]) ? kinds[0] : 'check';
    }
    return undefined;
  }
  return classifySingleVerificationCommand(normalized);
}

function classifySingleVerificationCommand(command: string): VerificationKind | undefined {
  const value = command.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)+/u, '');
  if (/^git\s+diff\b.*(?:^|\s)--check(?:\s|$)/u.test(value)) return 'diff';
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test(?::[^\s]+)?|test|vitest|jest)(?:\s|$)/u.test(value) ||
    /^(?:npx|pnpx|bunx)\s+(?:vitest|jest)(?:\s|$)/u.test(value) ||
    /^(?:python(?:\d+(?:\.\d+)*)?\s+-m\s+)?pytest(?:\s|$)/u.test(value) ||
    /^(?:cargo|go|dotnet|mvn|mvnw|gradle|gradlew)\s+(?:test|verify)(?:\s|$)/u.test(value) ||
    /^(?:make|just|task)\s+(?:test|verify)(?:\s|$)/u.test(value) ||
    /^node\s+--test(?:\s|$)/u.test(value)) return 'test';
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|check:types)(?:\s|$)/u.test(value) ||
    /^(?:npx|pnpx|bunx)\s+(?:tsc|pyright|mypy)(?:\s|$)/u.test(value) ||
    /^(?:tsc|pyright|mypy)(?:\s|$)/u.test(value) ||
    /^cargo\s+check(?:\s|$)/u.test(value)) return 'typecheck';
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint(?:\s|$)/u.test(value) ||
    /^(?:npx|pnpx|bunx)\s+(?:eslint|biome|ruff)(?:\s|$)/u.test(value) ||
    /^(?:eslint|biome\s+check|ruff\s+check|cargo\s+clippy)(?:\s|$)/u.test(value)) return 'lint';
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|compile)(?:\s|$)/u.test(value) ||
    /^(?:cargo|go|dotnet|mvn|mvnw|gradle|gradlew)\s+build(?:\s|$)/u.test(value) ||
    /^(?:make|just|task)\s+(?:build|compile)(?:\s|$)/u.test(value)) return 'build';
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?check(?:\s|$)/u.test(value) ||
    /^(?:make|just|task|gradle|gradlew)\s+check(?:\s|$)/u.test(value)) return 'check';
  return undefined;
}

function publicEvidence(item: CapturedVerification): VerificationEvidence {
  return {
    toolCallId: item.toolCallId,
    tool: item.tool,
    command: item.command,
    kind: item.kind,
    ok: item.ok,
  };
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/[\t ]+/gu, ' ');
}

function redactCommand(command: string): string {
  return command
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\b((?:api[_-]?key|access[_-]?token|authorization|password|secret|token))\s*=\s*([^\s]+)/giu, '$1=[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/gu, '[redacted-secret]')
    .trim()
    .slice(0, 2_000);
}

function fileCount(count: number): string {
  return `${count} workspace ${count === 1 ? 'file' : 'files'}`;
}
