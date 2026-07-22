import {PassThrough} from 'node:stream';
import React from 'react';
import {render} from 'ink';
import {describe, expect, it} from 'vitest';
import {commandSuggestions, findCommand} from '../src/ui/commands.js';
import {
  ComposerInput,
  composerCursorParts,
  composerViewport,
  moveComposerCursorVertically,
  nextWordBoundary,
  normalizeComposerPaste,
  previousWordBoundary,
  splitComposerInput,
} from '../src/ui/composer.js';
import {compactDisplayPath, displayWidth, truncateDisplay} from '../src/ui/text.js';

describe('terminal command and width helpers', () => {
  it('uses one registry for command discovery and aliases', () => {
    expect(commandSuggestions('/m')[0]).toMatchObject({value: '/memory ', label: '/memory'});
    expect(commandSuggestions('/tea')[0]).toMatchObject({value: '/team ', label: '/team'});
    expect(findCommand('?')?.name).toBe('help');
  });

  it('offers second-level theme and workflow completion', () => {
    expect(commandSuggestions('/theme gr', {themes: ['graphite', 'midnight']})[0]).toMatchObject({
      value: '/theme graphite',
    });
    expect(commandSuggestions('/workflow de', {workflows: [{
      name: 'debug', description: 'Debug safely', steps: [],
    }]})[0]).toMatchObject({value: '/workflow debug '});
    expect(commandSuggestions('/mode a')[0]).toMatchObject({value: '/mode ask', label: 'ask'});
    expect(commandSuggestions('/mode p')[0]).toMatchObject({value: '/mode plan', label: 'plan'});
    expect(commandSuggestions('/connections s')[0]).toMatchObject({value: '/connections setup', label: 'setup'});
  });

  it('truncates Chinese and emoji by terminal cells instead of UTF-16 length', () => {
    const value = truncateDisplay('项目/很长的路径/worker.ts', 12);
    expect(displayWidth(value)).toBeLessThanOrEqual(12);
    expect(displayWidth(truncateDisplay('fix 🔧 now', 7))).toBeLessThanOrEqual(7);
    expect(displayWidth(compactDisplayPath('/repo/项目/worker.ts', 14))).toBeLessThanOrEqual(14);
  });

  it('keeps the composer cursor on complete graphemes', () => {
    expect(composerCursorParts('A🧪项目', 1)).toEqual({before: 'A', cursor: '🧪', after: '项目'});
    expect(composerCursorParts('A🧪项目', 2).before).toBe('A');
    expect(composerCursorParts('A🧪项目', 99).cursor).toBe('');
  });

  it('keeps a bounded composer window around the cursor', () => {
    const value = 'one\ntwo\nthree\nfour\nfive';
    expect(composerViewport(value, value.length, 20, 4)).toEqual({
      value: 'three\nfour\nfive',
      cursor: 'three\nfour\nfive'.length,
      hiddenBefore: 2,
      hiddenAfter: 0,
    });
    expect(composerViewport(value, 0, 20, 4)).toMatchObject({
      value: 'one\ntwo\nthree',
      cursor: 0,
      hiddenBefore: 0,
      hiddenAfter: 2,
    });
  });

  it('moves vertically by terminal cells and retains the preferred column', () => {
    const value = 'abcdef\n界\n123456';
    const first = moveComposerCursorVertically(value, value.length, 'up');
    expect(first).toMatchObject({offset: 8, preferredColumn: 6, moved: true});
    expect(moveComposerCursorVertically(value, first.offset, 'up', first.preferredColumn))
      .toMatchObject({offset: 6, preferredColumn: 6, moved: true});

    const wide = 'a界b\n123';
    expect(moveComposerCursorVertically(wide, wide.length, 'up'))
      .toMatchObject({offset: 2, preferredColumn: 3, moved: true});
  });

  it('finds word boundaries without splitting CJK or emoji graphemes', () => {
    const value = 'alpha 项目 🧪 test';
    const testStart = value.indexOf('test');
    const emojiStart = value.indexOf('🧪');
    const cjkStart = value.indexOf('项目');
    expect(previousWordBoundary(value, value.length)).toBe(testStart);
    expect(previousWordBoundary(value, testStart)).toBe(emojiStart);
    expect(previousWordBoundary(value, emojiStart)).toBe(cjkStart);
    expect(nextWordBoundary(value, cjkStart)).toBe(cjkStart + '项目'.length);

    const joined = '项目❤️test';
    expect(previousWordBoundary(joined, joined.indexOf('test'))).toBe('项目'.length);
  });

  it('preserves ordered Return actions in combined terminal chunks', () => {
    expect(splitComposerInput('/context\r')).toEqual([
      {type: 'insert', text: '/context'},
      {type: 'submit'},
    ]);
    expect(splitComposerInput('/a\r/b\r')).toEqual([
      {type: 'insert', text: '/a'},
      {type: 'submit'},
      {type: 'insert', text: '/b'},
      {type: 'submit'},
    ]);
    expect(splitComposerInput('/context\r\n')).toEqual([
      {type: 'insert', text: '/context'},
      {type: 'submit'},
    ]);
    expect(normalizeComposerPaste('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('removes terminal controls and ANSI sequences from pasted text', () => {
    expect(normalizeComposerPaste(
      '\u001B[31mred\u001B[0m\u0007\b\u007F\r\nnext\tline',
    )).toBe('red\nnextline');
  });

  it('sanitizes non-paste text without losing ordered Return submissions', () => {
    expect(splitComposerInput(
      '\u001B[31m/first\u001B[0m\u0007\b\u007F\r/second\u0007\u001B[2J\r\n',
    )).toEqual([
      {type: 'insert', text: '/first'},
      {type: 'submit'},
      {type: 'insert', text: '/second'},
      {type: 'submit'},
    ]);
  });

  it('clears synchronous editor state between combined command-and-Return chunks', async () => {
    const stdin = mockInput();
    const stdout = mockOutput();
    const stderr = mockOutput();
    const submitted: string[] = [];

    function Harness() {
      const [value, setValue] = React.useState('');
      return React.createElement(ComposerInput, {
        value,
        onChange: setValue,
        onSubmit: (next: string) => {
          submitted.push(next);
          setValue('');
        },
      });
    }

    const instance = render(React.createElement(Harness), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      interactive: true,
      patchConsole: false,
    });
    try {
      await instance.waitUntilRenderFlush();
      stdin.write('/context\r');
      await nextEventLoop();
      stdin.write('/memory candidates\r');
      await nextEventLoop();
      expect(submitted).toEqual(['/context', '/memory candidates']);
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('inserts bracketed paste with trailing newlines without submitting it', async () => {
    const stdin = mockInput();
    const stdout = mockOutput();
    const stderr = mockOutput();
    const submitted: string[] = [];
    let latestValue = '';

    function Harness() {
      const [value, setValue] = React.useState('');
      return React.createElement(ComposerInput, {
        value,
        onChange: (next: string) => {
          latestValue = next;
          setValue(next);
        },
        onSubmit: (next: string) => {
          submitted.push(next);
          setValue('');
        },
      });
    }

    const instance = render(React.createElement(Harness), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      interactive: true,
      patchConsole: false,
    });
    try {
      await instance.waitUntilRenderFlush();
      stdin.write('\u001B[200~line 1\r\nline 2\r\u001B[201~');
      await nextEventLoop();
      expect(submitted).toEqual([]);
      expect(latestValue).toBe('line 1\nline 2\n');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('moves the cursor to a safe grapheme boundary after external value replacement', async () => {
    const stdin = mockInput();
    const stdout = mockOutput();
    const stderr = mockOutput();
    let replaceValue: React.Dispatch<React.SetStateAction<string>> | undefined;
    let latestValue = '';

    function Harness() {
      const [value, setValue] = React.useState('A');
      replaceValue = setValue;
      return React.createElement(ComposerInput, {
        value,
        onChange: (next: string) => {
          latestValue = next;
          setValue(next);
        },
        onSubmit: () => undefined,
      });
    }

    const instance = render(React.createElement(Harness), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      interactive: true,
      patchConsole: false,
    });
    try {
      await instance.waitUntilRenderFlush();
      replaceValue?.('🧪');
      await nextEventLoop();
      stdin.write('\u007F');
      await nextEventLoop();
      expect(latestValue).toBe('');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('moves through multiline input without losing the preferred display column', async () => {
    const harness = await mountComposer('a界b\nx\n123');
    try {
      harness.stdin.write('\u001B[A\u001B[AX');
      await nextEventLoop();
      expect(harness.state.latestValue).toBe('a界Xb\nx\n123');
    } finally {
      await harness.cleanup();
    }
  });

  it('supports terminal word movement and grapheme-safe word deletion', async () => {
    const harness = await mountComposer('alpha 项目 🧪 test');
    try {
      harness.stdin.write('\u001B[1;3DX');
      await nextEventLoop();
      expect(harness.state.latestValue).toBe('alpha 项目 🧪 Xtest');

      harness.stdin.write('\u001A\u001B\u007F');
      await nextEventLoop();
      expect(harness.state.latestValue).toBe('alpha 项目 test');
      expect(harness.state.latestValue).not.toMatch(/[\uD800-\uDFFF]/u);
    } finally {
      await harness.cleanup();
    }
  });

  it('supports Ctrl+U/K and snapshot undo/redo', async () => {
    const harness = await mountComposer('left right\nnext line');
    try {
      harness.stdin.write('\u0015');
      await nextEventLoop();
      expect(harness.state.latestValue).toBe('left right\n');

      harness.stdin.write('\u001A\u001B[H\u001B[A\u001B[C\u001B[C\u001B[C\u001B[C\u000B');
      await nextEventLoop();
      expect(harness.state.latestValue).toBe('left\nnext line');

      harness.stdin.write('\u001A');
      await nextEventLoop();
      expect(harness.state.latestValue).toBe('left right\nnext line');
      harness.stdin.write('\u0019');
      await nextEventLoop();
      expect(harness.state.latestValue).toBe('left\nnext line');
    } finally {
      await harness.cleanup();
    }
  });

  it('bounds undo history to the most recent editor changes', async () => {
    const harness = await mountComposer('');
    try {
      for (let index = 0; index < 105; index += 1) {
        harness.stdin.write('a');
        await nextEventLoop();
      }
      for (let index = 0; index < 101; index += 1) {
        harness.stdin.write('\u001A');
        await nextEventLoop();
      }
      expect(harness.state.latestValue).toBe('a'.repeat(5));
    } finally {
      await harness.cleanup();
    }
  });
});

type MockInput = PassThrough & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode(mode: boolean): MockInput;
  ref(): MockInput;
  unref(): MockInput;
};

type MockOutput = PassThrough & {
  isTTY: boolean;
  columns: number;
  rows: number;
};

function mockInput(): MockInput {
  const stream = new PassThrough() as MockInput;
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = (mode: boolean) => {
    stream.isRaw = mode;
    return stream;
  };
  stream.ref = () => stream;
  stream.unref = () => stream;
  return stream;
}

function mockOutput(): MockOutput {
  const stream = new PassThrough() as MockOutput;
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  return stream;
}

async function mountComposer(initialValue: string) {
  const stdin = mockInput();
  const stdout = mockOutput();
  const stderr = mockOutput();
  const state = {latestValue: initialValue, submitted: [] as string[]};

  function Harness() {
    const [value, setValue] = React.useState(initialValue);
    return React.createElement(ComposerInput, {
      value,
      onChange: (next: string) => {
        state.latestValue = next;
        setValue(next);
      },
      onSubmit: (next: string) => {
        state.submitted.push(next);
        state.latestValue = '';
        setValue('');
      },
    });
  }

  const instance = render(React.createElement(Harness), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    interactive: true,
    patchConsole: false,
  });
  await instance.waitUntilRenderFlush();
  return {
    stdin,
    state,
    async cleanup() {
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}

async function nextEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
