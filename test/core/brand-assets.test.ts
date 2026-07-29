import {readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import stringWidth from 'string-width';
import {describe, expect, it} from 'vitest';
import {PRODUCT_FLIGHT_MARK, PRODUCT_FLIGHT_MARK_ASCII, PRODUCT_MARK, PRODUCT_NAME} from '../../src/brand.js';
import {resolveGlyphs} from '../../src/ui/components.js';

const root = process.cwd();
const assets = join(root, 'docs', 'assets');

describe('Skein Goose brand assets', () => {
  it('keeps the transcript mark to one cell and the flight mark recognizable', () => {
    expect(PRODUCT_NAME).toBe('Skein');
    expect(PRODUCT_MARK).toBe('⌁');
    expect(stringWidth(PRODUCT_MARK)).toBe(1);
    expect(resolveGlyphs('unicode').brand).toBe(PRODUCT_MARK);
    expect(resolveGlyphs('ascii').brand).toBe('*');
    expect(PRODUCT_FLIGHT_MARK).toBe('__\\●▶');
    expect(PRODUCT_FLIGHT_MARK_ASCII).toBe('__\\o>');
    expect(stringWidth(PRODUCT_FLIGHT_MARK)).toBe(5);
    expect(stringWidth(PRODUCT_FLIGHT_MARK_ASCII)).toBe(5);
  });

  it.each([
    ['skein-goose.svg', ['#17202c', '#16a085']],
    ['skein-goose-dark.svg', ['#f4f7fb', '#6ee7d0']],
    ['skein-goose-mono.svg', ['#000']],
  ] as const)('keeps %s bounded, accessible, and vector-native', async (name, colors) => {
    const source = (await readFile(join(assets, name), 'utf8')).toLocaleLowerCase();
    expect(source).toContain('viewbox="0 0 512 512"');
    expect(source).toContain('<title');
    expect(source).toContain('<desc');
    expect(source).toContain('aria-labelledby=');
    for (const color of colors) expect(source).toContain(color);
    expect(source).not.toMatch(/<(?:text|image|lineargradient|radialgradient|filter|script)\b/u);
  });

  it('ships a bounded 512px transparent RGBA raster master', async () => {
    const path = join(assets, 'skein-goose.png');
    const [png, info] = await Promise.all([readFile(path), stat(path)]);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(512);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
    expect(info.size).toBeGreaterThan(1_000);
    expect(info.size).toBeLessThan(250_000);
  });

  it('ships the user-approved 1024px flight illustration without losing transparency', async () => {
    const path = join(assets, 'skein-goose-flight.png');
    const [png, info] = await Promise.all([readFile(path), stat(path)]);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
    expect(png[25]).toBe(6);
    expect(info.size).toBeGreaterThan(10_000);
    expect(info.size).toBeLessThan(1_000_000);
  });
});
