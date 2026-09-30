-- Cupboard migration 005 — snapshot tarball blob pointer (R2 cross-machine fork).
--
-- Plan: revive-cupboard-distribution-2026-06-04 (snapshot facet, owner-decided
-- 2026-06-04: snapshots fork cross-machine NOW via an R2 blob store, not deferred
-- to the project remote).
--
-- WHAT CHANGES
-- ------------
-- A snapshot is a local `.tar.gz` (operator FS + the PG snapshot_index). The
-- Cupboard listing row is METADATA-ONLY, so a snapshot published from machine A
-- couldn't be forked from machine B — the bytes never travelled. We add an R2
-- blob store (binding SNAPSHOTS) holding the tarball content-addressed at
-- `snapshots/<sha256>.tar.gz`, and the listing row now carries the pointer:
--
--   tarball_r2_key        — R2 object key, `snapshots/<sha256>.tar.gz` (content-addressed)
--   tarball_content_hash  — sha256 of the tarball (hex); the fork side verifies against it
--   tarball_bytes         — tarball size in bytes (UI display + a cheap pre-fetch sanity check)
--
-- All three are NULL for non-snapshot kinds (and for snapshot listings published
-- before this migration / without a blob). The fork bridge fetches the blob via
-- GET /blobs/snapshots/<sha256>, verifies the hash, then restores locally.
--
-- These are plain additive nullable columns, so this is a direct ALTER (no table
-- rebuild like 004). SQLite/D1 applies multiple ALTER TABLE ADD COLUMN fine.
--
-- ⚠ Apply once:
--     wrangler d1 execute papercusp-cupboard --remote \
--       --file migrations/005_snapshot_tarball_blob.sql

ALTER TABLE harnesses ADD COLUMN tarball_r2_key TEXT;
ALTER TABLE harnesses ADD COLUMN tarball_content_hash TEXT;
ALTER TABLE harnesses ADD COLUMN tarball_bytes INTEGER;

-- Blob refcount / visibility lookups: the GET /blobs gate ("serve only if a live
-- listing references this key") and the unlist GC ("delete the blob once no active
-- listing points at it") both query by tarball_r2_key. Partial index — only the
-- snapshot rows that actually carry a blob.
CREATE INDEX IF NOT EXISTS harnesses_tarball_key_idx
  ON harnesses (tarball_r2_key) WHERE tarball_r2_key IS NOT NULL;
