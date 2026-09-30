-- Migration 137 — plugin_audit_log (the ships-broken fail-closed regression).
--
-- Plan: revive-plugin-system-2026-06-04 (D-001 / P0).
--
-- `harness_shared.plugin_audit_log` was the ONLY plugin table never folded into
-- the migration baseline — it existed solely via a runtime `ensureTable()`
-- `CREATE TABLE IF NOT EXISTS` in plugin-audit-writer.ts. That violates the
-- repo's "schema = migrations only; NO runtime DDL" policy AND ships broken:
-- `ServerActionRegistry.invoke()` is FAIL-CLOSED on audit (an action that ran
-- but couldn't be audited is rejected), and the audit write begins with that
-- `CREATE TABLE`. On a least-privilege PG role (the ship direction —
-- `harness_app` has NO CREATE on `harness_shared`) the CREATE fails →
-- every plugin *action* fails. It was masked on the dev box only because the
-- audit writer connects as `harness_admin`, which has CREATE.
--
-- Fix: define the table here (so it exists without any runtime DDL), grant the
-- app role INSERT/SELECT + the BIGSERIAL sequence so a non-superuser role can
-- write audit rows, and delete the runtime ensureTable() from
-- plugin-audit-writer.ts (the now-redundant grants ensureTable() in
-- plugin-grants.ts is deleted too — its table is already in 000-baseline.sql).
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS; GRANTs are idempotent.
-- Roles harness_app/harness_zero are created by the embedded-pg boot prereqs
-- before migrations run (mirrored by fresh-migrate.integration.test.ts), so the
-- unguarded GRANTs match migration 136's pattern.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.plugin_audit_log (
  id                  BIGSERIAL PRIMARY KEY,
  ts                  TIMESTAMPTZ NOT NULL,
  plugin_name         TEXT NOT NULL,
  install_slug        TEXT NOT NULL,
  action_name         TEXT NOT NULL,
  trigger_source      TEXT NOT NULL,
  trigger_id          TEXT,
  params_json         JSONB,
  outcome             TEXT NOT NULL,
  duration_ms         INTEGER NOT NULL,
  error_message       TEXT,
  capabilities_used   TEXT[],
  killed_by_timeout   BOOLEAN,
  stdout_bytes        INTEGER,
  stderr_bytes        INTEGER,
  truncated           BOOLEAN
);

COMMENT ON TABLE harness_shared.plugin_audit_log IS
  'Append-only audit of plugin action invocations (one row per ServerActionRegistry.invoke). Written by PgAuditWriter; the invoke path is fail-closed on this write. Migrated from runtime ensureTable() DDL in revive-plugin-system D-001.';

CREATE INDEX IF NOT EXISTS plugin_audit_by_plugin
  ON harness_shared.plugin_audit_log (plugin_name, ts DESC);
CREATE INDEX IF NOT EXISTS plugin_audit_by_harness
  ON harness_shared.plugin_audit_log (install_slug, ts DESC);
CREATE INDEX IF NOT EXISTS plugin_audit_outcome
  ON harness_shared.plugin_audit_log (outcome) WHERE outcome != 'ok';

-- The whole point of D-001: a non-superuser role must be able to write audit
-- rows. INSERT needs the table grant AND the BIGSERIAL sequence.
--   - harness_admin is the runtime audit writer (PgAuditWriter → getOrgPg). In
--     embedded-pg it's SUPERUSER (grant is a redundant no-op there), but on the
--     native dev box it is NOT — so without this grant the table created by the
--     migration-applying role would be un-writable by the writer, re-breaking
--     the very fail-closed path D-001 fixes.
--   - harness_app is the least-privilege ship role (the regression's target).
--   - harness_zero gets read parity with sibling tables (migration 136 pattern).
GRANT SELECT, INSERT ON harness_shared.plugin_audit_log TO harness_admin, harness_app;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.plugin_audit_log_id_seq TO harness_admin, harness_app;
GRANT SELECT ON harness_shared.plugin_audit_log TO harness_zero;

COMMIT;
