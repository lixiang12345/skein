import type {TerminalTheme} from './theme.js';

/**
 * Block-letter SKEIN wordmark. Every row is exactly `LOGO_WIDTH` cells of
 * single-width glyphs, so the mark renders identically across terminals that
 * pass the Unicode capability check; ASCII terminals keep the text wordmark
 * instead of receiving an approximation built from `#` noise.
 */
export const LOGO_LINES: readonly string[] = [
  '███████ ██   ██ ███████ ██ ███    ██',
  '██      ██  ██  ██      ██ ████   ██',
  '███████ █████   █████   ██ ██ ██  ██',
  '     ██ ██  ██  ██      ██ ██  ██ ██',
  '███████ ██   ██ ███████ ██ ██   ████',
];

export const LOGO_WIDTH = 36;
export const LOGO_HEIGHT = LOGO_LINES.length;

/**
 * The emblem side of the lockup: a wound coil of thread — the literal
 * "skein" — with its loose end `⌁┄┄` unspooling toward the wordmark, so the
 * letters and the coil read as one continuous thread rather than a logotype
 * with a mascot beside it. The ring is also the resting form of the winding
 * spinner (`◌◍◎◉`): the same object at rest here and in motion beside live
 * work.
 *
 * Exactly `LOGO_HEIGHT` rows of `EMBLEM_WIDTH` cells, composed to the right
 * of `LOGO_LINES` with one blank column between. The letters carry the
 * vertical colour ramp; the coil and its thread render in the solid accent,
 * so the one live element of the frame is the thread being pulled forward.
 * Wide Unicode terminals only; ASCII mode keeps the text wordmark.
 */
export const EMBLEM_LINES: readonly string[] = [
  '     ▄█████▄    ',
  '   ▄██▀▀▀▀▀██▄  ',
  '   ██▌     ▐██  ',
  '   ▀██▄▄▄▄▄██▀  ',
  '⌁┄┄┄┄▀█████▀    ',
];

export const EMBLEM_WIDTH = 16;

const hexColorPattern = /^#[0-9a-f]{6}$/i;

/** Blend two `#RRGGBB` colors. Non-hex inputs (monochrome mode) return `from` untouched. */
export function mixHex(from: string, to: string, ratio: number): string {
  if (!hexColorPattern.test(from) || !hexColorPattern.test(to)) return from;
  const t = Math.max(0, Math.min(1, ratio));
  const channel = (offset: number): string => {
    const a = Number.parseInt(from.slice(offset, offset + 2), 16);
    const b = Number.parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * t)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/**
 * One color per wordmark row: the accent at the top fading toward the frame's
 * neutral dim tone, so the mark reads as a single object instead of a stripe
 * chart, and never competes with the semantic status colors beside it.
 */
export function logoRowColors(theme: TerminalTheme): string[] {
  const last = Math.max(1, LOGO_LINES.length - 1);
  return LOGO_LINES.map((_, index) => mixHex(theme.accent, theme.dim, (index / last) * 0.62));
}
