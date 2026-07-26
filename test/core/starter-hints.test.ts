import {describe, expect, it} from 'vitest';

import {starterHint} from '../../src/ui/starter-hints.js';

const SEPARATOR = ' · ';

describe('starterHint', () => {
  it('keeps the legacy first hint so first frames stay contract-stable', () => {
    expect(starterHint(0, SEPARATOR)).toBe('Type a request · @file · /command');
  });

  it('anchors every rotation on "Type a request" for PTY and screen-reader matches', () => {
    for (let index = 0; index < 8; index += 1) {
      expect(starterHint(index, SEPARATOR)).toMatch(/^Type a request/u);
    }
  });

  it('rotates through distinct hints and wraps', () => {
    const cycle = [0, 1, 2, 3].map((index) => starterHint(index, SEPARATOR));
    expect(new Set(cycle).size).toBe(4);
    expect(starterHint(4, SEPARATOR)).toBe(cycle[0]);
    expect(starterHint(-1, SEPARATOR)).toBe(cycle[3]);
  });

  it('only advertises interactions that exist', () => {
    const all = [0, 1, 2, 3].map((index) => starterHint(index, SEPARATOR)).join('\n');
    expect(all).toContain('/review');
    expect(all).toContain('/status');
    expect(all).toContain('ctrl+r');
  });
});
