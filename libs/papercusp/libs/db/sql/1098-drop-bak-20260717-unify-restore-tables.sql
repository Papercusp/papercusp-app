-- Drop the 6 one-off bak_20260717_unify_* restore-point tables.
--
-- These were full row-copy snapshots taken 2026-07-17 (su-22963) as pre-flip
-- restore points ahead of the default->papercusp-workspace backfill (plan
-- unify-default-workspace-backlog-2026-07-17). WI-5142 set a soak deadline of
-- 2026-07-24: if no regression traced to the backfill by then, drop them as
-- dead weight; if one was traced, they hold the exact pre-flip rows to
-- restore from.
--
-- Verified before this migration (WI-5142, 2026-09-02):
--   - soak window passed 5+ weeks ago with zero regressions ever traced to
--     the backfill anywhere in the corpus (search_fulltext: 0 hits beyond
--     WI-5142 itself)
--   - all 6 tables still exist, holding static snapshot rows (2301/3153/
--     1125/1843/2556/7 respectively) -- nothing has written to them since
--   - no FK constraint references any of them (pg_constraint query against
--     confrelid, positive-control-verified against a live table first)
--
-- FORWARD-COMPAT: these are ad-hoc backup snapshot tables from a one-off
-- data backfill, never part of the application schema -- no route, query,
-- resolver, or migration in the currently-deployed release checkout
-- (papercup-release / :3070) reads or writes bak_20260717_unify_*, so
-- dropping them cannot break code still serving on an older release.

DROP TABLE IF EXISTS harness_shared.bak_20260717_unify_work_items;
DROP TABLE IF EXISTS harness_shared.bak_20260717_unify_links;
DROP TABLE IF EXISTS harness_shared.bak_20260717_unify_threads;
DROP TABLE IF EXISTS harness_shared.bak_20260717_unify_posts;
DROP TABLE IF EXISTS harness_shared.bak_20260717_unify_subs;
DROP TABLE IF EXISTS harness_shared.bak_20260717_unify_topics;
