-- 1199 — index the acceptance-drain filing key on work_items (WI-10002538).
--
-- Every acceptance-drain filing stamps `payload.acceptanceDrainPlan` with the
-- plan's fully-qualified ref (workspace/harness/plan), and three readers look
-- rows up by it: system-health's readAcceptanceDrainVisibility (one LATERAL
-- probe per awaiting-acceptance plan), the filing dedupe in
-- acceptance-drain-filing.ts, and the acceptance-drain sweep. No index covered
-- the expression, so each probe was a sequential scan of the workspace's whole
-- work_items table. Measured 2026-09-23: on the tower, 223 awaiting plans x
-- 225,547 rows kept one readAcceptanceDrainVisibility instance running for 86.9s
-- (bg-host). On the P-203 rig VM (45 plans x 249,717 rows) it held one Postgres
-- backend continuously active, a full core taken from the peer-log fold.
--
-- Only filings carry the key (264 of 225,547 rows on the tower), so the index is
-- PARTIAL on `IS NOT NULL` and costs almost nothing to maintain. Every lookup is
-- an equality `payload->>'acceptanceDrainPlan' = <ref>`, and because the
-- operator is strict the planner proves the predicate from it, including for
-- readAcceptanceDrainVisibility's LATERAL join clause. The index-served test in
-- system-health/acceptance-drain-visibility.integration.test.ts EXPLAINs the
-- production SQL against this file to pin that.
--
-- The migration runner supplies the transaction; no BEGIN/COMMIT here.

CREATE INDEX IF NOT EXISTS work_items_acceptance_drain_plan_idx
  ON harness_shared.work_items (workspace_id, (payload->>'acceptanceDrainPlan'))
  WHERE (payload->>'acceptanceDrainPlan') IS NOT NULL;
