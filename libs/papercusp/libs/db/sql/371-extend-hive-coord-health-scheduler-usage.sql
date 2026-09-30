-- 371: extend the 'hive-coordination-health' rubric from 13 → 14 criteria —
--      add the `scheduler-usage` criterion
--      (hybrid-bee-scheduler-work-stealing-2026-06-22 P-004, su-815e2).
-- Number reserved via db:next-migration (harness_shared.migration_reservations).
--
-- WHY: the within-hive deterministic scheduler (per-bee claim SPECS + the get_next
-- pull path, plan P-005/P-006) is now built + tested. The Overwatch must continuously
-- verify it is USED AS DESIGNED — the Queen authoring + versioning per-bee specs (not
-- micro-dispatching), bees PULLING via get_next (not bypassing the scheduler by
-- self-scanning the frontier), deterministic resolution, ZERO duplicate-plan-item
-- claims (the dedup floor holding), and completions flowing from pulled work. A
-- regression in any of those should surface in the every-turn scorecard, so it is a
-- standing rubric criterion, not a one-off observation.
--
-- WHY A NEW MIGRATION (not editing 327): a rubric is a PLAN now (P-007). The v1
-- standalone rubrics table (mig 326/327) was migrated to a `template: rubric` plan by
-- mig 338 and then DROPPED by mig 353, so the LIVE source of truth is the plan row's
-- template_data, and editing the 327 seed alone would not touch a live (already-past-353)
-- DB. This migration UPDATEs the plan's template_data.criteria jsonb directly. The 327
-- seed is ALSO updated (same commit) so a fresh-DB replay (327 seed → 338 table→plan copy
-- → 353 drop → THIS) lands the same 14 criteria; this UPDATE is then idempotent on that
-- replay (the criterion is appended only if its key is absent — guarded below).
--
-- SCOPE: workspace_id='default', harness_slug='papercusp', plan_slug=
-- 'hive-coordination-health', template='rubric' — the exact key the rubrics store's
-- plans leg reads (rubrics.ts listRubricPlans: workspace_id = rubricsScopeWorkspace() =
-- 'default'). matches mig 338's INSERT.
--
-- LOCKSTEP CONTRACT: the criterion KEY set is a shared interface across the seeded
-- rubric, the capture completeness gate (rubric-driven — reads criteria from the store,
-- so it now requires 14 ratings), the Overwatch persona (lists the key), the synthesized
-- floor scorecard (scorecard-backstop.ts COORDINATION_CRITERIA), and two pinning tests
-- (rubrics-seed.integration / overwatch-scorecard-persona). All move 13→14 in this commit.
--
-- The runner wraps each file in its own transaction + strips psql metacommands, so NO
-- top-level BEGIN;/COMMIT;. ADDITIVE + idempotent (appends only if the key is absent).
UPDATE harness_shared.harness_plans
   SET template_data = jsonb_set(
         template_data,
         '{criteria}',
         (template_data->'criteria') || jsonb_build_array(jsonb_build_object(
           'key',   'scheduler-usage',
           'title', 'Within-hive scheduler usage',
           'model', 'The within-hive deterministic scheduler is USED as designed: the Queen authors + VERSIONS a per-bee claim SPEC (a scoped view.filter + rank over the live work-item DAG, composed from the primitive vocabulary) and re-steers a running bee by bumping the spec revision — she does NOT micro-dispatch each item. Bees PULL their next item through the get_next claim path (global hard floors AND the spec filter, ORDER BY the spec rank, FOR UPDATE SKIP LOCKED) rather than self-scanning the raw frontier or hand-claiming. Resolution is deterministic, the plan-item dedup floor holds (ZERO duplicate-plan-item claims), and completions flow from pulled work. Model-routing (model_fit / per-model capability) is DESCOPED behind its own flag (plan D-010): its absence is NOT a drift.',
           'method', 'Walk the live claim path: are bee claims stamped with a spec specId@revision (get_next records provenance), and do revisions bump when the Queen re-steers? Are there claims that did NOT go through get_next (a self-scanned/hand-claimed item, the bypass)? Query for duplicate-plan-item claims (two non-terminal claims sharing a source_plan_item_id — the dedup floor failing). Check that pulled items reach completion (claim → working → done) rather than zombie-holding. Signal is limited when no spec-driven hive is running (rate unknown). model_fit is neutral until its lane ships — do NOT flag its absence.',
           'driftMarkers', 'Queen micro-dispatching item-by-item instead of issuing/versioning specs; bees bypassing the scheduler (self-prioritizing the raw frontier, hand-claiming) instead of pulling via get_next; non-deterministic or floor-violating resolution; duplicate-plan-item claims (dedup floor breached); pulled claims that never make progress (zombie holds). NOT a drift: model_fit being neutral (descoped). Low evidence (no spec-driven hive running) is unknown, not broken.'
         ))
       ),
       updated_at = now()
 WHERE workspace_id = 'default'
   AND harness_slug = 'papercusp'
   AND plan_slug    = 'hive-coordination-health'
   AND template     = 'rubric'
   -- idempotent: append only when the key is not already present (re-run / fresh replay safe).
   AND NOT (template_data->'criteria') @> '[{"key":"scheduler-usage"}]'::jsonb;

-- The founding `overwatch-observation-quality` criterion's method text hard-coded
-- "all 13 criteria rated" — now stale (14). Patch it in the live plan's criteria jsonb
-- (a string replace inside the array, idempotent — no-op once it reads 14). The 327 seed
-- is updated to match for a clean fresh-DB replay.
UPDATE harness_shared.harness_plans
   SET template_data = jsonb_set(
         template_data,
         '{criteria}',
         replace(
           (template_data->'criteria')::text,
           'rubricRef set, all 13 criteria rated',
           'rubricRef set, all 14 criteria rated'
         )::jsonb
       ),
       updated_at = now()
 WHERE workspace_id = 'default'
   AND harness_slug = 'papercusp'
   AND plan_slug    = 'hive-coordination-health'
   AND template     = 'rubric'
   AND (template_data->'criteria')::text LIKE '%all 13 criteria rated%';

-- The plan's template_data.description (copied from the v1 row by mig 338, before the
-- 327 seed was bumped to "14-criteria") still opens "The 13-criteria scorecard …".
-- Bump the leading count so the prose metadata matches the 14 live criteria. Idempotent.
UPDATE harness_shared.harness_plans
   SET template_data = jsonb_set(
         template_data,
         '{description}',
         to_jsonb(replace(
           (template_data->>'description'),
           'The 13-criteria scorecard',
           'The 14-criteria scorecard'
         ))
       ),
       updated_at = now()
 WHERE workspace_id = 'default'
   AND harness_slug = 'papercusp'
   AND plan_slug    = 'hive-coordination-health'
   AND template     = 'rubric'
   AND (template_data->>'description') LIKE 'The 13-criteria scorecard%';
