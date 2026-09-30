-- Cupboard migration 010 — listing_kind 'tool-pack' → 'pack' (canonical) +
-- close the 'template' CHECK gap. (cupboard-public-release-2026-07-12 P-003.)
--
-- WHY
-- ---
-- 1. KIND RENAME (P-003): migration 008 renamed the runtime-less code-tool pack
--    'pack' → 'tool-pack' so "pack" wouldn't clash with the newly-arriving
--    learning-pack. For the public release, packs become the UMBRELLA concept
--    (a pack bundles n≥1 tools and — packs-v2, plan Phase 2 — event deps), and
--    the plugin MANIFEST already uses kind:'pack', so the listing kind is
--    renamed BACK to the canonical 'pack'. 'tool-pack' becomes the interim wire
--    alias; the route layer's normalizeListingKind maps BOTH 'tool-pack' and the
--    pre-008 'pack' → 'pack'. Existing rows are rewritten in the rebuild SELECT.
--
-- 2. TEMPLATE CHECK GAP (found during P-003): the listing_kind CHECK has been
--    stuck at migration 008's set — ('harness','blueprint','plugin','tool-pack',
--    'learning-pack') — because 009 only ADDed a nullable column (no CHECK
--    change). The 'template' kind (app-templates-2026-07-04; standard-path
--    publish wired in cupboard-full-dogfood-2026-07-10 P-003) is served by the
--    worker and used by the UI, but a POST /listings template publish would hit
--    a SQLITE_CONSTRAINT against this stale CHECK. This rebuild's CHECK includes
--    'template', so the standard template publish path (plan P-010) works.
--
-- WHAT CHANGES
-- ------------
-- A 12-step CHECK-constraint rebuild (004/006/008 precedent). The new CHECK is
--   ('harness','blueprint','plugin','pack','learning-pack','template').
-- Every column is preserved, including blueprint_kind (added additively by
-- migration 009). Row values: listing_kind 'tool-pack' → 'pack'; everything else
-- copied verbatim.
--
-- ⚠ PROD-VERIFY BEFORE APPLYING (release plan P-013). The 'template' CHECK gap
--   proves the deployed schema is NOT guaranteed to match this repo's migration
--   history 1:1 (template rows may have been seeded out-of-band). Before the
--   --remote apply:
--     1. Back up:  wrangler d1 export papercusp-cupboard --remote --output backup-pre-010.sql
--     2. Diff the live columns against this rebuild's column list:
--          wrangler d1 execute papercusp-cupboard --remote \
--            --command "SELECT sql FROM sqlite_master WHERE name='harnesses';"
--        If the live table has a column this rebuild omits (or vice-versa), the
--        explicit-column INSERT below will fail — reconcile the column list FIRST.
--
-- ⚠ ONE-SHOT rebuild (not idempotent). Apply once:
--     wrangler d1 execute papercusp-cupboard --remote \
--       --file migrations/010_pack_kind_rename.sql

PRAGMA foreign_keys=OFF;

-- Defensive: a previously-failed partial application may have left the staging
-- table behind.
DROP TABLE IF EXISTS harnesses_new;

CREATE TABLE harnesses_new (
  id TEXT PRIMARY KEY NOT NULL,                      -- uuid v4 (unchanged)

  listing_kind TEXT NOT NULL DEFAULT 'harness'
    CHECK (listing_kind IN ('harness', 'blueprint', 'plugin', 'pack', 'learning-pack', 'template')),
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
  review_reason TEXT
);

-- Preserve every row; the kind rename happens here (tool-pack → pack).
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
  review_status, reviewed_at, review_reason
)
SELECT
  id,
  CASE listing_kind WHEN 'tool-pack' THEN 'pack' ELSE listing_kind END,
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
  review_status, reviewed_at, review_reason
FROM harnesses;

DROP TABLE harnesses;
ALTER TABLE harnesses_new RENAME TO harnesses;

-- Recreate every index (001 + 004 + 005 + 007 + 008).
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
