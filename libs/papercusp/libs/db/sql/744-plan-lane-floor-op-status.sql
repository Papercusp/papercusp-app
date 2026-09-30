-- 744-plan-lane-floor-op-status.sql — EI-19409397800537963
--
-- Re-point the SQL claim-floor SSOT's reserved-plan-lane floor (#11) at the OPERATIONAL
-- plan axis, and scope its subqueries to the item's own tenant. This is the SQL half of a
-- two-part fix; the TS half is `reservedPlanLaneExclusionSql` in
-- packages/operator-core/lib/work-items.ts, and the two are bound by
-- lib/scheduler/claim-ssot-agreement.integration.test.ts. Landing only one half is exactly
-- the drift that test exists to catch.
--
-- WHAT WAS WRONG (measured on live papercusp, 2026-08-03):
--
--   * Floor #11 asked `harness_plans.status = 'active'`. That is the LIFECYCLE axis
--     (draft/ready/active/shipped/superseded — see harness_plans_status_check). The axis
--     that says a plan is UNDER EXECUTION is `op_status` (started/paused/done), which is
--     what plans:start and plans:pause actually write; plans:start only READS `status`, to
--     refuse a terminal plan, and never sets it. So a started plan normally sits at
--     status='ready' and this floor scored it as unreserved.
--
--     Of 16 plans at op_status='started', only 2 were also status='active'. Of 83 open
--     plan-bound work-items, 19 were reserved where 51 should have been — 31 items on 12
--     genuinely-running plans were fully self-selectable. That is the claim -> refuse ->
--     re-serve churn WI-2118 built this floor to stop (WI-6292 was handed to two different
--     agents within one hour, ~20 minutes lost each).
--
--     'paused' reserves for the same reason plans:pause exists: its documented contract is
--     "no new features are picked until plans:start". The orchestrator frontier
--     (dbos/orchestrator-loop.ts) already honored op_status; only the scheduler self-select
--     path did not, so pausing a plan stopped one dispatcher while the other kept handing
--     the same work out.
--
--   * Both subqueries matched on `plan_slug` ALONE. harness_plans and plan_item_claims are
--     keyed (workspace_id, harness_slug, plan_slug[, item_id]), and 7 plan slugs currently
--     exist in 3 different workspaces — so a foreign tenant's row could decide a local
--     item's claimability. (workspace_id, plan_slug) is unique across the whole table (0
--     duplicates), so scoping on the workspace alone is exact. It deliberately does NOT also
--     key on harness_slug: migration 656 canonicalized plan harness slugs without rewriting
--     the payload.plan_item back-pointers, so those disagree with the plan row for real items
--     (e.g. WI-5751 carries 'oddsmith' for a plan row now at 'oddsmith-hive') and keying on
--     them would silently un-reserve live lanes.
--
-- The `status = 'active'` leg is RETAINED, not replaced: 199 plans sit at status='active'
-- with op_status NULL, and dropping it would newly un-reserve their lanes. Union semantics
-- strictly widen reservation, so nothing reserved before this migration becomes claimable
-- after it.
--
-- SIGNATURE CHANGE: the function gains a leading p_workspace_id. Every other floor is
-- byte-identical to migration 654 — only #11 changes. Idempotent: DROP the view + every
-- prior signature, then CREATE fresh (same shape as 654).

DROP VIEW IF EXISTS harness_shared.work_items_claimable;
-- 10-arg (an early cut of 654 carried an own-node self-join):
DROP FUNCTION IF EXISTS harness_shared.work_item_claim_floors(text, text, text, text, text, text, text, jsonb, text, text);
-- 8-arg (654's shipped signature — the one this migration replaces):
DROP FUNCTION IF EXISTS harness_shared.work_item_claim_floors(text, text, text, text, text, text, jsonb, text);
-- 9-arg (idempotent re-run of THIS migration):
DROP FUNCTION IF EXISTS harness_shared.work_item_claim_floors(text, text, text, text, text, text, text, jsonb, text);

CREATE FUNCTION harness_shared.work_item_claim_floors(
  p_workspace_id            text,
  p_status                  text,
  p_taken_by                text,
  p_origin                  text,
  p_title                   text,
  p_terminal_owner          text,
  p_terminal_completion_ref text,
  p_payload                 jsonb,
  p_feature_id              text
) RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  -- One label per VIOLATED floor; array_remove drops the NULLs (satisfied floors), so an
  -- all-satisfied row returns '{}' (= claimable). Order mirrors claimNextIssueWorkItem.
  SELECT array_remove(ARRAY[
    -- 1. claimable status = 'open' (ISSUE_FAMILY_CLAIMABLE_STATES) — terminal/blocked/wip excluded.
    CASE WHEN p_status IS DISTINCT FROM 'open' THEN 'not-open' END,
    -- 2. unclaimed — taken_by null / blank / 'unassigned'.
    CASE WHEN NOT (p_taken_by IS NULL OR btrim(p_taken_by) = '' OR lower(btrim(p_taken_by)) = 'unassigned')
         THEN 'taken' END,
    -- 3. locally claimable — fail-safe origin form (origin local/null; the own-node drift-recovery
    --    leg is applied by the scheduler with its live workspace context, not baked into this view).
    CASE WHEN NOT (p_origin IS NULL OR p_origin = 'local') THEN 'federated-remote' END,
    -- 4. claim-hold (payload._claimHold) — a peer parked it out of self-select (still claimable BY ID).
    CASE WHEN COALESCE(p_payload, '{}'::jsonb) ->> '_claimHold' = 'true' THEN 'claim-hold' END,
    -- 5. observation-lane (D-005) — a reflection/scorecard that "never enters the work queue".
    CASE WHEN COALESCE(p_payload, '{}'::jsonb) ->> 'lane' = 'observation' THEN 'observation-lane' END,
    -- 6. needsHuman (EI-7776) — improvements:resolve routed it to a human (owner inbox), not the pool.
    CASE WHEN COALESCE(p_payload, '{}'::jsonb) ->> 'needsHuman' = 'true' THEN 'needs-human' END,
    -- 7. active typed external blocker (queue gate).
    CASE WHEN jsonb_path_exists(COALESCE(p_payload, '{}'::jsonb),
                                '$.externalBlockers[*] ? (@.status == "active")'::jsonpath)
         THEN 'external-blocker' END,
    -- 8. federation-liveness detector EI (WI-2633) — a generic drainer structurally can't action it.
    CASE WHEN COALESCE(p_payload, '{}'::jsonb) #>> '{_ei,created_by}' = 'system:replication-liveness'
         THEN 'federation-detector' END,
    -- 9. loop-iteration bookkeeping noise (EI-8802) — a misfiled loop:checkpoint marker.
    CASE WHEN COALESCE(p_title, '') ILIKE 'Loop wake #%' OR COALESCE(p_title, '') ILIKE 'AUTO loop iteration:%'
         THEN 'loop-iteration-noise' END,
    -- 10. already terminally completed (EI-8972) — terminal_owner + ref set even though `status` was
    --     never flipped terminal; a peer already finished/diagnosed it.
    CASE WHEN (p_terminal_owner IS NOT NULL AND p_terminal_owner <> '')
          AND (p_terminal_completion_ref IS NOT NULL AND p_terminal_completion_ref <> '')
         THEN 'already-terminally-completed' END,
    -- 11. reserved to a plan lane UNDER EXECUTION / a LIVE plan_item_claims lease.
    --     EI-19409397800537963: "under execution" is op_status (started/paused — the axis
    --     plans:start and plans:pause write), UNION the legacy lifecycle status='active' leg,
    --     which is retained so no lane reserved before that fix becomes claimable after it.
    --     Both subqueries are tenant-scoped on workspace_id: (workspace_id, plan_slug) is
    --     unique, and harness_slug is deliberately NOT part of the key (the plan_item
    --     back-pointer's copy drifted from the plan row in migration 656). op_status is
    --     nullable, but a NULL only makes the IN NULL and leaves the row unmatched by EXISTS
    --     — i.e. not reserved — which is the intended reading for a never-started plan.
    --     No owner-exemption: a generic "claimable by anyone" read; the claiming agent's
    --     own-lease exemption is caller-context and stays in the TS path.
    --     MUST stay in step with reservedPlanLaneExclusionSql (work-items.ts).
    CASE WHEN COALESCE(p_payload, '{}'::jsonb) ? 'plan_item' AND (
           EXISTS (SELECT 1 FROM harness_shared.harness_plans hp
                    WHERE hp.workspace_id = p_workspace_id
                      AND hp.plan_slug = p_payload->'plan_item'->>'plan_slug'
                      AND (hp.op_status IN ('started', 'paused') OR hp.status = 'active'))
           OR EXISTS (SELECT 1 FROM harness_shared.plan_item_claims pic
                       WHERE pic.workspace_id = p_workspace_id
                         AND pic.plan_slug = p_payload->'plan_item'->>'plan_slug'
                         AND pic.item_id  = p_payload->'plan_item'->>'item_id'
                         AND pic.expires_ts > now())
         ) THEN 'reserved-plan-lane' END,
    -- 12. readiness — a PRESENT, NON-TERMINAL blocker (work_item_deps, dep_type='blocks'). The issue
    --     blocked_ref is the BARE feature_id; a blocker is SATISFIED iff terminal or absent. The
    --     EXISTS on work_item_deps (indexed, empty for most rows) short-circuits the inner scans.
    CASE WHEN EXISTS (
           SELECT 1 FROM harness_shared.work_item_deps d
            WHERE d.workspace_id = 'default' AND d.dep_type = 'blocks' AND d.blocked_ref = p_feature_id
              AND (EXISTS (SELECT 1 FROM harness_shared.harness_features_consolidated bf
                            WHERE (bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref
                              AND bf.status NOT IN ('passed','deprecated','done','dropped'))
                OR EXISTS (SELECT 1 FROM harness_shared.engineer_issues bi
                            WHERE bi.workspace_id = 'default' AND bi.issue_id = d.blocker_ref
                              AND bi.state NOT IN ('resolved','closed','done','dropped')))
         ) THEN 'blocked-dep' END
  ], NULL)
$$;

COMMENT ON FUNCTION harness_shared.work_item_claim_floors(text, text, text, text, text, text, text, jsonb, text) IS
  'P-001 (work-item-claimability-clarity): the UNCONDITIONAL issue-family claim floors as a queryable SSOT. Returns the VIOLATED floor labels (empty = claimable). Mirrors claimNextIssueWorkItem''s caller-independent floors; per-claim floors (rig/swarm/redundancy/cooldown) and the own-node drift-recovery origin leg are caller/workspace-context and intentionally excluded (fail-safe under-admit). P-002 (DONE) BINDS the inline TS claim path to this SSOT via an agreement test (claim-ssot-agreement.integration.test.ts) — a physical merge would regress those caller-context floors, so the test proves set-equality-modulo-documented-divergences instead. EI-19409397800537963 added the leading p_workspace_id (both plan subqueries in floor #11 were cross-tenant) and re-pointed floor #11 at op_status.';

CREATE VIEW harness_shared.work_items_claimable AS
  SELECT wi.*
    FROM harness_shared.work_items wi
   WHERE wi.item_kind IN ('bug', 'change', 'task')
     -- PERF PREFILTER (not a second source of truth): the CHEAP, high-selectivity floors are also
     -- spelled inline so the planner filters the ~93% of open rows that are observation-lane /
     -- needs-human scorecards by index/expression BEFORE paying for the per-row function's gated
     -- subqueries (reserved-plan-lane, blocked-dep). The function below RE-CHECKS every floor and
     -- remains the authority — these conjuncts can only ever narrow to the same set, never widen it,
     -- so they cannot drift the result; they just make the full-backlog audit run in ~1s not ~15s.
     AND wi.status = 'open'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'lane'      IS DISTINCT FROM 'observation'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'needsHuman' IS DISTINCT FROM 'true'
     -- the authoritative full floor check (the SSOT — every unconditional floor, in one place):
     AND cardinality(harness_shared.work_item_claim_floors(
           wi.workspace_id, wi.status, wi.taken_by, wi.origin, wi.title,
           wi.terminal_owner, wi.terminal_completion_ref, wi.payload, wi.feature_id
         )) = 0;

COMMENT ON VIEW harness_shared.work_items_claimable IS
  'P-001 (work-item-claimability-clarity): issue-family (bug|change|task) rows that pass EVERY unconditional claim floor (work_item_claim_floors returns empty) — i.e. rows scheduler:get_next / claim_next would serve to a generic caller, modulo per-claim rig/swarm/redundancy/cooldown and the own-node drift-recovery origin leg. Query this instead of hand-rolling floors in raw SQL (owner turn-45).';
