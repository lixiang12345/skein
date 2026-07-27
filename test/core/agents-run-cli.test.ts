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
  }, 20_000);

  it('passes a configured Claude route endpoint and named credential to the isolated child', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-agents-run-route-'));
    const bin = await mkdtemp(join(tmpdir(), 'skein-agents-run-route-bin-'));
    roots.push(workspace, bin);
    const executable = join(bin, 'claude');
    const config = join(workspace, 'user-config.json');
    await writeFile(executable, [
      '#!/bin/sh',
      'test "$ANTHROPIC_BASE_URL" = "https://relay.example" || exit 41',
      'test "$ANTHROPIC_API_KEY" = "route-secret" || exit 42',
      'test -z "$OPENAI_API_KEY" || exit 43',
      'printf \'%s\\n\' \'{"type":"result","result":"Configured route ready","usage":{"input_tokens":12,"output_tokens":4}}\'',
      '',
    ].join('\n'));
    await chmod(executable, 0o755);
    await writeFile(config, JSON.stringify({
      agents: {routes: {product: {
        runtime: 'claude', provider: 'anthropic', model: 'claude-test',
        baseUrl: 'https://relay.example', apiKeyEnv: 'SKEIN_CLAUDE_RELAY_KEY',
      }}},
    }));

    const result = await runCli([
      'agents', 'run', 'product', 'Inspect', 'the', 'workspace',
      '--config', config, '--max-cost-usd', '0.1', '--workspace', workspace, '--json',
    ], bin, {SKEIN_CLAUDE_RELAY_KEY: 'route-secret', OPENAI_API_KEY: 'must-not-pass'});

    expect(result).toMatchObject({exitCode: 0, stderr: ''});
    expect(JSON.parse(result.stdout)).toMatchObject({
      content: 'Configured route ready', runtime: 'claude', model: 'claude-test',
    });
  }, 20_000);

  it('lists configured routes without resolving an incomplete default connection', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-agents-list-'));
    roots.push(workspace);
    const config = join(workspace, 'user-config.json');
    await writeFile(config, JSON.stringify({
      connections: {
        defaultConnection: 'relay',
        profiles: {relay: {
          provider: 'compatible', protocol: 'openai-responses', baseUrl: 'https://relay.example/v1',
          defaultModel: 'test-model', auth: {type: 'env', name: 'MISSING_RELAY_KEY', header: 'bearer'},
        }},
      },
      agents: {routes: {reviewer: {runtime: 'api', connection: 'relay', model: 'test-model'}}},
    }));

    const result = await runCli([
      'agents', 'list', '--config', config, '--workspace', workspace, '--json',
    ]);

    expect(result).toMatchObject({exitCode: 0, stderr: ''});
    const profiles = JSON.parse(result.stdout) as Array<{name: string; route: {connection?: string; credentials?: string}}>;
    expect(profiles.find(({name}) => name === 'reviewer')?.route).toMatchObject({
      connection: 'relay', credentials: 'env:MISSING_RELAY_KEY',
    });
  }, 20_000);

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
  }, 20_000);
});

function runCli(
  args: string[],
  extraPath?: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<{exitCode: number | null; stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.tsx', ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: extraPath ? `${extraPath}${delimiter}${process.env.PATH ?? ''}` : process.env.PATH,
        SKEIN_NO_UPDATE_CHECK: '1',
        ...environment,
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
