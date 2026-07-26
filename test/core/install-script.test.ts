import {spawn} from 'node:child_process';
import {describe, expect, it} from 'vitest';

describe('scripts/install.sh', () => {
  it('plans a pinned global npm install in dry-run mode', async () => {
    const result = await runScript(['--dry-run', '--version', '0.1.2']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('plan: npm install -g @skein-code/cli@0.1.2');
    expect(result.stdout).toContain('plan: skein --version');
  });

  it('defaults to the latest published version', async () => {
    const result = await runScript(['--dry-run']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('plan: npm install -g @skein-code/cli@latest');
  });

  it('fails closed on malformed versions and unknown options', async () => {
    const badVersion = await runScript(['--dry-run', '--version', 'banana']);
    expect(badVersion.exitCode).toBe(1);
    expect(badVersion.stderr).toContain('exact x.y.z version');

    const badOption = await runScript(['--oops']);
    expect(badOption.exitCode).toBe(1);
    expect(badOption.stderr).toContain('unknown option: --oops');
  });
});

function runScript(args: string[]): Promise<{exitCode: number | null; stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['scripts/install.sh', ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({exitCode, stdout, stderr}));
  });
}
