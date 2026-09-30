/**
 * hive-epoch-producer — the PRODUCER (write-side) of the read-plane re-key (Brief
 * RE-KEY / C-001 / Move 2, K's lane: P4 serving, encrypt-on-write). The symmetric
 * counterpart to the consumer side (EpochKeyProvider + decryptOpPayload): when an
 * owner writes hive content under the re-key, encrypt the op payload under the CURRENT
 * epoch key so only members holding that epoch's wrapped key can read it.
 *
 * `encryptForCurrentEpoch` composes the three landed layers:
 *   getHiveEpoch (P1 epoch model) → crypto.deriveEpochKey (ed300, owner mints/gets the
 *   epoch key) → encryptOpPayload (P4 serving glue, AEAD + deterministic OpAAD).
 * It returns { epoch, ciphertext } so the CALLER (46b7a's capture hook) stamps the
 * op envelope's `epoch?` field + sets `op.value` = ciphertext. This is the producer
 * 46b7a pairs with the envelope field + the apply-side decrypt-gate (so encrypt and
 * remote decrypt assemble the identical AAD via the shared deriveOpId).
 *
 * Pure composition (one PG read via getHiveEpoch); no key material persists here (the
 * epoch key lives device-local in the keychain, minted by deriveEpochKey).
 */
import type { Sql } from 'postgres';
import type { HiveEpochCrypto } from './hive-epoch-crypto';
import { getHiveEpoch } from './hive-epoch-state';
import { encryptOpPayload, type OpIdentity } from './hive-epoch-serving';

export interface EpochEncryptResult {
  /** The epoch the payload was encrypted under (stamp onto the op envelope). */
  epoch: number;
  /** The AEAD ciphertext (set as op.value). */
  ciphertext: Uint8Array;
}

export interface HiveProducerCtx {
  workspaceId: string;
  /** The hive's home_slug — the hive_settings epoch scope. */
  potHomeSlug: string;
  /** The hive's crypto identity id (deriveEpochKey / keychain key id). */
  potId: string;
}

/**
 * Encrypt an op payload under the hive's CURRENT epoch key. The owner mints/gets the
 * epoch key locally (deriveEpochKey). Returns the epoch (to stamp on the envelope) +
 * the ciphertext (op.value). An epoch-0 (pre-re-key / baseline) hive still goes through
 * the same path — its content is encrypted under epoch 0's key, distributed to all
 * members at hive creation (the boundary advances FROM there on the first remove).
 */
export async function encryptForCurrentEpoch(
  crypto: HiveEpochCrypto,
  ctx: HiveProducerCtx,
  payload: Uint8Array,
  id: OpIdentity,
  sql?: Sql,
): Promise<EpochEncryptResult> {
  const epoch = await getHiveEpoch(ctx.workspaceId, ctx.potHomeSlug, sql);
  const key = await crypto.deriveEpochKey(ctx.potId, epoch);
  const ciphertext = await encryptOpPayload(crypto, payload, { potId: ctx.potId, epoch, id }, key);
  return { epoch, ciphertext };
}
