/** Deterministic JSON for content-addressed runtime receipts. */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>()) ?? 'null';
}

function encode(value: unknown, stack: Set<object>): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'bigint') throw new TypeError('Canonical JSON does not support bigint values.');
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value !== 'object') return JSON.stringify(value);
  if (stack.has(value)) throw new TypeError('Canonical JSON does not support cyclic values.');
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => encode(item, stack) ?? 'null').join(',')}]`;
    }
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object).sort().flatMap((key) => {
      const encoded = encode(object[key], stack);
      return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
    });
    return `{${entries.join(',')}}`;
  } finally {
    stack.delete(value);
  }
}
