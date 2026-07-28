import {describe, expect, it} from 'vitest';

import {starterHint} from '../../src/ui/starter-hints.js';

const SEPARATOR = ' · ';

describe('starterHint', () => {
  it('keeps the idle composer short and stable', () => {
    expect(starterHint(0, SEPARATOR)).toBe('Type a request');
  });

  it('does not rotate feature or shortcut advertising into the composer', () => {
    for (let index = 0; index < 8; index += 1) {
      expect(starterHint(index, SEPARATOR)).toBe('Type a request');
    }
    expect(starterHint(-1, SEPARATOR)).toBe('Type a request');
  });
});
