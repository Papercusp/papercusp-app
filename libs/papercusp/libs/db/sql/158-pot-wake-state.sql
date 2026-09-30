-- 158-pot-wake-state.sql — autoloop-pot-operator-rebuild-2026-06-05 P0 (D-002).
--
-- The Pot operator's self-declared-wake state: one row per workspace holding the
-- persisted event-wake subscriptions (re-registered as event-reaction rules at
-- boot) + the last-wake timestamp the pot:wake floor-debounce reads. The TIME
-- wake itself is NOT here — it is durable in harness_shared.routines (the
-- one-shot `pot-wake` routine row). Follows the operator-state single-row-per-
-- workspace JSONB pattern (migration 020 idiom).
CREATE TABLE IF NOT EXISTS harness_shared.pot_wake (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

-- The runtime app role does CRUD (curator-operator D-009 lesson: owner-only
-- grants pass every test but fail the live harness_app connection).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.pot_wake TO harness_app;

-- harness_zero may not exist on every substrate (fresh embedded-pg) — guarded.
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.pot_wake TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

-- Workspace isolation, matching the operator-state table idiom (baseline).
ALTER TABLE harness_shared.pot_wake ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pot_wake_workspace_isolation ON harness_shared.pot_wake;
CREATE POLICY pot_wake_workspace_isolation ON harness_shared.pot_wake
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
