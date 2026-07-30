/** Public product identity. Storage and legacy environment names stay stable for upgrades. */
export const PRODUCT_NAME = 'Skein';
export const PRODUCT_COMMAND = 'skein';
/** One-cell thread-in-flight mark; unsafe terminals use the ASCII `*` glyph. */
export const PRODUCT_MARK = '⌁';
export const PRODUCT_WEBSITE_URL = 'https://lixiang12345.github.io/skein/';
export const PRODUCT_REPO_URL = 'https://github.com/lixiang12345/skein';
export const PRODUCT_ISSUES_URL = 'https://github.com/lixiang12345/skein/issues';

export function preferredEnv(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}
