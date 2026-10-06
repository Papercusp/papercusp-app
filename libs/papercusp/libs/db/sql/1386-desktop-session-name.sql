-- Migration 1386 — desktop_sessions.name: one agent may own MANY live desktops
-- (agent-multi-desktops-grid-2026-10-06 P-002 / WI-10006481; decision D-003).
--
-- WHY. Migration 900's `desktop_sessions_live_scope_uq` allows exactly ONE live row
-- per (workspace_id, scope, scope_ref). For scope='agent' the scope_ref is the
-- agent's ownerId, so an agent could never hold a second desktop: the second insert
-- raised a unique violation. The owner asked that an agent be able to start as many
-- virtual desktops as it wants (directive #1448), so an agent-scoped desktop now
-- carries an agent-chosen `name` and uniqueness becomes per (agent, name).
--
-- WHAT DOES NOT CHANGE. Pot and workspace desktops keep `name` NULL (enforced by the
-- CHECK below), and so do the deployed-frame allocator's scope='agent' rows, which
-- never set it. COALESCE(name, '') folds every NULL into one comparable key, so for
-- each of those rows the index admits exactly what migration 900's admitted: still
-- one live desktop per pot, per workspace, and per frame agent.
--
-- FORWARD-COMPAT: the release serving :3070 never writes `name`, so every row it
-- inserts has name NULL, and for name-NULL rows the replacement index enforces the
-- identical uniqueness the dropped one did; the new column is nullable with no default
-- and the new CHECKs only constrain a column that release never sets.
--
-- lint-migrations: allow-index-swap Verified on this check's own hazard model (2026-10-06, WI-10006481): no ON CONFLICT anywhere targets desktop_sessions — not the working tree, not the deployed papercup-release checkout, not the bundled desktop sidecar serve.mjs (its only scope_ref ON CONFLICT is agent_facts). desktop-session-registry.ts inserts with a plain INSERT and never matches this index's name; the deployed release never writes name, and for name-NULL rows COALESCE(name,'') reproduces the dropped index's uniqueness exactly.
--
-- The index is dropped and recreated under the SAME name inside this migration's
-- transaction (the runner wraps each file), so no window exists where neither
-- uniqueness rule holds, and every comment/test that names the index stays accurate.
-- Idempotent: re-running converges on the same end state.

ALTER TABLE harness_shared.desktop_sessions
  ADD COLUMN IF NOT EXISTS name text;

COMMENT ON COLUMN harness_shared.desktop_sessions.name IS
  'Agent-chosen desktop name, unique per live (workspace, agent). Only scope=''agent'' '
  'desktops provisioned through computer:provision_desktop set it; pot, workspace and '
  'deployed-frame rows keep it NULL (plan agent-multi-desktops-grid-2026-10-06, D-003).';

DO $mig1386$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'desktop_sessions_name_scope_ck'
       AND conrelid = 'harness_shared.desktop_sessions'::regclass
  ) THEN
    -- A name on a pot/workspace row would silently split that scope's
    -- one-live-desktop rule into one-per-name.
    ALTER TABLE harness_shared.desktop_sessions
      ADD CONSTRAINT desktop_sessions_name_scope_ck
      CHECK (name IS NULL OR scope = 'agent');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'desktop_sessions_name_format_ck'
       AND conrelid = 'harness_shared.desktop_sessions'::regclass
  ) THEN
    -- Same shape the tool accepts (desktop-names.ts DESKTOP_NAME_PATTERN): a short
    -- lowercase slug, so a name is safe in a URL, a log line and a scope key.
    ALTER TABLE harness_shared.desktop_sessions
      ADD CONSTRAINT desktop_sessions_name_format_ck
      CHECK (name IS NULL OR name ~ '^[a-z0-9][a-z0-9._-]{0,62}$');
  END IF;
END
$mig1386$;

DROP INDEX IF EXISTS harness_shared.desktop_sessions_live_scope_uq;

CREATE UNIQUE INDEX desktop_sessions_live_scope_uq
  ON harness_shared.desktop_sessions (workspace_id, scope, scope_ref, COALESCE(name, ''))
  WHERE state NOT IN ('released', 'dead');

DO $mig1386post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'harness_shared'
       AND indexname  = 'desktop_sessions_live_scope_uq'
       AND indexdef LIKE '%COALESCE(name%'
  ) THEN
    RAISE EXCEPTION '1386: post-condition failed — desktop_sessions_live_scope_uq does not include name';
  END IF;
  RAISE NOTICE '1386: desktop_sessions.name installed; live-scope uniqueness is per (scope_ref, name)';
END
$mig1386post$;
