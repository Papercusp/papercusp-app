/**
 * Boot wiring — register the work-item claim AUTHORITY ops (the receiving side of a
 * cross-Swarm claim RPC). decentralized-dispatch-scaling-2026-06-08 P-004 / D-002.
 *
 * Imported once from the agent-tools barrel (a side-effecting import, mirroring how
 * `agent-tools/plan-items/index.ts` calls `registerPlanItemClaimAuthorityOps()`). This
 * registers the `work-item.claim.{acquire,heartbeat,release}` handlers so that when a
 * peer routes a work-item claim to THIS machine as the per-Hive authority, the op runs
 * against the local lease store. Idempotent; safe before migration 188 applies (the
 * handlers only touch PG when actually invoked by an inbound RPC).
 *
 * ALSO installed here (fed-reanchor P-060; this header previously said "not installed"
 * and lied — cross-machine-coord-parity-and-trust-2026-07-01 P-017): the production
 * multi-peer ROUTER (`installSwarmWorkItemClaimAuthority`), gated on the
 * WORKITEM_CLAIM_LEASE flag (DEFAULT ON since WI-597) — see the conditional below.
 * When the flag is off the store's default `LocalWorkItemClaimAuthority` is correct
 * (single box → authority is always self).
 */
import { registerWorkItemClaimAuthorityOps } from '../../work-item-claim-authority-ops';
import { installSwarmWorkItemClaimAuthority } from '../../work-item-claim-authority-swarm';
import { workItemClaimLeaseEnabled } from '../../work-item-claim-lease-wiring';

registerWorkItemClaimAuthorityOps();

// Install the production multi-peer Hive router ONLY when the owner has flipped the
// ratification switch (the WORKITEM_CLAIM_LEASE flag, D-007/P-001). Off → the store's
// default LocalWorkItemClaimAuthority stays (single-box correct; tests stay deterministic).
if (workItemClaimLeaseEnabled()) {
  installSwarmWorkItemClaimAuthority();
}
