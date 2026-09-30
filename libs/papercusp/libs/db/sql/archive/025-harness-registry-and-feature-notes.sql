-- 025-harness-registry-and-feature-notes.sql
--
-- Round-6 file→PG migrations from the second-round audit:
--
--   <workspace>/registry.json                              → harness_registry
--   <workspace>/projects/<harness>/.harness/notes/<F>.md   → harness_feature_notes
--
-- harness_registry: per-workspace list of {slug, path, harness_kind,
--   department_slug?}. Single-row-per-workspace JSONB shape consistent with
--   the operator_state pattern (migration 020+). Read by 28 operator
--   callsites — converting to async is the unavoidable side-effect of
--   moving off the sync fs API.
--
-- harness_feature_notes: per-(workspace, harness, feature) markdown body.
--   Was previously one file per feature at
--   `<workspace>/projects/<harness>/.harness/notes/<feature>.md`. Compound
--   key lets agents query "all notes for harness X" or "notes touching
--   feature Y across all harnesses" — impossible with the file layout.

CREATE TABLE IF NOT EXISTS harness_shared.harness_registry (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS harness_shared.harness_feature_notes (
  workspace_id  TEXT NOT NULL,
  harness_slug  TEXT NOT NULL,
  feature_id    TEXT NOT NULL,
  content       TEXT NOT NULL,
  updated_at    BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, harness_slug, feature_id)
);

CREATE INDEX IF NOT EXISTS harness_feature_notes_harness_idx
  ON harness_shared.harness_feature_notes (workspace_id, harness_slug);
