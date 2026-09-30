-- 278-hive-member-repo-permission-cache.sql
--
-- shared-hive-collaboration-2026-06-14 B11 / P-014 (role/permission tiers, D-011):
-- cache the GitHub collaborator-graph permission derived for each hive member, so
-- routine tier checks read the cache (refreshed by the daily recheck) while
-- high-stakes owner-actions re-derive LIVE from GitHub (the cache is advisory
-- there). Nullable — unbound/solo + never-checked members stay NULL, and the
-- resolver treats a NULL/stale cache as "derive live".
--
--   repo_permission        the GitHub permission last derived for this member on
--                          the hive's repo (admin|maintain|write|triage|read|none).
--                          NULL = never derived.
--   permission_checked_at  epoch ms of the last derivation (freshness for the
--                          cached-read TTL).
--
-- Idempotent. No data of value pre-exists (additive columns).

ALTER TABLE harness_shared.hive_members
  ADD COLUMN IF NOT EXISTS repo_permission text,
  ADD COLUMN IF NOT EXISTS permission_checked_at bigint;
