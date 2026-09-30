-- Cupboard migration 008 — listing_kind 'learning-pack' + the pack→tool-pack
-- rename + pre-publication review (learning-packs-2026-06-11 P-014/P-019, D-005/D-007).
--
-- WHAT CHANGES
-- ------------
-- 1. KIND RENAME (D-005): 'pack' (the runtime-less code-tool pack) becomes
--    'tool-pack' — with learning packs arriving, "pack" must not mean two
--    things. Existing rows are rewritten in the rebuild's SELECT; the route
--    layer keeps accepting 'pack' on the wire as a normalized alias.
-- 2. NEW KIND 'learning-pack' (action: install) — a distributable set of
--    curated learnings seeded into a hive's shared memory.
-- 3. PRE-PUBLICATION REVIEW (D-007): three new columns —
--      review_status  TEXT 'pending'|'approved'|'rejected', NOT NULL,
--                     DEFAULT 'approved' (every pre-008 row + every
--                     non-policy-kind publish is live immediately, unchanged)
--      reviewed_at    INTEGER epoch-ms of the operator decision
--      review_reason  TEXT operator note (surfaced to the submitter)
--    The route layer sets 'pending' at publish for the POLICY KINDS
--    ('learning-pack' + 'blueprint' — both carry injected agent instructions);
--    public list/read exclude anything not 'approved'; only the operator
--    allowlist (/admin) approves/rejects.
--
-- CHECK constraints are baked into the table (004/006 precedent), so this is
-- the standard 12-step rebuild. reports references harnesses(id) by VALUE and
-- ids are unchanged (foreign_keys guarded OFF during the swap).
--
-- ⚠ ONE-SHOT rebuild (not idempotent). Apply once:
--     wrangler d1 execute papercusp-cupboard --remote \
--       --file migrations/008_learning_pack_kind_review_status.sql

PRAGMA foreign_keys=OFF;

-- Legacy 'snapshot' rows: the kind was RETIRED (retire-snapshots-instance-spec
-- 2026-06-09 D-005) — no current worker code can serve it and no client can
-- act on it, so carrying it forward in the new CHECK would preserve a zombie.
-- Removed here (the pre-008 `wrangler d1 export` backup preserves the bytes);
-- their reports rows (if any) go with them to keep the FK valid.
DELETE FROM reports WHERE harness_id IN (SELECT id FROM harnesses WHERE listing_kind = 'snapshot');
DELETE FROM harnesses WHERE listing_kind = 'snapshot';

-- Defensive: a previously-failed partial application may have left the
-- staging table behind.
DROP TABLE IF EXISTS harnesses_new;

CREATE TABLE harnesses_new (
  id TEXT PRIMARY KEY NOT NULL,                      -- uuid v4 (unchanged)

  listing_kind TEXT NOT NULL DEFAULT 'harness'
    CHECK (listing_kind IN ('harness', 'blueprint', 'plugin', 'tool-pack', 'learning-pack')),
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

  -- NEW (this migration): pre-publication review (D-007).
  review_status TEXT NOT NULL DEFAULT 'approved'
    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_at INTEGER,
  review_reason TEXT
);

-- Preserve every row; the kind rename happens here (pack → tool-pack); every
-- pre-008 row is review_status 'approved' (it was already publicly visible).
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
  provides_tools,
  hive_pubkey, hive_title,
  review_status, reviewed_at, review_reason
)
SELECT
  id,
  CASE listing_kind WHEN 'pack' THEN 'tool-pack' ELSE listing_kind END,
  project_ref, listing_ref,
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
  'approved', NULL, NULL
FROM harnesses;

DROP TABLE harnesses;
ALTER TABLE harnesses_new RENAME TO harnesses;

-- Recreate every index (001 + 004 + 005 + 007).
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

-- NEW: the operator's pending-review queue.
CREATE INDEX IF NOT EXISTS harnesses_review_pending_idx
  ON harnesses (created_at DESC) WHERE review_status = 'pending';

PRAGMA foreign_keys=ON;
