-- Cupboard migration 011 — listing_kind 'learning-pack' → 'knowledge-pack'.
-- (cupboard-public-release-2026-07-12 P-001 / knowledge-packs-2026-07-11 D-001.)
--
-- WHY
-- ---
-- The owner renamed "learning packs" → "knowledge packs" for the public release.
-- D-001 makes that a HARD rename internally (alpha: no aliases), with old wire
-- values still PARSING only at true system boundaries. The Cupboard listing kind
-- is exactly such a boundary: already-published rows carry 'learning-pack', and a
-- client built against the old API still sends it. So:
--   - stored rows are rewritten to 'knowledge-pack' here (one-shot, below), and
--   - the route layer's normalizeListingKind() keeps ACCEPTING 'learning-pack' on
--     the wire and normalizes it forward — nothing downstream sees the old value.
--
-- FORWARD-NORMALIZING, NOT 010-DEPENDENT (deliberate)
-- ---------------------------------------------------
-- This rebuild's SELECT normalizes BOTH legacy kinds in one pass:
--     'tool-pack'     → 'pack'            (migration 010 / P-003)
--     'learning-pack' → 'knowledge-pack'  (this migration / P-001)
-- so it is correct whether or not 010 has actually been applied to the target DB.
-- That is not belt-and-braces: migration 010's own header records that the
-- deployed schema is NOT guaranteed to match this repo's migration history 1:1
-- (the 'template' CHECK gap proved it), and release-plan P-013 still has to
-- reconcile prod before applying either file. If 011 assumed 010's row values, a
-- prod DB still holding 'tool-pack' rows would fail this rebuild's CHECK on
-- INSERT — a self-inflicted outage on a release migration. Normalizing forward
-- costs one CASE arm and removes the ordering hazard entirely.
--
-- WHAT CHANGES
-- ------------
-- A CHECK-constraint rebuild (004/006/008/010 precedent). The new CHECK is
--   ('harness','blueprint','plugin','pack','knowledge-pack','template').
-- Every column is preserved verbatim; only listing_kind VALUES are rewritten.
--
-- ⚠ PROD-VERIFY BEFORE APPLYING (release plan P-013):
--     1. Back up:  wrangler d1 export papercusp-cupboard --remote --output backup-pre-011.sql
--     2. Diff the live columns against this rebuild's column list:
--          wrangler d1 execute papercusp-cupboard --remote \
--            --command "SELECT sql FROM sqlite_master WHERE name='harnesses';"
--        If the live table has a column this rebuild omits (or vice-versa), the
--        explicit-column INSERT below will fail — reconcile the column list FIRST.
--
-- ⚠ ONE-SHOT rebuild (not idempotent). Apply once:
--     wrangler d1 execute papercusp-cupboard --remote \
--       --file migrations/011_knowledge_pack_kind_rename.sql

PRAGMA foreign_keys=OFF;

-- Defensive: a previously-failed partial application may have left the staging
-- table behind.
DROP TABLE IF EXISTS harnesses_new;

CREATE TABLE harnesses_new (
  id TEXT PRIMARY KEY NOT NULL,                      -- uuid v4 (unchanged)

  listing_kind TEXT NOT NULL DEFAULT 'harness'
    CHECK (listing_kind IN ('harness', 'blueprint', 'plugin', 'pack', 'knowledge-pack', 'template')),
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

-- Preserve every row; both legacy kind renames happen here (see header).
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
  CASE listing_kind
    WHEN 'learning-pack' THEN 'knowledge-pack'  -- this migration (P-001)
    WHEN 'tool-pack'     THEN 'pack'            -- migration 010 (P-003), re-applied idempotently
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
