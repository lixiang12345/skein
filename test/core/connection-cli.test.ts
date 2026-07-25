import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('CLI connection selection', () => {
  it('fails headless ambiguity with an actionable option and resolves an explicit connection', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-connection-cli-workspace-'));
    const home = await mkdtemp(join(tmpdir(), 'skein-connection-cli-home-'));
    roots.push(workspace, home);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      SKEIN_HOME: home,
      SKEIN_CONNECTIONS: 'alpha,beta',
      SKEIN_CONNECTION_ALPHA_PROVIDER: 'compatible',
      SKEIN_CONNECTION_ALPHA_BASE_URL: 'http://127.0.0.1:11434/v1',
      SKEIN_CONNECTION_ALPHA_AUTH: 'none',
      SKEIN_CONNECTION_ALPHA_MODEL: 'alpha-model',
      SKEIN_CONNECTION_BETA_PROVIDER: 'compatible',
      SKEIN_CONNECTION_BETA_BASE_URL: 'http://127.0.0.1:11435/v1',
      SKEIN_CONNECTION_BETA_AUTH: 'none',
      SKEIN_CONNECTION_BETA_MODEL: 'beta-model',
    };
    delete environment.SKEIN_DEFAULT_CONNECTION;

    const ambiguous = await runCli(['--no-color', '--print', '--workspace', workspace, 'hello'], environment);
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stderr).toContain('Multiple complete model connections found: alpha, beta. Pass --connection <name>.');

    const explicit = await runCli([
      '--no-color', '--connection', 'beta', '--workspace', workspace, 'config', 'show', '--json',
    ], environment);
    expect(explicit).toMatchObject({exitCode: 0, stderr: ''});
    const summary = JSON.parse(explicit.stdout) as {
      model: string;
      endpoint: string;
      activeConnection: {id: string; source: string; authStatus: string};
    };
    expect(summary).toMatchObject({
      model: 'compatible/beta-model',
      endpoint: 'http://127.0.0.1:11435/v1',
      activeConnection: {id: 'beta', source: 'environment', authStatus: 'none'},
    });
  }, 20_000);

  it('creates relay-only setup with Responses by default and supports explicit no-auth', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-connection-setup-workspace-'));
    const home = await mkdtemp(join(tmpdir(), 'skein-connection-setup-home-'));
    roots.push(workspace, home);
    const environment = {...process.env, SKEIN_HOME: home};

    const setup = await runCli([
      'agents', 'setup', '--yes', '--json', '--name', 'local', '--provider', 'compatible',
      '--base-url', 'http://127.0.0.1:11434/v1', '--model', 'local-coder', '--auth', 'none',
    ], environment);
    expect(setup).toMatchObject({exitCode: 0, stderr: ''});
    expect(JSON.parse(setup.stdout)).toMatchObject({
      connection: 'local', provider: 'compatible', protocol: 'openai-responses', auth: 'none',
      apiKeyEnv: null, defaultModel: 'local-coder',
    });

    const connections = await runCli(['agents', 'connections', '--json'], environment);
    expect(connections.exitCode).toBe(0);
    expect(JSON.parse(connections.stdout)).toEqual([expect.objectContaining({
      name: 'local', protocol: 'openai-responses', credentials: 'none', complete: true,
      endpoint: 'http://127.0.0.1:11434/v1', modelsEndpoint: 'http://127.0.0.1:11434/v1',
    })]);
  }, 20_000);

  it('requires an independent model catalog base for Anthropic relay transport', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-anthropic-setup-workspace-'));
    const home = await mkdtemp(join(tmpdir(), 'skein-anthropic-setup-home-'));
    roots.push(workspace, home);
    const environment = {...process.env, SKEIN_HOME: home};

    const incomplete = await runCli([
      'agents', 'setup', '--yes', '--name', 'relay', '--provider', 'compatible',
      '--protocol', 'anthropic-messages', '--base-url', 'https://relay.example/anthropic',
      '--model', 'claude-relay', '--auth', 'none',
    ], environment);
    expect(incomplete.exitCode).toBe(1);
    expect(incomplete.stderr).toContain('require a separate models base URL');

    const complete = await runCli([
      'agents', 'setup', '--yes', '--json', '--name', 'relay', '--provider', 'compatible',
      '--protocol', 'anthropic-messages', '--base-url', 'https://relay.example/anthropic',
      '--models-base-url', 'https://relay.example/v1', '--model', 'claude-relay', '--auth', 'none',
    ], environment);
    expect(complete.exitCode).toBe(0);
    expect(JSON.parse(complete.stdout)).toMatchObject({
      protocol: 'anthropic-messages',
      endpoint: 'https://relay.example/anthropic',
      modelsEndpoint: 'https://relay.example/v1',
    });

    const publicCatalog = await runCli([
      'agents', 'setup', '--yes', '--json', '--name', 'relay', '--provider', 'compatible',
      '--protocol', 'anthropic-messages', '--base-url', 'https://relay.example',
      '--models-base-url', 'https://relay.example/v1', '--model', 'claude-relay', '--auth', 'env',
      '--auth-header', 'x-api-key', '--models-auth-header', 'none', '--api-key-env', 'RELAY_KEY',
    ], {...environment, RELAY_KEY: 'not-persisted'});
    expect(publicCatalog.exitCode).toBe(0);
    expect(JSON.parse(publicCatalog.stdout)).toMatchObject({
      authHeader: 'x-api-key', modelsAuthHeader: 'none', apiKeyEnv: 'RELAY_KEY',
    });
  }, 20_000);
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
