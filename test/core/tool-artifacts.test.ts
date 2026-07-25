import {mkdtemp, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {ToolArtifactStore} from '../../src/session/tool-artifacts.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('ToolArtifactStore', () => {
  it('keeps output bound to the originating session and pages it by lines', async () => {
    const root = await workspace('skein-tool-artifact-page-');
    const store = new ToolArtifactStore(root);
    const archived = await store.archive('session-1', 'call-1', 'first\nsecond\nthird\n', {redacted: false});

    expect(archived).toMatchObject({stored: true, artifact: {toolCallId: 'call-1', bytes: 19}});
    const page = await store.read('session-1', 'call-1', {startLine: 2, maxLines: 1});
    expect(page).toMatchObject({content: 'second', startLine: 2, endLine: 2, totalLines: 4, hasMore: true, nextStartLine: 3});
    await expect(store.read('session-2', 'call-1')).rejects.toThrow('No retained tool output');
    expect(await readdir(join(root, '.skein', 'tool-artifacts'))).toHaveLength(1);
  });

  it('evicts the oldest retained output before exceeding the total storage limit', async () => {
    const root = await workspace('skein-tool-artifact-cap-');
    const store = new ToolArtifactStore(root, {maxArtifactBytes: 256, maxTotalBytes: 1_024});
    await store.archive('session-1', 'call-1', 'a'.repeat(200), {redacted: false});
    await store.archive('session-1', 'call-2', 'b'.repeat(200), {redacted: false});
    await store.archive('session-1', 'call-3', 'c'.repeat(200), {redacted: false});

    await expect(store.read('session-1', 'call-1')).rejects.toThrow('No retained tool output');
    await expect(store.read('session-1', 'call-2')).resolves.toMatchObject({content: 'b'.repeat(200)});
    await expect(store.read('session-1', 'call-3')).resolves.toMatchObject({content: 'c'.repeat(200)});
  });

  it('expires retained output and removes it before it can be returned', async () => {
    const root = await workspace('skein-tool-artifact-expiry-');
    let clock = new Date('2026-07-25T00:00:00.000Z');
    const store = new ToolArtifactStore(root, {
      now: () => clock,
      retentionMs: 1_000,
    });
    await store.archive('session-1', 'call-1', 'ephemeral', {redacted: false});
    clock = new Date('2026-07-25T00:00:02.000Z');

    await expect(store.read('session-1', 'call-1')).rejects.toThrow('expired');
  });

  it('prunes expired output and returns only valid receipts for the requested session', async () => {
    const root = await workspace('skein-tool-artifact-prune-');
    let clock = new Date('2026-07-25T00:00:00.000Z');
    const store = new ToolArtifactStore(root, {now: () => clock, retentionMs: 1_000});
    await store.archive('session-1', 'expired', 'old', {redacted: false});
    clock = new Date('2026-07-25T00:00:02.000Z');
    await store.archive('session-1', 'active', 'current', {redacted: true});
    await store.archive('session-2', 'other', 'private', {redacted: false});

    await expect(store.prune('session-1')).resolves.toMatchObject([
      {toolCallId: 'active', bytes: 7, redacted: true},
    ]);
    await expect(store.read('session-1', 'expired')).rejects.toThrow('No retained tool output');
    await expect(store.read('session-2', 'other')).resolves.toMatchObject({content: 'private'});
  });

  it('deletes retained output for one session without affecting another', async () => {
    const root = await workspace('skein-tool-artifact-remove-session-');
    const store = new ToolArtifactStore(root);
    await store.archive('session-1', 'call-1', 'first', {redacted: false});
    await store.archive('session-2', 'call-2', 'second', {redacted: false});

    await store.removeSession('session-1');

    await expect(store.read('session-1', 'call-1')).rejects.toThrow('No retained tool output');
    await expect(store.read('session-2', 'call-2')).resolves.toMatchObject({content: 'second'});
    await expect(store.removeSession('session-1')).resolves.toBeUndefined();
  });

  it('switches a giant single line to an exact UTF-8 byte continuation', async () => {
    const root = await workspace('skein-tool-artifact-byte-page-');
    const store = new ToolArtifactStore(root);
    await store.archive('session-1', 'call-1', `HEAD${'中'.repeat(4_000)}TAIL`, {redacted: false});

    const first = await store.read('session-1', 'call-1', {maxBytes: 768});
    expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(768);
    expect(first.content).toContain('HEAD');
    expect(first).toMatchObject({hasMore: true, nextStartByte: first.endByte});
    if (first.nextStartByte === undefined) throw new Error('Expected a byte continuation.');
    const second = await store.read('session-1', 'call-1', {startByte: first.nextStartByte, maxBytes: 768});
    expect(second.startByte).toBe(first.endByte);
    expect(Buffer.byteLength(second.content)).toBeLessThanOrEqual(768);
    expect(second.content).not.toContain('\uFFFD');
    await expect(store.read('session-1', 'call-1', {startByte: 5, maxBytes: 768}))
      .rejects.toThrow('exact UTF-8 boundary');
  });

  it('rejects namespace and artifact symlinks instead of following them', async () => {
    const root = await workspace('skein-tool-artifact-symlink-');
    const outside = await workspace('skein-tool-artifact-outside-');
    await symlink(outside, join(root, '.skein'));
    await expect(new ToolArtifactStore(root).archive('session-1', 'call-1', 'blocked', {redacted: false}))
      .rejects.toThrow('symbolic link');

    const clean = await workspace('skein-tool-artifact-file-symlink-');
    const store = new ToolArtifactStore(clean);
    await store.archive('session-1', 'call-1', 'safe', {redacted: false});
    const artifactPath = await onlyArtifactPath(clean);
    await rm(artifactPath);
    await symlink(join(outside, 'missing.json'), artifactPath);
    await expect(store.read('session-1', 'call-1')).rejects.toThrow('symbolic link');
  });

  it('rejects corrupted retained output before exposing it', async () => {
    const root = await workspace('skein-tool-artifact-corrupt-');
    const store = new ToolArtifactStore(root);
    await store.archive('session-1', 'call-1', 'trusted', {redacted: false});
    await writeFile(await onlyArtifactPath(root), '{"version":1}\n');

    await expect(store.read('session-1', 'call-1')).rejects.toThrow('unreadable or corrupt');
  });

  it('rejects control characters in model-supplied tool call ids', async () => {
    const root = await workspace('skein-tool-artifact-id-');
    await expect(new ToolArtifactStore(root).archive('session-1', 'call-1\nforged: true', 'data', {redacted: false}))
      .rejects.toThrow('control characters');
  });
});

async function workspace(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function onlyArtifactPath(root: string): Promise<string> {
  const directory = join(root, '.skein', 'tool-artifacts');
  const [sessionDirectory] = await readdir(directory);
  if (!sessionDirectory) throw new Error('Expected a session artifact directory.');
  const [artifact] = await readdir(join(directory, sessionDirectory));
  if (!artifact) throw new Error('Expected a retained artifact.');
  return join(directory, sessionDirectory, artifact);
}
