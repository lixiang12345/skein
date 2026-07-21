import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {reloadUserThemes, resolveTheme} from '../../src/ui/theme.js';

const directories: string[] = [];

afterEach(async () => {
  await reloadUserThemes(join(tmpdir(), 'skein-no-user-themes'));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {recursive: true, force: true})));
});

describe('user terminal themes', () => {
  it('loads a data-only user palette while rejecting invalid colors and built-in overrides', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'skein-themes-'));
    directories.push(directory);
    await writeFile(join(directory, 'studio.json'), JSON.stringify({
      name: 'studio',
      accent: '#21A6D8',
      text: '#E5E7EB',
      success: '#38B26D',
    }));
    await writeFile(join(directory, 'bad.json'), JSON.stringify({name: 'bad', accent: 'red'}));
    await writeFile(join(directory, 'graphite.json'), JSON.stringify({name: 'graphite', accent: '#111111'}));

    const result = await reloadUserThemes(directory);

    expect(result.loaded).toEqual(['studio']);
    expect(result.errors).toHaveLength(2);
    expect(resolveTheme('studio')).toMatchObject({name: 'studio', accent: '#21A6D8', text: '#E5E7EB'});
    expect(resolveTheme('graphite').accent).not.toBe('#111111');
  });
});
