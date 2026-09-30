-- Migration 523 — pot-rename SLICE-2 hive_slug CONTRACT (drop the mirrored column, pot_slug canonical).
--
-- Inverse/contract half of migration 506 (EXPAND). 506 made the 18 substrate tables carry
-- BOTH hive_slug (old) and pot_slug (new) with a bidirectional sync_pot_hive_slug() mirror
-- trigger so old code and new code could run against the same DB during the cutover. This
-- CONTRACT removes hive_slug once every writer speaks pot.
--
-- ✅ DRAIN PRECONDITION SATISFIED (verified 2026-07-06, su-9d427): every live coord_presence
-- writer on the shared harness DB runs pot_slug code. There is NO per-session operator-core
-- store — sessions route through shared hono-host operators, and every bound-port operator
-- (:3070 release cluster @2ae833a3, :3170, :3270 bg-host, :3976, substrate-sidecar) started
-- AFTER the pot_slug pg-store.ts commit a6704ca57 (2026-07-06T03:25Z) and so loaded pot_slug.
-- The only pre-commit operators (dev hosts on :3906/:3929) hold NO connection to the shared
-- org DB (absent from its pg_stat_activity) and do not write these tables. coord_presence
-- was 0-divergent (pot_slug = hive_slug on all rows) at cutover.
--
-- For each of the 18 substrate tables —
--   belt-and-braces same-row backfill (the 506 trigger kept pot_slug mirrored; the one
--   deferred bulk backfill is hive_throughput_ticks, ~260k rows, done here) →
--   SET NOT NULL where hive_slug was NOT NULL → promote the pot_slug companion key to
--   PK/UNIQUE (ADD CONSTRAINT ... USING INDEX — never leaves the table PK-less) →
--   create pot twins of the remaining hive secondary indexes → drop the mirror trigger →
--   DROP COLUMN hive_slug (cascades every remaining hive_slug index/constraint) →
--   finally drop the shared mirror function.
--
-- Hive-ENTITY tables (harness_registry, hives, memory_anchors, …) keep their identity slugs
-- (harness_slug / home_slug — they never had a hive_slug substrate column); NOT touched here (D-007).
--
-- Lock notes: single-txn runner (no CONCURRENTLY). New secondary indexes build under brief
-- SHARE locks on low-traffic tables; the one large build is hive_throughput_ticks (~261k
-- rows, telemetry — writes are periodic ticks, brief block acceptable). SET NOT NULL scans
-- are on the same small/medium tables. DROP COLUMN is catalog-only (ACCESS EXCLUSIVE, instant).
-- Idempotent: every step guarded (IF EXISTS / IF NOT EXISTS / catalog checks via DO blocks
-- for the PK swaps).

-- ── 1) belt-and-braces backfill (trigger has mirrored writes since 506; this catches
--       any row that predates 506 on the one deferred table + races) ──────────────────
UPDATE harness_shared.hive_throughput_ticks SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;  -- ~260k rows (deferred in 506)
UPDATE harness_shared.coord_presence            SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
UPDATE harness_shared.work_item_claims          SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
UPDATE harness_shared.cross_hive_asks           SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
UPDATE harness_shared.cross_hive_outbox         SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
UPDATE harness_shared.scout_lens_weights        SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
UPDATE harness_shared.hive_integration_requests SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
UPDATE harness_shared.scout_ticks               SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
UPDATE harness_shared.improvement_dispatches    SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
UPDATE harness_shared.memory_feedback           SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
UPDATE harness_shared.memory_recall_stats       SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
UPDATE harness_shared.calibration_predictions   SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
UPDATE harness_shared.shared_presence           SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
UPDATE harness_shared.shared_session_presence   SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
UPDATE harness_shared.datatype_registry         SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
UPDATE harness_shared.session_briefs            SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
UPDATE harness_shared.bench_runs                SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
UPDATE harness_shared.code_recipe_runs          SET pot_slug = hive_slug WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;

-- ── 2) NOT NULL where hive_slug was NOT NULL (5 tables; verified 2026-07-05) ──────────
ALTER TABLE harness_shared.cross_hive_asks           ALTER COLUMN pot_slug SET NOT NULL;
ALTER TABLE harness_shared.cross_hive_outbox         ALTER COLUMN pot_slug SET NOT NULL;
ALTER TABLE harness_shared.hive_integration_requests ALTER COLUMN pot_slug SET NOT NULL;
ALTER TABLE harness_shared.hive_throughput_ticks     ALTER COLUMN pot_slug SET NOT NULL;
ALTER TABLE harness_shared.scout_lens_weights        ALTER COLUMN pot_slug SET NOT NULL;

-- ── 3) promote the 506 companion keys to the canonical PK/UNIQUE ──────────────────────
-- ADD CONSTRAINT ... USING INDEX renames the index to the constraint name; the old
-- hive-keyed PK/UNIQUE is dropped in the same statement pair (table never PK-less inside
-- this txn). Guarded via catalog checks so a re-run is a no-op.
DO $pk$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='harness_shared' AND indexname='cross_hive_outbox_pot_pkey_idx') THEN
    ALTER TABLE harness_shared.cross_hive_outbox DROP CONSTRAINT cross_hive_outbox_pkey;
    ALTER TABLE harness_shared.cross_hive_outbox ADD CONSTRAINT cross_hive_outbox_pkey PRIMARY KEY USING INDEX cross_hive_outbox_pot_pkey_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='harness_shared' AND indexname='scout_lens_weights_pot_pkey_idx') THEN
    ALTER TABLE harness_shared.scout_lens_weights DROP CONSTRAINT scout_lens_weights_pkey;
    ALTER TABLE harness_shared.scout_lens_weights ADD CONSTRAINT scout_lens_weights_pkey PRIMARY KEY USING INDEX scout_lens_weights_pot_pkey_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='harness_shared' AND indexname='hive_integration_requests_pot_pkey_idx') THEN
    ALTER TABLE harness_shared.hive_integration_requests DROP CONSTRAINT hive_integration_requests_pkey;
    ALTER TABLE harness_shared.hive_integration_requests ADD CONSTRAINT hive_integration_requests_pkey PRIMARY KEY USING INDEX hive_integration_requests_pot_pkey_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='harness_shared' AND indexname='cross_hive_asks_correlation_pot_uniq')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='cross_hive_asks_correlation_pot_uniq') THEN
    ALTER TABLE harness_shared.cross_hive_asks ADD CONSTRAINT cross_hive_asks_correlation_pot_uniq UNIQUE USING INDEX cross_hive_asks_correlation_pot_uniq;
    ALTER TABLE harness_shared.cross_hive_asks DROP CONSTRAINT IF EXISTS cross_hive_asks_correlation_uniq;
  END IF;
END $pk$;

-- ── 4) pot twins of the hive secondary indexes that had no 506 twin ───────────────────
-- (coord_presence / work_item_claims / shared_session_presence already got theirs in 506;
--  the old hive versions vanish with the column drop below.)
CREATE INDEX IF NOT EXISTS cross_hive_asks_listing_pot_idx           ON harness_shared.cross_hive_asks           (workspace_id, pot_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS cross_hive_outbox_pending_pot_idx         ON harness_shared.cross_hive_outbox         (workspace_id, pot_slug, created_at);
CREATE INDEX IF NOT EXISTS hive_throughput_ticks_ws_pot_tick_idx     ON harness_shared.hive_throughput_ticks     (workspace_id, pot_slug, tick_at DESC);
CREATE INDEX IF NOT EXISTS scout_ticks_ws_pot_tick_at_idx            ON harness_shared.scout_ticks               (workspace_id, pot_slug, tick_at DESC);
CREATE INDEX IF NOT EXISTS improvement_dispatches_ws_pot_fired_at_idx ON harness_shared.improvement_dispatches   (workspace_id, pot_slug, fired_at DESC);
CREATE INDEX IF NOT EXISTS memory_feedback_ws_pot_created_idx        ON harness_shared.memory_feedback           (workspace_id, pot_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_recall_stats_ws_pot_created_idx    ON harness_shared.memory_recall_stats       (workspace_id, pot_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS calibration_predictions_ws_pot_idx        ON harness_shared.calibration_predictions   (workspace_id, pot_slug);
CREATE INDEX IF NOT EXISTS shared_presence_pot_recent_idx            ON harness_shared.shared_presence           (workspace_id, pot_slug, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS datatype_registry_ws_pot_idx              ON harness_shared.datatype_registry         (workspace_id, pot_slug);

-- ── 5) drop the mirror triggers, then the hive_slug columns (cascades old hive indexes/
--       constraints), then the shared mirror function ─────────────────────────────────
DROP TRIGGER IF EXISTS coord_presence_pot_hive_sync_trg            ON harness_shared.coord_presence;
DROP TRIGGER IF EXISTS work_item_claims_pot_hive_sync_trg          ON harness_shared.work_item_claims;
DROP TRIGGER IF EXISTS cross_hive_asks_pot_hive_sync_trg           ON harness_shared.cross_hive_asks;
DROP TRIGGER IF EXISTS cross_hive_outbox_pot_hive_sync_trg         ON harness_shared.cross_hive_outbox;
DROP TRIGGER IF EXISTS scout_lens_weights_pot_hive_sync_trg        ON harness_shared.scout_lens_weights;
DROP TRIGGER IF EXISTS hive_integration_requests_pot_hive_sync_trg ON harness_shared.hive_integration_requests;
DROP TRIGGER IF EXISTS hive_throughput_ticks_pot_hive_sync_trg     ON harness_shared.hive_throughput_ticks;
DROP TRIGGER IF EXISTS scout_ticks_pot_hive_sync_trg               ON harness_shared.scout_ticks;
DROP TRIGGER IF EXISTS improvement_dispatches_pot_hive_sync_trg    ON harness_shared.improvement_dispatches;
DROP TRIGGER IF EXISTS memory_feedback_pot_hive_sync_trg           ON harness_shared.memory_feedback;
DROP TRIGGER IF EXISTS memory_recall_stats_pot_hive_sync_trg       ON harness_shared.memory_recall_stats;
DROP TRIGGER IF EXISTS calibration_predictions_pot_hive_sync_trg   ON harness_shared.calibration_predictions;
DROP TRIGGER IF EXISTS shared_presence_pot_hive_sync_trg           ON harness_shared.shared_presence;
DROP TRIGGER IF EXISTS shared_session_presence_pot_hive_sync_trg   ON harness_shared.shared_session_presence;
DROP TRIGGER IF EXISTS datatype_registry_pot_hive_sync_trg         ON harness_shared.datatype_registry;
DROP TRIGGER IF EXISTS session_briefs_pot_hive_sync_trg            ON harness_shared.session_briefs;
DROP TRIGGER IF EXISTS bench_runs_pot_hive_sync_trg                ON harness_shared.bench_runs;
DROP TRIGGER IF EXISTS code_recipe_runs_pot_hive_sync_trg          ON harness_shared.code_recipe_runs;

ALTER TABLE harness_shared.coord_presence            DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.work_item_claims          DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.cross_hive_asks           DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.cross_hive_outbox         DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.scout_lens_weights        DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.hive_integration_requests DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.hive_throughput_ticks     DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.scout_ticks               DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.improvement_dispatches    DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.memory_feedback           DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.memory_recall_stats       DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.calibration_predictions   DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.shared_presence           DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.shared_session_presence   DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.datatype_registry         DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.session_briefs            DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.bench_runs                DROP COLUMN IF EXISTS hive_slug;
ALTER TABLE harness_shared.code_recipe_runs          DROP COLUMN IF EXISTS hive_slug;

DROP FUNCTION IF EXISTS harness_shared.sync_pot_hive_slug();
