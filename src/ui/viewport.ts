import type {TimelineItem} from './components.js';
import {displayWidth, sanitizeTerminalText, sliceDisplayFromEnd, terminalEllipsis, truncateDisplay} from './text.js';

export interface TimelineViewportOptions {
  width: number;
  rows: number;
  compact?: boolean;
  showToolOutput?: boolean;
  expandedToolId?: string;
}

/** Keep a recent, contiguous transcript window and bound even a single long latest item. */
export function fitTimelineToRows(
  items: readonly TimelineItem[],
  options: TimelineViewportOptions,
): TimelineItem[] {
  if (!items.length || options.rows <= 0) return [];
  const selected: TimelineItem[] = [];
  let used = 0;
  let firstIncluded = items.length;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] as TimelineItem;
    const itemRows = estimateTimelineItemRows(item, options);
    if (!selected.length && itemRows > options.rows) {
      selected.unshift(clipTimelineItem(item, options));
      firstIncluded = index;
      used = options.rows;
      break;
    }
    if (selected.length && used + itemRows > options.rows) break;
    selected.unshift(item);
    firstIncluded = index;
    used += itemRows;
    if (used >= options.rows) break;
  }
  if (firstIncluded > 0) {
    const marker: TimelineItem = {
      id: `viewport-hidden-${firstIncluded}`,
      kind: 'notice',
      text: `${firstIncluded} earlier transcript ${firstIncluded === 1 ? 'entry' : 'entries'} hidden`,
    };
    const markerRows = estimateTimelineItemRows(marker, options);
    while (selected.length > 1 && used + markerRows > options.rows) {
      const removed = selected.shift();
      if (!removed) break;
      firstIncluded += 1;
      used -= estimateTimelineItemRows(removed, options);
    }
    if (used + markerRows <= options.rows) {
      selected.unshift({...marker, id: `viewport-hidden-${firstIncluded}`,
        text: `${firstIncluded} earlier transcript ${firstIncluded === 1 ? 'entry' : 'entries'} hidden`});
    }
  }
  return selected;
}

function clipTimelineItem(item: TimelineItem, options: TimelineViewportOptions): TimelineItem {
  const width = Math.max(1, Math.floor(options.width));
  if (item.kind === 'assistant') {
    return {...item, clipped: true, text: tailText(item.text, Math.max(1, width - 2), Math.max(1, options.rows - 1))};
  }
  if (item.kind === 'user') {
    return {...item, clipped: true, text: tailText(item.text, Math.max(1, width - 2), options.rows)};
  }
  if (item.kind === 'notice') {
    return {...item, text: tailText(item.text, width, options.rows)};
  }
  if (item.kind === 'tool' && item.output && (options.showToolOutput || options.expandedToolId === item.id)) {
    const detailRows = width < 64 && (item.errorDetail || item.detail) ? 1 : 0;
    const outputRows = Math.max(1, options.rows - 1 - detailRows);
    return {...item, output: tailText(item.output, Math.max(1, width - 2), outputRows)};
  }
  return item;
}

function tailText(value: string, width: number, maxRows: number): string {
  const normalized = sanitizeTerminalText(value);
  const safeWidth = Math.max(1, width);
  const safeRows = Math.max(1, maxRows);
  const marker = truncateDisplay(`${terminalEllipsis()} earlier hidden`, safeWidth);
  if (safeRows === 1) {
    const markerPrefix = `${terminalEllipsis()} `;
    return `${markerPrefix}${sliceDisplayFromEnd(normalized.replace(/\s+/g, ' '), Math.max(1, safeWidth - displayWidth(markerPrefix)))}`;
  }

  let remaining = safeRows - 1;
  const selected: string[] = [];
  const lines = normalized.split('\n');
  for (let index = lines.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const line = lines[index] || ' ';
    const rows = wrappedRows(line, safeWidth);
    if (rows <= remaining) {
      selected.unshift(line);
      remaining -= rows;
      continue;
    }
    selected.unshift(sliceDisplayFromEnd(line, remaining * safeWidth));
    remaining = 0;
  }
  return `${marker}\n${selected.join('\n')}`;
}

export function estimateTimelineItemRows(
  item: TimelineItem,
  {width, compact = false, showToolOutput = false, expandedToolId}: TimelineViewportOptions,
): number {
  const rowWidth = Math.max(1, Math.floor(width));
  const gap = compact ? 0 : 1;
  if (item.kind === 'user') return wrappedRows(item.text, Math.max(1, rowWidth - 2)) + (item.clipped ? 0 : gap);
  if (item.kind === 'assistant') {
    return 1 + richTextRows(item.text, Math.max(1, rowWidth - 2)) + (item.clipped ? 0 : gap);
  }
  if (item.kind === 'notice') return wrappedRows(item.text, rowWidth);
  if (item.kind === 'tool') {
    const narrow = rowWidth < 64;
    const detail = item.errorDetail || item.detail;
    const detailRows = narrow && detail ? 1 : 0;
    const metaRows = item.meta ? 1 : 0;
    const outputRows = (showToolOutput || item.id === expandedToolId) && item.output
      ? Math.min(compact ? 25 : 81, richTextRows(item.output, Math.max(1, rowWidth - 2)))
      : 0;
    return 1 + detailRows + metaRows + outputRows;
  }
  if (item.kind === 'list') {
    const entryRows = item.entries.reduce((total, entry) => total + 1 + (entry.detail ? 1 : 0), 0);
    return 1 + entryRows + 1;
  }
  if (item.kind === 'context-inspector') {
    const workingRows = item.working
      ? 2 + item.working.constraints.length + item.working.decisions.length + item.working.openQuestions.length
      : 0;
    return 3 + workingRows + (item.summary ? wrappedRows(item.summary, Math.max(1, rowWidth - 2)) : 0) + (item.sources?.length ? 2 : 0);
  }
  if (item.kind === 'theme') return 3;
  if (item.kind === 'context') {
    const metaRows = rowWidth < 64 ? 2 : 1;
    const spanLimit = compact ? 2 : 3;
    const spanCount = Math.min(item.spans?.length ?? 0, spanLimit);
    const moreRow = (item.spans?.length ?? 0) > spanLimit ? 1 : 0;
    const degradationRows = item.degradation ? metaRows : 0;
    return metaRows + spanCount + moreRow + degradationRows;
  }
  if (item.kind === 'prompt') {
    return rowWidth < 64 ? 2 : 1;
  }
  if (item.kind === 'skill' || item.kind === 'memory' || item.kind === 'compaction') {
    return rowWidth < 64 ? 2 : 1;
  }
  if (item.kind === 'agent' || item.kind === 'agent-message') return rowWidth < 64 ? 2 : 1;
  if (item.kind === 'workflow') return rowWidth < 64 ? 2 : 1;
  return 1;
}

function richTextRows(value: string, width: number): number {
  return sanitizeTerminalText(value).split('\n')
    .reduce((rows, line) => rows + wrappedRows(line || ' ', width), 0);
}

function wrappedRows(value: string, width: number): number {
  const safeWidth = Math.max(1, width);
  return sanitizeTerminalText(value).split('\n').reduce((rows, line) =>
    rows + Math.max(1, Math.ceil(displayWidth(line) / safeWidth)), 0);
}
