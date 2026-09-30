/**
 * hive-epoch-serving — the SERVING half of the read-plane re-key (Brief RE-KEY /
 * C-001 / E-001 / Move 2, K's lane: P4 serving-under-epochs). Pure glue between the
 * federation op path and ed300's `HiveEpochCrypto` crypto foundation
 * (`hive-epoch-crypto.ts` / `hive-epoch-crypto-impl.ts`).
 *
 * Responsibilities (the parts ed300's contract delegates to the serving layer):
 *   1. `deriveOpId` — the DETERMINISTIC, STABLE op identity bound into the AEAD as
 *      `OpAAD.opId`. ed300's contract (2026-06-19): "opId must be deterministic +
 *      stable per op (table+key+author) so encrypt and the remote decrypt use the
 *      identical AAD — otherwise decrypt fails closed. Pin the opId derivation in your
 *      serving layer." This is that pin. The three inputs (tableTag, rowKey,
 *      authorPubkey) are all federated op fields, identical on owner (encrypt) and
 *      member (decrypt), so the derived opId matches across peers.
 *   2. `encryptOpPayload` / `decryptOpPayload` — assemble `OpAAD {potId, epoch, opId}`
 *      and call ed300's `encryptOp`/`decryptOp`. Thin, so the AAD is assembled in ONE
 *      place (encrypt and decrypt cannot drift).
 *   3. `resolveHiveEpochCrypto` — the flag gate: the real `createHiveEpochCrypto()`
 *      when the re-key is enabled, else the fail-closed `notImplementedHiveEpochCrypto`
 *      stub (never silently ships plaintext).
 *
 * NOT here (gated on d2230's A-003 send-side federation path — coordinate the
 * capture/drain wiring with that fix): the epoch-key PROVIDER (owner deriveEpochKey vs
 * member unwrap-from-`hive_epoch_keys`-blob) is only an INTERFACE here; its impl + the
 * op-path wiring land with P1/P3 once the federation seam settles. This module is pure
 * (depends only on ed300's stable crypto contract), so it carries no rework risk from
 * the A-003 approach still being refined.
 */

import { createHash } from 'node:crypto';
import type { HiveEpochCrypto, EpochKey, OpAAD } from './hive-epoch-crypto';
import { notImplementedHiveEpochCrypto } from './hive-epoch-crypto';

/**
 * The federated op fields that identify a row, mirrored on every peer. `authorPubkey`
 * is normalized (null/undefined → '') so a missing author still yields a stable id.
 */
export interface OpIdentity {
  /** The op's projection table tag (op.table) — e.g. 'harness-features'. */
  tableTag: string;
  /** The projection's composed row key (the same key the LWW guard uses). */
  rowKey: string;
  /** The op author's device pubkey (base64), or null. */
  authorPubkey: string | null | undefined;
}

/**
 * Deterministic, cross-peer-stable op id = sha256 over the JSON-encoded
 * [tableTag, rowKey, authorPubkey] triple (JSON string-quoting makes the encoding
 * unambiguous — no delimiter-injection across the three fields). Hex. Identical inputs
 * on any peer → identical id, so the AEAD AAD matches on encrypt + remote decrypt.
 */
export function deriveOpId(id: OpIdentity): string {
  const triple = JSON.stringify([id.tableTag, id.rowKey, id.authorPubkey ?? '']);
  return createHash('sha256').update(triple, 'utf8').digest('hex');
}

/** Build the AEAD associated data for an op under (hive, epoch). */
export function buildOpAAD(potId: string, epoch: number, id: OpIdentity): OpAAD {
  return { potId, epoch, opId: deriveOpId(id) };
}

/**
 * Encrypt an op payload under the current epoch key. The caller supplies the resolved
 * `epochKey` (from the epoch-key provider — owner-derived or member-unwrapped) so this
 * function stays pure + provider-agnostic.
 */
export function encryptOpPayload(
  crypto: HiveEpochCrypto,
  payload: Uint8Array,
  ctx: { potId: string; epoch: number; id: OpIdentity },
  epochKey: EpochKey,
): Promise<Uint8Array> {
  return crypto.encryptOp(payload, epochKey, buildOpAAD(ctx.potId, ctx.epoch, ctx.id));
}

/**
 * Decrypt an op payload. Rejects (fail-closed) when `epochKey` is wrong/absent or the
 * AAD does not match what was sealed — i.e. a removed member (no key) or a tampered
 * (hive, epoch, op) cannot read. The op's `epoch` is read from the op envelope (the
 * epoch it was written under), NOT the reader's current epoch.
 */
export function decryptOpPayload(
  crypto: HiveEpochCrypto,
  ciphertext: Uint8Array,
  ctx: { potId: string; epoch: number; id: OpIdentity },
  epochKey: EpochKey,
): Promise<Uint8Array> {
  return crypto.decryptOp(ciphertext, epochKey, buildOpAAD(ctx.potId, ctx.epoch, ctx.id));
}

/**
 * The epoch-key provider seam (impl deferred to P1/P3 — rides d2230's A-003 federation
 * path). Owner side returns the locally-minted key (deriveEpochKey); member side
 * re-unwraps from the durable `hive_epoch_keys` blob (unwrapEpochKey, stateless +
 * in-process-cached per ed300's recommendation). The serving wrappers above take the
 * resolved key, so they don't depend on this — but the op-path wiring will.
 */
export interface EpochKeyProvider {
  /** Resolve the content key for (hive, epoch) for the local device. Rejects when the
   *  local device has no access to that epoch (the removed-member cut-off). */
  keyForEpoch(potId: string, epoch: number): Promise<EpochKey>;
}

/**
 * Flag gate: the real crypto when the re-key path is enabled, else the fail-closed
 * stub. The boolean is the `papercusp-hive-rekey` flag, resolved at the call site +
 * passed in (keeps this module free of a static flag/impl import; the impl — with its
 * native sodium dep — is dynamically imported only when enabled).
 */
export async function resolveHiveEpochCrypto(enabled: boolean): Promise<HiveEpochCrypto> {
  if (!enabled) return notImplementedHiveEpochCrypto;
  const { createHiveEpochCrypto } = await import('./hive-epoch-crypto-impl');
  return createHiveEpochCrypto();
}
