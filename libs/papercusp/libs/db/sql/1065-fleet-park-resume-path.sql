-- 1065-fleet-park-resume-path.sql
--
-- WI-2034563 / capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01 P-008:
-- a park directive (fleet:wind-down / fleet:pause) had NO resume path. Members
-- were told to end their loops, did so, and were left with no wake source and no
-- key to await — ~23/45 members of one fleet sat parked 2.5-6h with claims held
-- while the fleet read as under-strength. Measured 2026-09-01 03:30-03:47Z.
--
-- The park directive now carries its own way back, on the same durable row as the
-- state it parks (mig 575's control_state/reason/by/at):
--
--   control_resume_gate   : the DECLARED, LATCHING event key members await instead
--                           of ending wake-less. fleet:resume FIRES it, so a member
--                           parked on the key is woken by the lift itself. Latching
--                           means a member that registers AFTER the fire is still
--                           told immediately, which is what makes the park safe to
--                           join late (a carry-respawn, a slow member).
--   control_expires_at    : optional epoch-ms deadline for the park. A park with a
--                           deadline is BOUNDED capacity loss; one without is
--                           indefinite and is surfaced as such in fleet:leader-brief.
--   control_no_resume_path: the park is deliberately TERMINAL — nobody is coming
--                           back (mission over; every member already in a terminal
--                           session state, which is what fleet-control-reconcile
--                           wind-downs record). This is the ONLY shape that still
--                           authorizes a member's wake-less loop:end.
--
-- Legacy winding-down rows carry none of the three, so they resolve exactly as they
-- did before this migration: no gate, no deadline, wake-less stop still authorized.
-- The change is additive at the read layer, never retroactive.
--
-- Columns are APPENDED for the same reason mig 964 appended fleet_type: COLS in
-- agent-fleets-store.ts binds positionally in createFleetIfAbsent's VALUES.

ALTER TABLE harness_shared.agent_fleets
  ADD COLUMN IF NOT EXISTS control_resume_gate    text,
  ADD COLUMN IF NOT EXISTS control_expires_at     bigint,
  ADD COLUMN IF NOT EXISTS control_no_resume_path boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN harness_shared.agent_fleets.control_resume_gate IS
  'WI-2034563: the declared, latching resume-gate event key for the current park directive (fleet:<slug>:<gate>). Members events:await it instead of ending their loop wake-less; fleet:resume fires it. NULL on an active fleet and on legacy pre-1065 wind-downs.';

COMMENT ON COLUMN harness_shared.agent_fleets.control_expires_at IS
  'WI-2034563: optional epoch-ms deadline after which the park directive is overdue. Bounds the capacity loss; a NULL deadline is an indefinite park and is reported as such by fleet:leader-brief. Advisory — the state is not auto-flipped by a read.';

COMMENT ON COLUMN harness_shared.agent_fleets.control_no_resume_path IS
  'WI-2034563: true when the park is deliberately TERMINAL (nobody is coming back). The only park shape that still authorizes a member wake-less loop:end; every other shape steers the member onto control_resume_gate instead.';
