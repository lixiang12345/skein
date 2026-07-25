import {z} from 'zod';
import {
  capabilityHealthFailureSchema,
  capabilityHealthSignalSchema,
  capabilityHealthStatusSchema,
  transitionCapabilityHealth,
} from './capability-health.js';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const routeReplaySchema = z.object({
  fixtureSha256: hashSchema,
  selectedRouteSha256: hashSchema,
  oracleRouteSha256: hashSchema,
  providerSha256: hashSchema,
  modelTier: z.enum(['strong', 'medium', 'other']),
  outcome: z.enum(['verified_success', 'verified_failure']),
  inputTokens: z.number().int().nonnegative().max(1_000_000_000),
  outputTokens: z.number().int().nonnegative().max(1_000_000_000),
  tokenLedgerSha256: hashSchema.optional(),
}).strict();

const judgeBiasProbeSchema = z.object({
  fixtureSha256: hashSchema,
  bias: z.enum(['position', 'verbosity', 'self_preference']),
  forwardWinner: z.enum(['a', 'b', 'tie']),
  reversedWinner: z.enum(['a', 'b', 'tie']),
}).strict();

const degradationSignalSchema = z.object({
  signal: capabilityHealthSignalSchema,
  passed: z.boolean(),
  evidenceSha256: hashSchema,
  failure: capabilityHealthFailureSchema.optional(),
  expectedStatus: capabilityHealthStatusSchema,
}).strict().superRefine((value, context) => {
  if (!value.passed && !value.failure) {
    context.addIssue({code: 'custom', message: 'Failed degradation signals require a failure reason.'});
  }
});

const degradationProbeSchema = z.object({
  fixtureSha256: hashSchema,
  routeFingerprintSha256: hashSchema,
  taskFingerprintSha256: hashSchema,
  signals: z.array(degradationSignalSchema).min(1).max(128),
}).strict();

export const capabilityReplayBundleSchema = z.object({
  version: z.literal(1),
  source: z.enum(['fixture', 'recorded', 'live']),
  routeReplays: z.array(routeReplaySchema).max(4_096),
  judgeBiasProbes: z.array(judgeBiasProbeSchema).max(4_096),
  degradationProbes: z.array(degradationProbeSchema).max(512),
}).strict();

export type CapabilityReplayBundle = z.infer<typeof capabilityReplayBundleSchema>;

export interface CapabilityReplayReport {
  version: 1;
  source: CapabilityReplayBundle['source'];
  routeReplay: {
    samples: number;
    verifiedSuccessRate: number;
    regretRate: number;
    averageTokens: number;
    providerCoverage: number;
    modelTiers: Array<'strong' | 'medium' | 'other'>;
  };
  tokenLedger: {linked: number; coverage: number};
  judgeBias: {
    probes: number;
    covered: Array<'position' | 'verbosity' | 'self_preference'>;
    stable: number;
    stabilityRate: number;
  };
  degradation: {
    probes: number;
    signals: number;
    exactTransitions: number;
    transitionAccuracy: number;
    quarantineObserved: boolean;
    recoveryObserved: boolean;
  };
  gates: {
    routeReplay: boolean;
    tokenLedger: boolean;
    judgeCalibration: boolean;
    degradation: boolean;
    externalValidation: boolean;
    automaticRouting: false;
  };
  readyForAutomaticRouting: false;
  reasons: string[];
}

/** Evaluate content-free replay evidence without calling a provider or changing routing. */
export function evaluateCapabilityReplay(value: unknown): CapabilityReplayReport {
  const bundle = capabilityReplayBundleSchema.parse(value);
  const routeSamples = bundle.routeReplays.length;
  const routeSuccesses = bundle.routeReplays.filter((entry) => entry.outcome === 'verified_success').length;
  const regrets = bundle.routeReplays.filter((entry) =>
    entry.selectedRouteSha256 !== entry.oracleRouteSha256).length;
  const totalTokens = bundle.routeReplays.reduce((total, entry) =>
    total + entry.inputTokens + entry.outputTokens, 0);
  const providers = new Set(bundle.routeReplays.map((entry) => entry.providerSha256));
  const tiers = [...new Set(bundle.routeReplays.map((entry) => entry.modelTier))].sort();
  const linked = bundle.routeReplays.filter((entry) => entry.tokenLedgerSha256).length;
  const biases = ['position', 'verbosity', 'self_preference'] as const;
  const covered = biases.filter((bias) => bundle.judgeBiasProbes.some((probe) => probe.bias === bias));
  const stable = bundle.judgeBiasProbes.filter((probe) => probe.forwardWinner === probe.reversedWinner).length;
  let exactTransitions = 0;
  let degradationSignals = 0;
  let quarantineObserved = false;
  let recoveryObserved = false;
  for (const probe of bundle.degradationProbes) {
    let health;
    let previouslyQuarantined = false;
    for (const signal of probe.signals) {
      const transition = transitionCapabilityHealth(health, {
        routeFingerprintSha256: probe.routeFingerprintSha256,
        taskFingerprintSha256: probe.taskFingerprintSha256,
        epoch: 1,
        signal: signal.signal,
        passed: signal.passed,
        evidenceSha256: signal.evidenceSha256,
        ...(!signal.passed && signal.failure ? {failure: signal.failure} : {}),
        timestamp: new Date(1_700_000_000_000 + degradationSignals * 1_000).toISOString(),
      });
      health = transition.health;
      degradationSignals += 1;
      if (health.status === signal.expectedStatus) exactTransitions += 1;
      if (health.status === 'quarantined') {
        quarantineObserved = true;
        previouslyQuarantined = true;
      }
      if (previouslyQuarantined && health.status === 'healthy') recoveryObserved = true;
    }
  }
  const verifiedSuccessRate = ratio(routeSuccesses, routeSamples);
  const regretRate = ratio(regrets, routeSamples);
  const ledgerCoverage = ratio(linked, routeSamples);
  const stabilityRate = ratio(stable, bundle.judgeBiasProbes.length);
  const transitionAccuracy = ratio(exactTransitions, degradationSignals);
  const routeReplay = routeSamples >= 4 && verifiedSuccessRate >= 0.5 && regretRate <= 0.25 &&
    providers.size >= 2 && tiers.includes('strong') && tiers.includes('medium');
  const tokenLedger = routeSamples > 0 && ledgerCoverage === 1;
  const judgeCalibration = bundle.judgeBiasProbes.length >= 3 && covered.length === biases.length &&
    stabilityRate === 1;
  const degradation = bundle.degradationProbes.length > 0 && transitionAccuracy === 1 &&
    quarantineObserved && recoveryObserved;
  // Replay files are local inputs. A `live` label records provenance intent,
  // but cannot attest an external provider run or human gold set by itself.
  const externalValidation = false;
  const reasons = [
    ...(!routeReplay ? ['Route replay lacks the required samples, provider/tier coverage, success, or regret bound.'] : []),
    ...(!tokenLedger ? ['Every route replay must link a content-addressed Token Ledger receipt.'] : []),
    ...(!judgeCalibration ? ['Position, verbosity, and self-preference probes must all be stable under reversal.'] : []),
    ...(!degradation ? ['Degradation fixtures must exactly exercise quarantine and canary recovery.'] : []),
    ...(bundle.source === 'live'
      ? ['Locally supplied live-labelled evidence is not externally attested.']
      : ['Fixture or recorded evidence is not live provider validation.']),
    'Automatic routing remains unavailable; the only supported modes are off and shadow.',
  ];
  return {
    version: 1,
    source: bundle.source,
    routeReplay: {
      samples: routeSamples,
      verifiedSuccessRate,
      regretRate,
      averageTokens: routeSamples ? totalTokens / routeSamples : 0,
      providerCoverage: providers.size,
      modelTiers: tiers,
    },
    tokenLedger: {linked, coverage: ledgerCoverage},
    judgeBias: {probes: bundle.judgeBiasProbes.length, covered, stable, stabilityRate},
    degradation: {
      probes: bundle.degradationProbes.length,
      signals: degradationSignals,
      exactTransitions,
      transitionAccuracy,
      quarantineObserved,
      recoveryObserved,
    },
    gates: {
      routeReplay,
      tokenLedger,
      judgeCalibration,
      degradation,
      externalValidation,
      automaticRouting: false,
    },
    readyForAutomaticRouting: false,
    reasons,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? numerator / denominator : 0;
}
