import {describe, expect, it} from 'vitest';
import {
  assessReviewIndependence,
  buildReviewRouteIdentity,
  createHumanArbitration,
  resolveReviewGate,
  reviewContractHighRisk,
  reviewCriterionConflicts,
  reviewCriterionConflictsIntegrityValid,
  reviewIndependenceIntegrityValid,
  reviewModelFamily,
} from '../../src/agent/review-arbitration.js';
import {
  buildWriterReviewContract,
  makeReviewEvidence,
  parseReviewVerdict,
} from '../../src/agent/review-verdict.js';

describe('review independence and human arbitration', () => {
  it('rejects an exact author/reviewer route and applies bounded correlation penalties', () => {
    const exact = buildReviewRouteIdentity({
      runtime: 'api', provider: 'compatible', protocol: 'openai-responses',
      model: 'openai/gpt-5.2-codex-20260101', endpoint: 'https://relay.example/openai/v1',
    });
    const sameProvider = buildReviewRouteIdentity({
      runtime: 'api', provider: 'compatible', protocol: 'anthropic-messages',
      model: 'anthropic/claude-sonnet-4-5', endpoint: 'https://relay.example/anthropic',
    });
    expect(assessReviewIndependence({authors: [exact], reviewer: exact, highRisk: false}))
      .toMatchObject({sufficient: false, maximumCorrelationPenalty: 1});
    expect(assessReviewIndependence({authors: [exact], reviewer: sameProvider, highRisk: false}))
      .toMatchObject({sufficient: true, maximumCorrelationPenalty: 0.2,
        correlations: [{relationship: 'same-gateway'}]});
    expect(assessReviewIndependence({authors: [exact], reviewer: sameProvider, highRisk: true}))
      .toMatchObject({sufficient: true, maximumCorrelationPenalty: 0.2});
    const sameModelProvider = buildReviewRouteIdentity({
      runtime: 'api', provider: 'compatible', protocol: 'openai-responses',
      model: 'openai/o3', endpoint: 'https://another.example/v1',
    });
    expect(assessReviewIndependence({authors: [exact], reviewer: sameModelProvider, highRisk: true}))
      .toMatchObject({sufficient: false, maximumCorrelationPenalty: 0.4,
        correlations: [{relationship: 'same-provider'}]});
    const sameFamilyThroughAnotherProvider = buildReviewRouteIdentity({
      runtime: 'api', provider: 'mirror', protocol: 'openai-responses',
      model: 'gpt-5.2-20260201', endpoint: 'https://another.example/v1',
    });
    expect(assessReviewIndependence({
      authors: [exact], reviewer: sameFamilyThroughAnotherProvider, highRisk: true,
    })).toMatchObject({sufficient: false, maximumCorrelationPenalty: 0.75,
      correlations: [{relationship: 'same-model-family'}]});
    expect(reviewModelFamily('openai/gpt-5.2-codex-20260101')).toBe('gpt-5.2');
    expect(reviewModelFamily('anthropic/claude-sonnet-4-5-20260101')).toBe('claude-sonnet-4-5');
    expect(reviewModelFamily('anthropic/claude-sonnet-4-20260101')).toBe('claude-sonnet-4');
  });

  it('classifies explicit release and security objectives without treating review boilerplate as high risk', () => {
    expect(reviewContractHighRisk(buildWriterReviewContract('Rename a local helper.'))).toBe(false);
    expect(reviewContractHighRisk(buildWriterReviewContract('Publish the release to npm.'))).toBe(true);
    expect(reviewContractHighRisk(buildWriterReviewContract('修复权限与密钥泄露。'))).toBe(true);
    const constrained = buildWriterReviewContract('Rename one helper.');
    expect(reviewContractHighRisk({...constrained, constraints: ['Do not change the authentication schema.']})).toBe(true);
  });

  it('lets deterministic oracle evidence outrank a contradictory reviewer judgment', () => {
    const contract = buildWriterReviewContract('Update one local helper.');
    const artifactSha256 = 'a'.repeat(64);
    const evidence = [makeReviewEvidence({
      kind: 'deterministic', status: 'passed', summary: 'Typecheck passed.',
      subjectSha256: artifactSha256, payload: {command: 'typecheck', exitCode: 0},
    })];
    const verdict = parseReviewVerdict(JSON.stringify({
      decision: 'revise',
      criteria: contract.criteria.map((criterion) => ({
        id: criterion.id,
        status: 'fail',
        evidence_refs: [evidence[0]!.id],
        finding: 'Reviewer disagrees with the passing oracle.',
      })),
      residual_risks: [],
      conflicts: [],
    }), {
      contract, artifactSha256, evidence,
      reviewer: {profile: 'reviewer', provider: 'openai', model: 'judge'},
    });
    const independence = independentRoutes();
    const conflicts = reviewCriterionConflicts(contract, verdict);
    expect(conflicts).toHaveLength(contract.criteria.length);
    expect(resolveReviewGate({
      contract, artifactSha256, verdict, independence, conflicts, arbitrations: [],
    })).toMatchObject({status: 'accepted', accepted: true});
    expect(resolveReviewGate({
      contract, artifactSha256: 'b'.repeat(64), verdict: {...verdict, artifactSha256: 'b'.repeat(64)},
      independence, conflicts, arbitrations: [],
    })).toMatchObject({status: 'rejected', accepted: false});
  });

  it('never lets human arbitration convert a failed deterministic oracle to pass', () => {
    const contract = buildWriterReviewContract('Update one local helper.');
    const artifactSha256 = 'c'.repeat(64);
    const evidence = [makeReviewEvidence({
      kind: 'deterministic', status: 'failed', summary: 'Tests failed.',
      subjectSha256: artifactSha256, payload: {command: 'test', exitCode: 1},
    })];
    const verdict = parseReviewVerdict(JSON.stringify({
      decision: 'accept',
      criteria: contract.criteria.map((criterion) => ({
        id: criterion.id, status: 'pass', evidence_refs: [evidence[0]!.id],
      })),
      residual_risks: [], conflicts: [],
    }), {
      contract, artifactSha256, evidence,
      reviewer: {profile: 'reviewer', provider: 'openai', model: 'judge'},
    });
    const arbitrations = contract.criteria.map((criterion) => createHumanArbitration({
      criterionId: criterion.id,
      contractSha256: contract.sha256,
      artifactSha256,
      decision: 'accept',
      reason: 'Attempted override must remain inadmissible.',
    }));
    expect(resolveReviewGate({
      contract,
      artifactSha256,
      verdict,
      independence: independentRoutes(),
      conflicts: reviewCriterionConflicts(contract, verdict),
      arbitrations,
    })).toMatchObject({status: 'rejected', accepted: false});
  });

  it('recomputes persisted independence and criterion conflicts before accepting a gate', () => {
    const contract = buildWriterReviewContract('Update one local helper.');
    const artifactSha256 = 'd'.repeat(64);
    const evidence = [makeReviewEvidence({
      kind: 'artifact', status: 'observed', summary: 'Patch observed.',
      subjectSha256: artifactSha256, payload: {artifactSha256},
    })];
    const verdict = parseReviewVerdict(JSON.stringify({
      decision: 'accept',
      criteria: contract.criteria.map((criterion) => ({
        id: criterion.id, status: 'pass', evidence_refs: [evidence[0]!.id],
      })),
      residual_risks: [], conflicts: [],
    }), {
      contract, artifactSha256, evidence,
      reviewer: {profile: 'reviewer', provider: 'openai', model: 'judge'},
    });
    const independence = independentRoutes();
    const conflicts = reviewCriterionConflicts(contract, verdict);
    expect(reviewIndependenceIntegrityValid(independence, false)).toBe(true);
    expect(reviewCriterionConflictsIntegrityValid(contract, verdict, conflicts)).toBe(true);
    const tampered = {...independence, sufficient: false};
    expect(reviewIndependenceIntegrityValid(tampered, false)).toBe(false);
    expect(resolveReviewGate({
      contract, artifactSha256, verdict, independence: tampered, conflicts, arbitrations: [],
    })).toMatchObject({status: 'rejected', accepted: false});
  });

  it('rejects duplicate or optional human arbitration records instead of taking the latest value', () => {
    const contract = buildWriterReviewContract('Update one local helper.');
    const artifactSha256 = 'e'.repeat(64);
    const evidence = [makeReviewEvidence({
      kind: 'artifact', status: 'observed', summary: 'Patch observed.',
      subjectSha256: artifactSha256, payload: {artifactSha256},
    })];
    const verdict = parseReviewVerdict(JSON.stringify({
      decision: 'escalate',
      criteria: contract.criteria.map((criterion) => ({
        id: criterion.id, status: 'unknown', evidence_refs: [],
      })),
      residual_risks: [], conflicts: [],
    }), {
      contract, artifactSha256, evidence,
      reviewer: {profile: 'reviewer', provider: 'openai', model: 'judge'},
    });
    const first = createHumanArbitration({
      criterionId: contract.criteria[0]!.id,
      contractSha256: contract.sha256,
      artifactSha256,
      decision: 'accept',
      reason: 'Inspected the evidence and relevant diff.',
    });
    expect(resolveReviewGate({
      contract, artifactSha256, verdict, independence: independentRoutes(), conflicts: [],
      arbitrations: [first, first],
    })).toMatchObject({status: 'rejected', accepted: false});
    const optionalContract = buildWriterReviewContract('Update one local helper.', {
      version: 1,
      state: 'active',
      objective: 'Update one local helper.',
      scope: [],
      constraints: [],
      nonGoals: [],
      acceptanceCriteria: [
        {id: 'required-change', description: 'Required change.', required: true, status: 'pending', evidenceRefs: []},
        {id: 'optional-note', description: 'Optional note.', required: false, status: 'pending', evidenceRefs: []},
      ],
      verificationRequirements: [],
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
    });
    const optional = createHumanArbitration({
      criterionId: 'optional-note', contractSha256: optionalContract.sha256, artifactSha256,
      decision: 'accept', reason: 'Optional criteria cannot authorize completion.',
    });
    const optionalVerdict = parseReviewVerdict(JSON.stringify({
      decision: 'accept',
      criteria: [
        {id: 'required-change', status: 'pass', evidence_refs: [evidence[0]!.id]},
        {id: 'optional-note', status: 'pass', evidence_refs: [evidence[0]!.id]},
      ],
      residual_risks: [], conflicts: [],
    }), {
      contract: optionalContract,
      artifactSha256,
      evidence,
      reviewer: {profile: 'reviewer', provider: 'openai', model: 'judge'},
    });
    expect(resolveReviewGate({
      contract: optionalContract,
      artifactSha256,
      verdict: optionalVerdict,
      independence: independentRoutes(),
      conflicts: [],
      arbitrations: [optional],
    })).toMatchObject({status: 'rejected', accepted: false});
  });
});

function independentRoutes() {
  return assessReviewIndependence({
    authors: [buildReviewRouteIdentity({runtime: 'api', provider: 'anthropic', model: 'claude-sonnet-4-5'})],
    reviewer: buildReviewRouteIdentity({runtime: 'api', provider: 'openai', model: 'gpt-5.2'}),
    highRisk: false,
  });
}
