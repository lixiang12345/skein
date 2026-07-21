/** Public product identity. Storage and legacy environment names stay stable for upgrades. */
export const PRODUCT_NAME = 'Skein';
export const PRODUCT_COMMAND = 'skein';
export const PRODUCT_MARK = '◆';
export const LEGACY_COMMANDS = ['mosaic', 'mosaic-code'] as const;

export function preferredEnv(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}
