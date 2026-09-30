/**
 * swarm-keypair — persistence for the SHARED PROCESS Hyperswarm's transport
 * identity (EI-18683526122026208, p2p-public-release-remaining-lanes-2026-07-16).
 *
 * `getSharedSwarm()` (swarm.ts) previously constructed `new Swarm({ maxPeers,
 * bootstrap|dht, firewall })` with no `keyPair`/`seed` — hyperswarm's own
 * constructor then does `keyPair = DHT.keyPair(seed)` with `seed` undefined,
 * which mints a CRYPTOGRAPHICALLY RANDOM keypair. `getSharedSwarm()` is a
 * per-process singleton that is never rehydrated from disk, so every process
 * boot minted a brand-new transport identity — continuity across a restart
 * (reputation, allow-listing, resuming a known peering) was structurally
 * impossible. This module makes that identity SURVIVE a restart by persisting
 * a 32-byte seed and reusing it.
 *
 * SCOPE DECISION (flagged in the bug as "a real design decision, not a
 * mechanical change" — resolved here): `getSharedSwarm()` is documented as
 * "ONE Hyperswarm for the entire process", shared across every harness/hive
 * that process serves — so the identity is scoped PER MACHINE (mirroring the
 * device keypair's `machineFingerprint()`, device-keychain-id.ts), not per
 * workspace or per hive. A workspace/hive-scoped identity would be wrong here:
 * the swarm this module identifies is a single transport shared by ALL hives
 * on the box, so keying it to any one of them is arbitrary and would still
 * collide across the others.
 *
 * KNOWN LIMITATION, accepted rather than solved here: this dev box runs TWO
 * operator processes (`:3070` release, `:3170` staging) that would otherwise
 * resolve the SAME machine-fingerprint id and mint/load the identical seed.
 * In practice this is harmless — the release process joins the PUBLIC DHT
 * (no `PAPERCUSP_DHT_BOOTSTRAP`) while staging joins an ISOLATED bootstrap
 * DHT (`PAPERCUSP_DHT_BOOTSTRAP` set), so the two never share a routing
 * graph and an identical keypair on each never actually collides on the wire.
 * A real single-process production deployment (the actual release target)
 * never hits this at all. `PAPERCUSP_SWARM_IDENTITY_ID` is provided as an
 * explicit escape hatch should a future topology need distinct per-process
 * identities on one machine.
 */

import { keychainStore, keychainLoad } from './keychain';
import { machineFingerprint } from './device-keychain-id';

/** OS-keychain / encrypted-file service namespace for the swarm transport
 *  identity — distinct from the device key's `papercusp-device-keypair` and
 *  the hive key's `papercusp-hive-keypair` (keychain.ts's serviceName
 *  namespacing). */
export const SWARM_KEYPAIR_SERVICE = 'papercusp-swarm-keypair';

const SEED_LEN = 32;

/**
 * The keychainId the swarm's persisted seed is stored/looked-up under.
 * `PAPERCUSP_SWARM_IDENTITY_ID` overrides the default machine-fingerprint id
 * (escape hatch for a future multi-instance-per-machine topology — see the
 * module header's KNOWN LIMITATION).
 */
export function swarmIdentityKeychainId(input?: { hostname?: string; username?: string }): string {
  const override = process.env.PAPERCUSP_SWARM_IDENTITY_ID?.trim();
  if (override) return `swarm:${override}`;
  return `swarm:${machineFingerprint(input)}`;
}

/**
 * Load the persisted 32-byte swarm identity seed, or generate + persist one
 * on first call. Idempotent: repeated calls on the same machine (or same
 * `PAPERCUSP_SWARM_IDENTITY_ID`) always return the same seed, so the
 * Hyperswarm/hyperdht keypair derived from it (`DHT.keyPair(seed)`) is stable
 * across process restarts.
 */
export async function loadOrGenerateSwarmSeed(): Promise<Buffer> {
  const keychainId = swarmIdentityKeychainId();
  const loaded = await keychainLoad(keychainId, SWARM_KEYPAIR_SERVICE);
  if (loaded.kind === 'ok' && loaded.value.length === SEED_LEN) {
    return loaded.value;
  }
  // Missing OR a wrong-length blob (never expected in practice — defensive,
  // matches the mint-on-miss idiom in hive-keypair.ts) — mint a fresh seed.
  const { randomBytes } = await import('node:crypto');
  const seed = randomBytes(SEED_LEN);
  await keychainStore(keychainId, seed, SWARM_KEYPAIR_SERVICE);
  return seed;
}
