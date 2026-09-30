-- Cupboard migration 016 — the 'goal' listing kind.
-- (work-on-everything-goal-2026-08-23 P-006 / D-002 [owner 2026-08-23].)
--
-- WHY
-- ---
-- D-002 makes the Cupboard the ENTRY POINT for goals: "goals as a type on our
-- cupboard", with the work-on-everything standing goal shipping as a goal PACKAGE
-- bundled with the release and installed through the cupboard system. A goal
-- package is a self-describing dir (goal.json + listing.json) carrying: title,
-- duties body/kickoff brief, the `standing` flag, tripwire / budget-window /
-- launch-setting defaults, input/output schemas, and (optionally)
-- `requires_rubrics` — e.g. the work-on-everything package requires
-- `goal-mode-e2e` so steward quality is measurable wherever it is installed.
--
-- Install ≠ start (D-002 rule 1): installing lands an INACTIVE goal stub
-- (status 'paused', no agent spawned, no spend), NO-CLOBBER on the package
-- identity; starting it is a separate deliberate act. That is all operator-side —
-- this migration is only the storefront storage half.
--
-- WHAT CHANGES
-- ------------
-- 1. listing_kind CHECK gains one value:
--      ('harness','blueprint','plugin','pack','knowledge-pack','template','app',
--       'rubric','plan','recipe','goal')
-- 2. NO new columns. `requires_rubrics` (migration 015) is already kind-agnostic;
--    the route-side kind gate is widened from 'plan' to 'plan'|'goal' in code
--    (routes/listings.ts), which migration 015's header anticipated verbatim:
--    "Widening this check is the only change needed to admit another kind."
--
-- Widening a CHECK constraint requires the 12-step table rebuild (SQLite/D1
-- cannot ALTER a CHECK) — same as migrations 014 + 015. The rebuild's SELECT
-- keeps 015's forward-normalization of the two legacy kind values so this file
-- is correct whether or not 010/011 were applied to the target DB.
--
-- ⚠ PROD-VERIFY BEFORE APPLYING (owner-authorized apply only):
--     1. Back up:  wrangler d1 export papercusp-cupboard --remote --output backup-pre-016.sql
--     2. Diff the live columns against this rebuild's column list:
--          wrangler d1 execute papercusp-cupboard --remote \
--            --command "SELECT sql FROM sqlite_master WHERE name='harnesses';"
--        If the live table has a column this rebuild omits (or vice-versa), the
--        explicit-column INSERT below fails — reconcile the column list FIRST.
--        This rebuild ASSUMES migrations 014 (five app columns) AND 015
--        (requires_rubrics) are present on the target.
--
-- ⚠ ONE-SHOT rebuild (not idempotent). Apply once:
--     wrangler d1 execute papercusp-cupboard --remote \
--       --file migrations/016_goal_kind.sql

PRAGMA foreign_keys=OFF;

-- Defensive: a previously-failed partial application may have left the staging
-- table behind.
DROP TABLE IF EXISTS harnesses_new;

CREATE TABLE harnesses_new (
  id TEXT PRIMARY KEY NOT NULL,                      -- uuid v4 (unchanged)

  listing_kind TEXT NOT NULL DEFAULT 'harness'
    CHECK (listing_kind IN ('harness', 'blueprint', 'plugin', 'pack', 'knowledge-pack', 'template', 'app', 'rubric', 'plan', 'recipe', 'goal')),
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
  platforms TEXT,

  -- migration 015 (rubric dependency axis — cupboard-plan-rubric-recipe-sharing).
  -- JSON Array<{ rubricRef, optional? }>; NULL on any listing declaring no rubric
  -- dependencies. Kind-agnostic by design; read for 'plan' AND 'goal' rows.
  requires_rubrics TEXT
);

-- Preserve every existing row. Both legacy kind renames stay normalized forward
-- (same as 015's rebuild — see its header for why).
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
  provides_events, requires_events,
  delivery_type, latest_json_url, release_repo, icon_url, platforms,
  requires_rubrics
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
  provides_events, requires_events,
  delivery_type, latest_json_url, release_repo, icon_url, platforms,
  requires_rubrics
FROM harnesses;

DROP TABLE harnesses;
ALTER TABLE harnesses_new RENAME TO harnesses;

-- Recreate every index (001 + 004 + 005 + 007 + 008). The active-listing unique
-- index already covers non-harness kinds, so a 'goal' row is keyed by
-- (github_repository_id, listing_kind, listing_ref) with no new index needed —
-- listing_ref carries the goal-package ref.
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
