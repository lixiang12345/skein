import {writeFile} from 'node:fs/promises';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {editComposerDraft, parseEditorCommand} from '../../src/ui/external-editor.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('external editor composer', () => {
  it('parses quoted editor commands without invoking a shell', () => {
    expect(parseEditorCommand('code --wait --reuse-window')).toEqual({
      command: 'code', args: ['--wait', '--reuse-window'],
    });
    expect(parseEditorCommand('"/Applications/My Editor/bin/editor" --wait')).toEqual({
      command: '/Applications/My Editor/bin/editor', args: ['--wait'],
    });
    expect(() => parseEditorCommand('code "unterminated')).toThrow('unterminated');
  });

  it('loads a bounded edited draft through an explicitly resolved executable', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-editor-workspace-'));
    roots.push(workspace);
    const result = await editComposerDraft('Initial', {
      workspace,
      environment: {EDITOR: process.execPath, PATH: process.env.PATH},
      async launch(_command, args) {
        await writeFile(args.at(-1) as string, 'Edited\r\nrequest\u0000', 'utf8');
        return 0;
      },
    });
    expect(result).toBe('Edited\nrequest');
  });

  it('fails clearly without an editor instead of falling back to a shell', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skein-editor-missing-'));
    roots.push(workspace);
    await expect(editComposerDraft('', {workspace, environment: {PATH: process.env.PATH}}))
      .rejects.toThrow('Set VISUAL or EDITOR');
    await expect(editComposerDraft('', {
      workspace,
      environment: {EDITOR: 'sh -c touch /tmp/blocked', PATH: process.env.PATH},
    })).rejects.toThrow('not a command shell');
  });
});
