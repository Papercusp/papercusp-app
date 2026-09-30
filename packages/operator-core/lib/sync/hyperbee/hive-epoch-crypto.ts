/**
 * hive-epoch-crypto — the SEAM between the read-plane re-key's two halves
 * (shared-pot-release-testing Brief RE-KEY / C-001 / E-001 / Move 2).
 *
 * OWNER-GREENLIT (the owner, 2026-06-19): member-remove / go-private MUST cut a removed
 * peer's READ access to post-boundary content. The load-bearing cut is CRYPTO: content
 * is encrypted under a per-epoch key, and on a boundary the epoch advances and the new
 * key is distributed to the REMAINING members only — a removed peer can still replicate
 * the ciphertext bytes but cannot decrypt them.
 *
 * SPLIT (see brief-REKEY-c001-move2.md + findings-REKEY.md):
 *   - The CRYPTO-FOUNDATION lane = the real implementation of this interface
 *     (epoch group-key + content-core encryption). v1 = a per-epoch symmetric content
 *     key wrapped-to-each-remaining-member's device key; the interface is deliberately
 *     MLS/TreeKEM-able so RFC 9420 (forward-secrecy + post-compromise security) can
 *     later re-implement it WITHOUT touching the boundary/distribution code.
 *   - The BOUNDARY lane = BOUNDARY + DISTRIBUTION + SERVING-UNDER-EPOCHS + the live
 *     cut-off witness — the CONSUMER of this interface.
 *
 * This file defines the contract + types + a fail-closed stub. It is INERT until the
 * re-key is wired behind its flag (no behavior change on import). Nothing here weakens
 * today's behavior; it is the scaffold both halves build against in parallel.
 */

/**
 * An opaque per-epoch symmetric content key. Branded so a raw Uint8Array can't be
 * passed where an EpochKey is required. The concrete representation is the crypto
 * foundation's choice (raw AEAD key bytes for v1; an MLS exporter secret later).
 */
export type EpochKey = Uint8Array & { readonly __brand: 'HiveEpochKey' };

/**
 * Associated data bound into the AEAD so a ciphertext can't be replayed under a
 * different (hive, epoch, op) — authenticated but not encrypted.
 */
export interface OpAAD {
  potId: string;
  epoch: number;
  /** Stable op identity (e.g. table+key+author) so a ct can't be moved between rows. */
  opId: string;
}

/**
 * The re-key crypto seam. The boundary/distribution half (K) calls these; the crypto
 * foundation (ed300) implements them. All async (key agreement / device-key ops may be
 * async, and MLS group ops certainly are).
 */
export interface HiveEpochCrypto {
  /**
   * OWNER-SIDE get-or-generate the content key for (hive, epoch). The key is a FRESH
   * RANDOM per-epoch key (NOT a deterministic derivation — fresh-per-epoch is what gives
   * the read cut-off: a removed peer can't recompute it), persisted by the foundation
   * (owner-local, never federated in the clear); returns the stored key for that epoch,
   * generating + persisting it on first call for a new epoch. MEMBERS never call this —
   * they obtain the epoch key via `unwrapEpochKey` from their distributed wrapped blob.
   * (ed300's design, 2026-06-19.)
   */
  deriveEpochKey(potId: string, epoch: number): Promise<EpochKey>;

  /**
   * Wrap `key` TO a single remaining member's device pubkey → an opaque blob only that
   * member's device key can unwrap. `memberDevicePubkeyBase64` is the member's raw
   * Ed25519 device pubkey, base64 (the same `device_pubkey` carried in hive_members
   * device_attestations / the announce); the foundation converts Ed25519→X25519 for the
   * ECDH sealed-box wrap. Called once per REMAINING member on an epoch advance; the
   * removed member is simply never wrapped to (→ K writes no hive_epoch_keys row for it).
   */
  wrapKeyToMember(key: EpochKey, memberDevicePubkeyBase64: string): Promise<Uint8Array>;

  /**
   * MEMBER-SIDE: unwrap a distributed wrapped-epoch-key blob with the local device key
   * (resolved from the keychain id, mirroring local-announce-identity / device-keychain-id).
   * This is the only way a non-owner obtains an epoch key.
   */
  unwrapEpochKey(blob: Uint8Array, ownDeviceKeychainId: string): Promise<EpochKey>;

  /** AEAD-encrypt an op payload under the epoch key, binding `ad`. */
  encryptOp(payload: Uint8Array, key: EpochKey, ad: OpAAD): Promise<Uint8Array>;

  /** AEAD-decrypt; throws/rejects on auth failure or a missing/wrong key. */
  decryptOp(ciphertext: Uint8Array, key: EpochKey, ad: OpAAD): Promise<Uint8Array>;
}

/**
 * Fail-closed placeholder until the crypto foundation lands. Importing this module is
 * inert; only a caller that actually invokes the re-key path hits these throws — which
 * is the correct failure mode for a not-yet-built SECURITY primitive (never silently
 * no-op, which would ship plaintext while claiming a cut).
 */
export const notImplementedHiveEpochCrypto: HiveEpochCrypto = {
  deriveEpochKey() {
    return Promise.reject(new Error('HiveEpochCrypto.deriveEpochKey not implemented (Move 2 / ed300 crypto foundation pending)'));
  },
  wrapKeyToMember() {
    return Promise.reject(new Error('HiveEpochCrypto.wrapKeyToMember not implemented (Move 2 / ed300 crypto foundation pending)'));
  },
  unwrapEpochKey() {
    return Promise.reject(new Error('HiveEpochCrypto.unwrapEpochKey not implemented (Move 2 / ed300 crypto foundation pending)'));
  },
  encryptOp() {
    return Promise.reject(new Error('HiveEpochCrypto.encryptOp not implemented (Move 2 / ed300 crypto foundation pending)'));
  },
  decryptOp() {
    return Promise.reject(new Error('HiveEpochCrypto.decryptOp not implemented (Move 2 / ed300 crypto foundation pending)'));
  },
};
