-- Migration 258 — drop the harness_git_log mirror table.
-- Part of fs-watcher-retirement-2026-05-10 step 1.
--
-- harness_shared.harness_git_log was a pure CACHE over `git log` (git is the
-- canonical producer). The fs-watcher mirror leg (replaceGitLog /
-- deleteGitLogAll in harness-fs-watcher.ts) is removed, and the UI
-- (RealGitPanel / AdvGitPanel) already reads the on-demand
-- /api/harness/<slug>/git/log REST route (3s-TTL cached, shells out live).
-- Nothing reads this table anymore; dropping it loses no source-of-truth data
-- (git is the source). Idempotent.

DROP TABLE IF EXISTS harness_shared.harness_git_log CASCADE;
