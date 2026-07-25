import {describe, expect, it} from 'vitest';
import {assessIntentSufficiency, resolvePendingInput} from '../../src/agent/intent-sufficiency.js';

describe('intent sufficiency', () => {
  it('executes explicit simple changes without asking', () => {
    const result = assessIntentSufficiency('Rename `oldName` to `newName` in src/name.ts.', 'implement', {
      complex: false, retrievalHits: 2,
    });
    expect(result.assessment.route).toBe('direct_execute');
    expect(result.pending).toBeUndefined();
  });

  it('uses workspace inspection for repository facts instead of asking the user', () => {
    const result = assessIntentSufficiency('Fix the current failing test by finding the shared root cause across modules.', 'debug', {
      complex: true, retrievalHits: 0,
    });
    expect(result).toMatchObject({assessment: {route: 'inspect_then_execute'}});
  });

  it('asks one targeted public API compatibility question', () => {
    const result = assessIntentSufficiency('重构公共接口并重命名所有导出，同时更新跨模块调用和测试。', 'refactor', {
      complex: true, retrievalHits: 4,
    });
    expect(result.assessment).toMatchObject({
      route: 'needs_input', reasons: ['public_api_compatibility_missing'],
    });
    expect(result.pending?.options).toHaveLength(2);
    expect(result.pending?.options[0]).toMatchObject({id: 'backward_compatible', recommended: true});
  });

  it('keeps a side-effect approval separate from clarification', () => {
    const result = assessIntentSufficiency('Publish the verified package to npm.', 'implement', {
      complex: false, retrievalHits: 0,
    });
    expect(result.assessment.route).toBe('permission_required');
    expect(result.pending).toBeUndefined();
  });

  it('resolves numbered answers without exposing hidden reasoning', () => {
    const pending = assessIntentSufficiency('Should this use a modal or inline editor?', 'implement', {
      complex: true, retrievalHits: 1,
    }).pending;
    expect(pending).toBeDefined();
    expect(resolvePendingInput(pending!, '2')).toMatchObject({answer: '2'});
    expect(resolvePendingInput(pending!, '2').decision).toContain('inline');
  });
});
