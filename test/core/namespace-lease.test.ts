import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {once} from 'node:events';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Command} from 'commander';
import {afterEach, describe, expect, it} from 'vitest';
import {MemoryStore} from '../../src/memory/store.js';
import {SessionStore} from '../../src/session/store.js';
import {CheckpointStore} from '../../src/checkpoint/store.js';
import {TeamRunStore} from '../../src/agent/team-store.js';
import {LocalContextIndex} from '../../src/context/local-index.js';
import {
  saveUiPreference,
  saveUserConfig,
  trustProjectModelConfig,
} from '../../src/config.js';
import {
  acquireCliNamespaceLeases,
  cliNamespaceLeaseScopes,
  releaseCliNamespaceLeases,
} from '../../src/cli/namespace-leases.js';
import {
  homeNamespacePaths,
  migrateHomeNamespace,
  migrateProjectNamespace,
  projectNamespacePaths,
} from '../../src/utils/namespace.js';
import {
  acquireNamespaceLease,
  NamespaceLeaseBusyError,
} from '../../src/utils/namespace-lease.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('namespace leases', () => {
  it('assigns CLI lease scopes without self-locking namespace mutations', () => {
    const program = new Command().name('skein').option('-w, --workspace <path>');
    const migrate = program.command('migrate').option('--yes').option('--home');
    migrate.setOptionValue('yes', true);
    expect(cliNamespaceLeaseScopes(migrate)).toEqual([]);
    migrate.setOptionValue('yes', false);
    migrate.setOptionValue('home', true);
    expect(cliNamespaceLeaseScopes(migrate)).toEqual(['home']);

    const sessions = program.command('session');
    expect(cliNamespaceLeaseScopes(sessions.command('list'))).toEqual(['project']);
    expect(cliNamespaceLeaseScopes(program.command('tools'))).toEqual([]);
    expect(cliNamespaceLeaseScopes(program)).toEqual(['project', 'home']);
  });

  it('prefers a subcommand workspace when acquiring CLI leases', async () => {
    const globalWorkspace = await workspace();
    const localWorkspace = await workspace();
    const program = new Command().name('skein')
      .option('-w, --workspace <path>', 'workspace', globalWorkspace);
    const command = program.command('session').command('list')
      .option('-w, --workspace <path>', 'workspace');
    command.setOptionValue('workspace', localWorkspace);

    const leases = await acquireCliNamespaceLeases(command);
    try {
      await expect(acquireNamespaceLease(
        projectNamespacePaths(localWorkspace).canonical,
        'exclusive',
      )).rejects.toBeInstanceOf(NamespaceLeaseBusyError);
      const unrelated = await acquireNamespaceLease(
        projectNamespacePaths(globalWorkspace).canonical,
        'exclusive',
      );
      unrelated.release();
    } finally {
      releaseCliNamespaceLeases(leases);
    }
  });

  it('allows shared holders and excludes namespace mutation holders', async () => {
    const root = await workspace();
    const target = projectNamespacePaths(root).canonical;
    const first = await acquireNamespaceLease(target, 'shared');
    expect(first.path.startsWith(root)).toBe(false);
    const second = await acquireNamespaceLease(target, 'shared');
    try {
      await expect(acquireNamespaceLease(target, 'exclusive')).rejects.toBeInstanceOf(NamespaceLeaseBusyError);
    } finally {
      second.release();
      first.release();
    }

    const exclusive = await acquireNamespaceLease(target, 'exclusive');
    try {
      await expect(acquireNamespaceLease(target, 'shared')).rejects.toBeInstanceOf(NamespaceLeaseBusyError);
    } finally {
      exclusive.release();
    }
    const shared = await acquireNamespaceLease(target, 'shared');
    shared.release();
  });

  it.skipIf(process.platform === 'win32')('holds the CLI lease across processes and releases it after SIGKILL', async () => {
    const root = await workspace();
    await mkdir(join(root, '.mosaic'));
    await writeFile(join(root, '.mosaic', 'config.json'), 'legacy');
    const target = projectNamespacePaths(root).canonical;
    const child = spawn(process.execPath, [
      '--import', 'tsx', 'src/cli.tsx', '--print', '--workspace', root,
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      await waitForExclusiveBlock(target, child);
      const secondShared = await acquireNamespaceLease(target, 'shared');
      secondShared.release();
      await expect(migrateProjectNamespace(root)).rejects.toThrow('in use by another Skein process');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      expect((await migrateProjectNamespace(root)).status).toBe('complete');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  }, 15_000);

  it('coalesces concurrent default memory opens under one home shared lease', async () => {
    const home = await workspace();
    const legacy = join(home, 'legacy-home');
    const environment = {MOSAIC_HOME: legacy};
    await mkdir(legacy);
    const previousSkeinHome = process.env.SKEIN_HOME;
    const previousMosaicHome = process.env.MOSAIC_HOME;
    delete process.env.SKEIN_HOME;
    process.env.MOSAIC_HOME = legacy;
    const store = new MemoryStore();
    await Promise.all([store.open(), store.open()]);
    try {
      await expect(migrateHomeNamespace(environment)).rejects.toThrow('in use by another Skein process');
      store.close();
      expect((await migrateHomeNamespace(environment)).status).toBe('complete');
      expect(new MemoryStore().path).toBe(join(homeNamespacePaths(environment).canonical, 'memory.sqlite'));
    } finally {
      store.close();
      restoreEnvironment('SKEIN_HOME', previousSkeinHome);
      restoreEnvironment('MOSAIC_HOME', previousMosaicHome);
    }
    expect(await readFile(join(homeNamespacePaths(environment).canonical, 'memory.sqlite'))).not.toHaveLength(0);
  });

  it('blocks direct user configuration writers during home migration', async () => {
    const home = await workspace();
    const root = await workspace();
    const canonical = join(home, 'canonical');
    const legacy = join(home, 'legacy');
    const projectConfig = join(root, '.mosaic', 'config.json');
    await mkdir(join(root, '.mosaic'));
    await writeFile(projectConfig, '{}');
    const previousSkeinHome = process.env.SKEIN_HOME;
    const previousMosaicHome = process.env.MOSAIC_HOME;
    process.env.SKEIN_HOME = canonical;
    process.env.MOSAIC_HOME = legacy;
    const lease = await acquireNamespaceLease(canonical, 'exclusive');
    try {
      await expect(saveUiPreference({compact: true})).rejects.toBeInstanceOf(NamespaceLeaseBusyError);
      await expect(saveUserConfig({agent: {maxTurns: 3}})).rejects.toBeInstanceOf(NamespaceLeaseBusyError);
      await expect(trustProjectModelConfig(root, projectConfig)).rejects.toBeInstanceOf(NamespaceLeaseBusyError);
    } finally {
      lease.release();
      restoreEnvironment('SKEIN_HOME', previousSkeinHome);
      restoreEnvironment('MOSAIC_HOME', previousMosaicHome);
    }
  });

  it('rejects writes from a store that cached the legacy project namespace', async () => {
    const root = await workspace();
    const store = new SessionStore(root);
    await store.create({id: 'before', title: 'Before', provider: 'openai', model: 'test'});
    await migrateProjectNamespace(root);
    await expect(store.create({
      id: 'stale', title: 'Stale', provider: 'openai', model: 'test',
    })).rejects.toThrow('storage namespace changed');
    await expect(access(join(root, '.mosaic', 'sessions', 'stale.json'))).rejects.toMatchObject({code: 'ENOENT'});

    const active = new SessionStore(root);
    await active.create({id: 'active', title: 'Active', provider: 'openai', model: 'test'});
    expect(await readFile(join(root, '.skein', 'sessions', 'active.json'), 'utf8')).toContain('"id": "active"');
  });

  it('rejects stale checkpoint, team-run, and index writers after migration', async () => {
    const root = await workspace();
    await mkdir(join(root, '.mosaic'));
    await writeFile(join(root, '.mosaic', 'config.json'), '{}');
    await writeFile(join(root, 'source.ts'), 'export const value = 1;\n');
    const checkpoints = new CheckpointStore(root);
    const teamRuns = new TeamRunStore(root);
    const index = new LocalContextIndex([root]);
    await migrateProjectNamespace(root);

    await expect(checkpoints.capture('session', [join(root, 'source.ts')])).rejects.toThrow('storage namespace changed');
    await expect(teamRuns.create({
      objective: 'stale writer', reviewer: 'reviewer', maxReviewRounds: 1,
    })).rejects.toThrow('storage namespace changed');
    await expect(index.build()).rejects.toThrow('storage namespace changed');
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skein-lease-'));
  roots.push(root);
  return root;
}

async function waitForExclusiveBlock(
  target: string,
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Lease-holder CLI exited early with ${child.exitCode ?? child.signalCode}.`);
    }
    try {
      const lease = await acquireNamespaceLease(target, 'exclusive');
      lease.release();
    } catch (error) {
      if (error instanceof NamespaceLeaseBusyError) return;
      throw error;
    }
    await delay(25);
  }
  throw new Error('Timed out waiting for the CLI to acquire its namespace lease.');
}

function restoreEnvironment(name: 'SKEIN_HOME' | 'MOSAIC_HOME', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
