-- 018-zero-migration-batch.sql
--
-- Migrate four file-backed REST polls to Zero WS push:
--   IssuesList "pending" poll (15s)        → harness_pending_issues
--   PhaseTabs phases poll (30s)            → harness_phases
--   TestsTab tests poll (30s)              → harness_tests
--   EscalationBanner mount fetch           → harness_escalations
--
-- All four follow the same pattern as harness_summaries / harness_proposals_shared:
-- a chokidar watcher in apps/operator/lib/harness-fs-watcher.ts mirrors the
-- source files into the table; (harness_slug, phase, ...) is the composite PK
-- so each phased worktree gets its own row.
--
-- Tables are added to the `zero_harness` publication and SELECT-granted to
-- `harness_zero` by scripts/fix-zero-harness-publication.sh.

-- Mirror of .harness/pending-issues.jsonl (one row per issue line).
CREATE TABLE IF NOT EXISTS harness_shared.harness_pending_issues (
  harness_slug TEXT NOT NULL,
  phase        TEXT NOT NULL DEFAULT 'staging',
  issue_id     TEXT NOT NULL,
  feature_id   TEXT,
  title        TEXT NOT NULL DEFAULT '',
  severity     TEXT NOT NULL DEFAULT 'normal',
  source       TEXT NOT NULL DEFAULT '',
  payload      JSONB NOT NULL,
  ts           BIGINT NOT NULL DEFAULT 0,
  mtime_ms     BIGINT NOT NULL DEFAULT 0,
  workspace_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (harness_slug, phase, issue_id)
);

-- Mirror of harness phase metadata (one row per (harness, phase)).
-- Watcher derives from .harness/config.json + worktree existence; the alive/
-- iteration/passed/total/cost fields are best-effort snapshots refreshed by the
-- 60s reconcile sweep.
CREATE TABLE IF NOT EXISTS harness_shared.harness_phases (
  harness_slug      TEXT NOT NULL,
  phase             TEXT NOT NULL,
  phase_path        TEXT NOT NULL DEFAULT '',
  branch            TEXT,
  port              INTEGER,
  public_url        TEXT,
  exists_on_disk    BOOLEAN NOT NULL DEFAULT false,
  alive             BOOLEAN NOT NULL DEFAULT false,
  passed_count      INTEGER NOT NULL DEFAULT 0,
  total_count       INTEGER NOT NULL DEFAULT 0,
  cost_usd          DOUBLE PRECISION NOT NULL DEFAULT 0,
  iteration         INTEGER NOT NULL DEFAULT 0,
  promotion_in_flight BOOLEAN NOT NULL DEFAULT false,
  mtime_ms          BIGINT NOT NULL DEFAULT 0,
  workspace_id      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (harness_slug, phase)
);

-- Mirror of test results under .harness/tests/ — one row per test file.
CREATE TABLE IF NOT EXISTS harness_shared.harness_tests (
  harness_slug TEXT NOT NULL,
  phase        TEXT NOT NULL DEFAULT 'staging',
  test_id      TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  last_run_ts  BIGINT,
  payload      JSONB NOT NULL,
  mtime_ms     BIGINT NOT NULL DEFAULT 0,
  workspace_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (harness_slug, phase, test_id)
);

-- Mirror of .harness/escalation.md + .harness/supervisor-notes.md (one row
-- per (harness, phase) — escalation either present or not).
CREATE TABLE IF NOT EXISTS harness_shared.harness_escalations (
  harness_slug      TEXT NOT NULL,
  phase             TEXT NOT NULL DEFAULT 'staging',
  escalation        TEXT,
  supervisor_notes  TEXT,
  mtime_ms          BIGINT NOT NULL DEFAULT 0,
  workspace_id      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (harness_slug, phase)
);
