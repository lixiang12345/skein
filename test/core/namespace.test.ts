import {mkdtemp, mkdir, readFile, writeFile, access, rm, stat, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  inspectProjectNamespace,
  inspectProjectRollback,
  inspectHomeNamespace,
  migrateHomeNamespace,
  migrateProjectNamespace,
  rollbackHomeNamespace,
  rollbackProjectNamespace,
  resolveProjectNamespace,
  resolveProjectNamespaceSync,
  resolveHomeStorageNamespace,
} from '../../src/utils/namespace.js';

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'skein-namespace-'));
}

describe('storage namespace migration', () => {
  it('reports an empty workspace as migration-complete without creating state', async () => {
    const root = await workspace();
    const status = await resolveProjectNamespace(root);
    expect(status.activeKind).toBe('legacy');
    expect(status.conflict).toBe(false);
    await expect(access(join(root, '.mosaic'))).rejects.toMatchObject({code: 'ENOENT'});
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
    expect(resolveProjectNamespaceSync(root).activeKind).toBe('legacy');
    expect((await inspectProjectNamespace(root)).status).toBe('conflict');
    await rm(join(root, '.skein'));
    const outside = await workspace();
    await symlink(outside, join(root, '.skein'));
    expect(resolveProjectNamespaceSync(root).activeKind).toBe('legacy');
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
});
