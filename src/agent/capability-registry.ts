import {createHash} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {z} from 'zod';
import type {DeterministicEvidenceReceipt, RunCompletion, TokenLedgerEntry} from '../types.js';
import {atomicWrite} from '../tools/write.js';
import {canonicalJson} from '../utils/canonical-json.js';
import {
  assertActiveProjectNamespacePath,
  projectNamespacePaths,
  resolveProjectNamespaceSync,
} from '../utils/namespace.js';
import {NamespaceLeaseBusyError, withNamespaceLease} from '../utils/namespace-lease.js';
import {assertNoSymlinkPath, ensureWorkspaceStorageDirectory} from '../utils/storage.js';
import {deterministicEvidenceReceiptValid} from './evidence-receipt.js';
import {
  capabilityRouteHealthIntegrityValid,
  capabilityRouteHealthSchema,
  transitionCapabilityHealth,
  type CapabilityHealthFailure,
  type CapabilityRouteHealth,
} from './capability-health.js';

export const CAPABILITY_REGISTRY_VERSION = 2 as const;
export const DEFAULT_CAPABILITY_HALF_LIFE_DAYS = 30;

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({offset: true});

export const capabilityRouteComponentsSchema = z.object({
  modelSha256: hashSchema,
  endpointSha256: hashSchema,
  authSha256: hashSchema,
  promptSha256: hashSchema,
  toolCatalogSha256: hashSchema,
  generationSha256: hashSchema,
}).strict();

const driftReasonSchema = z.enum(['initial', 'legacy', 'model', 'endpoint', 'auth', 'prompt', 'tools', 'generation']);

const legacyRouteEpochSchema = z.object({
  routeIdentitySha256: hashSchema,
  routeFingerprintSha256: hashSchema,
  taskFingerprintSha256: hashSchema,
  epoch: z.number().int().positive().max(1_000_000),
  firstSeenAt: timestampSchema,
  lastSeenAt: timestampSchema,
}).strict();

const routeEpochSchema = legacyRouteEpochSchema.extend({
  components: capabilityRouteComponentsSchema,
  componentStatus: z.enum(['complete', 'legacy']),
  driftReasons: z.array(driftReasonSchema).min(1).max(8),
}).strict();

const decayedAggregateSchema = z.object({
  samples: z.number().nonnegative().max(1_000_000_000),
  verifiedSuccess: z.number().nonnegative().max(1_000_000_000),
  verifiedFailure: z.number().nonnegative().max(1_000_000_000),
  tokenTotal: z.number().nonnegative().max(1_000_000_000_000),
  latencyMsTotal: z.number().nonnegative().max(1_000_000_000_000),
  toolFailures: z.number().nonnegative().max(1_000_000_000),
  updatedAt: timestampSchema,
}).strict();

const capabilityTokenLedgerAggregateSchema = z.object({
  linkedRequests: z.number().int().nonnegative().max(1_000_000_000),
  actualInputTokens: z.number().int().nonnegative().max(1_000_000_000_000),
  actualOutputTokens: z.number().int().nonnegative().max(1_000_000_000_000),
  estimatedInputTokens: z.number().int().nonnegative().max(1_000_000_000_000),
  estimatedOutputTokens: z.number().int().nonnegative().max(1_000_000_000_000),
  cachedInputTokens: z.number().int().nonnegative().max(1_000_000_000_000),
  cacheWriteInputTokens: z.number().int().nonnegative().max(1_000_000_000_000),
  reasoningTokens: z.number().int().nonnegative().max(1_000_000_000_000),
  recentReceiptSha256: z.array(hashSchema).max(256),
}).strict();

const legacyObservationAggregateSchema = z.object({
  routeIdentitySha256: hashSchema,
  routeFingerprintSha256: hashSchema,
  taskFingerprintSha256: hashSchema,
  epoch: z.number().int().positive().max(1_000_000),
  firstObservedAt: timestampSchema,
  lastObservedAt: timestampSchema,
  lastEvidenceSha256: hashSchema,
  recentEvidenceSha256: z.array(hashSchema).max(256),
  counts: z.object({
    verifiedSuccess: z.number().int().nonnegative().max(1_000_000_000),
    verifiedFailure: z.number().int().nonnegative().max(1_000_000_000),
    regression: z.number().int().nonnegative().max(1_000_000_000),
    rollback: z.number().int().nonnegative().max(1_000_000_000),
    reviewerReject: z.number().int().nonnegative().max(1_000_000_000),
    falseCompletion: z.number().int().nonnegative().max(1_000_000_000),
    toolFailure: z.number().int().nonnegative().max(1_000_000_000),
  }).strict(),
  decayed: decayedAggregateSchema,
}).strict();

const observationAggregateSchema = legacyObservationAggregateSchema.extend({
  tokenLedger: capabilityTokenLedgerAggregateSchema,
}).strict();

const pinSchema = z.object({
  taskFingerprintSha256: hashSchema,
  routeIdentitySha256: hashSchema,
  routeFingerprintSha256: hashSchema,
  pinnedAt: timestampSchema,
}).strict();

export const capabilityRegistrySchema = z.object({
  version: z.literal(CAPABILITY_REGISTRY_VERSION),
  workspaceSha256: hashSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  epochs: z.array(routeEpochSchema).max(4_096),
  observations: z.array(observationAggregateSchema).max(4_096),
  pins: z.array(pinSchema).max(512),
  health: z.array(capabilityRouteHealthSchema).max(4_096),
}).strict();

const legacyCapabilityRegistrySchema = z.object({
  version: z.literal(1),
  workspaceSha256: hashSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  epochs: z.array(legacyRouteEpochSchema).max(4_096),
  observations: z.array(legacyObservationAggregateSchema).max(4_096),
  pins: z.array(pinSchema).max(512),
}).strict();

export type CapabilityRegistrySnapshot = z.infer<typeof capabilityRegistrySchema>;
export type CapabilityRouteEpoch = z.infer<typeof routeEpochSchema>;
export type CapabilityObservationAggregate = z.infer<typeof observationAggregateSchema>;
export type CapabilityPin = z.infer<typeof pinSchema>;
export type CapabilityRouteComponents = z.infer<typeof capabilityRouteComponentsSchema>;

export interface CapabilityRouteEpochInput {
  routeIdentitySha256: string;
  routeFingerprintSha256: string;
  taskFingerprintSha256: string;
  components: CapabilityRouteComponents;
}

export type CapabilityFailureReason =
  | 'verification_failed'
  | 'regression'
  | 'rollback'
  | 'reviewer_reject'
  | 'false_completion'
  | 'tool_failure';

export interface CapabilityObservationMetrics {
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  toolFailures?: number;
  /** Authoritative per-request accounting; only content hashes and bounded totals persist. */
  tokenLedger?: TokenLedgerEntry[];
}

export interface CapabilityObservationResult {
  recorded: boolean;
  reason: 'verified' | CapabilityFailureReason | 'inadmissible' | 'duplicate';
  aggregate?: CapabilityObservationAggregate;
}

export interface CapabilityCanaryResult {
  recorded: boolean;
  reason: 'passed' | 'failed' | 'duplicate' | 'inadmissible';
  health?: CapabilityRouteHealth;
}

/**
 * Project-local capability statistics. The persisted schema contains only
 * content-free hashes and bounded aggregates; raw tasks, prompts, endpoints,
 * model output, source, commands, and credentials are never accepted here.
 */
export class CapabilityRegistryStore {
  readonly workspace: string;
  readonly file: string;
  private readonly managedFile: boolean;
  private writes: Promise<void> = Promise.resolve();

  constructor(workspace: string, file?: string) {
    this.workspace = resolve(workspace);
    this.managedFile = file === undefined;
    this.file = file
      ? resolve(file)
      : join(resolveProjectNamespaceSync(this.workspace).active, 'capability-registry.json');
  }

  async snapshot(): Promise<CapabilityRegistrySnapshot> {
    await this.writes;
    return this.withManagedLease(() => this.readUnlocked());
  }

  async touchEpochs(inputs: CapabilityRouteEpochInput[], now = new Date()): Promise<CapabilityRegistrySnapshot> {
    const timestamp = now.toISOString();
    const unique = uniqueEpochInputs(inputs);
    return this.update((state) => {
      const epochs = [...state.epochs];
      for (const input of unique) touchEpoch(epochs, input, timestamp);
      return {...state, epochs: trimEpochs(epochs)};
    }, timestamp);
  }

  async pin(input: CapabilityRouteEpochInput, now = new Date()): Promise<CapabilityPin> {
    parseEpochInput(input);
    const timestamp = now.toISOString();
    let pin: CapabilityPin | undefined;
    await this.update((state) => {
      const epochs = [...state.epochs];
      touchEpoch(epochs, input, timestamp);
      pin = pinSchema.parse({...identityFields(input), pinnedAt: timestamp});
      return {
        ...state,
        epochs: trimEpochs(epochs),
        pins: [
          ...state.pins.filter((entry) => entry.taskFingerprintSha256 !== input.taskFingerprintSha256),
          pin,
        ].slice(-512),
      };
    }, timestamp);
    return pin as CapabilityPin;
  }

  async unpin(taskFingerprintSha256: string, now = new Date()): Promise<boolean> {
    hashSchema.parse(taskFingerprintSha256);
    const timestamp = now.toISOString();
    let removed = false;
    await this.update((state) => {
      const pins = state.pins.filter((entry) => entry.taskFingerprintSha256 !== taskFingerprintSha256);
      removed = pins.length !== state.pins.length;
      return removed ? {...state, pins} : state;
    }, timestamp, false);
    return removed;
  }

  async reset(now = new Date()): Promise<CapabilityRegistrySnapshot> {
    const timestamp = now.toISOString();
    const empty = emptyRegistry(this.workspace, timestamp);
    await this.queueWrite(() => this.withManagedLease(() => this.writeUnlocked(empty)));
    return empty;
  }

  /**
   * Record only a deterministic completion outcome from the current receipt
   * schema. Reviewer prose, agent self-report, no-change runs, and unverified
   * completions are rejected before any state is written.
   */
  async recordVerifiedRun(input: {
    route: CapabilityRouteEpochInput;
    completion: RunCompletion;
    receipts: DeterministicEvidenceReceipt[];
    metrics?: CapabilityObservationMetrics;
    failureReason?: CapabilityFailureReason;
    halfLifeDays?: number;
    now?: Date;
  }): Promise<CapabilityObservationResult> {
    parseEpochInput(input.route);
    const outcome = admissibleCompletion(input.completion, input.receipts);
    if (!outcome) return {recorded: false, reason: 'inadmissible'};
    const metrics = normalizeMetrics(input.metrics);
    const halfLifeDays = boundedHalfLife(input.halfLifeDays);
    const timestamp = (input.now ?? new Date()).toISOString();
    const reason = outcome === 'success' ? 'verified' : input.failureReason ?? 'verification_failed';
    const evidenceSha256 = capabilitySha256(canonicalJson({
      status: input.completion.status,
      changedFilesSha256: capabilitySha256(canonicalJson([...new Set(input.completion.changedFiles)].sort())),
      checks: input.completion.checks.map((check) => ({
        receiptId: check.receiptId,
        receiptSha256: input.receipts.find((receipt) => receipt.id === check.receiptId)?.sha256,
        tool: check.tool,
        kind: check.kind,
        ok: check.ok,
      })),
    }));
    let aggregate: CapabilityObservationAggregate | undefined;
    let health: CapabilityRouteHealth | undefined;
    let duplicate = false;
    await this.update((state) => {
      const epochs = [...state.epochs];
      const epoch = touchEpoch(epochs, input.route, timestamp);
      const key = observationKey(input.route);
      const current = state.observations.find((entry) => observationKey(entry) === key);
      if (current?.recentEvidenceSha256.includes(evidenceSha256)) {
        duplicate = true;
        aggregate = current;
        return {...state, epochs: trimEpochs(epochs)};
      }
      const next = updateAggregate({
        ...(current ? {current} : {}),
        route: input.route,
        epoch: epoch.epoch,
        outcome,
        reason,
        evidenceSha256,
        metrics,
        halfLifeDays,
        timestamp,
      });
      aggregate = next;
      const currentHealth = state.health.find((entry) => observationKey(entry) === key);
      health = transitionCapabilityHealth(currentHealth, {
        routeFingerprintSha256: input.route.routeFingerprintSha256,
        taskFingerprintSha256: input.route.taskFingerprintSha256,
        epoch: epoch.epoch,
        signal: 'verified-run',
        passed: outcome === 'success',
        evidenceSha256,
        ...(outcome === 'failure' ? {failure: capabilityHealthFailure(reason)} : {}),
        timestamp,
      }).health;
      return {
        ...state,
        epochs: trimEpochs(epochs),
        observations: [
          ...state.observations.filter((entry) => observationKey(entry) !== key),
          next,
        ].sort((left, right) => left.lastObservedAt.localeCompare(right.lastObservedAt)).slice(-4_096),
        health: [
          ...state.health.filter((entry) => observationKey(entry) !== key),
          health,
        ].sort((left, right) => left.lastSignalAt.localeCompare(right.lastSignalAt)).slice(-4_096),
      };
    }, timestamp);
    if (!aggregate) throw new Error('Capability observation was not materialized.');
    if (duplicate) return {recorded: false, reason: 'duplicate', aggregate};
    return {recorded: true, reason, aggregate};
  }

  /** Record a deterministic canary receipt and advance route health. */
  async recordCanary(input: {
    route: CapabilityRouteEpochInput;
    receipt: DeterministicEvidenceReceipt;
    failure?: CapabilityHealthFailure;
    failuresToQuarantine?: number;
    canaryPassesToRecover?: number;
    now?: Date;
  }): Promise<CapabilityCanaryResult> {
    parseEpochInput(input.route);
    if (!deterministicEvidenceReceiptValid(input.receipt, {tool: 'capability_canary'})) {
      return {recorded: false, reason: 'inadmissible'};
    }
    const passed = input.receipt.outcome === 'success';
    if (passed && input.failure) throw new Error('Passing capability canaries cannot include a failure reason.');
    const timestamp = (input.now ?? new Date()).toISOString();
    let health: CapabilityRouteHealth | undefined;
    let duplicate = false;
    await this.update((state) => {
      const epochs = [...state.epochs];
      const epoch = touchEpoch(epochs, input.route, timestamp);
      const key = observationKey(input.route);
      const current = state.health.find((entry) => observationKey(entry) === key);
      const transition = transitionCapabilityHealth(current, {
        routeFingerprintSha256: input.route.routeFingerprintSha256,
        taskFingerprintSha256: input.route.taskFingerprintSha256,
        epoch: epoch.epoch,
        signal: 'canary',
        passed,
        evidenceSha256: input.receipt.sha256,
        ...(!passed ? {failure: input.failure ?? 'provider_error'} : {}),
        timestamp,
        ...(input.failuresToQuarantine === undefined
          ? {} : {failuresToQuarantine: input.failuresToQuarantine}),
        ...(input.canaryPassesToRecover === undefined
          ? {} : {canaryPassesToRecover: input.canaryPassesToRecover}),
      });
      health = transition.health;
      duplicate = transition.duplicate;
      if (duplicate) return {...state, epochs: trimEpochs(epochs)};
      return {
        ...state,
        epochs: trimEpochs(epochs),
        health: [
          ...state.health.filter((entry) => observationKey(entry) !== key),
          transition.health,
        ].sort((left, right) => left.lastSignalAt.localeCompare(right.lastSignalAt)).slice(-4_096),
      };
    }, timestamp);
    if (!health) throw new Error('Capability canary health was not materialized.');
    return {recorded: !duplicate, reason: duplicate ? 'duplicate' : passed ? 'passed' : 'failed', health};
  }

  private async update(
    operation: (state: CapabilityRegistrySnapshot) => CapabilityRegistrySnapshot,
    timestamp: string,
    writeWhenUnchanged = true,
  ): Promise<CapabilityRegistrySnapshot> {
    let result: CapabilityRegistrySnapshot | undefined;
    await this.queueWrite(() => this.withManagedLease(async () => {
      const current = await this.readUnlocked();
      const operated = operation(current);
      if (!writeWhenUnchanged && operated === current) {
        result = current;
        return;
      }
      result = capabilityRegistrySchema.parse({...operated, updatedAt: timestamp});
      await this.writeUnlocked(result);
    }));
    return result as CapabilityRegistrySnapshot;
  }

  private async readUnlocked(): Promise<CapabilityRegistrySnapshot> {
    try {
      await assertNoSymlinkPath(this.workspace, dirname(this.file));
      const info = await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error('Capability registry is not a regular file.');
      }
      if (info.size > 4_000_000) throw new Error('Capability registry exceeds the 4 MB limit.');
      const state = migrateCapabilityRegistry(JSON.parse(await readFile(this.file, 'utf8')) as unknown);
      if (state.workspaceSha256 !== workspaceFingerprint(this.workspace)) {
        throw new Error('Capability registry workspace identity does not match its location.');
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyRegistry(this.workspace, new Date().toISOString());
      }
      throw error;
    }
  }

  private async writeUnlocked(state: CapabilityRegistrySnapshot): Promise<void> {
    const parsed = capabilityRegistrySchema.parse(state);
    if (this.managedFile) {
      assertActiveProjectNamespacePath(this.workspace, this.file);
      await ensureWorkspaceStorageDirectory(this.workspace, dirname(this.file), {requireActiveNamespace: true});
    } else {
      await ensureWorkspaceStorageDirectory(this.workspace, dirname(this.file));
    }
    await atomicWrite(this.file, `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
  }

  private async queueWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.writes.then(operation);
    this.writes = next.catch(() => undefined);
    return next;
  }

  private async withManagedLease<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.managedFile) return operation();
    return withNamespaceLease(projectNamespacePaths(this.workspace).canonical, 'shared', () =>
      withCapabilityFileLease(this.file, operation));
  }
}

export function capabilitySha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function capabilityRouteFingerprint(input: {
  routeIdentitySha256: string;
  components: CapabilityRouteComponents;
}): string {
  hashSchema.parse(input.routeIdentitySha256);
  const components = capabilityRouteComponentsSchema.parse(input.components);
  return capabilitySha256(canonicalJson({version: 2, routeIdentitySha256: input.routeIdentitySha256, components}));
}

function emptyRegistry(workspace: string, timestamp: string): CapabilityRegistrySnapshot {
  return capabilityRegistrySchema.parse({
    version: CAPABILITY_REGISTRY_VERSION,
    workspaceSha256: workspaceFingerprint(workspace),
    createdAt: timestamp,
    updatedAt: timestamp,
    epochs: [],
    observations: [],
    pins: [],
    health: [],
  });
}

function workspaceFingerprint(workspace: string): string {
  return capabilitySha256(`skein-capability-workspace\0${resolve(workspace)}`);
}

function parseEpochInput(input: CapabilityRouteEpochInput): void {
  hashSchema.parse(input.routeIdentitySha256);
  hashSchema.parse(input.routeFingerprintSha256);
  hashSchema.parse(input.taskFingerprintSha256);
  capabilityRouteComponentsSchema.parse(input.components);
  if (capabilityRouteFingerprint(input) !== input.routeFingerprintSha256) {
    throw new Error('Capability route fingerprint does not match its component hashes.');
  }
}

function uniqueEpochInputs(inputs: CapabilityRouteEpochInput[]): CapabilityRouteEpochInput[] {
  if (inputs.length > 4_096) throw new Error('Capability epoch reconciliation exceeds the 4096-route limit.');
  const unique = new Map<string, CapabilityRouteEpochInput>();
  for (const input of inputs) {
    parseEpochInput(input);
    unique.set(observationKey(input), input);
  }
  return [...unique.values()];
}

function touchEpoch(
  epochs: CapabilityRouteEpoch[],
  input: CapabilityRouteEpochInput,
  timestamp: string,
): CapabilityRouteEpoch {
  const exact = epochs.find((entry) => observationKey(entry) === observationKey(input));
  if (exact) {
    exact.lastSeenAt = timestamp;
    if (exact.componentStatus === 'legacy') {
      exact.components = capabilityRouteComponentsSchema.parse(input.components);
      exact.componentStatus = 'complete';
    }
    return exact;
  }
  const previous = epochs.filter((entry) =>
    entry.routeIdentitySha256 === input.routeIdentitySha256 &&
    entry.taskFingerprintSha256 === input.taskFingerprintSha256);
  const epoch = Math.max(0, ...previous.map((entry) => entry.epoch)) + 1;
  const newest = previous.sort((left, right) => right.epoch - left.epoch)[0];
  const driftReasons = newest ? componentDrift(newest.components, input.components) : ['initial' as const];
  const created = routeEpochSchema.parse({
    ...identityFields(input),
    epoch,
    components: input.components,
    componentStatus: 'complete',
    driftReasons: driftReasons.length ? driftReasons : ['generation'],
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
  });
  epochs.push(created);
  return created;
}

function trimEpochs(epochs: CapabilityRouteEpoch[]): CapabilityRouteEpoch[] {
  return epochs.sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt)).slice(-4_096);
}

function observationKey(input: {
  routeFingerprintSha256: string;
  taskFingerprintSha256: string;
}): string {
  return `${input.taskFingerprintSha256}:${input.routeFingerprintSha256}`;
}

function admissibleCompletion(
  completion: RunCompletion,
  receipts: DeterministicEvidenceReceipt[],
): 'success' | 'failure' | undefined {
  if (!completion.checks.length || completion.checks.some((check) => {
    if (!check.receiptId || !/^evidence:[a-f0-9]{64}$/u.test(check.receiptId)) return true;
    const receipt = receipts.find((candidate) => candidate.id === check.receiptId);
    return !deterministicEvidenceReceiptValid(receipt, {
      toolCallId: check.toolCallId,
      tool: check.tool,
      outcome: check.ok ? 'success' : 'failure',
    });
  })) return undefined;
  if (completion.status === 'verified' && completion.checks.every((check) => check.ok)) return 'success';
  if (completion.status === 'verification_failed' && completion.checks.some((check) => !check.ok)) return 'failure';
  return undefined;
}

interface NormalizedCapabilityMetrics {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  toolFailures: number;
  tokenLedger: CapabilityTokenLedgerLink;
}

interface CapabilityTokenLedgerLink {
  linkedRequests: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningTokens: number;
  receiptSha256: string[];
}

function normalizeMetrics(metrics: CapabilityObservationMetrics | undefined): NormalizedCapabilityMetrics {
  const tokenLedger = normalizeTokenLedger(metrics?.tokenLedger);
  const declaredInput = boundedMetric(metrics?.inputTokens, 1_000_000_000);
  const declaredOutput = boundedMetric(metrics?.outputTokens, 1_000_000_000);
  const linkedInput = tokenLedger.actualInputTokens + tokenLedger.estimatedInputTokens;
  const linkedOutput = tokenLedger.actualOutputTokens + tokenLedger.estimatedOutputTokens;
  if (tokenLedger.linkedRequests && ((metrics?.inputTokens !== undefined && declaredInput !== linkedInput) ||
    (metrics?.outputTokens !== undefined && declaredOutput !== linkedOutput))) {
    throw new Error('Capability metrics must match the linked Token Ledger receipts.');
  }
  return {
    inputTokens: tokenLedger.linkedRequests ? linkedInput : declaredInput,
    outputTokens: tokenLedger.linkedRequests ? linkedOutput : declaredOutput,
    latencyMs: boundedMetric(metrics?.latencyMs, 86_400_000),
    toolFailures: boundedMetric(metrics?.toolFailures, 100_000),
    tokenLedger,
  };
}

function boundedMetric(value: number | undefined, maximum: number): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) throw new Error('Capability metrics must be finite non-negative numbers.');
  return Math.min(maximum, Math.floor(value));
}

function boundedHalfLife(value: number | undefined): number {
  const resolved = value ?? DEFAULT_CAPABILITY_HALF_LIFE_DAYS;
  if (!Number.isFinite(resolved) || resolved < 1 || resolved > 365) {
    throw new Error('Capability half-life must be between 1 and 365 days.');
  }
  return resolved;
}

function updateAggregate(input: {
  current?: CapabilityObservationAggregate;
  route: CapabilityRouteEpochInput;
  epoch: number;
  outcome: 'success' | 'failure';
  reason: 'verified' | CapabilityFailureReason;
  evidenceSha256: string;
  metrics: NormalizedCapabilityMetrics;
  halfLifeDays: number;
  timestamp: string;
}): CapabilityObservationAggregate {
  const current = input.current;
  const decayed = decayAggregate(current?.decayed, input.timestamp, input.halfLifeDays);
  decayed.samples = boundedSum(decayed.samples, 1, 1_000_000_000);
  decayed.verifiedSuccess = boundedSum(decayed.verifiedSuccess, input.outcome === 'success' ? 1 : 0, 1_000_000_000);
  decayed.verifiedFailure = boundedSum(decayed.verifiedFailure, input.outcome === 'failure' ? 1 : 0, 1_000_000_000);
  decayed.tokenTotal = boundedSum(decayed.tokenTotal, input.metrics.inputTokens + input.metrics.outputTokens, 1_000_000_000_000);
  decayed.latencyMsTotal = boundedSum(decayed.latencyMsTotal, input.metrics.latencyMs, 1_000_000_000_000);
  decayed.toolFailures = boundedSum(decayed.toolFailures, input.metrics.toolFailures, 1_000_000_000);
  decayed.updatedAt = input.timestamp;
  const counts = current ? {...current.counts} : {
    verifiedSuccess: 0,
    verifiedFailure: 0,
    regression: 0,
    rollback: 0,
    reviewerReject: 0,
    falseCompletion: 0,
    toolFailure: 0,
  };
  counts.verifiedSuccess = boundedInteger(counts.verifiedSuccess + (input.outcome === 'success' ? 1 : 0));
  counts.verifiedFailure = boundedInteger(counts.verifiedFailure + (input.outcome === 'failure' ? 1 : 0));
  if (input.reason === 'regression') counts.regression = boundedInteger(counts.regression + 1);
  if (input.reason === 'rollback') counts.rollback = boundedInteger(counts.rollback + 1);
  if (input.reason === 'reviewer_reject') counts.reviewerReject = boundedInteger(counts.reviewerReject + 1);
  if (input.reason === 'false_completion') counts.falseCompletion = boundedInteger(counts.falseCompletion + 1);
  if (input.reason === 'tool_failure' || input.metrics.toolFailures > 0) {
    counts.toolFailure = boundedInteger(counts.toolFailure + Math.max(1, input.metrics.toolFailures));
  }
  const tokenLedger = current ? {...current.tokenLedger} : emptyTokenLedgerAggregate();
  tokenLedger.linkedRequests = boundedInteger(tokenLedger.linkedRequests + input.metrics.tokenLedger.linkedRequests);
  tokenLedger.actualInputTokens = boundedTokenSum(tokenLedger.actualInputTokens, input.metrics.tokenLedger.actualInputTokens);
  tokenLedger.actualOutputTokens = boundedTokenSum(tokenLedger.actualOutputTokens, input.metrics.tokenLedger.actualOutputTokens);
  tokenLedger.estimatedInputTokens = boundedTokenSum(tokenLedger.estimatedInputTokens, input.metrics.tokenLedger.estimatedInputTokens);
  tokenLedger.estimatedOutputTokens = boundedTokenSum(tokenLedger.estimatedOutputTokens, input.metrics.tokenLedger.estimatedOutputTokens);
  tokenLedger.cachedInputTokens = boundedTokenSum(tokenLedger.cachedInputTokens, input.metrics.tokenLedger.cachedInputTokens);
  tokenLedger.cacheWriteInputTokens = boundedTokenSum(tokenLedger.cacheWriteInputTokens, input.metrics.tokenLedger.cacheWriteInputTokens);
  tokenLedger.reasoningTokens = boundedTokenSum(tokenLedger.reasoningTokens, input.metrics.tokenLedger.reasoningTokens);
  tokenLedger.recentReceiptSha256 = [
    ...tokenLedger.recentReceiptSha256,
    ...input.metrics.tokenLedger.receiptSha256,
  ].slice(-256);
  return observationAggregateSchema.parse({
    ...identityFields(input.route),
    epoch: input.epoch,
    firstObservedAt: current?.firstObservedAt ?? input.timestamp,
    lastObservedAt: input.timestamp,
    lastEvidenceSha256: input.evidenceSha256,
    recentEvidenceSha256: [
      ...(current?.recentEvidenceSha256 ?? []),
      input.evidenceSha256,
    ].slice(-256),
    counts,
    decayed,
    tokenLedger,
  });
}

function decayAggregate(
  current: CapabilityObservationAggregate['decayed'] | undefined,
  timestamp: string,
  halfLifeDays: number,
): CapabilityObservationAggregate['decayed'] {
  if (!current) return {
    samples: 0,
    verifiedSuccess: 0,
    verifiedFailure: 0,
    tokenTotal: 0,
    latencyMsTotal: 0,
    toolFailures: 0,
    updatedAt: timestamp,
  };
  const elapsedMs = Math.max(0, Date.parse(timestamp) - Date.parse(current.updatedAt));
  const factor = Math.exp(-Math.LN2 * elapsedMs / (halfLifeDays * 86_400_000));
  return {
    samples: current.samples * factor,
    verifiedSuccess: current.verifiedSuccess * factor,
    verifiedFailure: current.verifiedFailure * factor,
    tokenTotal: current.tokenTotal * factor,
    latencyMsTotal: current.latencyMsTotal * factor,
    toolFailures: current.toolFailures * factor,
    updatedAt: timestamp,
  };
}

function boundedInteger(value: number): number {
  return Math.min(1_000_000_000, value);
}

function boundedSum(left: number, right: number, maximum: number): number {
  return Math.min(maximum, left + right);
}

function boundedTokenSum(left: number, right: number): number {
  return boundedSum(left, right, 1_000_000_000_000);
}

function componentDrift(
  previous: CapabilityRouteComponents,
  current: CapabilityRouteComponents,
): Array<z.infer<typeof driftReasonSchema>> {
  const reasons: Array<z.infer<typeof driftReasonSchema>> = [];
  if (previous.modelSha256 !== current.modelSha256) reasons.push('model');
  if (previous.endpointSha256 !== current.endpointSha256) reasons.push('endpoint');
  if (previous.authSha256 !== current.authSha256) reasons.push('auth');
  if (previous.promptSha256 !== current.promptSha256) reasons.push('prompt');
  if (previous.toolCatalogSha256 !== current.toolCatalogSha256) reasons.push('tools');
  if (previous.generationSha256 !== current.generationSha256) reasons.push('generation');
  return reasons;
}

const tokenLedgerLinkSchema = z.object({
  requestId: z.string().min(1).max(256),
  turn: z.number().int().positive().max(1_000_000),
  recordedAt: timestampSchema,
  estimated: z.object({
    estimatedInputTokens: z.number().int().nonnegative().max(1_000_000_000),
    outputTokens: z.number().int().nonnegative().max(1_000_000_000),
  }).passthrough(),
  actual: z.object({
    inputTokens: z.number().int().nonnegative().max(1_000_000_000).optional(),
    outputTokens: z.number().int().nonnegative().max(1_000_000_000).optional(),
    cachedInputTokens: z.number().int().nonnegative().max(1_000_000_000).optional(),
    cacheWriteInputTokens: z.number().int().nonnegative().max(1_000_000_000).optional(),
    reasoningTokens: z.number().int().nonnegative().max(1_000_000_000).optional(),
  }).passthrough(),
  inputSource: z.enum(['actual', 'estimated']),
  outputSource: z.enum(['actual', 'estimated']),
}).passthrough();

function normalizeTokenLedger(entries: TokenLedgerEntry[] | undefined): CapabilityTokenLedgerLink {
  const result: CapabilityTokenLedgerLink = {
    linkedRequests: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    receiptSha256: [],
  };
  if (!entries?.length) return result;
  if (entries.length > 256) throw new Error('Capability Token Ledger linkage exceeds 256 requests.');
  const seen = new Set<string>();
  for (const entry of entries) {
    const parsed = tokenLedgerLinkSchema.parse(entry);
    const receiptSha256 = capabilitySha256(canonicalJson(parsed));
    if (seen.has(receiptSha256)) continue;
    seen.add(receiptSha256);
    const inputTokens = parsed.inputSource === 'actual'
      ? parsed.actual.inputTokens
      : parsed.estimated.estimatedInputTokens;
    const outputTokens = parsed.outputSource === 'actual'
      ? parsed.actual.outputTokens
      : parsed.estimated.outputTokens;
    if (inputTokens === undefined || outputTokens === undefined) {
      throw new Error('Actual Token Ledger linkage requires provider token counts.');
    }
    result.linkedRequests += 1;
    if (parsed.inputSource === 'actual') result.actualInputTokens += inputTokens;
    else result.estimatedInputTokens += inputTokens;
    if (parsed.outputSource === 'actual') result.actualOutputTokens += outputTokens;
    else result.estimatedOutputTokens += outputTokens;
    result.cachedInputTokens += parsed.actual.cachedInputTokens ?? 0;
    result.cacheWriteInputTokens += parsed.actual.cacheWriteInputTokens ?? 0;
    result.reasoningTokens += parsed.actual.reasoningTokens ?? 0;
    result.receiptSha256.push(receiptSha256);
  }
  return result;
}

function emptyTokenLedgerAggregate(): z.infer<typeof capabilityTokenLedgerAggregateSchema> {
  return {
    linkedRequests: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    recentReceiptSha256: [],
  };
}

function capabilityHealthFailure(
  reason: 'verified' | CapabilityFailureReason,
): CapabilityHealthFailure {
  return reason === 'verified' ? 'verification_failed' : reason;
}

function migrateCapabilityRegistry(value: unknown): CapabilityRegistrySnapshot {
  const current = capabilityRegistrySchema.safeParse(value);
  if (current.success) {
    if (current.data.health.some((entry) => !capabilityRouteHealthIntegrityValid(entry))) {
      throw new Error('Capability route health integrity check failed.');
    }
    return current.data;
  }
  const legacy = legacyCapabilityRegistrySchema.parse(value);
  return capabilityRegistrySchema.parse({
    ...legacy,
    version: CAPABILITY_REGISTRY_VERSION,
    epochs: legacy.epochs.map((epoch) => ({
      ...epoch,
      components: {
        modelSha256: epoch.routeFingerprintSha256,
        endpointSha256: epoch.routeFingerprintSha256,
        authSha256: epoch.routeFingerprintSha256,
        promptSha256: epoch.routeFingerprintSha256,
        toolCatalogSha256: epoch.routeFingerprintSha256,
        generationSha256: epoch.routeFingerprintSha256,
      },
      componentStatus: 'legacy',
      driftReasons: ['legacy'],
    })),
    observations: legacy.observations.map((observation) => ({
      ...observation,
      tokenLedger: emptyTokenLedgerAggregate(),
    })),
    health: [],
  });
}

function identityFields(input: CapabilityRouteEpochInput): Omit<CapabilityRouteEpochInput, 'components'> {
  return {
    routeIdentitySha256: input.routeIdentitySha256,
    routeFingerprintSha256: input.routeFingerprintSha256,
    taskFingerprintSha256: input.taskFingerprintSha256,
  };
}

async function withCapabilityFileLease<T>(file: string, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await withNamespaceLease(file, 'exclusive', operation);
    } catch (error) {
      if (!(error instanceof NamespaceLeaseBusyError) || attempt === 19) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw new Error('Capability registry file lease could not be acquired.');
}
