-- 422-drop-papercup-shared-compat.sql
-- CONTRACT phase of papercup_shared -> papercusp_shared (Brief 11; phase5 P-009 / migration P-005).
-- EXPAND (migration 332) renamed the 6 base tables into papercusp_shared and left
-- papercup_shared as 6 auto-updatable compat VIEWS. This drops them + the schema.
--
-- IDEMPOTENT + PRIVILEGE-GRACEFUL: a no-op once papercup_shared is gone, and a no-op
-- (with a WARNING) when the running role is neither the schema owner nor a superuser,
-- so it can never wedge the boot-migrator (db-boot-migrate.ts: "never throws"). On a
-- fresh install / re-provision the normal runner (harness_admin) OWNS papercup_shared
-- and this drops it cleanly. On the original shared dev DB, papercup_shared is owned by
-- the superuser `postgres_app` (an artifact of the manual EXPAND apply), so the
-- harness_admin runner cannot drop it -- that one live DB needs a one-time superuser:
--     DROP SCHEMA papercup_shared CASCADE;   -- run as postgres_app / postgres
-- (see HANDOFF-papercup-rename-window-runbook-2026-06-24.md section 0/1; escalated 2026-06-29.)
--
-- Replication-safe (0 publications/slots/subscriptions; views are never logically
-- replicated; the real tables live in papercusp_shared). Gate verified 2026-06-24 and
-- re-verified 2026-06-29 against the live DB + all three running trees (0 runtime refs).
-- Reversal (data is untouched in papercusp_shared): recreate the 6 compat views --
--   CREATE SCHEMA papercup_shared;
--   CREATE OR REPLACE VIEW papercup_shared.<t> AS SELECT * FROM papercusp_shared.<t>;
-- for t in (briefings, directive_summaries, directives, message_comments, message_recipients, messages).
-- Renumbered from the runbook's planned 394 (that slot was later taken by 394-operator-quota-overrides.sql).
DO $contract$
DECLARE
  v_owner text;
  v_super boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'papercup_shared') THEN
    RAISE NOTICE 'CONTRACT: papercup_shared already absent -- no-op';
    RETURN;
  END IF;

  SELECT pg_get_userbyid(nspowner) INTO v_owner FROM pg_namespace WHERE nspname = 'papercup_shared';
  SELECT rolsuper INTO v_super FROM pg_roles WHERE rolname = current_user;

  IF v_owner = current_user OR COALESCE(v_super, false) THEN
    DROP SCHEMA papercup_shared CASCADE;  -- CASCADE drops the 6 compat views (0 external deps verified)
    RAISE NOTICE 'CONTRACT: dropped papercup_shared compat views + schema';
  ELSE
    RAISE WARNING 'CONTRACT SKIPPED: papercup_shared is owned by % and current_user % is not owner/superuser. Drop it once as a superuser: DROP SCHEMA papercup_shared CASCADE;', v_owner, current_user;
  END IF;
END
$contract$;
