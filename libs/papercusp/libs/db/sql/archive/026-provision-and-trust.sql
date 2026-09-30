-- 026-provision-and-trust.sql
--
-- Round-6 file→PG migrations (continued):
--
--   <ws>/harnesses/<slug>/provision/<plugin>/state.json + resources.wal.jsonl
--                                                       → provision_state
--   <ws>/harnesses/<slug>/provision/<plugin>/audit.log → provision_audit_log
--   <ws>/trust.json                                     → operator_trust_store
--
-- provision_state: single row per (workspace, harness, plugin). The WAL
--   exists today as a crash-safety shim around state.json — PG transactions
--   give us the same guarantee natively, so the WAL goes away.
--
-- provision_audit_log: per-row append-only events. Indexed for the common
--   "all events for (harness, plugin) ordered by ts" query.
--
-- operator_trust_store: single row per workspace, JSONB payload mirrors
--   the existing TrustStore shape ({entries, rotations, blocklist}). NOT
--   in zero_harness publication — security state.

CREATE TABLE IF NOT EXISTS harness_shared.provision_state (
  workspace_id  TEXT NOT NULL,
  harness_slug  TEXT NOT NULL,
  plugin_slug   TEXT NOT NULL,
  payload       JSONB NOT NULL,
  updated_at    BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, harness_slug, plugin_slug)
);

CREATE TABLE IF NOT EXISTS harness_shared.provision_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  harness_slug  TEXT NOT NULL,
  plugin_slug   TEXT NOT NULL,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind          TEXT NOT NULL,
  run_id        TEXT,
  data          JSONB
);

CREATE INDEX IF NOT EXISTS provision_audit_log_target_idx
  ON harness_shared.provision_audit_log (workspace_id, harness_slug, plugin_slug, ts);

-- Trust store is sensitive — NOT in zero_harness publication.
CREATE TABLE IF NOT EXISTS harness_shared.operator_trust_store (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);
