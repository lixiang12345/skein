import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {buildWritePreview, permissionPreviewRows} from '../../src/ui/permission-preview.js';
import type {ToolCall} from '../../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skein-permission-preview-'));
  roots.push(root);
  return root;
}

function call(name: string, arguments_: Record<string, unknown>): ToolCall {
  return {id: 'call-1', name, arguments: arguments_};
}

describe('buildWritePreview', () => {
  it('diffs write_file against the current file content', async () => {
    const root = await workspace();
    await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\n');
    const preview = await buildWritePreview(
      call('write_file', {path: 'a.txt', content: 'one\nTWO\nthree\n'}),
      async (path) => join(root, path),
    );
    expect(preview?.lines).toContain('-two');
    expect(preview?.lines).toContain('+TWO');
  });

  it('shows pure additions for a new file and bounds long previews', async () => {
    const root = await workspace();
    const content = Array.from({length: 40}, (_, index) => `line ${index}`).join('\n');
    const preview = await buildWritePreview(
      call('write_file', {path: 'new.txt', content}),
      async (path) => join(root, path),
    );
    expect(preview?.lines.length).toBe(10);
    expect(preview?.more).toBeGreaterThan(0);
    expect(preview?.lines.some((line) => line.startsWith('+line'))).toBe(true);
  });

  it('degrades for binary current files instead of dumping bytes', async () => {
    const root = await workspace();
    await writeFile(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    const preview = await buildWritePreview(
      call('write_file', {path: 'bin.dat', content: 'text'}),
      async (path) => join(root, path),
    );
    expect(preview?.lines[0]).toContain('binary');
  });

  it('previews apply_patch bodies without Begin/End markers', async () => {
    const patch = ['*** Begin Patch', '*** Update File: a.ts', '@@', '-old', '+new', '*** End Patch'].join('\n');
    const preview = await buildWritePreview(
      call('apply_patch', {patch}),
      async (path) => path,
    );
    expect(preview?.lines).toEqual(['*** Update File: a.ts', '@@', '-old', '+new']);
  });

  it('returns undefined for non-write tools and malformed arguments', async () => {
    expect(await buildWritePreview(call('shell', {command: 'ls'}), async (p) => p)).toBeUndefined();
    expect(await buildWritePreview(call('write_file', {path: 42}), async (p) => p)).toBeUndefined();
  });
});

describe('permissionPreviewRows', () => {
  it('hides the preview in compact or narrow layouts', () => {
    const preview = {lines: ['+a', '-b'], more: 3};
    expect(permissionPreviewRows(preview, 80, false)).toBe(3);
    expect(permissionPreviewRows({lines: ['+a'], more: 0}, 80, false)).toBe(1);
    expect(permissionPreviewRows(preview, 80, true)).toBe(0);
    expect(permissionPreviewRows(preview, 40, false)).toBe(0);
    expect(permissionPreviewRows(undefined, 80, false)).toBe(0);
  });
});
