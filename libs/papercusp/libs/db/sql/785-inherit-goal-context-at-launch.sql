-- Migration 785 — inherit goal context at launch
-- (goal-mode-hardening-2026-08-10 P-002, D-008).
--
-- WHY A SECOND CARRIER FOR "WHICH GOAL", when migration 767 already added one.
-- `harness_shared.agent_modes.subject` answers "which goal is this session
-- RUNNING" for a GOAL-mode session. That is the PORTFOLIO MANAGER's marker, and
-- it is the wrong thing to inherit: a spawned fleet member that inherited the
-- mode row would become a goal agent itself — precisely what P-002 forbids
-- ("a fleet member must not become a portfolio manager"). The two facts only
-- looked like one because, until now, only goal agents created work:
--
--   agent_modes.subject (mode='goal')  -> this session RUNS the goal
--   session_briefs.goal_id (this file) -> this session's WORK BELONGS TO the goal
--
-- REUSE-FIRST: a COLUMN on the existing per-owner session row, not a new table.
-- session_briefs is keyed by owner_id — exactly the key stampGoalProvenance()
-- already resolves by — and its lane columns (current_plan_slug, pot_slug,
-- harness_slug) are already the canonical record of "what ambient scope is this
-- session working in". "Which goal" is the same shape as "which plan", so it
-- belongs beside it rather than in a parallel agent_goal_context table that
-- would need its own lifecycle, cleanup and isolation for a fact an existing
-- row can hold.
--
-- PURELY ADDITIVE, so no FORWARD-COMPAT acknowledgment is required: a nullable
-- column with no default and no backfill. Existing rows read NULL, which
-- resolveGoalContext() treats as "no inherited goal" — bit-for-bit the
-- behaviour before this migration — and the currently-deployed release never
-- selects the column at all.

ALTER TABLE harness_shared.session_briefs
  ADD COLUMN IF NOT EXISTS goal_id text;

COMMENT ON COLUMN harness_shared.session_briefs.goal_id IS
  'The harness_shared.goals.id this session''s work SERVES, inherited from its launcher at spawn (goal-mode-hardening-2026-08-10 P-002, D-008). DISTINCT from agent_modes.subject on a mode=''goal'' row, which means the session RUNS the goal: a descendant inherits this column but NEVER that mode row, so goal provenance reaches fleet members without turning them into portfolio managers. Read through resolveGoalContext(), which prefers the mode subject and falls back here. Like every provenance stamp, a dangling value must degrade to "no stamp", never to a failed write.';

-- "What has this goal''s whole tree been doing" is a scan BY goal, and the
-- column is NULL for every agent not working under one, so a partial index
-- keeps that read cheap without paying to index the mostly-NULL majority.
CREATE INDEX IF NOT EXISTS session_briefs_goal_id_idx
  ON harness_shared.session_briefs (goal_id)
  WHERE goal_id IS NOT NULL;
