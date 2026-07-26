import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

async function brokenConnectionEnvironment(): Promise<NodeJS.ProcessEnv> {
  const workspace = await mkdtemp(join(tmpdir(), 'skein-local-cmd-workspace-'));
  const home = await mkdtemp(join(tmpdir(), 'skein-local-cmd-home-'));
  roots.push(workspace, home);
  await writeFile(join(workspace, 'sample.ts'), 'export const localOnly = true;\n');
  return {
    ...process.env,
    SKEIN_HOME: home,
    NO_COLOR: '1',
    SKEIN_WORKSPACE: workspace,
    SKEIN_CONNECTIONS: 'broken',
    SKEIN_CONNECTION_BROKEN_PROVIDER: 'compatible',
    SKEIN_CONNECTION_BROKEN_PROTOCOL: 'openai-responses',
    SKEIN_CONNECTION_BROKEN_BASE_URL: 'https://relay.invalid/v1',
    SKEIN_CONNECTION_BROKEN_API_KEY_ENV: 'SKEIN_TEST_MISSING_CREDENTIAL',
    SKEIN_DEFAULT_CONNECTION: 'broken',
  };
}

describe('local-only commands without model credentials', () => {
  it('index, search, status, doctor, and config show keep working', async () => {
    const environment = await brokenConnectionEnvironment();
    const workspace = environment.SKEIN_WORKSPACE as string;

    const index = await runCli(['index', '--workspace', workspace, '--json'], environment);
    expect(index.stderr).not.toContain('is incomplete');
    expect(index.exitCode).toBe(0);

    const search = await runCli(['search', 'localOnly', '--workspace', workspace, '--json'], environment);
    expect(search.exitCode).toBe(0);

    const status = await runCli(['status', '--workspace', workspace, '--json'], environment);
    expect(status.exitCode).toBe(0);

    const configShow = await runCli(['config', 'show', '--workspace', workspace, '--json'], environment);
    expect(configShow.exitCode).toBe(0);
    expect(configShow.stdout).not.toContain('SKEIN_TEST_MISSING_CREDENTIAL is set');

    const statusText = await runCli(['--no-color', 'status', '--workspace', workspace], environment);
    expect(statusText.exitCode).toBe(0);
    expect(statusText.stdout).toMatch(/API key\s+missing/u);
  }, 60_000);

  it('model-backed chat still fails closed with the incomplete-connection error', async () => {
    const environment = await brokenConnectionEnvironment();
    const workspace = environment.SKEIN_WORKSPACE as string;
    const chat = await runCli(['-p', 'hello', '--workspace', workspace], environment);
    expect(chat.exitCode).not.toBe(0);
    expect(chat.stderr).toContain('is incomplete');
  }, 30_000);
});

function runCli(args: string[], environment: NodeJS.ProcessEnv): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.tsx', ...args], {
      cwd: process.cwd(),
      env: environment,
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
