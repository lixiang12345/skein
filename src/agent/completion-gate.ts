import {createHash} from 'node:crypto';
import {isAbsolute, resolve} from 'node:path';
import type {
  RunCompletion,
  SessionAuditEvent,
  TaskContract,
  ToolCall,
  ToolResult,
  VerificationEvidence,
  VerificationKind,
  DuplicationCompletionSummary,
} from '../types.js';
import {eventsSinceContract} from './task-contract.js';
import {commandForCall} from '../tools/permissions.js';
import {isInside} from '../utils/path.js';

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

export function verificationDiagnosticPaths(
  result: ToolResult,
  workspaceRoots: string[],
): string[] {
  if (result.ok || result.metadata?.sourceTruncated === true ||
    typeof result.metadata?.exitCode !== 'number' || result.metadata.exitCode === 0) return [];
  const roots = workspaceRoots.map((root) => resolve(root));
  const cwd = typeof result.metadata.cwd === 'string' ? resolve(result.metadata.cwd) : undefined;
  const bases = cwd ? [cwd, ...roots] : roots;
  const candidates = new Set<string>();
  const pathPattern = String.raw`((?:[./][^\s():]+|[^\s():]+)\.[A-Za-z0-9]{1,10})`;
  const patterns = [
    new RegExp(`${pathPattern}\\(\\d+,\\d+\\):\\s*(?:error|warning|fatal)\\b`, 'gimu'),
    new RegExp(`${pathPattern}:\\d+:\\d+:\\s*(?:error|warning|fatal)\\b`, 'gimu'),
    new RegExp(`^\\s*(?:FAIL|ERROR)\\s+${pathPattern}`, 'gimu'),
  ];
  // Shell receipts echo the submitted command. That input is not process
  // evidence and can itself contain strings that resemble a source location.
  const output = result.content.slice(0, 200_000)
    .split(/\r?\n/u)
    .filter((line) => !/^\s*Command:/u.test(line))
    .join('\n');
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const candidate = match[1];
      if (!candidate) continue;
      const path = resolveDiagnosticPath(candidate, bases, roots);
      if (path) candidates.add(path);
      if (candidates.size >= 16) return [...candidates];
    }
  }
  return [...candidates];
}

function resolveDiagnosticPath(candidate: string, bases: string[], roots: string[]): string | undefined {
  for (const base of bases) {
    const path = isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate);
    if (roots.some((root) => isInside(root, path))) return path;
  }
  return undefined;
}

export function buildRunCompletion(
  changedFiles: Iterable<string>,
  evidence: CapturedVerification[],
  currentChangeSequence: number,
  mutationTracking: 'complete' | 'unknown' = 'complete',
  taskContract?: TaskContract,
  audit: SessionAuditEvent[] = [],
  duplication?: DuplicationCompletionSummary,
): RunCompletion {
  const files = [...new Set(changedFiles)];
  const acceptance = taskContract
    ? buildAcceptance(taskContract, audit, evidence, currentChangeSequence)
    : undefined;
  if (mutationTracking === 'unknown') {
    return {
      status: 'unverified',
      changedFiles: files,
      checks: [],
      detail: files.length
        ? `Workspace changes were observed, but a dynamic shell command prevented complete mutation tracking for ${fileCount(files.length)}.`
        : 'A dynamic shell command may have changed workspace files, but reliable mutation tracking was unavailable.',
      mutationTracking,
      ...(duplication ? {duplication} : {}),
      ...(acceptance ? {acceptance: acceptanceForCompletion(acceptance, 'unverified')} : {}),
    };
  }
  if (!files.length) {
    if (acceptance && acceptanceUnresolved(acceptance)) {
      return {
        status: 'unverified',
        changedFiles: [],
        checks: [],
        detail: acceptanceDetail(acceptance),
        acceptance: acceptanceForCompletion(acceptance, 'unverified'),
        ...(duplication ? {duplication} : {}),
      };
    }
    return {
      status: 'no_changes',
      changedFiles: [],
      checks: [],
      detail: 'No workspace files changed in this run.',
      ...(acceptance ? {acceptance: acceptanceForCompletion(acceptance, 'no_changes')} : {}),
      ...(duplication ? {duplication} : {}),
    };
  }

  if (duplication?.enforcement === 'blocking' && duplication.warningCount > 0) {
    return {
      status: 'unverified',
      changedFiles: files,
      checks: [],
      detail: 'A high-confidence duplicate implementation requires reuse, extension, or an exact audited suppression before completion.',
      ...(acceptance ? {acceptance: acceptanceForCompletion(acceptance, 'unverified')} : {}),
      duplication,
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
      ...(acceptance ? {acceptance: acceptanceForCompletion(acceptance, 'unverified')} : {}),
      ...(duplication ? {duplication} : {}),
    };
  }
  const failures = checks.filter((check) => !check.ok);
  if (failures.length) {
    return {
      status: 'verification_failed',
      changedFiles: files,
      checks,
      detail: `${failures.length} of ${checks.length} current verification ${checks.length === 1 ? 'check' : 'checks'} failed.`,
      ...(acceptance ? {acceptance: acceptanceForCompletion(acceptance, 'verification_failed')} : {}),
      ...(duplication ? {duplication} : {}),
    };
  }
  if (acceptance && acceptanceUnresolved(acceptance)) {
    return {
      status: 'unverified',
      changedFiles: files,
      checks,
      detail: acceptanceDetail(acceptance),
      acceptance: acceptanceForCompletion(acceptance, 'unverified'),
      ...(duplication ? {duplication} : {}),
    };
  }
  return {
    status: 'verified',
    changedFiles: files,
    checks,
    detail: `${checks.length} current verification ${checks.length === 1 ? 'check' : 'checks'} passed for ${fileCount(files.length)}.`,
    ...(acceptance ? {acceptance: acceptanceForCompletion(acceptance, 'verified')} : {}),
    ...(duplication ? {duplication} : {}),
  };
}

export function completionRecoveryDirective(completion: RunCompletion): string {
  if (completion.duplication?.enforcement === 'blocking' && completion.duplication.warningCount > 0) {
    const matches = completion.duplication.matches
      .filter((match) => match.kind === 'type-1-or-2')
      .map((match) => `- ${match.matchId}: ${match.changedPath} ${match.changedSymbol} duplicates ${match.candidatePath} ${match.candidateSymbol}`)
      .join('\n');
    return `<runtime-completion-gate status="duplication_blocking" authorization="none">
High-confidence Type-1/2 duplication was detected. Reuse or extend the existing implementation, remove the duplicate, or call the read-only duplication_audit tool to suppress an exact match with an audited reason. Suppression never waives verification, safety, accessibility, error handling, concurrency, or correctness requirements.
${matches || '- Active duplicate match details are unavailable.'}
</runtime-completion-gate>`;
  }
  if (completion.acceptance && acceptanceUnresolved(completion.acceptance)) {
    const unresolved = completion.acceptance.unresolved
      .map((item) => `- [${item.status}] ${item.id}: ${item.description}`)
      .join('\n');
    const failed = completion.checks
      .filter((check) => !check.ok)
      .map((check) => `- ${check.command} (tool call ${check.toolCallId})`)
      .join('\n');
    return `<runtime-completion-gate status="acceptance_unresolved" authorization="none">
The run cannot be marked complete while required Task Contract criteria remain unresolved:
${unresolved || '- Acceptance criteria are satisfied.'}${completion.acceptance.missingVerification.length
    ? `\nMissing required verification:\n${completion.acceptance.missingVerification.map((item) => `- ${item}`).join('\n')}`
    : ''}${failed ? `\nCurrent failed checks:\n${failed}` : ''}
Complete or explicitly block only these criteria. Mark a criterion satisfied through task_contract only with successful tool audit evidence or a successful tool-call id. Run the smallest missing verification after the final mutation. Do not repeat the final summary or claim acceptance from prose alone.
</runtime-completion-gate>`;
  }
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

function buildAcceptance(
  contract: TaskContract,
  audit: SessionAuditEvent[],
  evidence: CapturedVerification[],
  currentChangeSequence: number,
): NonNullable<RunCompletion['acceptance']> {
  const contractEvents = eventsSinceContract(audit, contract);
  const successfulEvents = contractEvents.filter((event) =>
    event.type === 'tool' &&
    event.outcome === 'success' &&
    event.tool !== 'task_contract' &&
    event.tool !== 'task' &&
    event.tool !== 'working_memory',
  );
  const latestMutationIndex = contractEvents.reduce((latest, event, index) => {
    const changedFiles = event.metadata?.changedFiles;
    return Array.isArray(changedFiles) && changedFiles.length > 0
      ? index
      : latest;
  }, -1);
  const successfulRefs = new Map<string, {event: SessionAuditEvent; index: number}>();
  for (const event of successfulEvents) {
    const index = contractEvents.indexOf(event);
    successfulRefs.set(event.id, {event, index});
    successfulRefs.set(event.toolCallId, {event, index});
  }
  const required = contract.acceptanceCriteria.filter((item) => item.required);
  const normalized = required.map((item) => {
    const evidenceValid = item.evidenceRefs.some((ref) => {
      const event = successfulRefs.get(ref);
      return event !== undefined && event.index >= latestMutationIndex;
    });
    const status = item.status === 'satisfied' && !evidenceValid ? 'pending' : item.status;
    return {id: item.id, description: item.description, status};
  });
  const satisfied = normalized.filter((item) => item.status === 'satisfied').length;
  const pending = normalized.filter((item) => item.status === 'pending').length;
  const blocked = normalized.filter((item) => item.status === 'blocked').length;
  const currentChecks = evidence.filter((item) => item.changeSequence === currentChangeSequence && item.ok);
  const requirements = contract.verificationRequirements.length
    ? contract.verificationRequirements
    : ['Record at least one successful test, typecheck, lint, build, check, or diff check after the final mutation.'];
  const missingVerification = requirements.filter((requirement) =>
    !verificationRequirementMet(requirement, currentChecks),
  );
  return {
    state: contract.state === 'draft'
      ? 'draft'
      : blocked > 0 ? 'blocked' : pending > 0 || missingVerification.length > 0 ? 'active' : 'satisfied',
    total: normalized.length,
    satisfied,
    pending,
    blocked,
    missingVerification,
    unresolved: normalized.filter((item) => item.status !== 'satisfied'),
  };
}

function acceptanceDetail(acceptance: NonNullable<RunCompletion['acceptance']>): string {
  const parts = [
    acceptance.pending ? `${acceptance.pending} pending` : '',
    acceptance.blocked ? `${acceptance.blocked} blocked` : '',
    acceptance.missingVerification.length ? `${acceptance.missingVerification.length} verification requirements missing` : '',
  ].filter(Boolean).join(' and ');
  const unresolved = acceptance.pending + acceptance.blocked;
  return `Task Contract acceptance is unresolved: ${parts} required ${unresolved === 1 ? 'criterion' : 'criteria'}.`;
}

function verificationRequirementMet(
  requirement: string,
  checks: CapturedVerification[],
): boolean {
  const normalized = normalizeCommand(requirement);
  const broad = normalized.match(/^Record at least one successful (.+) after the final mutation\.?$/iu);
  if (broad) return checks.length > 0;
  const commandKey = createHash('sha256').update(normalized).digest('hex');
  return checks.some((item) => item.commandKey === commandKey);
}

function acceptanceUnresolved(acceptance: NonNullable<RunCompletion['acceptance']>): boolean {
  return acceptance.pending > 0 || acceptance.blocked > 0 || acceptance.missingVerification.length > 0;
}

function acceptanceForCompletion(
  acceptance: NonNullable<RunCompletion['acceptance']>,
  status: RunCompletion['status'],
): NonNullable<RunCompletion['acceptance']> {
  if (acceptance.state === 'draft' || acceptance.state === 'blocked' ||
    status === 'verified' || status === 'no_changes') return acceptance;
  return acceptance.state === 'active' ? acceptance : {...acceptance, state: 'active'};
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
