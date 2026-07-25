import {relative} from 'node:path';
import type {CompletionStatus, Session, ToolFailureClass} from '../types.js';

export type ReviewScope =
  | {kind: 'working-tree'}
  | {kind: 'commit'; ref: string}
  | {kind: 'branch'; ref: string};

const failureClasses = new Set<ToolFailureClass>([
  'schema_input',
  'unknown_tool',
  'permission_denied',
  'command_exit',
  'timeout',
  'cancelled',
  'hook',
  'execution',
  'no_progress',
  'contract_required',
]);

export interface RedactedReviewBundle {
  version: 1;
  redacted: true;
  sessionId: string;
  scope: ReviewScope;
  changedFiles: string[];
  lastRun?: {
    status: CompletionStatus;
    reason: string;
    checks: Array<{tool: 'shell' | 'git'; kind: string; ok: boolean}>;
    acceptance?: {state: string; satisfied: number; pending: number; blocked: number};
  };
  failures: Array<{
    tool: string;
    category?: string;
    class?: ToolFailureClass;
    retryable?: boolean;
    circuitOpen?: boolean;
  }>;
}

export function parseReviewScope(argument: string): ReviewScope {
  const value = argument.trim();
  if (!value || value === 'working-tree') return {kind: 'working-tree'};
  const [kind, ref, ...extra] = value.split(/\s+/u);
  if ((kind !== 'commit' && kind !== 'branch') || !ref || extra.length) {
    throw new Error('Usage: /review [working-tree|commit <ref>|branch <base-ref>]');
  }
  if (!/^[A-Za-z0-9._/@{}~^+-]{1,200}$/u.test(ref) || ref.startsWith('-')) {
    throw new Error('Review refs must be a single Git revision without control characters or leading dashes.');
  }
  return {kind, ref};
}

export function buildRedactedReviewBundle(
  session: Session,
  workspaceRoot: string,
  scope: ReviewScope,
): RedactedReviewBundle {
  const lastRun = session.lastRun;
  const failures = (session.audit ?? [])
    .filter((event) => event.type === 'tool' && event.outcome === 'failure')
    .slice(-8)
    .map((event) => {
      const receipt = failureReceipt(event.metadata?.failure);
      return {
        tool: event.tool,
        ...(event.category ? {category: event.category} : {}),
        ...(receipt?.class ? {class: receipt.class} : {}),
        ...(receipt?.retryable !== undefined ? {retryable: receipt.retryable} : {}),
        ...(receipt?.circuitOpen !== undefined ? {circuitOpen: receipt.circuitOpen} : {}),
      };
    });
  return {
    version: 1,
    redacted: true,
    sessionId: session.id,
    scope,
    changedFiles: [...new Set(session.changedFiles.map((path) => relative(workspaceRoot, path) || '.'))].sort(),
    ...(lastRun ? {
      lastRun: {
        status: lastRun.status,
        reason: lastRun.reason,
        checks: lastRun.checks.map((check) => ({tool: check.tool, kind: check.kind, ok: check.ok})),
        ...(lastRun.acceptance ? {acceptance: {
          state: lastRun.acceptance.state,
          satisfied: lastRun.acceptance.satisfied,
          pending: lastRun.acceptance.pending,
          blocked: lastRun.acceptance.blocked,
        }} : {}),
      },
    } : {}),
    failures,
  };
}

export function reviewRequest(scope: ReviewScope): string {
  if (scope.kind === 'working-tree') return 'Review the current working tree changes.';
  if (scope.kind === 'commit') return `Review commit ${scope.ref}.`;
  return `Review the current branch against ${scope.ref}.`;
}

export function reviewTurnInstructions(bundle: RedactedReviewBundle): string {
  return `A read-only review is active. Keep the review scope fixed to the bundle below. Do not mutate files, run write-capable tools, or widen the scope. Report actionable findings first with file and line evidence. Never reproduce credentials or secret values. The bundle is deliberately content-free and redacted.\n\n<redacted-review-bundle>\n${JSON.stringify(bundle, null, 2)}\n</redacted-review-bundle>`;
}

function failureReceipt(value: unknown): {
  class?: ToolFailureClass;
  retryable?: boolean;
  circuitOpen?: boolean;
} | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...(isToolFailureClass(record.class) ? {class: record.class} : {}),
    ...(typeof record.retryable === 'boolean' ? {retryable: record.retryable} : {}),
    ...(typeof record.circuitOpen === 'boolean' ? {circuitOpen: record.circuitOpen} : {}),
  };
}

function isToolFailureClass(value: unknown): value is ToolFailureClass {
  return typeof value === 'string' && failureClasses.has(value as ToolFailureClass);
}
