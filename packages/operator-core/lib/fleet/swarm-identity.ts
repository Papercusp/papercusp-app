/**
 * swarm-identity — resolve THIS instance's Swarm id (hive-coordination-model P-002).
 *
 * A **Swarm** is a deployment of a Hive to one instance. Its stable identity is the
 * per-harness device pubkey (the Hyperbee own-log `keyHex`, the same id the claim/lock
 * authority elects on) — see resolveMyPubkey / getBootedHarness. A harness that isn't
 * federated (private / local-only / substrate not booted) has no pubkey; there is then
 * exactly ONE Swarm — the local instance — so we return the stable `'local'` sentinel.
 *
 * This is the id stamped as a work-item's `swarm_affinity` (co-location lever) and the
 * id a Swarm matches itself against when honoring that affinity in `claim_next`.
 */
import { getBootedHarness } from '../sync/hyperbee/boot-all';
import { resolveMyPubkey } from '../orchestrator/distributed-claim';

/** The single-instance Swarm sentinel — used when a harness has no federated pubkey. */
export const LOCAL_SWARM = 'local';

/**
 * The local Swarm id for a (workspace, harness): the harness device pubkey when the
 * substrate is booted + federated, else `'local'`. Never throws — a resolution failure
 * collapses to `'local'` (the safe single-Swarm answer).
 */
export function localSwarmId(workspaceId: string, harnessSlug: string): string {
  try {
    const booted = getBootedHarness(workspaceId, harnessSlug);
    const pubkey = booted ? resolveMyPubkey(booted) : null;
    return pubkey && pubkey.length > 0 ? pubkey : LOCAL_SWARM;
  } catch {
    return LOCAL_SWARM;
  }
}
