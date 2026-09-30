-- 470: p2p_foreign_workspaces.base_sha — the canonical sha the foreign clone
-- was provisioned FROM (p2p-work-distribution-2026-07-02 P-109 leg iii).
--
-- WHY: the publish admission (foreign-publish.ts → quarantineFetchAndJudge)
-- judges the FOREIGN-INTRODUCED commit range. Without a durable range anchor,
-- a first publish into an empty per-scope repo judges the clone's FULL
-- history — including canonical host-authored base commits, which are outside
-- the offer's origin chain — and refuses everything (fail-closed, but wrong).
-- The provision step (foreign-clone.ts) records HEAD at clone time here; the
-- publish wiring anchors the admission range on it. base_sha is an
-- ALREADY-ADMITTED canonical sha by construction (it was the canonical tip
-- the host cloned), so excluding what it reaches never exempts foreign work.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); nullable — pre-470 rows and refused
-- clones have no base; consumers treat NULL as "no anchor" (full-history
-- judgment, the fail-closed direction).
ALTER TABLE harness_shared.p2p_foreign_workspaces
  ADD COLUMN IF NOT EXISTS base_sha text;
