-- Cupboard migration 031 — add the `event` listing kind.
-- Plan: identities-v1-2026-08-30 P-029, D-010 / D-011.
--
-- An `event` is an event-key DECLARATION: the versioned key, its payload
-- schema, and the discovery metadata that says who emits it and who may await
-- it. It is the half of the reactive axis that migration 030's `rule` assumed
-- but could not name — a rule's `on` and an agent's `events:await` both take a
-- key, and today that key resolves against a hand-authored first-party catalog
-- (`EVENT_CATALOG`). An event is independently useful with NO rule anywhere:
-- `events:await` is a first-class agent primitive and gate declarations work
-- against a key on their own, which is why this is its own listing kind rather
-- than a field on `rule`.
--
-- WHY IT PUBLISHES `pending` — the deciding argument is ASYMMETRY OF ERROR
-- ----------------------------------------------------------------------
-- An event listing is declarative and fires nothing, which argues for inert
-- treatment like `theme`. That argument loses to the precedent migration 029
-- recorded for `datatype`: folding a previously-MODERATED surface into the
-- Cupboard without adding it to `REVIEW_POLICY_KINDS` would be a silent
-- downgrade from moderated to auto-approved. The event-key space IS first-party
-- curated today, so the same downgrade applies here.
--
-- And the two errors are not symmetric. An over-moderated kind is loosened with
-- one edit to `REVIEW_POLICY_KINDS`. An auto-approved kind lets a publisher
-- SQUAT a key — `deploy:done`, `release:green` — and a squatted key in a
-- namespace agents resolve against is public before anyone looks and cannot be
-- retracted from the installs that already bound to it. When the inert/actuating
-- criterion does not cleanly decide, take the mistake you can undo.
--
-- EXIT CONDITION: revisit this posture when P-029 half (a) lands a STRUCTURAL
-- publisher-scoped-prefix guard on the registry. Resolution-time scoping is what
-- would make squatting impossible rather than merely reviewable; until then
-- review is the only thing standing between a publish and a captured key.
--
-- SQLite cannot alter a CHECK constraint in place, so this is a one-shot table
-- rebuild, the same shape as migrations 015, 024, 029 and 030.
--
-- ⚠ COLUMN LIST DERIVED FROM THE LIVE CHAIN AT 030, NOT COPIED BLIND — the same
-- discipline 029 demanded of 030. Derivation (measured 2026-09-16): 030 is the
-- highest migration in this directory, so nothing has touched `harnesses`
-- columns since its rebuild; the last migration to ADD a column is still 028
-- (pinned_commit_sha / pinned_tree_digest / pinned_at), which 029 and 030 both
-- carried. The chain-at-030 column set is therefore exactly 030's rebuild list,
-- and the only difference below is `'event'` in the listing_kind CHECK.
--
-- migration-column-preservation.test.ts applies the FULL chain UNPINNED and
-- asserts this table's column set survives the rebuild, so it covers this
-- migration without having been edited for it. That test — not this comment —
-- is what proves the derivation.
--
-- ⚠ APPLY PATH: this directory is a WRANGLER D1 MIGRATION SET. Apply with
--     wrangler d1 migrations apply papercusp-cupboard --remote
-- which applies every file not yet in `d1_migrations`, in NAME order (this is
-- `npm run deploy`'s predeploy step). NEVER `wrangler d1 execute --file` for a
-- file in this set: execute applies the SQL WITHOUT recording it, so the next
-- `migrations apply` re-runs it — and re-running a table rebuild is destructive.

PRAGMA foreign_keys=OFF;
DROP TABLE IF EXISTS harnesses_new;

CREATE TABLE harnesses_new (
  id TEXT PRIMARY KEY NOT NULL,
  listing_kind TEXT NOT NULL DEFAULT 'harness'
    CHECK (listing_kind IN ('harness', 'blueprint', 'plugin', 'pack', 'knowledge-pack', 'template', 'app', 'rubric', 'plan', 'recipe', 'goal', 'theme', 'datatype', 'rule', 'event')),
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
  revoked_reason TEXT,
  -- Added by migration 028 (content pin at publish). Present here because this
  -- rebuild was derived from the chain at 030 — NOT because 024 knew about them.
  pinned_commit_sha TEXT,
  pinned_tree_digest TEXT,
  pinned_at INTEGER
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
  yanked_at, yanked_reason, revoked_at, revoked_reason,
  pinned_commit_sha, pinned_tree_digest, pinned_at
)
SELECT
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
  yanked_at, yanked_reason, revoked_at, revoked_reason,
  pinned_commit_sha, pinned_tree_digest, pinned_at
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
