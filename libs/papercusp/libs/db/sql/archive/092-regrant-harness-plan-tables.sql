-- 092-regrant-harness-plan-tables.sql
--
-- Catch-up GRANTs for harness_plan_status / harness_plan_assertions.
--
-- The GRANT statements in 086/087 were committed ~15 min AFTER the
-- table-create versions of those files (086: grants added in 197778c, after
-- the table-create commit 25308f6). The migration runner tracks applied
-- migrations by FILENAME only (migration-runner.js: `if (applied.has(f))
-- continue`) and never re-applies a recorded file — the stored sha256 is
-- never compared. So any embedded-pg that recorded `086-harness-plan-status.sql`
-- from its grant-less version never re-ran the corrected file. On those DBs
-- the `harness_app` runtime role has no DML privilege on the tables and
-- `plans:start` fails with `permission denied for table harness_plan_status`.
--
-- GRANT is idempotent, so this is a no-op on DBs that already have the grant
-- (fresh installs that recorded 086/087 after the grants landed). Mirrors the
-- catch-up-grant precedent (067, 069).

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_plan_status     TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_plan_assertions TO harness_app, harness_admin;
