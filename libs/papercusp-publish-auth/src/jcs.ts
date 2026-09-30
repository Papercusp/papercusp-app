/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Produces a deterministic byte-for-byte serialization of any JSON value.
 * Required for cross-runtime hash agreement: Worker (V8 isolates) and Node
 * (V8 with different stringify path) must produce identical bytes for the
 * canonical-manifest sha256 to match the JWT's `sha256` claim.
 *
 * Rules implemented:
 *   - Object keys sorted by UTF-16 code unit order (ECMA-262 codePointAt).
 *   - No insignificant whitespace.
 *   - Numbers in shortest round-trip form (ECMAScript `Number.prototype.toString`
 *     happens to match RFC 7159 / ES2019 Number serialization for finite numbers;
 *     non-finite values rejected).
 *   - Strings escaped per RFC 8259 §7 minimal escape set.
 */

export class JcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JcsError';
  }
}

export function canonicalize(value: unknown): string {
  return serialize(value);
}

export function canonicalizeBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';

  const t = typeof value;
  if (t === 'number') return serializeNumber(value as number);
  if (t === 'string') return serializeString(value as string);
  if (t === 'bigint')
    throw new JcsError('bigint is not representable in canonical JSON');

  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ',';
      out += serialize(value[i]);
    }
    return out + ']';
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    keys.sort(compareUtf16);
    let out = '{';
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out += ',';
      const k = keys[i]!;
      out += serializeString(k) + ':' + serialize(obj[k]);
    }
    return out + '}';
  }

  throw new JcsError(`unsupported value of type ${t}`);
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) throw new JcsError('non-finite number');
  if (Object.is(n, -0)) return '0';
  return String(n);
}

function compareUtf16(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca - cb;
  }
  return a.length - b.length;
}

function serializeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0d) out += '\\r';
    else if (c < 0x20)
      out += '\\u' + c.toString(16).padStart(4, '0');
    else out += s[i];
  }
  return out + '"';
}
