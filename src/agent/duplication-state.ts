import type {
  DuplicationAuditReceipt,
  DuplicationCompletionSummary,
  DuplicationSuppressionReceipt,
  SessionAuditEvent,
} from '../types.js';

export function buildDuplicationCompletion(
  audit: SessionAuditEvent[],
  suppressions: DuplicationSuppressionReceipt[] = [],
  runStartedAt?: string,
): DuplicationCompletionSummary | undefined {
  type ActiveMatch = DuplicationAuditReceipt['matches'][number] & {matchId: string};
  const active = new Map<string, ActiveMatch>();
  const unresolved = new Map<string, number>();
  let sawCurrentReceipt = false;
  for (const event of audit) {
    if (runStartedAt && event.createdAt < runStartedAt) continue;
    const receipt = duplicationReceipt(event.metadata?.duplicationAudit);
    if (!receipt) continue;
    if (receipt.status === 'clear' || receipt.status === 'unresolved' ||
      receipt.matches.some((match) => typeof match.matchId === 'string')) sawCurrentReceipt = true;
    const changedPaths = changedPathsFor(event, receipt);
    for (const path of changedPaths) {
      for (const [id, match] of active) if (match.changedPath === path) active.delete(id);
      unresolved.delete(path);
    }
    if (receipt.status === 'unresolved') {
      for (const path of changedPaths) unresolved.set(path, receipt.changeSequence);
    }
    for (const match of receipt.matches) {
      if (typeof match.matchId === 'string') {
        active.set(match.matchId, match as ActiveMatch);
      }
    }
  }
  if (!active.size && !unresolved.size && !sawCurrentReceipt) return undefined;
  const activeIds = new Set(active.keys());
  const suppressedIds = new Set(suppressions
    .filter((item) => activeIds.has(item.matchId))
    .map((item) => item.matchId));
  const warnings = [...active.values()].filter((match) => !suppressedIds.has(match.matchId));
  const suppressedCount = active.size - warnings.length;
  const enforcement = warnings.some((match) => match.kind === 'type-1-or-2') ? 'blocking' : 'warning';
  return {
    enforcement,
    status: unresolved.size
      ? 'unresolved'
      : warnings.length ? 'warning' : suppressedCount ? 'suppressed' : 'clear',
    warningCount: warnings.length,
    unresolvedCount: unresolved.size,
    suppressedCount,
    matches: warnings.slice(0, 8),
  };
}

export function activeDuplicationMatchIds(
  audit: SessionAuditEvent[],
  suppressions: DuplicationSuppressionReceipt[] = [],
): Set<string> {
  const completion = buildDuplicationCompletion(audit, suppressions);
  return new Set(completion?.matches.map((match) => match.matchId) ?? []);
}

export function pruneDuplicationSuppressions(
  audit: SessionAuditEvent[],
  suppressions: DuplicationSuppressionReceipt[] = [],
): DuplicationSuppressionReceipt[] {
  if (!suppressions.length) return [];
  const active = new Set(buildDuplicationCompletion(audit, [])?.matches.map((match) => match.matchId) ?? []);
  return suppressions.filter((item) => active.has(item.matchId)).slice(-64);
}

export function findActiveDuplicationMatches(
  audit: SessionAuditEvent[],
  suppressions: DuplicationSuppressionReceipt[] = [],
): DuplicationAuditReceipt['matches'] {
  return buildDuplicationCompletion(audit, suppressions)?.matches ?? [];
}

export function hasDuplicationActivity(
  audit: SessionAuditEvent[],
  runStartedAt?: string,
): boolean {
  return audit.some((event) =>
    (!runStartedAt || event.createdAt >= runStartedAt) &&
    (duplicationReceipt(event.metadata?.duplicationAudit) !== undefined ||
      event.metadata?.duplicationSuppression !== undefined ||
      event.metadata?.activeDuplicationMatches !== undefined),
  );
}

function duplicationReceipt(value: unknown): DuplicationAuditReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const receipt = value as Partial<DuplicationAuditReceipt>;
  if (!Array.isArray(receipt.matches) || typeof receipt.changeSequence !== 'number' ||
    !['clear', 'warning', 'unresolved'].includes(String(receipt.status))) return undefined;
  return receipt as DuplicationAuditReceipt;
}

function changedPathsFor(
  event: SessionAuditEvent,
  receipt: DuplicationAuditReceipt,
): string[] {
  const metadataPaths = event.metadata?.changedFiles;
  const fromMetadata = Array.isArray(metadataPaths)
    ? metadataPaths.filter((path): path is string => typeof path === 'string')
    : [];
  return [...new Set([...fromMetadata, ...receipt.matches.map((match) => match.changedPath)])];
}
