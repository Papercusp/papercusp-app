-- 1107-plan-revisions-content-snapshot-hash.sql
--
-- EI-219171: `content_hash` intentionally identifies the canonical prose body,
-- while `content_snapshot` also carries enriched template data. Keeping those
-- meanings separate is required by activation/current-revision comparisons.
--
-- The adjacent column name invited callers to treat content_hash as a digest of
-- the stored snapshot, but callers can supply that value independently. Derive
-- an additive hash from the bytes persisted in content_snapshot so a future
-- guard cannot silently certify stale snapshot evidence.

ALTER TABLE harness_shared.plan_revisions
  ADD COLUMN IF NOT EXISTS content_snapshot_hash text
  GENERATED ALWAYS AS (encode(digest(content_snapshot, 'sha256'), 'hex')) STORED;

COMMENT ON COLUMN harness_shared.plan_revisions.content_snapshot_hash IS
  'SHA-256 digest of the persisted content_snapshot bytes. STORED generated column; do not write directly. content_hash remains the canonical prose-body hash.';
