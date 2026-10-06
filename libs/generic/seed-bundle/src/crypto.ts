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

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const SEED_CIPHER = 'chacha20-poly1305';
export const SEED_KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const SEALED_HEADER_LEN = NONCE_LEN + TAG_LEN;
const FILE_CHUNK_LEN = 8 * 1024 * 1024;

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

async function writeAll(
  handle: FileHandle,
  value: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < value.length) {
    const { bytesWritten } = await handle.write(
      value,
      offset,
      value.length - offset,
      position + offset,
    );
    if (bytesWritten <= 0)
      throw new SeedCryptoError("seed file write made no progress");
    offset += bytesWritten;
  }
}

async function readExact(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const value = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(
      value,
      offset,
      length - offset,
      position + offset,
    );
    if (bytesRead <= 0) {
      throw new SeedCryptoError(
        `sealed blob too short (${position + offset} < ${position + length})`,
      );
    }
    offset += bytesRead;
  }
  return value;
}

/**
 * Transform one file into another without exposing a partial destination.
 *
 * The temporary file lives beside the destination so the final rename is
 * atomic. Both handles are closed before publication, which also permits an
 * in-place transform on Windows. A failed transform removes only its private
 * temporary file and leaves any prior destination untouched.
 */
async function transformFileAtomically(
  sourcePath: string,
  destinationPath: string,
  transform: (source: FileHandle, destination: FileHandle) => Promise<void>,
): Promise<void> {
  const tempPath = join(
    dirname(destinationPath),
    `.${basename(destinationPath)}.partial-${process.pid}-${randomUUID()}`,
  );
  let source: FileHandle | undefined;
  let destination: FileHandle | undefined;
  let published = false;
  try {
    source = await open(sourcePath, "r");
    destination = await open(tempPath, "wx", 0o600);
    await transform(source, destination);
    await destination.sync();
    await destination.close();
    destination = undefined;
    await source.close();
    source = undefined;
    await rename(tempPath, destinationPath);
    published = true;
  } finally {
    await destination?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
    if (!published) await rm(tempPath, { force: true }).catch(() => undefined);
  }
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

/**
 * AEAD-seal a file with bounded memory and publish it atomically.
 *
 * The output is byte-format compatible with {@link sealBytes}:
 * `nonce(12) ‖ tag(16) ‖ ciphertext`. `plaintextPath === sealedPath` is
 * supported, which lets a producer replace a generated plaintext artifact only
 * after the complete ciphertext and authentication tag are durable.
 */
export async function sealFile(
  key: Uint8Array,
  plaintextPath: string,
  sealedPath: string,
): Promise<void> {
  const k = asKey(key);
  await transformFileAtomically(plaintextPath, sealedPath, async (source, destination) => {
    const nonce = randomBytes(NONCE_LEN);
    const cipher = createCipheriv(SEED_CIPHER, k, nonce, { authTagLength: TAG_LEN });
    await writeAll(destination, Buffer.concat([nonce, Buffer.alloc(TAG_LEN)]), 0);

    const chunk = Buffer.allocUnsafe(FILE_CHUNK_LEN);
    let readPosition = 0;
    let writePosition = SEALED_HEADER_LEN;
    for (;;) {
      const { bytesRead } = await source.read(chunk, 0, chunk.length, readPosition);
      if (bytesRead === 0) break;
      readPosition += bytesRead;
      const ciphertext = cipher.update(chunk.subarray(0, bytesRead));
      await writeAll(destination, ciphertext, writePosition);
      writePosition += ciphertext.length;
    }
    const finalCiphertext = cipher.final();
    await writeAll(destination, finalCiphertext, writePosition);
    await writeAll(destination, cipher.getAuthTag(), NONCE_LEN);
  });
}

/**
 * Authenticate and open a sealed file with bounded memory.
 *
 * Decrypted bytes are written only to a private sibling temporary file. The
 * requested destination is atomically published after `decipher.final()` has
 * authenticated the entire ciphertext; wrong-key, truncation, and tampering
 * failures therefore cannot expose a partial destination.
 */
export async function openFile(
  key: Uint8Array,
  sealedPath: string,
  plaintextPath: string,
): Promise<void> {
  const k = asKey(key);
  await transformFileAtomically(sealedPath, plaintextPath, async (source, destination) => {
    const { size } = await source.stat();
    if (size < SEALED_HEADER_LEN) {
      throw new SeedCryptoError(`sealed blob too short (${size} < ${SEALED_HEADER_LEN})`);
    }
    const header = await readExact(source, SEALED_HEADER_LEN, 0);
    const nonce = header.subarray(0, NONCE_LEN);
    const tag = header.subarray(NONCE_LEN);
    const decipher = createDecipheriv(SEED_CIPHER, k, nonce, { authTagLength: TAG_LEN });
    decipher.setAuthTag(tag);

    const chunk = Buffer.allocUnsafe(FILE_CHUNK_LEN);
    let readPosition = SEALED_HEADER_LEN;
    let writePosition = 0;
    while (readPosition < size) {
      const length = Math.min(chunk.length, size - readPosition);
      const { bytesRead } = await source.read(chunk, 0, length, readPosition);
      if (bytesRead <= 0) throw new SeedCryptoError('sealed blob truncated while reading ciphertext');
      readPosition += bytesRead;
      const plaintext = decipher.update(chunk.subarray(0, bytesRead));
      await writeAll(destination, plaintext, writePosition);
      writePosition += plaintext.length;
    }
    try {
      const finalPlaintext = decipher.final();
      await writeAll(destination, finalPlaintext, writePosition);
    } catch {
      throw new SeedCryptoError('seed decrypt failed — wrong key or tampered payload');
    }
  });
}

/** Constant-time key comparison (for tests / key-management assertions). */
export function keysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
