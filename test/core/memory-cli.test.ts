import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('CLI memory governance', () => {
  it('keeps privacy output content-free and exports reviewed content explicitly', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-memory-cli-workspace-'));
    const home = await mkdtemp(join(tmpdir(), 'skein-memory-cli-home-'));
    roots.push(workspace, home);
    const environment = isolatedEnvironment(home);
    const workspaceSecret = 'Private workspace release convention.';
    const userSecret = 'Prefer terse personal summaries.';

    expect((await runCli([
      '--no-color', 'memory', 'add', '--workspace', workspace, '--scope', 'workspace', workspaceSecret,
    ], environment)).exitCode).toBe(0);
    expect((await runCli([
      '--no-color', 'memory', 'add', '--workspace', workspace, '--scope', 'user', userSecret,
    ], environment)).exitCode).toBe(0);

    const privacy = await runCli([
      '--no-color', 'memory', 'privacy', '--workspace', workspace, '--json',
    ], environment);
    expect(privacy.exitCode).toBe(0);
    expect(JSON.parse(privacy.stdout)).toMatchObject({
      contentIncluded: false,
      scopeKeysIncluded: false,
      databasePathIncluded: false,
      totals: {records: 2, active: 2, archived: 0},
      recordsByScope: {user: 1, workspace: 1},
      storage: {kind: 'local-sqlite', encryptedAtRest: false},
    });
    expect(privacy.stdout).not.toContain(workspaceSecret);
    expect(privacy.stdout).not.toContain(userSecret);
    expect(privacy.stdout).not.toContain(workspace);
    expect(privacy.stdout).not.toContain(home);

    const stdoutExport = await runCli([
      '--no-color', 'memory', 'export', '--workspace', workspace, '--scope', 'workspace',
    ], environment);
    expect(stdoutExport.exitCode).toBe(0);
    const exported = JSON.parse(stdoutExport.stdout) as {
      records: Array<{scope: string; content: string}>;
      candidates: unknown[];
    };
    expect(exported.records).toEqual([
      expect.objectContaining({scope: 'workspace', content: workspaceSecret}),
    ]);
    expect(exported.candidates).toEqual([]);
    expect(stdoutExport.stdout).not.toContain(userSecret);

    const exportPath = join(home, 'memory-export.json');
    const fileExport = await runCli([
      '--no-color', 'memory', 'export', exportPath, '--workspace', workspace, '--scope', 'all',
    ], environment);
    expect(fileExport.exitCode).toBe(0);
    expect(JSON.parse(await readFile(exportPath, 'utf8')).records).toHaveLength(2);
    if (process.platform !== 'win32') expect((await stat(exportPath)).mode & 0o777).toBe(0o600);

    const symlinkTarget = join(home, 'existing.json');
    const symlinkPath = join(home, 'linked-export.json');
    await writeFile(symlinkTarget, '{}\n');
    await symlink(symlinkTarget, symlinkPath);
    const rejected = await runCli([
      '--no-color', 'memory', 'export', symlinkPath, '--workspace', workspace, '--scope', 'all',
    ], environment);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain('cannot be a symbolic link');
    expect(await readFile(symlinkTarget, 'utf8')).toBe('{}\n');
  }, 45_000);

  it('requires explicit headless confirmation and clears only the selected scope', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-memory-clear-workspace-'));
    const home = await mkdtemp(join(tmpdir(), 'skein-memory-clear-home-'));
    roots.push(workspace, home);
    const environment = isolatedEnvironment(home);

    await runCli([
      '--no-color', 'memory', 'add', '--workspace', workspace, '--scope', 'workspace',
      'Workspace memory must survive the user clear.',
    ], environment);
    await runCli([
      '--no-color', 'memory', 'add', '--workspace', workspace, '--scope', 'user',
      'User memory will be cleared.',
    ], environment);

    const unconfirmed = await runCli([
      '--no-color', 'memory', 'clear', '--workspace', workspace, '--scope', 'user', '--json',
    ], environment);
    expect(unconfirmed.exitCode).toBe(1);
    expect(unconfirmed.stderr).toContain('requires explicit --yes confirmation');

    const cleared = await runCli([
      '--no-color', 'memory', 'clear', '--workspace', workspace, '--scope', 'user', '--yes', '--json',
    ], environment);
    expect(cleared.exitCode).toBe(0);
    expect(JSON.parse(cleared.stdout)).toMatchObject({records: 1, candidates: 0, compacted: true, scope: 'user'});

    const remaining = await runCli([
      '--no-color', 'memory', 'export', '--workspace', workspace, '--scope', 'all',
    ], environment);
    const bundle = JSON.parse(remaining.stdout) as {records: Array<{scope: string; content: string}>};
    expect(bundle.records).toEqual([
      expect.objectContaining({scope: 'workspace', content: 'Workspace memory must survive the user clear.'}),
    ]);
  }, 45_000);
});

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  return {...process.env, SKEIN_HOME: home, NO_COLOR: '1'};
}

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
