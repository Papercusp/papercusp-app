-- Cupboard migration 014 — the 'app' listing kind + its distribution columns.
-- (cupboard-app-distribution-2026-07-14 P-001 / D-001 [owner 2026-07-14].)
--
-- WHY
-- ---
-- Oddsmith is a whole application built ON the papercusp platform, not a plugin
-- that runs inside it — and the owner wants users to distribute apps like it
-- through the Cupboard (a new "Apps" tab). An app is its own storefront kind: a
-- STANDALONE app is a separate downloadable product (its own Tauri installer),
-- and "install" = DOWNLOAD the platform installer from the app's own GitHub
-- release (the Cupboard hands off a link and never re-hosts the binary); a BUNDLE
-- app is a papercusp-native composition that installs into the workspace (Phase 2,
-- not yet wired). The `delivery_type` column discriminates the two.
--
-- The type-system side landed in P-002 (packages/operator-core/lib/cupboard/
-- types.ts: 'app' as the 7th LISTING_KINDS member + the columns below on
-- HarnessListing + listingActionFor('app') → 'download'|'install'). This migration
-- is the D1 storage side so a published app row can be stored and served.
--
-- WHAT CHANGES
-- ------------
-- 1. listing_kind CHECK gains 'app':
--      ('harness','blueprint','plugin','pack','knowledge-pack','template','app')
-- 2. Five NEW nullable columns, meaningful for `listing_kind = 'app'` rows only
--    (NULL on every other kind and every pre-014 row):
--      delivery_type    — 'standalone' | 'bundle' (CHECK-constrained; NULL ⇒
--                         treated as 'standalone', the safe download-handoff
--                         default). Drives listingActionFor → 'download'|'install'.
--      latest_json_url  — STANDALONE: URL of the app's signed `latest.json`
--                         updater manifest (@papercusp/tauri-release-kit
--                         buildLatestManifest output) the download flow reads to
--                         resolve the platform-specific installer URL.
--      release_repo     — STANDALONE: `<owner>/<repo>` whose GitHub Releases host
--                         the installers, when distinct from the source repo.
--      icon_url         — app icon for the storefront card/detail (an app is a
--                         whole product, so it gets a real icon, not a kind glyph).
--      platforms        — denormalized JSON string[] of OS keys present in
--                         latest.json (e.g. ["darwin-aarch64","linux-x86_64",
--                         "windows-x86_64"]) so the card shows availability
--                         without fetching the manifest.
--
-- WHY A TABLE REBUILD (like 004/006/008/010/011, unlike 012/013)
-- --------------------------------------------------------------
-- This migration CHANGES the listing_kind CHECK constraint, and SQLite/D1 cannot
-- ALTER a CHECK — the 12-step table rebuild is the only way to widen it. Because
-- we are rebuilding anyway, the five new columns are declared in the rebuilt
-- table (including delivery_type's own CHECK) rather than tacked on with separate
-- ALTERs afterward. 012/013 added a plain nullable column with no constraint
-- change, so they correctly used the cheap ALTER form; that option is not
-- available here.
--
-- FORWARD-NORMALIZING (deliberate, same as 011)
-- ---------------------------------------------
-- The rebuild's SELECT normalizes the two legacy kind values in one pass
-- ('tool-pack' → 'pack', 'learning-pack' → 'knowledge-pack') so this file is
-- correct whether or not 010/011 have actually been applied to the target DB.
-- The deployed prod schema is NOT guaranteed to match this repo's migration
-- history 1:1 (011's header documents the 'template' CHECK gap that proved it),
-- so a prod row still holding a legacy value would otherwise fail the new CHECK
-- on INSERT — a self-inflicted outage. Normalizing forward costs two CASE arms
-- and removes the ordering hazard entirely.
--
-- ⚠ PROD-VERIFY BEFORE APPLYING (owner-authorized apply only):
--     1. Back up:  wrangler d1 export papercusp-cupboard --remote --output backup-pre-014.sql
--     2. Diff the live columns against this rebuild's column list:
--          wrangler d1 execute papercusp-cupboard --remote \
--            --command "SELECT sql FROM sqlite_master WHERE name='harnesses';"
--        If the live table has a column this rebuild omits (or vice-versa), the
--        explicit-column INSERT below fails — reconcile the column list FIRST.
--        In particular this rebuild ASSUMES provides_events (012) + requires_events
--        (013) are present (they were added by ALTER after 011's rebuild). If the
--        target DB has not applied 012/013, drop those two columns from BOTH the
--        CREATE and the INSERT before running.
--
-- ⚠ ONE-SHOT rebuild (not idempotent). Apply once:
--     wrangler d1 execute papercusp-cupboard --remote \
--       --file migrations/014_app_kind.sql

PRAGMA foreign_keys=OFF;

-- Defensive: a previously-failed partial application may have left the staging
-- table behind.
DROP TABLE IF EXISTS harnesses_new;

CREATE TABLE harnesses_new (
  id TEXT PRIMARY KEY NOT NULL,                      -- uuid v4 (unchanged)

  listing_kind TEXT NOT NULL DEFAULT 'harness'
    CHECK (listing_kind IN ('harness', 'blueprint', 'plugin', 'pack', 'knowledge-pack', 'template', 'app')),
  blueprint_kind TEXT,                                -- migration 009 (nullable)
  project_ref TEXT,
  listing_ref TEXT,

  github_repository_id INTEGER NOT NULL,
  github_owner TEXT NOT NULL,
  github_name TEXT NOT NULL,
  github_url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  topic_hex TEXT,
  publisher_github_user_id INTEGER NOT NULL,
  publisher_github_login TEXT NOT NULL,
  publisher_permission TEXT,                          -- migration 002
  publisher_device_pubkey TEXT,                       -- migration 003
  publisher_attestation_gist_id TEXT,                 -- migration 003
  claim_status TEXT NOT NULL DEFAULT 'unclaimed',
  claimant_github_user_id INTEGER,
  claimant_github_login TEXT,
  superseded_by TEXT,
  stars INTEGER NOT NULL DEFAULT 0,
  contributor_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER,
  languages TEXT,
  stats_refreshed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  unlisted_at INTEGER,
  unlisted_reason TEXT,

  -- migration 005 (vestigial tarball pointers; snapshot kind retired)
  tarball_r2_key TEXT,
  tarball_content_hash TEXT,
  tarball_bytes INTEGER,

  -- migration 006
  provides_tools TEXT,

  -- migration 007
  hive_pubkey TEXT,
  hive_title TEXT,

  -- migration 008 (pre-publication review)
  review_status TEXT NOT NULL DEFAULT 'approved'
    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_at INTEGER,
  review_reason TEXT,

  -- migration 012 / 013 (event dependency axis; added by ALTER after 011)
  provides_events TEXT,
  requires_events TEXT,

  -- migration 014 (app distribution — cupboard-app-distribution-2026-07-14).
  -- All app-only; NULL on every other kind and every pre-014 row.
  delivery_type TEXT
    CHECK (delivery_type IS NULL OR delivery_type IN ('standalone', 'bundle')),
  latest_json_url TEXT,
  release_repo TEXT,
  icon_url TEXT,
  platforms TEXT
);

-- Preserve every existing row; the five app columns default to NULL (not in the
-- SELECT). Both legacy kind renames are normalized forward (see header).
INSERT INTO harnesses_new (
  id, listing_kind, blueprint_kind, project_ref, listing_ref,
  github_repository_id, github_owner, github_name, github_url,
  title, description, topic_hex,
  publisher_github_user_id, publisher_github_login, publisher_permission,
  publisher_device_pubkey, publisher_attestation_gist_id,
  claim_status, claimant_github_user_id, claimant_github_login, superseded_by,
  stars, contributor_count, last_activity_at, languages, stats_refreshed_at,
  created_at, updated_at, unlisted_at, unlisted_reason,
  tarball_r2_key, tarball_content_hash, tarball_bytes,
  provides_tools,
  hive_pubkey, hive_title,
  review_status, reviewed_at, review_reason,
  provides_events, requires_events
)
SELECT
  id,
  CASE listing_kind
    WHEN 'tool-pack'     THEN 'pack'            -- migration 010 (P-003)
    WHEN 'learning-pack' THEN 'knowledge-pack'  -- migration 011 (P-001)
    ELSE listing_kind
  END,
  blueprint_kind, project_ref, listing_ref,
  github_repository_id, github_owner, github_name, github_url,
  title, description, topic_hex,
  publisher_github_user_id, publisher_github_login, publisher_permission,
  publisher_device_pubkey, publisher_attestation_gist_id,
  claim_status, claimant_github_user_id, claimant_github_login, superseded_by,
  stars, contributor_count, last_activity_at, languages, stats_refreshed_at,
  created_at, updated_at, unlisted_at, unlisted_reason,
  tarball_r2_key, tarball_content_hash, tarball_bytes,
  provides_tools,
  hive_pubkey, hive_title,
  review_status, reviewed_at, review_reason,
  provides_events, requires_events
FROM harnesses;

DROP TABLE harnesses;
ALTER TABLE harnesses_new RENAME TO harnesses;

-- Recreate every index (001 + 004 + 005 + 007 + 008). The active-listing unique
-- index already covers non-harness kinds, so an 'app' row is keyed by
-- (github_repository_id, listing_kind, listing_ref) with no new index needed.
CREATE INDEX IF NOT EXISTS harnesses_listed_idx
  ON harnesses (unlisted_at, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS harnesses_publisher_idx
  ON harnesses (publisher_github_user_id);
CREATE INDEX IF NOT EXISTS harnesses_kind_idx
  ON harnesses (listing_kind, unlisted_at, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS harnesses_project_idx
  ON harnesses (project_ref) WHERE project_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS harnesses_active_harness_repo_unique
  ON harnesses (github_repository_id)
  WHERE listing_kind = 'harness' AND unlisted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS harnesses_active_listing_unique
  ON harnesses (github_repository_id, listing_kind, listing_ref)
  WHERE listing_kind != 'harness' AND unlisted_at IS NULL;
CREATE INDEX IF NOT EXISTS harnesses_tarball_key_idx
  ON harnesses (tarball_r2_key) WHERE tarball_r2_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS harnesses_hive_pubkey_idx
  ON harnesses (hive_pubkey) WHERE hive_pubkey IS NOT NULL;
CREATE INDEX IF NOT EXISTS harnesses_review_pending_idx
  ON harnesses (created_at DESC) WHERE review_status = 'pending';

PRAGMA foreign_keys=ON;
