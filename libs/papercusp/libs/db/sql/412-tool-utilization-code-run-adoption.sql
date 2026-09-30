-- 412: point the hive-coordination-health `tool-utilization` criterion at the code:run
--      ADOPTION metric (code-run-adoption directive 2026-06-29).
--
-- WHY: tool-utilization asks "are the tools that exist reached for when apt?" — and the
-- single biggest measured gap is code:run itself (~2% of batchable spawns fold into one
-- code:run; the rest hand-loop / fan-out one call at a time). The metric now exists as a
-- first-class read (dev:code_run_adoption) + a graded signal (gradeToolUtilization, wired
-- into the Overwatch scorecard-backstop), but the LIVE Overwatch grades against the
-- criterion's `method`/`driftMarkers` text — which still lists only the older tools. This
-- amends that text so the every-turn grader investigates code:run adoption from data
-- (dev:code_run_adoption) and the agent-graded trend the learning loop reads reflects it.
--
-- WHY A NEW MIGRATION (not editing 327 alone): the rubric is a PLAN now (mig 338 copied the
-- 326/327 standalone rubrics table into a `template: rubric` plan; mig 353 dropped the
-- table), so the LIVE source of truth is the plan row's template_data.criteria jsonb. This
-- UPDATEs that directly (mirrors mig 371's scheduler-usage amend). The 327 seed is updated
-- in the same commit so a fresh-DB replay (327 seed → 338 copy → 353 drop → THIS) lands the
-- same text; this UPDATE is then idempotent on that replay (guarded below).
--
-- SCOPE: matched by harness_slug='papercusp' + plan_slug='hive-coordination-health' +
-- template='rubric', across ANY workspace_id. NOTE: mig 371 filtered workspace_id='default'
-- (the seed's documented scope), but the LIVE plan is keyed 'papercusp-workspace'
-- (rubricsScopeWorkspace() resolves per-deployment), so that UPDATE was inert here and
-- scheduler-usage only landed via the SEED→plan copy. Dropping the workspace_id filter makes
-- THIS amend actually hit the live row regardless of deployment scope (and any peer-workspace
-- copies). KEYS + COUNT UNCHANGED (still 14 criteria) — only the `tool-utilization` criterion's
-- method + driftMarkers text is enriched, so the lockstep key-set contract is untouched.
--
-- The runner wraps each file in its own transaction + strips psql metacommands, so NO
-- top-level BEGIN;/COMMIT;. ADDITIVE + idempotent: a text-replace inside the criteria jsonb,
-- guarded to fire only when the anchor text is present AND the adoption guidance is absent.
UPDATE harness_shared.harness_plans
   SET template_data = jsonb_set(
         template_data,
         '{criteria}',
         replace(
           replace(
             (template_data->'criteria')::text,
             'A tool with near-zero lifetime use that should be hot is a gap.',
             'A tool with near-zero lifetime use that should be hot is a gap. ALSO grade code:run ADOPTION: call dev:code_run_adoption (of the spawns that COULD batch — a same-tool burst or a fan-out — what percent folded into one code:run; returns the fleet adoptionRate + a graded rating). A persistent low rate (the baseline sits near 2 percent) is a tool-utilization gap, not healthy.'
           ),
           'a fallback not wired into the path that needs it.',
           'a fallback not wired into the path that needs it. code:run UNDER-ADOPTED: agents hand-loop the same tool or fan out one-at-a-time instead of folding into one code:run (the dev:code_run_adoption rate stuck low).'
         )::jsonb
       ),
       updated_at = now()
 WHERE harness_slug = 'papercusp'
   AND plan_slug    = 'hive-coordination-health'
   AND template     = 'rubric'
   -- idempotent: only when the anchor is present and the adoption guidance is not yet added.
   AND (template_data->'criteria')::text LIKE '%should be hot is a gap.%'
   AND (template_data->'criteria')::text NOT LIKE '%dev:code_run_adoption%';
