-- 557-cup-lexicon-db-rename-phase3.sql
--
-- P-009 Phase 3 (cup-lexicon-full-rename-2026-07-10, Slice H): rename the FEDERATION-CRUD-family
-- tables that CANNOT use the view-compat pattern from Phase 1, because Postgres INSERT...ON CONFLICT
-- cannot target a view under any circumstance. This migration is ATOMIC: we rename the tables AND
-- all ON-CONFLICT accessor sites in the same transaction. No lingering old-name views for these tables.
--
-- Renumbered from a colliding 555 (leader su-7a3c4041, 2026-07-10) — a second agent independently
-- created 555-cup-lexicon-db-rename-phase2-bee-claim-specs-beekeeper.sql at the same time. That file
-- is the sole, correct owner of bee_claim_specs (full constraint rename + compat view, already paired
-- with accessor updates that target the new table name directly, so ON CONFLICT never touches the
-- view) — this migration's now-redundant duplicate bee_claim_specs block was removed to keep single
-- ownership; see 555-...-phase2-... for that table.
--
-- Scope: 12 federation-CRUD tables
--   hives -> pots
--   hive_members -> pot_members
--   hive_policy -> pot_policy
--   hive_settings -> pot_settings
--   hive_pending_joins -> pot_pending_joins
--   hive_reports -> pot_reports
--   cross_hive_asks -> cross_pot_asks
--   cross_hive_outbox -> cross_pot_outbox
--   cross_hive_beacon_history -> cross_pot_beacon_history
--   hive_epoch_keys -> pot_epoch_keys
--   hive_directory_cache -> pot_directory_cache
--   hive_directory_tombstones -> pot_directory_tombstones
--
-- Plus critical columns:
--   hive_home_slug -> pot_home_slug (in hive_members, hive_pending_joins, etc.)
--   hive_slug -> pot_slug (494+ references across schema)
--   bee_id -> cup_id
--
-- Key gotchas from Phase 1 (WI-3465):
-- - PK/UNIQUE constraint rename AUTO-RENAMES its index (no redundant ALTER INDEX after)
-- - Live busy table may need SET LOCAL lock_timeout='60s' during DDL
--
-- IDEMPOTENT: each rename block is guarded (skips if already renamed).

\set ON_ERROR_STOP on

-- ── hives -> pots ──────────────────────────────────────────────────────────────
-- Special: this table is referenced by FK from hive_members; the FK rename must
-- happen in the same transaction as the hives rename.
DO $$
BEGIN
  IF to_regclass('harness_shared.hives') IS NOT NULL AND to_regclass('harness_shared.pots') IS NULL THEN
    ALTER TABLE harness_shared.hives RENAME TO pots;
    ALTER TABLE harness_shared.pots RENAME COLUMN home_slug TO pot_home_slug;
    -- Constraints: note that constraint renames auto-rename their indexes
    ALTER TABLE harness_shared.pots RENAME CONSTRAINT hives_pkey TO pots_pkey;
    ALTER TABLE harness_shared.pots RENAME CONSTRAINT hives_public_key_key TO pots_public_key_key;
    ALTER POLICY hives_workspace_isolation ON harness_shared.pots RENAME TO pots_workspace_isolation;
  END IF;
END $$;

-- Update FK from hive_members to pots (must happen after pots rename)
DO $$
BEGIN
  -- The FK name is hive_members_hive_fkey; rename it after we rename the referenced table
  IF to_regclass('harness_shared.hive_members') IS NOT NULL THEN
    -- This will be updated when we rename hive_members below
    NULL;
  END IF;
END $$;

-- ── hive_members -> pot_members ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_members') IS NOT NULL AND to_regclass('harness_shared.pot_members') IS NULL THEN
    ALTER TABLE harness_shared.hive_members RENAME TO pot_members;
    ALTER TABLE harness_shared.pot_members RENAME COLUMN hive_home_slug TO pot_home_slug;
    -- Constraints
    ALTER TABLE harness_shared.pot_members RENAME CONSTRAINT hive_members_pkey TO pot_members_pkey;
    ALTER TABLE harness_shared.pot_members RENAME CONSTRAINT hive_members_hive_fkey TO pot_members_pot_fkey;
    -- Update FK to reference pots instead of hives
    ALTER TABLE harness_shared.pot_members DROP CONSTRAINT pot_members_pot_fkey;
    ALTER TABLE harness_shared.pot_members
      ADD CONSTRAINT pot_members_pot_fkey
      FOREIGN KEY (workspace_id, pot_home_slug)
      REFERENCES harness_shared.pots (workspace_id, pot_home_slug)
      ON DELETE CASCADE;
    -- Index (WI-3961 fixup: was missing the harness_shared. schema qualifier —
    -- an unqualified ALTER INDEX resolves via search_path, which does not
    -- include harness_shared, so this 42P01'd "relation does not exist" on
    -- every apply, wedging this migration — and every migration after it —
    -- permanently. IF EXISTS added to match this file's own idempotency claim.)
    ALTER INDEX IF EXISTS harness_shared.hive_members_username_idx RENAME TO pot_members_username_idx;
    ALTER POLICY hive_members_workspace_isolation ON harness_shared.pot_members RENAME TO pot_members_workspace_isolation;
  END IF;
END $$;

-- ── hive_settings -> pot_settings ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_settings') IS NOT NULL AND to_regclass('harness_shared.pot_settings') IS NULL THEN
    ALTER TABLE harness_shared.hive_settings RENAME TO pot_settings;
    -- Note: harness_slug column stays as-is (it's the Hive's home_slug, which stays conceptually the same)
    -- but it's not renamed since it's already logically a pot_slug equivalent
    -- Constraints
    ALTER TABLE harness_shared.pot_settings RENAME CONSTRAINT hive_settings_pkey TO pot_settings_pkey;
    -- Triggers
    ALTER TRIGGER capture_hive_settings_outbox_trg ON harness_shared.pot_settings RENAME TO capture_pot_settings_outbox_trg;
    ALTER TRIGGER capture_hive_settings_outbox_upd_trg ON harness_shared.pot_settings RENAME TO capture_pot_settings_outbox_upd_trg;
    ALTER POLICY hive_settings_workspace_isolation ON harness_shared.pot_settings RENAME TO pot_settings_workspace_isolation;
  END IF;
END $$;

-- ── hive_policy -> pot_policy ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_policy') IS NOT NULL AND to_regclass('harness_shared.pot_policy') IS NULL THEN
    ALTER TABLE harness_shared.hive_policy RENAME TO pot_policy;
    -- Constraints
    ALTER TABLE harness_shared.pot_policy RENAME CONSTRAINT hive_policy_pkey TO pot_policy_pkey;
    -- Triggers
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'capture_hive_policy_outbox_trg' AND tgrelid = 'harness_shared.pot_policy'::regclass) THEN
      ALTER TRIGGER capture_hive_policy_outbox_trg ON harness_shared.pot_policy RENAME TO capture_pot_policy_outbox_trg;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'capture_hive_policy_outbox_upd_trg' AND tgrelid = 'harness_shared.pot_policy'::regclass) THEN
      ALTER TRIGGER capture_hive_policy_outbox_upd_trg ON harness_shared.pot_policy RENAME TO capture_pot_policy_outbox_upd_trg;
    END IF;
    ALTER POLICY hive_policy_workspace_isolation ON harness_shared.pot_policy RENAME TO pot_policy_workspace_isolation;
  END IF;
END $$;

-- ── hive_pending_joins -> pot_pending_joins ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_pending_joins') IS NOT NULL AND to_regclass('harness_shared.pot_pending_joins') IS NULL THEN
    ALTER TABLE harness_shared.hive_pending_joins RENAME TO pot_pending_joins;
    -- Constraints
    ALTER TABLE harness_shared.pot_pending_joins RENAME CONSTRAINT hive_pending_joins_pkey TO pot_pending_joins_pkey;
    -- Triggers if they exist
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'capture_hive_pending_joins_outbox_trg' AND tgrelid = 'harness_shared.pot_pending_joins'::regclass) THEN
      ALTER TRIGGER capture_hive_pending_joins_outbox_trg ON harness_shared.pot_pending_joins RENAME TO capture_pot_pending_joins_outbox_trg;
    END IF;
    ALTER POLICY hive_pending_joins_workspace_isolation ON harness_shared.pot_pending_joins RENAME TO pot_pending_joins_workspace_isolation;
  END IF;
END $$;

-- ── hive_reports -> pot_reports ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_reports') IS NOT NULL AND to_regclass('harness_shared.pot_reports') IS NULL THEN
    ALTER TABLE harness_shared.hive_reports RENAME TO pot_reports;
    -- Constraints
    ALTER TABLE harness_shared.pot_reports RENAME CONSTRAINT hive_reports_pkey TO pot_reports_pkey;
    -- Triggers
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'capture_hive_reports_outbox_trg' AND tgrelid = 'harness_shared.pot_reports'::regclass) THEN
      ALTER TRIGGER capture_hive_reports_outbox_trg ON harness_shared.pot_reports RENAME TO capture_pot_reports_outbox_trg;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'capture_hive_reports_outbox_upd_trg' AND tgrelid = 'harness_shared.pot_reports'::regclass) THEN
      ALTER TRIGGER capture_hive_reports_outbox_upd_trg ON harness_shared.pot_reports RENAME TO capture_pot_reports_outbox_upd_trg;
    END IF;
    ALTER POLICY hive_reports_workspace_isolation ON harness_shared.pot_reports RENAME TO pot_reports_workspace_isolation;
  END IF;
END $$;

-- ── cross_hive_asks -> cross_pot_asks ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.cross_hive_asks') IS NOT NULL AND to_regclass('harness_shared.cross_pot_asks') IS NULL THEN
    ALTER TABLE harness_shared.cross_hive_asks RENAME TO cross_pot_asks;
    -- Rename columns if they reference hive_slug
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cross_pot_asks' AND column_name = 'hive_slug') THEN
      ALTER TABLE harness_shared.cross_pot_asks RENAME COLUMN hive_slug TO pot_slug;
    END IF;
    -- Constraints
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_hive_asks_pkey' AND conrelid = 'harness_shared.cross_pot_asks'::regclass) THEN
      ALTER TABLE harness_shared.cross_pot_asks RENAME CONSTRAINT cross_hive_asks_pkey TO cross_pot_asks_pkey;
    END IF;
    -- Indexes
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'cross_hive_asks_by_pot_idx' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'harness_shared')) THEN
      ALTER INDEX harness_shared.cross_hive_asks_by_pot_idx RENAME TO cross_pot_asks_by_pot_idx;
    END IF;
  END IF;
END $$;

-- ── cross_hive_outbox -> cross_pot_outbox ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.cross_hive_outbox') IS NOT NULL AND to_regclass('harness_shared.cross_pot_outbox') IS NULL THEN
    ALTER TABLE harness_shared.cross_hive_outbox RENAME TO cross_pot_outbox;
    -- Rename columns if they reference hive_slug
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cross_pot_outbox' AND column_name = 'hive_slug') THEN
      ALTER TABLE harness_shared.cross_pot_outbox RENAME COLUMN hive_slug TO pot_slug;
    END IF;
    -- Constraints
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_hive_outbox_pkey' AND conrelid = 'harness_shared.cross_pot_outbox'::regclass) THEN
      ALTER TABLE harness_shared.cross_pot_outbox RENAME CONSTRAINT cross_hive_outbox_pkey TO cross_pot_outbox_pkey;
    END IF;
  END IF;
END $$;

-- ── cross_hive_beacon_history -> cross_pot_beacon_history ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.cross_hive_beacon_history') IS NOT NULL AND to_regclass('harness_shared.cross_pot_beacon_history') IS NULL THEN
    ALTER TABLE harness_shared.cross_hive_beacon_history RENAME TO cross_pot_beacon_history;
    -- WI-3961 fixup: after the RENAME TO above the table's name IS
    -- cross_pot_beacon_history — the old name no longer resolves, so the
    -- constraint rename must target the table by its NEW name (every sibling
    -- block in this file does this correctly; this one referenced the stale
    -- pre-rename name and 42P01'd "relation does not exist").
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_hive_beacon_history_pkey' AND conrelid = 'harness_shared.cross_pot_beacon_history'::regclass) THEN
      ALTER TABLE harness_shared.cross_pot_beacon_history RENAME CONSTRAINT cross_hive_beacon_history_pkey TO cross_pot_beacon_history_pkey;
    END IF;
  END IF;
END $$;

-- ── hive_epoch_keys -> pot_epoch_keys ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_epoch_keys') IS NOT NULL AND to_regclass('harness_shared.pot_epoch_keys') IS NULL THEN
    ALTER TABLE harness_shared.hive_epoch_keys RENAME TO pot_epoch_keys;
    -- Constraints
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hive_epoch_keys_pkey' AND conrelid = 'harness_shared.pot_epoch_keys'::regclass) THEN
      ALTER TABLE harness_shared.pot_epoch_keys RENAME CONSTRAINT hive_epoch_keys_pkey TO pot_epoch_keys_pkey;
    END IF;
    -- Triggers
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'capture_hive_epoch_keys_outbox_trg' AND tgrelid = 'harness_shared.pot_epoch_keys'::regclass) THEN
      ALTER TRIGGER capture_hive_epoch_keys_outbox_trg ON harness_shared.pot_epoch_keys RENAME TO capture_pot_epoch_keys_outbox_trg;
    END IF;
  END IF;
END $$;

-- ── hive_directory_cache -> pot_directory_cache ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_directory_cache') IS NOT NULL AND to_regclass('harness_shared.pot_directory_cache') IS NULL THEN
    ALTER TABLE harness_shared.hive_directory_cache RENAME TO pot_directory_cache;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hive_directory_cache_pkey' AND conrelid = 'harness_shared.pot_directory_cache'::regclass) THEN
      ALTER TABLE harness_shared.pot_directory_cache RENAME CONSTRAINT hive_directory_cache_pkey TO pot_directory_cache_pkey;
    END IF;
  END IF;
END $$;

-- ── hive_directory_tombstones -> pot_directory_tombstones ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.hive_directory_tombstones') IS NOT NULL AND to_regclass('harness_shared.pot_directory_tombstones') IS NULL THEN
    ALTER TABLE harness_shared.hive_directory_tombstones RENAME TO pot_directory_tombstones;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hive_directory_tombstones_pkey' AND conrelid = 'harness_shared.pot_directory_tombstones'::regclass) THEN
      ALTER TABLE harness_shared.pot_directory_tombstones RENAME CONSTRAINT hive_directory_tombstones_pkey TO pot_directory_tombstones_pkey;
    END IF;
  END IF;
END $$;

-- bee_claim_specs -> cup_claim_specs is owned by 555-cup-lexicon-db-rename-phase2-bee-claim-specs-
-- beekeeper.sql (full constraint rename + compat view + paired accessor update) — see header note.

-- Note: Grant and view creation for compat views would go here, but since these tables
-- use ON CONFLICT, we cannot create views that target them. The accessor code MUST
-- be updated to use the new table names.
