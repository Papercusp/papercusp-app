-- 765-goal-projects-link.sql — goal-mode-2026-08-07 P-016 (D-020, D-021, D-019)
--
-- WHAT IS MISSING
--
--   GOAL mode shipped its contract, its record (harness_shared.goals) and its four tools, but
--   nothing can answer the one question every owner-facing surface needs: WHAT BELONGS TO THIS
--   GOAL? Measured 2026-08-09 on the live operator DB: goals has 0 rows, work_items.goal_id is
--   NULL on all 65,462 rows, harness_features.goal_id on all 2,205, and not one of the ~210
--   sync-resolver queries is goal-shaped. So a goal agent's pots, plans, fleets and spend appear
--   across the UI with no common parent — indistinguishable from the system's own self-improvement
--   work, which competes with it for the same Mug placement and the same budget.
--
-- WHY A PAIRING TABLE AND NOT A COLUMN ON THE PROJECT  (D-020, owner-decided 2026-08-09)
--
--   A single goal slug on the project asserts a project has exactly one goal, forever. The owner's
--   worked scenario breaks that immediately: goal 1 "an app that makes money" is half-built across
--   several pots, then goal 2 "release to the App Store" arrives and BOTH want tallytime. A slot
--   cannot store that sentence at all, and adopting a project would silently overwrite goal 1's
--   claim with nothing recording it ever held it — goal 1's page would quietly show two projects
--   instead of three. One row per (goal, project) pairing stores both, overwrites nothing, and
--   makes a project moving between goals an audited write (removed_at/removed_by) rather than an
--   invisible mutation.
--
-- ROLE GOVERNS PLACEMENT, NOT COST — the two were deliberately separated (D-020 + D-021)
--
--   role='owner'  → the ONE goal permitted to hand work into this project. This is D-019's ruling:
--     the GOAL contract's clause 3 ("one placer per pot") names exactly two candidates, the Mug and
--     the goal agent, and does not cover two GOAL agents placing into the same pot — the same
--     double-placement failure one level up. `goal_projects_one_owner_per_project` below makes that
--     a DATABASE CONSTRAINT rather than a convention an agent has to remember.
--   role='contributing' → linked, visible, counted for spend, but routes work through the owner.
--
--   Cost is NOT derived from role. Per D-021 (owner-decided, overriding the bill-to-owner
--   recommendation) a shared project's cost shows in FULL on EVERY linked goal's meter, so each
--   goal honestly reads "the work I depend on costs this much". The invariant that creates:
--   GOAL METERS DO NOT SUM — two goals sharing a $141 project read $141 each, and a portfolio total
--   must be computed from the DISTINCT projects, never by adding the per-goal figures. That is
--   guarded in code (goal-spend.ts + its test), not here; this comment exists so the next reader of
--   this schema does not "fix" the apparent double-count.
--
-- THE OTHER HALF OF THE ANSWER: work_items.goal_id
--
--   The pairing table answers "which projects", which inherits plans/sessions/fleets/spend because
--   every one of those already carries harness_slug. But when two goals SHARE a project, the
--   individual work-items are what separate them — so the finer edge cannot be skipped. The column
--   already exists and has never been written; this migration only gives it an index so
--   "work-items of this goal" is not a sequential scan of 65k rows.
--
-- GOALS GAINS TWO COLUMNS
--
--   kill_criterion moves out of metadata->>'killCriterion' into a real column. The contract makes it
--   mandatory at creation and the owner-facing surface renders it verbatim and permanently, so it is
--   first-class data, not a metadata bag entry. Safe to promote rather than dual-write precisely
--   because the table has 0 rows — there is nothing to backfill (verified 2026-08-09).
--   tripwires holds the optional structured [{ metric, threshold, current, unit }] that render the
--   criterion as live bars ("day 12 of 30", "$310 of $500") instead of prose nobody re-checks. NULL
--   is fully supported: a free-text criterion simply renders with no bars.
--
-- FORWARD-COMPAT: purely additive — one new table, two new nullable columns, new indexes. No DROP,
-- RENAME or SET NOT NULL on any existing object, and no existing code reads goal_projects or the two
-- new goals columns, so the release currently serving :3070 is unaffected by this applying first.
-- The two partial UNIQUE indexes are on the NEW table only (zero rows at creation, so they cannot
-- fail to build against live data) and constrain writes that no deployed code performs yet.

/* ── the pairing list ──────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS harness_shared.goal_projects (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id text        NOT NULL,
    goal_id      text        NOT NULL REFERENCES harness_shared.goals(id) ON DELETE CASCADE,
    -- The project. A pot/harness install slug — the same value carried by work_items,
    -- harness_plans, adv_sessions and agent_usage_samples, which is what lets one pairing
    -- inherit the whole tree beneath a project.
    harness_slug text        NOT NULL,
    role         text        NOT NULL DEFAULT 'contributing',
    added_at     timestamptz NOT NULL DEFAULT now(),
    added_by     text,
    removed_at   timestamptz,
    removed_by   text,
    -- Why it was attached or detached — the audit trail a column overwrite could never keep.
    note         text,

    CONSTRAINT goal_projects_role_check
      CHECK (role IN ('owner', 'contributing')),
    CONSTRAINT goal_projects_workspace_nonempty
      CHECK (workspace_id <> ''),
    CONSTRAINT goal_projects_harness_nonempty
      CHECK (harness_slug <> '')
);

-- One LIVE pairing per (goal, project). Re-attaching a previously detached project is a new row,
-- so the history survives; only the live set is constrained.
CREATE UNIQUE INDEX IF NOT EXISTS goal_projects_live_pair_key
  ON harness_shared.goal_projects (workspace_id, goal_id, harness_slug)
  WHERE removed_at IS NULL;

-- D-019, enforced rather than merely written down: at most ONE goal may be the main owner of a
-- given project at a time. Promoting a second goal without demoting the first is a constraint
-- violation, not a silent double-placement that surfaces days later as duplicated work.
CREATE UNIQUE INDEX IF NOT EXISTS goal_projects_one_owner_per_project
  ON harness_shared.goal_projects (workspace_id, harness_slug)
  WHERE role = 'owner' AND removed_at IS NULL;

-- "the projects of this goal" — the portfolio read behind every goal surface.
CREATE INDEX IF NOT EXISTS goal_projects_by_goal_idx
  ON harness_shared.goal_projects (workspace_id, goal_id)
  WHERE removed_at IS NULL;

-- "which goals does this project serve" — the reverse read behind the goal chip on a pot card,
-- and behind the "shared with N other goals" marker D-021 requires next to a shared cost.
CREATE INDEX IF NOT EXISTS goal_projects_by_harness_idx
  ON harness_shared.goal_projects (workspace_id, harness_slug)
  WHERE removed_at IS NULL;

COMMENT ON TABLE harness_shared.goal_projects IS
  'One row per (goal, project) pairing — goal-mode-2026-08-07 D-020. A project may serve several goals; role=owner marks the single goal permitted to place work into it (D-019). Cost is NOT attributed by role: a shared project counts in full on every linked goal (D-021), so per-goal spend figures deliberately DO NOT SUM.';

COMMENT ON COLUMN harness_shared.goal_projects.role IS
  'owner | contributing. Governs PLACEMENT only (D-019) — never cost attribution (D-021).';

COMMENT ON COLUMN harness_shared.goal_projects.removed_at IS
  'Soft removal. A project moving between goals closes its old pairing rather than overwriting it, so the move leaves a trace.';

/* ── the finer edge: work-items ────────────────────────────────────────────────────────── */

-- The column already exists (and is NULL on every row); it has simply never been indexed, so
-- "the work-items of this goal" would scan 65k rows. Partial: only stamped rows are of interest.
CREATE INDEX IF NOT EXISTS work_items_goal_id_idx
  ON harness_shared.work_items (workspace_id, goal_id)
  WHERE goal_id IS NOT NULL;

COMMENT ON COLUMN harness_shared.work_items.goal_id IS
  'The GOAL this work serves — goal-mode-2026-08-07 P-016. Stamped from session context (the agent_modes row of a GOAL-mode session), never from agent self-report: a self-reported edge rots, and a forgotten stamp silently under-reports the spend meter used to decide whether to kill the goal. When two goals share a project, this is what separates their work.';

/* ── goals: promote the kill criterion, add tripwires ──────────────────────────────────── */

ALTER TABLE harness_shared.goals
  ADD COLUMN IF NOT EXISTS kill_criterion text,
  ADD COLUMN IF NOT EXISTS tripwires      jsonb;

COMMENT ON COLUMN harness_shared.goals.kill_criterion IS
  'The written condition under which this goal is abandoned. Mandatory at creation per the GOAL contract; rendered verbatim and permanently on the owner surface so a goal cannot quietly ratchet past the condition it was created under. Promoted from metadata->>killCriterion (the table had 0 rows, so nothing to backfill).';

COMMENT ON COLUMN harness_shared.goals.tripwires IS
  'Optional [{ metric, label, threshold, current, unit }] rendering the kill criterion as live bars ("day 12 of 30", "$310 of $500"). NULL is fully supported — a free-text criterion renders with no bars.';
