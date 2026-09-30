-- Papercup-specific shared tables (cross-dept message bus).
-- Lives in `papercup_shared` schema, separate from the framework's
-- `harness_shared` schema. Idempotent — safe to re-run.
--
-- This file exists so a fresh install of Papercusp (the framework) does NOT
-- create these tables; only installs that opt into the Papercup-org demo
-- (or any other multi-dept org demo) need them.

CREATE SCHEMA IF NOT EXISTS papercup_shared;

CREATE TABLE IF NOT EXISTS papercup_shared.messages (
  id TEXT PRIMARY KEY,
  ts BIGINT NOT NULL,
  from_dept TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  ref_id TEXT,
  project_id TEXT,
  directive_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  metadata JSONB
);
CREATE INDEX IF NOT EXISTS messages_ts_idx        ON papercup_shared.messages(ts);
CREATE INDEX IF NOT EXISTS messages_kind_idx      ON papercup_shared.messages(kind);
CREATE INDEX IF NOT EXISTS messages_from_idx      ON papercup_shared.messages(from_dept);
CREATE INDEX IF NOT EXISTS messages_status_idx    ON papercup_shared.messages(status);
CREATE INDEX IF NOT EXISTS messages_project_idx   ON papercup_shared.messages(project_id);
CREATE INDEX IF NOT EXISTS messages_directive_idx ON papercup_shared.messages(directive_id);

CREATE TABLE IF NOT EXISTS papercup_shared.message_recipients (
  message_id TEXT NOT NULL REFERENCES papercup_shared.messages(id) ON DELETE CASCADE,
  dept_slug TEXT NOT NULL,
  PRIMARY KEY (message_id, dept_slug)
);
CREATE INDEX IF NOT EXISTS recipients_dept_idx ON papercup_shared.message_recipients(dept_slug);

CREATE TABLE IF NOT EXISTS papercup_shared.message_comments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES papercup_shared.messages(id) ON DELETE CASCADE,
  ts BIGINT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_msg_idx ON papercup_shared.message_comments(message_id);
CREATE INDEX IF NOT EXISTS comments_ts_idx  ON papercup_shared.message_comments(ts);

CREATE TABLE IF NOT EXISTS papercup_shared.directive_summaries (
  id TEXT PRIMARY KEY,
  directive_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  author TEXT NOT NULL DEFAULT 'ceo',
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS summaries_directive_idx ON papercup_shared.directive_summaries(directive_id);
CREATE INDEX IF NOT EXISTS summaries_ts_idx        ON papercup_shared.directive_summaries(ts);

GRANT USAGE ON SCHEMA papercup_shared TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA papercup_shared TO harness_app, harness_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA papercup_shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO harness_app, harness_admin;

-- ───────────────────────────────────────────────────────────────────────
-- briefings: quarterly executive briefings (script + render artifacts).
-- Schema mirrors the columns declared in @restart/zero-harness's
-- briefings table so zeroPostgresJS's schema validation can find every
-- column it expects. Driven by apps/papercup's briefing pipeline.
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS papercup_shared.briefings (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  quarter           TEXT NOT NULL,
  status            TEXT NOT NULL,
  created_at        BIGINT NOT NULL,
  script_path       TEXT,
  duration_seconds  BIGINT,
  youtube_url       TEXT,
  youtube_video_id  TEXT,
  thumbnail_url     TEXT,
  render_log        TEXT,
  error             TEXT,
  summary           TEXT
);

CREATE INDEX IF NOT EXISTS briefings_quarter_idx ON papercup_shared.briefings(quarter);
CREATE INDEX IF NOT EXISTS briefings_status_idx  ON papercup_shared.briefings(status);
