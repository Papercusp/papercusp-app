-- Migration 042 — chunk plans for the worker chunk loop.
--
-- The worker chunk loop (libs/papercusp/packages/orchestrator/src/
-- worker-chunk-loop.ts) plans all chunks of a feature up-front and
-- iterates through them. We persist the plan + per-chunk status so the
-- harness UI can show "F-AUTH-001: chunk 3/12 in progress" and so a
-- restarted orchestrator can resume cleanly.
--
-- One row per chunk. The plan is reconstructable by selecting all
-- chunks for a feature ordered by chunk_index.
--
-- Idempotent + non-destructive — drops nothing, only adds.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.harness_chunk_plans (
  workspace_id   TEXT NOT NULL,
  harness_slug   TEXT NOT NULL,
  feature_id     TEXT NOT NULL,
  chunk_id       TEXT NOT NULL,        -- e.g. F-AUTH-001-3
  chunk_index    INT  NOT NULL,        -- 1-based position in the plan
  files          JSONB NOT NULL,       -- string[] — declared file paths
  description    TEXT NOT NULL,        -- 'verb object', ≤72 chars
  status         TEXT NOT NULL DEFAULT 'pending',
                                       -- pending | in_progress | committed | failing | escalated
  strikes        INT NOT NULL DEFAULT 0,
  last_error     TEXT,                 -- truncated typecheck output on most recent failure
  commit_sha     TEXT,                 -- set on successful commit
  created_ts     BIGINT NOT NULL DEFAULT (extract(epoch from now())*1000)::bigint,
  updated_ts     BIGINT NOT NULL DEFAULT (extract(epoch from now())*1000)::bigint,
  PRIMARY KEY (workspace_id, harness_slug, feature_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_chunk_plans_by_feature
  ON harness_shared.harness_chunk_plans (workspace_id, harness_slug, feature_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_chunk_plans_by_status
  ON harness_shared.harness_chunk_plans (workspace_id, harness_slug, status)
  WHERE status IN ('in_progress', 'failing', 'escalated');

-- RLS: same workspace-scoping as every other harness_shared table.
ALTER TABLE harness_shared.harness_chunk_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chunk_plans_workspace_isolation ON harness_shared.harness_chunk_plans;
CREATE POLICY chunk_plans_workspace_isolation
  ON harness_shared.harness_chunk_plans
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- Grants follow the standard pattern: harness_app reads/writes via app
-- code, harness_admin gets full DDL, harness_zero needs SELECT for
-- replication into the operator UI.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.harness_chunk_plans TO harness_app;
GRANT ALL ON harness_shared.harness_chunk_plans TO harness_admin;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
    GRANT SELECT ON harness_shared.harness_chunk_plans TO harness_zero;
  END IF;
END$$;

-- Add to the Zero publication if it exists. Like other tables in this
-- migration set, the publication add must come AFTER the GRANT SELECT
-- to harness_zero — otherwise zero-cache crashloops on permission
-- errors during initial sync (see feedback memory:
-- feedback_zero_cache_grant_before_publication).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'harness_shared_pub') THEN
    BEGIN
      ALTER PUBLICATION harness_shared_pub
        ADD TABLE harness_shared.harness_chunk_plans;
    EXCEPTION WHEN duplicate_object THEN
      -- Already in publication — fine.
      NULL;
    END;
  END IF;
END$$;

COMMIT;
