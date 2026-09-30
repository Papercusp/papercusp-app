-- Migration 506 — pot-rename SLICE-2 EXPAND (hive → pot terminology cutover, phase 1).
--
-- This is the EXPAND half of an expand/contract rename. It makes the schema tolerate
-- BOTH the OLD vocabulary (role ids bee|queen, column hive_slug) and the NEW vocabulary
-- (role ids cup|mug, column pot_slug) SIMULTANEOUSLY, so the two-port version skew
-- (:3070 GREEN on main vs :3170/desktop staging) can run old code and new code against
-- the same DB during the cutover. Nothing is dropped here; the CONTRACT migration (later
-- slice) removes hive_slug / the old CHECK values once every writer speaks pot.
--
-- Three moving parts:
--   A) ROLE-VALUE widen — the rank_writer CHECKs on the two work_items base tables and
--      the reorder_work_item() plpgsql guard are widened from IN (bee, queen) to
--      IN (bee, queen, cup, mug) so a NEW writer stamping cup|mug isn't rejected while an
--      OLD writer stamping bee|queen still passes. spawned_agents.child_role/parent_role
--      are FREE-TEXT (no CHECK) — only the partial fleet-running index hardcoded
--      child_role='bee', so it is rebuilt value-AGNOSTIC so the value flip doesn't
--      de-index running fleet members.
--   B) COLUMN widen — every table carrying hive_slug gains a nullable pot_slug, a same-row
--      backfill, and ONE shared BEFORE INSERT OR UPDATE trigger that keeps the two columns
--      mirrored (COALESCE both ways) so OLD code (writes hive_slug) and NEW code (writes
--      pot_slug) both leave a fully-populated row across the skew window.
--   C) COMPANION keys — for the four tables that carry hive_slug INSIDE a PK/UNIQUE, a
--      pot_slug-keyed UNIQUE INDEX is created ALONGSIDE the old key (the table is NEVER
--      left PK-less); the three hot partial (workspace_id, hive_slug) lookup indexes get a
--      pot_slug twin.
--
-- LOCK SAFETY — the db:migrate runner (embedded-postgres-server/src/migration-runner.js)
-- wraps EACH file in a single `BEGIN; SET LOCAL statement_timeout = 0; <ddl>; INSERT
-- schema_migrations; COMMIT;` and its CONTRACT forbids a top-level BEGIN/COMMIT in the file
-- (lint:migrations). So this whole file is ONE transaction and CREATE INDEX CONCURRENTLY is
-- IMPOSSIBLE here (it cannot run in a txn block). Every statement below is therefore chosen
-- to be transaction-safe AND cheap on locks:
--   • ADD COLUMN <nullable, no default>  → metadata-only, instantaneous ACCESS EXCLUSIVE.
--   • CHECK widen                        → DROP + ADD ... NOT VALID (catalog-only, no scan)
--                                          then VALIDATE (SHARE UPDATE EXCLUSIVE — permits
--                                          concurrent DML). The new set is a strict SUPERSET
--                                          of the old, so validation is provably a no-op.
--   • the hot tables (coord_presence, work_item_claims, shared_session_presence) get only
--     small PARTIAL indexes (near-instant build under a brief SHARE lock).
--   • backfills are guarded (hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug)
--     — same-row only, never a cross-row copy.
-- lock acquisition is fail-fast via the runner's lock_timeout (default 15s): a DDL that
-- can't grab its lock aborts and the migration is retried, never queues behind a reader.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + re-ADD, CREATE OR
-- REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE, CREATE [UNIQUE] INDEX IF NOT EXISTS.
-- Runs as harness_admin. Composes onto 178 (rank_writer + reorder) + 475 (spawned_agents
-- fleet index) + 000-baseline (the 18 hive_slug tables).

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────────────────────────────
-- A) ROLE-VALUE widen: rank_writer CHECKs → bee|queen|cup|mug
-- ─────────────────────────────────────────────────────────────────────────────────────
-- DROP the narrow CHECK then ADD the wide one NOT VALID (catalog-only, no table scan),
-- then VALIDATE (DML-friendly lock). Superset widen ⇒ every existing row already complies.
--
-- FIX (su-bf97d, 2026-07-05): the rank_writer CHECK lives on the UNIFIED base table
-- harness_shared.work_items (mig 374 folded harness_features_consolidated + engineer_issues
-- INTO work_items and turned both into VIEWS over it). ALTER TABLE ... CONSTRAINT on a VIEW
-- fails with 42809 "not supported for views" — which broke the ENTIRE chain from a clean
-- baseline (every fresh operator boot + the integration baseline global-setup). The single
-- constraint kept its historical name `hfc_rank_writer_chk` on work_items through the
-- unification; both views read through it, so widening it ONCE covers both. (There is no
-- separate `engineer_issues_rank_writer_chk` — verified on live PG18.)
ALTER TABLE harness_shared.work_items
  DROP CONSTRAINT IF EXISTS hfc_rank_writer_chk;
ALTER TABLE harness_shared.work_items
  ADD CONSTRAINT hfc_rank_writer_chk
  CHECK (rank_writer IS NULL OR rank_writer IN ('bee', 'queen', 'cup', 'mug')) NOT VALID;
ALTER TABLE harness_shared.work_items
  VALIDATE CONSTRAINT hfc_rank_writer_chk;

-- ─────────────────────────────────────────────────────────────────────────────────────
-- A') reorder_work_item() guard widen — bee|queen → bee|queen|cup|mug
-- ─────────────────────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE with the SAME body as migration 178, changing ONLY the p_writer guard
-- (and its error message) so a NEW caller passing cup|mug isn't rejected. Catalog-only,
-- brief lock. (Function bodies use plpgsql BEGIN…END inside $$, which is NOT a top-level
-- transaction and is allowed by the runner contract.)
CREATE OR REPLACE FUNCTION harness_shared.reorder_work_item(
  p_workspace text,
  p_assignee  text,
  p_item_id   text,
  p_target    integer,
  p_writer    text DEFAULT 'bee'
) RETURNS integer
LANGUAGE plpgsql
AS $reorder$
DECLARE
  v_old_rank integer;
  v_count    integer;
  v_new_rank integer;
  v_now      timestamptz := now();
BEGIN
  IF p_writer IS NULL OR p_writer NOT IN ('bee', 'queen', 'cup', 'mug') THEN
    RAISE EXCEPTION 'reorder_work_item: writer must be bee|queen|cup|mug (got %)', p_writer;
  END IF;

  -- The current rank of the moving item (NULL if it was unranked / newly appended).
  SELECT assignee_rank INTO v_old_rank
    FROM harness_shared.work_items
   WHERE workspace_id = p_workspace AND taken_by = p_assignee AND feature_id = p_item_id;

  -- Queue length EXCLUDING the moving item — the target clamps to [0, len].
  SELECT count(*) INTO v_count
    FROM harness_shared.work_items
   WHERE workspace_id = p_workspace AND taken_by = p_assignee
     AND feature_id <> p_item_id;

  v_new_rank := GREATEST(0, LEAST(p_target, v_count));

  -- Pull the moving item out (so the renumber below sees a contiguous peer set), then
  -- compact the survivors into a dense 0..n-1 ordering by their current rank
  -- (NULLs last, then created order), then re-open a gap at v_new_rank and slot it in.
  UPDATE harness_shared.work_items
     SET assignee_rank = NULL, rank_writer = p_writer, rank_updated_at = v_now
   WHERE workspace_id = p_workspace AND taken_by = p_assignee AND feature_id = p_item_id;

  WITH ordered AS (
    SELECT feature_id,
           row_number() OVER (
             ORDER BY assignee_rank ASC NULLS LAST, rank_updated_at ASC NULLS LAST, created_ts ASC
           ) - 1 AS seq
      FROM harness_shared.work_items
     WHERE workspace_id = p_workspace AND taken_by = p_assignee
       AND feature_id <> p_item_id
  ), shifted AS (
    SELECT feature_id,
           CASE WHEN seq < v_new_rank THEN seq ELSE seq + 1 END AS new_rank
      FROM ordered
  )
  UPDATE harness_shared.work_items w
     SET assignee_rank = s.new_rank, rank_updated_at = v_now
    FROM shifted s
   WHERE w.workspace_id = p_workspace AND w.taken_by = p_assignee
     AND w.feature_id = s.feature_id
     AND w.assignee_rank IS DISTINCT FROM s.new_rank;

  -- Slot the moving item into the freed hole.
  UPDATE harness_shared.work_items
     SET assignee_rank = v_new_rank, rank_writer = p_writer, rank_updated_at = v_now
   WHERE workspace_id = p_workspace AND taken_by = p_assignee AND feature_id = p_item_id;

  RETURN v_new_rank;
END;
$reorder$;

GRANT EXECUTE ON FUNCTION harness_shared.reorder_work_item(text, text, text, integer, text) TO harness_app;

-- ─────────────────────────────────────────────────────────────────────────────────────
-- A'') spawned_agents fleet-running index → value-AGNOSTIC on child_role
-- ─────────────────────────────────────────────────────────────────────────────────────
-- Migration 475 built this partial index with predicate `child_role = 'bee'`. child_role is
-- free-text (no CHECK), and SLICE-2 flips the fleet role value (bee → cup), which would
-- silently de-index every running fleet member (countRunningFleetBees goes O(n)). Rebuild
-- WITHOUT the child_role predicate so it counts running fleet members regardless of the
-- role token. The partial predicate (fleet_slug IS NOT NULL AND running/restarting) is very
-- selective, so the build is near-instant under a brief SHARE lock; DROP+CREATE is atomic
-- to peers within this one txn (they never observe the gap).
DROP INDEX IF EXISTS harness_shared.spawned_agents_fleet_slug_running_idx;
CREATE INDEX IF NOT EXISTS spawned_agents_fleet_slug_running_idx
  ON harness_shared.spawned_agents (workspace_id, fleet_slug)
  WHERE fleet_slug IS NOT NULL AND status IN ('running', 'restarting');

-- ─────────────────────────────────────────────────────────────────────────────────────
-- B) the shared pot_slug ⇄ hive_slug mirror trigger function (installed once, used by all)
-- ─────────────────────────────────────────────────────────────────────────────────────
-- BEFORE INSERT OR UPDATE: fill whichever slug the writer left NULL from the other, so an
-- OLD writer (sets hive_slug) and a NEW writer (sets pot_slug) both leave BOTH populated.
-- On INSERT exactly one is typically set → the other is derived. (Caveat: if BOTH are
-- already non-null on an UPDATE and OLD code mutates hive_slug to a NEW value, pot_slug is
-- not force-synced — hive_slug is a stable partition key in every one of these tables, not
-- mutated in place, so this is a non-issue for the skew window; the CONTRACT slice removes
-- hive_slug entirely.)
CREATE OR REPLACE FUNCTION harness_shared.sync_pot_hive_slug()
RETURNS trigger
LANGUAGE plpgsql
AS $sync$
BEGIN
  NEW.pot_slug  := COALESCE(NEW.pot_slug, NEW.hive_slug);
  NEW.hive_slug := COALESCE(NEW.hive_slug, NEW.pot_slug);
  RETURN NEW;
END;
$sync$;

-- ─────────────────────────────────────────────────────────────────────────────────────
-- B') per-table: ADD pot_slug, same-row backfill, attach the mirror trigger
-- ─────────────────────────────────────────────────────────────────────────────────────
-- Order per table: ADD COLUMN (metadata-only) → backfill (guarded, same-row) → attach
-- trigger. Backfill BEFORE the trigger so the one-time bulk UPDATE doesn't pay per-row
-- trigger overhead; from then on the trigger keeps new writes mirrored.

-- coord_presence (HOT — heartbeats from ~46 sessions; column add is metadata-only)
ALTER TABLE harness_shared.coord_presence ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.coord_presence SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS coord_presence_pot_hive_sync_trg ON harness_shared.coord_presence;
CREATE TRIGGER coord_presence_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.coord_presence
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- work_item_claims (HOT)
ALTER TABLE harness_shared.work_item_claims ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.work_item_claims SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS work_item_claims_pot_hive_sync_trg ON harness_shared.work_item_claims;
CREATE TRIGGER work_item_claims_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.work_item_claims
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- cross_hive_asks (hive_slug NOT NULL; carries a UNIQUE on hive_slug — companion below)
ALTER TABLE harness_shared.cross_hive_asks ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.cross_hive_asks SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS cross_hive_asks_pot_hive_sync_trg ON harness_shared.cross_hive_asks;
CREATE TRIGGER cross_hive_asks_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.cross_hive_asks
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- cross_hive_outbox (hive_slug NOT NULL; carries the PK on hive_slug — companion below)
ALTER TABLE harness_shared.cross_hive_outbox ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.cross_hive_outbox SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS cross_hive_outbox_pot_hive_sync_trg ON harness_shared.cross_hive_outbox;
CREATE TRIGGER cross_hive_outbox_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.cross_hive_outbox
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- scout_lens_weights (hive_slug NOT NULL; carries the PK on hive_slug — companion below)
ALTER TABLE harness_shared.scout_lens_weights ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.scout_lens_weights SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS scout_lens_weights_pot_hive_sync_trg ON harness_shared.scout_lens_weights;
CREATE TRIGGER scout_lens_weights_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.scout_lens_weights
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- hive_integration_requests (hive_slug NOT NULL; carries the PK on hive_slug — companion below)
ALTER TABLE harness_shared.hive_integration_requests ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.hive_integration_requests SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS hive_integration_requests_pot_hive_sync_trg ON harness_shared.hive_integration_requests;
CREATE TRIGGER hive_integration_requests_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.hive_integration_requests
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- hive_throughput_ticks (hive_slug NOT NULL; PK is on identity id — no companion key needed)
-- NOTE: this telemetry table is LARGE (~260k rows). Its historical pot_slug backfill is
-- DEFERRED to the P5 batched / out-of-band backfill — pot_slug is not READ until CONTRACT,
-- and the trigger below already mirrors every NEW row, so leaving old rows' pot_slug NULL
-- during the window is safe. Deferring keeps this EXPAND migration fast so its co-transaction
-- never holds a long lock on the hot tables (coord_presence etc.). Only ADD COLUMN + trigger here.
ALTER TABLE harness_shared.hive_throughput_ticks ADD COLUMN IF NOT EXISTS pot_slug text;
DROP TRIGGER IF EXISTS hive_throughput_ticks_pot_hive_sync_trg ON harness_shared.hive_throughput_ticks;
CREATE TRIGGER hive_throughput_ticks_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.hive_throughput_ticks
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- scout_ticks (hive_slug nullable; PK on identity id)
ALTER TABLE harness_shared.scout_ticks ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.scout_ticks SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS scout_ticks_pot_hive_sync_trg ON harness_shared.scout_ticks;
CREATE TRIGGER scout_ticks_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.scout_ticks
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- improvement_dispatches (hive_slug nullable; PK on id)
ALTER TABLE harness_shared.improvement_dispatches ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.improvement_dispatches SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS improvement_dispatches_pot_hive_sync_trg ON harness_shared.improvement_dispatches;
CREATE TRIGGER improvement_dispatches_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.improvement_dispatches
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- memory_feedback (hive_slug nullable; PK on id)
ALTER TABLE harness_shared.memory_feedback ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.memory_feedback SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS memory_feedback_pot_hive_sync_trg ON harness_shared.memory_feedback;
CREATE TRIGGER memory_feedback_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.memory_feedback
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- memory_recall_stats (hive_slug nullable; PK on identity id)
ALTER TABLE harness_shared.memory_recall_stats ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.memory_recall_stats SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS memory_recall_stats_pot_hive_sync_trg ON harness_shared.memory_recall_stats;
CREATE TRIGGER memory_recall_stats_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.memory_recall_stats
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- calibration_predictions (hive_slug nullable; PK on identity id)
ALTER TABLE harness_shared.calibration_predictions ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.calibration_predictions SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS calibration_predictions_pot_hive_sync_trg ON harness_shared.calibration_predictions;
CREATE TRIGGER calibration_predictions_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.calibration_predictions
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- shared_presence (hive_slug nullable; PK on workspace/harness/github/machine)
ALTER TABLE harness_shared.shared_presence ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.shared_presence SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS shared_presence_pot_hive_sync_trg ON harness_shared.shared_presence;
CREATE TRIGGER shared_presence_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.shared_presence
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- shared_session_presence (hive_slug nullable; PK on workspace/owner/machine — hot partial idx below)
ALTER TABLE harness_shared.shared_session_presence ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.shared_session_presence SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS shared_session_presence_pot_hive_sync_trg ON harness_shared.shared_session_presence;
CREATE TRIGGER shared_session_presence_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.shared_session_presence
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- datatype_registry (hive_slug nullable; PK on id/workspace)
ALTER TABLE harness_shared.datatype_registry ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.datatype_registry SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS datatype_registry_pot_hive_sync_trg ON harness_shared.datatype_registry;
CREATE TRIGGER datatype_registry_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.datatype_registry
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- session_briefs (hive_slug nullable; PK on owner_id)
ALTER TABLE harness_shared.session_briefs ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.session_briefs SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS session_briefs_pot_hive_sync_trg ON harness_shared.session_briefs;
CREATE TRIGGER session_briefs_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.session_briefs
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- bench_runs (hive_slug nullable; PK on identity id — telemetry table, backfill guarded)
ALTER TABLE harness_shared.bench_runs ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.bench_runs SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS bench_runs_pot_hive_sync_trg ON harness_shared.bench_runs;
CREATE TRIGGER bench_runs_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.bench_runs
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- code_recipe_runs (hive_slug nullable; PK on identity id — telemetry table, backfill guarded)
ALTER TABLE harness_shared.code_recipe_runs ADD COLUMN IF NOT EXISTS pot_slug text;
UPDATE harness_shared.code_recipe_runs SET pot_slug = hive_slug
  WHERE hive_slug IS NOT NULL AND pot_slug IS DISTINCT FROM hive_slug;
DROP TRIGGER IF EXISTS code_recipe_runs_pot_hive_sync_trg ON harness_shared.code_recipe_runs;
CREATE TRIGGER code_recipe_runs_pot_hive_sync_trg BEFORE INSERT OR UPDATE ON harness_shared.code_recipe_runs
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_pot_hive_slug();

-- ─────────────────────────────────────────────────────────────────────────────────────
-- C) COMPANION pot_slug keys — created ALONGSIDE the old hive_slug key (never PK-less)
-- ─────────────────────────────────────────────────────────────────────────────────────
-- The four tables that carry hive_slug INSIDE their PK/UNIQUE get a pot_slug-keyed UNIQUE
-- INDEX. The old PK/UNIQUE stays as-is (the table keeps a live PK); the CONTRACT slice will
-- swap the PK to pot_slug and drop the hive_slug key. Uniqueness is guaranteed post-backfill:
-- pot_slug = hive_slug for every row, and the old key already enforces (…, hive_slug, …)
-- uniqueness, so the (…, pot_slug, …) twin cannot collide. Non-concurrent (forced), so each
-- build holds a brief SHARE lock — acceptable on these lower-traffic federation tables.
CREATE UNIQUE INDEX IF NOT EXISTS cross_hive_asks_correlation_pot_uniq
  ON harness_shared.cross_hive_asks (workspace_id, pot_slug, correlation_id);
CREATE UNIQUE INDEX IF NOT EXISTS cross_hive_outbox_pot_pkey_idx
  ON harness_shared.cross_hive_outbox (workspace_id, pot_slug, id);
CREATE UNIQUE INDEX IF NOT EXISTS scout_lens_weights_pot_pkey_idx
  ON harness_shared.scout_lens_weights (workspace_id, lens, pot_slug);
CREATE UNIQUE INDEX IF NOT EXISTS hive_integration_requests_pot_pkey_idx
  ON harness_shared.hive_integration_requests (workspace_id, pot_slug, repo_key, device_pubkey, head_sha);

-- pot_slug twins of the three hot (workspace_id, hive_slug) partial lookup indexes.
-- Small PARTIAL indexes ⇒ near-instant build even on coord_presence / work_item_claims.
CREATE INDEX IF NOT EXISTS coord_presence_pot_idx
  ON harness_shared.coord_presence (workspace_id, pot_slug)
  WHERE pot_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_item_claims_pot_idx
  ON harness_shared.work_item_claims (workspace_id, pot_slug)
  WHERE pot_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS shared_session_presence_pot_idx
  ON harness_shared.shared_session_presence (workspace_id, pot_slug, last_seen_at DESC)
  WHERE pot_slug IS NOT NULL;
