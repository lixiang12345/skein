import type {TerminalTheme} from './theme.js';

/**
 * Three-row code-native Skein Goose. Head and beak reuse the compact flight
 * signature (`●▶`); the `⌁┄┄` tow-thread is the same thread-in-flight mark used
 * in the transcript. Wide Unicode terminals only (≥100 columns); narrower
 * frames keep the one-line `__\●▶` flight mark, and ASCII keeps `__\o>`.
 *
 * Every row is exactly `GOOSE_WIDTH` single-width cells so the lockup cannot
 * drift across terminals that pass the Unicode capability check.
 */
export const GOOSE_LINES: readonly string[] = [
  '      ▄█●▶  ',
  '   ▄▄██▛▘   ',
  '⌁┄┄▟████▘   ',
];

export const GOOSE_WIDTH = 12;
export const GOOSE_HEIGHT = GOOSE_LINES.length;

/** Minimum content width before the three-row goose may replace the flight mark. */
export const GOOSE_MIN_WIDTH = 100;

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
 * One color per goose row: accent at the head fading toward dim at the thread,
 * so the animal reads as a single object and never competes with status hues.
 */
export function gooseRowColors(theme: TerminalTheme): string[] {
  const last = Math.max(1, GOOSE_LINES.length - 1);
  return GOOSE_LINES.map((_, index) => mixHex(theme.accent, theme.dim, (index / last) * 0.55));
}

/** @deprecated Prefer `gooseRowColors`; retained for callers still naming the ramp. */
export function logoRowColors(theme: TerminalTheme): string[] {
  return gooseRowColors(theme);
}
