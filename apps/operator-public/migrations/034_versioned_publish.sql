-- P-004: a new pinned commit is a new self-describing listing version.
-- Exact retries remain deduplicated by (repo, kind, ref, pinned SHA), while a
-- changed SHA can enter review as a fresh row. Pre-028 NULL pins are naturally
-- grouped by the route's explicit IS NULL lookup.
DROP INDEX IF EXISTS harnesses_active_listing_unique;
CREATE UNIQUE INDEX IF NOT EXISTS harnesses_active_listing_version_unique
  ON harnesses (github_repository_id, listing_kind, listing_ref, pinned_commit_sha)
  WHERE listing_kind != 'harness' AND unlisted_at IS NULL;
