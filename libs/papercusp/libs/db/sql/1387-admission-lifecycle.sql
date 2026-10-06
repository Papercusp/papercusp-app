-- 1387: admission lifecycle rules (linear-asana-task-sync-2026-10-05 P-003).
--
-- admission_rules.lifecycle       which lifecycle reactions a rule runs. '{}' means the defaults:
--                                 every reaction on, and completion moves the source to `done`
--                                 (owner answer #1417). Validated by work-admission/lifecycle.ts.
-- admission_write_backs.lifecycle_key
--                                 the lifecycle event a write answered (claim:<holder>,
--                                 complete:<closedAt>, ...). Unique per admission, so each event
--                                 is written back to the source once, whatever the sync cadence.
-- work_admissions.source_category the source's workflow category as last seen, so an outside close
--                                 or reopen is recognised as a change between two syncs rather than
--                                 re-inferred from a standing state on every pass.
--
-- FORWARD-COMPAT: additive only. The deployed release neither reads nor writes these columns, and the new partial unique index constrains only rows that carry a lifecycle_key, which no deployed code writes.

ALTER TABLE harness_shared.admission_rules
  ADD COLUMN IF NOT EXISTS lifecycle jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE harness_shared.admission_rules
  ADD CONSTRAINT admission_rules_lifecycle_check CHECK (jsonb_typeof(lifecycle) = 'object');

ALTER TABLE harness_shared.admission_write_backs
  ADD COLUMN IF NOT EXISTS lifecycle_key text;
ALTER TABLE harness_shared.admission_write_backs
  ADD CONSTRAINT admission_write_backs_lifecycle_key_check
  CHECK (lifecycle_key IS NULL OR btrim(lifecycle_key) <> '');
CREATE UNIQUE INDEX IF NOT EXISTS admission_write_backs_lifecycle_idx
  ON harness_shared.admission_write_backs (workspace_id, admission_id, lifecycle_key)
  WHERE lifecycle_key IS NOT NULL;

ALTER TABLE harness_shared.work_admissions
  ADD COLUMN IF NOT EXISTS source_category text;
ALTER TABLE harness_shared.work_admissions
  ADD CONSTRAINT work_admissions_source_category_check
  CHECK (source_category IS NULL OR source_category IN
    ('triage', 'backlog', 'todo', 'in-progress', 'in-review', 'done', 'canceled'));
