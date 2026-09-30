-- Cupboard migration 018 — catalog fields for visibility, SKU, compatibility,
-- permissions, immutable releases, and tenant isolation.
--
-- Plan: shared-pot-dao-cupboard-v1-2026-09-04 (P-008; D-024, D-025, D-027..D-029).
--
-- WHAT CHANGES
-- ------------
-- The eleven-kind catalog (migrations 004..016) carries kind, project identity,
-- review status, and the app-distribution columns, but nothing about WHO may see
-- a listing, WHAT it costs, WHAT it runs on, WHAT it may do once installed, or
-- WHICH immutable release a row points at. P-008 adds those six axes as columns
-- on the existing `harnesses` listing table rather than a parallel catalog:
--
--   visibility axis      visibility, tenant_id
--   commerce axis        sku_ref, pricing_model, price_amount_micros, price_currency
--   compatibility axis   compatibility_json  ({ runtime, platforms[], architectures[] })
--   permission axis      required_permissions (JSON string[])
--   immutable release    release_version, release_content_hash,
--                        release_manifest_digest, release_signature,
--                        yanked_at/yanked_reason, revoked_at/revoked_reason
--
-- PROVIDER NEUTRALITY (D-025, D-028): the commerce columns are provider-neutral.
-- `sku_ref` is an opaque SKU identifier and `price_amount_micros`/`price_currency`
-- are integer minor-unit amounts — no Stripe price id, no gateway URL, no blob
-- provider reference. A settlement adapter maps `sku_ref` to its own product; the
-- catalog never learns which adapter is in use.
--
-- STORAGE NEUTRALITY (D-024, D-025): the release columns carry content IDENTITY
-- (hash, manifest digest, signature) and never a retrieval URL, so the later P2P
-- storage migration changes the ArtifactStore adapter and not this schema.
--
-- IMMUTABILITY: a published release is never mutated or deleted. Yank and revoke
-- are additive timestamp columns, and the release identity is pinned by a partial
-- UNIQUE index — republishing the same version is a constraint violation, not an
-- overwrite.
--
-- TENANT ISOLATION: `tenant_id` names the owning shared pot. NULL is the global
-- public catalog. Read paths are fail-closed: only `visibility='public'` rows are
-- visible without a tenant scope (see compileHarnessListPredicate in src/db.ts).
--
-- This is a plain additive ALTER chain — no table rebuild — so it is safe to
-- apply to the live D1 database while the worker is serving. SQLite permits a
-- column-level CHECK on ADD COLUMN as long as the column carries a default.
--
-- Apply:
--   wrangler d1 execute papercusp-cupboard --remote \
--     --file migrations/018_catalog_visibility_sku_release.sql

-- ── Visibility + tenant isolation ────────────────────────────────────────────
-- public   — listed in the global catalog (every pre-018 row; preserves behavior)
-- unlisted — reachable by direct id/ref, never returned by browse
-- private  — visible only within the owning tenant
ALTER TABLE harnesses ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('public', 'unlisted', 'private'));

ALTER TABLE harnesses ADD COLUMN tenant_id TEXT;

-- ── Commerce (provider-neutral; D-028) ───────────────────────────────────────
ALTER TABLE harnesses ADD COLUMN sku_ref TEXT;

ALTER TABLE harnesses ADD COLUMN pricing_model TEXT
  CHECK (pricing_model IS NULL OR pricing_model IN ('free', 'one-time', 'subscription', 'per-use'));

-- Integer minor units scaled by 1e6 so per-use microcharges and stablecoin
-- amounts are exact; float money is never stored.
ALTER TABLE harnesses ADD COLUMN price_amount_micros INTEGER;

-- ISO-4217 code or a stablecoin symbol (e.g. 'USD', 'USDC').
ALTER TABLE harnesses ADD COLUMN price_currency TEXT;

-- ── Compatibility + permissions (mirrors the P-006 release manifest) ─────────
-- { "runtime": "node>=22", "platforms": ["darwin-aarch64"], "architectures": ["arm64"] }
ALTER TABLE harnesses ADD COLUMN compatibility_json TEXT;

-- JSON string[] of the permissions the unit REQUESTS at install time.
ALTER TABLE harnesses ADD COLUMN required_permissions TEXT;

-- ── Immutable release identity ───────────────────────────────────────────────
ALTER TABLE harnesses ADD COLUMN release_version TEXT;
ALTER TABLE harnesses ADD COLUMN release_content_hash TEXT;      -- sha256:<64 hex>
ALTER TABLE harnesses ADD COLUMN release_manifest_digest TEXT;   -- listingManifestDigest()
ALTER TABLE harnesses ADD COLUMN release_signature TEXT;
ALTER TABLE harnesses ADD COLUMN release_published_at INTEGER;   -- unix ms
ALTER TABLE harnesses ADD COLUMN yanked_at INTEGER;              -- unix ms; row is kept
ALTER TABLE harnesses ADD COLUMN yanked_reason TEXT;
ALTER TABLE harnesses ADD COLUMN revoked_at INTEGER;             -- unix ms; row is kept
ALTER TABLE harnesses ADD COLUMN revoked_reason TEXT;

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- Public browse is visibility-scoped, so the browse index leads with visibility.
CREATE INDEX IF NOT EXISTS harnesses_visibility_idx
  ON harnesses (visibility, unlisted_at, last_activity_at DESC);

-- Tenant rollup: every listing owned by one shared pot.
CREATE INDEX IF NOT EXISTS harnesses_tenant_idx
  ON harnesses (tenant_id, visibility, last_activity_at DESC)
  WHERE tenant_id IS NOT NULL;

-- Settlement lookup: adapter receives a sku_ref and resolves the listing.
CREATE INDEX IF NOT EXISTS harnesses_sku_idx
  ON harnesses (sku_ref) WHERE sku_ref IS NOT NULL;

-- Content-addressed lookup for delivery + dependency resolution.
CREATE INDEX IF NOT EXISTS harnesses_release_hash_idx
  ON harnesses (release_content_hash) WHERE release_content_hash IS NOT NULL;

-- Immutable release identity: one row per (repo, kind, listing_ref, version).
-- Unlike the active-listing indexes this is NOT scoped to `unlisted_at IS NULL`
-- — an unlisted or yanked release still occupies its version forever, which is
-- exactly what makes the release immutable.
--
-- ⚠ listing_ref is COALESCEd to '' deliberately. SQLite treats NULLs as DISTINCT
-- in a UNIQUE index (the caveat migration 004 relies on for its per-kind index),
-- so a bare column list would let the canonical listing_ref IS NULL row publish
-- the SAME release_version twice without violating the constraint — silently
-- breaking the immutability this index exists to enforce.
CREATE UNIQUE INDEX IF NOT EXISTS harnesses_release_identity_unique
  ON harnesses (github_repository_id, listing_kind, COALESCE(listing_ref, ''), release_version)
  WHERE release_version IS NOT NULL;
