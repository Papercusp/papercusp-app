-- Framework-level shared tables for the Papercusp harness storage system.
-- Lives in `harness_shared`. Idempotent — safe to re-run.
--
-- A fresh Papercusp install only needs this. Demo installs (e.g. Papercup-org)
-- additionally run 003-papercusp-shared.sql to create their cross-dept message
-- bus tables in the separate `papercup_shared` schema.

CREATE SCHEMA IF NOT EXISTS harness_shared;

-- Generic audit trail for any harness action (feature edits, role hooks, etc.).
CREATE TABLE IF NOT EXISTS harness_shared.audit_log (
  id TEXT PRIMARY KEY,
  ts BIGINT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  details JSONB
);
CREATE INDEX IF NOT EXISTS audit_ts_idx      ON harness_shared.audit_log(ts);
CREATE INDEX IF NOT EXISTS audit_action_idx  ON harness_shared.audit_log(action);
-- Composite on (subject, ts DESC) replaces the bare (subject) index —
-- serves the same point-lookups AND lets MAX(ts) WHERE subject = ?
-- (operator-trigger-state.ts) be an O(1) index-only seek instead of a
-- range scan. Composite on (actor, action, ts DESC) covers the
-- operator-* read paths (operator-standing-candidates,
-- operator-ack-latency, operator-card-reconstruction, operator-stats).
CREATE INDEX IF NOT EXISTS audit_subject_ts_idx      ON harness_shared.audit_log(subject, ts DESC);
CREATE INDEX IF NOT EXISTS audit_actor_action_ts_idx ON harness_shared.audit_log(actor, action, ts DESC);
-- Drop the old single-column subject index if present from earlier installs;
-- the (subject, ts DESC) composite serves the same lookups.
DROP INDEX IF EXISTS harness_shared.audit_subject_idx;

-- Project registry. Some columns (owning_dept, vertical) are convenience
-- fields used by org-style demos; framework code treats them as optional.
CREATE TABLE IF NOT EXISTS harness_shared.projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  slug TEXT,
  budget_cents BIGINT,
  spent_cents BIGINT NOT NULL DEFAULT 0,
  cost_cap_cents BIGINT,
  earned_cents BIGINT NOT NULL DEFAULT 0,
  owning_dept TEXT,
  vertical TEXT,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL,
  metadata JSONB
);
CREATE INDEX IF NOT EXISTS projects_status_idx ON harness_shared.projects(status);
CREATE UNIQUE INDEX IF NOT EXISTS projects_slug_idx ON harness_shared.projects(slug);

GRANT USAGE ON SCHEMA harness_shared TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA harness_shared TO harness_app, harness_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA harness_shared
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO harness_app, harness_admin;

-- Cross-harness consolidated features mirror — trigger-maintained in
-- 002-per-harness-template.sql. Read-only at the SQL level (writes go
-- through per-harness API endpoints, the trigger does the rest). Why a
-- table not a view: PG can't include views in logical-replication
-- publications, so /features needed a real table to be Zero-subscribed.
CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
  harness_slug         TEXT NOT NULL,
  feature_id           TEXT NOT NULL,
  title                TEXT,
  summary              TEXT,
  status               TEXT,
  attempts             BIGINT,
  claims               TEXT,
  notes                TEXT,
  metadata             JSONB,
  kind                 TEXT,
  project_id           TEXT,
  expected_cost_cents  BIGINT,
  tags                 JSONB,
  needs_human_review   BOOLEAN,
  ts                   BIGINT,
  created_ts           BIGINT,
  updated_ts           BIGINT,
  parent_id            TEXT,
  goal_id              TEXT,
  taken_by             TEXT,
  taken_at             TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ,
  PRIMARY KEY (harness_slug, feature_id)
);
CREATE INDEX IF NOT EXISTS hfc_status_idx   ON harness_shared.harness_features_consolidated(status);
CREATE INDEX IF NOT EXISTS hfc_review_idx   ON harness_shared.harness_features_consolidated(needs_human_review);
CREATE INDEX IF NOT EXISTS hfc_slug_idx     ON harness_shared.harness_features_consolidated(harness_slug);
CREATE INDEX IF NOT EXISTS hfc_updated_idx  ON harness_shared.harness_features_consolidated(updated_ts DESC);

CREATE OR REPLACE FUNCTION harness_shared.sync_features_consolidated()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM harness_shared.harness_features_consolidated
      WHERE harness_slug = OLD.harness_slug AND feature_id = OLD.feature_id;
    RETURN OLD;
  END IF;
  INSERT INTO harness_shared.harness_features_consolidated (
    harness_slug, feature_id, title, summary, status, attempts, claims, notes,
    metadata, kind, project_id, expected_cost_cents, tags, needs_human_review,
    ts, created_ts, updated_ts, parent_id, goal_id, taken_by, taken_at, expires_at
  ) VALUES (
    NEW.harness_slug, NEW.feature_id, NEW.title, NEW.summary, NEW.status, NEW.attempts,
    NEW.claims, NEW.notes, NEW.metadata, NEW.kind, NEW.project_id, NEW.expected_cost_cents,
    NEW.tags, NEW.needs_human_review, NEW.ts, NEW.created_ts, NEW.updated_ts,
    NEW.parent_id, NEW.goal_id, NEW.taken_by, NEW.taken_at, NEW.expires_at
  )
  ON CONFLICT (harness_slug, feature_id) DO UPDATE SET
    title = EXCLUDED.title, summary = EXCLUDED.summary, status = EXCLUDED.status,
    attempts = EXCLUDED.attempts, claims = EXCLUDED.claims, notes = EXCLUDED.notes,
    metadata = EXCLUDED.metadata, kind = EXCLUDED.kind, project_id = EXCLUDED.project_id,
    expected_cost_cents = EXCLUDED.expected_cost_cents, tags = EXCLUDED.tags,
    needs_human_review = EXCLUDED.needs_human_review, ts = EXCLUDED.ts,
    created_ts = EXCLUDED.created_ts, updated_ts = EXCLUDED.updated_ts,
    parent_id = EXCLUDED.parent_id, goal_id = EXCLUDED.goal_id,
    taken_by = EXCLUDED.taken_by, taken_at = EXCLUDED.taken_at,
    expires_at = EXCLUDED.expires_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_features_consolidated TO harness_app, harness_admin;

-- ───────────────────────────────────────────────────────────────────────
-- plugin_enables: cross-harness mirror of each harness's
-- enabled-plugins.json. Source-of-truth is the JSON; the operator's
-- lib/plugin-enables-pg.ts mirrors writes into this table so reads
-- (Zero, /api/plugins/enabled) can use one PG query instead of
-- fanning over ~/.papercusp/harnesses/<slug>/enabled-plugins.json.
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.plugin_enables (
  harness_slug TEXT NOT NULL,
  plugin_slug  TEXT NOT NULL,
  version      TEXT NOT NULL DEFAULT '',
  config_hash  TEXT NOT NULL DEFAULT '',
  -- Zero schema declares this as `number` (epoch ms). Was TEXT in the
  -- first iteration; the type mismatch broke zeroPostgresJS's strict
  -- schema validation.
  enabled_at   BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (harness_slug, plugin_slug)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.plugin_enables TO harness_app, harness_admin;

-- ───────────────────────────────────────────────────────────────────────
-- plugin_configs: cross-harness mirror of each harness's
-- plugin-configs/<plugin>.json. Mirrors the shape declared in
-- @restart/zero-harness's pluginConfigs table; the operator's
-- lib/plugin-configs-pg.ts mirrors writes into this table.
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.plugin_configs (
  harness_slug TEXT NOT NULL,
  plugin_slug  TEXT NOT NULL,
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (harness_slug, plugin_slug)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.plugin_configs TO harness_app, harness_admin;
