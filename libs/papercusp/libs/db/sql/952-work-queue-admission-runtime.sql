-- 952-work-queue-admission-runtime.sql
-- Plan: work-queue-admission-and-bulk-dedup-2026-08-24 (P-001/P-003/P-005).
--
-- Migration 944 created the admission/dedup substrate.  This follow-up makes
-- the shard map match the ratified runtime contract: one item has exactly one
-- member/home shard, while the same item may appear as read-only ghost context
-- in several other shards.  It also preserves the first-claim timestamp needed
-- for the promoted-to-first-claim distribution metric (D-003); taken_at is not
-- sufficient because release clears the current claim.
--
-- FORWARD-COMPAT: the currently deployed release has no dedup_shard_map writer
-- or ON CONFLICT consumer at all (P-001 is its first runtime writer), and the
-- live admission_runs ledger is empty.  Changing the unused migration-944 key
-- therefore cannot strand an old writer between migration apply and code deploy.
-- lint-migrations: allow-index-swap dedup_shard_map is an unused pre-runtime table; P-001 introduces the first writer only after this migration is applied

DO $$
DECLARE
  current_pk text;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO current_pk
    FROM pg_constraint
   WHERE conrelid = 'harness_shared.dedup_shard_map'::regclass
     AND conname = 'dedup_shard_map_pkey';

  IF current_pk IS NOT NULL
     AND current_pk <> 'PRIMARY KEY (run_id, shard_id, item_id, role)' THEN
    ALTER TABLE harness_shared.dedup_shard_map
      DROP CONSTRAINT dedup_shard_map_pkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'harness_shared.dedup_shard_map'::regclass
       AND conname = 'dedup_shard_map_pkey'
  ) THEN
    ALTER TABLE harness_shared.dedup_shard_map
      ADD CONSTRAINT dedup_shard_map_pkey
      PRIMARY KEY (run_id, shard_id, item_id, role);
  END IF;
END $$;

-- The wider primary key permits one ghost in N shards.  This partial unique
-- index keeps the stronger home-shard invariant in the database: exactly-one is
-- asserted by the census writer before commit; at-most-one is enforced here.
CREATE UNIQUE INDEX IF NOT EXISTS dedup_shard_map_one_member_uq
  ON harness_shared.dedup_shard_map (run_id, item_id)
  WHERE role = 'member';

CREATE INDEX IF NOT EXISTS dedup_shard_map_run_shard_idx
  ON harness_shared.dedup_shard_map
    (workspace_id, harness_slug, run_id, shard_id, role);

COMMENT ON TABLE harness_shared.dedup_shard_map IS
  'Shard assignment per census run. Exactly one member/home row per corpus item; the same item may be a read-only ghost in multiple other shards. The writer asserts member coverage equals the corpus exactly before any model call (work-queue-admission-and-bulk-dedup D-006).';

ALTER TABLE harness_shared.work_items
  ADD COLUMN IF NOT EXISTS first_claimed_at timestamptz;

COMMENT ON COLUMN harness_shared.work_items.first_claimed_at IS
  'Immutable first successful claim timestamp. Unlike taken_at it survives release/reclaim; paired with admitted_at for the promoted-to-first-claim distribution required by work-queue-admission-and-bulk-dedup D-003.';

CREATE INDEX IF NOT EXISTS wi_admission_first_claim_latency_idx
  ON harness_shared.work_items
    (workspace_id, harness_slug, admitted_at, first_claimed_at)
  WHERE admitted_at IS NOT NULL;
