import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
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

  it('keeps an Anthropic inference connection valid without a model catalog', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-anthropic-setup-workspace-'));
    const home = await mkdtemp(join(tmpdir(), 'skein-anthropic-setup-home-'));
    roots.push(workspace, home);
    const environment = {...process.env, SKEIN_HOME: home};

    const inferenceOnly = await runCli([
      'agents', 'setup', '--yes', '--json', '--name', 'relay', '--provider', 'compatible',
      '--protocol', 'anthropic-messages', '--base-url', 'https://relay.example/anthropic',
      '--model', 'claude-relay', '--auth', 'none',
    ], environment);
    expect(inferenceOnly.exitCode).toBe(0);
    expect(JSON.parse(inferenceOnly.stdout)).toMatchObject({
      protocol: 'anthropic-messages', modelsEndpoint: 'https://relay.example/anthropic',
    });

  }, 60_000);

  it('provides first-class provider-neutral add/list/show/use/doctor/test commands', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-first-class-connection-workspace-'));
    const home = await mkdtemp(join(tmpdir(), 'skein-first-class-connection-home-'));
    roots.push(workspace, home);
    const environment = {...process.env, SKEIN_HOME: home};

    const added = await runCli([
      'connections', 'add', '--yes', '--json', '--name', 'company', '--provider', 'company-gateway',
      '--protocol', 'openai-responses', '--base-url', 'https://gateway.example/v1',
      '--model', 'coder-v2', '--declared-model', 'coder-v2', '--auth', 'command',
      '--auth-command', process.execPath, '--auth-arg=-e', '--auth-arg=console.log(process.env.HELPER_TOKEN)',
      '--auth-pass-env', 'HELPER_TOKEN', '--auth-header-name', 'X-Gateway-Token',
      '--auth-header-prefix', 'Token ', '--catalog-auth', 'none', '--header', 'X-Client=skein',
      '--models-header-env', 'X-Tenant=TENANT_ID', '--no-model-discovery',
      '--input-price', '2', '--output-price', '8', '--cached-input-price', '0.5',
    ], {...environment, HELPER_TOKEN: 'runtime-only-secret', TENANT_ID: 'tenant-a'});
    expect(added).toMatchObject({exitCode: 0, stderr: ''});
    expect(JSON.parse(added.stdout)).toMatchObject({
      name: 'company', provider: 'company-gateway', protocol: 'openai-responses',
      auth: expect.stringMatching(/^command:/u), catalogAuth: 'none', declaredModels: ['coder-v2'],
      complete: true, pricing: 'configured',
    });
    const stored = await readFile(join(home, 'config.json'), 'utf8');
    expect(stored).not.toContain('runtime-only-secret');
    expect(stored).toContain('"connections"');
    expect(stored).toContain('"providerId": "company-gateway"');

    const listed = await runCli(['connections', 'list', '--json'], environment);
    expect(JSON.parse(listed.stdout)).toEqual([expect.objectContaining({
      name: 'company', provider: 'company-gateway', credentials: expect.stringMatching(/^command:/u),
      catalogCredentials: 'none', declaredModels: 1, default: true,
      pricing: 'configured',
    })]);
    const shown = await runCli(['connections', 'show', 'company', '--json'], environment);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      authPlacement: 'X-Gateway-Token',
      inferenceHeaders: ['X-Client=static'], catalogHeaders: ['X-Tenant=env:TENANT_ID'],
    });
    expect(shown.stdout).not.toContain('console.log');

    const models = await runCli(['connections', 'models', 'company', '--json'], environment);
    expect(JSON.parse(models.stdout)).toEqual([{id: 'coder-v2'}]);
    const doctor = await runCli(['connections', 'doctor', 'company', '--json'], {
      ...environment, TENANT_ID: 'tenant-a',
    });
    expect(JSON.parse(doctor.stdout)).toEqual([expect.objectContaining({
      config: 'pass', auth: 'configured-unverified', catalog: 'declared-only', inference: 'not-tested',
    })]);
    const tested = await runCli(['connections', 'test', 'company', '--no-catalog', '--json'], {
      ...environment, HELPER_TOKEN: 'runtime-only-secret', TENANT_ID: 'tenant-a',
    });
    expect(JSON.parse(tested.stdout)).toMatchObject({
      ok: true, inference: 'not called', checks: [
        {layer: 'config', status: 'pass'},
        {layer: 'auth', status: 'pass'},
        {layer: 'catalog', status: 'skip'},
      ],
    });
    expect(tested.stdout).not.toContain('runtime-only-secret');

    const used = await runCli(['connections', 'use', 'company', '--json'], environment);
    expect(JSON.parse(used.stdout)).toMatchObject({connection: 'company'});
  }, 60_000);

  it('updates auth placement without inheriting conflicting or irrelevant options', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-connection-update-workspace-'));
    const home = await mkdtemp(join(tmpdir(), 'skein-connection-update-home-'));
    roots.push(workspace, home);
    const environment = {...process.env, SKEIN_HOME: home};
    const base = [
      'connections', 'add', '--yes', '--json', '--name', 'relay', '--provider', 'company',
      '--protocol', 'openai-responses', '--base-url', 'https://relay.example/v1', '--model', 'coder',
      '--auth', 'command', '--auth-command', process.execPath, '--models-path', '/catalog/models',
      '--auth-header-name', 'X-Relay-Key', '--auth-header-prefix', 'Token ',
      '--input-price', '1', '--output-price', '4', '--cached-input-price', '0.25',
    ];
    expect((await runCli(base, environment)).exitCode).toBe(0);

    const preserved = await runCli([
      'connections', 'add', '--yes', '--json', '--name', 'relay', '--models-base-url',
      'https://catalog.example/v1',
    ], environment);
    expect(JSON.parse(preserved.stdout)).toMatchObject({
      authPlacement: 'X-Relay-Key', modelsPath: '/catalog/models', pricing: 'configured',
    });

    const standard = await runCli([
      'connections', 'add', '--yes', '--json', '--name', 'relay', '--auth-header', 'bearer',
      '--models-path', '/models', '--input-price', 'none', '--output-price', 'none',
    ], environment);
    expect(JSON.parse(standard.stdout)).toMatchObject({
      authPlacement: 'bearer', modelsPath: '/models', pricing: 'unpriced',
    });

    const custom = await runCli([
      'connections', 'add', '--yes', '--json', '--name', 'relay', '--auth-header-name', 'X-New-Key',
      '--auth-header-prefix', 'ApiKey ',
    ], environment);
    expect(JSON.parse(custom.stdout)).toMatchObject({authPlacement: 'X-New-Key'});
    const stored = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    expect(stored.connections.profiles.relay.auth).toMatchObject({
      placement: {name: 'X-New-Key', prefix: 'ApiKey '},
    });
    expect(stored.connections.profiles.relay.auth).not.toHaveProperty('header');

    const invalidNone = await runCli([
      'connections', 'add', '--yes', '--name', 'public', '--provider', 'local',
      '--protocol', 'openai-chat', '--base-url', 'http://localhost:8080/v1', '--model', 'local',
      '--auth', 'none', '--auth-arg', 'unused',
    ], environment);
    expect(invalidNone).toMatchObject({exitCode: 1});
    expect(invalidNone.stderr).toContain('Authentication none cannot include');

    const ambiguousCatalog = await runCli([
      'connections', 'add', '--yes', '--name', 'catalog', '--provider', 'company',
      '--protocol', 'openai-chat', '--base-url', 'https://relay.example/v1', '--model', 'coder',
      '--auth', 'none', '--catalog-api-key-env', 'CATALOG_KEY',
    ], environment);
    expect(ambiguousCatalog).toMatchObject({exitCode: 1});
    expect(ambiguousCatalog.stderr).toContain('require --catalog-auth');

  }, 60_000);

  it('keeps init project state credential-free and stores routing in user connections', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-init-connection-workspace-'));
    const home = await mkdtemp(join(tmpdir(), 'skein-init-connection-home-'));
    roots.push(workspace, home);
    const environment = {...process.env, SKEIN_HOME: home};

    const initialized = await runCli([
      'init', '--yes', '--workspace', workspace, '--provider', 'compatible',
      '--base-url', 'http://127.0.0.1:11434/v1', '--model', 'local-coder',
    ], environment);
    expect(initialized.exitCode).toBe(0);
    const project = await readFile(join(workspace, '.skein', 'config.json'), 'utf8');
    const user = await readFile(join(home, 'config.json'), 'utf8');
    expect(project).not.toMatch(/provider|baseUrl|apiKey|auth/u);
    expect(user).toContain('"connections"');
    expect(user).toContain('http://127.0.0.1:11434/v1');
    expect(user).toContain('"type": "none"');

    const rejected = await runCli([
      'init', '--yes', '--workspace', workspace, '--provider', 'openai', '--api-key', 'must-not-store',
    ], environment);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain('--api-key is not accepted');
    expect(await readFile(join(home, 'config.json'), 'utf8')).not.toContain('must-not-store');
    expect(await readFile(join(workspace, '.skein', 'config.json'), 'utf8')).not.toContain('must-not-store');
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
