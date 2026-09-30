/**
 * Offsite destination support — local-primary, replicated to S3 / B2 /
 * any rclone remote via `kopia repository sync-to` after each snapshot.
 *
 * Config persistence: the destination_config_encrypted column is an
 * AES-256-GCM ciphertext over JSON. Key = HKDF over db-encryption-key,
 * label "kopia-dest-config-v1:<workspaceId>". Stored encrypted so a
 * naive PG dump doesn't leak access tokens.
 *
 * sync-to flow:
 *   1. Local snapshot completes (existing path).
 *   2. After success, if destination_type !== 'local', kopia repository
 *      sync-to <type> <args>. Failures are logged but non-fatal — the
 *      local snapshot is the canonical store; offsite is durability.
 *
 * Threat-model fit:
 *   - Hardware loss of the workspace drive → restore from offsite.
 *   - Local malware/agent that wipes the local repo → offsite retains
 *     history (especially if you enable S3 Object Lock / B2 versioning).
 */

import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type DestinationType = 'local' | 'local+s3' | 'local+b2' | 'local+rclone';

interface S3Config { bucket: string; prefix?: string; endpoint?: string; region?: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string; }
interface B2Config { bucket: string; prefix?: string; keyId: string; key: string; }
interface RcloneConfig { remotePath: string; /* "<remote-name>:<path>" */ }

export type DestinationConfig = S3Config | B2Config | RcloneConfig;

const KEY_FILE = join(homedir(), '.papercusp', 'db-encryption-key');
const KDF_LABEL = 'kopia-dest-config-v1';

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

async function deriveDestKey(workspaceId: string): Promise<Buffer> {
  const raw = await readFile(KEY_FILE);
  const s = raw.toString('utf8').trim();
  const prk = /^[0-9a-f]{32,}$/i.test(s)
    ? Buffer.from(s, 'hex')
    : /^[A-Za-z0-9+/=_-]+$/.test(s)
      ? Buffer.from(s, 'base64')
      : raw;
  return hkdfExpand(prk, Buffer.from(`${KDF_LABEL}:${workspaceId}`, 'utf8'), 32);
}

export async function encryptDestConfig(workspaceId: string, cfg: DestinationConfig): Promise<string> {
  const key = await deriveDestKey(workspaceId);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(cfg), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export async function decryptDestConfig(workspaceId: string, b64: string): Promise<DestinationConfig> {
  const key = await deriveDestKey(workspaceId);
  const buf = Buffer.from(b64, 'base64');
  // 12B iv + 16B tag minimum — a truncated blob would otherwise hand
  // setAuthTag a short tag (DEP0182; becomes a hard error in future Node).
  if (buf.length < 28) throw new Error('decryptDestConfig: ciphertext too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8')) as DestinationConfig;
}

/**
 * Build the args + env to run `kopia repository sync-to` for a given
 * destination type. The caller spawns kopia with these. Returns null
 * if the destination is local-only (nothing to sync to).
 */
export function syncArgsFor(
  type: DestinationType,
  cfg: DestinationConfig,
): { args: string[]; env: Record<string, string> } | null {
  if (type === 'local') return null;

  if (type === 'local+s3') {
    const c = cfg as S3Config;
    const args = [
      'repository', 'sync-to', 's3',
      `--bucket=${c.bucket}`,
      ...(c.prefix ? [`--prefix=${c.prefix}`] : []),
      ...(c.endpoint ? [`--endpoint=${c.endpoint}`] : []),
      ...(c.region ? [`--region=${c.region}`] : []),
      '--delete-blobs=false',
    ];
    const env: Record<string, string> = {
      AWS_ACCESS_KEY_ID: c.accessKeyId,
      AWS_SECRET_ACCESS_KEY: c.secretAccessKey,
      ...(c.sessionToken ? { AWS_SESSION_TOKEN: c.sessionToken } : {}),
    };
    return { args, env };
  }

  if (type === 'local+b2') {
    const c = cfg as B2Config;
    const args = [
      'repository', 'sync-to', 'b2',
      `--bucket=${c.bucket}`,
      ...(c.prefix ? [`--prefix=${c.prefix}`] : []),
      `--key-id=${c.keyId}`,
      `--key=${c.key}`,
      '--delete-blobs=false',
    ];
    return { args, env: {} };
  }

  if (type === 'local+rclone') {
    const c = cfg as RcloneConfig;
    const args = [
      'repository', 'sync-to', 'rclone',
      `--remote-path=${c.remotePath}`,
      '--delete-blobs=false',
    ];
    return { args, env: {} };
  }

  return null;
}
