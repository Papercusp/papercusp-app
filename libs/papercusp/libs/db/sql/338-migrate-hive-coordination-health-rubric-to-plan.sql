-- 338: P-007 (plan-templates-and-rubric-v2) Stage 1 — migrate the seeded
--      'hive-coordination-health' rubric from the v1 standalone table
--      (harness_shared.rubrics, mig 326/327) → a rubric-template PLAN
--      (harness_shared.harness_plans, template='rubric'), so the rubric is
--      served from the plans leg of the re-pointed store (rubrics.ts, P-006).
-- Number reserved via db:next-migration.
--
-- WHY HERE (not plans:new): the rubric id MUST stay 'hive-coordination-health'
-- (existing engineer_issues scorecards + the Overwatch persona reference it; the
-- store maps rubricId = plan_slug in planRowToRubric). plans:new force-appends a
-- -YYYY-MM-DD slug suffix, so this founding fixture is seeded as a PLAN row the
-- same way 327 seeded the v1 TABLE row.
--
-- WORKSPACE = 'default' (DEFAULT_COORD_WORKSPACE), matching the v1 table seed (327)
-- AND P-006's plans-leg query (rubrics.ts listRubricPlans: WHERE workspace_id =
-- rubricsScopeWorkspace() = 'default'). So the re-pointed store finds this plan with
-- NO code change — sidestepping the D-006 trap (which only arises if the plan lives in
-- a non-'default' workspace while rubricsScopeWorkspace stays 'default', making the
-- plans leg miss it). A harness_plans row in 'default' is valid: no FK on workspace_id,
-- the v1 rubrics row already lives there, and the rubrics store's plans leg filters only
-- workspace_id+template (harness_slug is NOT read — 'papercusp' here just names the hive
-- the rubric measures). EFFECT IS IMMEDIATE: the deployed :3070 already runs P-006's
-- union querying 'default', so on apply it serves the rubric from THIS plan (plans win
-- over the table row, mergeRubricLegs). ADDITIVE + idempotent; the v1 table stays as the
-- fallback leg until the Stage-2 DROP migration.
--
-- template_data is BUILT FROM the v1 row (no hand-copy of the criteria — 13 at seed,
-- plus the 14th `scheduler-usage` criterion added to the 327 seed by mig 371): the
-- criteria jsonb is field-for-field rubricCriterionSchema (verified), and
-- jsonb_strip_nulls drops a null methodRef/description so the .strict()
-- rubricTemplateDataSchema safeParse in planRowToRubric passes. The plan-level title
-- + status are NOT in template_data (they derive from frontmatter/plan status).
--
-- The runner wraps each file in its own transaction + strips psql metacommands, so
-- NO top-level BEGIN;/COMMIT;. ADDITIVE + idempotent (ON CONFLICT re-syncs the row).
-- Runs AFTER 326/327 (table created + seeded) and BEFORE the Stage-2 DROP migration,
-- so the SELECT-from-rubrics resolves on a fresh-DB replay.
INSERT INTO harness_shared.harness_plans
  (workspace_id, harness_slug, plan_slug, title, status, created, updated, owner,
   items, decisions, now_state, template, template_data, is_legacy, archived)
SELECT
  'default',
  'papercusp',
  'hive-coordination-health',
  r.title,
  'active',
  to_char(now(), 'YYYY-MM-DD'),
  to_char(now(), 'YYYY-MM-DD'),
  COALESCE(r.ratified_by, r.created_by, 'ownerhandle@gmail.com'),
  '[]'::jsonb,
  '[]'::jsonb,
  'Rubric-template plan (template:rubric) migrated from the v1 rubrics table (P-007). The hive-coordination-health scorecard the Overwatch grades every turn (14 criteria — the founding 13 plus scheduler-usage, mig 371); structured fields live in template_data, queried via rubrics:list/get/search. Long-form per-criterion METHOD: the agent-insights runbook named by template_data.methodRef.',
  'rubric',
  jsonb_strip_nulls(jsonb_build_object(
    'characteristic', r.characteristic,
    'criteria',       r.criteria,
    'ratingScale',    r.rating_scale,
    'methodRef',      r.method_ref,
    'description',    r.description
  )),
  false,
  false
FROM harness_shared.rubrics r
WHERE r.rubric_id = 'hive-coordination-health'
ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE SET
  template      = 'rubric',
  template_data = EXCLUDED.template_data,
  status        = 'active',
  title         = EXCLUDED.title,
  updated_at    = now();
