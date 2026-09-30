-- 017-harness-shared-phase-and-proposal-cols.sql
--
-- Phase 2.5 mirror tables grew columns that the Zero schema definition
-- references but the runtime DB doesn't have. The columns are added by
-- apps/operator/lib/ensure-schema.ts at startup, but ensure-schema is
-- gated on the harness fs-watcher actually loading — and any unrelated
-- compile error in lib/harness-fs-watcher.ts blocks it. Result: every
-- /api/zero-harness/rest-query for proposalsShared / featuresSheets /
-- issuesSheets / agentRunsSheets / pendingReviews returns
-- 500 "Schema incompatibility detected" until ensure-schema runs.
--
-- This migration codifies the additive changes so a fresh DB or a
-- repaired existing DB can match the Zero schema without depending on
-- ensure-schema firing at the right time.
--
-- The CREATE TABLE IF NOT EXISTS blocks below mirror the runtime DDL in
-- apps/operator/lib/ensure-schema.ts so this migration is self-sufficient
-- on a fresh PG data dir (the operator's lazy ensure-* runs after PG
-- bootstrap, so the table doesn't exist yet when the bootstrap migration
-- runner reaches this file).

-- harness_summaries: cross-harness mirror of .harness/summary.md.
CREATE TABLE IF NOT EXISTS harness_shared.harness_summaries (
  harness_slug  TEXT NOT NULL,
  phase         TEXT NOT NULL DEFAULT 'staging',
  content       TEXT NOT NULL DEFAULT '',
  mtime_ms      BIGINT NOT NULL DEFAULT 0,
  updated_at    BIGINT NOT NULL DEFAULT 0,
  workspace_id  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (harness_slug, phase)
);

-- pending_reviews: cross-harness mirror of .harness/pending-reviews/*.json.
CREATE TABLE IF NOT EXISTS harness_shared.pending_reviews (
  harness_slug TEXT NOT NULL,
  phase        TEXT NOT NULL DEFAULT 'staging',
  review_id    TEXT NOT NULL,
  feature_id   TEXT,
  kind         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  ts           BIGINT NOT NULL,
  resolved     BOOLEAN NOT NULL DEFAULT FALSE,
  mtime_ms     BIGINT NOT NULL DEFAULT 0,
  workspace_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (harness_slug, phase, review_id)
);

-- harness_proposals_shared: cross-harness mirror of .harness/proposals/*.json.
CREATE TABLE IF NOT EXISTS harness_shared.harness_proposals_shared (
  harness_slug    TEXT NOT NULL,
  phase           TEXT NOT NULL DEFAULT 'staging',
  proposal_id     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  review_verdict  TEXT,
  review_summary  TEXT,
  reviewed_at     BIGINT,
  applied_at      BIGINT,
  rejected_at     BIGINT,
  size_bytes      BIGINT NOT NULL DEFAULT 0,
  payload         JSONB NOT NULL,
  ts              BIGINT NOT NULL,
  mtime_ms        BIGINT NOT NULL DEFAULT 0,
  workspace_id    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (harness_slug, phase, proposal_id)
);

-- harness_summaries: add `phase` for staging/testing/production triple-mirror.
ALTER TABLE harness_shared.harness_summaries
  ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'staging';

-- pending_reviews: add `phase`.
ALTER TABLE harness_shared.pending_reviews
  ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'staging';

-- harness_proposals_shared: full set of Phase 2.5 columns.
ALTER TABLE harness_shared.harness_proposals_shared
  ADD COLUMN IF NOT EXISTS phase           TEXT NOT NULL DEFAULT 'staging',
  ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS review_verdict  TEXT,
  ADD COLUMN IF NOT EXISTS review_summary  TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at     BIGINT,
  ADD COLUMN IF NOT EXISTS applied_at      BIGINT,
  ADD COLUMN IF NOT EXISTS rejected_at     BIGINT,
  ADD COLUMN IF NOT EXISTS size_bytes      BIGINT NOT NULL DEFAULT 0;
