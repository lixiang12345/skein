export interface HistorySearchState {
  /** Input that was present before Ctrl+R opened the search. */
  readonly draft: string;
  /** Unique history entries ordered from newest to oldest. */
  readonly history: readonly string[];
  readonly query: string;
  readonly results: readonly string[];
  /** Selected result, or -1 when the query has no matches. */
  readonly activeIndex: number;
}

export type HistorySearchDirection = 'older' | 'newer';
export type HistorySearchResolution = 'select' | 'cancel';

export function createHistorySearchState(
  history: readonly string[],
  draft: string,
  query = '',
): HistorySearchState {
  const uniqueHistory = uniqueNewestFirst(history);
  return stateForQuery({
    draft,
    history: uniqueHistory,
    query: '',
    results: uniqueHistory,
    activeIndex: uniqueHistory.length ? 0 : -1,
  }, query);
}

export function setHistorySearchQuery(
  state: HistorySearchState,
  query: string,
): HistorySearchState {
  if (query === state.query) return state;
  return stateForQuery(state, query);
}

export function moveHistorySearchSelection(
  state: HistorySearchState,
  direction: HistorySearchDirection,
): HistorySearchState {
  if (!state.results.length) return state.activeIndex === -1 ? state : {...state, activeIndex: -1};
  const delta = direction === 'older' ? 1 : -1;
  return setHistorySearchActiveIndex(state, state.activeIndex + delta);
}

export function setHistorySearchActiveIndex(
  state: HistorySearchState,
  activeIndex: number,
): HistorySearchState {
  if (!state.results.length) return state.activeIndex === -1 ? state : {...state, activeIndex: -1};
  const requested = Number.isFinite(activeIndex) ? Math.trunc(activeIndex) : 0;
  const next = Math.max(0, Math.min(requested, state.results.length - 1));
  return next === state.activeIndex ? state : {...state, activeIndex: next};
}

export function selectedHistorySearchValue(state: HistorySearchState): string | undefined {
  if (state.activeIndex < 0) return undefined;
  return state.results[state.activeIndex];
}

/** Resolve the overlay without losing the draft when the user cancels or has no match. */
export function resolveHistorySearch(
  state: HistorySearchState,
  resolution: HistorySearchResolution,
): string {
  if (resolution === 'cancel') return state.draft;
  return selectedHistorySearchValue(state) ?? state.draft;
}

function stateForQuery(state: HistorySearchState, query: string): HistorySearchState {
  const normalizedQuery = normalizeSearchText(query);
  const results = normalizedQuery
    ? state.history.filter((entry) => normalizeSearchText(entry).includes(normalizedQuery))
    : [...state.history];
  return {
    ...state,
    query,
    results,
    activeIndex: results.length ? 0 : -1,
  };
}

function uniqueNewestFirst(history: readonly string[]): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index] as string;
    if (!entry.trim()) continue;
    const identity = entry.normalize('NFC');
    if (seen.has(identity)) continue;
    seen.add(identity);
    entries.push(entry);
  }
  return entries;
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}
