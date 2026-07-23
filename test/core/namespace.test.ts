import {mkdtemp, mkdir, readFile, writeFile, access, cp, rename, rm, stat, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  inspectProjectNamespace,
  inspectProjectRollback,
  inspectHomeNamespace,
  inspectHomeRecovery,
  inspectProjectRecovery,
  legacyCompatibilityStatus,
  LEGACY_COMPATIBILITY_POLICY,
  migrateHomeNamespace,
  migrateProjectNamespace,
  recoverHomeNamespace,
  recoverProjectNamespace,
  rollbackHomeNamespace,
  rollbackProjectNamespace,
  resolveProjectNamespace,
  resolveProjectNamespaceSync,
  resolveHomeStorageNamespace,
  projectNamespacePaths,
} from '../../src/utils/namespace.js';
import {acquireNamespaceLease} from '../../src/utils/namespace-lease.js';

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'skein-namespace-'));
}

function expectedFreshProjectNamespaceKind(): 'canonical' | 'legacy' {
  return legacyCompatibilityStatus().phase === 'active' ? 'legacy' : 'canonical';
}

describe('storage namespace migration', () => {
  it('defines and measures the legacy alias compatibility window', async () => {
    const root = await workspace();
    await mkdir(join(root, '.mosaic'));
    const projectNamespace = await inspectProjectNamespace(root);
    const status = legacyCompatibilityStatus({
      release: '0.2.0',
      projectNamespace,
      environment: {MOSAIC_MODEL: 'legacy-model'},
    });
    expect(LEGACY_COMPATIBILITY_POLICY).toEqual({
      deprecatedIn: '0.3.0',
      pendingRemovalIn: '0.4.0',
      removedIn: '0.5.0',
    });
    expect(status).toMatchObject({
      release: '0.2.0',
      phase: 'active',
      inUse: true,
      legacyPaths: [{scope: 'project', path: join(root, '.mosaic')}],
      legacyEnvironmentVariables: ['MOSAIC_MODEL'],
    });
    expect(legacyCompatibilityStatus({release: '0.3.0'}).phase).toBe('deprecated');
    expect(legacyCompatibilityStatus({release: '0.4.0'}).phase).toBe('pending-removal');
    expect(legacyCompatibilityStatus({
      environment: {MOSAIC_MODEL: 'legacy', SKEIN_MODEL: 'canonical'},
    }).legacyEnvironmentVariables).toEqual([]);
  });

  it('reports an empty workspace as migration-complete without creating state', async () => {
    const root = await workspace();
    const status = await resolveProjectNamespace(root);
    expect(status.activeKind).toBe(expectedFreshProjectNamespaceKind());
    expect(status.phase).toBe(legacyCompatibilityStatus().phase);
    expect(status.conflict).toBe(false);
    await expect(access(status.active)).rejects.toMatchObject({code: 'ENOENT'});
    const manifest = await inspectProjectNamespace(root);
    expect(manifest.status).toBe('complete');
    expect(manifest.entries).toEqual([]);
  });

  it('creates a manifest and atomically migrates legacy state', async () => {
    const root = await workspace();
    await mkdir(join(root, '.mosaic', 'sessions'), {recursive: true});
    await writeFile(join(root, '.mosaic', 'sessions', 'one.json'), '{"id":"one"}\n');
    const before = await inspectProjectNamespace(root);
    expect(before.status).toBe('ready');
    expect(before.entries.some((entry) => entry.relativePath === 'sessions/one.json')).toBe(true);
    const after = await migrateProjectNamespace(root);
    expect(after.status).toBe('complete');
    expect(after.migrationId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(await readFile(join(root, '.skein', 'sessions', 'one.json'), 'utf8')).toBe('{"id":"one"}\n');
    expect((await stat(join(root, '.skein'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, '.skein', 'sessions', 'one.json'))).mode & 0o777).toBe(0o600);
    const storedManifest = await readFile(join(root, '.skein', 'migration-manifest.json'), 'utf8');
    expect(storedManifest).toContain('"status": "complete"');
    expect(storedManifest).toContain(after.migrationId as string);
    const repeat = await migrateProjectNamespace(root);
    expect(repeat.status).toBe('complete');
  });

  it('blocks conflicting files instead of overwriting canonical state', async () => {
    const root = await workspace();
    await mkdir(join(root, '.mosaic'), {recursive: true});
    await mkdir(join(root, '.skein'), {recursive: true});
    await writeFile(join(root, '.mosaic', 'config.json'), 'legacy');
    await writeFile(join(root, '.skein', 'config.json'), 'canonical');
    const manifest = await inspectProjectNamespace(root);
    expect(manifest.status).toBe('conflict');
    await expect(migrateProjectNamespace(root)).rejects.toThrow('conflicts');
    expect(await readFile(join(root, '.skein', 'config.json'), 'utf8')).toBe('canonical');
  });

  it('rolls back only an unchanged migration and keeps the legacy source', async () => {
    const root = await workspace();
    await mkdir(join(root, '.mosaic', 'sessions'), {recursive: true});
    await writeFile(join(root, '.mosaic', 'sessions', 'one.json'), '{"id":"one"}\n');
    expect((await inspectProjectRollback(root)).ready).toBe(false);
    await migrateProjectNamespace(root);
    expect((await inspectProjectRollback(root)).ready).toBe(true);
    const rolledBack = await rollbackProjectNamespace(root);
    expect(rolledBack.status).toBe('rolled_back');
    expect(await readFile(join(root, '.mosaic', 'sessions', 'one.json'), 'utf8')).toBe('{"id":"one"}\n');
    await expect(access(join(root, '.skein'))).rejects.toMatchObject({code: 'ENOENT'});
    expect((await rollbackProjectNamespace(root)).status).toBe('not_available');
  });

  it('refuses rollback after canonical data changes', async () => {
    const root = await workspace();
    await mkdir(join(root, '.mosaic'), {recursive: true});
    await writeFile(join(root, '.mosaic', 'config.json'), 'legacy');
    await migrateProjectNamespace(root);
    await writeFile(join(root, '.skein', 'config.json'), 'edited-canonical');
    await expect(rollbackProjectNamespace(root)).rejects.toThrow('conflicts');
    expect(await readFile(join(root, '.skein', 'config.json'), 'utf8')).toBe('edited-canonical');
  });

  it('migrates and rolls back the user namespace with the explicit home scope', async () => {
    const home = await mkdtemp(join(tmpdir(), 'skein-home-namespace-'));
    const legacy = join(home, 'legacy-home');
    const canonical = join(home, 'canonical-home');
    await mkdir(join(legacy, 'sessions'), {recursive: true});
    await writeFile(join(legacy, 'sessions', 'home.json'), '{"id":"home"}\n');
    const environment = {SKEIN_HOME: canonical, MOSAIC_HOME: legacy};
    const resolution = await resolveHomeStorageNamespace(environment);
    expect(resolution.canonical).toBe(canonical);
    expect(resolution.legacy).toBe(legacy);
    expect((await inspectHomeNamespace(environment)).status).toBe('ready');
    await migrateHomeNamespace(environment);
    expect(await readFile(join(canonical, 'sessions', 'home.json'), 'utf8')).toBe('{"id":"home"}\n');
    expect((await rollbackHomeNamespace(environment)).status).toBe('rolled_back');
    await expect(access(canonical)).rejects.toMatchObject({code: 'ENOENT'});
    await rm(home, {recursive: true, force: true});
  });

  it('derives explicit user source and destination paths without nesting namespaces', async () => {
    const home = await mkdtemp(join(tmpdir(), 'skein-home-paths-'));
    const legacy = join(home, 'legacy-custom');
    const canonical = join(home, 'canonical-custom');
    const fromLegacy = await resolveHomeStorageNamespace({MOSAIC_HOME: legacy});
    expect(fromLegacy.legacy).toBe(legacy);
    expect(fromLegacy.canonical).toBe(join(home, '.skein'));
    const fromCanonical = await resolveHomeStorageNamespace({SKEIN_HOME: canonical});
    expect(fromCanonical.canonical).toBe(canonical);
    expect(fromCanonical.legacy).toBe(join(home, '.mosaic'));
    await rm(home, {recursive: true, force: true});
  });

  it('rejects overlapping logical or physical user namespace paths', async () => {
    const home = await mkdtemp(join(tmpdir(), 'skein-home-overlap-'));
    const legacy = join(home, 'legacy');
    await mkdir(legacy);
    await writeFile(join(legacy, 'config.json'), 'legacy');
    const nested = {
      MOSAIC_HOME: legacy,
      SKEIN_HOME: join(legacy, 'canonical'),
    };
    await expect(resolveHomeStorageNamespace(nested)).rejects.toThrow('non-nested paths');
    await expect(migrateHomeNamespace(nested)).rejects.toThrow('non-nested paths');
    await expect(resolveHomeStorageNamespace({
      MOSAIC_HOME: join(home, 'canonical', 'legacy'),
      SKEIN_HOME: join(home, 'canonical'),
    })).rejects.toThrow('non-nested paths');
    await expect(migrateHomeNamespace({MOSAIC_HOME: legacy, SKEIN_HOME: legacy})).rejects.toThrow('non-nested paths');

    const alias = join(home, 'legacy-alias');
    await symlink(legacy, alias);
    await expect(inspectHomeNamespace({
      MOSAIC_HOME: legacy,
      SKEIN_HOME: join(alias, 'canonical'),
    })).rejects.toThrow('overlapping paths');
    expect(await readFile(join(legacy, 'config.json'), 'utf8')).toBe('legacy');
    await expect(access(join(legacy, 'canonical.lock'))).rejects.toMatchObject({code: 'ENOENT'});
    await rm(home, {recursive: true, force: true});
  });

  it('treats partial or extra canonical state as a conflict', async () => {
    const root = await workspace();
    await mkdir(join(root, '.mosaic', 'sessions'), {recursive: true});
    await writeFile(join(root, '.mosaic', 'config.json'), 'legacy');
    await writeFile(join(root, '.mosaic', 'sessions', 'one.json'), 'one');
    await mkdir(join(root, '.skein'), {recursive: true});
    await writeFile(join(root, '.skein', 'config.json'), 'legacy');
    let manifest = await inspectProjectNamespace(root);
    expect(manifest.status).toBe('conflict');
    expect(manifest.conflicts).toContain('sessions');

    await mkdir(join(root, '.skein', 'sessions'), {recursive: true});
    await writeFile(join(root, '.skein', 'sessions', 'one.json'), 'one');
    await writeFile(join(root, '.skein', 'extra.json'), 'extra');
    manifest = await inspectProjectNamespace(root);
    expect(manifest.status).toBe('conflict');
    expect(manifest.conflicts).toContain('extra.json');
  });

  it('refuses rollback when the migration manifest is modified', async () => {
    const root = await workspace();
    await mkdir(join(root, '.mosaic'), {recursive: true});
    await writeFile(join(root, '.mosaic', 'config.json'), 'legacy');
    await migrateProjectNamespace(root);
    const path = join(root, '.skein', 'migration-manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    manifest.workspace = '/unexpected';
    await writeFile(path, `${JSON.stringify(manifest)}\n`);
    await expect(rollbackProjectNamespace(root)).rejects.toThrow('does not match');
    expect(await readFile(join(root, '.skein', 'config.json'), 'utf8')).toBe('legacy');
  });

  it('does not activate file or symlink namespace paths in synchronous resolution', async () => {
    const root = await workspace();
    await writeFile(join(root, '.skein'), 'not-a-directory');
    expect(resolveProjectNamespaceSync(root).activeKind).toBe(expectedFreshProjectNamespaceKind());
    expect((await inspectProjectNamespace(root)).status).toBe('conflict');
    await rm(join(root, '.skein'));
    const outside = await workspace();
    await symlink(outside, join(root, '.skein'));
    expect(resolveProjectNamespaceSync(root).activeKind).toBe(expectedFreshProjectNamespaceKind());
    expect((await inspectProjectNamespace(root)).status).toBe('conflict');
  });

  it('blocks symlink entries inside legacy state', async () => {
    const root = await workspace();
    const outside = await workspace();
    await mkdir(join(root, '.mosaic'), {recursive: true});
    await writeFile(join(outside, 'secret.json'), 'outside');
    await symlink(join(outside, 'secret.json'), join(root, '.mosaic', 'redirect.json'));
    const manifest = await inspectProjectNamespace(root);
    expect(manifest.status).toBe('conflict');
    expect(manifest.conflicts).toContain('redirect.json');
    await expect(migrateProjectNamespace(root)).rejects.toThrow('conflicts');
    expect(await readFile(join(outside, 'secret.json'), 'utf8')).toBe('outside');
  });

  it('serializes namespace mutation commands while a shared lease is held', async () => {
    const root = await workspace();
    await mkdir(join(root, '.mosaic'), {recursive: true});
    await writeFile(join(root, '.mosaic', 'config.json'), 'legacy');
    const candidate = join(root, '.skein.migrating-00000000-0000-4000-8000-000000000009');
    await mkdir(candidate);
    await writeFile(join(candidate, 'config.json'), 'legacy');
    const lease = await acquireNamespaceLease(projectNamespacePaths(root).canonical, 'shared');
    try {
      await expect(migrateProjectNamespace(root)).rejects.toThrow('in use by another Skein process');
      await expect(rollbackProjectNamespace(root)).rejects.toThrow('in use by another Skein process');
      await expect(recoverProjectNamespace(root)).rejects.toThrow('in use by another Skein process');
      expect(await readFile(join(candidate, 'config.json'), 'utf8')).toBe('legacy');
    } finally {
      lease.release();
    }
    await recoverProjectNamespace(root);
    await migrateProjectNamespace(root);
    expect(await readFile(join(root, '.skein', 'config.json'), 'utf8')).toBe('legacy');
  });

  it('resumes a complete interrupted migration', async () => {
    const root = await workspace();
    await mkdir(join(root, '.mosaic'), {recursive: true});
    await writeFile(join(root, '.mosaic', 'config.json'), 'legacy');
    await migrateProjectNamespace(root);
    const candidate = join(root, '.skein.migrating-00000000-0000-4000-8000-000000000001');
    await rename(join(root, '.skein'), candidate);
    const preview = await inspectProjectRecovery(root);
    expect(preview.status).toBe('ready');
    expect(preview.candidates).toMatchObject([{kind: 'migration', action: 'resume_migration'}]);
    expect((await recoverProjectNamespace(root)).status).toBe('recovered');
    expect(await readFile(join(root, '.skein', 'config.json'), 'utf8')).toBe('legacy');
    await expect(access(candidate)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('restores a complete interrupted rollback', async () => {
    const root = await workspace();
    await mkdir(join(root, '.mosaic'), {recursive: true});
    await writeFile(join(root, '.mosaic', 'config.json'), 'legacy');
    await migrateProjectNamespace(root);
    const candidate = join(root, '.skein.rollback-00000000-0000-4000-8000-000000000002');
    await rename(join(root, '.skein'), candidate);
    expect((await inspectProjectRecovery(root)).candidates).toMatchObject([
      {kind: 'rollback', action: 'restore_canonical'},
    ]);
    await recoverProjectNamespace(root);
    expect((await inspectProjectRollback(root)).ready).toBe(true);
  });

  it('removes an interrupted partial copy only when it is redundant', async () => {
    const root = await workspace();
    await mkdir(join(root, '.mosaic', 'sessions'), {recursive: true});
    await writeFile(join(root, '.mosaic', 'config.json'), 'legacy');
    await writeFile(join(root, '.mosaic', 'sessions', 'one.json'), 'one');
    const candidate = join(root, '.skein.migrating-00000000-0000-4000-8000-000000000003');
    await mkdir(candidate);
    await writeFile(join(candidate, 'config.json'), 'legacy');
    expect((await inspectProjectRecovery(root)).candidates).toMatchObject([
      {action: 'remove_redundant'},
    ]);
    await recoverProjectNamespace(root);
    await expect(access(candidate)).rejects.toMatchObject({code: 'ENOENT'});
    expect(await readFile(join(root, '.mosaic', 'sessions', 'one.json'), 'utf8')).toBe('one');
  });

  it('blocks changed or ambiguous recovery candidates', async () => {
    const root = await workspace();
    await mkdir(join(root, '.mosaic'), {recursive: true});
    await writeFile(join(root, '.mosaic', 'config.json'), 'legacy');
    const conflicting = join(root, '.skein.migrating-00000000-0000-4000-8000-000000000004');
    await mkdir(conflicting);
    await writeFile(join(conflicting, 'config.json'), 'changed');
    expect((await inspectProjectRecovery(root)).status).toBe('blocked');
    await expect(recoverProjectNamespace(root)).rejects.toThrow('blocked');
    await rm(conflicting, {recursive: true});

    const invalidManifest = join(root, '.skein.migrating-00000000-0000-4000-8000-000000000008');
    await mkdir(invalidManifest);
    await writeFile(join(invalidManifest, 'config.json'), 'legacy');
    await writeFile(join(invalidManifest, 'migration-manifest.json'), '{}');
    expect((await inspectProjectRecovery(root)).status).toBe('blocked');
    await expect(recoverProjectNamespace(root)).rejects.toThrow('could not be verified');
    await rm(invalidManifest, {recursive: true});

    await migrateProjectNamespace(root);
    const first = join(root, '.skein.migrating-00000000-0000-4000-8000-000000000005');
    const second = join(root, '.skein.migrating-00000000-0000-4000-8000-000000000006');
    await rename(join(root, '.skein'), first);
    await cp(first, second, {recursive: true});
    const ambiguous = await inspectProjectRecovery(root);
    expect(ambiguous.status).toBe('blocked');
    expect(ambiguous.candidates.every((candidate) => candidate.action === 'blocked')).toBe(true);
  });

  it('recovers interrupted user-level rollback state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'skein-home-recovery-'));
    const legacy = join(home, 'legacy-home');
    const canonical = join(home, 'canonical-home');
    const environment = {SKEIN_HOME: canonical, MOSAIC_HOME: legacy};
    await mkdir(legacy);
    await writeFile(join(legacy, 'config.json'), 'user');
    await migrateHomeNamespace(environment);
    const candidate = `${canonical}.rollback-00000000-0000-4000-8000-000000000007`;
    await rename(canonical, candidate);
    expect((await inspectHomeRecovery(environment)).candidates).toMatchObject([
      {action: 'restore_canonical'},
    ]);
    await recoverHomeNamespace(environment);
    expect(await readFile(join(canonical, 'config.json'), 'utf8')).toBe('user');
    await rm(home, {recursive: true, force: true});
  });
});
