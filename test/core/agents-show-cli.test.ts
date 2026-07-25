import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
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
import {
  assessReviewIndependence,
  buildReviewRouteIdentity,
  reviewCriterionConflicts,
} from '../../src/agent/review-arbitration.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('agents show CLI', () => {
  it('normalizes v4 reviewer JSON in text while retaining raw evidence in JSON', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-agents-show-'));
    roots.push(workspace);
    const store = new TeamRunStore(workspace);
    const run = await store.create({objective: 'Review the delivery', reviewer: 'reviewer', maxReviewRounds: 0});
    const rawMarker = 'RAW_REVIEW_MARKER';
    await store.recordAgent(run.id, {
      id: '00000000-0000-4000-8000-000000000001',
      profile: 'reviewer', provider: 'compatible', model: 'judge', phase: 'review', ok: true,
      report: rawMarker,
    });
    const contract = buildWriterReviewContract('Review the delivery');
    const bundle = {reviewRound: 0, reports: [{profile: 'architect', ok: true, summary: 'Evidence ready.'}]};
    const artifactSha256 = reviewArtifactSha256(bundle);
    const evidence = [makeReviewEvidence({
      kind: 'model-report', status: 'observed', summary: 'Architect report completed.',
      subjectSha256: artifactSha256, payload: bundle.reports[0],
    })];
    const verdict = parseReviewVerdict(JSON.stringify({
      decision: 'accept',
      criteria: contract.criteria.map((criterion) => ({
        id: criterion.id, status: 'pass', evidence_refs: [evidence[0]!.id],
      })),
      residual_risks: [], conflicts: [],
    }), {
      contract, artifactSha256, evidence,
      reviewer: {profile: 'reviewer', provider: 'compatible', model: 'judge'},
    });
    await store.recordReviewVerdict(
      run.id,
      contract,
      verdict,
      reviewArtifactText(bundle),
      assessReviewIndependence({
        authors: [buildReviewRouteIdentity({runtime: 'api', provider: 'compatible', model: 'worker'})],
        reviewer: buildReviewRouteIdentity({runtime: 'api', provider: 'openai', model: 'judge'}),
        highRisk: false,
      }),
      reviewCriterionConflicts(contract, verdict),
    );
    await store.complete(run.id, {accepted: true, reviewRounds: 0});

    const textResult = await runCli(['agents', 'show', run.id, '--workspace', workspace]);
    expect(textResult).toMatchObject({exitCode: 0, stderr: ''});
    expect(textResult.stdout).toContain('Structured council verdict 1/1');
    expect(textResult.stdout).toContain('Decision: accept');
    expect(textResult.stdout).toContain('Structured reviewer output is normalized below');
    expect(textResult.stdout).not.toContain(rawMarker);

    const jsonResult = await runCli(['agents', 'show', run.id, '--workspace', workspace, '--json']);
    expect(jsonResult).toMatchObject({exitCode: 0, stderr: ''});
    const output = JSON.parse(jsonResult.stdout) as {
      agents: Array<{reportText: string}>;
      reviews: Array<{artifact: {sha256: string}; verdict: {decision: string}}>;
    };
    expect(output.agents[0]?.reportText).toBe(rawMarker);
    expect(output.reviews[0]).toMatchObject({
      artifact: {sha256: artifactSha256}, verdict: {decision: 'accept'},
    });

    const arbitration = await runCli([
      'agents', 'arbitrate', run.id, contract.criteria[0]!.id,
      '--workspace', workspace,
      '--decision', 'accept',
      '--reason', 'Reviewed the exact bound evidence.',
    ]);
    expect(arbitration.exitCode).toBe(1);
    expect(arbitration.stderr).toContain('requires a live interactive TTY');
  }, 20_000);
});

function runCli(args: string[]): Promise<{exitCode: number | null; stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.tsx', ...args], {
      cwd: process.cwd(),
      env: {...process.env, SKEIN_NO_UPDATE_CHECK: '1'},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({exitCode, stdout, stderr}));
  });
}
