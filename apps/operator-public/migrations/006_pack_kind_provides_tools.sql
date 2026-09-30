-- Cupboard migration 006 — listing_kind 'pack' + provides_tools tool metadata.
--
-- Plan: tool-distribution-granularity-2026-06-05 (P-005, D-001/D-004/D-006).
--
-- WHAT CHANGES
-- ------------
-- The pack model lands at the storefront: a **pack** is the unified
-- distribution unit (n≥1 tools) — a *single tool* is the degenerate n=1 pack,
-- a *plugin* is a pack WITH a runtime (D-001). Two schema changes:
--
--   listing_kind     — gains 'pack' (a runtime-less code-tool pack; action:
--                      install, same as plugin). The CHECK constraint is baked
--                      into the 004 table definition and SQLite/D1 can't ALTER
--                      a CHECK, so this is the standard 12-step table rebuild
--                      (004 precedent).
--   provides_tools   — NEW nullable TEXT: a JSON array of the MCP tool names
--                      the unit registers when installed (e.g.
--                      ["repomix.pack"]). Meaningful for kinds plugin|pack
--                      only (POST-validated); NULL elsewhere and for listings
--                      published before this migration. The operator's
--                      tool→provider resolver (pack-catalog.ts /
--                      pack-model.ts) reads it to answer "which Cupboard unit
--                      provides tool X?" → an `installable` resolution.
--
-- Uniqueness/dedup for kind='pack' comes free: packs are non-harness, so the
-- (repo, kind, listing_ref) unique index from 004 already covers them.
--
-- Existing rows are preserved verbatim (provides_tools = NULL). reports
-- references harnesses(id) by VALUE and ids are unchanged, so the FK stays
-- valid across the rebuild (foreign_keys guarded OFF during the swap).
--
-- ⚠ This is a ONE-SHOT rebuild (not idempotent). Apply once:
--     wrangler d1 execute papercusp-cupboard --remote \
--       --file migrations/006_pack_kind_provides_tools.sql

PRAGMA foreign_keys=OFF;

CREATE TABLE harnesses_new (
  id TEXT PRIMARY KEY NOT NULL,                      -- uuid v4 (unchanged)

  listing_kind TEXT NOT NULL DEFAULT 'harness'
    CHECK (listing_kind IN ('harness', 'blueprint', 'snapshot', 'plugin', 'pack')),
  project_ref TEXT,                                  -- papercupai project remote id; NULL = legacy/standalone
  listing_ref TEXT,                                  -- within-project discriminator; NULL for the canonical harness listing

  github_repository_id INTEGER NOT NULL,             -- project-remote repo id (1:N since 004)
  github_owner TEXT NOT NULL,
  github_name TEXT NOT NULL,
  github_url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  topic_hex TEXT,                                    -- required only for kind='harness'
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

  -- migration 005 (snapshot tarball blob pointer)
  tarball_r2_key TEXT,
  tarball_content_hash TEXT,
  tarball_bytes INTEGER,

  -- NEW (this migration): JSON string[] of provided MCP tool names; plugin|pack only.
  provides_tools TEXT
);

-- Preserve every existing row verbatim; provides_tools starts NULL.
INSERT INTO harnesses_new (
  id, listing_kind, project_ref, listing_ref,
  github_repository_id, github_owner, github_name, github_url,
  title, description, topic_hex,
  publisher_github_user_id, publisher_github_login, publisher_permission,
  publisher_device_pubkey, publisher_attestation_gist_id,
  claim_status, claimant_github_user_id, claimant_github_login, superseded_by,
  stars, contributor_count, last_activity_at, languages, stats_refreshed_at,
  created_at, updated_at, unlisted_at, unlisted_reason,
  tarball_r2_key, tarball_content_hash, tarball_bytes,
  provides_tools
)
SELECT
  id, listing_kind, project_ref, listing_ref,
  github_repository_id, github_owner, github_name, github_url,
  title, description, topic_hex,
  publisher_github_user_id, publisher_github_login, publisher_permission,
  publisher_device_pubkey, publisher_attestation_gist_id,
  claim_status, claimant_github_user_id, claimant_github_login, superseded_by,
  stars, contributor_count, last_activity_at, languages, stats_refreshed_at,
  created_at, updated_at, unlisted_at, unlisted_reason,
  tarball_r2_key, tarball_content_hash, tarball_bytes,
  NULL
FROM harnesses;

DROP TABLE harnesses;
ALTER TABLE harnesses_new RENAME TO harnesses;

-- Recreate every index (001 + 004 + 005).
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

PRAGMA foreign_keys=ON;
