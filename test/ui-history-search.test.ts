import {describe, expect, it} from 'vitest';
import {
  createHistorySearchState,
  moveHistorySearchSelection,
  resolveHistorySearch,
  selectedHistorySearchValue,
  setHistorySearchActiveIndex,
  setHistorySearchQuery,
} from '../src/ui/history-search.js';

describe('reverse history search', () => {
  it('returns unique non-empty history from newest to oldest for an empty query', () => {
    const history = ['npm test', 'git status', 'npm test', ' ', '部署 项目', 'git status'];
    const state = createHistorySearchState(history, 'unfinished draft');

    expect(state.query).toBe('');
    expect(state.history).toEqual(['git status', '部署 项目', 'npm test']);
    expect(state.results).toEqual(state.history);
    expect(state.activeIndex).toBe(0);
    expect(selectedHistorySearchValue(state)).toBe('git status');
    expect(history).toEqual(['npm test', 'git status', 'npm test', ' ', '部署 项目', 'git status']);
  });

  it('matches case-insensitively and supports CJK queries', () => {
    const initial = createHistorySearchState([
      'npm test -- --run',
      '修复登录流程',
      '部署 项目到测试环境',
      'NPM TEST',
    ], 'draft');

    const latin = setHistorySearchQuery(initial, 'npm test');
    expect(latin.results).toEqual(['NPM TEST', 'npm test -- --run']);
    expect(latin.activeIndex).toBe(0);

    const cjk = setHistorySearchQuery(latin, '项目');
    expect(cjk.results).toEqual(['部署 项目到测试环境']);
    expect(selectedHistorySearchValue(cjk)).toBe('部署 项目到测试环境');
  });

  it('moves and directly sets the active result without wrapping', () => {
    const initial = createHistorySearchState(['one', 'two', 'three'], 'draft');
    const older = moveHistorySearchSelection(initial, 'older');
    expect(older.activeIndex).toBe(1);
    expect(selectedHistorySearchValue(older)).toBe('two');
    expect(moveHistorySearchSelection(older, 'newer').activeIndex).toBe(0);
    expect(setHistorySearchActiveIndex(initial, 99).activeIndex).toBe(2);
    expect(setHistorySearchActiveIndex(initial, -99).activeIndex).toBe(0);
  });

  it('selects a match while cancel and no-match selection restore the original draft', () => {
    const initial = createHistorySearchState(['npm test', 'git status'], 'keep this draft');
    const match = setHistorySearchQuery(initial, 'git');
    expect(resolveHistorySearch(match, 'select')).toBe('git status');
    expect(resolveHistorySearch(match, 'cancel')).toBe('keep this draft');

    const missing = setHistorySearchQuery(match, '不存在');
    expect(missing.results).toEqual([]);
    expect(missing.activeIndex).toBe(-1);
    expect(selectedHistorySearchValue(missing)).toBeUndefined();
    expect(resolveHistorySearch(missing, 'select')).toBe('keep this draft');
    expect(resolveHistorySearch(missing, 'cancel')).toBe('keep this draft');
  });

  it('deduplicates canonically equivalent Unicode entries using the newest spelling', () => {
    const state = createHistorySearchState(['café', 'status', 'cafe\u0301'], 'draft');
    expect(state.history).toEqual(['cafe\u0301', 'status']);
    expect(setHistorySearchQuery(state, 'CAFÉ').results).toEqual(['cafe\u0301']);
  });
});
