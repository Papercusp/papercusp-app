/**
 * FNV-1a 64-bit, computed over four 16-bit limbs.
 *
 * Why this exists: the obvious implementation keeps the running hash in a
 * `BigInt` and performs a BigInt XOR + multiply + mask for EVERY input unit.
 * Each of those allocates, so hashing a large canonical string (a response
 * body, the projected tool registry) costs heap allocations per character.
 * On the operator main thread that showed up as the hottest JS function in
 * event-loop-saturation profiles (WI-10003260).
 *
 * This version is bit-exact with the BigInt reference: it produces the same
 * 64-bit value, so every revision / fingerprint / cursor string derived from
 * it is unchanged. Only the final formatting touches BigInt, once per hash.
 *
 * Arithmetic: prime = 2^40 + 0x1b3. With h = h3·2^48 + h2·2^32 + h1·2^16 + h0,
 *   h·prime mod 2^64 = h·0x1b3 + (h1·2^16 + h0)·2^40   (mod 2^64)
 * so the 2^40 term adds h0·2^8 to limb 2 and h1·2^8 to limb 3. Every
 * intermediate stays below 2^27, i.e. inside V8's small-integer range, which
 * is what makes the loop allocation-free and fast.
 */

const PRIME_LO = 0x1b3;

function toBigInt(h3: number, h2: number, h1: number, h0: number): bigint {
  const hi = ((h3 << 16) | h2) >>> 0;
  const lo = ((h1 << 16) | h0) >>> 0;
  return (BigInt(hi) << 32n) | BigInt(lo);
}

/**
 * FNV-1a 64 over a string's UTF-16 CODE UNITS (`charCodeAt`), as the delta
 * protocol has always hashed. Returns the value in base 36.
 */
export function fnv1a64CodeUnitsBase36(str: string): string {
  // Offset basis 0xcbf29ce484222325 split into 16-bit limbs.
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (let i = 0; i < str.length; i++) {
    h0 ^= str.charCodeAt(i); // a code unit is < 2^16, so it only touches limb 0
    const t0 = h0 * PRIME_LO;
    let t1 = h1 * PRIME_LO;
    let t2 = h2 * PRIME_LO + (h0 << 8);
    const t3 = h3 * PRIME_LO + (h1 << 8);
    t1 += t0 >>> 16;
    h0 = t0 & 0xffff;
    t2 += t1 >>> 16;
    h1 = t1 & 0xffff;
    h3 = (t3 + (t2 >>> 16)) & 0xffff;
    h2 = t2 & 0xffff;
  }
  return toBigInt(h3, h2, h1, h0).toString(36);
}

/**
 * FNV-1a 64 over BYTES (e.g. the UTF-8 encoding of a string). Returns the
 * value as 16 zero-padded lowercase hex digits.
 */
export function fnv1a64BytesHex(bytes: Uint8Array): string {
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (let i = 0; i < bytes.length; i++) {
    h0 ^= bytes[i]!;
    const t0 = h0 * PRIME_LO;
    let t1 = h1 * PRIME_LO;
    let t2 = h2 * PRIME_LO + (h0 << 8);
    const t3 = h3 * PRIME_LO + (h1 << 8);
    t1 += t0 >>> 16;
    h0 = t0 & 0xffff;
    t2 += t1 >>> 16;
    h1 = t1 & 0xffff;
    h3 = (t3 + (t2 >>> 16)) & 0xffff;
    h2 = t2 & 0xffff;
  }
  return toBigInt(h3, h2, h1, h0).toString(16).padStart(16, '0');
}
