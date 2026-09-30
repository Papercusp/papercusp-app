/**
 * hive-epoch-key-provider — the MEMBER-side epoch-key resolver for the read-plane
 * re-key (Brief RE-KEY / Move 2, K's lane: P-005 consumer half). Implements the
 * `EpochKeyProvider` seam (hive-epoch-serving.ts) that the apply-path decrypt-gate
 * (46b7a's `applyOpVia` hook) calls to answer "do I hold the key for (hive, epoch)?".
 *
 * Per ed300's contract: the member NEVER mints a key — it RE-UNWRAPS from the durable
 * `hive_epoch_keys` blob (its own wrapped row, P-005) via ed300's stateless
 * `unwrapEpochKey`, and caches the result in-process (no second member-side secret
 * store). A member with no wrapped row for (hive, epoch) — a REMOVED member, or one
 * whose key has not arrived yet — fails closed (`keyForEpoch` rejects). That single
 * rejection is BOTH the C-001 cut-off (removed → forever) AND the defer signal for
 * 46b7a's pending-epoch-content buffer (not-yet-arrived → defer + drain on key arrival).
 *
 * The `WrappedKeyLoader` seam is the only dependency on the (gated) `hive_epoch_keys`
 * table — injected, so this module + its tests run AHEAD of the migration/federation.
 */
import type { EpochKey, HiveEpochCrypto } from './hive-epoch-crypto';
import type { EpochKeyProvider } from './hive-epoch-serving';

/** Loads THIS device's wrapped epoch-key blob from `hive_epoch_keys` (P-005 store). */
export interface WrappedKeyLoader {
  /** The wrapped-key blob for (hive, epoch) sealed to `memberDevicePubkey`, or null
   *  when there is no such row (removed member / not-yet-distributed). */
  load(potId: string, epoch: number, memberDevicePubkey: string): Promise<Uint8Array | null>;
}

/** The local device identity (keychain id + raw Ed25519 pubkey base64). */
export interface LocalDevice {
  keychainId: string;
  pubkeyBase64: string;
}

/** Thrown (fail-closed) when this device holds no key for (hive, epoch). */
export class EpochKeyUnavailableError extends Error {
  constructor(
    readonly potId: string,
    readonly epoch: number,
    // WI-2009 / wake-#5742 (v3 instrumentation, leg b): carry WHAT was queried so a
    // miss is diagnosable from the error alone — if the hive_epoch_keys row EXISTS
    // for a DIFFERENT member_device_pubkey, this is the split-device-identity class
    // (the epoch tier resolved a different key than the presence tier).
    detail?: { devicePubkey?: string; keychainId?: string },
  ) {
    super(
      `no epoch key for (${potId}, epoch ${epoch}) on this device — cut off or not yet distributed` +
        (detail?.devicePubkey
          ? ` [queried member_device_pubkey=${detail.devicePubkey} keychainId=${detail.keychainId ?? '?'} row-found=false — WI-2009: a row under a DIFFERENT pubkey ⇒ split device identity]`
          : ''),
    );
    this.name = 'EpochKeyUnavailableError';
  }
}

/**
 * Build the member-side `EpochKeyProvider`. `keyForEpoch` re-unwraps the device's
 * wrapped row and caches it; rejects with `EpochKeyUnavailableError` when absent.
 */
export function createEpochKeyProvider(
  crypto: HiveEpochCrypto,
  loader: WrappedKeyLoader,
  localDevice: LocalDevice,
): EpochKeyProvider {
  const cache = new Map<string, EpochKey>();
  return {
    async keyForEpoch(potId: string, epoch: number): Promise<EpochKey> {
      const ck = `${potId}\x1f${epoch}`;
      const hit = cache.get(ck);
      if (hit) return hit;
      const blob = await loader.load(potId, epoch, localDevice.pubkeyBase64);
      if (!blob)
        throw new EpochKeyUnavailableError(potId, epoch, {
          devicePubkey: localDevice.pubkeyBase64,
          keychainId: localDevice.keychainId,
        });
      const key = await crypto.unwrapEpochKey(blob, localDevice.keychainId);
      cache.set(ck, key);
      return key;
    },
  };
}
