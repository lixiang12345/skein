import {describe, expect, it} from 'vitest';
import {
  activeDuplicationMatchIds,
  buildDuplicationCompletion,
  hasDuplicationActivity,
} from '../../src/agent/duplication-state.js';
import {duplicationTool} from '../../src/tools/duplication.js';
import {createSession} from '../../src/session/store.js';
import {WorkspaceAccess} from '../../src/tools/workspace.js';
import type {
  DuplicationAuditReceipt,
  MosaicConfig,
  SessionAuditEvent,
} from '../../src/types.js';

describe('duplication completion state', () => {
  it('aggregates warnings and replacements by changed path', () => {
    const first = auditEvent('first', warning('111111111111111111111111', '/repo/src/a.ts', 1));
    const other = auditEvent('other', warning('222222222222222222222222', '/repo/src/b.ts', 2));
    const repaired = auditEvent('repaired', clear(3), '/repo/src/a.ts');
    const summary = buildDuplicationCompletion([first, other, repaired]);
    expect(summary).toMatchObject({
      enforcement: 'blocking', status: 'warning', warningCount: 1,
      unresolvedCount: 0, suppressedCount: 0,
      matches: [{matchId: '222222222222222222222222'}],
    });
    expect(activeDuplicationMatchIds([first, other, repaired]))
      .toEqual(new Set(['222222222222222222222222']));
  });

  it('keeps unresolved paths visible and reports fully suppressed warnings', () => {
    const warningEvent = auditEvent('warning', warning('aaaaaaaaaaaaaaaaaaaaaaaa', '/repo/src/a.ts', 1));
    const unresolvedEvent = auditEvent('unresolved', {
      ...clear(2), status: 'unresolved', baselineGeneration: 'unavailable',
      rationale: 'Evidence unavailable.',
    }, '/repo/src/b.ts');
    const suppression = {
      matchId: 'aaaaaaaaaaaaaaaaaaaaaaaa', reasonCode: 'separate-boundary' as const,
      reason: 'Separate trust boundaries require this implementation.',
      createdAt: '2026-07-25T00:00:03.000Z', toolCallId: 'suppress-1',
    };
    expect(buildDuplicationCompletion([warningEvent], [suppression])).toMatchObject({
      status: 'suppressed', warningCount: 0, suppressedCount: 1,
    });
    expect(buildDuplicationCompletion([warningEvent, unresolvedEvent], [suppression])).toMatchObject({
      status: 'unresolved', warningCount: 0, unresolvedCount: 1, suppressedCount: 1,
    });
  });

  it('detects activity within the current run boundary', () => {
    const event = auditEvent('warning', warning('aaaaaaaaaaaaaaaaaaaaaaaa', '/repo/src/a.ts', 1));
    expect(hasDuplicationActivity([event], '2026-07-24T23:59:59.000Z')).toBe(true);
    expect(hasDuplicationActivity([event], '2026-07-25T00:00:02.000Z')).toBe(false);
  });

  it('reports clear after a later clear receipt removes the final warning', () => {
    const warningEvent = auditEvent('warning', warning('aaaaaaaaaaaaaaaaaaaaaaaa', '/repo/src/a.ts', 1));
    const clearEvent = auditEvent('clear', clear(2), '/repo/src/a.ts');
    expect(buildDuplicationCompletion([warningEvent, clearEvent])).toEqual({
      enforcement: 'warning', status: 'clear', warningCount: 0,
      unresolvedCount: 0, suppressedCount: 0, matches: [],
    });
  });

  it('suppresses only an exact active match with a bounded auditable reason', async () => {
    const session = createSession({workspace: '/repo', model: 'test', provider: 'compatible'});
    session.audit?.push(auditEvent('warning', warning('abcdef0123456789abcdef01', '/repo/src/a.ts', 1)));
    const context = {
      config: {} as MosaicConfig,
      workspace: new WorkspaceAccess(['/repo']),
      session,
      toolCallId: 'suppress-tool',
    };
    const result = await duplicationTool.execute({
      action: 'suppress',
      match_id: 'abcdef0123456789abcdef01',
      reason_code: 'protocol-required',
      reason: 'The protocol requires separate trust-boundary validation here.',
    }, context);
    expect(result.metadata?.duplicationSuppression).toMatchObject({
      matchId: 'abcdef0123456789abcdef01', toolCallId: 'suppress-tool',
    });
    expect(session.duplicationSuppressions).toHaveLength(1);
    await expect(duplicationTool.execute({
      action: 'suppress',
      match_id: 'abcdef0123456789abcdef01',
      reason_code: 'other',
      reason: 'Trying to suppress it a second time is not allowed.',
    }, context)).rejects.toThrow('already suppressed');
    await expect(duplicationTool.execute({
      action: 'suppress',
      match_id: 'ffffffffffffffffffffffff',
      reason_code: 'false-positive',
      reason: 'This id was never emitted by the runtime audit.',
    }, context)).rejects.toThrow();
    await expect(duplicationTool.execute({
      action: 'suppress',
      match_id: 'ffffffffffffffffffffffff',
      reason_code: 'other',
      reason: '```ts\nconst API_KEY=secret-value\n```',
    }, context)).rejects.toThrow();
  });
});

function auditEvent(id: string, receipt: DuplicationAuditReceipt, changedPath?: string): SessionAuditEvent {
  return {
    id, createdAt: `2026-07-25T00:00:0${receipt.changeSequence}.000Z`,
    type: 'tool', toolCallId: id, tool: 'write_file', category: 'write', outcome: 'success',
    metadata: {changedFiles: changedPath ? [changedPath] : pathsFor(receipt), duplicationAudit: receipt},
  };
}

function warning(matchId: string, changedPath: string, changeSequence: number): DuplicationAuditReceipt {
  return {
    baselineGeneration: `g-${changeSequence}`,
    changeSequence,
    status: 'warning',
    warningOnly: true,
    checkedFunctions: 1,
    skippedSmallFunctions: 0,
    matches: [{
      matchId,
      changedPath,
      changedSymbol: 'copy',
      candidatePath: '/repo/src/helper.ts',
      candidateSymbol: 'helper',
      kind: 'type-1-or-2',
      similarity: 1,
    }],
    rationale: 'Duplicate candidate found.',
  };
}

function clear(changeSequence: number): DuplicationAuditReceipt {
  return {
    baselineGeneration: `g-${changeSequence}`,
    changeSequence,
    status: 'clear',
    warningOnly: true,
    checkedFunctions: 1,
    skippedSmallFunctions: 0,
    matches: [],
    rationale: 'No duplicate candidate found.',
  };
}

function pathsFor(receipt: DuplicationAuditReceipt): string[] {
  return receipt.matches.length ? receipt.matches.map((match) => match.changedPath) : ['/repo/src/a.ts'];
}
