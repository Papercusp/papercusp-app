-- Cupboard migration 015 — the 'rubric', 'plan' and 'recipe' listing kinds, plus
-- the `requires_rubrics` dependency column.
-- (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-001 / D-001 [owner 2026-08-21].)
--
-- WHY
-- ---
-- Three of the system's most reusable units had no storefront kind:
--
--   rubric — a graded acceptance/quality rubric. The LOCAL half already exists and
--            was built FOR this: `packages/operator-core/lib/cupboard/rubric-store.ts`
--            (local-first-party-rubric-bundling-2026-07-07) is a layered
--            self-describing store whose writable user layer
--            (`~/.papercusp/rubrics`) is documented verbatim as "v2's Cupboard
--            `kind='rubric'` install target". A rubric is a self-describing dir:
--            rubric.json + listing.json + optional METHOD.md. This migration is the
--            storage side that lets such a listing exist.
--
--   plan   — a PLAN TEMPLATE: goal + item DAG + decisions + schedule, with live
--            state (statuses, assignees, work-item ids, audit citations) stripped at
--            publish. Installing one lands a template row, never a live plan — the
--            template/instance split already used by scheduled recurring plans
--            (papercusp migration 299 `template_slug`).
--
--   recipe — a captured multi-step tool orchestration (papercusp
--            `harness_shared.code_recipes`, migration 349), the most skill-like unit
--            in the system.
--
-- WHAT CHANGES
-- ------------
-- 1. listing_kind CHECK gains three values:
--      ('harness','blueprint','plugin','pack','knowledge-pack','template','app',
--       'rubric','plan','recipe')
-- 2. ONE new nullable column:
--      requires_rubrics — JSON-encoded Array<{ rubricRef, optional? }> naming the
--                         rubrics a listing REQUIRES. Primarily for `plan` rows (a
--                         plan's acceptance rubric class + any rubricRefs it names),
--                         but deliberately kind-agnostic: the column is nullable on
--                         every kind, so a future kind can declare rubric deps
--                         without another rebuild. Mirrors the requires_events
--                         (migration 013) consumer-half shape exactly — a missing
--                         `optional` means REQUIRED, and the client resolves the
--                         requirement BEFORE install (workspace rubric store, incl.
--                         the bundled first-party set, counts as PROVIDED; otherwise
--                         a kind='rubric' co-install is offered; otherwise the
--                         install is refused).
--
-- WHY ONE MIGRATION FOR THREE KINDS (D-001)
-- ------------------------------------------
-- Widening a CHECK constraint requires the 12-step table rebuild (SQLite/D1 cannot
-- ALTER a CHECK) — see migration 014's header. A rebuild is one-shot, non-idempotent
-- and carries a prod column-reconciliation ritual, so doing it three times for one
-- logical change triples the risk for no benefit. And because we rebuild anyway, the
-- new column is declared in the rebuilt table rather than tacked on by a later ALTER
-- (the same reasoning 014 applied to its five app columns).
--
-- The three kinds ship INDEPENDENTLY on the client side regardless: a kind whose
-- publish/install wire is not yet built simply has no rows.
--
-- FORWARD-NORMALIZING (deliberate, same as 011 + 014)
-- ---------------------------------------------------
-- The rebuild's SELECT normalizes the two legacy kind values in one pass
-- ('tool-pack' → 'pack', 'learning-pack' → 'knowledge-pack') so this file is correct
-- whether or not 010/011 have actually been applied to the target DB. The deployed
-- prod schema is NOT guaranteed to match this repo's migration history 1:1, so a
-- prod row still holding a legacy value would otherwise fail the new CHECK on
-- INSERT — a self-inflicted outage.
--
-- ⚠ PROD-VERIFY BEFORE APPLYING (owner-authorized apply only):
--     1. Back up:  wrangler d1 export papercusp-cupboard --remote --output backup-pre-015.sql
--     2. Diff the live columns against this rebuild's column list:
--          wrangler d1 execute papercusp-cupboard --remote \
--            --command "SELECT sql FROM sqlite_master WHERE name='harnesses';"
--        If the live table has a column this rebuild omits (or vice-versa), the
--        explicit-column INSERT below fails — reconcile the column list FIRST.
--        In particular this rebuild ASSUMES migration 014's five app columns
--        (delivery_type, latest_json_url, release_repo, icon_url, platforms) are
--        present. If the target DB has not applied 014, drop those five from BOTH
--        the CREATE and the INSERT before running.
--
-- ⚠ ONE-SHOT rebuild (not idempotent). Apply once:
--     wrangler d1 execute papercusp-cupboard --remote \
--       --file migrations/015_plan_rubric_recipe_kinds.sql

PRAGMA foreign_keys=OFF;

-- Defensive: a previously-failed partial application may have left the staging
-- table behind.
DROP TABLE IF EXISTS harnesses_new;

CREATE TABLE harnesses_new (
  id TEXT PRIMARY KEY NOT NULL,                      -- uuid v4 (unchanged)

  listing_kind TEXT NOT NULL DEFAULT 'harness'
    CHECK (listing_kind IN ('harness', 'blueprint', 'plugin', 'pack', 'knowledge-pack', 'template', 'app', 'rubric', 'plan', 'recipe')),
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
  -- JSON Array<{ rubricRef, optional? }>; NULL on every pre-015 row and on any
  -- listing declaring no rubric dependencies. Kind-agnostic by design (see header).
  requires_rubrics TEXT
);

-- Preserve every existing row; requires_rubrics defaults to NULL (not in the
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
  provides_events, requires_events,
  delivery_type, latest_json_url, release_repo, icon_url, platforms
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
  delivery_type, latest_json_url, release_repo, icon_url, platforms
FROM harnesses;

DROP TABLE harnesses;
ALTER TABLE harnesses_new RENAME TO harnesses;

-- Recreate every index (001 + 004 + 005 + 007 + 008). The active-listing unique
-- index already covers non-harness kinds, so a 'rubric' / 'plan' / 'recipe' row is
-- keyed by (github_repository_id, listing_kind, listing_ref) with no new index
-- needed — listing_ref carries the rubricId / plan slug / recipe id.
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
