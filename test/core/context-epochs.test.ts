import {describe, expect, it} from 'vitest';
import {createSession} from '../../src/session/store.js';
import {
  activeContextEpoch,
  recordContextEpochUsage,
  rotateContextEpoch,
} from '../../src/context/epochs.js';

describe('context epochs', () => {
  it('keeps lifetime usage separate while rotating a bounded epoch', () => {
    const session = createSession({workspace: process.cwd(), model: 'test', provider: 'compatible'});
    session.usage = {inputTokens: 260_000, outputTokens: 20_000};
    recordContextEpochUsage(session, 240_000, 10_000);

    const rotated = rotateContextEpoch(session, 'token_budget');

    expect(rotated.previous.usage).toEqual({inputTokens: 240_000, outputTokens: 10_000});
    expect(rotated.current).toMatchObject({index: 2, usage: {inputTokens: 0, outputTokens: 0}});
    expect(session.usage).toMatchObject({inputTokens: 260_000, outputTokens: 20_000});
  });

  it('preserves contract, failure, changed-file, and verification facts across five handoffs', () => {
    const session = createSession({workspace: process.cwd(), model: 'test', provider: 'compatible'});
    session.taskContract = {
      version: 1,
      state: 'active',
      objective: 'Finish the long migration.',
      scope: ['src'],
      constraints: ['Keep the public API compatible.'],
      nonGoals: [],
      acceptanceCriteria: [{
        id: 'compatibility', description: 'Old callers keep working.', required: true,
        status: 'pending', evidenceRefs: [],
      }],
      verificationRequirements: ['npm test'],
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    };
    session.changedFiles = ['src/api.ts'];
    session.lastRun = {
      status: 'unverified', changedFiles: ['src/api.ts'], detail: 'verification pending',
      checks: [{toolCallId: 'check-1', tool: 'shell', command: 'npm test', kind: 'test', ok: false}],
      reason: 'verification_failed', finishedAt: '2026-07-25T00:01:00.000Z',
    };
    session.audit = [{
      id: 'audit-1', createdAt: '2026-07-25T00:01:00.000Z', type: 'tool',
      toolCallId: 'check-1', tool: 'shell', outcome: 'failure',
      metadata: {failure: {
        class: 'command_exit', retryable: true, repairHint: 'Fix the test.', attempt: 1,
        remaining: 1, circuitOpen: false, signature: 'failed-test-signature',
      }},
    }];

    for (let index = 0; index < 5; index += 1) {
      recordContextEpochUsage(session, 200_000, 50_000);
      rotateContextEpoch(session, 'token_budget');
    }

    expect(activeContextEpoch(session)).toMatchObject({index: 6, usage: {inputTokens: 0, outputTokens: 0}});
    const handoffs = session.contextEpochs?.slice(0, -1).map((epoch) => epoch.handoff);
    expect(handoffs).toHaveLength(5);
    for (const handoff of handoffs ?? []) {
      expect(handoff).toMatchObject({
        contract: {state: 'active', required: [{id: 'compatibility', status: 'pending'}]},
        unresolvedFailures: [{signature: 'failed-test-signature', class: 'command_exit'}],
        changedFiles: ['src/api.ts'],
        checks: [{command: 'npm test', ok: false}],
      });
    }
  });

  it('excludes an exact historical failure after the same call succeeds', () => {
    const session = createSession({workspace: process.cwd(), model: 'test', provider: 'compatible'});
    session.audit = [{
      id: 'audit-failure', createdAt: '2026-07-25T00:00:00.000Z', type: 'tool',
      toolCallId: 'check-1', tool: 'shell', outcome: 'failure',
      metadata: {failure: {
        class: 'command_exit', retryable: true, repairHint: 'Fix the test.', attempt: 1,
        remaining: 2, circuitOpen: false, signature: 'exact-failure-signature',
      }},
    }, {
      id: 'audit-success', createdAt: '2026-07-25T00:01:00.000Z', type: 'tool',
      toolCallId: 'check-2', tool: 'shell', outcome: 'success',
      metadata: {resolvedFailureSignatures: ['exact-failure-signature']},
    }];

    const rotated = rotateContextEpoch(session, 'manual');

    expect(rotated.handoff.unresolvedFailures).toEqual([]);
  });
});
