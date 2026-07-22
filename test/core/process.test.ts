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

  it('streams bounded process output while retaining the final result', async () => {
    let streamed = '';
    const result = await runProcess(process.execPath, [
      '-e',
      'process.stdout.write("scan 0/2\\n"); setTimeout(() => process.stdout.write("done 2/2\\n"), 10)',
    ], {
      cwd: process.cwd(),
      onStdout: (chunk) => { streamed += chunk; },
    });

    expect(streamed).toBe('scan 0/2\ndone 2/2\n');
    expect(result.stdout).toBe(streamed);
  });

  it('preserves UTF-8 characters split across child-process chunks', async () => {
    let streamed = '';
    const result = await runProcess(process.execPath, [
      '-e',
      'const b=Buffer.from("你"); process.stdout.write(b.subarray(0,1)); setTimeout(() => process.stdout.write(b.subarray(1)), 10)',
    ], {
      cwd: process.cwd(),
      onStdout: (chunk) => { streamed += chunk; },
    });

    expect(streamed).toBe('你');
    expect(result.stdout).toBe('你');
  });

  it('bounds retained output without truncating the live callback stream', async () => {
    let streamed = '';
    const result = await runProcess(process.execPath, [
      '-e',
      'process.stdout.write("x".repeat(100))',
    ], {
      cwd: process.cwd(),
      maxOutputBytes: 12,
      onStdout: (chunk) => { streamed += chunk; },
    });

    expect(result.stdout).toHaveLength(12);
    expect(streamed).toHaveLength(100);

    const unicode = await runProcess(process.execPath, [
      '-e',
      'process.stdout.write("你")',
    ], {
      cwd: process.cwd(),
      maxOutputBytes: 1,
    });
    expect(Buffer.byteLength(unicode.stdout)).toBeLessThanOrEqual(1);
    expect(unicode.stdout).not.toContain('\uFFFD');
  });
});
