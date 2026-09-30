-- 745-routine-loop-transitions.sql — EI-19411045952024591.
--
-- THE FAULT THIS INSTRUMENTS
-- On 2026-08-03 five members of fleet `nonp2p-bug-drain-0801` took their last loop
-- fire between 03:21Z and 03:31Z and then received nothing for ~45min, until
-- `stalled-loops-guard` read them as dead and disarmed all five. Both candidate root
-- causes (the `poolCritical` shed at routines-workflow.ts, and a misresolved shared
-- `getOrgPg()` handle) were REFUTED with primary evidence — and the investigation then
-- dead-ended, because the fault is UNDIAGNOSABLE AFTER THE FACT with the state we keep.
--
-- WHY THE EXISTING STORES CANNOT ANSWER IT
-- There are two last-fire stores and BOTH are overwritten single-row state:
--   * `harness_shared.routines.last_fired_at`  (written by claimDueRoutine / fireRoutine /
--     recordEphemeralFire — every write destroys the previous value)
--   * `harness_shared.autoloop_state`          (recordFire(), upsert-on-conflict)
-- Neither retains HISTORY. So "which loops sat parked, from when, and which actor was
-- supposed to re-arm them" is not a hard query — it is an unanswerable one. The whole
-- signal was a `last_fired_at` frozen at 03:2xZ, which is equally consistent with
-- "never fired again", "fired and the fire was swallowed", and "re-armed then re-parked".
--
-- WHAT THIS RECORDS
-- One append-only row per LOOP LIFECYCLE TRANSITION — the `next_fire_at` state changes
-- that the single-row stores overwrite:
--
--   parked    a pure loop was claimed and parked at 'infinity' (its turn was dispatched)
--   rearmed   an actor moved it off 'infinity' back to a concrete fire time
--   disarmed  it was deactivated (guard disarm, cost-cap, loop:end)
--
-- The diagnostic value is in the ABSENCE: a `parked` row with no subsequent `rearmed`
-- row IS the fault, and `actor` names the last code path that touched the routine, so
-- the next occurrence starts from evidence instead of from two refuted hypotheses.
-- Park duration is `rearmed.at - parked.at`; a park that never re-armed is an open
-- interval whose age is the outage.
--
-- Deliberately a SEPARATE table rather than more columns on `routines`: the failure mode
-- being instrumented is precisely that single-row state gets overwritten, so recording
-- history in overwritable columns would reproduce the bug in the instrument.
--
-- Written fire-and-forget from the two chokepoints (claimDueRoutine's pure-loop park and
-- reconcileLoopRoutines' re-arm convergence point); a write failure here must never
-- perturb the fire path it reports on.
--
-- Idempotent; apply via the runner (db:migrate) or psql + a schema_migrations row in one txn.

\set ON_ERROR_STOP on
-- (No top-level BEGIN/COMMIT: the migration runner supplies the transaction.)

CREATE TABLE IF NOT EXISTS harness_shared.routine_loop_transitions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT now(),
  workspace_id     text        NOT NULL,
  install_slug     text        NOT NULL,
  routine_id       text        NOT NULL,
  routine_name     text,
  target_role      text,
  target_owner_id  text,
  event            text        NOT NULL,   -- 'parked' | 'rearmed' | 'disarmed'
  actor            text        NOT NULL,   -- the code path that made the transition
  new_next_fire_at timestamptz,            -- 'infinity' on a park; the re-armed instant; NULL on disarm
  interval_sec     integer,                -- routines.reschedule_interval_sec at transition time
  detail           jsonb,
  host             text
);

-- THE forensic query: "what happened to THIS loop, most recent first" — walk back from
-- a frozen last_fired_at and find the park with no matching re-arm.
CREATE INDEX IF NOT EXISTS routine_loop_transitions_routine_at_idx
  ON harness_shared.routine_loop_transitions (workspace_id, routine_id, at DESC);

-- Window scan: "every loop transition between t0 and t1" — the incident-window shape
-- (e.g. "which loops parked between 03:21Z and 03:31Z and never came back").
CREATE INDEX IF NOT EXISTS routine_loop_transitions_at_idx
  ON harness_shared.routine_loop_transitions (at DESC);

COMMENT ON TABLE harness_shared.routine_loop_transitions IS
  'EI-19411045952024591: append-only history of engine-loop next_fire_at transitions (parked/rearmed/disarmed), one row per transition. Exists because routines.last_fired_at and autoloop_state are BOTH overwritten single-row state, so a loop that parks and is never re-armed leaves no evidence of why — the fault that stopped serving 5 live agents for ~45min on 2026-08-03 and could not be diagnosed after the fact. A parked row with no subsequent rearmed row IS the fault; actor names the last path that touched the routine. Appended fire-and-forget from claimDueRoutine + reconcileLoopRoutines; never read on the hot fire path. Self-pruning (see routine-loop-transitions.ts prune).';
COMMENT ON COLUMN harness_shared.routine_loop_transitions.event IS
  'parked = claimed and parked at the ''infinity'' in-flight sentinel (turn dispatched); rearmed = moved off ''infinity'' back to a concrete fire time; disarmed = deactivated (guard disarm / cost-cap / loop:end).';
COMMENT ON COLUMN harness_shared.routine_loop_transitions.actor IS
  'The code path that made the transition (e.g. claim-due-routine, reconcile-loop-routines, loop-turn-outcome-429, stalled-loops-guard). The forensic payload: when a park never re-arms, this names who last held the routine.';
COMMENT ON COLUMN harness_shared.routine_loop_transitions.new_next_fire_at IS
  'The next_fire_at the transition WROTE — ''infinity'' for a park, the concrete instant for a re-arm, NULL for a disarm. Nullable and never trusted for control flow: this table is evidence, never an input to scheduling.';
