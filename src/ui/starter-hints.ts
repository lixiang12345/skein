/**
 * Idle composer hints rotated while the composer is empty.
 *
 * Every entry keeps the literal "Type a request" anchor: PTY release gates
 * and screen-reader flows match on it, so rotation may only vary the tail.
 */
export function starterHint(index: number, separator: string): string {
  const hints = [
    `Type a request${separator}@file${separator}/command`,
    `Type a request${separator}/review runs a read-only audit`,
    `Type a request${separator}/status shows runtime detail`,
    `Type a request${separator}ctrl+r searches prompt history`,
  ];
  return hints[((index % hints.length) + hints.length) % hints.length] as string;
}
