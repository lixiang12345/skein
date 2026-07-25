import {describe, expect, it} from 'vitest';
import {
  buildWriterReviewContract,
  formatReviewVerdict,
  makeReviewEvidence,
  parseReviewVerdict,
  reviewEvidenceIntegrityValid,
  reviewVerdictAccepted,
} from '../../src/agent/review-verdict.js';
import type {TaskContract} from '../../src/types.js';

describe('structured review verdicts', () => {
  it('accepts only a complete evidence-backed verdict bound to the contract and artifact', () => {
    const contract = buildWriterReviewContract('Implement the bounded change.');
    const artifactSha256 = 'a'.repeat(64);
    const evidence = [makeReviewEvidence({
      kind: 'artifact', status: 'observed', summary: 'Reviewed patch artifact.', subjectSha256: artifactSha256,
      payload: {artifactSha256},
    })];
    const verdict = parseReviewVerdict(output(contract, evidence[0]!.id, 'accept'), {
      contract, artifactSha256, evidence,
      reviewer: {profile: 'reviewer', provider: 'compatible', model: 'judge'},
    });

    expect(verdict).toMatchObject({decision: 'accept', contractSha256: contract.sha256, artifactSha256});
    expect(reviewVerdictAccepted(contract, artifactSha256, verdict)).toBe(true);
    expect(reviewVerdictAccepted(contract, 'b'.repeat(64), verdict)).toBe(false);
    expect(reviewVerdictAccepted({...contract, objective: 'tampered'}, artifactSha256, verdict)).toBe(false);
    expect(reviewVerdictAccepted(contract, artifactSha256, {
      ...verdict, residualRisks: ['tampered after persistence'],
    })).toBe(false);
  });

  it('binds the evidence receipt id to its payload hash and normalized metadata', () => {
    const evidence = makeReviewEvidence({
      kind: 'deterministic', status: 'passed', summary: 'Typecheck passed.',
      subjectSha256: 'a'.repeat(64), payload: {command: 'npm run typecheck', exitCode: 0},
    });
    expect(reviewEvidenceIntegrityValid(evidence)).toBe(true);
    expect(reviewEvidenceIntegrityValid({...evidence, payloadSha256: 'f'.repeat(64)})).toBe(false);
    expect(reviewEvidenceIntegrityValid({...evidence, summary: 'Tampered.'})).toBe(false);
  });

  it('downgrades unsupported conclusions to unknown and escalates', () => {
    const contract = buildWriterReviewContract('Implement the bounded change.');
    const artifactSha256 = 'a'.repeat(64);
    const evidence = [makeReviewEvidence({
      kind: 'artifact', status: 'observed', summary: 'Reviewed patch artifact.', subjectSha256: artifactSha256,
      payload: {artifactSha256},
    })];
    const raw = JSON.stringify({
      decision: 'accept',
      criteria: contract.criteria.map((criterion) => ({
        id: criterion.id, status: 'pass', evidence_refs: [], finding: 'Trust me.',
      })),
      residual_risks: [],
      conflicts: [],
    });
    const verdict = parseReviewVerdict(raw, {
      contract, artifactSha256, evidence,
      reviewer: {profile: 'reviewer', provider: 'compatible', model: 'judge'},
    });

    expect(verdict.decision).toBe('escalate');
    expect(verdict.criteria.every((criterion) => criterion.status === 'unknown')).toBe(true);
    expect(reviewVerdictAccepted(contract, artifactSha256, verdict)).toBe(false);
  });

  it('never permits model acceptance to override failed deterministic evidence', () => {
    const contract = buildWriterReviewContract('Implement the bounded change.');
    const artifactSha256 = 'a'.repeat(64);
    const evidence = [makeReviewEvidence({
      kind: 'deterministic', status: 'failed', summary: 'Patch apply check failed.', subjectSha256: artifactSha256,
      payload: {status: 'conflict'},
    })];
    const verdict = parseReviewVerdict(output(contract, evidence[0]!.id, 'accept'), {
      contract, artifactSha256, evidence,
      reviewer: {profile: 'reviewer', provider: 'compatible', model: 'judge'},
    });

    expect(verdict.decision).toBe('revise');
    expect(verdict.criteria.every((criterion) => criterion.status === 'fail')).toBe(true);
    expect(reviewVerdictAccepted(contract, artifactSha256, verdict)).toBe(false);
  });

  it('rejects prose, fences, duplicate criteria, and unknown evidence handles', () => {
    const contract = buildWriterReviewContract('Implement the bounded change.');
    const artifactSha256 = 'a'.repeat(64);
    const evidence = [makeReviewEvidence({
      kind: 'artifact', status: 'observed', summary: 'Reviewed patch artifact.', subjectSha256: artifactSha256,
      payload: {artifactSha256},
    })];
    for (const raw of ['VERDICT: ACCEPT', '```json\n{}\n```']) {
      const verdict = parseReviewVerdict(raw, {
        contract, artifactSha256, evidence,
        reviewer: {profile: 'reviewer', provider: 'compatible', model: 'judge'},
      });
      expect(verdict.decision).toBe('escalate');
      expect(reviewVerdictAccepted(contract, artifactSha256, verdict)).toBe(false);
    }

    const invalid = JSON.stringify({
      decision: 'accept',
      criteria: [
        ...contract.criteria.map((criterion) => ({
          id: criterion.id, status: 'pass', evidence_refs: ['evidence:' + 'f'.repeat(64)],
        })),
        {id: contract.criteria[0]!.id, status: 'pass', evidence_refs: [evidence[0]!.id]},
      ],
      residual_risks: [],
      conflicts: [],
    });
    const verdict = parseReviewVerdict(invalid, {
      contract, artifactSha256, evidence,
      reviewer: {profile: 'reviewer', provider: 'compatible', model: 'judge'},
    });
    expect(verdict.decision).toBe('escalate');
    expect(verdict.criteria.some((criterion) => criterion.status === 'unknown')).toBe(true);
  });

  it('fails closed when a reviewer adds an unknown criterion even if required criteria pass', () => {
    const contract = buildWriterReviewContract('Implement the bounded change.');
    const artifactSha256 = 'a'.repeat(64);
    const evidence = [makeReviewEvidence({
      kind: 'artifact', status: 'observed', summary: 'Reviewed patch artifact.', subjectSha256: artifactSha256,
      payload: {artifactSha256},
    })];
    const raw = JSON.stringify({
      decision: 'accept',
      criteria: [
        ...contract.criteria.map((criterion) => ({
          id: criterion.id, status: 'pass', evidence_refs: [evidence[0]!.id],
        })),
        ...Array.from({length: 70}, (_, index) => ({
          id: `invented-criterion-${index}-${'x'.repeat(100)}`,
          status: 'pass',
          evidence_refs: [evidence[0]!.id],
        })),
      ],
      residual_risks: [],
      conflicts: [],
    });
    const verdict = parseReviewVerdict(raw, {
      contract, artifactSha256, evidence,
      reviewer: {profile: 'reviewer', provider: 'compatible', model: 'judge'},
    });
    expect(verdict.decision).toBe('escalate');
    expect(verdict.criteria.every((criterion) => criterion.status === 'unknown')).toBe(true);
    expect(reviewVerdictAccepted(contract, artifactSha256, verdict)).toBe(false);
  });

  it('normalizes model-authored control characters before formatting or revision feedback', () => {
    const contract = buildWriterReviewContract('Implement the bounded change.');
    const artifactSha256 = 'a'.repeat(64);
    const evidence = [makeReviewEvidence({
      kind: 'artifact', status: 'observed', summary: 'Reviewed patch artifact.', subjectSha256: artifactSha256,
      payload: {artifactSha256},
    })];
    const raw = JSON.stringify({
      decision: 'accept',
      criteria: contract.criteria.map((criterion) => ({
        id: criterion.id, status: 'pass', evidence_refs: [evidence[0]!.id],
        finding: '\u001b[31mSupported\u001b[0m\nwithout terminal controls.',
      })),
      residual_risks: ['\u001b[2Jbounded\nrisk'],
      conflicts: [],
    });
    const verdict = parseReviewVerdict(raw, {
      contract, artifactSha256, evidence,
      reviewer: {profile: 'reviewer', provider: 'compatible', model: 'judge'},
    });
    const formatted = formatReviewVerdict(verdict);
    expect(formatted).toContain('Supported without terminal controls.');
    expect(formatted).toContain('bounded risk');
    expect(formatted).not.toContain('\u001b');
  });

  it('reuses Task Contract criterion ids and changes the semantic hash when the contract changes', () => {
    const contract = taskContract();
    const first = buildWriterReviewContract('Implement the bounded change.', contract);
    const evidenceOnlyChange = structuredClone(contract);
    evidenceOnlyChange.acceptanceCriteria[0]!.status = 'satisfied';
    evidenceOnlyChange.acceptanceCriteria[0]!.evidenceRefs = ['tool-call-1'];
    const second = buildWriterReviewContract('Implement the bounded change.', evidenceOnlyChange);
    const semanticChange = structuredClone(contract);
    semanticChange.constraints.push('Keep the public API stable.');
    const third = buildWriterReviewContract('Implement the bounded change.', semanticChange);

    expect(first.criteria.map((criterion) => criterion.id)).toEqual(['criterion-public-api']);
    expect(second.sha256).toBe(first.sha256);
    expect(third.sha256).not.toBe(first.sha256);
  });
});

function output(
  contract: ReturnType<typeof buildWriterReviewContract>,
  evidenceRef: string,
  decision: 'accept' | 'revise' | 'escalate',
): string {
  return JSON.stringify({
    decision,
    criteria: contract.criteria.map((criterion) => ({
      id: criterion.id,
      status: 'pass',
      evidence_refs: [evidenceRef],
      finding: 'Supported by supplied evidence.',
    })),
    residual_risks: [],
    conflicts: [],
  });
}

function taskContract(): TaskContract {
  return {
    version: 1,
    state: 'active',
    objective: 'Keep the public API stable.',
    scope: ['src/'],
    constraints: ['Preserve unrelated changes.'],
    nonGoals: [],
    acceptanceCriteria: [{
      id: 'criterion-public-api',
      description: 'The public API remains compatible.',
      required: true,
      status: 'pending',
      evidenceRefs: [],
    }],
    verificationRequirements: ['npm test'],
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
  };
}
