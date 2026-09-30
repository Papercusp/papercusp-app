-- 1046-in-process-sweep-arm-tier.sql
-- EI-19294826146331487 — "the pane is listing sweeps you can neither see running nor turn off."
--
-- Adds a THIRD value to the routines execution-tier discriminator introduced by
-- 408-routines-ephemeral-tier.sql:
--   - 'durable'    : a cron routine fired by the DBOS `routinesTick`.
--   - 'ephemeral'  : a frequent non-DBOS cadence armed by the per-host ephemeral executor.
--   - 'in-process' : NEW. An ARM-STATE-ONLY row for a sweep that is DECLARED IN CODE
--                    (`buildDefaultChecks()` in packages/operator-core/lib/dbos/in-process-periodic.ts,
--                    each riding its own `managedSetInterval`). The row is fired by NOBODY:
--                    `listDueCronRoutines` filters `tier='durable'` and
--                    `listActiveEphemeralRoutines` filters `tier='ephemeral'`, so a third value
--                    matches neither query and can never double-fire the sweep. Its ONLY job is
--                    to carry the sweep's durable on/off state in the `active` column — which is
--                    what gives the Automation pane a real switch to render for a population that
--                    previously showed an inert padlock ("no per-row switch yet").
--
-- WHY THE ROUTINES TABLE AND NOT A NEW ONE. The switch has to be reachable by the surface the
-- owner already clicks. The pane's toggle dispatches `routines:set { installSlug, name, active }`;
-- the catalog collapses a routines row and an inventory row that share (kind, name) into ONE row
-- whose control comes from the routines half. Putting the state anywhere else would have required
-- a parallel control plane for 17 rows — explicitly ruled out on the item.
--
-- The cadence rides `reschedule_interval_sec` (seconds), mirroring how the ephemeral tier stores
-- its cadence in `trigger_config.interval_sec`; it is display truth for the pane, not a schedule.
--
-- FORWARD-COMPAT: this only WIDENS a CHECK constraint (durable|ephemeral -> durable|ephemeral|
-- in-process). Every row the currently-deployed :3070 release can write still satisfies it, and
-- that release never writes or reads 'in-process', so it is unaffected by the new value; the
-- DROP+ADD is the standard idempotent re-statement idiom already used by 408, not a contraction.
--
-- IDEMPOTENT + non-destructive: no existing row changes tier, and re-running is a no-op.

ALTER TABLE harness_shared.routines
  DROP CONSTRAINT IF EXISTS routines_tier_check;
ALTER TABLE harness_shared.routines
  ADD CONSTRAINT routines_tier_check CHECK (tier IN ('durable', 'ephemeral', 'in-process'));

-- The arm-state reader's filter is `tier = 'in-process'` across ALL rows (active and inactive —
-- a DISABLED sweep is precisely the row it needs to find), so the existing partial index on
-- (tier, active) WHERE active = true cannot serve it.
CREATE INDEX IF NOT EXISTS routines_in_process_tier_idx
  ON harness_shared.routines (tier, name) WHERE tier = 'in-process';
