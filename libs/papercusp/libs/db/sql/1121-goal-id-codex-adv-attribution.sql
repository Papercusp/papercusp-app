-- 1121: resolve goal_id for CODEX isolation-root usage samples (WI-2145149).
--
-- Sibling of 1120. Same broken key, same fix shape -- but read the measurement
-- before assuming the same payoff, because it is NOT the same payoff, and the
-- honest number is the whole point of this header.
--
-- THE DEFECT (verified by reading pg_get_functiondef, not inferred from a
-- correlation). Both routes in the 2-arg `goal_id_for_usage_session` join
-- `adv_sessions` on `a.session_id = p_session_id`. The interactive ingester
-- stores the codex ROLLOUT uuid in `agent_usage_samples.session_id`, while the
-- key these psu-launched sessions are actually indexed by is `adv_sessions.id`
-- -- the bigint primary key carried by the per-session CODEX_HOME directory
-- `~/.papercusp/su-codex-homes/session-<advId>/`. So for codex rows the join
-- matches nothing and both routes return NULL, exactly as 1119/1120 found for
-- harness_slug.
--
-- MEASURED COVERAGE OF THIS ROUTE, BEFORE IT WAS WRITTEN (2026-09-05T03:35Z,
-- papercusp-workspace, 134 distinct advIds recovered from the codex homes on
-- disk -- the check that decided the design rather than justifying it after):
--
--   codex advIds                            134
--   ... with an adv_sessions row on id      134   (100.0%)   <- the key works
--   ... with a coord_owner_id               131   ( 97.8%)
--   ... resolving a goal_id                   3   (  2.2%)   <- the ceiling
--
--   resolving TODAY in production             0   (  0.0%)
--
-- So this migration moves codex goal attribution from 0 to 3 of 134. That is a
-- real, strictly monotonic improvement -- and it is also the ENTIRE achievable
-- set: the same 3 are all that resolve even when the OLD function is handed a
-- key it can match (`adv_sessions.session_id` fed in directly also yields 3/134).
-- The fix therefore captures 100% of what the data supports and leaves nothing
-- on the table. It is capped at 3 for a reason that has nothing to do with the
-- join key.
--
-- WHY THE CEILING IS 3 AND NOT 131 -- DO NOT MISREAD THIS AS A RESOLVER BUG.
-- The remaining 131 have a real adv_sessions row and a real coord owner whose
-- `agent_modes`/`session_briefs` simply carry NO goal. Goal provenance is close
-- to absent workspace-wide, and that is a separate and far larger finding than
-- this migration:
--
--   agent_modes rows, mode='goal', subject NOT NULL     150 (150 owners)
--   session_briefs rows, goal_id NOT NULL               189 (189 owners)
--   adv_sessions total                               22,229
--   adv_sessions resolving a goal by ANY route          344 (  1.55%)
--
-- The codex subset's 2.2% is therefore slightly ABOVE the 1.55% global base
-- rate, not below it. Checked against the possibility that the workspace
-- predicate was suppressing the lookup: it is not -- every goal row in both
-- tables lives under 'papercusp-workspace', so the sparsity is real and not a
-- scoping artifact. Anyone reading a NULL goal_id as evidence that this
-- resolver is broken should re-read those four numbers first.
--
-- BRANCH ORDER -- A DELIBERATE DEPARTURE FROM 1120's SHAPE. 1120 could rank its
-- branches purely by key strength because it had ONE semantic source
-- (session_briefs.harness_slug). This function has TWO, and their precedence is
-- already ratified: the session's GOAL-mode subject outranks an inherited
-- session_briefs.goal_id (881, EI-21128511122311550). Copying 1120's flat
-- key-first ordering would have silently INVERTED that ruling for any row where
-- both keys resolve. So semantics is the OUTER tier and key strength the INNER
-- tier: goal-mode subject (adv id, then session), then inherited brief goal
-- (adv id, then session). The ratified precedence is preserved exactly.
--
-- ADDITIVE ONLY. This creates a NEW 3-argument overload and leaves the existing
-- 2-argument function untouched, because the currently-deployed release checkout
-- and the desktop sidecar still call the 2-arg form
-- (papercusp-desktop/src-tauri/sidecar/serve.mjs, .../invoke-once.mjs,
-- libs/papercusp/packages/orchestrator/src/usage-sample-pg.ts,
-- packages/operator-core/lib/agent-usage-telemetry.ts). Dropping or re-signing
-- it would break goal attribution on :3070 the moment this applied, hours before
-- the new code ships. The two coexist unambiguously (different arity, no DEFAULT
-- on the new parameter, so no overload-resolution ambiguity). No destructive
-- DDL, hence no FORWARD-COMPAT acknowledgment is required.
--
-- EXPLICITLY NOT THE FIX: re-signing the rollout uuid out of `session_id` to
-- make the old join work. That column is load-bearing for the P3
-- session-attribution path (ingest-claude-transcripts.session-attribution
-- .integration.test.ts asserts the native uuid lands there).
--
-- NO INDEX, for the reason 1119/1120 recorded: adv_sessions' PK and
-- session_briefs.owner_id / agent_modes.owner_id are already indexed, so this
-- route is a PK lookup plus an indexed lookup. A plain CREATE INDEX on
-- agent_usage_samples remains a real hazard on a continuously-written table.

CREATE OR REPLACE FUNCTION harness_shared.goal_id_for_usage_session(
  p_workspace_id text,
  p_session_id text,
  p_adv_session_id bigint
) RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    -- TIER 1: the session's own GOAL-mode subject (outranks an inherited brief
    -- goal -- 881 / EI-21128511122311550). Preferred key first.
    -- 1a. adv_sessions PRIMARY KEY, carried by the per-session CODEX_HOME dir.
    (
      SELECT m.subject
        FROM harness_shared.adv_sessions a
        JOIN harness_shared.agent_modes m
          ON m.owner_id = a.coord_owner_id
         AND m.workspace_id = p_workspace_id
       WHERE a.id = p_adv_session_id
         AND m.mode = 'goal'
         AND m.subject IS NOT NULL
       ORDER BY m.set_at DESC
       LIMIT 1
    ),
    -- 1b. native session route, for adapters whose root carries no adv id.
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
    -- TIER 2: inherited session_briefs.goal_id. Same key preference.
    -- 2a. adv_sessions PRIMARY KEY.
    (
      SELECT b.goal_id
        FROM harness_shared.adv_sessions a
        JOIN harness_shared.session_briefs b
          ON b.owner_id = a.coord_owner_id
         AND b.workspace_id = p_workspace_id
       WHERE a.id = p_adv_session_id
         AND b.goal_id IS NOT NULL
       ORDER BY b.updated_at DESC
       LIMIT 1
    ),
    -- 2b. native session route.
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

COMMENT ON FUNCTION harness_shared.goal_id_for_usage_session(text, text, bigint) IS
  'Resolve write-time goal provenance for a usage sample. Precedence is SEMANTIC first (the session''s GOAL-mode subject outranks an inherited session_briefs.goal_id -- 881, EI-21128511122311550), then by key strength within each tier (adv_sessions PK from a per-session CODEX_HOME dir name, then the native session route). Measured 2026-09-05: lifts codex goal attribution from 0 to 3 of 134 sessions -- which is 100% of the achievable set, because 131 of those owners have no goal recorded on any brief or mode row. Workspace-wide only 344 of 22,229 adv_sessions (1.55%) resolve a goal by any route, so a NULL here is overwhelmingly absent goal data, NOT a resolver failure (WI-2145149).';
