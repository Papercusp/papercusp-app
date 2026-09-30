-- 527-notes-app.sql
--
-- Minimal notes app (owner-ask-batch-2026-07-06 P-004, WI-3265): "Build me a
-- small notes app — something where I can jot notes down and search them
-- later. Keep it minimal." One row per note; workspace-scoped like every
-- other harness_shared table (RLS mirrors improvement_dispatches, migration
-- 238). Search is a simple ILIKE over title+body (P-004 says "keep it
-- minimal" — no full-text index needed at this scale).
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.notes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  text NOT NULL,
    title         text NOT NULL DEFAULT '',
    body          text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Primary read path: a workspace's notes, most-recently-updated first.
CREATE INDEX IF NOT EXISTS notes_ws_updated_at_idx
    ON harness_shared.notes (workspace_id, updated_at DESC);

ALTER TABLE harness_shared.notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notes_workspace_isolation ON harness_shared.notes;
CREATE POLICY notes_workspace_isolation ON harness_shared.notes
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.notes TO harness_app;
GRANT SELECT ON harness_shared.notes TO harness_zero;
