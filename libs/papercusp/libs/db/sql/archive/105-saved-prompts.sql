-- Migration 105 — saved_prompts: cross-client saved prompts.
--
-- Plan saved-prompts-cross-client. Canonical store for user-authored
-- reusable prompts, scoped either workspace-global (harness_slug NULL) or
-- to a single harness. The on-disk command files Claude/OMP/Codex read are
-- a deterministic projection of these rows (D-001) — this table is the
-- source of truth, edited from the harness settings + personalization UI.

BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.saved_prompts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT NOT NULL,
  harness_slug  TEXT,                 -- NULL ⇒ workspace-global; a slug ⇒ harness-scoped
  name          TEXT NOT NULL,        -- the slash command (`/name`); slug-validated app-side
  body          TEXT NOT NULL,        -- prompt markdown (supports $ARGUMENTS, $1..$9)
  description   TEXT,
  arg_hint      TEXT,                 -- maps to Claude `argument-hint`
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One prompt name per scope. Workspace-global rows collapse harness_slug to
-- '' so they share a namespace distinct from each harness's.
CREATE UNIQUE INDEX IF NOT EXISTS saved_prompts_scope_name
  ON harness_shared.saved_prompts (workspace_id, COALESCE(harness_slug, ''), name);

ALTER TABLE harness_shared.saved_prompts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saved_prompts_workspace_isolation ON harness_shared.saved_prompts;
CREATE POLICY saved_prompts_workspace_isolation
  ON harness_shared.saved_prompts
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.saved_prompts TO harness_app;
GRANT ALL
  ON harness_shared.saved_prompts TO harness_admin;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
    GRANT SELECT ON harness_shared.saved_prompts TO harness_zero;
  END IF;
END$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'harness_shared_pub') THEN
    BEGIN
      ALTER PUBLICATION harness_shared_pub
        ADD TABLE harness_shared.saved_prompts;
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
  END IF;
END$$;

COMMIT;
