import type {RunCompletion} from '../types.js';

export const HEADLESS_SCHEMA_VERSION = 1 as const;

export const HEADLESS_EXIT_CODES = {
  completed: 0,
  error: 1,
  needsInput: 2,
  unverified: 3,
  verificationFailed: 4,
  blocked: 5,
  cancelled: 6,
  maxTurns: 7,
  tokenBudget: 8,
  needsReview: 9,
} as const;

export type HeadlessStatus =
  | 'completed'
  | 'verified'
  | 'needs_input'
  | 'needs_review'
  | 'unverified'
  | 'verification_failed'
  | 'blocked'
  | 'cancelled'
  | 'max_turns'
  | 'token_budget'
  | 'error';

export interface HeadlessOutcome {
  schemaVersion: typeof HEADLESS_SCHEMA_VERSION;
  ok: boolean;
  status: HeadlessStatus;
  exitCode: number;
  reason: string;
}

export function resolveHeadlessOutcome(input: {
  reason?: string;
  completion?: RunCompletion;
  error?: unknown;
}): HeadlessOutcome {
  if (input.error !== undefined || input.reason === 'error') {
    return outcome('error', HEADLESS_EXIT_CODES.error, input.reason ?? 'error');
  }
  if (input.reason === 'needs_input') {
    return outcome('needs_input', HEADLESS_EXIT_CODES.needsInput, input.reason);
  }
  if (input.reason === 'needs_review') {
    return outcome('needs_review', HEADLESS_EXIT_CODES.needsReview, input.reason);
  }
  if (input.reason === 'blocked' || input.completion?.acceptance?.state === 'blocked') {
    return outcome('blocked', HEADLESS_EXIT_CODES.blocked, input.reason ?? 'blocked');
  }
  if (input.reason === 'aborted' || input.reason === 'cancelled') {
    return outcome('cancelled', HEADLESS_EXIT_CODES.cancelled, input.reason);
  }
  if (input.reason === 'max_turns') {
    return outcome('max_turns', HEADLESS_EXIT_CODES.maxTurns, input.reason);
  }
  if (input.reason === 'token_budget') {
    return outcome('token_budget', HEADLESS_EXIT_CODES.tokenBudget, input.reason);
  }
  if (input.reason === 'verification_failed' || input.completion?.status === 'verification_failed') {
    return outcome('verification_failed', HEADLESS_EXIT_CODES.verificationFailed, input.reason ?? 'verification_failed');
  }
  if (input.reason === 'unverified' || input.completion?.status === 'unverified') {
    return outcome('unverified', HEADLESS_EXIT_CODES.unverified, input.reason ?? 'unverified');
  }
  if (input.completion?.status === 'verified') {
    return outcome('verified', HEADLESS_EXIT_CODES.completed, input.reason ?? 'completed');
  }
  return outcome('completed', HEADLESS_EXIT_CODES.completed, input.reason ?? 'completed');
}

function outcome(status: HeadlessStatus, exitCode: number, reason: string): HeadlessOutcome {
  return {
    schemaVersion: HEADLESS_SCHEMA_VERSION,
    ok: exitCode === HEADLESS_EXIT_CODES.completed,
    status,
    exitCode,
    reason,
  };
}
