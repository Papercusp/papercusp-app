-- 010-workspace-scoping-rls.sql
--
-- Phase A part 2: enable Row Level Security on workspace-scoped tables.
--
-- DO NOT RUN until 009 has been applied AND the backfill script
-- (libs/db/scripts/backfill-workspace-id.ts) has populated real
-- workspace_id values on every existing row. RLS predicates filter
-- by `app.workspace_id` GUC; if a row's workspace_id is empty string
-- and no GUC is set, the predicate returns false and the row is
-- invisible — including to the backfill script if rerun.
--
-- The backfill script verifies "no row has workspace_id = ''" before
-- this migration is allowed to apply. Operators should:
--   1. Apply 009 (additive columns + new tables).
--   2. node libs/db/scripts/backfill-workspace-id.ts --dry-run
--   3. Review the output.
--   4. node libs/db/scripts/backfill-workspace-id.ts --apply
--   5. Apply 010 (this file).

-- ────────────────────────────────────────────────────────────────────────
-- After backfill: enforce non-empty workspace_id on all workspace-scoped
-- tables. The CHECK constraints catch any future write that fails to set
-- the column; combined with the DEFAULT being removed, no row can be
-- inserted without an explicit workspace_id.
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE harness_shared.projects
  ALTER COLUMN workspace_id DROP DEFAULT,
  ADD CONSTRAINT projects_workspace_nonempty CHECK (workspace_id <> '');

ALTER TABLE harness_shared.audit_log
  ALTER COLUMN workspace_id DROP DEFAULT,
  ADD CONSTRAINT audit_workspace_nonempty CHECK (workspace_id <> '');

ALTER TABLE harness_shared.harness_features_consolidated
  ALTER COLUMN workspace_id DROP DEFAULT,
  ADD CONSTRAINT hfc_workspace_nonempty CHECK (workspace_id <> '');

ALTER TABLE harness_shared.plugin_enables
  ALTER COLUMN workspace_id DROP DEFAULT,
  ADD CONSTRAINT plugin_enables_workspace_nonempty CHECK (workspace_id <> '');

ALTER TABLE harness_shared.plugin_configs
  ALTER COLUMN workspace_id DROP DEFAULT,
  ADD CONSTRAINT plugin_configs_workspace_nonempty CHECK (workspace_id <> '');

ALTER TABLE harness_shared.goals
  ALTER COLUMN workspace_id DROP DEFAULT,
  ADD CONSTRAINT goals_workspace_nonempty CHECK (workspace_id <> '');

ALTER TABLE harness_shared.pending_events
  ALTER COLUMN workspace_id DROP DEFAULT,
  ADD CONSTRAINT pending_events_workspace_nonempty CHECK (workspace_id <> '');

ALTER TABLE harness_shared.routines
  ALTER COLUMN workspace_id DROP DEFAULT,
  ADD CONSTRAINT routines_workspace_nonempty CHECK (workspace_id <> '');

ALTER TABLE harness_shared.project_spec_revisions
  ALTER COLUMN workspace_id DROP DEFAULT,
  ADD CONSTRAINT psr_workspace_nonempty CHECK (workspace_id <> '');

ALTER TABLE harness_shared.token_index
  ALTER COLUMN workspace_id DROP DEFAULT,
  ADD CONSTRAINT token_index_workspace_nonempty CHECK (workspace_id <> '');

-- ────────────────────────────────────────────────────────────────────────
-- RLS policies. Each policy filters by `app.workspace_id` GUC. If the
-- GUC is unset, current_setting('app.workspace_id', true) returns NULL,
-- and the predicate `workspace_id = NULL` is false → row invisible.
--
-- harness_admin BYPASSES RLS for migrations and tooling; harness_app is
-- subject to RLS for application code paths.
-- ────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'projects',
    'audit_log',
    'harness_features_consolidated',
    'plugin_enables',
    'plugin_configs',
    'goals',
    'pending_events',
    'routines',
    'project_spec_revisions',
    'token_index',
    'system_principals',
    'pi_sessions'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE harness_shared.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON harness_shared.%I '
      'USING (workspace_id = current_setting(''app.workspace_id'', true)) '
      'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t || '_workspace_isolation', t
    );
    -- harness_admin bypasses RLS via FORCE not being applied + table owner
    -- being a superuser; the harness_app role is the constrained one.
  END LOOP;
END $$;

-- system_principals and pi_sessions need workspace_id NOT NULL
-- (they were created in 009 with the column built-in, no DEFAULT to drop).
-- CHECK constraints for consistency with the others:
ALTER TABLE harness_shared.system_principals
  ADD CONSTRAINT system_principals_workspace_nonempty CHECK (workspace_id <> '');
ALTER TABLE harness_shared.pi_sessions
  ADD CONSTRAINT pi_sessions_workspace_nonempty CHECK (workspace_id <> '');

-- ────────────────────────────────────────────────────────────────────────
-- Re-grant after RLS to ensure harness_app can SELECT/INSERT/UPDATE/DELETE
-- subject to the policies. RLS does not affect grants.
-- ────────────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA harness_shared
  TO harness_app, harness_admin;
