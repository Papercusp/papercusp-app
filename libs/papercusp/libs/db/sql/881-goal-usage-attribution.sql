-- 881: persist goal attribution on usage samples at write time
-- (EI-21128511122311550 — goal spend must not shrink when live membership does).
--
-- New samples carry the goal resolved from their native session at INSERT time:
-- adv_sessions.session_id -> coord_owner_id -> agent_modes.subject (the
-- session RUNS the goal), then session_briefs.goal_id (the session's work
-- INHERITS the goal). Existing rows remain nullable and are handled by the
-- rollup's legacy CURRENT-membership fallback; a historical backfill cannot
-- safely recover membership that has already been removed.

ALTER TABLE harness_shared.agent_usage_samples
  ADD COLUMN IF NOT EXISTS goal_id text;

COMMENT ON COLUMN harness_shared.agent_usage_samples.goal_id IS
  'Goal provenance resolved from the native session at usage-sample write time; nullable for pre-881 rows and sessions with no goal context.';

CREATE INDEX IF NOT EXISTS agent_usage_samples_ws_goal_ts_idx
  ON harness_shared.agent_usage_samples (workspace_id, goal_id, ts DESC)
  WHERE goal_id IS NOT NULL;

-- Keep the precedence in one database-side writer primitive so the three
-- usage-sample producers cannot drift. adv_sessions is intentionally not
-- workspace-filtered: native session ids and coord owner ids are global, and a
-- carry-respawn chain can retain rows under more than one workspace label.
CREATE OR REPLACE FUNCTION harness_shared.goal_id_for_usage_session(
  p_workspace_id text,
  p_session_id text
) RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (
      SELECT m.subject
        FROM harness_shared.adv_sessions a
        JOIN harness_shared.agent_modes m
          ON m.owner_id = a.coord_owner_id
         AND m.workspace_id = p_workspace_id
       WHERE a.session_id = p_session_id
         AND m.mode = 'goal'
         AND m.subject IS NOT NULL
       ORDER BY m.set_at DESC
       LIMIT 1
    ),
    (
      SELECT b.goal_id
        FROM harness_shared.adv_sessions a
        JOIN harness_shared.session_briefs b
          ON b.owner_id = a.coord_owner_id
         AND b.workspace_id = p_workspace_id
       WHERE a.session_id = p_session_id
         AND b.goal_id IS NOT NULL
       ORDER BY b.updated_at DESC
       LIMIT 1
    )
  )
$$;

COMMENT ON FUNCTION harness_shared.goal_id_for_usage_session(text, text) IS
  'Resolve write-time goal provenance from a native session, preferring the session''s GOAL-mode subject over inherited session_briefs.goal_id (EI-21128511122311550).';
