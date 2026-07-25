import {randomUUID} from 'node:crypto';
import type {
  ContextCompactionReceipt,
  ContextEpoch,
  ContextEpochHandoff,
  ContextEpochHandoffReason,
  Session,
  ToolFailureClass,
} from '../types.js';

const MAX_EPOCHS = 64;
const MAX_HANDOFF_FAILURES = 16;

export function activeContextEpoch(session: Session): ContextEpoch {
  return ensureContextEpoch(session);
}

export function ensureContextEpoch(session: Session): ContextEpoch {
  const epochs = session.contextEpochs ?? (session.contextEpochs = []);
  const active = epochs.at(-1);
  if (active && active.finishedAt === undefined) return active;
  const next = createEpoch((active?.index ?? 0) + 1);
  epochs.push(next);
  trimEpochs(epochs);
  return next;
}

export function recordContextEpochUsage(session: Session, inputTokens: number, outputTokens: number): ContextEpoch {
  const epoch = ensureContextEpoch(session);
  epoch.usage.inputTokens += boundedTokens(inputTokens);
  epoch.usage.outputTokens += boundedTokens(outputTokens);
  return epoch;
}

export function contextEpochTokens(session: Session): number {
  const epoch = ensureContextEpoch(session);
  return epoch.usage.inputTokens + epoch.usage.outputTokens;
}

export function rotateContextEpoch(
  session: Session,
  reason: ContextEpochHandoffReason,
  compaction?: ContextCompactionReceipt,
): {previous: ContextEpoch; current: ContextEpoch; handoff: ContextEpochHandoff} {
  const previous = ensureContextEpoch(session);
  const createdAt = new Date().toISOString();
  const handoff = buildEpochHandoff(session, reason, createdAt, compaction);
  previous.finishedAt = createdAt;
  previous.handoff = handoff;
  const current = createEpoch(previous.index + 1, createdAt);
  const epochs = session.contextEpochs ?? (session.contextEpochs = []);
  epochs.push(current);
  trimEpochs(epochs);
  return {previous, current, handoff};
}

function buildEpochHandoff(
  session: Session,
  reason: ContextEpochHandoffReason,
  createdAt: string,
  compaction?: ContextCompactionReceipt,
): ContextEpochHandoff {
  const failures = unresolvedFailureReceipts(session);
  const contract = session.taskContract;
  return {
    reason,
    createdAt,
    ...(compaction ? {compactionReceiptId: compaction.id} : {}),
    ...(session.compactedThroughMessageId
      ? {compactedThroughMessageId: session.compactedThroughMessageId}
      : {}),
    ...(contract ? {
      contract: {
        state: contract.state,
        required: contract.acceptanceCriteria.filter((criterion) => criterion.required).map((criterion) => ({
          id: criterion.id,
          status: criterion.status,
          evidenceRefs: [...criterion.evidenceRefs],
        })),
      },
    } : {}),
    unresolvedFailures: failures,
    changedFiles: [...new Set(session.changedFiles)].slice(-256),
    checks: session.lastRun?.checks.map((check) => ({...check})) ?? [],
  };
}

function unresolvedFailureReceipts(session: Session): Array<{
  signature: string;
  class: ToolFailureClass;
  circuitOpen: boolean;
}> {
  const unresolved = new Map<string, {
    signature: string;
    class: ToolFailureClass;
    circuitOpen: boolean;
  }>();
  for (const event of session.audit ?? []) {
    if (event.type !== 'tool') continue;
    if (event.outcome === 'failure') {
      const receipt = failureReceipt(event.metadata?.failure);
      if (receipt) unresolved.set(receipt.signature, receipt);
      continue;
    }
    const resolved = event.metadata?.resolvedFailureSignatures;
    if (!Array.isArray(resolved)) continue;
    for (const signature of resolved) {
      if (typeof signature === 'string') unresolved.delete(signature);
    }
  }
  return [...unresolved.values()].slice(-MAX_HANDOFF_FAILURES);
}

function failureReceipt(value: unknown): {
  signature: string;
  class: ToolFailureClass;
  circuitOpen: boolean;
} | undefined {
  if (!value || typeof value !== 'object') return;
  const candidate = value as Record<string, unknown>;
  const classes = new Set<ToolFailureClass>([
    'schema_input', 'unknown_tool', 'permission_denied', 'command_exit', 'timeout',
    'cancelled', 'hook', 'execution', 'no_progress', 'contract_required',
  ]);
  if (typeof candidate.signature !== 'string' || !candidate.signature ||
    typeof candidate.class !== 'string' || !classes.has(candidate.class as ToolFailureClass) ||
    typeof candidate.circuitOpen !== 'boolean') return;
  return {
    signature: candidate.signature.slice(0, 256),
    class: candidate.class as ToolFailureClass,
    circuitOpen: candidate.circuitOpen,
  };
}

function createEpoch(index: number, startedAt = new Date().toISOString()): ContextEpoch {
  return {
    id: randomUUID(),
    index,
    startedAt,
    usage: {inputTokens: 0, outputTokens: 0},
  };
}

function trimEpochs(epochs: ContextEpoch[]): void {
  if (epochs.length > MAX_EPOCHS) epochs.splice(0, epochs.length - MAX_EPOCHS);
}

function boundedTokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
