import {spawn} from 'node:child_process';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('agents run CLI', () => {
  it('runs a built-in read-only profile through a trusted external CLI', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-agents-run-workspace-'));
    const bin = await mkdtemp(join(tmpdir(), 'skein-agents-run-bin-'));
    roots.push(workspace, bin);
    const executable = join(bin, 'claude');
    await writeFile(executable, '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"result","result":"Grounded website plan","usage":{"input_tokens":24,"output_tokens":8}}\'\n');
    await chmod(executable, 0o755);

    const result = await runCli([
      'agents', 'run', 'product', 'Plan', 'the', 'website',
      '--runtime', 'claude', '--model', 'opus', '--max-cost-usd', '0.5', '--workspace', workspace, '--json',
    ], bin);

    expect(result).toMatchObject({exitCode: 0, stderr: ''});
    expect(JSON.parse(result.stdout)).toMatchObject({
      profile: 'product',
      readOnly: true,
      content: 'Grounded website plan',
      runtime: 'claude',
      model: 'opus',
      usage: {inputTokens: 24, outputTokens: 8},
    });
  });

  it('rejects writable profiles and API-only routes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-agents-run-errors-'));
    roots.push(workspace);

    const writer = await runCli([
      'agents', 'run', 'implementer', 'Edit', 'the', 'site',
      '--runtime', 'claude', '--workspace', workspace,
    ]);
    expect(writer.exitCode).toBe(1);
    expect(writer.stderr).toContain('external CLI runs are read-only');

    const api = await runCli([
      'agents', 'run', 'product', 'Plan', 'the', 'site', '--workspace', workspace,
    ]);
    expect(api.exitCode).toBe(1);
    expect(api.stderr).toContain('pass --runtime codex, claude, or grok');
  });
});

function runCli(args: string[], extraPath?: string): Promise<{exitCode: number | null; stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.tsx', ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: extraPath ? `${extraPath}${delimiter}${process.env.PATH ?? ''}` : process.env.PATH,
        SKEIN_NO_UPDATE_CHECK: '1',
      },
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
