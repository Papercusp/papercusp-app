/**
 * Deterministic JSON for hashing.
 *
 * Object members are sorted by key in UTF-16 code-unit order (JavaScript's
 * default string comparison), there is no insignificant whitespace, and strings
 * and finite numbers serialize exactly as `JSON.stringify` writes them. For the
 * value space accepted here that is the RFC 8785 (JCS) serialization, so an
 * independent verifier in another language can reproduce every digest.
 *
 * Anything JSON cannot round-trip is REFUSED rather than silently coerced,
 * because a coercion is a second byte-sequence for the same logical entry:
 * non-finite numbers, bigint, functions, symbols, and `undefined` array slots
 * all throw. `undefined` object members are dropped (they do not exist in JSON),
 * and `toJSON` is never consulted — a Date must be converted by the caller.
 */
export class CanonicalJsonError extends Error {
  override readonly name = 'CanonicalJsonError';
}

export function canonicalJson(value: unknown): string {
  return encode(value, '$');
}

function encode(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`${path}: non-finite number ${String(value)}`);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`${path}: ${typeof value} is not representable in canonical JSON`);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const item: unknown = value[i];
      if (item === undefined) throw new CanonicalJsonError(`${path}[${i}]: undefined array element`);
      parts.push(encode(item, `${path}[${i}]`));
    }
    return `[${parts.join(',')}]`;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalJsonError(`${path}: only plain objects are representable (got ${describe(value)})`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const member = record[key];
    if (member === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${encode(member, `${path}.${key}`)}`);
  }
  return `{${parts.join(',')}}`;
}

function describe(value: object): string {
  const ctor = (value as { constructor?: { name?: string } }).constructor;
  return ctor?.name ? ctor.name : 'object';
}
