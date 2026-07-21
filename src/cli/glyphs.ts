import {PRODUCT_MARK} from '../brand.js';

export interface CliGlyphs {
  mode: 'unicode' | 'ascii';
  brand: string;
  meta: string;
  running: string;
  success: string;
  error: string;
  separator: string;
  ellipsis: string;
  prompt: string;
}

const unicodeGlyphs: CliGlyphs = {
  mode: 'unicode',
  brand: PRODUCT_MARK,
  meta: '◇',
  running: '◌',
  success: '✓',
  error: '×',
  separator: '·',
  ellipsis: '…',
  prompt: '›',
};

const asciiGlyphs: CliGlyphs = {
  mode: 'ascii',
  brand: '*',
  meta: '-',
  running: '~',
  success: '+',
  error: 'x',
  separator: '|',
  ellipsis: '...',
  prompt: '>',
};

export function resolveCliGlyphs(environment: NodeJS.ProcessEnv = process.env): CliGlyphs {
  return environment.SKEIN_GLYPHS === 'ascii' || environment.MOSAIC_GLYPHS === 'ascii'
    ? asciiGlyphs
    : unicodeGlyphs;
}
