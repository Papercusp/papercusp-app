/**
 * hive-directory-deps.ts — the production WIRING of the HiveDirectory service
 * (p2p-hive-directory-2026-06-06 P-003/P-005).
 *
 * Mirrors change-feed-deps.ts: the core `hive-directory.ts` stays pure over
 * injected seams; this module binds those seams to the real subsystems and owns
 * the process singleton the operator endpoint (`discovery:pots`, P-005) reads:
 *
 *   - `sign`             → `signWithDeviceKey(keychainId, …)` (the device key
 *                          that signs our own hive announces). Throws until the
 *                          boot wiring supplies the keychain id.
 *   - `verifyAttestation`→ `attest.verifyAttestation(...).valid` (channel-2 — the
 *                          spam floor: only GitHub-attested announces render).
 *   - `broadcast`        → the swarm transport set by the boot wiring
 *                          (`setHiveDirectoryTransport`). A no-op until wired, so
 *                          the endpoint serves a read-only list before the
 *                          substrate join exists.
 *   - cache              → WIRED (this line previously said "omitted" — stale):
 *                          productionDeps() binds loadCache/saveCache to the
 *                          `hive_directory_cache` operator-state row (mig 182)
 *                          + tombstones, so the discovered set survives reboots
 *                          and live announces LWW over the hydrated cache.
 *
 * Boot integration (the live join, deferred to the substrate boot path): on
 * substrate boot, call `setHiveDirectoryTransport(send, keychainId)`, join
 * `deriveDirectoryTopic()` (+ any invite topics for owned invite hives), pipe
 * inbound frames to `getHiveDirectory().ingestAnnounce`, `registerLocalHive` the
 * workspace's public/invite hives, and `startReannounce(...)`.
 */

import { verifyAttestation } from './identity/attest';
import { signWithDeviceKey } from './identity/sign-with-device-key';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { HiveDirectory, type DiscoveredHive, type HiveDirectoryDeps, type SignedHiveAnnounce } from './hive-directory';
import { contentPeerCountForTopic, lastContentAnnounceRecvMs } from './sync/hyperbee/swarm';

let _singleton: HiveDirectory | null = null;
let _transport: ((topicHex: string, frame: SignedHiveAnnounce) => Promise<void>) | null = null;
let _keychainId: string | null = null;
let _reachablePeers: ((topicHex?: string) => number) | null = null;

/**
 * Wire the live swarm transport + device keychain id (called by the substrate
 * boot path). Until this runs, `broadcast` is a no-op and `sign` throws — the
 * endpoint still serves the (empty) discovered list without crashing.
 *
 * `reachablePeers` (deceptive-publish fix) reports the directory-swarm's live
 * paired-channel count so a publish can honestly say whether the announce reached
 * anyone. G-001: it takes an optional `topicHex` so the count is scoped to the
 * announce's OWN topic (the boot wiring passes `gossip.openChannelCount(topicHex)`);
 * with no topic it returns the all-topics total. Optional: until wired (or with no
 * transport) it reports 0 — the truthful answer (broadcasting into the void).
 */
export function setHiveDirectoryTransport(
  broadcast: (topicHex: string, frame: SignedHiveAnnounce) => Promise<void>,
  keychainId: string,
  reachablePeers?: (topicHex?: string) => number,
): void {
  _transport = broadcast;
  _keychainId = keychainId;
  _reachablePeers = reachablePeers ?? null;
}

function productionDeps(): HiveDirectoryDeps {
  return {
    sign: async (bytes) => {
      if (!_keychainId) {
        throw new Error('hive-directory: device keychain not wired (call setHiveDirectoryTransport at boot)');
      }
      return signWithDeviceKey(_keychainId, bytes);
    },
    verifyAttestation: async ({ attestationGistId, devicePubkey, githubUserId }) => {
      const res = await verifyAttestation(attestationGistId, devicePubkey, githubUserId);
      return res.valid;
    },
    broadcast: async (topicHex, frame) => {
      if (_transport) await _transport(topicHex, frame);
    },
    // Deceptive-publish fix: real swarm reach (0 until the transport is wired).
    // G-001: thread the announce topic through so the count is the announce's own
    // topic, not every joined topic.
    reachablePeers: (topicHex) => _reachablePeers?.(topicHex) ?? 0,
    // EI-1599: unlike `reachablePeers` (the directory-gossip instance created per
    // boot wiring), the CONTENT substrate's per-topic announce-channel accounting
    // lives as process-global module state in swarm.ts (every harness's
    // `joinHarnessSwarm` call feeds the SAME shared swarm) — no injection/wiring
    // needed, these are always live once ANY content swarm join has happened.
    contentPeers: (topicHex) => contentPeerCountForTopic(topicHex),
    lastContentSyncMs: (topicHex) => lastContentAnnounceRecvMs(topicHex),
    // PG offline cache (migration 182, hive_directory_cache state table). Reads/
    // writes via getOrgPg (admin, RLS-bypass) like the rest of operator-state.
    // Best-effort — a cache failure must never break ingest/listing.
    loadCache: async () => {
      const row = await readOperatorState<{ hives: DiscoveredHive[] }>('pot_directory_cache').catch(
        () => null,
      );
      return row?.hives ?? [];
    },
    saveCache: async (hives) => {
      await writeOperatorState('pot_directory_cache', { hives }).catch(() => {});
    },
    // P-004 (hardening): fresh members/links on every announce build. Lazy
    // import keeps this module light; the enricher is best-effort internally.
    enrichDescriptor: async (desc) =>
      (await import('./hive-descriptor-enrich')).enrichLocalHiveDescriptor(desc),
    // P-005 (hardening): withdrawal tombstones persist beside the offline
    // cache so a reboot can't resurrect a withdrawn hive from it.
    loadTombstones: async () => {
      const row = await readOperatorState<{ tombstones: Record<string, number> }>(
        'pot_directory_tombstones',
      ).catch(() => null);
      return row?.tombstones ?? {};
    },
    saveTombstones: async (tombstones) => {
      await writeOperatorState('pot_directory_tombstones', { tombstones }).catch(() => {});
    },
    // P-014 item 2: capture beacon history for the tier-4 dossier. Lazy-import
    // keeps this module from pulling in PG at startup; the capture itself is
    // already best-effort (the directory wraps it in a catch).
    onBeaconAccepted: async (potId, hivePubkey, beacon) => {
      const { captureBeaconSnapshot } = await import('./network-board/beacon-history-pg');
      await captureBeaconSnapshot(potId, hivePubkey, beacon);
    },
  };
}

/** The process singleton the operator endpoint reads + the boot path feeds. */
export function getHiveDirectory(): HiveDirectory {
  if (!_singleton) _singleton = new HiveDirectory(productionDeps());
  return _singleton;
}

/** Test seam: install a directory built over fake deps + clear the transport. */
export function configureHiveDirectoryForTest(deps: HiveDirectoryDeps): HiveDirectory {
  _singleton = new HiveDirectory(deps);
  _transport = null;
  _keychainId = null;
  return _singleton;
}

/** Test seam: drop the singleton so the next getHiveDirectory rebuilds it. */
export function __resetHiveDirectorySingleton(): void {
  _singleton = null;
  _transport = null;
  _keychainId = null;
}
