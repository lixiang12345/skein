import {describe, expect, it} from 'vitest';
import {
  buildRunCompletion,
  captureVerification,
  classifyVerificationCommand,
  completionRecoveryDirective,
} from '../../src/agent/completion-gate.js';
import type {SessionAuditEvent, TaskContract, ToolCall, ToolResult} from '../../src/types.js';

describe('completion gate', () => {
  it.each([
    ['npm test', 'test'],
    ['pnpm run typecheck', 'typecheck'],
    ['cargo clippy', 'lint'],
    ['npm run build', 'build'],
    ['git diff --check', 'diff'],
    ['npm run check', 'check'],
    ['CI=1 npm run typecheck && npm test', 'check'],
  ] as const)('classifies %s as %s evidence', (command, kind) => {
    expect(classifyVerificationCommand(command)).toBe(kind);
  });

  it.each(['echo npm test', 'node script.js', 'git status', 'npm install']) (
    'does not treat %s as verification',
    (command) => {
      expect(classifyVerificationCommand(command)).toBeUndefined();
    },
  );

  it('accepts configured checks and redacts credentials from persisted evidence', () => {
    const command = 'API_KEY=secret-value node verify.js';
    const evidence = captureVerification(
      shellCall('configured', command),
      result('configured', true),
      2,
      [command],
    );
    expect(evidence).toMatchObject({kind: 'configured', ok: true, changeSequence: 2});
    expect(evidence?.command).toBe('API_KEY=[redacted] node verify.js');
    expect(evidence?.command).not.toContain('secret-value');
  });

  it('rejects stale checks performed before the latest change', () => {
    const evidence = captureVerification(
      shellCall('test-before-change', 'npm test'),
      result('test-before-change', true),
      1,
      [],
    );
    expect(buildRunCompletion(['/workspace/src/app.ts'], evidence ? [evidence] : [], 2)).toMatchObject({
      status: 'unverified',
      checks: [],
    });
  });

  it('uses the latest result per command without hiding another failing check', () => {
    const failedTest = captureVerification(
      shellCall('test-failed', 'npm test'), result('test-failed', false), 3, [],
    );
    const passedTest = captureVerification(
      shellCall('test-passed', 'npm test'), result('test-passed', true), 3, [],
    );
    const failedLint = captureVerification(
      shellCall('lint-failed', 'npm run lint'), result('lint-failed', false), 3, [],
    );
    const evidence = [failedTest, passedTest, failedLint].filter(
      (item): item is NonNullable<typeof item> => Boolean(item),
    );
    const report = buildRunCompletion(['/workspace/src/app.ts'], evidence, 3);
    expect(report.status).toBe('verification_failed');
    expect(report.checks).toEqual([
      expect.objectContaining({toolCallId: 'test-passed', kind: 'test', ok: true}),
      expect.objectContaining({toolCallId: 'lint-failed', kind: 'lint', ok: false}),
    ]);
  });

  it('never reports no changes when shell mutation tracking is unknown', () => {
    const report = buildRunCompletion([], [], 0, 'unknown');
    expect(report).toMatchObject({
      status: 'unverified',
      changedFiles: [],
      mutationTracking: 'unknown',
    });
    expect(report.detail).toContain('may have changed workspace files');
  });

  it('does not report verified while required acceptance is pending', () => {
    const evidence = captureVerification(
      shellCall('test-passed', 'npm test'), result('test-passed', true), 1, [],
    );
    const report = buildRunCompletion(
      ['/workspace/src/app.ts'],
      evidence ? [evidence] : [],
      1,
      'complete',
      contract('pending', []),
      [successfulAudit('test-passed')],
    );
    expect(report).toMatchObject({
      status: 'unverified',
      acceptance: {pending: 1, satisfied: 0},
    });
  });

  it('requires a successful audit reference before accepting satisfied criteria', () => {
    const withoutAudit = buildRunCompletion(
      [], [], 0, 'complete', contract('satisfied', ['invented']), [],
    );
    expect(withoutAudit).toMatchObject({status: 'unverified', acceptance: {pending: 1}});

    const testEvidence = captureVerification(
      shellCall('test-ok', 'npm test'), result('test-ok', true), 0, [],
    );
    const withAudit = buildRunCompletion(
      [], testEvidence ? [testEvidence] : [], 0, 'complete',
      contract('satisfied', ['tool-ok']), [successfulAudit('tool-ok')],
    );
    expect(withAudit).toMatchObject({status: 'no_changes', acceptance: {satisfied: 1}});
  });

  it('enforces Contract verification requirements after the final mutation', () => {
    const taskContract = contract('satisfied', ['write-ok']);
    taskContract.verificationRequirements = ['npm test'];
    const withoutCheck = buildRunCompletion(
      ['/workspace/src/app.ts'], [], 1, 'complete', taskContract, [successfulAudit('write-ok')],
    );
    expect(withoutCheck).toMatchObject({
      status: 'unverified',
      acceptance: {missingVerification: ['npm test']},
    });
    const testEvidence = captureVerification(
      shellCall('test-ok', 'npm test'), result('test-ok', true), 1, [],
    );
    const withCheck = buildRunCompletion(
      ['/workspace/src/app.ts'], testEvidence ? [testEvidence] : [], 1,
      'complete', taskContract, [successfulAudit('write-ok'), successfulAudit('test-ok')],
    );
    expect(withCheck).toMatchObject({
      status: 'verified',
      acceptance: {missingVerification: []},
    });
  });

  it('does not accept a different command of the same verification kind', () => {
    const taskContract = contract('satisfied', ['write-ok']);
    taskContract.verificationRequirements = ['npm test'];
    const differentTest = captureVerification(
      shellCall('different-test', 'node --test'), result('different-test', true), 1, [],
    );
    const report = buildRunCompletion(
      ['/workspace/src/app.ts'], differentTest ? [differentTest] : [], 1,
      'complete', taskContract, [successfulAudit('write-ok'), successfulAudit('different-test')],
    );
    expect(report).toMatchObject({
      status: 'unverified',
      acceptance: {missingVerification: ['npm test']},
    });
  });

  it('invalidates criterion evidence recorded before a later mutation', () => {
    const taskContract = contract('satisfied', ['first-write']);
    const verification = captureVerification(
      shellCall('test-after-second-write', 'npm test'),
      result('test-after-second-write', true),
      2,
      [],
    );
    const report = buildRunCompletion(
      ['/workspace/src/app.ts'],
      verification ? [verification] : [],
      2,
      'complete',
      taskContract,
      [
        successfulAudit('first-write', '2026-07-25T00:00:01.000Z', ['/workspace/src/app.ts']),
        successfulAudit('second-write', '2026-07-25T00:00:02.000Z', ['/workspace/src/app.ts']),
        successfulAudit('test-after-second-write', '2026-07-25T00:00:03.000Z'),
      ],
    );
    expect(report).toMatchObject({
      status: 'unverified',
      acceptance: {pending: 1, satisfied: 0},
    });
  });

  it('uses the Contract audit boundary when timestamps are identical', () => {
    const taskContract = contract('satisfied', ['old-tool']);
    taskContract.auditBoundaryId = 'audit-before-contract';
    const verification = captureVerification(
      shellCall('verify-after-contract', 'npm test'),
      result('verify-after-contract', true),
      0,
      [],
    );
    const sameTimestamp = '2026-07-25T00:00:00.000Z';
    const report = buildRunCompletion(
      [],
      verification ? [verification] : [],
      0,
      'complete',
      taskContract,
      [
        successfulAudit('old-tool', sameTimestamp),
        successfulAudit('before-contract', sameTimestamp),
        successfulAudit('verify-after-contract', sameTimestamp),
      ],
    );
    expect(report).toMatchObject({status: 'unverified', acceptance: {pending: 1, satisfied: 0}});
  });

  it('invalidates evidence before a failed tool that changed files', () => {
    const taskContract = contract('satisfied', ['first-write']);
    const verification = captureVerification(
      shellCall('verify-after-failed-write', 'npm test'),
      result('verify-after-failed-write', true),
      2,
      [],
    );
    const failedMutation: SessionAuditEvent = {
      id: 'audit-failed-write', createdAt: '2026-07-25T00:00:02.000Z',
      type: 'tool', toolCallId: 'failed-write', tool: 'shell', outcome: 'failure',
      metadata: {changedFiles: ['/workspace/src/app.ts']},
    };
    const report = buildRunCompletion(
      ['/workspace/src/app.ts'],
      verification ? [verification] : [],
      2,
      'complete',
      taskContract,
      [
        successfulAudit('first-write', '2026-07-25T00:00:01.000Z', ['/workspace/src/app.ts']),
        failedMutation,
        successfulAudit('verify-after-failed-write', '2026-07-25T00:00:03.000Z'),
      ],
    );
    expect(report).toMatchObject({status: 'unverified', acceptance: {pending: 1, satisfied: 0}});
  });

  it('keeps acceptance active when mutation tracking prevents a verified completion', () => {
    const taskContract = contract('satisfied', ['write-ok']);
    const verification = captureVerification(
      shellCall('verify', 'npm test'), result('verify', true), 1, [],
    );
    const report = buildRunCompletion(
      ['/workspace/src/app.ts'],
      verification ? [verification] : [],
      1,
      'unknown',
      taskContract,
      [
        successfulAudit('write-ok', '2026-07-25T00:00:01.000Z', ['/workspace/src/app.ts']),
        successfulAudit('verify', '2026-07-25T00:00:02.000Z'),
      ],
    );
    expect(report).toMatchObject({status: 'unverified', acceptance: {state: 'active', satisfied: 1}});
  });

  it('attaches warning-only duplication evidence without changing verified status', () => {
    const verification = captureVerification(
      shellCall('verify-duplicate', 'npm test'), result('verify-duplicate', true), 1, [],
    );
    const report = buildRunCompletion(
      ['/workspace/src/copy.ts'],
      verification ? [verification] : [],
      1,
      'complete',
      undefined,
      [],
      {
        enforcement: 'warning', status: 'warning', warningCount: 1,
        unresolvedCount: 0, suppressedCount: 0,
        matches: [{
          matchId: 'abcdef0123456789abcdef01',
          changedPath: '/workspace/src/copy.ts', changedSymbol: 'copy',
          candidatePath: '/workspace/src/helper.ts', candidateSymbol: 'helper',
          kind: 'type-1-or-2', similarity: 1,
        }],
      },
    );
    expect(report).toMatchObject({
      status: 'verified',
      duplication: {enforcement: 'warning', status: 'warning', warningCount: 1},
    });
    expect(completionRecoveryDirective(report)).not.toContain('duplication');
  });
});

function contract(status: 'pending' | 'satisfied', evidenceRefs: string[]): TaskContract {
  return {
    version: 1,
    state: status === 'satisfied' ? 'satisfied' : 'active',
    objective: 'Implement the change',
    scope: ['workspace'],
    constraints: [],
    nonGoals: [],
    acceptanceCriteria: [{
      id: 'criterion-1', description: 'Requested behavior works', required: true,
      status, evidenceRefs,
    }],
    verificationRequirements: [],
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function successfulAudit(
  toolCallId: string,
  createdAt = '2026-07-25T00:00:01.000Z',
  changedFiles: string[] = [],
): SessionAuditEvent {
  return {
    id: `audit-${toolCallId}`,
    createdAt,
    type: 'tool',
    toolCallId,
    tool: 'shell',
    outcome: 'success',
    ...(changedFiles.length ? {metadata: {changedFiles}} : {}),
  };
}

function shellCall(id: string, command: string): ToolCall {
  return {id, name: 'shell', arguments: {command}};
}

function result(toolCallId: string, ok: boolean): ToolResult {
  return {toolCallId, name: 'shell', ok, content: ok ? 'passed' : 'failed'};
}
