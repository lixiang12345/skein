import {describe, expect, it} from 'vitest';
import {startAgent, toolMetaSummary, updateAgentQueued, updateContractProgress} from '../src/ui/timeline-reducers.js';
import type {TaskContract} from '../src/types.js';
import type {TimelineItem} from '../src/ui/components.js';

describe('timeline reducers', () => {
  it('summarizes warning-only reuse and duplication receipts', () => {
    expect(toolMetaSummary({
      reuseReceipt: {decision: 'extend', status: 'warning'},
      duplicationAudit: {status: 'warning', matches: [{}, {}]},
    })).toBe('reuse extend (warning) · duplicates 2 (warning)');
    expect(toolMetaSummary({duplicationAudit: {status: 'unresolved', matches: []}}))
      .toBe('duplicates incomplete');
    expect(toolMetaSummary({duplicationSuppression: {matchId: 'abcdef0123456789abcdef01'}}))
      .toBe('duplicate abcdef01 suppressed');
  });

  it('keeps one Contract row and removes it after acceptance', () => {
    const initial: TimelineItem[] = [{id: 'banner', kind: 'notice', text: 'Ready'}];
    const draft = updateContractProgress(initial, contract('draft', ['pending', 'pending']));
    const active = updateContractProgress(draft, contract('active', ['satisfied', 'pending']));
    const blocked = updateContractProgress(active, contract('blocked', ['satisfied', 'blocked']));

    expect(blocked.filter((item) => item.id === 'task-contract-progress')).toEqual([{
      id: 'task-contract-progress',
      kind: 'notice',
      tone: 'error',
      text: 'Contract blocked | 1/2 accepted',
    }]);
    expect(updateContractProgress(blocked, contract('satisfied', ['satisfied', 'satisfied'])))
      .toEqual(initial);
  });

  it('upserts a queued agent when it starts instead of duplicating its React key', () => {
    const id = 'fdf2703f-f72c-489f-b60d-9ed8cdb997f4';
    const queued = updateAgentQueued([], {
      type: 'agent_queued', id, profile: 'tester', task: 'Verify the answer', phase: 'work',
    });
    const running = startAgent(queued, {
      type: 'agent_start', id, profile: 'tester', task: 'Verify the answer', phase: 'work',
      provider: 'compatible', model: 'gpt-5.6-sol',
    }, 1_234);

    expect(running.filter((item) => item.kind === 'agent' && item.id === id)).toEqual([{
      id,
      kind: 'agent',
      profile: 'tester',
      task: 'Verify the answer',
      phase: 'work',
      provider: 'compatible',
      model: 'gpt-5.6-sol',
      state: 'running',
      startedAt: 1_234,
    }]);
    expect(new Set(running.map((item) => item.id)).size).toBe(running.length);
  });

  it('supersedes only the previous attempt when a queued retry starts', () => {
    const previous: TimelineItem = {
      id: 'attempt-1', kind: 'agent', profile: 'tester', task: 'Verify', state: 'error',
    };
    const queued = updateAgentQueued([previous], {
      type: 'agent_queued', id: 'attempt-2', profile: 'tester', task: 'Verify', phase: 'review',
    });
    const running = startAgent(queued, {
      type: 'agent_start', id: 'attempt-2', profile: 'tester', task: 'Verify', phase: 'review',
      retryOf: 'attempt-1', provider: 'compatible', model: 'gpt-5.6-sol',
    }, 2_345);

    expect(running.filter((item) => item.kind === 'agent' && item.id === 'attempt-1'))
      .toMatchObject([{state: 'error', superseded: true}]);
    expect(running.filter((item) => item.kind === 'agent' && item.id === 'attempt-2'))
      .toMatchObject([{state: 'running', retryOf: 'attempt-1', startedAt: 2_345}]);
  });
});

function contract(
  state: TaskContract['state'],
  statuses: Array<'pending' | 'satisfied' | 'blocked'>,
): TaskContract {
  return {
    version: 1,
    state,
    objective: 'Implement the change',
    scope: ['workspace'],
    constraints: [],
    nonGoals: [],
    acceptanceCriteria: statuses.map((status, index) => ({
      id: `criterion-${index + 1}`,
      description: `Criterion ${index + 1}`,
      required: true,
      status,
      evidenceRefs: status === 'satisfied' ? [`tool-${index + 1}`] : [],
    })),
    verificationRequirements: ['npm test'],
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}
