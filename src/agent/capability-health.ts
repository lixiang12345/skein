import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonicalJson} from '../utils/canonical-json.js';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({offset: true});

export const capabilityHealthStatusSchema = z.enum(['healthy', 'degraded', 'quarantined']);
export const capabilityHealthSignalSchema = z.enum(['verified-run', 'canary']);
export const capabilityHealthFailureSchema = z.enum([
  'verification_failed',
  'regression',
  'rollback',
  'reviewer_reject',
  'false_completion',
  'tool_failure',
  'schema_mismatch',
  'provider_error',
  'latency_regression',
]);

const capabilityRouteHealthBodySchema = z.object({
  routeFingerprintSha256: hashSchema,
  taskFingerprintSha256: hashSchema,
  epoch: z.number().int().positive().max(1_000_000),
  status: capabilityHealthStatusSchema,
  consecutiveFailures: z.number().int().nonnegative().max(1_000_000),
  recoveryCanaryPasses: z.number().int().nonnegative().max(1_000_000),
  signals: z.number().int().nonnegative().max(1_000_000_000),
  canaryRuns: z.number().int().nonnegative().max(1_000_000_000),
  transitions: z.number().int().nonnegative().max(1_000_000_000),
  lastSignal: capabilityHealthSignalSchema,
  lastFailure: capabilityHealthFailureSchema.optional(),
  lastEvidenceSha256: hashSchema,
  recentEvidenceSha256: z.array(hashSchema).max(128),
  lastSignalAt: timestampSchema,
  lastTransitionAt: timestampSchema,
}).strict();

export const capabilityRouteHealthSchema = capabilityRouteHealthBodySchema.extend({
  sha256: hashSchema,
}).strict();

export type CapabilityHealthStatus = z.infer<typeof capabilityHealthStatusSchema>;
export type CapabilityHealthSignal = z.infer<typeof capabilityHealthSignalSchema>;
export type CapabilityHealthFailure = z.infer<typeof capabilityHealthFailureSchema>;
export type CapabilityRouteHealth = z.infer<typeof capabilityRouteHealthSchema>;

export const DEFAULT_CAPABILITY_FAILURES_TO_QUARANTINE = 2;
export const DEFAULT_CAPABILITY_CANARY_PASSES_TO_RECOVER = 2;

export interface CapabilityHealthTransitionInput {
  routeFingerprintSha256: string;
  taskFingerprintSha256: string;
  epoch: number;
  signal: CapabilityHealthSignal;
  passed: boolean;
  evidenceSha256: string;
  failure?: CapabilityHealthFailure;
  timestamp: string;
  failuresToQuarantine?: number;
  canaryPassesToRecover?: number;
}

export interface CapabilityHealthTransition {
  health: CapabilityRouteHealth;
  changed: boolean;
  duplicate: boolean;
}

/**
 * Pure deterministic health transition used by both the Registry and replay
 * fixtures. Quarantine recovery deliberately requires canary evidence; an
 * ordinary successful task cannot silently reactivate a drifting route.
 */
export function transitionCapabilityHealth(
  current: CapabilityRouteHealth | undefined,
  input: CapabilityHealthTransitionInput,
): CapabilityHealthTransition {
  const parsedInput = parseTransitionInput(input);
  if (current && !capabilityRouteHealthIntegrityValid(current)) {
    throw new Error('Capability route health integrity check failed.');
  }
  if (current?.recentEvidenceSha256.includes(parsedInput.evidenceSha256)) {
    return {health: current, changed: false, duplicate: true};
  }
  const failuresToQuarantine = boundedThreshold(
    parsedInput.failuresToQuarantine,
    DEFAULT_CAPABILITY_FAILURES_TO_QUARANTINE,
  );
  const canaryPassesToRecover = boundedThreshold(
    parsedInput.canaryPassesToRecover,
    DEFAULT_CAPABILITY_CANARY_PASSES_TO_RECOVER,
  );
  const previousStatus = current?.status ?? 'healthy';
  let status = previousStatus;
  let consecutiveFailures = current?.consecutiveFailures ?? 0;
  let recoveryCanaryPasses = current?.recoveryCanaryPasses ?? 0;
  if (parsedInput.passed) {
    consecutiveFailures = 0;
    if (previousStatus === 'quarantined') {
      recoveryCanaryPasses = parsedInput.signal === 'canary' ? recoveryCanaryPasses + 1 : 0;
      if (recoveryCanaryPasses >= canaryPassesToRecover) {
        status = 'healthy';
        recoveryCanaryPasses = 0;
      }
    } else {
      recoveryCanaryPasses = 0;
      status = 'healthy';
    }
  } else {
    consecutiveFailures += 1;
    recoveryCanaryPasses = 0;
    status = consecutiveFailures >= failuresToQuarantine ? 'quarantined' : 'degraded';
  }
  const changed = status !== previousStatus;
  const body = capabilityRouteHealthBodySchema.parse({
    routeFingerprintSha256: parsedInput.routeFingerprintSha256,
    taskFingerprintSha256: parsedInput.taskFingerprintSha256,
    epoch: parsedInput.epoch,
    status,
    consecutiveFailures,
    recoveryCanaryPasses,
    signals: boundedCount((current?.signals ?? 0) + 1),
    canaryRuns: boundedCount((current?.canaryRuns ?? 0) + (parsedInput.signal === 'canary' ? 1 : 0)),
    transitions: boundedCount((current?.transitions ?? 0) + (changed ? 1 : 0)),
    lastSignal: parsedInput.signal,
    ...(!parsedInput.passed && parsedInput.failure
      ? {lastFailure: parsedInput.failure}
      : status === 'quarantined' && current?.lastFailure
        ? {lastFailure: current.lastFailure}
        : {}),
    lastEvidenceSha256: parsedInput.evidenceSha256,
    recentEvidenceSha256: [
      ...(current?.recentEvidenceSha256 ?? []),
      parsedInput.evidenceSha256,
    ].slice(-128),
    lastSignalAt: parsedInput.timestamp,
    lastTransitionAt: changed ? parsedInput.timestamp : current?.lastTransitionAt ?? parsedInput.timestamp,
  });
  const health = capabilityRouteHealthSchema.parse({...body, sha256: sha256(canonicalJson(body))});
  return {health, changed, duplicate: false};
}

export function capabilityRouteHealthIntegrityValid(value: unknown): value is CapabilityRouteHealth {
  const parsed = capabilityRouteHealthSchema.safeParse(value);
  if (!parsed.success) return false;
  const {sha256: expected, ...body} = parsed.data;
  return sha256(canonicalJson(body)) === expected;
}

function parseTransitionInput(input: CapabilityHealthTransitionInput): CapabilityHealthTransitionInput {
  hashSchema.parse(input.routeFingerprintSha256);
  hashSchema.parse(input.taskFingerprintSha256);
  hashSchema.parse(input.evidenceSha256);
  timestampSchema.parse(input.timestamp);
  capabilityHealthSignalSchema.parse(input.signal);
  if (!Number.isInteger(input.epoch) || input.epoch < 1 || input.epoch > 1_000_000) {
    throw new Error('Capability health epoch must be a positive bounded integer.');
  }
  if (!input.passed && !input.failure) throw new Error('Failed capability health signals require a failure reason.');
  if (input.failure) capabilityHealthFailureSchema.parse(input.failure);
  return input;
}

function boundedThreshold(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 100) {
    throw new Error('Capability health thresholds must be integers between 1 and 100.');
  }
  return resolved;
}

function boundedCount(value: number): number {
  return Math.min(1_000_000_000, value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
