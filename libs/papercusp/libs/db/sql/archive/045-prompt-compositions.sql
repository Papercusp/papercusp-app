-- Migration 045 — prompt_compositions telemetry table.
--
-- Phase 5 of the agent-memory plan. Records per-invoke prompt size
-- breakdowns so we can verify cache discipline (stable preamble vs
-- volatile trailing zone) actually pays off in production.
--
-- One row per `invoke()` call. Written async after the spawn — the
-- log line at the same site is the transport channel; this row is
-- the persisted audit. Per architectural rule: never poll PG to
-- learn what happened; the log line tells the operator UI in real
-- time, this row enables historical queries.

BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.prompt_compositions (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  harness_slug  TEXT NOT NULL,
  feature_id    TEXT,                 -- nullable: roles like orchestrator have no feature
  role          TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  ts_ms         BIGINT NOT NULL,
  -- Per-section character counts. Tokens ≈ chars/4 for english; UI
  -- can convert if needed. Stored as INT (no realistic prompt > 2 GB).
  total_chars       INT NOT NULL DEFAULT 0,
  substrate_chars   INT NOT NULL DEFAULT 0,
  history_chars     INT NOT NULL DEFAULT 0,
  -- Reserved for future breakdown — populated when buildPrompt is
  -- refactored to return per-section sizes. NULL means "not measured."
  role_prompt_chars INT,
  memory_chars      INT,
  identity_chars    INT,
  runtime_chars     INT
);

CREATE INDEX IF NOT EXISTS prompt_compositions_by_harness
  ON harness_shared.prompt_compositions (workspace_id, harness_slug, ts_ms DESC);
CREATE INDEX IF NOT EXISTS prompt_compositions_by_feature
  ON harness_shared.prompt_compositions (workspace_id, harness_slug, feature_id, ts_ms DESC)
  WHERE feature_id IS NOT NULL;

ALTER TABLE harness_shared.prompt_compositions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prompt_compositions_workspace_isolation ON harness_shared.prompt_compositions;
CREATE POLICY prompt_compositions_workspace_isolation
  ON harness_shared.prompt_compositions
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT
  ON harness_shared.prompt_compositions TO harness_app;
GRANT USAGE, SELECT
  ON SEQUENCE harness_shared.prompt_compositions_id_seq TO harness_app;
GRANT ALL
  ON harness_shared.prompt_compositions TO harness_admin;
GRANT ALL
  ON SEQUENCE harness_shared.prompt_compositions_id_seq TO harness_admin;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
    GRANT SELECT ON harness_shared.prompt_compositions TO harness_zero;
    GRANT SELECT ON SEQUENCE harness_shared.prompt_compositions_id_seq TO harness_zero;
  END IF;
END$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'harness_shared_pub') THEN
    BEGIN
      ALTER PUBLICATION harness_shared_pub
        ADD TABLE harness_shared.prompt_compositions;
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
  END IF;
END$$;

COMMIT;
