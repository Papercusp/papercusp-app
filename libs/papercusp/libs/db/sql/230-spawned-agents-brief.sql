-- 230: persist the queen brief on the nursery row (dock 4-pane split,
-- pui-dock owner ask 2026-06-11). Until now the brief only rode the child's
-- env (QUEEN_BRIEF) — gone with the process, so nothing could show "what
-- started this agent" after launch. NULL = the spawn carried no brief.
ALTER TABLE harness_shared.spawned_agents
  ADD COLUMN IF NOT EXISTS brief TEXT NULL;

COMMENT ON COLUMN harness_shared.spawned_agents.brief IS
  'Queen-authored situational brief threaded into the spawn (QUEEN_BRIEF). NULL = none.';
