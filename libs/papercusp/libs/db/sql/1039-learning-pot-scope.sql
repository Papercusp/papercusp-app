-- 1039-learning-pot-scope.sql
--
-- THE PER-POT LEARNING GATE.
-- Plan learning-pot-scope-gate-2026-08-30, P-001 / D-001. Owner ask 2026-08-30:
-- "How can I configure which pots the learning tab is learning on?"
--
-- ## What this is
--
-- One row per (workspace_id, pot_slug) saying whether learning may run for that
-- pot AT ALL. Every learning lane's preflight ANDs this with its own arming:
--
--     lane runs  ⟺  potLearningEnabled(pot)  AND  <the lane's existing gate>
--
-- It does NOT replace any lane's arming, and it never writes to a lane's row.
-- That is the whole point (D-001): because each lane keeps its own config
-- untouched, switching a pot off and back on restores EXACTLY the lanes that
-- were armed before, and revives nothing that was deliberately parked.
--
-- ## Why a stored row rather than a derived predicate
--
-- Before this table, "is this pot learning" was DERIVED — true iff some lane
-- happened to be armed. A master toggle over a derived value cannot restore
-- state: turning a pot back on has nothing to read, so it would either arm
-- everything or arm a guessed default, and either way revive a lane a human
-- had deliberately parked. The pot's own bit is what makes the restore lossless
-- by construction instead of by bookkeeping.
--
-- The rejected alternative was a "remembered bulk write" — stamp each lane row
-- on pause and revive only stamped rows, reusing the `metadata.pause.groupPause`
-- idiom that `routines:group-set` already applies to the self-improvement group
-- (loop-control.ts). It needed no migration, but it is not a GATE: an agent
-- calling gym:arm could re-arm a pot the owner had switched off. Owner chose the
-- real gate.
--
-- ## ABSENT ROW MEANS ENABLED — this migration is deliberately inert
--
-- The table ships EMPTY and every reader treats a missing row as enabled
-- (plan R-5). So applying this stops nothing that is currently running; the gate
-- only begins to bite when someone explicitly switches a pot off. This is the
-- opposite posture from `learningGovernorPreflight`, which fails CLOSED — that
-- one is protecting spend against a broken ledger, whereas an unreadable pot row
-- must not turn into a fleet-wide learning outage. The asymmetry is intentional;
-- do not "fix" it into symmetry.
--
-- Purely additive DDL (CREATE TABLE / INDEX / POLICY / GRANT), so no
-- FORWARD-COMPAT acknowledgement is owed: the currently-deployed release simply
-- does not read this relation. Idempotent throughout.

CREATE TABLE IF NOT EXISTS harness_shared.learning_pot_scope (
    workspace_id text NOT NULL,
    -- The pot's HOME slug, matching learning_governor_loops.pot_slug and
    -- gym_autoloop_config.harness_slug. Deliberately NOT a foreign key: a pot
    -- can be dissolved while its scope row is still being read by an in-flight
    -- tick, and a dangling row here is harmless (it gates a pot nobody runs).
    pot_slug text NOT NULL,
    -- false = no learning lane may run for this pot, whatever its own arming says.
    enabled boolean NOT NULL DEFAULT true,
    -- Who last flipped it (an ownerId, or a human identity) — the audit trail the
    -- picker's bulk write stamps.
    set_by text,
    set_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT learning_pot_scope_pkey PRIMARY KEY (workspace_id, pot_slug)
);

COMMENT ON TABLE harness_shared.learning_pot_scope IS
  'Per-pot learning gate (plan learning-pot-scope-gate-2026-08-30 D-001). ANDed with each lane''s own arming; an ABSENT row means ENABLED, so this table being empty is the no-op state.';
COMMENT ON COLUMN harness_shared.learning_pot_scope.enabled IS
  'false = no learning lane runs for this pot regardless of gym_autoloop_config / learning_governor_loops / routines.active. Absent row = true.';

-- The only non-PK read shape: "which pots in this workspace are switched OFF"
-- (the picker's summary, and the rail's count). Partial, because the disabled
-- set is the small one and the enabled set is answered by absence.
CREATE INDEX IF NOT EXISTS learning_pot_scope_disabled_idx
  ON harness_shared.learning_pot_scope (workspace_id)
  WHERE enabled = false;

-- ── grants (mirrors 912 / 983: the runtime app role needs real CRUD) ────────
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.learning_pot_scope TO harness_app;

-- harness_zero may not exist on every substrate (fresh embedded-pg) — guarded.
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.learning_pot_scope TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

-- ── workspace isolation (every sibling learning table carries this policy:
--    gym_autoloop_config, learning_governor_loops, learning_spend_events) ────
ALTER TABLE harness_shared.learning_pot_scope ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_pot_scope_workspace_isolation ON harness_shared.learning_pot_scope;
CREATE POLICY learning_pot_scope_workspace_isolation ON harness_shared.learning_pot_scope
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
