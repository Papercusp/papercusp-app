/**
 * Trust store — PG-backed (migration 026).
 *
 * Records which (publisher, plugin) pairs the user has trusted to run
 * setup scripts on their host, plus which scriptHashes are approved.
 * Per spec, trust is granular per-(publisher, plugin); a user trusting
 * `@papercupai/aws-lambda` does NOT auto-trust `@papercupai/x`.
 *
 * Key rotation: when a publisher rotates their signing key, the old
 * fingerprint is recorded with `rotated_at`. Trusts pinned to the old
 * fingerprint do NOT auto-migrate — the user re-confirms once.
 *
 * Storage: single row per workspace in `harness_shared.operator_trust_store`,
 * payload mirrors the prior file shape ({entries, rotations, blocklist}).
 * NOT in zero_harness publication — security state stays server-side.
 *
 * Was previously `<workspace>/trust.json` mode 0600.
 *
 * Spec: /docs/snapshots/build-scripts#trust-lifecycle.
 */

import { readOperatorState, writeOperatorState } from '../operator-state-pg';

export interface TrustEntry {
  publisher: string;
  plugin: string;
  /** Publisher signing-key fingerprint at the time the trust was granted. */
  publisherKeyFingerprint: string;
  /** Set of scriptHashes the user has approved. */
  approvedScriptHashes: string[];
  /** Set if the install was a `--dev` ad-hoc local install. */
  dev?: boolean;
  approvedAt: string;
}

export interface KeyRotationEvent {
  publisher: string;
  oldFingerprint: string;
  newFingerprint: string;
  rotatedAt: string;
  /** True if the rotation was countersigned by the marketplace key. */
  countersigned: boolean;
  reason?: string;
}

export interface TrustStore {
  entries: TrustEntry[];
  rotations: KeyRotationEvent[];
  /** Optional blocklist of revoked fingerprints. */
  blocklist: string[];
}

// Fresh object per call — a shared `const EMPTY` spread (`{ ...EMPTY }`)
// copies the ARRAY REFERENCES, so recordTrust's pushes would mutate the
// module constant and leak stale entries into every later "empty" read.
function emptyTrustStore(): TrustStore {
  return { entries: [], rotations: [], blocklist: [] };
}

export async function readTrustStore(): Promise<TrustStore> {
  const raw = await readOperatorState<Partial<TrustStore>>('operator_trust_store');
  return { ...emptyTrustStore(), ...raw };
}

async function writeTrustStore(store: TrustStore): Promise<void> {
  await writeOperatorState('operator_trust_store', store);
}

/**
 * Record consent for a (publisher, plugin, scriptHash). Idempotent.
 */
export async function recordTrust(args: {
  publisher: string;
  plugin: string;
  publisherKeyFingerprint: string;
  scriptHash: string;
  dev?: boolean;
}): Promise<void> {
  const store = await readTrustStore();
  let entry = store.entries.find(
    (e) => e.publisher === args.publisher && e.plugin === args.plugin,
  );
  if (!entry) {
    entry = {
      publisher: args.publisher,
      plugin: args.plugin,
      publisherKeyFingerprint: args.publisherKeyFingerprint,
      approvedScriptHashes: [],
      approvedAt: new Date().toISOString(),
    };
    if (args.dev) entry.dev = true;
    store.entries.push(entry);
  } else if (entry.publisherKeyFingerprint !== args.publisherKeyFingerprint) {
    // Different fingerprint than last trust — replace.
    entry.publisherKeyFingerprint = args.publisherKeyFingerprint;
    entry.approvedScriptHashes = [];
    entry.approvedAt = new Date().toISOString();
    if (args.dev) entry.dev = true;
    else delete entry.dev;
  }
  if (!entry.approvedScriptHashes.includes(args.scriptHash)) {
    entry.approvedScriptHashes.push(args.scriptHash);
  }
  await writeTrustStore(store);
}

export type TrustCheck =
  | { trusted: true; entry: TrustEntry }
  | {
      trusted: false;
      reason: 'no-trust' | 'key-rotated' | 'blocklisted' | 'script-not-approved';
      entry?: TrustEntry;
    };

/**
 * Check whether `(publisher, plugin)` is trusted to run a script with
 * `scriptHash` signed by `currentFingerprint`.
 */
export async function checkTrust(args: {
  publisher: string;
  plugin: string;
  scriptHash: string;
  currentFingerprint: string;
}): Promise<TrustCheck> {
  const store = await readTrustStore();
  if (store.blocklist.includes(args.currentFingerprint)) {
    return { trusted: false, reason: 'blocklisted' };
  }
  const entry = store.entries.find(
    (e) => e.publisher === args.publisher && e.plugin === args.plugin,
  );
  if (!entry) return { trusted: false, reason: 'no-trust' };
  if (entry.publisherKeyFingerprint !== args.currentFingerprint) {
    return { trusted: false, reason: 'key-rotated', entry };
  }
  if (!entry.approvedScriptHashes.includes(args.scriptHash)) {
    return { trusted: false, reason: 'script-not-approved', entry };
  }
  return { trusted: true, entry };
}

/**
 * Record a publisher key-rotation event. Per spec, V1 requires the
 * marketplace to countersign these before the substrate accepts them.
 */
export async function recordKeyRotation(event: KeyRotationEvent): Promise<void> {
  const store = await readTrustStore();
  store.rotations.push(event);
  await writeTrustStore(store);
}

/** Add a fingerprint to the blocklist. Future trust checks reject. */
export async function blocklistFingerprint(fingerprint: string): Promise<void> {
  const store = await readTrustStore();
  if (!store.blocklist.includes(fingerprint)) {
    store.blocklist.push(fingerprint);
    await writeTrustStore(store);
  }
}

/** Drop trust for a (publisher, plugin) pair. Used on uninstall. */
export async function revokeTrust(publisher: string, plugin: string): Promise<void> {
  const store = await readTrustStore();
  store.entries = store.entries.filter(
    (e) => !(e.publisher === publisher && e.plugin === plugin),
  );
  await writeTrustStore(store);
}
