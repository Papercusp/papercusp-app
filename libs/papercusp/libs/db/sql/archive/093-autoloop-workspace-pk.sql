-- 093-autoloop-workspace-pk.sql
-- Phase E (per-window-workspace-context P-020 / D-015): the ONE shared operator
-- fires autoloop directors across ALL workspaces, so autoloop_state must key
-- per-workspace. Widen the primary key (harness_slug, role) →
-- (workspace_id, harness_slug, role) so the same harness slug in two workspaces
-- keeps independent fire-state instead of one clobbering the other.
--
-- Idempotent + safe: guarded on the table existing AND still having the old
-- 2-column PK; existing rows are unique under the new (superset) key, so the
-- ADD never violates. Fresh installs get the 3-col PK from autoloop.ts's
-- ensureTable() CREATE.
DO $$
BEGIN
  IF to_regclass('harness_shared.autoloop_state') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'harness_shared.autoloop_state'::regclass
         AND contype = 'p'
         AND array_length(conkey, 1) = 2
     )
  THEN
    ALTER TABLE harness_shared.autoloop_state DROP CONSTRAINT autoloop_state_pkey;
    ALTER TABLE harness_shared.autoloop_state
      ADD CONSTRAINT autoloop_state_pkey PRIMARY KEY (workspace_id, harness_slug, role);
  END IF;
END $$;
