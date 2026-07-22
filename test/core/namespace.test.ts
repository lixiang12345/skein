import {mkdtemp, mkdir, readFile, writeFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  inspectProjectNamespace,
  migrateProjectNamespace,
  resolveProjectNamespace,
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
    expect(await readFile(join(root, '.skein', 'sessions', 'one.json'), 'utf8')).toBe('{"id":"one"}\n');
    expect(await readFile(join(root, '.skein', 'migration-manifest.json'), 'utf8')).toContain('"status": "complete"');
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
});
