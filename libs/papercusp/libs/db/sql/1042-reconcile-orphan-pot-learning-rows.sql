-- 1042 — reconcile orphaned per-pot learning rows
-- (plan learning-pot-scope-gate-2026-08-30, P-011).
--
-- WHAT AN ORPHAN IS HERE. `gym_autoloop_config` and `learning_governor_loops`
-- are keyed by pot slug and live in the SHARED schema — not in `harness_<slug>`.
-- So dropping a pot's schema does not reach them, and deregistering the pot only
-- makes them INVISIBLE: no surface enumerates a row whose pot is gone, no tick
-- can run it, and nothing ever deletes it.
--
-- WHERE THEY CAME FROM. `pot:dissolve` and `pot:obliterate` have called
-- `teardownPotLearningLoop` since per-hive-learning-loops-2026-06-14 P-021, but
-- the external-bench teardown (`bench-harness-live.ts`) did not — it called
-- `removeHarnessFromWorkspace` + `dropHarnessSchema` only. Measured 2026-08-30:
-- 28 orphans in EACH table, every one an `xbench-su-*` / `xb*` / `heval*` bench
-- slug from July. That leak is fixed at the source in the same change as this
-- migration; this statement clears what it already left behind.
--
-- SPEND HISTORY IS NOT LOST. These are arming/config rows, not the ledger:
-- per-run cost lives in `harness_shared.agent_usage_samples`, keyed by
-- `harness_slug`, and is untouched here. (One orphan, `gymloopharness`, carries
-- spent_usd 13.52; its usage samples remain.)
--
-- THE GUARD, AND WHY IT IS NOT OPTIONAL. The predicate is "this pot is not in
-- the workspace registry". If a registry payload were empty or unreadable for a
-- workspace, that predicate would match EVERY row and delete every pot's arming
-- in one statement. So each DELETE is constrained to workspaces whose registry
-- actually resolved at least one project. A workspace with no readable registry
-- is skipped, which is the correct direction to fail: leaving an orphan costs
-- nothing, deleting a live pot's arming silently un-arms real learning.
--
-- Idempotent: re-running deletes nothing once the orphans are gone. On a fresh
-- substrate both tables are empty and this is a no-op.

WITH regs AS (
  SELECT r.workspace_id, p->>'slug' AS slug
    FROM harness_shared.harness_registry r,
         LATERAL jsonb_array_elements(r.payload->'projects') p
)
DELETE FROM harness_shared.gym_autoloop_config g
 WHERE EXISTS (SELECT 1 FROM regs WHERE regs.workspace_id = g.workspace_id)
   AND NOT EXISTS (
     SELECT 1 FROM regs
      WHERE regs.workspace_id = g.workspace_id
        AND regs.slug = g.harness_slug);

WITH regs AS (
  SELECT r.workspace_id, p->>'slug' AS slug
    FROM harness_shared.harness_registry r,
         LATERAL jsonb_array_elements(r.payload->'projects') p
)
DELETE FROM harness_shared.learning_governor_loops l
 WHERE l.pot_slug IS NOT NULL
   AND EXISTS (SELECT 1 FROM regs WHERE regs.workspace_id = l.workspace_id)
   AND NOT EXISTS (
     SELECT 1 FROM regs
      WHERE regs.workspace_id = l.workspace_id
        AND regs.slug = l.pot_slug);
