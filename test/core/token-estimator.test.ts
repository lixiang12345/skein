import {describe, expect, it} from 'vitest';
import {estimateTokens, sliceEndByTokens, sliceStartByTokens} from '../../src/utils/tokens.js';

describe('provider-neutral token estimator', () => {
  it('prices English, Chinese, code, accented text, and emoji deterministically', () => {
    expect(estimateTokens('x'.repeat(400))).toBe(100);
    expect(estimateTokens('中'.repeat(400))).toBe(400);
    expect(estimateTokens('é'.repeat(400))).toBe(800);
    expect(estimateTokens('🙂'.repeat(400))).toBe(800);
    expect(estimateTokens('const answer = items.map((item) => item.id);')).toBe(11);
  });

  it('keeps fixture error measurable without claiming a provider tokenizer match', () => {
    // Reference ranges are frozen observations from o200k and cl100k. They
    // measure estimator drift; they are not billing truth for every provider.
    const fixtures = [
      {kind: 'English', text: 'Fix the parser and run the focused tests.', referenceMin: 9, referenceMax: 9},
      {kind: 'Chinese', text: '修复解析器，并运行相关测试。', referenceMin: 9, referenceMax: 11},
      {kind: 'Code', text: 'const answer = items.map((item) => item.id);', referenceMin: 12, referenceMax: 12},
      {kind: 'Mixed', text: '检查 src/parser.ts 的 parseInput()', referenceMin: 8, referenceMax: 9},
    ];
    const report = fixtures.map((fixture) => {
      const estimated = estimateTokens(fixture.text);
      const absoluteError = estimated < fixture.referenceMin
        ? fixture.referenceMin - estimated
        : estimated > fixture.referenceMax
          ? estimated - fixture.referenceMax
          : 0;
      return {
        ...fixture,
        estimated,
        absoluteError,
        relativeError: absoluteError / fixture.referenceMax,
      };
    });

    expect(report.map(({kind, estimated, absoluteError}) => ({kind, estimated, absoluteError}))).toEqual([
      {kind: 'English', estimated: 11, absoluteError: 2},
      {kind: 'Chinese', estimated: 13, absoluteError: 2},
      {kind: 'Code', estimated: 11, absoluteError: 1},
      {kind: 'Mixed', estimated: 10, absoluteError: 1},
    ]);
    expect(report.every((item) => Number.isFinite(item.relativeError))).toBe(true);
  });

  it('slices on code-point boundaries under the same budget model', () => {
    const text = 'abc🙂中文xyz';
    const head = sliceStartByTokens(text, 4);
    const tail = sliceEndByTokens(text, 4);
    expect(head).toBe('abc🙂中');
    expect(tail).toBe('中文xyz');
    expect(head).not.toContain('\ufffd');
    expect(tail).not.toContain('\ufffd');
  });
});
