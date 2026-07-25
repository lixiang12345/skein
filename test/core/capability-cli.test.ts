import {spawn} from 'node:child_process';
import {access, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('agents capability CLI', () => {
  it('inspects, pins, exports, unpins, and resets without exposing route inputs', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-capability-cli-workspace-'));
    const home = await mkdtemp(join(tmpdir(), 'skein-capability-cli-home-'));
    roots.push(workspace, home);
    await writeFile(join(home, 'config.json'), `${JSON.stringify({
      model: {
        provider: 'compatible',
        model: 'parent-model',
        baseUrl: 'http://127.0.0.1:11434/v1',
      },
      agents: {
        connections: {
          fast: {
            provider: 'compatible', protocol: 'openai-responses',
            baseUrl: 'http://127.0.0.1:11435/v1', defaultModel: 'fast-model', auth: {type: 'none'},
          },
          quality: {
            provider: 'compatible', protocol: 'openai-responses',
            baseUrl: 'https://private-relay.example/v1', defaultModel: 'quality-model', auth: {type: 'none'},
          },
        },
        routes: {
          frontend: {connection: 'fast'},
          backend: {connection: 'quality'},
        },
        capability: {
          mode: 'shadow', halfLifeDays: 30, minimumSamples: 5,
          priors: {frontend: {
            frontend: {successRate: 0.5, strength: 10},
            backend: {successRate: 0.9, strength: 10},
          }},
        },
      },
    }, null, 2)}\n`, {mode: 0o600});
    const environment = {
      ...process.env,
      SKEIN_HOME: home,
      SKEIN_NO_UPDATE_CHECK: '1',
    };

    const inspected = await runCli([
      'agents', 'capability', 'inspect', 'frontend', '--workspace', workspace, '--json',
    ], environment);
    expect(inspected).toMatchObject({exitCode: 0, stderr: ''});
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      mode: 'shadow', profile: 'frontend', current: 'frontend', suggested: 'backend', changed: true,
    });

    const textInspection = await runCli([
      'agents', 'capability', 'inspect', 'frontend', '--workspace', workspace,
    ], environment);
    expect(textInspection).toMatchObject({exitCode: 0, stderr: ''});
    expect(textInspection.stdout).toContain('frontend  mode=shadow  recommend change');
    expect(textInspection.stdout).toContain('    transport: openai-responses');
    expect(textInspection.stdout).not.toContain('private-relay.example');

    const pinned = await runCli([
      'agents', 'capability', 'pin', 'frontend', 'backend', '--workspace', workspace, '--json',
    ], environment);
    expect(pinned).toMatchObject({exitCode: 0, stderr: ''});
    expect(JSON.parse(pinned.stdout)).toMatchObject({profile: 'frontend', route: 'backend', mode: 'shadow'});

    const pinnedInspection = await runCli([
      'agents', 'capability', 'inspect', 'frontend', '--workspace', workspace, '--json',
    ], environment);
    expect(JSON.parse(pinnedInspection.stdout)).toMatchObject({pinned: 'active', suggested: 'backend'});

    const exported = await runCli([
      'agents', 'capability', 'export', '--workspace', workspace,
    ], environment);
    expect(exported).toMatchObject({exitCode: 0, stderr: ''});
    const exportValue = JSON.parse(exported.stdout) as {version: number; pins: unknown[]; epochs: unknown[]};
    expect(exportValue).toMatchObject({version: 1, pins: [expect.any(Object)]});
    expect(exportValue.epochs.length).toBeGreaterThan(0);
    expect(exported.stdout).not.toContain('private-relay');
    expect(exported.stdout).not.toContain('quality-model');
    expect(exported.stdout).not.toContain('frontend');

    const unpinned = await runCli([
      'agents', 'capability', 'unpin', 'frontend', '--workspace', workspace, '--json',
    ], environment);
    expect(JSON.parse(unpinned.stdout)).toEqual({profile: 'frontend', removed: true});

    const reset = await runCli([
      'agents', 'capability', 'reset', '--workspace', workspace, '--yes', '--json',
    ], environment);
    expect(JSON.parse(reset.stdout)).toMatchObject({version: 1, epochs: [], observations: [], pins: []});
  }, 30_000);

  it('keeps off-mode inspection read-only and retains the static route', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-capability-off-workspace-'));
    const home = await mkdtemp(join(tmpdir(), 'skein-capability-off-home-'));
    roots.push(workspace, home);
    await writeFile(join(home, 'config.json'), `${JSON.stringify({
      model: {
        provider: 'compatible',
        model: 'local-model',
        baseUrl: 'http://127.0.0.1:11434/v1',
      },
      agents: {capability: {mode: 'off'}},
    }, null, 2)}\n`, {mode: 0o600});
    const result = await runCli([
      'agents', 'capability', 'inspect', 'frontend', '--workspace', workspace, '--json',
    ], {...process.env, SKEIN_HOME: home, SKEIN_NO_UPDATE_CHECK: '1'});
    expect(result).toMatchObject({exitCode: 0, stderr: ''});
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'off', profile: 'frontend', current: '@parent', suggested: '@parent', changed: false,
    });
    await expect(access(join(workspace, '.skein', 'capability-registry.json'))).rejects.toThrow();
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
