-- Migration 1004 — one live acceptance rubric per subject plan.
--
-- EI-21627428942644674: acceptance rubrics are keyed by subjectPlan inside
-- template_data, so the plan slug primary key alone cannot prevent two different
-- rubric ids from competing to define the same plan's definition of done. Keep the
-- newest live contract and retire older duplicates before installing the invariant.
-- FORWARD-COMPAT: this migration does not replace an existing arbiter. The deployed
-- release writes harness_plans through its existing (workspace_id, harness_slug,
-- plan_slug) upsert and never targets the new subjectPlan index with ON CONFLICT;
-- archiving duplicate acceptance rows leaves its existing single-row lookup valid
-- while the stricter proposal and ambiguity checks roll out with this change.

WITH ranked AS (
  SELECT
    workspace_id,
    harness_slug,
    plan_slug,
    first_value(plan_slug) OVER (
      PARTITION BY workspace_id, template_data->>'subjectPlan'
      ORDER BY updated_at DESC NULLS LAST, created_at DESC, plan_slug ASC
    ) AS winner,
    row_number() OVER (
      PARTITION BY workspace_id, template_data->>'subjectPlan'
      ORDER BY updated_at DESC NULLS LAST, created_at DESC, plan_slug ASC
    ) AS position
  FROM harness_shared.harness_plans
  WHERE template = 'rubric'
    AND template_slug IS NULL
    AND archived = false
    AND status IN ('active', 'ready')
    AND template_data->>'kind' = 'acceptance'
    AND NULLIF(template_data->>'subjectPlan', '') IS NOT NULL
), duplicates AS (
  SELECT workspace_id, harness_slug, plan_slug, winner
  FROM ranked
  WHERE position > 1
)
UPDATE harness_shared.harness_plans AS plan
   SET status = 'superseded',
       archived = true,
       superseded_by = duplicates.winner,
       version = plan.version + 1,
       updated_at = now()
  FROM duplicates
 WHERE plan.workspace_id = duplicates.workspace_id
   AND plan.harness_slug = duplicates.harness_slug
   AND plan.plan_slug = duplicates.plan_slug;

-- The partial index deliberately mirrors getAcceptanceRubricsForPlan's live-row
-- predicate. It scopes uniqueness by workspace (not harness), because the gate reads
-- all harnesses in the active workspace and subjectPlan is the plan-level identity.
CREATE UNIQUE INDEX IF NOT EXISTS harness_plans_one_active_acceptance_per_subject_plan
  ON harness_shared.harness_plans (workspace_id, (template_data->>'subjectPlan'))
  WHERE template = 'rubric'
    AND template_slug IS NULL
    AND archived = false
    AND status IN ('active', 'ready')
    AND template_data->>'kind' = 'acceptance'
    AND NULLIF(template_data->>'subjectPlan', '') IS NOT NULL;

COMMENT ON INDEX harness_shared.harness_plans_one_active_acceptance_per_subject_plan IS
  'EI-21627428942644674: at most one active/ready, unarchived acceptance rubric per workspace and subjectPlan.';
