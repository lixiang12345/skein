import {describe, expect, it} from 'vitest';
import type {TimelineItem} from '../src/ui/components.js';
import {estimateTimelineItemRows, fitTimelineToRows} from '../src/ui/viewport.js';

describe('timeline viewport budgeting', () => {
  it('keeps a contiguous recent window and reports hidden history', () => {
    const items: TimelineItem[] = Array.from({length: 8}, (_, index) => ({
      id: String(index),
      kind: 'notice',
      text: `entry ${index}`,
    }));
    const visible = fitTimelineToRows(items, {width: 80, rows: 5, compact: true});
    expect(visible.at(-1)).toEqual(items.at(-1));
    expect(visible[0]).toMatchObject({kind: 'notice', text: expect.stringContaining('earlier transcript')});
    expect(visible.slice(1).map((item) => item.id)).toEqual(['4', '5', '6', '7']);
  });

  it('keeps the tail of an oversized newest item inside the row budget', () => {
    const latest: TimelineItem = {id: 'latest', kind: 'assistant', text: 'line\n'.repeat(20)};
    const visible = fitTimelineToRows([
      {id: 'old', kind: 'user', text: 'old'},
      latest,
    ], {width: 24, rows: 3});
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({id: 'latest', kind: 'assistant'});
    expect((visible[0] as Extract<TimelineItem, {kind: 'assistant'}>).text).toContain('earlier hidden');
    expect(estimateTimelineItemRows(visible[0] as TimelineItem, {width: 24, rows: 3})).toBeLessThanOrEqual(3);
  });

  it('accounts for display width, multiline assistant chrome, and expanded tool output', () => {
    expect(estimateTimelineItemRows(
      {id: 'cjk', kind: 'user', text: '界'.repeat(10)},
      {width: 12, rows: 20, compact: true},
    )).toBe(2);
    expect(estimateTimelineItemRows(
      {id: 'assistant', kind: 'assistant', text: 'one\ntwo'},
      {width: 80, rows: 20, compact: true},
    )).toBe(3);
    expect(estimateTimelineItemRows(
      {id: 'tool', kind: 'tool', name: 'shell', detail: 'test', state: 'ok', output: 'a\nb\nc'},
      {width: 80, rows: 20, compact: true, showToolOutput: true},
    )).toBe(4);
  });
});
