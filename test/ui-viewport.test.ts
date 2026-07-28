import {describe, expect, it} from 'vitest';
import type {TimelineItem} from '../src/ui/components.js';
import {estimateTimelineItemRows, fitTimelineToRows} from '../src/ui/viewport.js';

describe('timeline viewport budgeting', () => {
  it('bounds a long latest list and preserves its title plus recent recovery actions', () => {
    const visible = fitTimelineToRows([{
      id: 'recovery',
      kind: 'list',
      title: 'Recovery Center',
      entries: Array.from({length: 10}, (_, index) => ({
        label: index < 7 ? `Evidence ${index + 1}` : `/recover action-${index + 1}`,
        detail: `Detail ${index + 1}`,
      })),
    }], {width: 40, rows: 8, compact: true});

    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({kind: 'list', title: 'Recovery Center'});
    expect(estimateTimelineItemRows(visible[0]!, {width: 40, rows: 8, compact: true})).toBeLessThanOrEqual(8);
    expect(JSON.stringify(visible[0])).toContain('/recover action-10');
    expect(JSON.stringify(visible[0])).toContain('earlier entries hidden');
  });

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

  it('scrolls to older transcript rows without replacing them with the latest tail', () => {
    const items: TimelineItem[] = Array.from({length: 10}, (_, index) => ({
      id: String(index), kind: 'notice', text: `entry ${index}`,
    }));
    const visible = fitTimelineToRows(items, {
      width: 80, rows: 4, compact: true, scrollOffsetRows: 3,
    });

    expect(visible.map((item) => item.id)).toEqual(['3', '4', '5', '6']);
    expect(JSON.stringify(visible)).not.toContain('entry 9');
  });

  it('pages through the middle of one oversized assistant response', () => {
    const response: TimelineItem = {
      id: 'long', kind: 'assistant',
      text: Array.from({length: 12}, (_, index) => `answer line ${index}`).join('\n'),
    };
    const visible = fitTimelineToRows([response], {
      width: 40, rows: 4, compact: true, scrollOffsetRows: 4,
    });

    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({id: 'long', kind: 'assistant', clipped: true});
    expect((visible[0] as Extract<TimelineItem, {kind: 'assistant'}>).text).not.toContain('answer line 11');
    expect(estimateTimelineItemRows(visible[0]!, {width: 40, rows: 4, compact: true})).toBeLessThanOrEqual(4);
  });

  it('pages through expanded tool output instead of pinning its latest tail', () => {
    const tool: TimelineItem = {
      id: 'tool', kind: 'tool', name: 'shell', detail: 'test', state: 'ok',
      output: Array.from({length: 12}, (_, index) => `tool line ${index}`).join('\n'),
    };
    const visible = fitTimelineToRows([tool], {
      width: 80, rows: 4, compact: true, expandedToolId: 'tool', scrollOffsetRows: 4,
    });

    expect(visible).toHaveLength(1);
    expect((visible[0] as Extract<TimelineItem, {kind: 'tool'}>).output).not.toContain('tool line 11');
    expect(estimateTimelineItemRows(visible[0]!, {width: 80, rows: 4, compact: true, expandedToolId: 'tool'})).toBeLessThanOrEqual(4);
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
    // A settled reply is content from its first row: the brand nameplate is
    // gone, so only an active stream spends a row on chrome.
    expect(estimateTimelineItemRows(
      {id: 'assistant', kind: 'assistant', text: 'one\ntwo'},
      {width: 80, rows: 20, compact: true},
    )).toBe(2);
    expect(estimateTimelineItemRows(
      {id: 'streaming', kind: 'assistant', text: 'one\ntwo', streaming: true},
      {width: 80, rows: 20, compact: true},
    )).toBe(3);
    expect(estimateTimelineItemRows(
      {id: 'tool', kind: 'tool', name: 'shell', detail: 'test', state: 'ok', output: 'a\nb\nc'},
      {width: 80, rows: 20, compact: true, showToolOutput: true},
    )).toBe(4);
  });

  it('budgets and clips update metadata within short viewports', () => {
    const update: TimelineItem = {
      id: 'update',
      kind: 'update',
      current: '0.2.3',
      latest: '0.3.0',
      command: 'npm i -g @skein-code/cli',
      highlights: ['one', 'two', 'three', 'four'],
    };
    expect(estimateTimelineItemRows(update, {width: 80, rows: 20})).toBe(6);
    const twoRows = fitTimelineToRows([update], {width: 80, rows: 2});
    expect(twoRows[0]).toMatchObject({kind: 'update'});
    expect((twoRows[0] as Extract<TimelineItem, {kind: 'update'}>).highlights).toBeUndefined();
    expect(estimateTimelineItemRows(twoRows[0] as TimelineItem, {width: 80, rows: 2})).toBe(2);
    const oneRow = fitTimelineToRows([update], {width: 40, rows: 1});
    expect(oneRow[0]).toMatchObject({kind: 'notice', text: expect.stringContaining('Update available')});
    expect(estimateTimelineItemRows(oneRow[0] as TimelineItem, {width: 40, rows: 1})).toBe(1);
  });
});
