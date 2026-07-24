import {access, mkdtemp, readFile, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {CheckpointStore} from '../../src/checkpoint/store.js';
import {SessionStore} from '../../src/session/store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('sessions and checkpoints', () => {
  it('keeps empty list operations side-effect free', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-storage-read-'));
    roots.push(root);
    await expect(new SessionStore(root).list()).resolves.toEqual([]);
    await expect(new CheckpointStore(root).list('session-1')).resolves.toEqual([]);
    await expect(access(join(root, '.skein'))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('persists and resumes an auditable session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-session-'));
    roots.push(root);
    const store = new SessionStore(root);
    const session = await store.create({title: 'Fix queue', model: 'test', provider: 'compatible'});
    session.messages.push({
      id: 'message-1', role: 'user', content: 'Fix it', createdAt: new Date().toISOString(),
    });
    await store.save(session);
    const loaded = await store.load(session.id);
    expect(loaded.messages).toHaveLength(1);
    expect((await store.list())[0]?.title).toBe('Fix queue');
  });

  it('restores file bytes without touching the project Git history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-checkpoint-'));
    roots.push(root);
    const path = join(root, 'settings.json');
    await writeFile(path, '{"safe":true}\n');
    const store = new CheckpointStore(root);
    const manifest = await store.capture('session-1', [path], {reason: 'before test write'});
    expect(manifest?.entries).toHaveLength(1);
    await writeFile(path, '{"safe":false}\n');
    await store.restore('session-1', manifest?.id ?? '');
    expect(await readFile(path, 'utf8')).toBe('{"safe":true}\n');
  });

  it('prevents a repository symlink from redirecting Mosaic storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-storage-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-storage-outside-'));
    roots.push(root, outside);
    await symlink(outside, join(root, '.skein'));
    await expect(new SessionStore(root).list()).rejects.toThrow('symbolic link');
    await expect(new CheckpointStore(root).capture('session-1', [join(root, 'file.txt')]))
      .rejects.toThrow('symbolic link');
  });

  it('preflights all checkpoint blobs before restoring any file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-checkpoint-preflight-'));
    roots.push(root);
    const first = join(root, 'first.txt');
    const second = join(root, 'second.txt');
    await writeFile(first, 'first before\n');
    await writeFile(second, 'second before\n');
    const store = new CheckpointStore(root);
    const manifest = await store.capture('session-1', [first, second]);
    const secondEntry = manifest?.entries[1];
    await writeFile(first, 'first changed\n');
    await writeFile(second, 'second changed\n');
    await unlink(join(root, '.skein', 'checkpoints', 'session-1', manifest?.id ?? '', 'blobs', secondEntry?.blob ?? ''));
    await expect(store.restore('session-1', manifest?.id ?? '')).rejects.toThrow('blob');
    expect(await readFile(first, 'utf8')).toBe('first changed\n');
    expect(await readFile(second, 'utf8')).toBe('second changed\n');
  });

  it('rejects symlinked checkpoint subdirectories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-checkpoint-symlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-checkpoint-symlink-outside-'));
    roots.push(root, outside);
    const file = join(root, 'file.txt');
    await writeFile(file, 'before\n');
    const store = new CheckpointStore(root);
    await store.capture('session-1', [file]);
    await symlink(outside, join(root, '.skein', 'checkpoints', 'session-1', 'redirect'));
    await expect(store.load('session-1', 'redirect')).rejects.toThrow('symbolic link');
  });

  it('does not follow a symlinked session backup during save', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-session-backup-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'mosaic-session-backup-outside-'));
    roots.push(root, outside);
    const victim = join(outside, 'victim.txt');
    await writeFile(victim, 'unchanged\n');
    const store = new SessionStore(root);
    const session = await store.create({
      id: 'session-1', title: 'Before', model: 'test', provider: 'compatible',
    });
    await symlink(victim, join(root, '.skein', 'sessions', 'session-1.bak'));
    session.title = 'After';
    await expect(store.save(session)).rejects.toThrow('symbolic link');
    expect(await readFile(victim, 'utf8')).toBe('unchanged\n');
  });

  it('rejects a stored session whose identity does not match its file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mosaic-session-identity-'));
    roots.push(root);
    const store = new SessionStore(root);
    await store.create({
      id: 'session-1', title: 'Original', model: 'test', provider: 'compatible',
    });
    const path = join(root, '.skein', 'sessions', 'session-1.json');
    const stored = JSON.parse(await readFile(path, 'utf8')) as {id: string};
    stored.id = 'different-session';
    await writeFile(path, `${JSON.stringify(stored)}\n`);
    await expect(store.load('session-1')).rejects.toThrow('not found or unreadable');
  });
});
