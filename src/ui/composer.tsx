import React, {useEffect, useRef, useState} from 'react';
import {Text, useInput, usePaste} from 'ink';
import {displayWidth, sanitizeTerminalText, terminalEllipsis, truncateDisplay} from './text.js';

const editorHistoryLimit = 100;

interface EditorSnapshot {
  value: string;
  cursor: number;
}

export function ComposerInput({
  value,
  onChange,
  onSubmit,
  onCursorChange,
  externalCursorOffset,
  focus = true,
  placeholder = '',
  width = 80,
  maxVisibleRows = 4,
  captureVerticalArrows = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string, mode: 'steer' | 'follow-up' | 'normal') => void;
  onCursorChange?: (offset: number) => void;
  externalCursorOffset?: number;
  focus?: boolean;
  placeholder?: string;
  width?: number;
  maxVisibleRows?: number;
  /** Let an owning palette use Up/Down without also moving the text cursor. */
  captureVerticalArrows?: boolean;
}) {
  const [cursorOffset, setCursorOffsetState] = useState(value.length);
  const valueRef = useRef(value);
  const cursorRef = useRef(value.length);
  const pendingControlledValueRef = useRef<string | undefined>(undefined);
  const preferredColumnRef = useRef<number | undefined>(undefined);
  const undoStackRef = useRef<EditorSnapshot[]>([]);
  const redoStackRef = useRef<EditorSnapshot[]>([]);

  useEffect(() => {
    const isInternalUpdate = pendingControlledValueRef.current === value;
    pendingControlledValueRef.current = undefined;
    valueRef.current = value;
    if (!isInternalUpdate) {
      undoStackRef.current = [];
      redoStackRef.current = [];
      preferredColumnRef.current = undefined;
    }
    const requested = isInternalUpdate
      ? cursorRef.current
      : externalCursorOffset ?? value.length;
    const next = cursorAtOrBefore(value, requested);
    cursorRef.current = next;
    setCursorOffsetState(next);
    if (!isInternalUpdate) onCursorChange?.(next);
  }, [value]);

  function setCursorOffset(offset: number, preservePreferredColumn = false): void {
    const next = cursorAtOrBefore(valueRef.current, offset);
    if (!preservePreferredColumn) preferredColumnRef.current = undefined;
    cursorRef.current = next;
    onCursorChange?.(next);
    setCursorOffsetState(next);
  }

  function commitEdit(nextValue: string, nextCursor: number): void {
    const current = {value: valueRef.current, cursor: cursorRef.current};
    const safeCursor = cursorAtOrBefore(nextValue, nextCursor);
    if (nextValue === current.value && safeCursor === current.cursor) return;

    if (nextValue !== current.value) {
      pushSnapshot(undoStackRef.current, current);
      redoStackRef.current = [];
    }

    // Input events can arrive in one terminal chunk. Keep the latest value
    // synchronously so a pasted command followed by Return submits that value.
    valueRef.current = nextValue;
    cursorRef.current = safeCursor;
    onCursorChange?.(safeCursor);
    pendingControlledValueRef.current = nextValue;
    preferredColumnRef.current = undefined;
    setCursorOffsetState(safeCursor);
    onChange(nextValue);
  }

  function restoreSnapshot(snapshot: EditorSnapshot): void {
    const safeCursor = cursorAtOrBefore(snapshot.value, snapshot.cursor);
    valueRef.current = snapshot.value;
    cursorRef.current = safeCursor;
    onCursorChange?.(safeCursor);
    pendingControlledValueRef.current = snapshot.value;
    preferredColumnRef.current = undefined;
    setCursorOffsetState(safeCursor);
    onChange(snapshot.value);
  }

  function undo(): void {
    const snapshot = undoStackRef.current.pop();
    if (!snapshot) return;
    pushSnapshot(redoStackRef.current, {value: valueRef.current, cursor: cursorRef.current});
    restoreSnapshot(snapshot);
  }

  function redo(): void {
    const snapshot = redoStackRef.current.pop();
    if (!snapshot) return;
    pushSnapshot(undoStackRef.current, {value: valueRef.current, cursor: cursorRef.current});
    restoreSnapshot(snapshot);
  }

  usePaste((text) => {
    insert(normalizeComposerPaste(text));
  }, {isActive: focus});

  useInput((input, key) => {
    const current = valueRef.current;
    const cursor = cursorRef.current;
    const commandInput = input.toLocaleLowerCase();
    if (key.tab || key.escape || (key.ctrl && commandInput === 'c')) return;
    if ((key.ctrl || key.super) && commandInput === 'z') {
      if (key.shift) redo();
      else undo();
      return;
    }
    if ((key.ctrl || key.super) && commandInput === 'y') {
      redo();
      return;
    }
    if (key.ctrl && input === 'a') {
      setCursorOffset(0);
      return;
    }
    if (key.ctrl && input === 'e') {
      setCursorOffset(current.length);
      return;
    }
    if (key.ctrl && input === 'u') {
      deleteRange(lineStart(current, cursor), cursor);
      return;
    }
    if (key.ctrl && input === 'k') {
      deleteRange(cursor, lineEnd(current, cursor));
      return;
    }
    if (key.ctrl && input === 'w') {
      deleteRange(previousWordBoundary(current, cursor), cursor);
      return;
    }
    if (key.meta && commandInput === 'b') {
      setCursorOffset(previousWordBoundary(current, cursor));
      return;
    }
    if (key.meta && commandInput === 'f') {
      setCursorOffset(nextWordBoundary(current, cursor));
      return;
    }
    if (key.meta && commandInput === 'd') {
      deleteRange(cursor, nextWordBoundary(current, cursor));
      return;
    }
    if ((key.upArrow || key.downArrow) && !captureVerticalArrows) {
      const result = moveComposerCursorVertically(
        current,
        cursor,
        key.upArrow ? 'up' : 'down',
        preferredColumnRef.current,
      );
      if (result.moved) {
        preferredColumnRef.current = result.preferredColumn;
        setCursorOffset(result.offset, true);
      }
      return;
    }
    if ((key.return && (key.shift || key.ctrl)) || (key.ctrl && input === 'j')) {
      insert('\n');
      return;
    }
    if (key.return) {
      submitValue(current, key.meta ? 'follow-up' : 'normal');
      return;
    }
    if (input === '\n') {
      insert('\n');
      return;
    }
    if (key.leftArrow) {
      setCursorOffset(key.meta || key.ctrl
        ? previousWordBoundary(current, cursor)
        : previousGrapheme(current, cursor));
      return;
    }
    if (key.rightArrow) {
      setCursorOffset(key.meta || key.ctrl
        ? nextWordBoundary(current, cursor)
        : nextGrapheme(current, cursor));
      return;
    }
    if (key.home) {
      setCursorOffset(key.ctrl ? 0 : lineStart(current, cursor));
      return;
    }
    if (key.end) {
      setCursorOffset(key.ctrl ? current.length : lineEnd(current, cursor));
      return;
    }
    if (key.backspace && (key.meta || key.ctrl)) {
      deleteRange(previousWordBoundary(current, cursor), cursor);
      return;
    }
    if (key.backspace) {
      const start = previousGrapheme(current, cursor);
      if (start === cursor) return;
      commitEdit(`${current.slice(0, start)}${current.slice(cursor)}`, start);
      return;
    }
    if (key.delete && (key.meta || key.ctrl)) {
      deleteRange(cursor, nextWordBoundary(current, cursor));
      return;
    }
    if (key.delete) {
      const end = nextGrapheme(current, cursor);
      if (end === cursor) return;
      commitEdit(`${current.slice(0, cursor)}${current.slice(end)}`, cursor);
      return;
    }
    const actions = splitComposerInput(input);
    if (actions.some((action) => action.type === 'submit')) {
      if (key.ctrl || key.shift) {
        insert(actions.map((action) => action.type === 'insert' ? action.text : '\n').join(''));
      } else {
        applyInputActions(actions, key.meta ? 'follow-up' : 'normal', current, cursor);
      }
      return;
    }
    if (key.ctrl || key.meta || key.super) return;
    const text = actions.map((action) => action.type === 'insert' ? action.text : '').join('');
    if (!text) return;
    insert(text);
  }, {isActive: focus});

  function insert(text: string): void {
    if (!text) return;
    const current = valueRef.current;
    const cursor = cursorRef.current;
    commitEdit(`${current.slice(0, cursor)}${text}${current.slice(cursor)}`, cursor + text.length);
  }

  function deleteRange(start: number, end: number): void {
    const current = valueRef.current;
    const safeStart = cursorAtOrBefore(current, start);
    const safeEnd = cursorAtOrBefore(current, end);
    if (safeStart >= safeEnd) return;
    commitEdit(`${current.slice(0, safeStart)}${current.slice(safeEnd)}`, safeStart);
  }

  function submitValue(submittedValue: string, mode: 'follow-up' | 'normal'): void {
    // A terminal can deliver pasted text and Return in one event. Reset the
    // synchronous editor state before React batches onChange and parent clear.
    valueRef.current = '';
    cursorRef.current = 0;
    onCursorChange?.(0);
    pendingControlledValueRef.current = undefined;
    preferredColumnRef.current = undefined;
    undoStackRef.current = [];
    redoStackRef.current = [];
    setCursorOffsetState(0);
    onSubmit(submittedValue, mode);
  }

  function applyInputActions(
    actions: ComposerInputAction[],
    mode: 'follow-up' | 'normal',
    initialValue: string,
    initialCursor: number,
  ): void {
    let nextValue = initialValue;
    let nextCursor = initialCursor;
    for (const action of actions) {
      if (action.type === 'insert') {
        nextValue = `${nextValue.slice(0, nextCursor)}${action.text}${nextValue.slice(nextCursor)}`;
        nextCursor += action.text.length;
        continue;
      }
      submitValue(nextValue, mode);
      nextValue = '';
      nextCursor = 0;
    }
    if (nextValue) commitEdit(nextValue, nextCursor);
  }

  if (!value) {
    return (
      <Text dimColor>
        {focus ? <Text inverse>{placeholder.slice(0, 1) || ' '}</Text> : null}
        {placeholder.slice(focus ? 1 : 0)}
      </Text>
    );
  }

  const viewport = composerViewport(value, cursorOffset, width, maxVisibleRows);
  const {before, cursor, after} = composerCursorParts(viewport.value, viewport.cursor);
  const markerWidth = Math.max(1, width);
  return (
    <Text>
      {viewport.hiddenBefore ? <Text dimColor>{truncateDisplay(`${terminalEllipsis()} ${viewport.hiddenBefore} rows above`, markerWidth)}{`\n`}</Text> : null}
      {before}
      {focus ? <Text inverse>{cursor === '\n' || cursor === '' ? ' ' : cursor}</Text> : cursor}
      {cursor === '\n' ? '\n' : null}
      {after}
      {viewport.hiddenAfter ? <Text dimColor>{`\n`}{truncateDisplay(`${terminalEllipsis()} ${viewport.hiddenAfter} rows below`, markerWidth)}</Text> : null}
    </Text>
  );
}

interface ComposerViewport {
  value: string;
  cursor: number;
  hiddenBefore: number;
  hiddenAfter: number;
}

interface ComposerVisualRow {
  start: number;
  end: number;
}

/** Keep the cursor visible while bounding a long draft to stable terminal rows. */
export function composerViewport(value: string, cursor: number, width: number, maxRows: number): ComposerViewport {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeRows = Math.max(1, Math.floor(maxRows));
  const rows = composerVisualRows(value, safeWidth);
  if (rows.length <= safeRows) return {value, cursor, hiddenBefore: 0, hiddenAfter: 0};

  const safeCursor = cursorAtOrBefore(value, cursor);
  let active = rows.findIndex((row, index) => safeCursor < row.end || (safeCursor === row.end && index === rows.length - 1));
  if (active < 0) active = rows.length - 1;

  let contentRows = Math.max(1, safeRows - 1);
  let start = Math.max(0, active - contentRows + 1);
  let end = Math.min(rows.length - 1, start + contentRows - 1);
  if (start > 0 && end < rows.length - 1 && safeRows >= 3) {
    contentRows = safeRows - 2;
    start = Math.max(0, active - contentRows + 1);
    end = Math.min(rows.length - 1, start + contentRows - 1);
  }

  const startOffset = (rows[start] as ComposerVisualRow).start;
  const endOffset = (rows[end] as ComposerVisualRow).end;
  return {
    value: value.slice(startOffset, endOffset),
    cursor: Math.max(0, Math.min(safeCursor - startOffset, endOffset - startOffset)),
    hiddenBefore: start,
    hiddenAfter: rows.length - end - 1,
  };
}

function composerVisualRows(value: string, width: number): ComposerVisualRow[] {
  const rows: ComposerVisualRow[] = [];
  let start = 0;
  let used = 0;
  for (const span of graphemeSpans(value)) {
    const segment = value.slice(span.start, span.end);
    if (segment === '\n') {
      rows.push({start, end: span.start});
      start = span.end;
      used = 0;
      continue;
    }
    const segmentWidth = displayWidth(segment);
    if (used > 0 && used + segmentWidth > width) {
      rows.push({start, end: span.start});
      start = span.start;
      used = 0;
    }
    used += segmentWidth;
  }
  rows.push({start, end: value.length});
  return rows;
}

function graphemeBoundaries(value: string): number[] {
  if (typeof Intl.Segmenter === 'function') {
    const boundaries = [...new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(value)]
      .map((segment) => segment.index);
    boundaries.push(value.length);
    return boundaries;
  }
  const boundaries = [0];
  let offset = 0;
  for (const character of value) {
    offset += character.length;
    boundaries.push(offset);
  }
  return boundaries;
}

function cursorAtOrBefore(value: string, offset: number): number {
  const bounded = Math.max(0, Math.min(offset, value.length));
  let cursor = 0;
  for (const boundary of graphemeBoundaries(value)) {
    if (boundary > bounded) break;
    cursor = boundary;
  }
  return cursor;
}

function previousGrapheme(text: string, offset: number): number {
  const boundaries = graphemeBoundaries(text);
  for (let index = boundaries.length - 1; index > 0; index -= 1) {
    if ((boundaries[index] as number) <= offset) return boundaries[index - 1] as number;
  }
  return 0;
}

function nextGrapheme(text: string, offset: number): number {
  return graphemeBoundaries(text).find((boundary) => boundary > offset) ?? text.length;
}

function lineStart(text: string, offset: number): number {
  const newline = text.lastIndexOf('\n', Math.max(0, offset - 1));
  return newline < 0 ? 0 : newline + 1;
}

function lineEnd(text: string, offset: number): number {
  const newline = text.indexOf('\n', offset);
  return newline < 0 ? text.length : newline;
}

type GraphemeKind = 'space' | 'word' | 'symbol';

interface GraphemeSpan {
  start: number;
  end: number;
  kind: GraphemeKind;
}

function graphemeSpans(value: string): GraphemeSpan[] {
  const boundaries = graphemeBoundaries(value);
  const spans: GraphemeSpan[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index] as number;
    const end = boundaries[index + 1] as number;
    const segment = value.slice(start, end);
    spans.push({start, end, kind: graphemeKind(segment)});
  }
  return spans;
}

function graphemeKind(value: string): GraphemeKind {
  if (/^\s+$/u.test(value)) return 'space';
  if (/^[\p{Letter}\p{Number}\p{Mark}\p{Connector_Punctuation}]/u.test(value)) return 'word';
  return 'symbol';
}

/** Return the start of the previous grapheme-class token. */
export function previousWordBoundary(value: string, offset: number): number {
  const cursor = cursorAtOrBefore(value, offset);
  const spans = graphemeSpans(value);
  let index = spans.length - 1;
  while (index >= 0 && (spans[index] as GraphemeSpan).end > cursor) index -= 1;
  while (index >= 0 && (spans[index] as GraphemeSpan).kind === 'space') index -= 1;
  if (index < 0) return 0;
  const kind = (spans[index] as GraphemeSpan).kind;
  let start = cursor;
  while (index >= 0 && (spans[index] as GraphemeSpan).kind === kind) {
    start = (spans[index] as GraphemeSpan).start;
    index -= 1;
  }
  return start;
}

/** Return the end of the next grapheme-class token. */
export function nextWordBoundary(value: string, offset: number): number {
  const cursor = cursorAtOrBefore(value, offset);
  const spans = graphemeSpans(value);
  let index = 0;
  while (index < spans.length && (spans[index] as GraphemeSpan).end <= cursor) index += 1;
  while (index < spans.length && (spans[index] as GraphemeSpan).kind === 'space') index += 1;
  if (index >= spans.length) return value.length;
  const kind = (spans[index] as GraphemeSpan).kind;
  let end = cursor;
  while (index < spans.length && (spans[index] as GraphemeSpan).kind === kind) {
    end = (spans[index] as GraphemeSpan).end;
    index += 1;
  }
  return end;
}

export interface ComposerVerticalMove {
  offset: number;
  preferredColumn: number;
  moved: boolean;
}

/** Move between logical lines while retaining the terminal display-cell column. */
export function moveComposerCursorVertically(
  value: string,
  offset: number,
  direction: 'up' | 'down',
  preferredColumn?: number,
): ComposerVerticalMove {
  const cursor = cursorAtOrBefore(value, offset);
  const currentStart = lineStart(value, cursor);
  const currentEnd = lineEnd(value, cursor);
  const column = preferredColumn ?? displayWidth(value.slice(currentStart, cursor));

  if (direction === 'up') {
    if (currentStart === 0) return {offset: cursor, preferredColumn: column, moved: false};
    const targetEnd = currentStart - 1;
    const targetStart = lineStart(value, targetEnd);
    return {
      offset: offsetAtDisplayColumn(value, targetStart, targetEnd, column),
      preferredColumn: column,
      moved: true,
    };
  }

  if (currentEnd === value.length) return {offset: cursor, preferredColumn: column, moved: false};
  const targetStart = currentEnd + 1;
  const targetEnd = lineEnd(value, targetStart);
  return {
    offset: offsetAtDisplayColumn(value, targetStart, targetEnd, column),
    preferredColumn: column,
    moved: true,
  };
}

function offsetAtDisplayColumn(
  value: string,
  start: number,
  end: number,
  targetColumn: number,
): number {
  let column = 0;
  for (const span of graphemeSpans(value.slice(start, end))) {
    const segmentStart = start + span.start;
    const segmentEnd = start + span.end;
    const nextColumn = column + displayWidth(value.slice(segmentStart, segmentEnd));
    if (nextColumn === targetColumn) return segmentEnd;
    if (nextColumn > targetColumn) {
      return nextColumn - targetColumn < targetColumn - column ? segmentEnd : segmentStart;
    }
    column = nextColumn;
  }
  return end;
}

function pushSnapshot(stack: EditorSnapshot[], snapshot: EditorSnapshot): void {
  const previous = stack.at(-1);
  if (previous?.value === snapshot.value && previous.cursor === snapshot.cursor) return;
  stack.push(snapshot);
  if (stack.length > editorHistoryLimit) stack.splice(0, stack.length - editorHistoryLimit);
}

/** Split the editor at a grapheme boundary so emoji and CJK never render half-selected. */
export function composerCursorParts(value: string, offset: number): {
  before: string;
  cursor: string;
  after: string;
} {
  const boundaries = graphemeBoundaries(value);
  const safeOffset = boundaries.reduce((closest, boundary) =>
    Math.abs(boundary - offset) < Math.abs(closest - offset) ? boundary : closest, 0);
  const cursorEnd = boundaries.find((boundary) => boundary > safeOffset) ?? value.length;
  return {
    before: value.slice(0, safeOffset),
    cursor: value.slice(safeOffset, cursorEnd),
    after: value.slice(cursorEnd),
  };
}

export type ComposerInputAction =
  | {type: 'insert'; text: string}
  | {type: 'submit'};

/** Parse non-paste terminal data into ordered insert and Return actions. */
export function splitComposerInput(input: string): ComposerInputAction[] {
  const actions: ComposerInputAction[] = [];
  let textStart = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== '\r') continue;
    if (index > textStart) pushComposerInsert(actions, input.slice(textStart, index));
    actions.push({type: 'submit'});
    if (input[index + 1] === '\n') index += 1;
    textStart = index + 1;
  }
  if (textStart < input.length) pushComposerInsert(actions, input.slice(textStart));
  return actions;
}

function pushComposerInsert(actions: ComposerInputAction[], value: string): void {
  const text = sanitizeComposerText(value);
  if (text) actions.push({type: 'insert', text});
}

function sanitizeComposerText(input: string): string {
  // Tabs and every other terminal control except newline are unsafe inside the
  // cursor-managed editor. Return is interpreted before this helper is called.
  return sanitizeTerminalText(input).replace(/\t/gu, '');
}

/** Preserve every pasted line while removing terminal control sequences. */
export function normalizeComposerPaste(input: string): string {
  return sanitizeComposerText(input);
}
