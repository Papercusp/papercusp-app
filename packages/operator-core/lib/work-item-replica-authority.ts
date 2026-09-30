/**
 * work-item-replica-authority seam — the HIVE-scoped redundancy-replica router
 * (EI-266; the BOINC-redundancy analog of work-item-claim-authority.ts).
 *
 * A redundancy REPLICA SLOT is mutual exclusion across the Swarms of a Hive (up
 * to N distinct Swarms each hold a DISTINCT slot of the same high-stakes item),
 * and the judge that picks the winner needs every replica in ONE place. Like the
 * work-item CLAIM, that makes it AUTHORITY-MEDIATED, never federated: the per-Hive
 * lock authority (`lockAuthorityForHive`) is the single serialization point and the
 * single home for the `work_item_replicas` table. Without this routing the store is
 * local-PG only — on two separate-PG swarms each grabs replica_index 0 of its OWN
 * table, the replicas never meet, and judge sees one complete replica
 * ('insufficient-replicas'). That is the exact gap EI-266 reports.
 *
 * Distinct from the work-item CLAIM seam (one live grip per item) — this serializes
 * the N SLOTS of a redundancy group — but the routing shape is identical: the store
 * only ever calls `getWorkItemReplicaAuthority().route(potSlug, op)`, and on a
 * single box the default `LocalWorkItemReplicaAuthority` runs every op locally
 * (byte-identical to the pre-routing behavior). When the cross-Swarm mesh transport
 * lands, `setWorkItemReplicaAuthority()` installs the real resolver
 * (`lockAuthorityForHive()` + RPC routing — `work-item-replica-authority-swarm.ts`)
 * with ZERO changes to the store. The op the store carries is the shared
 * `AuthorityOp<T>` shape (`{ local, remote? }`); the remote envelope is re-run on the
 * authority via the handlers in `work-item-replica-authority-ops.ts`.
 */
import type { AuthorityOp } from './authority';

export interface WorkItemReplicaAuthority {
  /** True if this peer is the replica authority for the Hive. Single box → always true. */
  isSelf(potSlug: string): Promise<boolean>;
  /** Run a replica op AT the authority: `op.local()` when isSelf, else RPC `op.remote` to the authority peer. */
  route<T>(potSlug: string, op: AuthorityOp<T>): Promise<T>;
}

/** The single-peer / single-box authority: this peer is always the authority. */
export class LocalWorkItemReplicaAuthority implements WorkItemReplicaAuthority {
  async isSelf(_potSlug: string): Promise<boolean> {
    return true;
  }
  async route<T>(_potSlug: string, op: AuthorityOp<T>): Promise<T> {
    return op.local();
  }
}

let current: WorkItemReplicaAuthority = new LocalWorkItemReplicaAuthority();

/** The active replica authority router. The redundancy store calls this. */
export function getWorkItemReplicaAuthority(): WorkItemReplicaAuthority {
  return current;
}

/** Install a real (multi-peer, Hive-scoped) authority router — the Track-B swap-in point. */
export function setWorkItemReplicaAuthority(authority: WorkItemReplicaAuthority): void {
  current = authority;
}

/** Reset to the single-peer local authority (tests / teardown). */
export function resetWorkItemReplicaAuthority(): void {
  current = new LocalWorkItemReplicaAuthority();
}
