-- 135-migration-reservations.sql
-- Atomic migration-number allocator (handoff-coordination-dx-followups-2026-06-04 §A1).
--
-- Problem: agents pick the next migration NNN by `ls | tail`, so two agents
-- racing both choose the same number (this session: two `131-*.sql`, and a live
-- 134 collision between snapshot-index and the allocator itself) — and on the
-- native :5432 box only one of the colliding files applies, so a table goes
-- silently dark. This ledger lets `db:next-migration` hand out a guaranteed-
-- unique number under a pg advisory lock: next = GREATEST(max-on-disk,
-- max-reserved) + 1, recorded here atomically. Filesystem-max is folded in by
-- the tool, so even an unreserved on-disk file (a peer that wrote NNN-*.sql
-- without reserving) is still respected.
CREATE TABLE IF NOT EXISTS harness_shared.migration_reservations (
  num          integer PRIMARY KEY,
  filename     text,
  reserved_by  text,
  intent       text,
  reserved_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE harness_shared.migration_reservations IS
  'db:next-migration allocator ledger — one row per reserved migration number. num is the PK so a duplicate reservation cannot be inserted.';
