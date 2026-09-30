-- 578-memory-canonical-temporal-lite.sql — memory-temporal-lite-validity-windows-2026-07-11
-- P-001 (owner-approved direction; executed under memory-public-release-hardening-2026-07-11
-- P-006): temporal-lite validity windows + supersession on the canonical memory store,
-- Graphiti-schema-inspired, rolled our own on memory_canonical.
--
--   • valid_at      — when the fact BECAME true. NULL ⇒ treat as created_at (the
--                     backfill semantics: no data migration beyond this DDL).
--   • invalid_at    — when the fact STOPPED being true. NULL ⇒ still current.
--                     Read paths exclude rows with invalid_at <= now() by default
--                     (CanonicalVectorStore search/list, behind an include_superseded
--                     opt-in); point-in-time reads use valid_at <= as_of < invalid_at.
--   • superseded_by — fk-free pointer to the memory row that REPLACED this one
--                     (deliberately no FK: the replacing row may be hard-deleted
--                     later for privacy without cascading here; consumers treat a
--                     dangling pointer as "superseded by a now-forgotten fact").
--
-- COLUMNS, not payload keys: indexable, and zero impact on the vec tables — the
-- embedding never covers validity, so invalidation/supersession NEVER re-embeds.
-- The existing `state` lifecycle column (active/broken_anchor/superseded/…) is the
-- anchor-audit taxonomy and is deliberately untouched here — validity windows are
-- orthogonal time semantics, not a state machine.
--
-- The partial index serves the default read shape: current rows (invalid_at IS
-- NULL), newest first (list's ORDER BY created_at DESC over a scope post-filter).

\set ON_ERROR_STOP on

ALTER TABLE harness_shared.memory_canonical
  ADD COLUMN IF NOT EXISTS valid_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS invalid_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS superseded_by uuid NULL;

CREATE INDEX IF NOT EXISTS memory_canonical_current_idx
  ON harness_shared.memory_canonical USING btree (created_at DESC)
  WHERE invalid_at IS NULL;
