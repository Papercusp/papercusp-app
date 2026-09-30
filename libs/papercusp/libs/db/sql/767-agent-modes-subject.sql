-- 767-agent-modes-subject.sql — goal-mode-2026-08-07 P-016
--
-- THE PROBLEM THIS SOLVES
--
--   P-016 requires goal provenance to be stamped FROM SESSION CONTEXT, never from agent
--   self-report — because a self-reported edge rots, and a forgotten stamp silently
--   under-reports the spend meter used to decide whether to kill the goal (D-021).
--
--   "Session context" for a GOAL-mode agent means: WHICH goal is this session running?
--   harness_shared.agent_modes already records THAT a session is in GOAL mode
--   (axis_key='overlay:goal', mode='goal') but has nowhere to record WHICH goal — its eight
--   columns are workspace_id, owner_id, axis_key, mode, reason, set_by, owner_directed, set_at.
--
-- WHY A COLUMN HERE RATHER THAN A NEW TABLE
--
--   Reuse-first. agent_modes IS the per-session "what mode is this in" record, and "which goal"
--   is a PARAMETER of that mode, not a separate concern needing its own registry, its own
--   lifecycle and its own cleanup. A goal_sessions side-table would duplicate agent_modes'
--   entire key (workspace_id, owner_id) and its entire lifetime, and would then need its own
--   answer to every question agent_modes has already answered — what happens on mode exit, on
--   an auto-switch, on a session ending.
--
--   The field is deliberately named `subject`, not `goal_id`. Other modes have the same shape of
--   missing parameter: DRAIN has a scope, GRADE has a rubric. One generic "what is this mode
--   about" slot serves all of them; a goal_id column would need a sibling per mode.
--
--   It is NOT a foreign key to goals.id for the same reason — the value is mode-defined. GOAL
--   stores a goal id; another mode may store a plan slug or a rubric ref. The GOAL read path
--   joins to goals and tolerates a miss (a goal deleted out from under a live session resolves to
--   no stamp rather than an error), which is the correct behaviour anyway: an unstamped row is
--   recoverable, a failed work-item creation is not.
--
-- WHO WRITES IT
--
--   modes/store.ts setMode() (a new optional opt), and goals:create, which sets it on the caller
--   as a side effect of filing the goal. That side effect is the whole point: the agent never has
--   to remember to declare which goal it is working on, because filing the goal IS the
--   declaration. Clearing a mode clears the row, so the subject cannot outlive the mode.
--
-- FORWARD-COMPAT: one new NULLABLE column with no default and no constraint. Every existing
-- reader does `SELECT *` and maps named fields (modes/store.ts toRow), so an extra column is
-- ignored rather than positionally misread, and no deployed code writes it. Safe under the
-- two-port model regardless of which release checkout is serving :3070.

ALTER TABLE harness_shared.agent_modes
  ADD COLUMN IF NOT EXISTS subject text;

COMMENT ON COLUMN harness_shared.agent_modes.subject IS
  'WHAT this mode is about, mode-defined and optional. GOAL stores the harness_shared.goals.id the session is running, which is how provenance is stamped from session context rather than agent self-report (goal-mode-2026-08-07 P-016). Deliberately generic and NOT a foreign key: other modes may store a plan slug or a rubric ref, and a dangling value must degrade to "no stamp", never to a failed write.';
