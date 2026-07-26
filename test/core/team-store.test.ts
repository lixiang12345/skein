import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {TeamRunStore} from '../../src/agent/team-store.js';
import {routeCostReceipt} from '../../src/agent/route-cost.js';
import {
  buildWriterReviewContract,
  makeReviewEvidence,
  parseReviewVerdict,
  reviewArtifactSha256,
  reviewArtifactText,
} from '../../src/agent/review-verdict.js';
import {
  assessReviewIndependence,
  buildReviewRouteIdentity,
  reviewCriterionConflicts,
} from '../../src/agent/review-arbitration.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true}))));

describe('team run blackboard', () => {
  it('persists content-addressed reports and peer messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-team-store-'));
    roots.push(root);
    const store = new TeamRunStore(root);
    const run = await store.create({objective: 'Ship a safe team loop', reviewer: 'reviewer', maxReviewRounds: 1});
    await Promise.all([
      store.recordAgent(run.id, {
        id: randomUUID(), profile: 'backend', provider: 'openai', model: 'gpt-test', phase: 'work', ok: true,
        report: 'State and cancellation are bounded.',
      }),
      store.recordMessage(run.id, {
        id: randomUUID(), from: 'backend', to: 'reviewer', content: 'Please verify cancellation.',
      }),
    ]);
    await expect(store.complete(run.id, {accepted: true, reviewRounds: 0}))
      .rejects.toThrow('status is inconsistent');
    await store.complete(run.id, {accepted: false, reviewRounds: 0});
    const loaded = await store.load(run.id);
    expect(loaded.status).toBe('rejected');
    expect(loaded.agents).toHaveLength(1);
    expect(loaded.messages).toHaveLength(1);
    expect(await store.readArtifact(run.id, loaded.agents[0]!.report)).toContain('cancellation');
    expect((await store.list())[0]).toMatchObject({id: run.id, status: 'rejected', agentCount: 1, messageCount: 1});
  });

  it('binds route, cost, hosted search, sources, and reviewer state into provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-team-provenance-'));
    roots.push(root);
    const store = new TeamRunStore(root);
    const run = await store.create({objective: 'Research current APIs', reviewer: 'reviewer', maxReviewRounds: 0});
    const route = buildReviewRouteIdentity({
      runtime: 'api',
      provider: 'compatible',
      protocol: 'openai-responses',
      model: 'research-model',
      endpoint: 'https://relay.example/v1',
    });
    const usage = {
      inputTokens: 1_000,
      outputTokens: 200,
      cachedInputTokens: 100,
      source: 'actual' as const,
    };
    const cost = routeCostReceipt(usage, {
      protocol: 'openai-responses',
      pricingSource: 'connection',
      pricing: {inputPerMillionUsd: 2, outputPerMillionUsd: 8, cachedInputPerMillionUsd: 0.5},
    });
    const exactUrl = 'https://example.com/source?private=query#fragment';
    const urlSha256 = createHash('sha256').update(exactUrl).digest('hex');
    await store.recordAgent(run.id, {
      id: randomUUID(),
      profile: 'researcher',
      provider: 'compatible',
      model: 'research-model',
      phase: 'work',
      ok: true,
      usage,
      cost,
      route,
      hostedTools: [{id: 'ws-1', tool: 'web_search', status: 'completed'}],
      sources: [{
        id: `source:${urlSha256}`,
        type: 'url_citation',
        url: 'https://example.com/source',
        urlSha256,
        title: 'Source',
      }],
      report: 'The current API is documented by the bound source.',
    });
    const loaded = await store.load(run.id);
    expect(loaded).toMatchObject({version: 4, provenance: {
      agentCount: 1,
      hostedToolCalls: 1,
      sourceCount: 1,
      unpricedAgents: 0,
    }});
    if (loaded.version !== 4 || !loaded.provenance) throw new Error('provenance missing');
    const bundle = await store.readArtifact(run.id, loaded.provenance.bundle);
    expect(bundle).toContain(route.routeFingerprintSha256);
    expect(bundle).toContain(loaded.agents[0]!.report.sha256);
    expect(bundle).not.toContain('private=query');

    const manifestPath = join(store.directory, run.id, 'manifest.json');
    const tampered = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      agents: Array<{cost: {amountMicros: number}}>;
    };
    tampered.agents[0]!.cost.amountMicros += 1;
    await writeFile(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
    await expect(store.load(run.id)).rejects.toThrow('cost receipt integrity');
  });

  it('detects tampered artifacts and preserves the original manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-team-store-tamper-'));
    roots.push(root);
    const store = new TeamRunStore(root);
    const run = await store.create({objective: 'Test integrity', reviewer: 'reviewer', maxReviewRounds: 0});
    await store.recordAgent(run.id, {
      id: randomUUID(), profile: 'tester', provider: 'compatible', model: 'test', phase: 'review', ok: true,
      report: 'Original report.',
    });
    const loaded = await store.load(run.id, false);
    const blob = join(store.directory, run.id, 'blobs', `${loaded.agents[0]!.report.sha256}.txt`);
    await writeFile(blob, 'tampered');
    await expect(store.load(run.id)).rejects.toThrow('integrity');
  });

  it('round-trips v4 structured writer evidence and integration rollback coordinates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-team-store-writer-'));
    roots.push(root);
    const store = new TeamRunStore(root);
    const run = await store.create({objective: 'Prepare a patch', reviewer: 'reviewer', maxReviewRounds: 0});
    const patch = 'diff --git a/source.ts b/source.ts\n';
    const patchSha256 = createHash('sha256').update(patch).digest('hex');
    const contract = buildWriterReviewContract('Prepare a patch');
    const evidence = [makeReviewEvidence({
      kind: 'artifact', status: 'observed', summary: 'Reviewed patch.', subjectSha256: patchSha256,
      payload: {patchSha256},
    })];
    const review = JSON.stringify({
      decision: 'accept',
      criteria: contract.criteria.map((criterion) => ({
        id: criterion.id, status: 'pass', evidence_refs: [evidence[0]!.id,], finding: 'Supported.',
      })),
      residual_risks: [],
      conflicts: [],
    });
    const verdict = parseReviewVerdict(review, {
      contract, artifactSha256: patchSha256, evidence,
      reviewer: {profile: 'reviewer', provider: 'compatible', model: 'judge'},
    });
    const independence = independentRoutes();
    await store.recordWriterLane(run.id, {
      profile: 'implementer',
      reviewer: 'reviewer',
      baseCommit: 'a'.repeat(40),
      outcome: 'accepted',
      patch,
      files: ['source.ts'],
      worktreeCleaned: true,
      contract,
      verdict,
      independence,
      criterionConflicts: reviewCriterionConflicts(contract, verdict),
      review,
      integration: {status: 'ready', checkedAt: new Date().toISOString(), detail: 'Applies cleanly.'},
    });
    await store.recordWriterIntegration(run.id, {
      status: 'integrated',
      checkedAt: new Date().toISOString(),
      integratedAt: new Date().toISOString(),
      detail: 'Integrated with checkpoint.',
      checkpoint: {sessionId: 'session-1', checkpointId: 'checkpoint-1'},
    });
    const loaded = await store.load(run.id);
    expect(loaded.version).toBe(4);
    expect(loaded.version === 4 ? loaded.writer : undefined).toMatchObject({
      profile: 'implementer',
      files: ['source.ts'],
      verdict: {decision: 'accept', artifactSha256: patchSha256},
      integration: {status: 'integrated', checkpoint: {sessionId: 'session-1'}},
    });
    if (loaded.version !== 4 || !loaded.writer) throw new Error('writer record missing');
    expect(await store.readArtifact(run.id, loaded.writer.patch)).toContain('diff --git');
    expect(await store.readArtifact(run.id, loaded.writer.review!)).toContain('"decision":"accept"');
    await expect(store.recordWriterIntegration(run.id, {
      status: 'conflict',
      checkedAt: new Date().toISOString(),
      detail: 'Late competing result.',
    })).rejects.toThrow('cannot be downgraded');

    const manifestPath = join(store.directory, run.id, 'manifest.json');
    const original = await readFile(manifestPath, 'utf8');
    const tamperedIndependence = JSON.parse(original) as {
      writer: {independence: {sufficient: boolean}};
    };
    tamperedIndependence.writer.independence.sufficient = false;
    await writeFile(manifestPath, `${JSON.stringify(tamperedIndependence, null, 2)}\n`);
    await expect(store.load(run.id)).rejects.toThrow('writer verdict integrity');

    const tampered = JSON.parse(original) as {
      writer: {verdict: {artifactSha256: string}};
    };
    tampered.writer.verdict.artifactSha256 = 'b'.repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
    await expect(store.load(run.id)).rejects.toThrow('writer verdict integrity');

    const missingVerdict = JSON.parse(original) as {
      writer: {verdict?: unknown; independence?: unknown; outcome: string; criterionConflicts: unknown[]};
    };
    delete missingVerdict.writer.verdict;
    delete missingVerdict.writer.independence;
    missingVerdict.writer.criterionConflicts = [];
    missingVerdict.writer.outcome = 'accepted';
    await writeFile(manifestPath, `${JSON.stringify(missingVerdict, null, 2)}\n`);
    await expect(store.load(run.id)).rejects.toThrow('writer verdict integrity');
  });

  it('persists and verifies the exact content-addressed council report bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-team-store-council-'));
    roots.push(root);
    const store = new TeamRunStore(root);
    const run = await store.create({objective: 'Review a bounded plan', reviewer: 'reviewer', maxReviewRounds: 0});
    const contract = buildWriterReviewContract('Review a bounded plan');
    const bundle = [{profile: 'architect', ok: true, summary: 'Keep the boundary small.'}];
    const artifact = reviewArtifactText(bundle);
    const artifactSha256 = reviewArtifactSha256(bundle);
    const evidence = [makeReviewEvidence({
      kind: 'model-report', status: 'observed', summary: 'Architect report completed.',
      subjectSha256: artifactSha256, payload: bundle[0],
    })];
    const verdict = parseReviewVerdict(JSON.stringify({
      decision: 'accept',
      criteria: contract.criteria.map((criterion) => ({
        id: criterion.id, status: 'pass', evidence_refs: [evidence[0]!.id],
      })),
      residual_risks: [],
      conflicts: [],
    }), {
      contract, artifactSha256, evidence,
      reviewer: {profile: 'reviewer', provider: 'compatible', model: 'judge'},
    });
    await store.recordReviewVerdict(
      run.id,
      contract,
      verdict,
      artifact,
      independentRoutes(),
      reviewCriterionConflicts(contract, verdict),
    );

    const loaded = await store.load(run.id);
    expect(loaded.version === 4 ? loaded.reviews[0] : undefined).toMatchObject({
      artifact: {sha256: artifactSha256},
      verdict: {decision: 'accept', artifactSha256},
    });
    if (loaded.version !== 4) throw new Error('v4 run missing');
    expect(await store.readArtifact(run.id, loaded.reviews[0]!.artifact)).toBe(artifact);

    const manifestPath = join(store.directory, run.id, 'manifest.json');
    const original = await readFile(manifestPath, 'utf8');
    const tamperedConflict = JSON.parse(original) as {
      reviews: Array<{criterionConflicts: unknown[]}>;
    };
    tamperedConflict.reviews[0]!.criterionConflicts.push({
      version: 1,
      criterionId: contract.criteria[0]!.id,
      kind: 'reviewer-disagreement',
      evidenceRefs: [],
      detail: 'Injected conflict.',
    });
    await writeFile(manifestPath, `${JSON.stringify(tamperedConflict, null, 2)}\n`);
    await expect(store.load(run.id)).rejects.toThrow('independence or conflict integrity');
    await writeFile(manifestPath, original);

    const blob = join(store.directory, run.id, 'blobs', `${artifactSha256}.txt`);
    await writeFile(blob, 'tampered council bundle');
    await expect(store.load(run.id)).rejects.toThrow('artifact integrity');
  });

  it('persists criterion-level human arbitration and closes needs_review only after every required decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-team-store-arbitration-'));
    roots.push(root);
    const store = new TeamRunStore(root);
    const run = await store.create({objective: 'Review a correlated patch', reviewer: 'reviewer', maxReviewRounds: 0});
    const patch = 'diff --git a/source.ts b/source.ts\n';
    const patchSha256 = createHash('sha256').update(patch).digest('hex');
    const contract = buildWriterReviewContract('Review a correlated patch');
    const evidence = [makeReviewEvidence({
      kind: 'artifact', status: 'observed', summary: 'Reviewed patch.', subjectSha256: patchSha256,
      payload: {patchSha256},
    })];
    const verdict = parseReviewVerdict(JSON.stringify({
      decision: 'accept',
      criteria: contract.criteria.map((criterion) => ({
        id: criterion.id, status: 'pass', evidence_refs: [evidence[0]!.id],
      })),
      residual_risks: [], conflicts: [],
    }), {
      contract, artifactSha256: patchSha256, evidence,
      reviewer: {profile: 'reviewer', provider: 'compatible', model: 'same-model'},
    });
    const route = buildReviewRouteIdentity({runtime: 'api', provider: 'compatible', model: 'same-model'});
    const independence = assessReviewIndependence({authors: [route], reviewer: route, highRisk: false});
    await store.recordWriterLane(run.id, {
      profile: 'implementer', reviewer: 'reviewer', baseCommit: 'a'.repeat(40), outcome: 'needs_review',
      patch, files: ['source.ts'], worktreeCleaned: true, contract, verdict, independence,
      criterionConflicts: [],
      integration: {status: 'ready', checkedAt: new Date().toISOString(), detail: 'Applies cleanly.'},
    });
    await store.complete(run.id, {accepted: false, needsReview: true, reviewRounds: 0});
    for (const [index, criterion] of contract.criteria.entries()) {
      const result = await store.arbitrate(run.id, {
        criterionId: criterion.id,
        decision: 'accept',
        reason: 'A human inspected the bound patch and criterion evidence.',
        now: `2026-07-26T01:00:0${index}.000Z`,
      });
      expect(result.gate.status).toBe(index === contract.criteria.length - 1 ? 'accepted' : 'needs_review');
    }
    const loaded = await store.load(run.id);
    expect(loaded).toMatchObject({version: 4, status: 'accepted'});
    if (loaded.version !== 4) throw new Error('v4 run missing');
    expect(loaded.writer?.outcome).toBe('accepted');
    expect(loaded.arbitrations).toHaveLength(contract.criteria.length);
    await expect(store.arbitrate(run.id, {
      criterionId: contract.criteria[0]!.id,
      decision: 'accept',
      reason: 'A duplicate decision should not reopen an accepted run.',
    })).rejects.toThrow('only available while');

    const manifestPath = join(store.directory, run.id, 'manifest.json');
    const original = await readFile(manifestPath, 'utf8');
    const staleStatus = JSON.parse(original) as {status: string};
    staleStatus.status = 'needs_review';
    await writeFile(manifestPath, `${JSON.stringify(staleStatus, null, 2)}\n`);
    await expect(store.load(run.id)).rejects.toThrow('status is inconsistent');

    const tampered = JSON.parse(original) as {
      arbitrations: Array<{reason: string}>;
    };
    tampered.arbitrations[0]!.reason = 'Tampered rationale.';
    await writeFile(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
    await expect(store.load(run.id)).rejects.toThrow('human arbitration integrity');
  });

  it('continues to load legacy v1 manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-team-store-v1-'));
    roots.push(root);
    const store = new TeamRunStore(root);
    const run = await store.create({objective: 'Legacy run', reviewer: 'reviewer', maxReviewRounds: 0});
    const path = join(store.directory, run.id, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    manifest.version = 1;
    delete manifest.reviews;
    delete manifest.arbitrations;
    delete manifest.provenance;
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    const loaded = await store.load(run.id);
    expect(loaded.version).toBe(1);
    expect((await store.list())[0]?.id).toBe(run.id);
  });

  it('continues to load legacy v2 manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-team-store-v2-'));
    roots.push(root);
    const store = new TeamRunStore(root);
    const run = await store.create({objective: 'Legacy v2 run', reviewer: 'reviewer', maxReviewRounds: 0});
    const path = join(store.directory, run.id, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    manifest.version = 2;
    delete manifest.reviews;
    delete manifest.arbitrations;
    delete manifest.provenance;
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(store.load(run.id)).resolves.toMatchObject({version: 2, id: run.id});
  });

  it('continues to load legacy v3 structured manifests without treating them as v4 arbitration state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-team-store-v3-'));
    roots.push(root);
    const store = new TeamRunStore(root);
    const run = await store.create({objective: 'Legacy v3 run', reviewer: 'reviewer', maxReviewRounds: 0});
    const contract = buildWriterReviewContract('Legacy v3 run');
    const artifact = reviewArtifactText({reviewRound: 0, reports: [{summary: 'Legacy evidence.'}]});
    const artifactSha256 = reviewArtifactSha256({reviewRound: 0, reports: [{summary: 'Legacy evidence.'}]});
    const evidence = [makeReviewEvidence({
      kind: 'model-report', status: 'observed', summary: 'Legacy report.',
      subjectSha256: artifactSha256, payload: {summary: 'Legacy evidence.'},
    })];
    const verdict = parseReviewVerdict(JSON.stringify({
      decision: 'accept',
      criteria: contract.criteria.map((criterion) => ({
        id: criterion.id, status: 'pass', evidence_refs: [evidence[0]!.id],
      })),
      residual_risks: [], conflicts: [],
    }), {
      contract, artifactSha256, evidence,
      reviewer: {profile: 'reviewer', provider: 'compatible', model: 'legacy-judge'},
    });
    await store.recordReviewVerdict(run.id, contract, verdict, artifact, independentRoutes());
    const path = join(store.directory, run.id, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as {
      version: number;
      reviews: Array<{independence?: unknown; criterionConflicts?: unknown}>;
      arbitrations?: unknown;
      provenance?: unknown;
    };
    manifest.version = 3;
    delete manifest.arbitrations;
    delete manifest.provenance;
    for (const review of manifest.reviews) {
      delete review.independence;
      delete review.criterionConflicts;
    }
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(store.load(run.id)).resolves.toMatchObject({version: 3, id: run.id});
  });

  it('fails closed on a symlinked run directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-team-store-link-'));
    const outside = await mkdtemp(join(tmpdir(), 'skein-team-store-outside-'));
    roots.push(root, outside);
    const store = new TeamRunStore(root);
    await mkdir(store.directory, {recursive: true});
    await symlink(outside, join(store.directory, randomUUID()));
    await expect(store.list()).resolves.toEqual([]);
  });
});

function independentRoutes() {
  return assessReviewIndependence({
    authors: [buildReviewRouteIdentity({runtime: 'api', provider: 'compatible', model: 'writer-model'})],
    reviewer: buildReviewRouteIdentity({runtime: 'api', provider: 'openai', model: 'judge-model'}),
    highRisk: false,
  });
}
