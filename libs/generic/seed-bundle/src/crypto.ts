/**
 * @papercusp/seed-bundle — payload encryption at rest.
 *
 * A seed of a PRIVATE store (e.g. the dogfood git repo) must ship in the
 * installer as CIPHERTEXT, with the key delivered only by the live join /
 * admission (never in the installer). This module is the symmetric seal/open
 * primitive; the manifest's {@link import('./manifest').SeedEncryptionEnvelope}
 * records the scheme + how the key is obtained (`SeedKeyRef`), and the host
 * resolves the key post-admission before restore.
 *
 * Cipher: ChaCha20-Poly1305 (AEAD) from Node's built-in `crypto` — a 256-bit
 * key + a random 96-bit nonce per sealed blob + a 128-bit auth tag. Each blob
 * gets a fresh random nonce, so nonce-reuse is a non-issue at our scale (a
 * handful of per-release seed blobs under a per-release key). Sealed layout:
 *
 *     nonce(12) ‖ tag(16) ‖ ciphertext
 *
 * Zero third-party deps (Node builtin only), so this stays in the generic lib.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

export const SEED_CIPHER = 'chacha20-poly1305';
export const SEED_KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;

export class SeedCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedCryptoError';
  }
}

/** A fresh random 256-bit seed key. The host wraps this to each admitted member. */
export function generateSeedKey(): Buffer {
  return randomBytes(SEED_KEY_LEN);
}

function asKey(key: Uint8Array): Buffer {
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(key);
  if (buf.length !== SEED_KEY_LEN) {
    throw new SeedCryptoError(`seed key must be ${SEED_KEY_LEN} bytes (got ${buf.length})`);
  }
  return buf;
}

/** AEAD-seal a plaintext blob: returns `nonce ‖ tag ‖ ciphertext`. */
export function sealBytes(key: Uint8Array, plaintext: Uint8Array): Buffer {
  const k = asKey(key);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(SEED_CIPHER, k, nonce, { authTagLength: TAG_LEN });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ciphertext]);
}

/** Open a `nonce ‖ tag ‖ ciphertext` blob. Throws {@link SeedCryptoError} on a
 *  wrong key, a truncated blob, or tampering (the auth tag fails). */
export function openBytes(key: Uint8Array, sealed: Uint8Array): Buffer {
  const k = asKey(key);
  const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed);
  if (buf.length < NONCE_LEN + TAG_LEN) {
    throw new SeedCryptoError(`sealed blob too short (${buf.length} < ${NONCE_LEN + TAG_LEN})`);
  }
  const nonce = buf.subarray(0, NONCE_LEN);
  const tag = buf.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
  const ciphertext = buf.subarray(NONCE_LEN + TAG_LEN);
  const decipher = createDecipheriv(SEED_CIPHER, k, nonce, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new SeedCryptoError('seed decrypt failed — wrong key or tampered payload');
  }
}

/** Constant-time key comparison (for tests / key-management assertions). */
export function keysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
