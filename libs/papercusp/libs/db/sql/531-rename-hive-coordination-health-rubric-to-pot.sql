-- 531-rename-hive-coordination-health-rubric-to-pot.sql
--
-- Part of the hive->pot lexicon rename (WI-3618, split off WI-3617's CI-lint
-- red). A rubric IS a plan (harness_shared.harness_plans, plan_slug doubles
-- as rubricId): the docs side + ~40 producer-file string constants were
-- already renamed hive-coordination-health -> pot-coordination-health in the
-- same change; this migration renames the LIVE plan row so the active rubric
-- stays resolvable under its new id (method_ref / plan_slug / rubricId /
-- methodRef all derive from plan_slug per rubrics.ts's planRowToRubric).
--
-- plan_slug is the PK (workspace_id, harness_slug, plan_slug) with no FK
-- dependents (verified: no `REFERENCES harness_shared.harness_plans` in the
-- schema) — other tables (plan_events, scorecards.rubricRef, coverage links)
-- reference plan_slug only as a loose string, not an enforced FK. Historical
-- rows in those tables are left pointing at the OLD id (they are an
-- immutable log of what happened under that id at the time); only the live
-- plan row and template_data's embedded id fields are renamed here, since
-- every future producer-file write now targets the NEW id.
--
-- Verified against the live row before writing this migration: rubricId is
-- NOT a stored template_data key (planRowToRubric derives r.rubricId purely
-- from plan_slug — see rubrics.ts) — only methodRef is a real stored field,
-- and the live row currently holds methodRef='hive-coordination-health' (no
-- '-runbook' suffix, despite the rubric.json/seed-SQL fixture spelling).
--
-- Race note (hit live on 2026-07-10 while authoring this): the same change
-- also renames rubrics/hive-coordination-health/ -> rubrics/pot-coordination-health/
-- on disk, and the first-party-rubric-bundle cold-start seeder
-- (local-first-party-rubric-bundling-2026-07-07, cupboard/rubric-store.ts) is
-- no-clobber PER-ID — it happily seeds a BLANK new 'pot-coordination-health'
-- row (owner='first-party-bundle') the moment it sees that dir on disk with
-- no DB row under that id yet, racing ahead of this migration on whichever
-- boot applies migrations. That blank seed must NOT survive: it has no real
-- ratification lineage. So this migration explicitly clears a first-party-bundle
-- placeholder under the NEW id before renaming the real historical row into
-- its place — idempotent and safe whichever order the two processes land in.
--
-- Idempotent: safe to re-run (guarded by plan_slug existence).

DO $$
BEGIN
  -- Clear a same-id placeholder the disk-scan seeder may have raced in ahead
  -- of us (see race note above) — never touch a real (non-seed-placeholder)
  -- row that happens to already hold the new id.
  DELETE FROM harness_shared.harness_plans
   WHERE plan_slug = 'pot-coordination-health'
     AND owner = 'first-party-bundle';

  IF EXISTS (
    SELECT 1 FROM harness_shared.harness_plans
     WHERE plan_slug = 'hive-coordination-health'
  ) AND NOT EXISTS (
    SELECT 1 FROM harness_shared.harness_plans
     WHERE plan_slug = 'pot-coordination-health'
  ) THEN
    UPDATE harness_shared.harness_plans
       SET plan_slug = 'pot-coordination-health',
           template_data = jsonb_set(
             COALESCE(template_data, '{}'::jsonb),
             '{methodRef}', '"pot-coordination-health"', true
           )
     WHERE plan_slug = 'hive-coordination-health';
  END IF;
END $$;
