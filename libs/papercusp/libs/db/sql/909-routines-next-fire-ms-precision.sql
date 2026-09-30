-- 909-routines-next-fire-ms-precision.sql
--
-- WI-40883 — a routine whose next_fire_at was written by SQL now() could NEVER be claimed.
--
-- PostgreSQL `timestamptz` stores MICROSECONDS. `claimDueRoutine` reads a routine row
-- through postgres-js, which parses next_fire_at into a JS `Date` — a type that holds only
-- MILLISECONDS — and then sends that value back as the parameter of its optimistic-concurrency
-- guard (`next_fire_at IS NOT DISTINCT FROM $captured`). For any row whose next_fire_at was
-- written by SQL `now()` — i.e. every `INSERT ... next_fire_at) VALUES (..., now())` seeder —
-- the sub-millisecond digits are silently dropped on the way out and cannot be reproduced on
-- the way back in, so the guard is FALSE forever, the claim UPDATE matches zero rows, and
-- routinesTick skips the routine on every tick for the life of the row. Nothing errors and
-- nothing is logged: the routine is active, due, correctly configured, its handler is
-- registered — and it never runs.
--
-- MEASURED 2026-08-23 on the live operator DB before this migration: 11 active/due routines
-- had NEVER fired, against 162 healthy ones, and the split was exact — every never-fired row
-- carried sub-millisecond precision and every firing row did not. Dark routines included
-- green-checkpoint for three pots (hotel-reservations since 2026-08-21T19:29Z, ~36h, so those
-- pots' release gate had never once run), cross-hive-outbox-drain for three pots,
-- external-trigger-dispatch, google-calendar-poll, google-gmail-poll,
-- facebook-personal-vault-poll and gc-desktop-sessions.
--
-- THE FIX, at the source: make the column's precision match what every JS reader can actually
-- represent. Narrowing to timestamptz(3) means PG can no longer store a value a Date cannot
-- round-trip, so the whole class disappears for EVERY writer at once — including the existing
-- `now()`-writing seeders, none of which have to change. The ALTER also rounds the stored
-- values in place, which un-sticks the 11 dark rows: each becomes whole-millisecond, its
-- captured value compares equal again, and it is claimed on the next tick.
--
-- claim.ts additionally compares via date_trunc('milliseconds', next_fire_at) as
-- defence-in-depth for any writer path this column change does not cover. The two are
-- deliberately redundant: this migration removes the cause, that guard survives a future
-- column that reintroduces it.
--
-- FORWARD-COMPAT: this is a precision narrowing on two timestamp columns, not a destructive
-- schema change — no column, constraint or index is dropped or renamed, and nothing is set NOT
-- NULL. The currently-deployed release checkout serving :3070 reads both columns only as
-- instants (comparisons against now(), cron arithmetic, and display), never at sub-millisecond
-- resolution, and it writes them either as JS Dates (already millisecond values, unaffected) or
-- as `now()` (which the narrowed column simply rounds on write, exactly as intended here). Any
-- value the old code can produce is still storable and any value it reads back is still valid,
-- so the running release keeps working unchanged both before and after this applies.

ALTER TABLE harness_shared.routines
  ALTER COLUMN next_fire_at TYPE timestamptz(3),
  ALTER COLUMN last_fired_at TYPE timestamptz(3);

COMMENT ON COLUMN harness_shared.routines.next_fire_at IS
  'When this routine is next due. timestamptz(3) — MILLISECOND precision deliberately (WI-40883): '
  'claimDueRoutine compares this value after it has round-tripped through a JS Date, which cannot '
  'hold microseconds, so a µs-precision value here is unclaimable forever. Do not widen.';

COMMENT ON COLUMN harness_shared.routines.last_fired_at IS
  'When this routine last fired. timestamptz(3) — kept at millisecond precision alongside '
  'next_fire_at (WI-40883) so a future guard that compares it after a JS round-trip cannot '
  'reintroduce the unclaimable-routine class. Do not widen.';
