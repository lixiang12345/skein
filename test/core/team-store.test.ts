import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {TeamRunStore} from '../../src/agent/team-store.js';
import {
  buildWriterReviewContract,
  makeReviewEvidence,
  parseReviewVerdict,
  reviewArtifactSha256,
  reviewArtifactText,
} from '../../src/agent/review-verdict.js';

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
    await store.complete(run.id, {accepted: true, reviewRounds: 0});
    const loaded = await store.load(run.id);
    expect(loaded.status).toBe('accepted');
    expect(loaded.agents).toHaveLength(1);
    expect(loaded.messages).toHaveLength(1);
    expect(await store.readArtifact(run.id, loaded.agents[0]!.report)).toContain('cancellation');
    expect((await store.list())[0]).toMatchObject({id: run.id, status: 'accepted', agentCount: 1, messageCount: 1});
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

  it('round-trips v3 structured writer evidence and integration rollback coordinates', async () => {
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
    expect(loaded.version).toBe(3);
    expect(loaded.version === 3 ? loaded.writer : undefined).toMatchObject({
      profile: 'implementer',
      files: ['source.ts'],
      verdict: {decision: 'accept', artifactSha256: patchSha256},
      integration: {status: 'integrated', checkpoint: {sessionId: 'session-1'}},
    });
    if (loaded.version !== 3 || !loaded.writer) throw new Error('writer record missing');
    expect(await store.readArtifact(run.id, loaded.writer.patch)).toContain('diff --git');
    expect(await store.readArtifact(run.id, loaded.writer.review!)).toContain('"decision":"accept"');
    await expect(store.recordWriterIntegration(run.id, {
      status: 'conflict',
      checkedAt: new Date().toISOString(),
      detail: 'Late competing result.',
    })).rejects.toThrow('cannot be downgraded');

    const manifestPath = join(store.directory, run.id, 'manifest.json');
    const tampered = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      writer: {verdict: {artifactSha256: string}};
    };
    tampered.writer.verdict.artifactSha256 = 'b'.repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
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
    await store.recordReviewVerdict(run.id, contract, verdict, artifact);

    const loaded = await store.load(run.id);
    expect(loaded.version === 3 ? loaded.reviews[0] : undefined).toMatchObject({
      artifact: {sha256: artifactSha256},
      verdict: {decision: 'accept', artifactSha256},
    });
    if (loaded.version !== 3) throw new Error('v3 run missing');
    expect(await store.readArtifact(run.id, loaded.reviews[0]!.artifact)).toBe(artifact);

    const blob = join(store.directory, run.id, 'blobs', `${artifactSha256}.txt`);
    await writeFile(blob, 'tampered council bundle');
    await expect(store.load(run.id)).rejects.toThrow('artifact integrity');
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
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(store.load(run.id)).resolves.toMatchObject({version: 2, id: run.id});
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
