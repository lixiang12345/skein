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

describe('terminal themes', () => {
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

  it('keeps dark themes vivid, readable, and hierarchically distinct', () => {
    for (const name of ['graphite', 'cinder', 'midnight']) {
      const theme = resolveTheme(name);
      // A deliberately elevated graphite approximates common dark terminal
      // profiles, where subdued tokens are harder to read than on pure black.
      const background = '#292C38';

      expect(contrast(theme.textStrong, background), `${name} strong text`).toBeGreaterThanOrEqual(13);
      expect(contrast(theme.text, background), `${name} body text`).toBeGreaterThanOrEqual(10.5);
      expect(contrast(theme.muted, background), `${name} muted text`).toBeGreaterThanOrEqual(6.5);
      expect(contrast(theme.dim, background), `${name} dim text`).toBeGreaterThanOrEqual(3.75);
      expect(contrast(theme.border, background), `${name} border`).toBeGreaterThanOrEqual(2.25);

      expect(luminance(theme.textStrong), `${name} strong/body hierarchy`).toBeGreaterThan(luminance(theme.text));
      expect(luminance(theme.text), `${name} body/muted hierarchy`).toBeGreaterThan(luminance(theme.muted));
      expect(luminance(theme.muted), `${name} muted/dim hierarchy`).toBeGreaterThan(luminance(theme.dim));
      expect(luminance(theme.dim), `${name} dim/border hierarchy`).toBeGreaterThan(luminance(theme.border));

      for (const token of ['accent', 'success', 'warning', 'error'] as const) {
        expect(contrast(theme[token], background), `${name} ${token} contrast`).toBeGreaterThanOrEqual(5.25);
        expect(saturation(theme[token]), `${name} ${token} saturation`).toBeGreaterThanOrEqual(0.65);
      }

      expect(contrast(theme.selectionText, theme.selection), `${name} selection`).toBeGreaterThanOrEqual(10);
      expect(contrast(theme.success, theme.toolSuccessBackground), `${name} success surface`).toBeGreaterThanOrEqual(7);
      expect(contrast(theme.error, theme.toolErrorBackground), `${name} error surface`).toBeGreaterThanOrEqual(5);
    }
  });
});

function contrast(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const light = Math.max(foregroundLuminance, backgroundLuminance);
  const dark = Math.min(foregroundLuminance, backgroundLuminance);
  return (light + 0.05) / (dark + 0.05);
}

function luminance(color: string): number {
  return rgb(color)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
}

function saturation(color: string): number {
  const channels = rgb(color);
  const maximum = Math.max(...channels);
  const minimum = Math.min(...channels);
  if (maximum === minimum) return 0;
  const lightness = (maximum + minimum) / 2;
  return (maximum - minimum) / (1 - Math.abs(2 * lightness - 1));
}

function rgb(color: string): number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
}
