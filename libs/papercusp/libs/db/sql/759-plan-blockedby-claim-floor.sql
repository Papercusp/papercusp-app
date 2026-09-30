-- 759-plan-blockedby-claim-floor.sql — EI-13738
--
-- Add claim floor #13 (`plan-item-blocked`) to the issue-family claim-floor SSOT: a work-item
-- bound to a plan-item that is BLOCKED-BY an unfinished sibling is not claimable. This is the
-- SQL half of a two-part fix; the TS half is `reservedPlanLaneExclusionSql` in
-- packages/operator-core/lib/work-items.ts, and the two are bound by
-- lib/scheduler/claim-ssot-agreement.integration.test.ts. Landing only one half is exactly the
-- drift that test exists to catch.
--
-- WHAT IS WRONG
--
--   Readiness lives in TWO stores and only one of them is enforced at claim time:
--
--     (a) the WORK-ITEM: state + work_item_deps ('blocks' edges) — floor #12 (`blocked-dep`).
--     (b) the PLAN: harness_plans.items[].blockedBy[] — a SEPARATE, richer dependency graph
--         that `plans:get-item` reports as effectiveStatus:'blocked'.
--
--   NOTHING in this function reads (b). An item on a plan that is NOT under execution, whose
--   plan-item is blockedBy an unfinished sibling, passes every floor and is served to
--   self-select. Two independent agents hit this within one hour from opposite directions
--   (the filing near-miss was a 10-agent dispatch), which is the signal: neither was careless,
--   the readiness truth is simply split and only half of it gates the claim.
--
--   Floor #11 (reserved-plan-lane, migration 744) MITIGATES but does not fix this: it reserves
--   items whose plan is op_status started/paused. A plan that was never started — or is merely
--   'ready' — reserves nothing, and its blocked lanes stay fully claimable.
--
-- ONE LEVEL IS ENOUGH — DO NOT BUILD A RECURSIVE CTE
--
--   An item is blocked iff ∃ b ∈ blockedBy where sibling b is not satisfied. Transitivity is
--   automatic: a blocker that is itself blocked is, by definition, not yet done. A recursive
--   CTE would buy nothing and would put a cycle risk on the fleet-wide claim path.
--
-- SATISFIED = 'done' OR 'dropped' — MEASURED, NOT ASSUMED
--
--   Mirrors the canonical TS predicate verbatim (libs/generic/plan-parser/src/effective-status.ts
--   L178: `depItem.storedStatus !== 'done' && depItem.storedStatus !== 'dropped'`), and matches
--   floor #12's own terminal sets, which already count 'dropped' as satisfied.
--
--   ⚠ A `<> 'done'` test alone (the obvious spelling) is WRONG and would STARVE work: measured
--   on live papercusp 2026-08-04 there are 209 plan-items at status='dropped', and every item
--   blocked by one of them would have become permanently unclaimable. The live status vocabulary
--   is done 6669 / todo 828 / dropped 209 / blocked 54 / needs-human 44 / wip 35 — note that
--   'needs-human' and 'blocked' are NOT satisfied, so they correctly keep blocking.
--
-- A TERMINAL SELF-ITEM IS NEVER BLOCKED (EI-19412899868617052)
--
--   The predicate also requires the item's OWN status to be non-terminal, mirroring the
--   short-circuit that item's fix added to plan-parser: the blocked-by graph exists to gate work
--   that has NOT happened; it must never re-open work that already has. Without this a work-item
--   whose plan-item is already done/dropped, but whose blocker is still running, would be
--   excluded from its own claim.
--
-- DELIBERATE DIVERGENCE FROM plan-parser: A DANGLING REF DOES NOT BLOCK
--
--   plan-parser pushes a blockedBy id with no matching sibling into `unresolvedBlockers` (⇒
--   blocked). This floor treats it as NOT blocking — an EXISTS over the sibling join simply
--   finds nothing. That is deliberate and matches the established claim-floor convention: the
--   sibling readiness floor is already specified as "an ABSENT / dangling blocker ref does NOT
--   block (no deadlock)" (claim-respects-blocking.integration.test.ts case 4). Fail-OPEN on a
--   dangling ref, because the failure mode of the alternative is a permanently unclaimable item
--   that no one can diagnose. Measured: exactly 1 dangling ref exists across all plans.
--
-- MALFORMED-JSONB GUARD (fleet-wide blast radius)
--
--   `jsonb_array_elements` RAISES on a non-array input, and this function runs on EVERY claim
--   for the whole fleet — one malformed plan row would take out claiming entirely, not just
--   that row. Both element scans are wrapped in a jsonb_typeof CASE that degrades a non-array
--   to '[]'. Measured today: items is 'array' on 982 plans and NULL on 52 (NULL is already safe
--   — a strict SRF over NULL yields zero rows — but the guard makes the property structural
--   rather than incidental).
--
-- TENANT SCOPE
--
--   workspace_id ONLY, exactly like floor #11 and for the same reason: (workspace_id, plan_slug)
--   is unique across the table, and the plan_item back-pointer's own harness_slug drifted from
--   the plan row's in migration 656, so keying on it would silently un-block real lanes.
--
-- EXPOSURE TODAY: ZERO — measured in BOTH families before writing this (issue family via
--   payload.plan_item: 41 plan-bound open+unassigned rows, 0 newly excluded; feature family via
--   source_plan_slug: 1,253 plan-bound rows, 8 todo+unclaimed, 0 newly excluded). This migration
--   therefore CANNOT be validated against production data, which is why the accompanying change
--   ships a synthetic fixture test rather than a before/after count. A "0 before, 0 after" run
--   would prove nothing. The floor is still correct to add: the current population is not the
--   blast radius, and floor #11 is a mitigation that a not-yet-started plan bypasses entirely.
--
-- SIGNATURE UNCHANGED (9-arg). Idempotent: DROP the view + this signature, then CREATE fresh
-- (same shape as 654/744). Every floor other than the new #13 is byte-identical to 744.

DROP VIEW IF EXISTS harness_shared.work_items_claimable;
-- 9-arg (744's shipped signature — the one this migration replaces, and an idempotent re-run
-- of THIS migration):
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
         ) THEN 'blocked-dep' END,
    -- 13. PLAN-graph readiness (EI-13738) — the item's plan-item is blockedBy an unfinished
    --     sibling. Floor #12 above enforces the WORK-ITEM dependency store (work_item_deps);
    --     this enforces the PLAN one (harness_plans.items[].blockedBy[]), which nothing read
    --     until now, so a plan-blocked lane on a not-yet-started plan was fully self-selectable.
    --
    --     Satisfied = 'done' OR 'dropped', mirroring plan-parser's effective-status L178 verbatim.
    --     ⚠ NOT `<> 'done'`: 209 live plan-items sit at 'dropped', and treating those as blockers
    --     would permanently starve every item behind them.
    --
    --     The item's OWN status must also be non-terminal (EI-19412899868617052: a terminal token
    --     wins over the blocked-by graph — the graph gates work that has not happened, it must
    --     never re-open work that has).
    --
    --     One level only: transitivity is automatic, since a blocker that is itself blocked is by
    --     definition not done. Dangling refs fail OPEN (no deadlock), matching the sibling
    --     readiness floor's documented convention.
    --
    --     Both element scans are jsonb_typeof-guarded because jsonb_array_elements RAISES on a
    --     non-array, and this function gates EVERY claim on the fleet.
    --     MUST stay in step with reservedPlanLaneExclusionSql (work-items.ts).
    CASE WHEN COALESCE(p_payload, '{}'::jsonb) ? 'plan_item' AND EXISTS (
           SELECT 1
             FROM harness_shared.harness_plans hp,
                  LATERAL jsonb_array_elements(
                    CASE WHEN jsonb_typeof(hp.items) = 'array' THEN hp.items ELSE '[]'::jsonb END) self_it,
                  LATERAL jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(self_it->'blockedBy') = 'array'
                         THEN self_it->'blockedBy' ELSE '[]'::jsonb END) dep_id,
                  LATERAL jsonb_array_elements(
                    CASE WHEN jsonb_typeof(hp.items) = 'array' THEN hp.items ELSE '[]'::jsonb END) dep_it
            WHERE hp.workspace_id = p_workspace_id
              AND hp.plan_slug = p_payload->'plan_item'->>'plan_slug'
              AND self_it->>'id' = p_payload->'plan_item'->>'item_id'
              AND COALESCE(self_it->>'status', '') NOT IN ('done', 'dropped')
              AND dep_it->>'id' = dep_id
              AND COALESCE(dep_it->>'status', '') NOT IN ('done', 'dropped')
         ) THEN 'plan-item-blocked' END
  ], NULL)
$$;

COMMENT ON FUNCTION harness_shared.work_item_claim_floors(text, text, text, text, text, text, text, jsonb, text) IS
  'P-001 (work-item-claimability-clarity): the UNCONDITIONAL issue-family claim floors as a queryable SSOT. Returns the VIOLATED floor labels (empty = claimable). Mirrors claimNextIssueWorkItem''s caller-independent floors; per-claim floors (rig/swarm/redundancy/cooldown) and the own-node drift-recovery origin leg are caller/workspace-context and intentionally excluded (fail-safe under-admit). P-002 (DONE) BINDS the inline TS claim path to this SSOT via an agreement test (claim-ssot-agreement.integration.test.ts) — a physical merge would regress those caller-context floors, so the test proves set-equality-modulo-documented-divergences instead. EI-19409397800537963 added the leading p_workspace_id (both plan subqueries in floor #11 were cross-tenant) and re-pointed floor #11 at op_status. EI-13738 added floor #13 (plan-item-blocked): the PLAN dependency graph (harness_plans.items[].blockedBy[]) now gates the claim alongside the work-item one (floor #12), which is the only readiness store that was enforced before.';

CREATE VIEW harness_shared.work_items_claimable AS
  SELECT wi.*
    FROM harness_shared.work_items wi
   WHERE wi.item_kind IN ('bug', 'change', 'task')
     -- PERF PREFILTER (not a second source of truth): the CHEAP, high-selectivity floors are also
     -- spelled inline so the planner filters the ~93% of open rows that are observation-lane /
     -- needs-human scorecards by index/expression BEFORE paying for the per-row function's gated
     -- subqueries (reserved-plan-lane, blocked-dep, plan-item-blocked). The function below
     -- RE-CHECKS every floor and remains the authority — these conjuncts can only ever narrow to
     -- the same set, never widen it, so they cannot drift the result; they just make the
     -- full-backlog audit run in ~1s not ~15s.
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
