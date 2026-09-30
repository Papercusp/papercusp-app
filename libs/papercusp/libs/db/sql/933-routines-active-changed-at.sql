-- 933: harness_shared.routines.active_changed_at — "since when has this routine been paused",
-- derived by the database instead of inferred from an unrelated column.
--
-- EI-21299569563939689.
--
-- WHAT WAS WRONG. `green-stall-watchdog.ts`'s release-trigger freeze alarm answers "has the
-- deploy trigger been paused long enough to call it a SILENT fleet-wide freeze?" by computing
-- `now() - routines.updated_at`. Its field comment justified that with an invariant:
--
--     routines:set is the ONLY writer of `active` (the playbook forbids raw UPDATE) and always
--     stamps `updated_at = now()` on every flip, so this doubles as "since when it went
--     inactive" without a dedicated column.
--
-- The invariant is already false. `updated_at` is stamped by at least eight raw UPDATE sites —
-- green-stall-watchdog's own watchdogAlerted flips, gate-health-merge's candidate/retriage
-- markers, git-sync-action, watchdog-tunables, seed-scan-routine, hive-git-gc-routine,
-- autoloop/control, dead-owner-control-sweep — most of which never touch `active` at all.
--
-- The error is directional and it is the dangerous direction. Every one of those writes moves
-- `updated_at` FORWARD, so `now() - updated_at` UNDER-states the pause age: the age never
-- crosses the threshold, and the alarm fires late or never. The condition it guards has already
-- recurred twice (2026-06-18, 2026-07-12) with no auto-recovery, and by construction it "will
-- NEVER self-clear" — a paused routine has no cadence to catch up on. So the failure mode here
-- is a watchdog that stays quiet during exactly the outage it exists to catch.
--
-- WHY A TRIGGER AND NOT "routines:set ALSO WRITES THE NEW COLUMN". A column that each writer
-- must remember to stamp reproduces the original defect one column over: `active` is flipped by
-- routines:set, routines:group-set, autoloop:control and dead-owner-control-sweep TODAY, and
-- nothing stops the next one from being added without the stamp. A BEFORE UPDATE trigger gated
-- on `OLD.active IS DISTINCT FROM NEW.active` is correct by construction for every writer that
-- exists now, every writer added later, and a hand-run UPDATE in psql — none of which can opt
-- out. This is the derive rung of the derived-truth ladder rather than the curate rung.
--
-- NOT DESTRUCTIVE: this migration only ADDs a column, a function and a trigger. The currently
-- deployed release never selects `active_changed_at` and is unaffected by a trigger that writes
-- only NEW (no visible behaviour change to any existing statement), so no FORWARD-COMPAT
-- acknowledgment is required.

ALTER TABLE harness_shared.routines
  ADD COLUMN IF NOT EXISTS active_changed_at timestamptz;

-- New rows: the row's `active` is established at INSERT, so that IS the flip instant.
ALTER TABLE harness_shared.routines
  ALTER COLUMN active_changed_at SET DEFAULT now();

-- BACKFILL — deliberately `updated_at`, not `now()`.
--
-- `updated_at >= active_changed_at` always (the flip is itself a write), so for existing rows
-- `updated_at` is the best available LOWER bound on the true pause age, and seeding from it
-- reproduces today's computed value EXACTLY. That makes this migration a behaviour no-op at
-- apply time: nothing starts or stops alarming because 933 ran, and the column only becomes
-- more accurate than the old expression from the next flip onward.
--
-- `now()` was the alternative and is wrong: it would reset the clock on every currently-paused
-- routine, silencing a freeze that may already be hours old — the exact failure being fixed.
-- Leaving it NULL is also wrong: the reader treats an unresolvable timestamp as maximally
-- stale, so every paused routine would alarm at once on the deploy that reads this column.
UPDATE harness_shared.routines
   SET active_changed_at = updated_at
 WHERE active_changed_at IS NULL;

CREATE OR REPLACE FUNCTION harness_shared.set_routines_active_changed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.active_changed_at := now();
  RETURN NEW;
END;
$$;

-- The WHEN clause is the whole point: a metadata-only write (gate-health markers, watchdogAlerted
-- flips, next_fire_at ticks) must leave `active_changed_at` untouched, so the pause age keeps
-- accruing across them. Postgres evaluates a row trigger's WHEN without entering the function,
-- so the routines tick's per-fire UPDATEs pay a comparison, not a call.
DROP TRIGGER IF EXISTS routines_active_changed_at_trg ON harness_shared.routines;
CREATE TRIGGER routines_active_changed_at_trg
  BEFORE UPDATE ON harness_shared.routines
  FOR EACH ROW
  WHEN (OLD.active IS DISTINCT FROM NEW.active)
  EXECUTE FUNCTION harness_shared.set_routines_active_changed_at();

COMMENT ON COLUMN harness_shared.routines.active_changed_at IS
  'When `active` last flipped, stamped by routines_active_changed_at_trg — NOT by application '
  'code. Read this, never `updated_at`, for "how long has this routine been paused": `updated_at` '
  'moves on any metadata write and therefore under-states the pause age (EI-21299569563939689).';
