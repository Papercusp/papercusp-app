-- 964-fleet-type-single-paired.sql
-- directed-pair-work-items-2026-08-25 D-008 / P-010: a fleet is TYPED, so a
-- directed pair is a fleet TYPE rather than a parallel non-fleet construct.
-- Everything a fleet already gives us — presence, claims, locks, the scheduler,
-- leader-brief, restart durability — applies unchanged to a paired fleet.
--
--   fleet_type : 'single' (default — today's fleet, unchanged) | 'paired'
--
-- Mirrors the control_state precedent (mig 575): a typed enum-ish text column
-- on the durable registry row, so the type is PLATFORM state every member and
-- every late joiner reads at orient, not a launch-time argument that only the
-- launching agent remembers. Readers narrow defensively (only the one non-
-- default value is honored), so a legacy NULL row and a hand-forged value both
-- read back 'single'.
--
-- Purely additive expand: the column has a default and no existing code reads
-- it, so the currently-deployed release is unaffected while the DB migrates.

ALTER TABLE harness_shared.agent_fleets
  ADD COLUMN IF NOT EXISTS fleet_type text NOT NULL DEFAULT 'single';

COMMENT ON COLUMN harness_shared.agent_fleets.fleet_type IS
  'Fleet type (D-008/P-010): single | paired. single is today''s fleet, unchanged and the default; paired launches N director-implementer pairs whose launch options branch per role. Set at fleet:create / fleet:launch-on-plan; read by members at orient.';
