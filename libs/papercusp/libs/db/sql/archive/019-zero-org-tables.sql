-- 019-zero-org-tables.sql
--
-- Migrate the 7 org-dashboard REST polls to Zero WS push:
--   /api/org/charter             → org_charter
--   /api/org/departments         → org_departments
--   /api/org/projects            → org_projects
--   /api/org/<dept>/inbox        → org_inbox
--   /api/org/<dept>/outbox       → org_outbox
--   /api/org/<dept>/notes        → org_notes
--   /api/org/<dept>/decisions    → org_decisions
--
-- Source files (resolved per-org-root via the registry's harness_kind='org'
-- project, and per-department via harness_kind='department' + department_slug):
--   <org-root>/charter.md             → org_charter
--   <org-root>/departments.json       → org_departments
--   <org-root>/projects.json          → org_projects
--   <dept-harness>/.harness/inbox-view.jsonl   → org_inbox
--   <dept-harness>/.harness/outbox-view.jsonl  → org_outbox
--   <dept-harness>/.harness/director-notes.md  → org_notes
--   <dept-harness>/.harness/decision-log.md    → org_decisions
--
-- Currently there is one org root (slug='org'); the org_id column anticipates
-- multi-org support without a schema change.

CREATE TABLE IF NOT EXISTS harness_shared.org_charter (
  org_id       TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  mtime_ms     BIGINT NOT NULL DEFAULT 0,
  workspace_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (org_id)
);

CREATE TABLE IF NOT EXISTS harness_shared.org_departments (
  org_id       TEXT NOT NULL,
  dept_slug    TEXT NOT NULL,
  harness_slug TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  mandate      TEXT NOT NULL DEFAULT '',
  inbox_kinds  JSONB NOT NULL DEFAULT '[]'::jsonb,
  outbox_kinds JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload      JSONB NOT NULL,
  mtime_ms     BIGINT NOT NULL DEFAULT 0,
  workspace_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, dept_slug)
);

CREATE TABLE IF NOT EXISTS harness_shared.org_projects (
  org_id       TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  slug         TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  vertical     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT '',
  payload      JSONB NOT NULL,
  mtime_ms     BIGINT NOT NULL DEFAULT 0,
  workspace_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, project_id)
);

CREATE TABLE IF NOT EXISTS harness_shared.org_inbox (
  org_id       TEXT NOT NULL,
  dept_slug    TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  ts           BIGINT NOT NULL DEFAULT 0,
  msg_from     TEXT NOT NULL DEFAULT '',
  msg_to       JSONB NOT NULL DEFAULT '[]'::jsonb,
  kind         TEXT NOT NULL DEFAULT '',
  subject      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  ref_id       TEXT,
  project_id   TEXT,
  directive_id TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  payload      JSONB NOT NULL,
  mtime_ms     BIGINT NOT NULL DEFAULT 0,
  workspace_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, dept_slug, message_id)
);

CREATE TABLE IF NOT EXISTS harness_shared.org_outbox (
  org_id       TEXT NOT NULL,
  dept_slug    TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  ts           BIGINT NOT NULL DEFAULT 0,
  msg_from     TEXT NOT NULL DEFAULT '',
  msg_to       JSONB NOT NULL DEFAULT '[]'::jsonb,
  kind         TEXT NOT NULL DEFAULT '',
  subject      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  ref_id       TEXT,
  project_id   TEXT,
  directive_id TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  payload      JSONB NOT NULL,
  mtime_ms     BIGINT NOT NULL DEFAULT 0,
  workspace_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, dept_slug, message_id)
);

CREATE TABLE IF NOT EXISTS harness_shared.org_notes (
  org_id       TEXT NOT NULL,
  dept_slug    TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  mtime_ms     BIGINT NOT NULL DEFAULT 0,
  workspace_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, dept_slug)
);

CREATE TABLE IF NOT EXISTS harness_shared.org_decisions (
  org_id       TEXT NOT NULL,
  dept_slug    TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  mtime_ms     BIGINT NOT NULL DEFAULT 0,
  workspace_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (org_id, dept_slug)
);
