import {describe, expect, it} from 'vitest';
import {MINIMUM_NODE_VERSION, supportsNodeVersion} from '../../src/cli/doctor.js';

describe('doctor runtime checks', () => {
  it('enforces the first Node release with unflagged node:sqlite', () => {
    expect(MINIMUM_NODE_VERSION).toBe('22.13.0');
    expect(supportsNodeVersion('22.12.0')).toBe(false);
    expect(supportsNodeVersion('v22.12.9')).toBe(false);
    expect(supportsNodeVersion('22.13.0')).toBe(true);
    expect(supportsNodeVersion('22.22.3')).toBe(true);
    expect(supportsNodeVersion('23.0.0')).toBe(true);
    expect(supportsNodeVersion('not-a-version')).toBe(false);
  });
});
