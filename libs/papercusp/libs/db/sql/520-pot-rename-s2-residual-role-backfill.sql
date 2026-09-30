-- Migration 520 — pot-rename S2 RESIDUAL role-id backfill (audit sweep 2026-07-05, WI-2932).
--
-- The S2 contract (mig 519) backfilled the columns live introspection had flagged; a
-- post-land information_schema sweep of EVERY role-bearing column found ten more
-- attribution/audit columns still holding old role ids (counts at audit time):
--   decision_ledger.actor_role ×18810   adv_sessions.role ×6908
--   prompt_compositions.role ×5901      regret_findings.role ×64
--   code_recipe_runs.agent_role ×25     code_recipes.author_role ×25
--   harness_run_output.role ×20         spawn_sig_verification_failures.claimed_role ×13
--   agent_runs_consolidated.role ×8     code_run_nudge_fires.role ×8
-- None carries a CHECK; live readers dual-accept old|new, so this is value
-- canonicalization, not a behavior gate. All guarded → idempotent re-run = no-op.
--
-- Also re-runs the mig-519 §1 mop-up for spawned_agents/agent_usage_samples: live
-- pre-rename agents kept trailing old-id rows for a few minutes after 519 applied.

\set ON_ERROR_STOP on

UPDATE harness_shared.decision_ledger SET actor_role = CASE actor_role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE actor_role IN ('bee','queen','sentinel','overwatch','scout');

UPDATE harness_shared.adv_sessions SET role = CASE role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE role IN ('bee','queen','sentinel','overwatch','scout');

UPDATE harness_shared.prompt_compositions SET role = CASE role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE role IN ('bee','queen','sentinel','overwatch','scout');

UPDATE harness_shared.regret_findings SET role = CASE role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE role IN ('bee','queen','sentinel','overwatch','scout');

UPDATE harness_shared.code_recipe_runs SET agent_role = CASE agent_role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE agent_role IN ('bee','queen','sentinel','overwatch','scout');

UPDATE harness_shared.code_recipes SET author_role = CASE author_role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE author_role IN ('bee','queen','sentinel','overwatch','scout');

UPDATE harness_shared.harness_run_output SET role = CASE role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE role IN ('bee','queen','sentinel','overwatch','scout');

UPDATE harness_shared.spawn_sig_verification_failures SET claimed_role = CASE claimed_role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE claimed_role IN ('bee','queen','sentinel','overwatch','scout');

UPDATE harness_shared.agent_runs_consolidated SET role = CASE role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE role IN ('bee','queen','sentinel','overwatch','scout');

UPDATE harness_shared.code_run_nudge_fires SET role = CASE role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE role IN ('bee','queen','sentinel','overwatch','scout');

-- ── mig-519 §1 mop-up (trailing writes from live pre-rename agents) ─────────────────
UPDATE harness_shared.spawned_agents SET child_role = CASE child_role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE child_role IN ('bee','queen','sentinel','overwatch','scout');
UPDATE harness_shared.spawned_agents SET parent_role = CASE parent_role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE parent_role IN ('bee','queen','sentinel','overwatch','scout');
UPDATE harness_shared.agent_usage_samples SET role = CASE role
    WHEN 'bee' THEN 'cup' WHEN 'queen' THEN 'mug' WHEN 'sentinel' THEN 'papercup'
    WHEN 'overwatch' THEN 'kettle' WHEN 'scout' THEN 'blender' END
  WHERE role IN ('bee','queen','sentinel','overwatch','scout');
