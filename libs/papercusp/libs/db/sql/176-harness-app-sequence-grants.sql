-- 176-harness-app-sequence-grants.sql
--
-- Fix: harness_app (the RLS-subject runtime role the operator uses for
-- workspace-scoped writes) lacked USAGE/SELECT/UPDATE on sequences created
-- AFTER migration 109's one-time `GRANT ... ON ALL SEQUENCES`. Any INSERT into
-- a serial/identity table whose backing sequence post-dates 109 therefore failed
-- the nextval() with:
--     ERROR: permission denied for sequence <name>_id_seq
-- e.g.  plans:launch -> INSERT harness_shared.plan_runs   (the reported symptom)
--       events:await -> INSERT harness_shared.event_awaits / event_wake_deliveries
--       coord links / thread_posts / entity_subscriptions, delegates,
--       delegate_inbox, agent_usage_samples, directive/supervisor consolidated …
-- As of 2026-06-06, 11 of 45 harness_shared sequences were ungranted.
--
-- Root cause: migration 109's `ALTER DEFAULT PRIVILEGES ... ON SEQUENCES TO
-- harness_app` has NO `FOR ROLE` clause, so it registered default privileges
-- ONLY for the role that executed 109 (postgres / postgres_app — see
-- pg_default_acl). But the native boot migrator (operator-core/lib/
-- db-boot-migrate.ts), db:migrate, and embedded-pg's migrator all connect as
-- harness_admin, so every migration-created table/sequence is OWNED BY
-- harness_admin — a creator role with no default-privilege rule. Each migration
-- explicitly GRANTed its TABLE to harness_app but relied on the (never-firing)
-- default-privilege safety net for the backing SEQUENCE, which silently stayed
-- ungranted.
--
-- (A) One-time catch-up GRANT on existing harness_shared sequences. All
--     harness_shared sequences are owned by harness_admin, so this is runnable
--     by the (non-superuser) native harness_admin role as well as the embedded
--     superuser harness_admin. Scoped to harness_shared because that is the only
--     schema with drift and the only one whose sequences harness_admin reliably
--     owns (audit/papercup_shared/papercusp_auth had 0 ungranted sequences).
-- (B) Durable root-cause fix: register default privileges keyed to harness_admin
--     — the role that actually creates migration objects — so future
--     harness_admin-owned sequences (and tables, defensively) auto-grant to
--     harness_app/harness_zero without each migration having to remember.
--
-- Idempotent: GRANT and ALTER DEFAULT PRIVILEGES are both safe to re-run.

GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA harness_shared TO harness_app;

DO $grants$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['harness_shared', 'papercup_shared', 'papercusp_auth', 'audit'] LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE harness_admin IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO harness_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE harness_admin IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO harness_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE harness_admin IN SCHEMA %I GRANT SELECT ON TABLES TO harness_zero', s);
  END LOOP;
END
$grants$;
