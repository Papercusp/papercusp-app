-- 329-plan-template-mechanism.sql
-- plan-templates-and-rubric-v2-2026-06-20 P-004 — the template-mechanism foundation.
--
-- A plan may be a TEMPLATE INSTANCE: `template` names the built-in template TYPE
-- (a code-registry zod schema, e.g. 'rubric'); `template_data` jsonb holds the
-- per-plan structured instance data, validated against that schema on write by
-- plans:set-template-data (P-005). `template` is DERIVED from the `template:`
-- frontmatter (mirrors `initiative` — see with-plan-lock.ts reproject);
-- `template_data` is written structured, never parsed from frontmatter.
--
-- Distinct from `template_slug` (mig 299): that is the scheduled-INSTANCE →
-- template back-pointer (Option C, points an auto-run instance plan at its
-- recurring template plan). `template` here names the artifact-template TYPE a
-- plan conforms to. Do NOT conflate the two (plan note on P-004).
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS) — safe to boot-apply.

ALTER TABLE harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS template text,
  ADD COLUMN IF NOT EXISTS template_data jsonb;

COMMENT ON COLUMN harness_shared.harness_plans.template IS
  'Template TYPE a plan conforms to (code-registry zod schema name, e.g. ''rubric''); NULL for ordinary plans. Derived from the `template:` frontmatter (mirrors `initiative`). plan-templates-and-rubric-v2 P-004.';
COMMENT ON COLUMN harness_shared.harness_plans.template_data IS
  'Per-plan structured template instance data (jsonb), validated against the template''s registry zod schema on write (plans:set-template-data, P-005). NULL until set; never parsed from frontmatter. Distinct from template_slug (mig 299, scheduled-instance back-pointer).';

-- Filter index for plans:list template filters (P-005): plans of a given template type.
CREATE INDEX IF NOT EXISTS harness_plans_template_idx
  ON harness_shared.harness_plans USING btree (workspace_id, harness_slug, template)
  WHERE (template IS NOT NULL);
