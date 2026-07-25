import {describe, expect, it} from 'vitest';
import {toolMetaSummary, updateContractProgress} from '../src/ui/timeline-reducers.js';
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
