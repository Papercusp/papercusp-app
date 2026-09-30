-- Cupboard migration 004 — three listing kinds + project-centric 1:N keying.
--
-- Plan: harness-blueprint-distribution-2026-06-03 (E4 / P-007, D-005, D-008).
--
-- WHAT CHANGES
-- ------------
-- The Cupboard stops being a harness-only registry and becomes ONE storefront
-- with three listing kinds (D-005):
--
--   harness   → join     (shared-harness via the Hypercore `topic_hex`)
--   blueprint → fork     (a blueprint stream within a project)
--   snapshot  → fork     (a captured snapshot)
--   plugin    → install  (a distributable plugin)
--
-- and it re-keys listings PROJECT-CENTRICALLY (D-008, reconciled onto RFC
-- project-centric-harness-rethink-2026-06-04 D-001): the shareable unit is a
-- blueprint stream within a project, and a PROJECT HOSTS N LISTINGS. So the
-- old "exactly one listing per stable GitHub repo id" (1:1) invariant —
-- enforced by `github_repository_id INTEGER NOT NULL UNIQUE` in 001 — is wrong
-- for the new model and must be dropped. GitHub-repo-backed identity stays for
-- v1 (D-008): `github_repository_id` now denotes the PROJECT REMOTE's repo id,
-- which N listings can share.
--
-- NEW COLUMNS
--   listing_kind  — harness | blueprint | snapshot | plugin (default 'harness';
--                   every pre-004 row IS a shared-harness listing).
--   project_ref   — stable identifier of the papercupai project remote a listing
--                   belongs to (D-008). NULL = legacy / standalone-repo harness.
--   listing_ref   — discriminates the N listings within a project (blueprint
--                   stream name / snapshot id / plugin slug). NULL for the
--                   canonical single shared-harness listing.
--
-- topic_hex becomes NULLABLE: only kind='harness' carries a Hypercore join
-- topic. Non-harness kinds locate their fork/install source from
-- github_url + project_ref + listing_ref (GitHub-repo-backed, v1).
--
-- SQLite/D1 can't ALTER away the column-level UNIQUE constraint, so this is the
-- standard 12-step table rebuild. Existing rows are preserved verbatim and
-- defaulted to listing_kind='harness'. reports.harness_id references
-- harnesses(id) by VALUE and ids are unchanged, so the FK stays valid across
-- the rebuild (foreign_keys guarded OFF during the swap).
--
-- ⚠ This is a ONE-SHOT rebuild (not idempotent). Apply once:
--     wrangler d1 execute papercusp-cupboard --remote \
--       --file migrations/004_listing_kinds_project_centric.sql

PRAGMA foreign_keys=OFF;

CREATE TABLE harnesses_new (
  id TEXT PRIMARY KEY NOT NULL,                      -- uuid v4 (unchanged)

  -- New: kind + project-centric 1:N keying.
  listing_kind TEXT NOT NULL DEFAULT 'harness'
    CHECK (listing_kind IN ('harness', 'blueprint', 'snapshot', 'plugin')),
  project_ref TEXT,                                  -- papercupai project remote id; NULL = legacy/standalone
  listing_ref TEXT,                                  -- within-project discriminator; NULL for the canonical harness listing

  github_repository_id INTEGER NOT NULL,             -- project-remote repo id; NO LONGER unique on its own (1:N)
  github_owner TEXT NOT NULL,
  github_name TEXT NOT NULL,
  github_url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  topic_hex TEXT,                                    -- NULLABLE now; required only for kind='harness'
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
  unlisted_reason TEXT
);

-- Preserve every existing row; they are all shared-harness listings.
INSERT INTO harnesses_new (
  id, listing_kind, project_ref, listing_ref,
  github_repository_id, github_owner, github_name, github_url,
  title, description, topic_hex,
  publisher_github_user_id, publisher_github_login, publisher_permission,
  publisher_device_pubkey, publisher_attestation_gist_id,
  claim_status, claimant_github_user_id, claimant_github_login, superseded_by,
  stars, contributor_count, last_activity_at, languages, stats_refreshed_at,
  created_at, updated_at, unlisted_at, unlisted_reason
)
SELECT
  id, 'harness', NULL, NULL,
  github_repository_id, github_owner, github_name, github_url,
  title, description, topic_hex,
  publisher_github_user_id, publisher_github_login, publisher_permission,
  publisher_device_pubkey, publisher_attestation_gist_id,
  claim_status, claimant_github_user_id, claimant_github_login, superseded_by,
  stars, contributor_count, last_activity_at, languages, stats_refreshed_at,
  created_at, updated_at, unlisted_at, unlisted_reason
FROM harnesses;

DROP TABLE harnesses;
ALTER TABLE harnesses_new RENAME TO harnesses;

-- Recreate the 001 listing indexes.
CREATE INDEX IF NOT EXISTS harnesses_listed_idx
  ON harnesses (unlisted_at, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS harnesses_publisher_idx
  ON harnesses (publisher_github_user_id);

-- Kind-scoped browse index (the generalized /listings?kind= path).
CREATE INDEX IF NOT EXISTS harnesses_kind_idx
  ON harnesses (listing_kind, unlisted_at, last_activity_at DESC);

-- Project rollup (all listings for one project remote).
CREATE INDEX IF NOT EXISTS harnesses_project_idx
  ON harnesses (project_ref) WHERE project_ref IS NOT NULL;

-- Uniqueness, kind-aware:
--  (a) Preserve the 1:1 "one active shared-harness per repo" invariant that
--      GET /binding/:repoId + publish dedup rely on — but ONLY for harness kind.
CREATE UNIQUE INDEX IF NOT EXISTS harnesses_active_harness_repo_unique
  ON harnesses (github_repository_id)
  WHERE listing_kind = 'harness' AND unlisted_at IS NULL;

--  (b) N distinct non-harness listings per project: unique by (repo, kind, ref).
--      A project can host many blueprints/snapshots/plugins, each a distinct
--      listing_ref. (NULLs compare distinct in SQLite, so a kind without a ref
--      is not forced unique — the route layer requires listing_ref for these.)
CREATE UNIQUE INDEX IF NOT EXISTS harnesses_active_listing_unique
  ON harnesses (github_repository_id, listing_kind, listing_ref)
  WHERE listing_kind != 'harness' AND unlisted_at IS NULL;

PRAGMA foreign_keys=ON;
