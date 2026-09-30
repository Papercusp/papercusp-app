/**
 * Boot wiring — register the work-item REPLICA authority ops (the receiving side
 * of a cross-Swarm redundancy RPC). EI-266 — the BOINC analog of
 * register-claim-authority-ops.ts.
 *
 * Imported once from the agent-tools barrel (a side-effecting import). Registers
 * the `work-item.replica.{claim-slot,heartbeat,release,record-result,list,judge}`
 * handlers so that when a peer routes a replica op to THIS machine as the per-Hive
 * authority, the op runs against the local `work_item_replicas` store — which is
 * what makes the N replicas of a high-stakes item MEET in one place. Idempotent;
 * the handlers only touch PG when actually invoked by an inbound RPC.
 *
 * The production multi-peer ROUTER (`SwarmWorkItemReplicaAuthority`) is installed
 * ONLY when redundancy is enabled (`PAPERCUSP_WORKITEM_REDUNDANCY=1`) — off → the
 * store's default `LocalWorkItemReplicaAuthority` stays (single-box correct; tests
 * deterministic). Redundancy is off by default, so this is byte-identical at boot.
 */
import { registerWorkItemReplicaAuthorityOps } from '../../work-item-replica-authority-ops';
import { installSwarmWorkItemReplicaAuthority } from '../../work-item-replica-authority-swarm';
import { workItemRedundancyEnabled } from '../../work-item-redundancy';

registerWorkItemReplicaAuthorityOps();

if (workItemRedundancyEnabled()) {
  installSwarmWorkItemReplicaAuthority();
}
