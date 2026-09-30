-- Dockview migration plan v4 — Phase 4
-- Remembers last-used phase per (workspace, harness, user). Reopening a
-- view:harness-overview panel for a slug defaults to whatever phase the
-- user last had it in; falls back to 'staging' on miss.

CREATE TABLE IF NOT EXISTS harness_shared.harness_phase_last_used (
  workspace_id  text   NOT NULL,
  harness_slug  text   NOT NULL,
  user_id       text   NOT NULL,
  phase         text   NOT NULL,
  updated_ts    bigint NOT NULL,
  PRIMARY KEY (workspace_id, harness_slug, user_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.harness_phase_last_used TO harness_admin;
