import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {reservedCommandNames} from '../../src/ui/commands.js';
import {discoverCustomCommands, expandCustomCommand} from '../../src/ui/custom-commands.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

async function workspaceWithCommands(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skein-custom-commands-'));
  roots.push(root);
  const dir = join(root, '.agents', 'commands');
  await mkdir(dir, {recursive: true});
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(dir, name), content, 'utf8')));
  return root;
}

describe('custom command discovery', () => {
  it('returns an empty list when the directory does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skein-custom-none-'));
    roots.push(root);
    expect(await discoverCustomCommands(root, reservedCommandNames)).toEqual([]);
  });

  it('loads valid templates with descriptions from the first heading or line', async () => {
    const root = await workspaceWithCommands({
      'ship.md': '# Ship checklist\n\nRun the release checks for $ARGUMENTS.',
      'triage.md': 'Triage the open bug reports.\nSecond line ignored.',
    });
    const commands = await discoverCustomCommands(root, reservedCommandNames);
    expect(commands.map((command) => command.name)).toEqual(['ship', 'triage']);
    expect(commands[0]?.description).toBe('Ship checklist');
    expect(commands[1]?.description).toBe('Triage the open bug reports.');
    expect(commands[0]?.path).toBe(join('.agents', 'commands', 'ship.md'));
  });

  it('never lets a workspace template shadow a built-in command or alias', async () => {
    const root = await workspaceWithCommands({
      'help.md': 'malicious help override',
      'quit.md': 'alias shadow attempt',
      'model.md': 'built-in shadow attempt',
      'safe.md': 'A safe command.',
    });
    const commands = await discoverCustomCommands(root, reservedCommandNames);
    expect(commands.map((command) => command.name)).toEqual(['safe']);
  });

  it('skips invalid names, empty bodies, and oversized files while lowercasing stems', async () => {
    const root = await workspaceWithCommands({
      'Bad Name.md': 'space in name',
      'UPPER.md': 'uppercase filename normalizes to /upper',
      'empty.md': '   \n  ',
      'big.md': `# big\n${'x'.repeat(11_000)}`,
      'ok.md': 'Fine.',
    });
    const commands = await discoverCustomCommands(root, reservedCommandNames);
    expect(commands.map((command) => command.name)).toEqual(['upper', 'ok']);
  });
});

describe('custom command expansion', () => {
  const command = {name: 'ship', description: '', path: 'p', content: 'Check $ARGUMENTS twice, then ship $ARGUMENTS.'};

  it('substitutes every $ARGUMENTS occurrence', () => {
    expect(expandCustomCommand(command, ' v1.2 ')).toBe('Check v1.2 twice, then ship v1.2.');
  });

  it('substitutes an empty string when no arguments are given', () => {
    expect(expandCustomCommand(command, '')).toBe('Check  twice, then ship .');
  });

  it('appends arguments when the template has no placeholder', () => {
    const plain = {...command, content: 'Review the diff.'};
    expect(expandCustomCommand(plain, 'focus on tests')).toBe('Review the diff.\n\nfocus on tests');
    expect(expandCustomCommand(plain, '')).toBe('Review the diff.');
  });
});
