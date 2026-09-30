-- Dockview migration plan v4 — Phase 0 / Phase 2
-- Per-user named dock layouts. workspace_id and user_id are text:
-- workspace IDs are literals like 'default'; user_id is '_local' in loopback dev.

CREATE TABLE IF NOT EXISTS harness_shared.harness_dock_layouts (
  workspace_id    text   NOT NULL,
  user_id         text   NOT NULL,
  layout_name     text   NOT NULL DEFAULT 'default',
  schema_version  int    NOT NULL DEFAULT 1,
  layout_json     jsonb  NOT NULL,
  updated_ts      bigint NOT NULL,
  created_ts      bigint NOT NULL,
  PRIMARY KEY (workspace_id, user_id, layout_name)
);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.harness_dock_layouts TO harness_admin;
