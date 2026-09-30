/**
 * High-entropy ID + secret generation. Uses Web Crypto in both Node 18+ and
 * Workers; no Node-only fallback required.
 */

import { b64uEncode } from './base64url';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function randomBase32(chars: number): string {
  const bytes = randomBytes(chars);
  let out = '';
  for (let i = 0; i < chars; i++) out += BASE32_ALPHABET[bytes[i]! & 0x1f];
  return out;
}

export function randomBase64url(byteLen = 16): string {
  return b64uEncode(randomBytes(byteLen));
}

export function tenantId(): string {
  return 'tnt_' + randomBase32(10);
}

export function deploymentId(): string {
  return 'dep_' + randomBase32(8);
}

export function snapshotId(): string {
  return 'snap_' + randomBase32(12);
}

export function tenantSecret(): string {
  return randomBase64url(32);
}

export function jti(): string {
  return randomBase64url(16);
}
