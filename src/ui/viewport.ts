import type {TimelineItem} from './components.js';
import {
  bannerContentRows,
  clarificationHint,
  clarificationOptionLabel,
  contextClippedReceiptText,
  contextDegradedReceiptText,
  contextInspectorEntries,
  isChineseText,
  listPanelRows,
  resolveGlyphs,
  richTextLine,
  type RichTextScanState,
} from './components.js';
import {displayWidth, limitTerminalText, sanitizeTerminalText, sliceDisplayFromEnd, terminalEllipsis, truncateDisplay, wrapDisplayLines, wrapDisplayRows} from './text.js';

/**
 * Width of the status-glyph gutter every transcript row reserves. Must stay in
 * sync with `components.GUTTER`: these row estimates are what anchors the
 * viewport, and a mismatch shows up as drift while scrolling.
 */
const GUTTER = 2;

/** Extra indent applied to expanded tool output, on top of the gutter. */
const OUTPUT_INDENT = 2;

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
    // A fully-visible item still has to respect what is left of the budget:
    // the offset window can start mid-item, and its own minimum height (a
    // banner's gap, a tool row's gap) may exceed the remaining rows.
    if (visibleRows > remaining) {
      visible = enforceRowBudget(visible, {...options, rows: remaining});
      visibleRows = estimateTimelineItemRows(visible, options);
    }
    if (visibleRows > remaining) break;
    selected.unshift(visible);
    remaining -= visibleRows;
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
  const contentWidth = Math.max(1, width - GUTTER);
  const outputWidth = Math.max(1, width - GUTTER - OUTPUT_INDENT);
  const availableRows = Math.max(1, endRow - startRow);
  if (item.kind === 'assistant') {
    // Only a streaming reply spends a row on chrome; a settled reply is content
    // from its first row, matching the nameplate-free renderer.
    const chrome = item.streaming ? 1 : 0;
    const rows = visualTextRows(item.text, contentWidth);
    const desiredEnd = Math.min(rows.length, Math.max(1, endRow - chrome));
    const selected = rows.slice(Math.max(0, desiredEnd - Math.max(1, availableRows - chrome)), desiredEnd);
    return {...item, clipped: true, text: markWindowedRows(selected, desiredEnd - selected.length, desiredEnd, rows.length, contentWidth)};
  }
  if (item.kind === 'user') {
    const rows = visualTextRows(item.text, contentWidth);
    const desiredEnd = Math.min(rows.length, endRow);
    const selected = rows.slice(Math.max(0, desiredEnd - availableRows), desiredEnd);
    return {...item, clipped: true, text: markWindowedRows(selected, desiredEnd - selected.length, desiredEnd, rows.length, contentWidth)};
  }
  if (item.kind === 'notice') {
    const rows = visualTextRows(item.text, contentWidth);
    const desiredEnd = Math.min(rows.length, endRow);
    const selected = rows.slice(Math.max(0, desiredEnd - availableRows), desiredEnd);
    return {...item, text: markWindowedRows(selected, desiredEnd - selected.length, desiredEnd, rows.length, contentWidth)};
  }
  if (item.kind === 'tool' && item.output && (options.showToolOutput || options.expandedToolId === item.id)) {
    const baseRows = toolChromeRows(item, options);
    const rows = visualTextRows(item.output, outputWidth);
    const desiredEnd = Math.min(rows.length, Math.max(1, endRow - baseRows));
    const selected = rows.slice(
      Math.max(0, desiredEnd - Math.max(1, availableRows - baseRows)),
      desiredEnd,
    );
    return {...item, output: markWindowedRows(selected, desiredEnd - selected.length, desiredEnd, rows.length, outputWidth)};
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

/**
 * Split text into the rows Ink will render, so a windowed slice of a long item
 * lines up with what the same text looks like unclipped. Each returned row
 * already fits the width, so re-wrapping it is a no-op.
 */
function visualTextRows(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const output: string[] = [];
  for (const source of sanitizeTerminalText(value).split('\n')) {
    output.push(...wrapDisplayLines(source || ' ', safeWidth));
  }
  return output.length ? output : [' '];
}

function clipTimelineItem(item: TimelineItem, options: TimelineViewportOptions): TimelineItem {
  return enforceRowBudget(clipTimelineItemContent(item, options), options);
}

/**
 * Last line of defence for the row budget. Some items have a floor the content
 * clipper cannot go below — a banner is a fixed row plus its gap, a tool row is
 * a row plus its gap — so a one- or two-row viewport would still overflow and
 * push the composer off screen. Drop the trailing gap first, since it is pure
 * spacing, and only then fall back to a single truncated line.
 */
function enforceRowBudget(item: TimelineItem, options: TimelineViewportOptions): TimelineItem {
  const budget = Math.max(1, options.rows);
  if (estimateTimelineItemRows(item, options) <= budget) return item;
  if (item.kind === 'tool') {
    const gapless: TimelineItem = {...item, grouped: true};
    if (estimateTimelineItemRows(gapless, options) <= budget) return gapless;
  }
  const summary = timelineItemSummary(item);
  return {
    id: item.id,
    kind: 'notice',
    text: truncateDisplay(summary, Math.max(1, Math.floor(options.width) - GUTTER)),
  };
}

/**
 * One-line stand-in for an item that cannot fit its own minimum height. The
 * separator comes from the active glyph set, so an ASCII, dumb, or
 * screen-reader terminal never receives a Unicode middot here.
 */
function timelineItemSummary(item: TimelineItem): string {
  const separator = resolveGlyphs().separator;
  if (item.kind === 'banner') return `${item.status === 'ready' ? 'ready' : item.status} ${separator} v${item.version}`;
  if (item.kind === 'tool') return `${item.name} ${item.errorDetail || item.detail}`;
  if (item.kind === 'user' || item.kind === 'assistant' || item.kind === 'notice') {
    return sanitizeTerminalText(item.text).replace(/\s+/gu, ' ').trim() || item.kind;
  }
  if (item.kind === 'list') return item.title;
  return item.kind;
}

function clipTimelineItemContent(item: TimelineItem, options: TimelineViewportOptions): TimelineItem {
  const width = Math.max(1, Math.floor(options.width));
  const contentWidth = Math.max(1, width - GUTTER);
  if (item.kind === 'assistant') {
    // Only an active stream still costs a row above the text.
    const reserved = item.streaming ? 1 : 0;
    return {...item, clipped: true, text: tailText(item.text, contentWidth, Math.max(1, options.rows - reserved))};
  }
  if (item.kind === 'user') {
    return {...item, clipped: true, text: tailText(item.text, contentWidth, options.rows)};
  }
  if (item.kind === 'notice') {
    return {...item, text: tailText(item.text, contentWidth, options.rows)};
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
    const outputRows = Math.max(1, options.rows - toolChromeRows(item, options));
    return {...item, output: tailText(item.output, Math.max(1, width - GUTTER - OUTPUT_INDENT), outputRows)};
  }
  return item;
}

/**
 * Rows expanded tool output costs. `components.ToolRow` bounds the text with
 * `limitTerminalText` first — which caps *source* lines and appends its own
 * markers — and only then renders it as rich text, so the row count has to
 * follow the same order. Scoring the raw output and clamping the total instead
 * undercounts badly at narrow widths, where each source line wraps several times.
 */
function toolOutputRows(output: string, rowWidth: number, compact: boolean): number {
  const limited = limitTerminalText(output, compact ? 24 : 80);
  return richTextRows(limited.text, Math.max(1, rowWidth - GUTTER - OUTPUT_INDENT)) +
    (limited.truncated ? 1 : 0);
}

/**
 * Rows a tool row costs before its output: the aligned row itself, an optional
 * meta line, and the trailing gap when it is the last of a contiguous run.
 * Mirrors `components.ToolRow`.
 */
function toolChromeRows(
  item: Extract<TimelineItem, {kind: 'tool'}>,
  options: TimelineViewportOptions,
): number {
  return 1 + (item.meta ? 1 : 0) + (item.grouped || options.compact ? 0 : 1);
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
    // Keep the tail of the line, then take exactly the rows that fit. Slicing
    // by `remaining * width` alone overshoots, because word wrapping leaves
    // short rows; re-wrapping and keeping the last `remaining` rows is what
    // makes the clipped item score the height it was budgeted.
    const tail = sliceDisplayFromEnd(line, remaining * safeWidth);
    selected.unshift(wrapDisplayLines(tail, safeWidth).slice(-remaining).join('\n'));
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
  if (item.kind === 'user') return wrappedRows(item.text, Math.max(1, rowWidth - GUTTER)) + (item.clipped ? 0 : gap);
  if (item.kind === 'assistant') {
    // No nameplate row any more; only an active stream adds a status row.
    return (item.streaming ? 1 : 0) + richTextRows(item.text, Math.max(1, rowWidth - GUTTER)) +
      (item.clipped ? 0 : gap);
  }
  if (item.kind === 'notice') return wrappedRows(item.text, Math.max(1, rowWidth - GUTTER));
  if (item.kind === 'update') return (rowWidth < 48 ? 3 : 2) + (item.highlights?.length ?? 0);
  if (item.kind === 'tool') {
    // One aligned row, plus an optional checkpoint/meta line, plus the bounded
    // output when expanded. `components.ToolRow` renders exactly this shape; a
    // narrow terminal no longer adds a second detail row.
    const metaRows = item.meta ? 1 : 0;
    const outputRows = (showToolOutput || item.id === expandedToolId) && item.output
      ? toolOutputRows(item.output, rowWidth, compact)
      : 0;
    return 1 + metaRows + outputRows + (item.grouped ? 0 : gap);
  }
  if (item.kind === 'list') return listPanelRows(item.entries, rowWidth);
  if (item.kind === 'context-inspector') {
    // Heading row plus the evidence list, scored from the same entries the
    // renderer builds — a narrow terminal stacks each detail onto its own row.
    return 1 + listPanelRows(contextInspectorEntries({
      status: item.status,
      working: item.working,
      summary: item.summary,
      compact,
      sources: item.sources,
      separator: resolveGlyphs().separator,
    }), rowWidth, true);
  }
  if (item.kind === 'theme') return 3;
  if (item.kind === 'context') {
    // A routine retrieval renders nothing at all. The clipped and degraded
    // receipts wrap rather than truncate, because they carry the remedy, so
    // they are scored like a notice — see `components.WrappedReceipt`.
    const contentWidth = Math.max(1, rowWidth - GUTTER);
    const separator = resolveGlyphs().separator;
    const clippedRows = item.truncated && !item.degradation
      ? wrappedRows(contextClippedReceiptText(item.engine, item.hits, separator), contentWidth)
      : 0;
    const degradedRows = item.degradation
      ? wrappedRows(contextDegradedReceiptText(item.degradation), contentWidth)
      : 0;
    return clippedRows + degradedRows;
  }
  // Per-turn model-input estimates never enter the transcript.
  if (item.kind === 'prompt') return 0;
  // Every receipt row is now single-line at any width: the detail is dropped
  // rather than wrapped, so a narrow terminal cannot double the height.
  if (item.kind === 'skill' || item.kind === 'memory' || item.kind === 'compaction' || item.kind === 'turn') return 1;
  if (item.kind === 'agent-message' || item.kind === 'workflow') return 1;
  if (item.kind === 'agent') return 1;
  if (item.kind === 'clarification') {
    // A pending question wraps rather than truncates: an option whose
    // consequence was cut off is not answerable. The trailing hint is truncated,
    // not wrapped, and the block always keeps its gap. Mirrors `components`.
    const contentWidth = Math.max(1, rowWidth - GUTTER);
    const chinese = isChineseText(item.pending.question);
    const optionSeparator = resolveGlyphs().separator;
    const optionRows = item.pending.options.reduce((rows, option, index) => {
      const label = clarificationOptionLabel(option, index, chinese);
      return rows + (rowWidth < 48
        ? 1 + wrappedRows(option.impact, contentWidth)
        : wrappedRows(`${label} ${optionSeparator} ${option.impact}`, contentWidth));
    }, 0);
    return wrappedRows(item.pending.question, contentWidth) + optionRows + 1 + 1;
  }
  // The fresh-session banner never wraps: `bannerLayout` emits single-line
  // rows only, so its height is exact at any width. The trailing gap is fixed
  // (the banner keeps its breathing room even in compact mode, matching the
  // renderer's unconditional margin).
  if (item.kind === 'banner') return bannerContentRows(item, rowWidth) + 1;
  return 1;
}

/**
 * Mirror of the `RichText` renderer's row shape. Each source line is turned into
 * the exact visible string the renderer produces — including its code rail or
 * list marker, and with inline-markup delimiters removed — and then wrapped at
 * the same width. Scoring the content against a reduced width instead disagrees
 * with the render as soon as a line wraps, because Ink wraps the whole `<Text>`
 * including its prefix.
 */
function richTextRows(value: string, width: number): number {
  const state: RichTextScanState = {inCode: false};
  let rows = 0;
  for (const line of sanitizeTerminalText(value).split('\n')) {
    const rendered = richTextLine(line, state);
    if (rendered === null) continue;
    rows += wrapDisplayRows(rendered, width);
  }
  return rows;
}

function wrappedRows(value: string, width: number): number {
  const safeWidth = Math.max(1, width);
  return sanitizeTerminalText(value).split('\n').reduce((rows, line) =>
    rows + wrapDisplayRows(line || ' ', safeWidth), 0);
}
