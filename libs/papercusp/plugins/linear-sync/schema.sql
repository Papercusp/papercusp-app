-- @papercupai/linear-sync — plugin Postgres schema (mirrors jira-sync's shape).

CREATE SCHEMA IF NOT EXISTS plugin_linear_sync;

CREATE TABLE IF NOT EXISTS plugin_linear_sync.links (
  harness_slug   TEXT NOT NULL,
  entity_kind    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  external_id    TEXT NOT NULL,                                -- Linear issue UUID
  external_identifier TEXT NOT NULL,                           -- e.g. ENG-42
  external_url   TEXT NOT NULL,
  local_hash     TEXT NOT NULL,
  remote_hash    TEXT NOT NULL,
  remote_meta    JSONB NOT NULL DEFAULT '{}'::jsonb,
  tombstoned     BOOLEAN NOT NULL DEFAULT FALSE,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (harness_slug, entity_kind, entity_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS links_external_idx
  ON plugin_linear_sync.links (harness_slug, entity_kind, external_id);

CREATE TABLE IF NOT EXISTS plugin_linear_sync.cursors (
  harness_slug    TEXT PRIMARY KEY,
  local_cursor    BIGINT NOT NULL DEFAULT 0,
  remote_cursor   TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  last_full_sync  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS plugin_linear_sync.conflicts (
  id             BIGSERIAL PRIMARY KEY,
  harness_slug   TEXT NOT NULL,
  entity_kind    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  external_id    TEXT,
  field          TEXT NOT NULL,
  local_value    JSONB,
  remote_value   JSONB,
  resolution     TEXT NOT NULL,
  resolved_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conflicts_lookup_idx
  ON plugin_linear_sync.conflicts (harness_slug, entity_kind, entity_id, resolved_at DESC);
