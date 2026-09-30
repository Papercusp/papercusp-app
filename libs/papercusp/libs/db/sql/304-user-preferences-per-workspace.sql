-- 304-user-preferences-per-workspace.sql — workspace-data-isolation-leaks-2026-06-17
-- (owner decision D-001: user_preferences → per-workspace).
--
-- user_preferences is the per-USER override layer over the workspace-level prefs
-- (resolution: user → workspace → default, user-preferences.ts). It was keyed by
-- user_id ALONE, so a user's voice/language/token-budget overrides applied across
-- ALL their workspaces — the owner chose per-workspace isolation instead. The table
-- is EMPTY (verified 0 rows 2026-06-17), so no backfill: add workspace_id and re-key
-- the PK to (user_id, workspace_id). user-preferences.ts now scopes reads/writes to
-- the active workspace; a workspace with no user override falls through to the
-- workspace-level pref exactly as before.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS; DROP CONSTRAINT IF EXISTS then re-ADD the
-- composite PK — both default to the `user_preferences_pkey` name). Safe on an empty
-- table; no RLS here (user-preferences.ts reads via the admin handle + an explicit
-- workspace_id filter, matching the table's existing posture).

ALTER TABLE harness_shared.user_preferences
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';

ALTER TABLE harness_shared.user_preferences DROP CONSTRAINT IF EXISTS user_preferences_pkey;
ALTER TABLE harness_shared.user_preferences ADD CONSTRAINT user_preferences_pkey
  PRIMARY KEY (user_id, workspace_id);
