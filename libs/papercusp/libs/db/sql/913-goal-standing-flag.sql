-- 913 — goals.standing: the STANDING (stewardship) goal flavor.
--
-- work-on-everything-goal-2026-08-23 P-001. The plan ports the retired
-- Mug/autoloop's FEATURES into the goal system without changing that system's
-- design (D-001, owner-directed): a standing goal is an ORDINARY goal row with
-- one extra bit, never a second table and never a special-cased entity.
--
-- WHY A REAL COLUMN, NOT `metadata`. Same reasoning migration 786 wrote for
-- `launch_settings` and 765 for `kill_criterion`: this is first-class data the
-- read path branches on, not an untyped grab-bag key. Three consumers already
-- need to filter or branch on it — the GOAL-mode contract's STANDING clause
-- (P-008), the rolling budget window (P-004, which replaces the lifetime
-- ceiling comparison for these rows), and the creation-time mandates that a
-- standing goal is exempt from (a stewardship goal has no checkable achievement
-- and therefore no honest kill criterion; its stopping condition is its
-- tripwires plus the owner). A jsonb key cannot be indexed or constrained the
-- way those reads want.
--
-- POLARITY IS DELIBERATE AND DEFAULTS TO FALSE. `false` = an ordinary
-- outcome-shaped goal, which is what every one of the existing rows is and what
-- the GOAL contract still mandates by default ("the objective is an OUTCOME,
-- not a queue"). Standing is the OPT-IN exception, so the default covers every
-- pre-existing row correctly with no backfill and no migration of behavior:
-- nothing observable changes for any goal that does not set it. Reading this
-- flag as "the goal is active/alive" is the misreading to avoid — liveness is
-- `status` plus the holder policy (goal-live-holder-guarantee-2026-08-18);
-- `standing` says only that the goal is stewardship-shaped rather than
-- outcome-shaped.
--
-- NOT NULL + DEFAULT false rather than a nullable tri-state: there is no
-- meaningful third value here, and a NULL would force every consumer to decide
-- what an unset flag means (the exact ambiguity D-008 of the holder-guarantee
-- plan had to resolve for `requireLive`). Postgres 11+ applies a defaulted
-- ADD COLUMN without a table rewrite, so this is a metadata-only change on a
-- small table.
--
-- Multiple standing goals are ALLOWED, deliberately — there is no uniqueness
-- constraint here and none should be added. The plan originally proposed a
-- one-active-standing-goal-per-workspace singleton and the owner dropped it
-- (P-003, owner-directed 2026-08-23): a singleton would reintroduce the
-- centralized-decider shape the Mug retirement removed. Overlap between goals
-- is arbitrated by the claim layer, as it already is for ordinary goals.

ALTER TABLE harness_shared.goals
  ADD COLUMN IF NOT EXISTS standing boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN harness_shared.goals.standing IS
  'TRUE for a STANDING (stewardship) goal — one that pursues an ongoing duty rather than a checkable outcome, e.g. the bundled "work on everything" goal package. Standing goals are exempt from the creation-time checkable-outcome and kill-criterion mandates (their stopping condition is tripwires + the owner), and are budgeted by a rolling window rather than a lifetime ceiling. DEFAULT false = an ordinary outcome-shaped goal, which is what the GOAL contract still mandates by default; standing is the opt-in exception. NOT a liveness flag — liveness is status + the holder policy. Multiple standing goals are allowed by design (no uniqueness constraint): a singleton was deliberately rejected as reintroducing the retired centralized-decider shape.';

-- Partial index: every consumer of this column asks the same question — "which
-- standing goals are there (in this workspace)?" — and standing rows are by
-- construction a tiny minority of the table, so a partial index over the true
-- rows is both the smallest and the only shape that read needs. A full-column
-- index would be almost entirely `false` entries no query ever seeks.
CREATE INDEX IF NOT EXISTS goals_standing_idx
  ON harness_shared.goals (workspace_id, install_slug)
  WHERE standing;
