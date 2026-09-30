-- 725-payload-object-shape-guard-and-plan-item-stamp-index.sql
--
-- WI-6993 (EI-19342686955096692): the plan_item STAMP lookup is the single
-- largest LIVE consumer of database time in the system.
--
--   queryid -8876052228175373488, measured 2026-08-02 13:01-13:03Z by RATE
--   (two pg_stat_statements reads 73.9s apart, joined on queryid):
--     142.1 calls/min x 133.9ms mean, returning ONE row per call
--     = ~19s of DB time per minute = ~32% of a core, continuously
--     = ~7.6 HOURS of database time PER DAY, to fetch a single row.
--
--   134ms for one row is the tell: a full sequential scan, no usable index.
--
-- WHY NO INDEX COULD BE USED. Every reader of the `plan_item` stamp wraps the
-- column in a defensive shape-normalizer:
--
--   (CASE WHEN jsonb_typeof(payload) = 'string'
--         THEN (payload #>> '{}')::jsonb ELSE payload END)->'plan_item'->>'plan_slug'
--
-- That wrap exists because of the postgres-js `::jsonb` binding quirk
-- (agent-insights/postgres-js-jsonb-binding): a JS object bound under a
-- `::jsonb` cast could land as a jsonb STRING SCALAR holding the JSON text
-- instead of a real object, so `payload->'plan_item'` read as null. An index on
-- `payload->'plan_item'->>'plan_slug'` can never match the CASE-wrapped
-- expression, so the wrap silently forced a full scan on every lookup.
--
-- THE WRAP IS NOW DEFENDING AGAINST AN IMPOSSIBLE SHAPE. The write path was
-- fixed twice over, and the data proves it:
--
--   1. restoreRawJsonbSerializer (libs/papercusp/libs/db/src/raw-serializers.ts,
--      EI-18698602043482898) installs a STICKY hybrid serializer on OIDs
--      114/3802 that is correct for BOTH call shapes — `sql.json(v)` with a
--      real JS value AND `${JSON.stringify(v)}::jsonb` with a pre-stringified
--      one. It survives drizzle's runtime re-assignment, so the double-encode
--      cannot come back through a drizzle-wrapped client either.
--   2. Migration 641 normalizes NEW.payload inside engineer_issues_view_dml()
--      before the `|| jsonb_build_object('_ei', ...)` merge.
--
--   Measured 2026-08-02 13:00Z, jsonb_typeof(payload) across every row:
--     harness_shared.work_items                    30,660 / 30,660  object
--     harness_shared.harness_features_consolidated  1,321 /  1,321  object
--   ZERO string scalars, with the newest row written in the same second.
--
-- This migration converts that empirical fact into a STRUCTURAL invariant, so
-- the read-side wraps can be deleted for good rather than being re-added by the
-- next reader who rediscovers the quirk. Three separate sites had independently
-- grown a copy of the same mitigation (plan-item-coverage.ts,
-- plan-items/reconcile-linked-work-items.ts — whose comment asks the reader to
-- "keep both in sync" — and plan-items/convert.ts), plus a fourth shape in
-- slot-parked-store's parseEnvelope(). Manual synchronisation between copies of
-- a workaround is the tell that the underlying defect was never closed out.
--
-- Note the wrap was already provably UNREACHABLE on the engineer_issues path:
-- that view projects `payload - '_ei'`, and jsonb `-` raises 22023
-- "cannot delete from scalar" on a scalar — so a string-scalar payload would
-- have thrown in the view before the CASE could ever evaluate.
--
-- PART 1 - the structural guard. Added NOT VALID then VALIDATEd so the
-- full-table check runs under SHARE UPDATE EXCLUSIVE rather than holding
-- ACCESS EXCLUSIVE for the scan. Idempotent via a pg_constraint guard.
-- A non-object payload now fails LOUDLY at write time instead of silently
-- destroying every named key on the row (the WI-5493 `||` array-corruption
-- bug, where `"str" || {...}` yields `["str", {...}]`).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'work_items_payload_is_object_ck'
       AND conrelid = 'harness_shared.work_items'::regclass
  ) THEN
    ALTER TABLE harness_shared.work_items
      ADD CONSTRAINT work_items_payload_is_object_ck
      CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object') NOT VALID;
  END IF;
END $$;

ALTER TABLE harness_shared.work_items VALIDATE CONSTRAINT work_items_payload_is_object_ck;

-- WI-7049 (found verifying WI-6052, 2026-08-02): `harness_features_consolidated`
-- has been a VIEW over `work_items` since migration 374-work-items-unify-base-
-- table.sql (2026-06-22) — you cannot ALTER TABLE / ADD CONSTRAINT a view
-- (Postgres 42809 "X is not a table"). This is the same defect class EI-3032
-- hit for the baseline snapshot; here it was never applied ANYWHERE (the
-- statement fails identically every time, so schema_migrations never recorded
-- it), sitting as dead code waiting to break the next full db:migrate replay.
-- It is also redundant, not just illegal: the current view definition
-- (migration 677) projects `payload` straight through with no transform for
-- this projection, so hfc's payload IS work_items.payload for every row it
-- includes — the CHECK constraint above, on the real base table, already
-- guarantees hfc's payload shape. No second constraint needed.

-- PART 2 - the indexes the wrap was defeating.
--
-- Both readers match on the (plan_slug, item_id) pair, so a composite
-- expression index turns the scan into a point lookup. PARTIAL on
-- `payload->'plan_item' IS NOT NULL`: only 2,821 of 31,493 work_items rows and
-- 1,224 of 2,135 harness_features_consolidated rows carry a stamp (measured
-- 2026-08-02), so the partial index stays small and the planner can still use
-- it — every caller already filters on the stamp being present.
--
-- Non-concurrent CREATE INDEX is correct inside a migration: the runner wraps
-- each file in a single transaction (CONCURRENTLY is illegal there), migrations
-- apply at boot/provision before load, and IF NOT EXISTS makes it a no-op where
-- the index was already built live with CONCURRENTLY. Same rationale as
-- migration 315.

CREATE INDEX IF NOT EXISTS work_items_plan_item_stamp_idx
  ON harness_shared.work_items (
    (payload -> 'plan_item' ->> 'plan_slug'),
    (payload -> 'plan_item' ->> 'item_id')
  )
  WHERE payload -> 'plan_item' IS NOT NULL;

-- WI-7049: no separate `hfc_plan_item_stamp_idx` — `harness_features_consolidated`
-- is a simple (non-aggregating) view directly over `work_items` (migration 374 /
-- 677), so a `payload->'plan_item'->>...` predicate against the view is inlined
-- by the planner and uses the index above on the base table. `CREATE INDEX ...
-- ON` a view is illegal on Postgres in any case (see PART 1's comment).
