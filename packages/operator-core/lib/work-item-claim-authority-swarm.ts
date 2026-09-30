/**
 * Swarm-backed work-item claim authority — rides the per-HIVE lock authority (P-009).
 *
 * Plan: decentralized-dispatch-scaling-2026-06-08 (Phase 1, P-004 / D-002).
 *
 * Installs the REAL multi-peer authority behind the work-item-claims store's
 * `WorkItemClaimAuthority` seam, so a work-item claim lease serializes through the
 * Hive's single serialization point — the lowest-live-device-pubkey Swarm of the Hive
 * (`lockAuthorityForHive`, shared-hive-federation P-009). Mirrors
 * `plan-items/claim-authority-swarm.ts` exactly, but Hive-scoped: it forwards through
 * `routeToAuthorityForHive` (the Hive analog of `routeToAuthority`, landed by the
 * federation team + proven by two-instance-hive-authority.integration.test.ts) instead
 * of the per-harness `routeToAuthority`.
 *
 * `routeToAuthorityForHive` runs `op.local()` when we are the authority (single box →
 * always), RPCs the authority peer when a remote authority + transport + `op.remote`
 * exist, and FAILS OPEN to a local advisory lease + a warning otherwise — D-007's
 * tolerate-and-reconcile branch (work-item-claim-reconcile.ts, P-005, is the backstop).
 *
 * NOT installed at module load. Unlike plan-items (whose claims are live), work-item
 * claims have no live caller yet — `work_items:claim_next` is re-pointed through the
 * lease only at the flag-gated cutover (P-006, gated on the P-001 consistency-mode
 * ratification). `installSwarmWorkItemClaimAuthority()` is called THERE, together with
 * the wiring, so the production router goes live exactly when claims start flowing and
 * after the presence-write `hive_slug` keystone lands. Until then the store's default
 * `LocalWorkItemClaimAuthority` is correct (single box → authority is always self).
 */
import { routeToAuthorityForHive, type LockAuthorityDeps } from './authority/lock-authority';
import type { AuthorityOp } from './authority';
import { setWorkItemClaimAuthority, type WorkItemClaimAuthority } from './work-item-claim-authority';

export class SwarmWorkItemClaimAuthority implements WorkItemClaimAuthority {
  constructor(private readonly deps: LockAuthorityDeps = {}) {}

  async isSelf(potSlug: string): Promise<boolean> {
    // Probe via a no-op route: `via:'local-authority'` ⇔ we are the Hive authority.
    const res = await routeToAuthorityForHive<boolean>(potSlug, { local: async () => true }, this.deps);
    return res.via === 'local-authority';
  }

  async route<T>(potSlug: string, op: AuthorityOp<T>): Promise<T> {
    const res = await routeToAuthorityForHive<T>(potSlug, op, this.deps);
    if (res.warning) {
      // Fail-open (cross-machine, no transport / unreachable): the lease was taken
      // locally and the P-005 reconcile is the backstop. Surface the warning (D-007).
      // On a single box this never fires.
       
      console.warn(`[work-item-claim] authority fail-open for hive ${potSlug}: ${res.warning}`);
    }
    return res.value;
  }
}

let installed = false;

/**
 * Install the swarm-backed work-item claim authority (idempotent). Called at the
 * flag-gated claim_next→lease cutover (P-006), NOT at boot — see the file header.
 */
export function installSwarmWorkItemClaimAuthority(deps: LockAuthorityDeps = {}): void {
  if (installed) return;
  installed = true;
  setWorkItemClaimAuthority(new SwarmWorkItemClaimAuthority(deps));
}
