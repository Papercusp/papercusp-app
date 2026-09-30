-- 191-work-item-swarm-affinity.sql
-- hive-coordination-model-2026-06-08 P-002 — the Queen's co-location lever.
--
-- A work-item may carry a SWARM AFFINITY: the device-pubkey of the Swarm its
-- tightly-coupled work should run on (so collaborators co-locate on one instance,
-- where coordination is instant, instead of paying cross-Swarm federation latency).
-- NULL = no affinity (free-for-all; any Swarm may claim it — today's behavior).
--
-- The affinity is HONORED by `work_items:claim_next` ONLY when the per-Hive claim
-- lease is active (PAPERCUSP_WORKITEM_CLAIM_LEASE=1, the owner's default-OFF switch):
-- a Swarm then skips work affined to a DIFFERENT Swarm and prefers work affined to
-- itself. With the flag OFF (single-instance default) the column is inert — the claim
-- path never reads it — so this migration is a pure additive no-op until multi-Swarm
-- is activated. See packages/operator-core/lib/work-items.ts (claimNextWorkItem) +
-- fleet/co-location.ts.

ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS swarm_affinity text;

COMMENT ON COLUMN harness_shared.harness_features_consolidated.swarm_affinity IS
  'Co-location affinity (hive-coordination-model P-002): device-pubkey of the Swarm this work should run on. NULL = no affinity. Honored by claim_next only when PAPERCUSP_WORKITEM_CLAIM_LEASE=1.';
