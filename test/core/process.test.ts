import {describe, expect, it} from 'vitest';
import {runProcess} from '../../src/utils/process.js';

describe('process runner', () => {
  it('treats a zero timeout as disabled', async () => {
    const result = await runProcess(process.execPath, [
      '-e',
      'setTimeout(() => process.stdout.write("done"), 20)',
    ], {
      cwd: process.cwd(),
      timeoutMs: 0,
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('done');
  });
});
