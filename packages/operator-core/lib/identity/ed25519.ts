/**
 * ed25519 — shared Ed25519 key helpers used by BOTH identity keypairs:
 * the per-DEVICE identity (attest.ts / sign-with-device-key.ts) and the
 * per-HIVE identity (hive-keypair.ts, shared-hive-federation-2026-06-08 P-002).
 *
 * Convention across the identity layer:
 *   - a PUBLIC key on the wire / in PG is the RAW 32-byte Ed25519 key,
 *     base64-encoded (`pubkeyBase64`).
 *   - a PRIVATE key at rest (in the keychain) is PKCS8 DER.
 * These helpers bridge those byte shapes to node:crypto KeyObjects and back.
 *
 * Extracted from attest.ts (which originally inlined them) so the Hive
 * keypair reuses the EXACT same byte-compatible crypto — same Node Ed25519,
 * same PKCS8/SPKI-DER shapes — rather than re-deriving it and risking drift.
 *
 * Pure: no I/O, no keychain access. Signing/verification take key MATERIAL,
 * not a keychain id (the keychain seam lives in keychain.ts + the per-identity
 * signer modules).
 */

import {
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  createPublicKey,
  createPrivateKey,
  type KeyObject,
} from 'node:crypto';

/**
 * The fixed 12-byte SPKI prefix (DER OID sequence) for an Ed25519 public key:
 *   30 2a 30 05 06 03 2b 65 70 03 21 00
 * A full Ed25519 SPKI DER is this prefix + the raw 32-byte key = 44 bytes.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Reconstruct a node KeyObject private key from stored PKCS8 DER bytes. */
export function privateKeyFromDer(der: Buffer): KeyObject {
  // node:crypto imported at top — a bare require() here throws "require is not
  // defined" under operator-core's ESM (type:module). Use the top-level import.
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/**
 * Reconstruct a 44-byte SPKI DER from a raw 32-byte Ed25519 public key, so it
 * can be loaded as a node KeyObject for verification.
 */
export function buildSpkiDerFromRawPubkey(rawPubkey: Buffer): Buffer {
  if (rawPubkey.length !== 32) {
    throw new Error('expected 32-byte Ed25519 public key, got ' + rawPubkey.length);
  }
  return Buffer.concat([ED25519_SPKI_PREFIX, rawPubkey]);
}

/** Reconstruct a node KeyObject public key from a raw 32-byte Ed25519 key. */
export function publicKeyFromRaw(rawPubkey: Buffer): KeyObject {
  return createPublicKey({ key: buildSpkiDerFromRawPubkey(rawPubkey), format: 'der', type: 'spki' });
}

/** Raw 32-byte Ed25519 pubkey (base64) from a public KeyObject. */
export function rawPubkeyBase64(publicKey: KeyObject): string {
  // SPKI DER for Ed25519 is 44 bytes; the raw 32-byte pubkey is the last 32.
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

/** Raw 32-byte Ed25519 pubkey (base64) derived from a private KeyObject. */
export function pubkeyBase64FromPrivate(privateKey: KeyObject): string {
  return rawPubkeyBase64(createPublicKey(privateKey));
}

/** Raw 32-byte Ed25519 pubkey (base64) derived from stored PKCS8 DER bytes. */
export function pubkeyBase64FromDer(der: Buffer): string {
  return pubkeyBase64FromPrivate(privateKeyFromDer(der));
}

export interface GeneratedKeypairDer {
  /** PKCS8 DER private key — what the keychain stores; never goes on the wire. */
  privateKeyDer: Buffer;
  /** Raw 32-byte Ed25519 public key, base64 — the identity on the wire. */
  pubkeyBase64: string;
}

/** Generate a fresh Ed25519 keypair: PKCS8-DER private + raw-32-byte-b64 public. */
export function generateEd25519KeypairDer(): GeneratedKeypairDer {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privateKeyDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  return { privateKeyDer, pubkeyBase64: rawPubkeyBase64(publicKey) };
}

/**
 * Sign raw bytes with a PKCS8-DER private key. For Ed25519 the algorithm
 * argument MUST be null. Returns the raw 64-byte signature Buffer.
 */
export function signWithPrivateKeyDer(privateKeyDer: Buffer, bytes: Buffer): Buffer {
  return nodeSign(null, bytes, privateKeyFromDer(privateKeyDer));
}

/**
 * Verify a raw Ed25519 signature against a raw-32-byte base64 public key.
 * Never throws — a malformed key/signature returns false.
 */
export function verifyEd25519(
  bytes: Buffer,
  rawPubkeyBase64Str: string,
  signature: Buffer,
): boolean {
  try {
    const publicKey = publicKeyFromRaw(Buffer.from(rawPubkeyBase64Str, 'base64'));
    return nodeVerify(null, bytes, publicKey, signature);
  } catch {
    return false;
  }
}
