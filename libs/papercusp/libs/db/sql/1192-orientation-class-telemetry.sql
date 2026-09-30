-- 1192 — ORIENTATION CLASS REACH + ACTION TELEMETRY
-- Plan: turn-start-memory-two-class-2026-09-21, item P-020.
--
-- WHY THIS EXISTS. D-003 admits a class to the turn-start block by the ACTOR
-- TEST: a field belongs there only if an agent would do something different on
-- reading it. That test was applied by JUDGEMENT when the improvement-triage
-- line was withdrawn (P-017) — nobody could measure that it had stopped
-- causing action, they inferred it from a HUD diff. This pair of tables is the
-- instrument that makes the same call from evidence next time:
--
--   REACH  — how often did a class actually reach an agent (turns rendered)?
--   ACTION — for a CLASS-B (obligation) row, how many turns did it stay
--            outstanding before it was dispositioned?
--
-- The two are DELIBERATELY separate relations rather than one table with a
-- nullable row key, because they answer at different GRAINS and a reader that
-- conflates them gets a wrong number silently: reach is per (owner, class) per
-- TURN, action is per (owner, class, row) across its whole lifetime. Summing
-- action rows does not give reach, and a class-A class has no action rows at
-- all — which is a MEASURABILITY fact the read must state, not a zero.
--
-- No destructive DDL: both relations are new, so no FORWARD-COMPAT line is
-- owed — the currently-deployed release cannot be using a table that does not
-- exist yet.

-- ── REACH ────────────────────────────────────────────────────────────────────
-- One row per (workspace, owner, sink, class). `turns_rendered` counts TURNS on
-- which at least one line of this class SURVIVED the outer character budget —
-- i.e. what the agent was actually told, not what the projection produced. A
-- class that is projected every turn and truncated away every turn has reach 0,
-- and that is the honest reading: it reached nobody.
CREATE TABLE IF NOT EXISTS harness_shared.orientation_class_reach (
  workspace_id      text        NOT NULL,
  owner_id          text        NOT NULL,
  -- The OrientationSink the rows were rendered for ('turn-start' today; the
  -- leader-brief / carry-brief / agent-orders sinks render the same registry).
  sink              text        NOT NULL,
  -- `keyof OrientationState` — the registry class id, e.g. 'ownerDirectives'.
  class_id          text        NOT NULL,
  turns_rendered    bigint      NOT NULL DEFAULT 0,
  -- Total LINES contributed across those turns. rows/turns is the class's mean
  -- cost, which is the other half of a keep/drop argument.
  rows_rendered     bigint      NOT NULL DEFAULT 0,
  first_rendered_at timestamptz NOT NULL DEFAULT now(),
  last_rendered_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, owner_id, sink, class_id)
);

-- The read is "per class, across every owner in this workspace", so the class
-- leads the index.
CREATE INDEX IF NOT EXISTS orientation_class_reach_by_class
  ON harness_shared.orientation_class_reach (workspace_id, sink, class_id);

-- ── ACTION ───────────────────────────────────────────────────────────────────
-- One row per CLASS-B obligation row, keyed by the row's own stable identity
-- (an owner-directive id, an open-check `carryRowKey`, an obligation-agenda
-- entry id). `turns_outstanding` counts the turns the row was present in the
-- RESOLVED STATE — not the turns it was rendered — because an obligation is
-- discharged by DISPOSITION and not by delivery (D-001/P-002), so a row the
-- budget truncated is still outstanding.
--
-- DISPOSITION IS OBSERVED AS DISAPPEARANCE. Class B is re-injected every turn
-- until dispositioned, so a row that stops appearing HAS been dispositioned.
-- That is why this needs no hook in orders:resolve-pending, work_items:*, or
-- any future disposition verb: a new obligation source is measured the day it
-- lands instead of the day someone remembers to instrument it.
CREATE TABLE IF NOT EXISTS harness_shared.orientation_obligation_action (
  workspace_id         text        NOT NULL,
  owner_id             text        NOT NULL,
  class_id             text        NOT NULL,
  -- Stable per-row identity WITHIN the class. Never the rendered text: a
  -- re-worded row is the same obligation (the reason `carryRowKey` exists).
  row_key              text        NOT NULL,
  turns_outstanding    bigint      NOT NULL DEFAULT 0,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  -- NULL ⇒ still outstanding. Set on the first turn the row is absent.
  dispositioned_at     timestamptz,
  -- `turns_outstanding` frozen at the MOST RECENT disposition. A key that
  -- reappears starts a new episode (counter below) and overwrites this, so it
  -- is the latest episode's cost, never a lifetime sum — stated here because a
  -- reader who assumes otherwise gets a plausible wrong median.
  turns_to_disposition bigint,
  -- How many times this row has been dispositioned. The 500-turn guard asks
  -- "did this class EVER cause an action", which is SUM(dispositions) per
  -- class — a question the single latest `turns_to_disposition` cannot answer
  -- once a row has reopened.
  dispositions         bigint      NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, owner_id, class_id, row_key)
);

-- The 500-turn guard reads dispositions per class across owners; the partial
-- index keeps that scan on the dispositioned rows only.
CREATE INDEX IF NOT EXISTS orientation_obligation_action_dispositioned
  ON harness_shared.orientation_obligation_action (workspace_id, class_id)
  WHERE dispositioned_at IS NOT NULL;

-- Closing a turn's absent rows is `WHERE dispositioned_at IS NULL` scoped to one
-- owner, which is the hottest write path here.
CREATE INDEX IF NOT EXISTS orientation_obligation_action_open
  ON harness_shared.orientation_obligation_action (workspace_id, owner_id)
  WHERE dispositioned_at IS NULL;

COMMENT ON TABLE harness_shared.orientation_class_reach IS
  'P-020 REACH: turns on which an orientation class survived the budget and reached an agent.';
COMMENT ON TABLE harness_shared.orientation_obligation_action IS
  'P-020 ACTION: per class-B obligation row, turns outstanding until disposition (disposition = the row stopped appearing).';
