-- Migration 307 — Add requeue_count to harness_features_consolidated
--
-- work-queue-stuck-item-recovery-2026-06-17 (P-001 / D-007). The stale-claim
-- reaper (work-items-stale-claims.ts) now RESETS a dead-holder's mid-flight,
-- non-terminal feature row back to `todo` so it re-enters the claimable pool
-- (GAP 1). To avoid an unbounded poison-item loop (claim -> die -> requeue ->
-- claim -> ...) the reset is bounded: after `requeue_count` reaches the cap
-- (default 3, PAPERCUSP_STALE_RECLAIM_REQUEUE_CAP), the row is dead-lettered to
-- `blocked` instead. This column is that durable counter — `status='blocked'
-- AND requeue_count >= cap` is the queryable "dead-lettered by stale-reclaim"
-- signal (no separate reason column needed; the coord broadcast carries the
-- human-readable `stale-reclaim-exhausted` reason).
--
-- Dedicated column (NOT the existing `attempts` bigint) per D-007: `attempts`
-- carries pipeline-retry semantics and conflating the two would corrupt both.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, NOT NULL DEFAULT 0 (existing rows
-- backfill to 0 — never requeued yet).

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS requeue_count integer NOT NULL DEFAULT 0;

COMMIT;
