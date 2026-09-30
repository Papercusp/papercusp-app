-- Migration 1014 — durable detached testing:run snapshots (EI-21460735281159215).
--
-- testing:run launches a detached process group after the foreground transport
-- budget expires. Its in-memory snapshot is owned by one operator worker, so a
-- status request routed to another worker incorrectly returns unknown_run. This
-- table is the shared live-run ledger; test_runs remains the per-file history
-- ledger and harness_run_output remains agent transcript storage.
--
-- Expand-only and idempotent. The command is JSONB because a snapshot carries
-- an ordered argv array, while run_id stays TEXT so the store can preserve the
-- externally returned identifier without imposing a UUID parser on test seams.

CREATE TABLE IF NOT EXISTS harness_shared.testing_run_snapshots (
  run_id       TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL,
  file_path    TEXT,
  command      JSONB NOT NULL,
  status       TEXT NOT NULL,
  exit_code    INTEGER,
  started_at   TIMESTAMPTZ NOT NULL,
  finished_at  TIMESTAMPTZ,
  output       TEXT NOT NULL DEFAULT '',
  truncated    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT testing_run_snapshots_kind_ck CHECK (
    kind IN ('vitest', 'playwright', 'cargo', 'node', 'shell', 'admin-suite')
  ),
  CONSTRAINT testing_run_snapshots_status_ck CHECK (
    status IN ('running', 'pass', 'fail', 'cancelled', 'error')
  )
);

CREATE INDEX IF NOT EXISTS testing_run_snapshots_updated_idx
  ON harness_shared.testing_run_snapshots (updated_at DESC, run_id);

CREATE INDEX IF NOT EXISTS testing_run_snapshots_finished_idx
  ON harness_shared.testing_run_snapshots (finished_at DESC, run_id)
  WHERE finished_at IS NOT NULL;

COMMENT ON TABLE harness_shared.testing_run_snapshots IS
  'EI-21460735281159215: shared live snapshots for detached testing:run process groups; local operator maps remain the process-control cache and this table is the cross-worker status source.';

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.testing_run_snapshots TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.testing_run_snapshots TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;
