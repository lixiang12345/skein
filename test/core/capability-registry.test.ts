import {mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  CapabilityRegistryStore,
  capabilityRouteFingerprint,
  capabilitySha256,
  type CapabilityRouteEpochInput,
} from '../../src/agent/capability-registry.js';
import {createDeterministicEvidenceReceipt} from '../../src/agent/evidence-receipt.js';
import type {DeterministicEvidenceReceipt, RunCompletion, TokenLedgerEntry} from '../../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('capability registry', () => {
  it('opens a new epoch when endpoint, prompt, or tool behavior changes', async () => {
    const root = await workspace();
    const store = new CapabilityRegistryStore(root);
    const first = route('logical-route', 'behavior-a', 'frontend');
    const changed = route('logical-route', 'behavior-b', 'frontend');

    const initial = await store.touchEpochs([first], new Date('2026-01-01T00:00:00.000Z'));
    expect(initial.epochs).toEqual([expect.objectContaining({
      routeFingerprintSha256: first.routeFingerprintSha256,
      epoch: 1,
    })]);

    const next = await store.touchEpochs([changed], new Date('2026-01-02T00:00:00.000Z'));
    expect(next.epochs.map(({routeFingerprintSha256, epoch}) => ({routeFingerprintSha256, epoch}))).toEqual([
      {routeFingerprintSha256: first.routeFingerprintSha256, epoch: 1},
      {routeFingerprintSha256: changed.routeFingerprintSha256, epoch: 2},
    ]);
    expect(next.epochs[1]).toMatchObject({
      componentStatus: 'complete',
      driftReasons: expect.arrayContaining(['endpoint', 'prompt', 'tools', 'generation']),
    });

    const repeated = await store.touchEpochs([first], new Date('2026-01-03T00:00:00.000Z'));
    expect(repeated.epochs.find((entry) => entry.routeFingerprintSha256 === first.routeFingerprintSha256)?.epoch).toBe(1);
  });

  it('learns only from receipt-backed deterministic completion and decays aggregate evidence', async () => {
    const root = await workspace();
    const store = new CapabilityRegistryStore(root);
    const selected = route('logical-route', 'behavior-a', 'backend');
    const success = completion('verified', true, 'a');
    const failure = completion('verification_failed', false, 'b');

    const first = await store.recordVerifiedRun({
      route: selected,
      ...success,
      metrics: {inputTokens: 60, outputTokens: 40, latencyMs: 1_000},
      halfLifeDays: 30,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(first).toMatchObject({recorded: true, reason: 'verified'});

    const rejected = await store.recordVerifiedRun({
      route: selected,
      completion: {...success.completion, status: 'unverified'},
      receipts: success.receipts,
      now: new Date('2026-01-02T00:00:00.000Z'),
    });
    expect(rejected).toEqual({recorded: false, reason: 'inadmissible'});

    const second = await store.recordVerifiedRun({
      route: selected,
      ...failure,
      failureReason: 'reviewer_reject',
      metrics: {inputTokens: 150, outputTokens: 50, latencyMs: 2_000, toolFailures: 1},
      halfLifeDays: 30,
      now: new Date('2026-01-31T00:00:00.000Z'),
    });
    expect(second).toMatchObject({recorded: true, reason: 'reviewer_reject'});
    expect(second.aggregate?.counts).toMatchObject({
      verifiedSuccess: 1,
      verifiedFailure: 1,
      reviewerReject: 1,
      toolFailure: 1,
    });
    expect(second.aggregate?.decayed).toMatchObject({
      samples: 1.5,
      verifiedSuccess: 0.5,
      verifiedFailure: 1,
      tokenTotal: 250,
      latencyMsTotal: 2_500,
      toolFailures: 1,
    });
    expect((await store.snapshot()).health[0]).toMatchObject({status: 'degraded', consecutiveFailures: 1});

    const duplicate = await store.recordVerifiedRun({
      route: selected,
      ...failure,
      failureReason: 'reviewer_reject',
      now: new Date('2026-01-31T00:01:00.000Z'),
    });
    expect(duplicate).toMatchObject({recorded: false, reason: 'duplicate'});
    expect((await store.snapshot()).observations[0]?.counts.verifiedFailure).toBe(1);

    const nonConsecutiveDuplicate = await store.recordVerifiedRun({
      route: selected,
      ...success,
      now: new Date('2026-02-01T00:02:00.000Z'),
    });
    expect(nonConsecutiveDuplicate).toMatchObject({recorded: false, reason: 'duplicate'});
    expect((await store.snapshot()).observations[0]?.counts).toMatchObject({
      verifiedSuccess: 1,
      verifiedFailure: 1,
    });
  });

  it('persists only bounded hashes and aggregates in an owner-only file', async () => {
    const root = await workspace();
    const store = new CapabilityRegistryStore(root);
    const selected = route('logical-route', 'behavior-a', 'security');
    await store.recordVerifiedRun({
      route: selected,
      completion: {
        ...completion('verified', true, 'privacy').completion,
        detail: 'Do not persist this model summary or https://secret-relay.example/v1.',
      },
      receipts: completion('verified', true, 'privacy').receipts,
      metrics: {inputTokens: 12, outputTokens: 3, latencyMs: 25},
      now: new Date('2026-02-01T00:00:00.000Z'),
    });
    await store.pin(selected, new Date('2026-02-01T00:00:01.000Z'));

    const raw = await readFile(store.file, 'utf8');
    expect(raw).not.toContain('secret-relay');
    expect(raw).not.toContain('model summary');
    expect(raw).not.toContain('privacy');
    expect(raw).not.toContain('OPENAI_API_KEY');
    expect(JSON.parse(raw)).toMatchObject({version: 2, observations: [expect.any(Object)], pins: [expect.any(Object)]});
    if (process.platform !== 'win32') expect((await stat(store.file)).mode & 0o777).toBe(0o600);
  });

  it('rejects forged receipts and serializes concurrent aggregate writers', async () => {
    const root = await workspace();
    const selected = route('logical-route', 'behavior-a', 'backend');
    const validA = completion('verified', true, 'concurrent-a');
    const validB = completion('verified', true, 'concurrent-b');
    const forged = {...validA.receipts[0]!, outputSha256: capabilitySha256('forged-output')};
    const rejected = await new CapabilityRegistryStore(root).recordVerifiedRun({
      route: selected,
      completion: validA.completion,
      receipts: [forged],
    });
    expect(rejected).toEqual({recorded: false, reason: 'inadmissible'});

    const left = new CapabilityRegistryStore(root);
    const right = new CapabilityRegistryStore(root);
    await Promise.all([
      left.recordVerifiedRun({route: selected, ...validA, now: new Date('2026-02-02T00:00:00.000Z')}),
      right.recordVerifiedRun({route: selected, ...validB, now: new Date('2026-02-02T00:00:01.000Z')}),
    ]);
    const aggregate = (await left.snapshot()).observations[0];
    expect(aggregate?.counts).toMatchObject({verifiedSuccess: 2, verifiedFailure: 0});
  });

  it('resets observations, epochs, and pins without leaving a stale decision', async () => {
    const root = await workspace();
    const store = new CapabilityRegistryStore(root);
    const selected = route('logical-route', 'behavior-a', 'reviewer');
    await store.touchEpochs([selected]);
    await store.pin(selected);
    const reset = await store.reset(new Date('2026-03-01T00:00:00.000Z'));
    expect(reset).toMatchObject({version: 2, epochs: [], observations: [], pins: [], health: []});
    expect(await store.snapshot()).toEqual(reset);
  });

  it('fails closed for corrupted, oversized, and wrong-workspace registries', async () => {
    const root = await workspace();
    const store = new CapabilityRegistryStore(root);
    await store.touchEpochs([route('logical-route', 'behavior-a', 'backend')]);
    await writeFile(store.file, '{not-json', {mode: 0o600});
    await expect(store.snapshot()).rejects.toThrow();

    await writeFile(store.file, 'x'.repeat(4_000_001), {mode: 0o600});
    await expect(store.snapshot()).rejects.toThrow('exceeds the 4 MB limit');

    const other = await workspace();
    const otherStore = new CapabilityRegistryStore(other);
    await mkdir(dirname(otherStore.file), {recursive: true});
    const original = new CapabilityRegistryStore(root);
    await original.reset(new Date('2026-03-02T00:00:00.000Z'));
    await writeFile(otherStore.file, await readFile(original.file), {mode: 0o600});
    await expect(otherStore.snapshot()).rejects.toThrow('workspace identity does not match');
  });

  it('rejects a symlinked registry file', async () => {
    const root = await workspace();
    const store = new CapabilityRegistryStore(root);
    await mkdir(dirname(store.file), {recursive: true});
    const outside = join(await workspace(), 'outside-registry.json');
    await writeFile(outside, '{}', {mode: 0o600});
    await symlink(outside, store.file);
    await expect(store.snapshot()).rejects.toThrow('not a regular file');
  });

  it('migrates v1 registries and backfills complete component epochs on first touch', async () => {
    const root = await workspace();
    const store = new CapabilityRegistryStore(root);
    const selected = route('logical-route', 'behavior-a', 'backend');
    await store.recordVerifiedRun({route: selected, ...completion('verified', true, 'legacy')});
    const current = JSON.parse(await readFile(store.file, 'utf8')) as Record<string, unknown> & {
      epochs: Array<Record<string, unknown>>;
      observations: Array<Record<string, unknown>>;
    };
    current.version = 1;
    current.epochs = current.epochs.map(({components, componentStatus, driftReasons, ...epoch}) => epoch);
    current.observations = current.observations.map(({tokenLedger, ...observation}) => observation);
    delete current.health;
    await writeFile(store.file, `${JSON.stringify(current, null, 2)}\n`, {mode: 0o600});

    const migrated = await store.snapshot();
    expect(migrated).toMatchObject({version: 2, health: []});
    expect(migrated.epochs[0]).toMatchObject({componentStatus: 'legacy', driftReasons: ['legacy']});
    const backfilled = await store.touchEpochs([selected]);
    expect(backfilled.epochs[0]).toMatchObject({componentStatus: 'complete', components: selected.components});
  });

  it('links authoritative Token Ledger receipts without storing request content', async () => {
    const root = await workspace();
    const store = new CapabilityRegistryStore(root);
    const selected = route('logical-route', 'behavior-a', 'backend');
    const ledger = tokenLedger('request-private', 80, 20);
    const recorded = await store.recordVerifiedRun({
      route: selected,
      ...completion('verified', true, 'ledger'),
      metrics: {inputTokens: 80, outputTokens: 20, tokenLedger: [ledger]},
    });
    expect(recorded.aggregate).toMatchObject({
      decayed: {tokenTotal: 100},
      tokenLedger: {
        linkedRequests: 1,
        actualInputTokens: 80,
        actualOutputTokens: 20,
        recentReceiptSha256: [expect.stringMatching(/^[a-f0-9]{64}$/u)],
      },
    });
    expect(await readFile(store.file, 'utf8')).not.toContain('request-private');
    await expect(store.recordVerifiedRun({
      route: selected,
      ...completion('verified', true, 'ledger-mismatch'),
      metrics: {inputTokens: 81, outputTokens: 20, tokenLedger: [ledger]},
    })).rejects.toThrow('must match the linked Token Ledger');
  });

  it('degrades, quarantines, and recovers only after consecutive passing canaries', async () => {
    const root = await workspace();
    const store = new CapabilityRegistryStore(root);
    const selected = route('logical-route', 'behavior-a', 'reviewer');
    const failedOne = canary('canary-fail-1', false);
    const failedTwo = canary('canary-fail-2', false);
    const passedOne = canary('canary-pass-1', true);
    const passedTwo = canary('canary-pass-2', true);

    expect(await store.recordCanary({route: selected, receipt: failedOne, failure: 'schema_mismatch'}))
      .toMatchObject({recorded: true, reason: 'failed', health: {status: 'degraded'}});
    expect(await store.recordCanary({route: selected, receipt: failedTwo, failure: 'provider_error'}))
      .toMatchObject({health: {status: 'quarantined', consecutiveFailures: 2}});
    expect(await store.recordCanary({route: selected, receipt: passedOne}))
      .toMatchObject({health: {status: 'quarantined', recoveryCanaryPasses: 1}});
    expect(await store.recordCanary({route: selected, receipt: passedTwo}))
      .toMatchObject({health: {status: 'healthy', recoveryCanaryPasses: 0}});
    expect(await store.recordCanary({route: selected, receipt: passedTwo}))
      .toMatchObject({recorded: false, reason: 'duplicate'});
    await expect(store.recordCanary({route: selected, receipt: canary('invalid-pass-reason', true),
      failure: 'provider_error'})).rejects.toThrow('Passing capability canaries');
  });

  it('rejects forged component fingerprints, unrelated canary tools, and tampered health state', async () => {
    const root = await workspace();
    const store = new CapabilityRegistryStore(root);
    const selected = route('logical-route', 'behavior-a', 'reviewer');
    await expect(store.touchEpochs([{
      ...selected,
      components: {...selected.components, promptSha256: capabilitySha256('forged-prompt')},
    }])).rejects.toThrow('fingerprint does not match');
    const unrelated = createDeterministicEvidenceReceipt({
      toolCallId: 'ordinary-check', tool: 'shell', arguments: {command: 'true'}, ok: true, content: 'passed',
    });
    expect(await store.recordCanary({route: selected, receipt: unrelated}))
      .toEqual({recorded: false, reason: 'inadmissible'});

    await store.recordCanary({route: selected, receipt: canary('health-integrity', false)});
    const persisted = JSON.parse(await readFile(store.file, 'utf8')) as {health: Array<Record<string, unknown>>};
    persisted.health[0]!.status = 'healthy';
    await writeFile(store.file, `${JSON.stringify(persisted, null, 2)}\n`, {mode: 0o600});
    await expect(store.snapshot()).rejects.toThrow('health integrity check failed');
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skein-capability-registry-'));
  roots.push(root);
  return root;
}

function route(identity: string, behavior: string, task: string): CapabilityRouteEpochInput {
  const routeIdentitySha256 = capabilitySha256(identity);
  const components = {
    modelSha256: capabilitySha256(`${identity}:model`),
    endpointSha256: capabilitySha256(`${behavior}:endpoint`),
    authSha256: capabilitySha256(`${identity}:auth`),
    promptSha256: capabilitySha256(`${behavior}:prompt`),
    toolCatalogSha256: capabilitySha256(`${behavior}:tools`),
    generationSha256: capabilitySha256(`${behavior}:generation`),
  };
  return {
    routeIdentitySha256,
    routeFingerprintSha256: capabilityRouteFingerprint({routeIdentitySha256, components}),
    taskFingerprintSha256: capabilitySha256(task),
    components,
  };
}

function canary(seed: string, ok: boolean): DeterministicEvidenceReceipt {
  return createDeterministicEvidenceReceipt({
    toolCallId: seed,
    tool: 'capability_canary',
    arguments: {fixture: capabilitySha256(seed)},
    ok,
    content: ok ? 'passed' : 'failed',
  });
}

function tokenLedger(requestId: string, inputTokens: number, outputTokens: number): TokenLedgerEntry {
  return {
    requestId,
    turn: 1,
    recordedAt: '2026-02-01T00:00:00.000Z',
    estimated: {
      stableTokens: 10,
      dynamicTokens: 5,
      retrievedTokens: 3,
      conversationTokens: 40,
      toolResultTokens: 2,
      toolSchemaTokens: 20,
      estimatedInputTokens: inputTokens,
      outputAllowanceTokens: outputTokens,
      outputTokens,
    },
    actual: {inputTokens, outputTokens, cachedInputTokens: 10, reasoningTokens: 4},
    inputSource: 'actual',
    outputSource: 'actual',
    tools: {loaded: ['read_file'], deferredCount: 0},
    retrieval: {engine: 'local', discarded: []},
  };
}

function completion(status: RunCompletion['status'], ok: boolean, seed: string): {
  completion: RunCompletion;
  receipts: DeterministicEvidenceReceipt[];
} {
  const receipt = createDeterministicEvidenceReceipt({
    toolCallId: `check-${seed}`,
    tool: 'shell',
    arguments: {command: `npm test -- ${seed}`},
    ok,
    content: ok ? 'passed' : 'failed',
  });
  return {completion: {
    status,
    changedFiles: ['src/index.ts'],
    detail: 'Content-free deterministic completion.',
    checks: [{
      toolCallId: `check-${seed}`,
      receiptId: receipt.id,
      tool: 'shell',
      command: `npm test -- ${seed}`,
      kind: 'test',
      ok,
    }],
  }, receipts: [receipt]};
}
