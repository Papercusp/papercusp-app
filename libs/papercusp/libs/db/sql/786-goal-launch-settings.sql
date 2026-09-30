-- 786 — per-goal launch settings (goal-mode-hardening-2026-08-10 P-004, D-009)
--
-- The numbers a goal agent launches by: how many agents it may run in total
-- (D-005's ceiling over EVERY session associated with the goal), how large any
-- one of its fleets may get, and the model/effort/account/carry each ROLE it
-- spawns should use. D-006 keeps these as per-goal editable DATA rather than
-- prose in the GOAL contract, which is what makes them ownerchangeable at all.
--
-- ON THE GOAL ROW, not a `goal_launch_settings` table: the document is 1:1 with
-- the goal, keyed by the id every reader already holds, and dies with it. A
-- separate table would need its own lifecycle, cleanup and RLS to carry a fact
-- the goal's own row can hold (the same reasoning D-008 used to put inherited
-- goal context on `session_briefs` instead of minting `agent_goal_context`).
--
-- NOT folded into `goals.metadata`: that column is the untyped grab-bag
-- (startedBy / agentOwnerId / spentCents), and goals:update has just finished
-- migrating `killCriterion` OUT of it precisely because two sources of truth for
-- one field is how a reader ends up rendering the stale one. These settings are
-- typed (a zod schema in goal-launch-settings.ts) and owner-editable, so they get
-- their own column rather than going back into the bag that was just emptied.
--
-- EXPAND ONLY — one nullable ADD COLUMN, no backfill, no destructive DDL. NULL
-- is a meaningful value and the overwhelmingly common one: "no per-goal settings
-- declared", which resolves to exactly today's launch behaviour. The deployed
-- :3070 release never reads or writes this column, so it cannot be broken by it.

ALTER TABLE harness_shared.goals
  ADD COLUMN IF NOT EXISTS launch_settings jsonb;

COMMENT ON COLUMN harness_shared.goals.launch_settings IS
  'Per-goal launch settings (P-004/D-009): { maxAgents?, maxPerFleet?, defaults?, roles? }. '
  'Validated by goalLaunchSettingsSchema in packages/operator-core/lib/goal-launch-settings.ts — '
  'the shape is owned by that zod schema, not by this column. NULL = none declared = system defaults.';
