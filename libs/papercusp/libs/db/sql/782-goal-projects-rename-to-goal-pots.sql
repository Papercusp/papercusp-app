-- 782-goal-projects-rename-to-goal-pots.sql
-- goal-mode-hardening-2026-08-10 D-001 [owner 2026-08-10, interactive: "We dont have the
-- concept of projects so why use that verbiage instead of pots?" / "do the full rename"].
--
-- WHY. There is no "project" entity in this system. This table's own column is `harness_slug`
-- and migration 765's comment says so outright: "The project. A pot/harness install slug".
-- Worse, `harness_shared.projects` ALREADY EXISTS as a different table (the registered-harness
-- registry) which this one does not reference — so `goal_projects` reads as a link to `projects`
-- and is not one. The GOAL mode contract had to spend a whole clause explaining that a goal's
-- "projects" are pots, which is the tell that the word carries nothing.
--
-- WHY NOW. `goal_projects` has ZERO rows (measured 2026-08-10 across the live operator DB), so
-- this is a pure metadata rename: no backfill, no data risk, and no window where two shapes are
-- both populated. That is the cheapest this rename will ever be, and it gets strictly more
-- expensive the first time a real goal attaches a pot.
--
-- FORWARD-COMPAT: the currently-deployed release DOES read and write this table (its
-- sync-resolver joins `goal_projects` for the goals board, and goals:attach-project inserts into
-- it), so a bare rename would break :3070 for the whole deploy window — the DB migrates now while
-- the release checkout keeps serving older code. This migration therefore EXPANDS rather than
-- cutting over: the table is renamed and the old name is kept as an auto-updatable view over it,
-- so deployed reads AND writes keep working unchanged against `goal_projects` until :3070 serves
-- the renamed code. The view is the CONTRACT half's job to drop (tracked as
-- goal-mode-hardening-2026-08-10 P-010) — it is a deploy-window shim, not a permanent alias, and
-- D-001's "no aliases" rule governs the code surface, which this migration does not soften.

DO $$
BEGIN
  -- Idempotent + fresh-DB safe: a database built from a baseline that already carries goal_pots
  -- has nothing to do, and one that never had goal_projects (a future squashed baseline) must not
  -- fail here.
  IF to_regclass('harness_shared.goal_pots') IS NOT NULL THEN
    RETURN;
  END IF;
  IF to_regclass('harness_shared.goal_projects') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE harness_shared.goal_projects RENAME TO goal_pots;
  ALTER SEQUENCE harness_shared.goal_projects_id_seq RENAME TO goal_pots_id_seq;

  -- Postgres carries indexes, constraints and policies through a table rename but KEEPS their old
  -- names, so rename them explicitly: a `goal_projects_*` constraint violation raised against a
  -- table called goal_pots is exactly the kind of stale-name error that costs an hour to place.
  ALTER INDEX harness_shared.goal_projects_pkey            RENAME TO goal_pots_pkey;
  ALTER INDEX harness_shared.goal_projects_by_goal_idx     RENAME TO goal_pots_by_goal_idx;
  ALTER INDEX harness_shared.goal_projects_by_harness_idx  RENAME TO goal_pots_by_harness_idx;
  ALTER INDEX harness_shared.goal_projects_live_pair_key   RENAME TO goal_pots_live_pair_key;
  -- D-019's one-placer rule, renamed with the noun it polices.
  ALTER INDEX harness_shared.goal_projects_one_owner_per_project
    RENAME TO goal_pots_one_owner_per_pot;

  ALTER TABLE harness_shared.goal_pots
    RENAME CONSTRAINT goal_projects_goal_id_fkey TO goal_pots_goal_id_fkey;
  ALTER TABLE harness_shared.goal_pots
    RENAME CONSTRAINT goal_projects_role_check TO goal_pots_role_check;
  ALTER TABLE harness_shared.goal_pots
    RENAME CONSTRAINT goal_projects_harness_nonempty TO goal_pots_harness_nonempty;
  ALTER TABLE harness_shared.goal_pots
    RENAME CONSTRAINT goal_projects_workspace_nonempty TO goal_pots_workspace_nonempty;

  ALTER POLICY goal_projects_workspace_isolation ON harness_shared.goal_pots
    RENAME TO goal_pots_workspace_isolation;
END
$$;

-- The deploy-window shim described in FORWARD-COMPAT above. `security_invoker = true` is
-- load-bearing, not decoration: without it the view is evaluated as its OWNER, which would
-- silently BYPASS the workspace-isolation RLS policy on the underlying table and let one
-- workspace read another's rows through the old name. A simple single-table SELECT * view is
-- auto-updatable, so the deployed release's INSERT/UPDATE/DELETE against goal_projects keep
-- working too.
CREATE OR REPLACE VIEW harness_shared.goal_projects
  WITH (security_invoker = true) AS
  SELECT * FROM harness_shared.goal_pots;

COMMENT ON VIEW harness_shared.goal_projects IS
  'DEPLOY-WINDOW SHIM (migration 782, goal-mode-hardening-2026-08-10 D-001). The table is now harness_shared.goal_pots; this view exists only so the release checkout serving :3070 keeps working until it carries the renamed code. Do NOT write new code against this name — it is dropped by the contract migration (plan item P-010).';

COMMENT ON TABLE harness_shared.goal_pots IS
  'Which POTS a goal is pursued in, one row per (goal, pot) pairing. role=owner is the ONE goal permitted to place work into that pot (enforced by goal_pots_one_owner_per_pot); role=contributing is linked, visible and counted for spend but routes work through the owner. A shared pot''s cost shows IN FULL on every goal it serves, so per-goal figures do NOT sum — a portfolio total must be computed from the DISTINCT pots.';
