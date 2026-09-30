/**
 * work-item-claim-authority seam — the HIVE-scoped claim router.
 *
 * Plan: decentralized-dispatch-scaling-2026-06-08 (Phase 1, D-002).
 *
 * A work-item CLAIM is mutual exclusion across the Swarms of a Hive, so it is
 * AUTHORITY-MEDIATED, never federated: the per-HIVE lock authority (the
 * lowest-live-device-pubkey peer — `lockAuthorityForHive`, shared-hive-federation
 * P-009 / mig 187) is the single serialization point. This module is the seam the
 * work-item-claims store routes through; it does NOT rebuild the authority election.
 *
 * Distinct from the plan-item claim-authority seam (`plan-items/claim-authority.ts`),
 * which routes by HARNESS slug → the per-harness authority. This one routes by HIVE
 * slug → the per-Hive authority, because the dispatch backlog is Hive-scoped (D-009).
 * Keeping them separate avoids overloading one seam's scope key with two meanings
 * (harness vs Hive), so the real Track B router can be installed for each
 * independently.
 *
 * On a single box there is exactly one peer, so the authority is always self and
 * every op runs locally (`LocalWorkItemClaimAuthority`). When the cross-Swarm mesh
 * transport lands (shared-hive-federation Track B's live cutover), `setWorkItemClaimAuthority()`
 * installs the real resolver (`lockAuthorityForHive()` + RPC routing) with ZERO
 * changes to the claim store — the store only ever calls
 * `getWorkItemClaimAuthority().route(potSlug, op)`.
 *
 * The op carried is the shared `AuthorityOp<T>` shape (`{ local, remote? }`): the
 * `local` leg runs against THIS peer's store (used when we are the authority OR on
 * fail-open — D-007's tolerate-and-reconcile branch); the serialisable `remote`
 * envelope (`{ kind, payload, decode }`) is what a REMOTE authority re-runs on our
 * behalf over the peer-RPC transport (registered via work-item-claim-authority-ops.ts).
 */
import type { AuthorityOp } from './authority';

export interface WorkItemClaimAuthority {
  /** True if this peer is the claim authority for the Hive. Single box → always true. */
  isSelf(potSlug: string): Promise<boolean>;
  /** Run a claim op AT the authority: `op.local()` when isSelf, else RPC `op.remote` to the authority peer. */
  route<T>(potSlug: string, op: AuthorityOp<T>): Promise<T>;
}

/** The single-peer / single-box authority: this peer is always the authority. */
export class LocalWorkItemClaimAuthority implements WorkItemClaimAuthority {
  async isSelf(_potSlug: string): Promise<boolean> {
    return true;
  }
  async route<T>(_potSlug: string, op: AuthorityOp<T>): Promise<T> {
    return op.local();
  }
}

let current: WorkItemClaimAuthority = new LocalWorkItemClaimAuthority();

/** The active work-item claim authority router. The claim store calls this. */
export function getWorkItemClaimAuthority(): WorkItemClaimAuthority {
  return current;
}

/** Install a real (multi-peer, Hive-scoped) authority router — Track B's swap-in point. */
export function setWorkItemClaimAuthority(authority: WorkItemClaimAuthority): void {
  current = authority;
}

/** Reset to the single-peer local authority (tests / teardown). */
export function resetWorkItemClaimAuthority(): void {
  current = new LocalWorkItemClaimAuthority();
}
