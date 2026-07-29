/** Public product identity. Storage and legacy environment names stay stable for upgrades. */
export const PRODUCT_NAME = 'Skein';
export const PRODUCT_COMMAND = 'skein';
/**
 * One-cell thread-in-flight mark for transcript gutters and live chrome.
 * Unsafe terminals use the ASCII `*` glyph via the glyph table.
 */
export const PRODUCT_MARK = '⌁';
/**
 * Compact flight signature for headers and the fresh-session banner. Reads as
 * a goose in motion; the one-cell `PRODUCT_MARK` remains the quiet transcript
 * signer. ASCII terminals use `PRODUCT_FLIGHT_MARK_ASCII`.
 */
export const PRODUCT_FLIGHT_MARK = '__\\●▶';
export const PRODUCT_FLIGHT_MARK_ASCII = '__\\o>';
export const LEGACY_COMMANDS = ['mosaic', 'mosaic-code'] as const;
export const PRODUCT_WEBSITE_URL = 'https://lixiang12345.github.io/skein/';
export const PRODUCT_REPO_URL = 'https://github.com/lixiang12345/skein';
export const PRODUCT_ISSUES_URL = 'https://github.com/lixiang12345/skein/issues';

export function preferredEnv(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}
