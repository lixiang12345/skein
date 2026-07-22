import {describe, expect, it} from 'vitest';
import {checkSqliteFts5, MINIMUM_NODE_VERSION, supportsNodeVersion} from '../../src/cli/doctor.js';

describe('doctor runtime checks', () => {
  it('enforces the first Node release with unflagged node:sqlite', () => {
    expect(MINIMUM_NODE_VERSION).toBe('22.16.0');
    expect(supportsNodeVersion('22.15.1')).toBe(false);
    expect(supportsNodeVersion('v22.15.9')).toBe(false);
    expect(supportsNodeVersion('22.16.0')).toBe(true);
    expect(supportsNodeVersion('22.22.3')).toBe(true);
    expect(supportsNodeVersion('23.0.0')).toBe(true);
    expect(supportsNodeVersion('not-a-version')).toBe(false);
  });

  it('probes the SQLite capability required by durable memory', async () => {
    await expect(checkSqliteFts5()).resolves.toEqual({ok: true, detail: 'available'});
  });
});
