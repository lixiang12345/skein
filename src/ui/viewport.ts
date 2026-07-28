import type {TimelineItem} from './components.js';
import {displayWidth, sanitizeTerminalText, sliceDisplay, sliceDisplayFromEnd, terminalEllipsis, truncateDisplay} from './text.js';

export interface TimelineViewportOptions {
  width: number;
  rows: number;
  compact?: boolean;
  showToolOutput?: boolean;
  expandedToolId?: string;
  /** Render rows this far above the latest transcript row. */
  scrollOffsetRows?: number;
}

/** Keep a recent, contiguous transcript window and bound even a single long latest item. */
export function fitTimelineToRows(
  items: readonly TimelineItem[],
  options: TimelineViewportOptions,
): TimelineItem[] {
  if (!items.length || options.rows <= 0) return [];
  if ((options.scrollOffsetRows ?? 0) > 0) return fitScrolledTimelineToRows(items, options);
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

/** Total rendered transcript height for scroll bounds and stable viewport anchoring. */
export function timelineTotalRows(
  items: readonly TimelineItem[],
  options: TimelineViewportOptions,
): number {
  return items.reduce((rows, item) => rows + estimateTimelineItemRows(item, options), 0);
}

function fitScrolledTimelineToRows(
  items: readonly TimelineItem[],
  options: TimelineViewportOptions,
): TimelineItem[] {
  const totalRows = timelineTotalRows(items, options);
  const maximumOffset = Math.max(0, totalRows - options.rows);
  const offset = Math.min(maximumOffset, Math.max(0, Math.floor(options.scrollOffsetRows ?? 0)));
  let windowEnd = totalRows - offset;
  let cursor = totalRows;
  let remaining = options.rows;
  const selected: TimelineItem[] = [];

  for (let index = items.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const item = items[index] as TimelineItem;
    const itemRows = estimateTimelineItemRows(item, options);
    const itemEnd = cursor;
    const itemStart = itemEnd - itemRows;
    cursor = itemStart;
    if (itemStart >= windowEnd) continue;

    const localEnd = Math.min(itemRows, windowEnd - itemStart);
    if (localEnd <= 0) continue;
    const localStart = Math.max(0, localEnd - remaining);
    let visible = localStart === 0 && localEnd === itemRows
      ? item
      : clipTimelineItemRange(item, options, localStart, localEnd);
    let visibleRows = estimateTimelineItemRows(visible, options);
    if (visibleRows > remaining) {
      visible = clipTimelineItem(visible, {...options, rows: remaining});
      visibleRows = estimateTimelineItemRows(visible, options);
    }
    selected.unshift(visible);
    remaining -= Math.min(remaining, visibleRows);
    windowEnd = itemStart + localStart;
  }
  return selected;
}

function clipTimelineItemRange(
  item: TimelineItem,
  options: TimelineViewportOptions,
  startRow: number,
  endRow: number,
): TimelineItem {
  const width = Math.max(1, Math.floor(options.width));
  const availableRows = Math.max(1, endRow - startRow);
  if (item.kind === 'assistant') {
    // Only a streaming reply spends a row on chrome; a settled reply is content
    // from its first row, matching the nameplate-free renderer.
    const chrome = item.streaming ? 1 : 0;
    const rows = visualTextRows(item.text, Math.max(1, width - 2));
    const desiredEnd = Math.min(rows.length, Math.max(1, endRow - chrome));
    const selected = rows.slice(Math.max(0, desiredEnd - Math.max(1, availableRows - chrome)), desiredEnd);
    return {...item, clipped: true, text: markWindowedRows(selected, desiredEnd - selected.length, desiredEnd, rows.length, Math.max(1, width - 2))};
  }
  if (item.kind === 'user') {
    const rows = visualTextRows(item.text, Math.max(1, width - 2));
    const desiredEnd = Math.min(rows.length, endRow);
    const selected = rows.slice(Math.max(0, desiredEnd - availableRows), desiredEnd);
    return {...item, clipped: true, text: markWindowedRows(selected, desiredEnd - selected.length, desiredEnd, rows.length, Math.max(1, width - 2))};
  }
  if (item.kind === 'notice') {
    const rows = visualTextRows(item.text, Math.max(1, width - 2));
    const desiredEnd = Math.min(rows.length, endRow);
    const selected = rows.slice(Math.max(0, desiredEnd - availableRows), desiredEnd);
    return {...item, text: markWindowedRows(selected, desiredEnd - selected.length, desiredEnd, rows.length, Math.max(1, width - 2))};
  }
  if (item.kind === 'tool' && item.output && (options.showToolOutput || options.expandedToolId === item.id)) {
    const detailRows = width < 64 && (item.errorDetail || item.detail) ? 1 : 0;
    const baseRows = 1 + detailRows + (item.meta ? 1 : 0) + (item.grouped ? 0 : 1);
    const rows = visualTextRows(item.output, Math.max(1, width - 5));
    const desiredEnd = Math.min(rows.length, Math.max(1, endRow - baseRows));
    const selected = rows.slice(
      Math.max(0, desiredEnd - Math.max(1, availableRows - baseRows)),
      desiredEnd,
    );
    return {...item, output: markWindowedRows(selected, desiredEnd - selected.length, desiredEnd, rows.length, Math.max(1, width - 5))};
  }
  if (item.kind === 'list') {
    if (availableRows <= 1) return {id: item.id, kind: 'notice', text: truncateDisplay(item.title, width)};
    const entryBudget = Math.max(1, availableRows - 2);
    let rowCursor = 1;
    let endIndex = 0;
    while (endIndex < item.entries.length && rowCursor < endRow) {
      rowCursor += listEntryRows(item.entries[endIndex]!);
      endIndex += 1;
    }
    const entries: typeof item.entries = [];
    let used = 0;
    let firstIncluded = endIndex;
    for (let index = endIndex - 1; index >= 0; index -= 1) {
      const entry = item.entries[index]!;
      const rows = listEntryRows(entry);
      if (entries.length && used + rows > entryBudget) break;
      if (!entries.length && rows > entryBudget) {
        const {detail: _detail, ...compactEntry} = entry;
        entries.unshift(compactEntry);
        firstIncluded = index;
        used = 1;
        break;
      }
      entries.unshift(entry);
      firstIncluded = index;
      used += rows;
      if (used >= entryBudget) break;
    }
    const earlier = firstIncluded;
    const newer = Math.max(0, item.entries.length - endIndex);
    if (earlier > 0) makeRoomForListMarker(entries, entryBudget, () => used -= listEntryRows(entries.shift()!));
    if (earlier > 0 && used < entryBudget) {
      entries.unshift({label: `${terminalEllipsis()} ${earlier} earlier entries`});
      used += 1;
    }
    if (newer > 0) makeRoomForListMarker(entries, entryBudget, () => used -= listEntryRows(entries.pop()!));
    if (newer > 0 && used < entryBudget) entries.push({label: `${terminalEllipsis()} ${newer} newer entries`});
    return {...item, entries};
  }
  return clipTimelineItem(item, {...options, rows: availableRows});
}

function listEntryRows(entry: {detail?: string}): number {
  return 1 + (entry.detail ? 1 : 0);
}

function makeRoomForListMarker(
  entries: {detail?: string}[],
  budget: number,
  remove: () => void,
): void {
  let used = entries.reduce((rows, entry) => rows + listEntryRows(entry), 0);
  while (entries.length > 1 && used >= budget) {
    remove();
    used = entries.reduce((rows, entry) => rows + listEntryRows(entry), 0);
  }
}

function markWindowedRows(
  rows: string[],
  start: number,
  end: number,
  total: number,
  width: number,
): string {
  const selected = rows.length ? [...rows] : [' '];
  if (start > 0) selected[0] = truncateDisplay(`${terminalEllipsis()} ${selected[0] ?? ''}`, width, '');
  if (end < total) {
    const last = selected.length - 1;
    selected[last] = truncateDisplay(`${selected[last] ?? ''} ${terminalEllipsis()}`, width, '');
  }
  return selected.join('\n');
}

function visualTextRows(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const output: string[] = [];
  for (const source of sanitizeTerminalText(value).split('\n')) {
    let remaining = source || ' ';
    while (remaining) {
      let piece = sliceDisplay(remaining, safeWidth);
      if (!piece) piece = firstGrapheme(remaining);
      output.push(piece);
      remaining = remaining.slice(piece.length);
    }
  }
  return output.length ? output : [' '];
}

function firstGrapheme(value: string): string {
  if (typeof Intl.Segmenter === 'function') {
    return new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(value)[Symbol.iterator]().next().value?.segment ?? value[0] ?? '';
  }
  return [...value][0] ?? '';
}

function clipTimelineItem(item: TimelineItem, options: TimelineViewportOptions): TimelineItem {
  const width = Math.max(1, Math.floor(options.width));
  if (item.kind === 'assistant') {
    // Only an active stream still costs a row above the text.
    const reserved = item.streaming ? 1 : 0;
    return {...item, clipped: true, text: tailText(item.text, Math.max(1, width - 2), Math.max(1, options.rows - reserved))};
  }
  if (item.kind === 'user') {
    return {...item, clipped: true, text: tailText(item.text, Math.max(1, width - 2), options.rows)};
  }
  if (item.kind === 'notice') {
    return {...item, text: tailText(item.text, Math.max(1, width - 2), options.rows)};
  }
  if (item.kind === 'list') {
    if (options.rows <= 1) return {id: item.id, kind: 'notice', text: truncateDisplay(item.title, width)};
    const available = Math.max(1, options.rows - 2);
    const entries: typeof item.entries = [];
    let used = 0;
    let firstIncluded = item.entries.length;
    for (let index = item.entries.length - 1; index >= 0; index -= 1) {
      const entry = item.entries[index]!;
      const rows = 1 + (entry.detail ? 1 : 0);
      if (entries.length && used + rows > available) break;
      if (!entries.length && rows > available) {
        const {detail: _detail, ...compactEntry} = entry;
        entries.unshift(compactEntry);
        firstIncluded = index;
        used = 1;
        break;
      }
      entries.unshift(entry);
      firstIncluded = index;
      used += rows;
    }
    if (firstIncluded > 0) {
      while (entries.length > 1 && used >= available) {
        const removed = entries.shift();
        if (!removed) break;
        firstIncluded += 1;
        used -= 1 + (removed.detail ? 1 : 0);
      }
      if (used < available) {
        entries.unshift({label: `${terminalEllipsis()} ${firstIncluded} earlier entries hidden`});
      }
    }
    return {...item, entries};
  }
  if (item.kind === 'update') {
    const baseRows = width < 48 ? 3 : 2;
    if (options.rows < baseRows) {
      return {id: item.id, kind: 'notice', text: truncateDisplay(`Update available ${item.current} -> ${item.latest}`, width)};
    }
    const {highlights: _highlights, ...base} = item;
    const highlights = item.highlights?.slice(0, Math.max(0, options.rows - baseRows));
    return highlights?.length ? {...base, highlights} : base;
  }
  if (item.kind === 'tool' && item.output && (options.showToolOutput || options.expandedToolId === item.id)) {
    const detailRows = width < 64 && (item.errorDetail || item.detail) ? 1 : 0;
    const baseRows = 1 + detailRows + (item.meta ? 1 : 0) + (item.grouped ? 0 : 1);
    const outputRows = Math.max(1, options.rows - baseRows);
    return {...item, output: tailText(item.output, Math.max(1, width - 5), outputRows)};
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
    // No nameplate row any more; only an active stream adds a status row.
    return (item.streaming ? 1 : 0) + richTextRows(item.text, Math.max(1, rowWidth - 2)) +
      (item.clipped ? 0 : gap);
  }
  if (item.kind === 'notice') return wrappedRows(item.text, Math.max(1, rowWidth - 2));
  if (item.kind === 'tool-group') return 1 + (compact ? 0 : 1);
  if (item.kind === 'update') return (rowWidth < 48 ? 3 : 2) + (item.highlights?.length ?? 0);
  if (item.kind === 'tool') {
    const narrow = rowWidth < 64;
    const detail = item.errorDetail || item.detail;
    const detailRows = narrow && detail ? 1 : 0;
    const metaRows = item.meta ? 1 : 0;
    const outputRows = (showToolOutput || item.id === expandedToolId) && item.output
      ? Math.min(compact ? 25 : 81, richTextRows(item.output, Math.max(1, rowWidth - 5)))
      : 0;
    return 1 + detailRows + metaRows + outputRows + (item.grouped ? 0 : 1);
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
    const degradationRows = item.degradation ? metaRows : 0;
    return metaRows + degradationRows;
  }
  if (item.kind === 'prompt') {
    return rowWidth < 64 ? 2 : 1;
  }
  if (item.kind === 'skill' || item.kind === 'memory' || item.kind === 'compaction') {
    return rowWidth < 64 ? 2 : 1;
  }
  if (item.kind === 'agent' || item.kind === 'agent-message') return rowWidth < 64 ? 2 : 1;
  if (item.kind === 'workflow') return rowWidth < 64 ? 2 : 1;
  if (item.kind === 'clarification') {
    return 3 + item.pending.options.length * (rowWidth < 48 ? 2 : 1);
  }
  if (item.kind === 'banner') return 2;
  return 1;
}

/**
 * Mirror of the `RichText` renderer's row shape. Fenced code, quotes, and list
 * markers change how much width a line has left, and dropped fences emit no row
 * at all; the transcript viewport only anchors correctly while this agrees with
 * `ui/components.RichText`.
 */
function richTextRows(value: string, width: number): number {
  let inCode = false;
  let rows = 0;
  for (const line of sanitizeTerminalText(value).split('\n')) {
    const fence = line.trim().match(/^```+\s*([\w+#.-]*)/u);
    if (fence) {
      inCode = !inCode;
      // A language tag renders one caption row; bare and closing fences render none.
      if (inCode && fence[1]) rows += 1;
      continue;
    }
    if (inCode) {
      // The left rail costs two columns of the available width.
      rows += wrappedRows(line || ' ', Math.max(1, width - 2));
      continue;
    }
    const bullet = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
    if (bullet) {
      const markerWidth = displayWidth(bullet[1] ?? '') + displayWidth(bullet[2] as string) + 1;
      rows += wrappedRows(bullet[3] as string, Math.max(1, width - markerWidth));
      continue;
    }
    if (line.startsWith('> ')) {
      rows += wrappedRows(line.slice(2) || ' ', Math.max(1, width - 2));
      continue;
    }
    rows += wrappedRows(line || ' ', width);
  }
  return rows;
}

function wrappedRows(value: string, width: number): number {
  const safeWidth = Math.max(1, width);
  return sanitizeTerminalText(value).split('\n').reduce((rows, line) =>
    rows + Math.max(1, Math.ceil(displayWidth(line) / safeWidth)), 0);
}
