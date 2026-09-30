/**
 * Swarm-backed work-item REPLICA authority — rides the per-Hive lock authority
 * (EI-266; the redundancy analog of work-item-claim-authority-swarm.ts).
 *
 * Installs the REAL multi-peer authority behind the redundancy store's
 * `WorkItemReplicaAuthority` seam, so every replica op (claim-slot / heartbeat /
 * release / record-result / list / judge) serializes through the Hive's single
 * serialization point — the lowest-live-device-pubkey Swarm of the Hive
 * (`lockAuthorityForHive`) — and lands in that one peer's `work_item_replicas`
 * table. That is what makes cross-swarm replicas MEET (without it each separate-PG
 * swarm writes its own table and the judge sees one replica).
 *
 * `routeToAuthorityForHive` runs `op.local()` when we are the authority (single box
 * → always), RPCs the authority peer when a remote authority + transport + `op.remote`
 * exist, and FAILS OPEN to a local op + warning otherwise (D-004's tolerate branch).
 *
 * NOT installed at module load — like work-item claims (and unlike plan-items),
 * redundancy is opt-in (`PAPERCUSP_WORKITEM_REDUNDANCY`) and has no live caller at
 * boot. `installSwarmWorkItemReplicaAuthority()` is called at the same flag-gated
 * cutover that installs the claim authority + wires the transport, so the router
 * goes live exactly when redundant work starts flowing. Until then the default
 * `LocalWorkItemReplicaAuthority` is correct (single box → authority is always self).
 */
import { routeToAuthorityForHive, type LockAuthorityDeps } from './authority/lock-authority';
import type { AuthorityOp } from './authority';
import { setWorkItemReplicaAuthority, type WorkItemReplicaAuthority } from './work-item-replica-authority';

export class SwarmWorkItemReplicaAuthority implements WorkItemReplicaAuthority {
  constructor(private readonly deps: LockAuthorityDeps = {}) {}

  async isSelf(potSlug: string): Promise<boolean> {
    const res = await routeToAuthorityForHive<boolean>(potSlug, { local: async () => true }, this.deps);
    return res.via === 'local-authority';
  }

  async route<T>(potSlug: string, op: AuthorityOp<T>): Promise<T> {
    const res = await routeToAuthorityForHive<T>(potSlug, op, this.deps);
    if (res.warning) {
      // Fail-open (cross-machine, no transport / unreachable): the op ran locally
      // and the redundancy group may transiently split until the authority is
      // reachable again. Surface the warning (D-004). On a single box never fires.
       
      console.warn(`[work-item-replica] authority fail-open for hive ${potSlug}: ${res.warning}`);
    }
    return res.value;
  }
}

let installed = false;

/**
 * Install the swarm-backed replica authority (idempotent). Called at the
 * flag-gated redundancy cutover, NOT at boot — see the file header.
 */
export function installSwarmWorkItemReplicaAuthority(deps: LockAuthorityDeps = {}): void {
  if (installed) return;
  installed = true;
  setWorkItemReplicaAuthority(new SwarmWorkItemReplicaAuthority(deps));
}

/** Test seam: allow re-install (the module-level guard otherwise blocks a second call). */
export function __resetSwarmWorkItemReplicaAuthorityForTests(): void {
  installed = false;
}
