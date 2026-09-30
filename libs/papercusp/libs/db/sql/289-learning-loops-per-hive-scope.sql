-- 289-learning-loops-per-hive-scope.sql
--
-- per-hive-learning-loops-2026-06-14 (Phase 1: P-010 / P-011 / P-012).
--
-- The learning loop's tenancy unit is the HIVE (the project/federation unit,
-- kind:'hive'), not the harness (D-008). These three loop-tracking tables were
-- workspace-scoped only, so multiple hives in one workspace would share — and
-- corrupt — each other's scout signal. Add the hive dimension.
--
-- Idempotent (IF NOT EXISTS / guarded DO blocks); additive; fresh-migrate-safe.

-- ── P-010: scout_ticks — add hive_slug (the hive home slug) ───────────────────
-- A scout tick already records install_slug (the routine's slug); under the
-- per-hive model that IS the hive home slug, so backfill from it. Nullable: a
-- tick is an append-only log row, no PK coupling.
ALTER TABLE harness_shared.scout_ticks ADD COLUMN IF NOT EXISTS hive_slug text;
UPDATE harness_shared.scout_ticks
   SET hive_slug = install_slug
 WHERE hive_slug IS NULL AND install_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS scout_ticks_ws_hive_tick_at_idx
    ON harness_shared.scout_ticks (workspace_id, hive_slug, tick_at DESC);

-- ── P-011: scout_lens_weights — repoint PK to (workspace_id, hive_slug, lens) ──
-- scout_lens_weights is a CACHE of a derivation (208 header: "safe to truncate")
-- — recomputed/upserted each cycle from scout_routed_ideas outcomes. So no data
-- migration / per-hive fan-out is needed: add the column, truncate the cache,
-- and repoint the PK. It repopulates per-hive on the next scout cycle.
-- RLS policy + grants stay on the SAME table (no DROP/rebuild) — they are
-- untouched. Guarded so a re-run is a no-op once the PK already carries hive_slug.
ALTER TABLE harness_shared.scout_lens_weights ADD COLUMN IF NOT EXISTS hive_slug text;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
     WHERE i.indrelid = 'harness_shared.scout_lens_weights'::regclass
       AND i.indisprimary
       AND a.attname = 'hive_slug'
  ) THEN
    TRUNCATE harness_shared.scout_lens_weights;  -- derivation cache; repopulates per-hive
    ALTER TABLE harness_shared.scout_lens_weights DROP CONSTRAINT IF EXISTS scout_lens_weights_pkey;
    ALTER TABLE harness_shared.scout_lens_weights ALTER COLUMN hive_slug SET NOT NULL;
    ALTER TABLE harness_shared.scout_lens_weights
      ADD CONSTRAINT scout_lens_weights_pkey PRIMARY KEY (workspace_id, hive_slug, lens);
  END IF;
END $$;

-- ── P-012: improvement_dispatches — add hive_slug ─────────────────────────────
-- The improvement an item belongs to is harness-scoped, but engineer_issues has
-- NO harness_slug column (197: the slug is stamped into the federation outbox
-- jsonb, not a column), so there is no reliable historical backfill. Nullable;
-- new dispatches stamp hive_slug going forward (the per-hive improvement lens,
-- Phase 4, filters on it). Historical rows keep NULL.
ALTER TABLE harness_shared.improvement_dispatches ADD COLUMN IF NOT EXISTS hive_slug text;
CREATE INDEX IF NOT EXISTS improvement_dispatches_ws_hive_fired_at_idx
    ON harness_shared.improvement_dispatches (workspace_id, hive_slug, fired_at DESC);
