/**
 * hive-keypair — the per-HIVE Ed25519 identity keypair
 * (shared-hive-federation-2026-06-08 P-002; D-002 keypair identity, D-008
 * multiple-Hives-per-workspace).
 *
 * A Hive's IDENTITY is a stable Ed25519 keypair, mirroring the per-device
 * identity (attest.ts) but scoped per-hive-entity: keyed by (workspaceId, hive
 * slug). The owner ruled a workspace hosts MULTIPLE Hives (D-008), so the key
 * is per-hive, NOT per-workspace.
 *
 * The PUBLIC key (raw 32-byte, base64) is the Hive's externally-addressable id:
 *   - it becomes the federation topic key (P-003 — deriveHiveFederationTopic),
 *     replacing the shared-harness slug; and
 *   - when cross-Hive lands (D-002, deferred) it is the hyperdht dial address.
 * The PRIVATE key lives in the keychain on the Hive's OWNING Swarm and never
 * leaves the identity layer — other Swarms / contributors only ever hold the
 * pubkey (distributed via the Hive entity / registry, never the secret).
 *
 * This reuses the device-key machinery wholesale (keychain.ts 3-tier persist +
 * ed25519.ts byte-compatible crypto). The ONLY differences from a device key
 * are the keychain SERVICE namespace and the per-hive keychainId.
 */

import { keychainStore, keychainLoad } from './keychain';
import {
  generateEd25519KeypairDer,
  pubkeyBase64FromDer,
  signWithPrivateKeyDer,
} from './ed25519';

/** OS-keychain service namespace for hive identity keys (distinct from the
 *  device key's `papercusp-device-keypair`). */
export const HIVE_KEYPAIR_SERVICE = 'papercusp-hive-keypair';

export interface HiveKeypairId {
  /** The keychainId the private key is stored under. */
  keychainId: string;
  /** Raw 32-byte Ed25519 public key, base64 — the Hive's addressable identity. */
  pubkeyBase64: string;
}

/**
 * Deterministic keychainId for a hive's identity key. A workspace hosts
 * multiple Hives (D-008), so the key is scoped by (workspaceId, slug). Slugs
 * are stable per workspace, so this id is stable for the hive's lifetime — the
 * keypair therefore survives restarts (the keychain persists; this id is the
 * lookup).
 */
export function hiveKeychainId(workspaceId: string, slug: string): string {
  if (!workspaceId) throw new Error('hiveKeychainId: workspaceId required');
  if (!slug) throw new Error('hiveKeychainId: slug required');
  return `hive:${workspaceId}:${slug}`;
}

/**
 * WI-1981: thrown when a MINT is attempted for a hive this box only JOINED
 * (a `remote_hive` registry VIEW). Minting there creates a second, conflicting
 * hive author identity → wrong epoch secrets (deriveEpochKey is deterministic
 * per hive PRIVATE key) → poison `origin=local` wraps → a permanent mutual
 * `epoch_decrypt_fail` wall against the true owner (proven live tower↔VM,
 * 2026-07-03). The docstring below always said "peers must NOT call this";
 * this error is that contract, enforced.
 */
export class RemoteHiveViewMintRefusedError extends Error {
  constructor(workspaceId: string, slug: string) {
    super(
      `loadOrGenerateHiveKeypair: REFUSING to mint a hive identity for '${workspaceId}/${slug}' — ` +
        `the registry marks it a JOINED remote_hive VIEW (this box is a peer, not the owner). ` +
        `Read the pubkey off the registry view (hive_pubkey) or the hives row instead (WI-1981).`,
    );
    this.name = 'RemoteHiveViewMintRefusedError';
  }
}

/**
 * Load the existing hive keypair, or generate + persist one on first call.
 * Idempotent: repeated calls for the same hive always return the same pubkey.
 * The private key never leaves the keychain — callers receive only the pubkey.
 *
 * Call this on the Hive's OWNING Swarm (the one that created the hive). A peer
 * Swarm that only holds the pubkey must NOT call this — it would mint a second,
 * conflicting identity. Peers read the pubkey off the Hive entity instead.
 * WI-1981: that contract is now ENFORCED — the generate (miss) path refuses,
 * loudly, when the harness_registry row for (workspaceId, slug) is a joined
 * `remote_hive` VIEW. Loading an EXISTING key is unaffected, and a fresh mint
 * with no registry row (create-before-registry, the owner path) stays allowed.
 */
export async function loadOrGenerateHiveKeypair(
  workspaceId: string,
  slug: string,
): Promise<HiveKeypairId> {
  const keychainId = hiveKeychainId(workspaceId, slug);
  const loaded = await keychainLoad(keychainId, HIVE_KEYPAIR_SERVICE);
  if (loaded.kind === 'ok') {
    return { keychainId, pubkeyBase64: pubkeyBase64FromDer(loaded.value) };
  }
  // MINT path — WI-1981 guard: never mint for a joined remote view. Best-effort
  // registry read: an unreadable registry must not break the legitimate owner
  // mint (fail-open matches the pre-guard behavior for owners; the view check
  // itself is authoritative when the registry IS readable).
  try {
    const { loadHarnessRegistry } = await import('../harness-registry');
    const reg = await loadHarnessRegistry(workspaceId);
    const entry = reg.projects?.find((p) => p.slug === slug);
    if (entry?.remote_hive === true) {
      throw new RemoteHiveViewMintRefusedError(workspaceId, slug);
    }
  } catch (e) {
    if (e instanceof RemoteHiveViewMintRefusedError) throw e;
    // registry unreadable → proceed (owner-mint fail-open, see above)
  }
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  await keychainStore(keychainId, privateKeyDer, HIVE_KEYPAIR_SERVICE);
  return { keychainId, pubkeyBase64 };
}

/**
 * Load the hive's pubkey WITHOUT generating one if absent. Returns null when
 * this Swarm does not hold the hive's private key (e.g. a hive owned by a
 * different Swarm). Use loadOrGenerateHiveKeypair on the owning Swarm to mint
 * it; use the pubkey off the Hive entity for a peer-held hive.
 *
 * NOTE: this collapses "genuinely no local key" (a normal non-owning Swarm —
 * expected, safe to treat as "no identity to compare") and "a key IS present
 * but failed to load/decrypt" (a real error — should NOT be silently treated
 * the same as "no identity", see WI-762) into one `null`. A caller that needs
 * to tell those apart for a security-relevant ownership check (e.g.
 * papercusp-hive-share.ts's gist-adopt guard) should use
 * `loadHiveKeyStatus` instead.
 */
export async function loadHivePubkey(
  workspaceId: string,
  slug: string,
): Promise<string | null> {
  const loaded = await keychainLoad(hiveKeychainId(workspaceId, slug), HIVE_KEYPAIR_SERVICE);
  return loaded.kind === 'ok' ? pubkeyBase64FromDer(loaded.value) : null;
}

/** The tri-state result of `loadHiveKeyStatus` — distinguishes "no local key"
 *  (safe: no competing identity to compare against) from "a key IS present but
 *  couldn't be read" (unsafe: proceeding would silently drop a verification
 *  check the caller thinks it's making). See `loadHiveKeyStatus`. */
export type HiveKeyStatus =
  | { kind: 'ok'; pubkeyBase64: string }
  | { kind: 'not_found' }
  | { kind: 'error'; reason: string };

/**
 * Load the hive's pubkey, preserving WHY it's absent when it is (WI-762).
 * `loadHivePubkey` flattens "no key held" and "a key is held but couldn't be
 * loaded/decrypted" into the same `null` — fine for callers that only ever
 * want "do I hold it or not", but wrong for a security-relevant ownership
 * guard: a device that HAS a competing local identity but hit a transient
 * keychain read/decrypt error must NOT be treated the same as a device that
 * genuinely has no local identity (a normal non-owning member) — the former
 * should fail closed (bail, don't proceed under an unverified state); the
 * latter is the expected, safe-to-proceed case.
 */
export async function loadHiveKeyStatus(
  workspaceId: string,
  slug: string,
): Promise<HiveKeyStatus> {
  const loaded = await keychainLoad(hiveKeychainId(workspaceId, slug), HIVE_KEYPAIR_SERVICE);
  if (loaded.kind === 'ok') return { kind: 'ok', pubkeyBase64: pubkeyBase64FromDer(loaded.value) };
  if (loaded.error.kind === 'not_found') return { kind: 'not_found' };
  // Remaining variants (io_error | decryption_failed) both carry `.reason`.
  return { kind: 'error', reason: loaded.error.reason };
}

/**
 * Sign `bytes` with the hive's Ed25519 private key. Throws if this Swarm does
 * not hold the hive's private key (only the owning Swarm does). Returns the raw
 * 64-byte signature Buffer — callers base64-encode for the wire.
 *
 * This is the hive-level signing seam (vs signWithDeviceKey): a signature that
 * binds to the HIVE identity rather than a device identity — e.g. a hive-level
 * directory announce or federation envelope — rides through here.
 */
export async function signWithHiveKey(
  workspaceId: string,
  slug: string,
  bytes: Buffer,
): Promise<Buffer> {
  const keychainId = hiveKeychainId(workspaceId, slug);
  const loaded = await keychainLoad(keychainId, HIVE_KEYPAIR_SERVICE);
  if (loaded.kind !== 'ok') {
    throw new Error('signWithHiveKey: hive private key not held by this Swarm for ' + keychainId);
  }
  return signWithPrivateKeyDer(loaded.value, bytes);
}
