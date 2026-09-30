/**
 * Per-workspace kopia repo password.
 *
 * Derived (not stored) from the workspace's existing db-encryption-key via
 * HKDF, so the threat surface stays exactly the same as today's PG
 * encryption: lose the key, lose the backups. No new secret to manage,
 * no new place to leak it.
 *
 * Context label binds the derivation to (a) this purpose ("kopia-backup")
 * and (b) the workspace id, so the same root key produces a distinct
 * password per workspace. Bump the version suffix if the derivation
 * scheme ever changes — existing repos won't be readable after that and
 * a new repo will be created on next snapshot.
 */

import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY_FILE = join(homedir(), '.papercusp', 'db-encryption-key');
const KDF_LABEL = 'kopia-backup-v1';

/**
 * HKDF-Expand only (RFC 5869 §2.3) — the existing key is already
 * high-entropy random bytes, so no Extract step is needed.
 */
function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const blocks: Buffer[] = [];
  let t = Buffer.alloc(0);
  let counter = 1;
  while (Buffer.concat(blocks).length < length) {
    t = createHmac('sha256', prk).update(t).update(info).update(Buffer.from([counter])).digest();
    blocks.push(t);
    counter++;
  }
  return Buffer.concat(blocks).subarray(0, length);
}

/** Returns base64 url-safe password, 256 bits of entropy. */
export async function deriveRepoPassword(workspaceId: string): Promise<string> {
  const keyRaw = await readFile(KEY_FILE);
  const key = keyRaw.toString('utf8').trim();
  // Accept either raw bytes or hex/base64 in the file — normalize to bytes.
  const prk = /^[0-9a-f]{32,}$/i.test(key)
    ? Buffer.from(key, 'hex')
    : /^[A-Za-z0-9+/=_-]+$/.test(key)
      ? Buffer.from(key, 'base64')
      : keyRaw;
  const info = Buffer.from(`${KDF_LABEL}:${workspaceId}`, 'utf8');
  return hkdfExpand(prk, info, 32).toString('base64url');
}
