/**
 * Swarm-backed claim authority — rides the per-harness lock authority (Track B).
 *
 * Plan: plan-item-assignment-claim-liveness-2026-06-04 (Phase 1).
 *
 * This installs the REAL multi-peer authority (distributed-coordination-shared-
 * harness-2026-06-04, su-584a8) behind the claim store's `ClaimAuthority` seam, so
 * plan-item claim leases serialize through the same single-serialization-point as
 * file-claim locks: `routeToAuthority(harness, { local, remote? })` runs locally when
 * we are the authority (single box → always), RPCs the authority peer when a remote
 * authority + transport + `remote` envelope exist, and FAILS OPEN to a local lease +
 * a warning otherwise (D-004 — git-merge is the data-safety backstop). The claim
 * store now supplies the `remote` envelope per op, so claims gain the cross-peer leg
 * automatically — this class just forwards the whole `AuthorityOp` through.
 *
 * Kept OUT of claim-authority.ts (which stays dependency-free for tests). Installed
 * once from the plan-items tool barrel so production uses the swarm authority while
 * unit/integration tests of the stores keep the pure LocalClaimAuthority default.
 * The optional `deps` seam lets a two-instance test inject a deterministic roster
 * (the same `LockAuthorityDeps` su-584a8's two-instance-authority test uses).
 */
import { routeToAuthority, type LockAuthorityDeps, type AuthorityOp } from '../authority';
import { setClaimAuthority, type ClaimAuthority } from './claim-authority';

export class SwarmClaimAuthority implements ClaimAuthority {
  constructor(private readonly deps: LockAuthorityDeps = {}) {}

  async isSelf(harnessSlug: string): Promise<boolean> {
    // Probe via a no-op route: `via:'local-authority'` ⇔ we are the authority.
    const res = await routeToAuthority<boolean>(harnessSlug, { local: async () => true }, this.deps);
    return res.via === 'local-authority';
  }

  async route<T>(harnessSlug: string, op: AuthorityOp<T>): Promise<T> {
    const res = await routeToAuthority<T>(harnessSlug, op, this.deps);
    if (res.warning) {
      // Fail-open (cross-machine, no transport): the lease was taken locally and git
      // is the backstop. Surface the warning (D-004). On a single box this never fires.
       
      console.warn(`[plan-item-claim] authority fail-open for ${harnessSlug}: ${res.warning}`);
    }
    return res.value;
  }
}

let installed = false;

/** Install the swarm-backed claim authority (idempotent). Called from the tool barrel. */
export function installSwarmClaimAuthority(): void {
  if (installed) return;
  installed = true;
  setClaimAuthority(new SwarmClaimAuthority());
}
