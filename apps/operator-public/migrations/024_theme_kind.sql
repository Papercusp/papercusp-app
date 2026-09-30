-- Cupboard migration 024 — add the inert `theme` listing kind.
-- Plan: cupboard-themes-2026-09-05 P-002.
--
-- SQLite cannot alter a CHECK constraint in place, so this is a one-shot table
-- rebuild. It carries every column through migration 018 and recreates every
-- index from migrations 001..018.
--
-- ⚠ DO NOT COPY THIS FILE'S COLUMN LIST INTO A NEW REBUILD. It is a snapshot of
-- the table AS OF 024 and is already out of date: migration 028 ALTER-added
-- pinned_commit_sha / pinned_tree_digest / pinned_at to `harnesses`, so a
-- rebuild copied from here silently DROPS them (measured 2026-09-16 by
-- execution: 67 columns -> 64). This line previously read "Later migrations add
-- other tables only" — true when written, false from 028 onward, and load-bearing
-- in the wrong direction: it told a reader the column set was still post-018,
-- which is exactly the premise a destructive rebuild needs them to believe.
-- Derive the column list from the LIVE chain instead (see migration 029), and
-- let migration-column-preservation.test.ts prove you did.

PRAGMA foreign_keys=OFF;
DROP TABLE IF EXISTS harnesses_new;

CREATE TABLE harnesses_new (
  id TEXT PRIMARY KEY NOT NULL,
  listing_kind TEXT NOT NULL DEFAULT 'harness'
    CHECK (listing_kind IN ('harness', 'blueprint', 'plugin', 'pack', 'knowledge-pack', 'template', 'app', 'rubric', 'plan', 'recipe', 'goal', 'theme')),
  blueprint_kind TEXT,
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
  publisher_permission TEXT,
  publisher_device_pubkey TEXT,
  publisher_attestation_gist_id TEXT,
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
  tarball_r2_key TEXT,
  tarball_content_hash TEXT,
  tarball_bytes INTEGER,
  provides_tools TEXT,
  hive_pubkey TEXT,
  hive_title TEXT,
  review_status TEXT NOT NULL DEFAULT 'approved'
    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_at INTEGER,
  review_reason TEXT,
  provides_events TEXT,
  requires_events TEXT,
  delivery_type TEXT
    CHECK (delivery_type IS NULL OR delivery_type IN ('standalone', 'bundle')),
  latest_json_url TEXT,
  release_repo TEXT,
  icon_url TEXT,
  platforms TEXT,
  requires_rubrics TEXT,
  visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'unlisted', 'private')),
  tenant_id TEXT,
  sku_ref TEXT,
  pricing_model TEXT
    CHECK (pricing_model IS NULL OR pricing_model IN ('free', 'one-time', 'subscription', 'per-use')),
  price_amount_micros INTEGER,
  price_currency TEXT,
  compatibility_json TEXT,
  required_permissions TEXT,
  release_version TEXT,
  release_content_hash TEXT,
  release_manifest_digest TEXT,
  release_signature TEXT,
  release_published_at INTEGER,
  yanked_at INTEGER,
  yanked_reason TEXT,
  revoked_at INTEGER,
  revoked_reason TEXT
);

INSERT INTO harnesses_new (
  id, listing_kind, blueprint_kind, project_ref, listing_ref,
  github_repository_id, github_owner, github_name, github_url,
  title, description, topic_hex,
  publisher_github_user_id, publisher_github_login, publisher_permission,
  publisher_device_pubkey, publisher_attestation_gist_id,
  claim_status, claimant_github_user_id, claimant_github_login, superseded_by,
  stars, contributor_count, last_activity_at, languages, stats_refreshed_at,
  created_at, updated_at, unlisted_at, unlisted_reason,
  tarball_r2_key, tarball_content_hash, tarball_bytes, provides_tools,
  hive_pubkey, hive_title, review_status, reviewed_at, review_reason,
  provides_events, requires_events, delivery_type, latest_json_url, release_repo,
  icon_url, platforms, requires_rubrics, visibility, tenant_id, sku_ref,
  pricing_model, price_amount_micros, price_currency, compatibility_json,
  required_permissions, release_version, release_content_hash,
  release_manifest_digest, release_signature, release_published_at,
  yanked_at, yanked_reason, revoked_at, revoked_reason
)
SELECT
  id,
  CASE listing_kind
    WHEN 'tool-pack' THEN 'pack'
    WHEN 'learning-pack' THEN 'knowledge-pack'
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
  tarball_r2_key, tarball_content_hash, tarball_bytes, provides_tools,
  hive_pubkey, hive_title, review_status, reviewed_at, review_reason,
  provides_events, requires_events, delivery_type, latest_json_url, release_repo,
  icon_url, platforms, requires_rubrics, visibility, tenant_id, sku_ref,
  pricing_model, price_amount_micros, price_currency, compatibility_json,
  required_permissions, release_version, release_content_hash,
  release_manifest_digest, release_signature, release_published_at,
  yanked_at, yanked_reason, revoked_at, revoked_reason
FROM harnesses;

DROP TABLE harnesses;
ALTER TABLE harnesses_new RENAME TO harnesses;

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
CREATE INDEX IF NOT EXISTS harnesses_visibility_idx
  ON harnesses (visibility, unlisted_at, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS harnesses_tenant_idx
  ON harnesses (tenant_id, visibility, last_activity_at DESC)
  WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS harnesses_sku_idx
  ON harnesses (sku_ref) WHERE sku_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS harnesses_release_hash_idx
  ON harnesses (release_content_hash) WHERE release_content_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS harnesses_release_identity_unique
  ON harnesses (github_repository_id, listing_kind, COALESCE(listing_ref, ''), release_version)
  WHERE release_version IS NOT NULL;

PRAGMA foreign_keys=ON;
