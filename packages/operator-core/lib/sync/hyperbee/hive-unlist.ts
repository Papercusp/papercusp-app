/**
 * hive-unlist — the signed WITHDRAWAL tombstone for the hive directory
 * (hive-from-repo-hardening-2026-06-11 P-005 / D-005).
 *
 * Before this, withdrawing a hive (visibility → private) only STOPPED
 * re-announcing — peers kept the listing until the 7-day TTL aged it out. The
 * unlist frame is the active half: the owner device broadcasts a signed
 * tombstone on the same directory topic; peers verify it against the LISTED
 * record's `owner_device_pubkey` (no new trust root — exactly the device that
 * proved ownership of the listing) and drop the record immediately.
 *
 * Trust rule (D-005):
 *   - sig must verify against `owner_device_pubkey` IN THE FRAME, and that
 *     pubkey must EQUAL the listed record's — an attacker can sign their own
 *     frame but cannot match the listing's owner key.
 *   - the tombstone's ts is cached: announces with ts ≤ tombstone stay
 *     dropped (replays of old announces can't resurrect the listing), while a
 *     genuinely NEWER signed announce relists (re-publish after withdraw
 *     keeps working).
 *   - an unlist for an UNKNOWN hive is rejected — without the listed record
 *     there is nothing to authenticate against (and nothing to drop).
 *
 * Same crypto conventions as hive-announce.ts: raw-32-byte-base64 device
 * pubkey → SPKI-DER rebuild → node verify; field-ordered canonical JSON;
 * ±window freshness on `ts`; injected signer.
 */

import { verify as nodeVerify, createPublicKey } from 'node:crypto';

export const HIVE_UNLIST_KIND = 'hive-unlist' as const;

/** The signed-over fields (everything except `sig`). */
export interface HiveUnlistBody {
  /** Frame discriminator — lets the shared gossip channel route announce vs
   *  unlist. Old peers fail their announce shape-check and ignore us. */
  kind: typeof HIVE_UNLIST_KIND;
  /** The listed hive id being withdrawn. */
  hive_id: string;
  /** Raw 32-byte Ed25519 device pubkey, base64 — MUST equal the listing's. */
  owner_device_pubkey: string;
  /** Epoch-ms at build time. Covered by sig; freshness-checked; the tombstone watermark. */
  ts: number;
  /** Optional replay nonce. Covered by sig. */
  nonce?: string;
}

export interface SignedHiveUnlist extends HiveUnlistBody {
  /** Base64 Ed25519 signature over `hiveUnlistSigningBytes(body)`. */
  sig: string;
}

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Same default freshness window as announces. */
export const DEFAULT_HIVE_UNLIST_WINDOW_MS = 5 * 60 * 1000;

export function hiveUnlistSigningBytes(body: HiveUnlistBody): Buffer {
  const ordered: Record<string, unknown> = {
    kind: body.kind,
    hive_id: body.hive_id,
    owner_device_pubkey: body.owner_device_pubkey,
    ts: body.ts,
  };
  if (typeof body.nonce === 'string') ordered.nonce = body.nonce;
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

export async function buildHiveUnlist(
  body: HiveUnlistBody,
  sign: (bytes: Buffer) => Promise<Buffer>,
): Promise<SignedHiveUnlist> {
  const sig = await sign(hiveUnlistSigningBytes(body));
  return { ...body, sig: sig.toString('base64') };
}

/** A frame from the shared gossip channel that claims to be an unlist. */
export function isHiveUnlistFrame(frame: unknown): frame is SignedHiveUnlist {
  return (
    !!frame &&
    typeof frame === 'object' &&
    (frame as { kind?: unknown }).kind === HIVE_UNLIST_KIND
  );
}

/**
 * Signature + freshness + shape only (channel-1). The OWNERSHIP check — frame
 * pubkey equals the listed record's — is the directory's ingest step (it holds
 * the record).
 */
export function verifyHiveUnlist(
  frame: SignedHiveUnlist,
  opts?: { nowMs?: number; windowMs?: number },
): boolean {
  try {
    if (!frame || typeof frame !== 'object') return false;
    if (
      frame.kind !== HIVE_UNLIST_KIND ||
      typeof frame.hive_id !== 'string' ||
      frame.hive_id.length === 0 ||
      typeof frame.owner_device_pubkey !== 'string' ||
      typeof frame.ts !== 'number' ||
      (frame.nonce !== undefined && typeof frame.nonce !== 'string') ||
      typeof frame.sig !== 'string'
    ) {
      return false;
    }
    const nowMs = opts?.nowMs ?? Date.now();
    const windowMs = opts?.windowMs ?? DEFAULT_HIVE_UNLIST_WINDOW_MS;
    if (Math.abs(nowMs - frame.ts) > windowMs) return false;

    const rawPubkey = Buffer.from(frame.owner_device_pubkey, 'base64');
    if (rawPubkey.length !== 32) return false;
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, rawPubkey]),
      format: 'der',
      type: 'spki',
    });
    return nodeVerify(null, hiveUnlistSigningBytes(frame), publicKey, Buffer.from(frame.sig, 'base64'));
  } catch {
    return false;
  }
}
