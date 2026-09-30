-- 267-retire-plan-review.sql
--
-- queen-autonomy-policy-2026-06-13 (B-14 / P-101 · D-011): retire the vestigial
-- Reviews source. `harness_shared.harness_plan_review` had NO live writer — its
-- only producer was the retired bash `run.sh` plan-review block (which POSTed
-- /api/internal/plan-review-event, now deleted). The plan-review attention kind
-- + adapter + the inbox "Reviews" counter are removed; the review-gate role is
-- now served by `needs-human` plan items (a plan-governance Decision on the
-- unified Queue), so this table is dead and dropped.
--
-- Idempotent. Drops the table + its workspace-isolation RLS policy and the
-- single-row-per-harness PK with it. No data of value is lost (no live writer).
-- generated.ts still carries an unused `harnessPlanReviewInHarnessShared` export
-- until the next pull-schema runs against a DB where this has applied — harmless
-- (no TS importer remains after P-101).

DROP TABLE IF EXISTS harness_shared.harness_plan_review;
