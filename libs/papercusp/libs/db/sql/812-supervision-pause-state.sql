-- 812-supervision-pause-state.sql — EI-20003974512096022 fixes 1+2.
--
-- operator_supervision_pause_state — one JSONB row per workspace holding, per
-- supervised systemd-user unit, WHEN that unit was first observed
-- administratively paused (`UnitFileState` = disabled|masked). This is the
-- clock the supervision reconciler needs to answer "how long has this been
-- paused", which drives BOTH:
--   fix 1 — escalate a persistent pause into ONE idempotent, claimable EI once
--           it outlives PAUSE_ESCALATION_MS, instead of only broadcasting;
--   fix 2 — ramp alert salience with duration (a 48h pause on a release-blocker
--           gate must not be reported at the same level as an 8-minute one).
--
-- Root cause this replaces: unit-reconciler.ts's `flapStateByUnit` is a
-- module-level in-memory Map, so a bg-host restart wipes every unit's pause
-- history (the same amnesia already documented on that file for `wasDown` in
-- EI-20083989508593730). Two consequences, both observed in the incident this
-- migration is named for: the transition-only notify latch re-fires after each
-- restart, which is how ONE 2-day pause of
-- `papercup-live-federation-gate.timer` produced 16 identical "respecting the
-- pause" broadcasts; and any duration threshold computed from that in-memory
-- clock would reset with it, so an escalation gated on "paused > N hours" would
-- SILENTLY NEVER FIRE on a box that restarts more often than N.
--
-- systemd cannot supply this clock either — measured 2026-08-12 against the
-- real paused unit, `systemctl --user show -p InactiveEnterTimestamp` returns
-- EMPTY (and InactiveEnterTimestampMonotonic=0) for a disabled unit, so the
-- duration has to be ours and it has to be durable.
--
-- Same architecture class, and the same fix, as migration 635
-- (operator_liveness_flap_state / EI-15126): move the in-memory dedup state
-- into a durable single-JSONB-row-per-workspace table read+written through the
-- operator-state-pg helpers.
--
-- payload shape: { [unit: string]: { pausedSince: number, escalatedAt: number |
--   null, lastNotifiedTier: string | null } } — read+mutated+written once per
--   reconciler tick (see supervision/pause-clock.ts).
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_supervision_pause_state (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_supervision_pause_state TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_supervision_pause_state TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_supervision_pause_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_supervision_pause_state_workspace_isolation ON harness_shared.operator_supervision_pause_state;
CREATE POLICY operator_supervision_pause_state_workspace_isolation ON harness_shared.operator_supervision_pause_state
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
