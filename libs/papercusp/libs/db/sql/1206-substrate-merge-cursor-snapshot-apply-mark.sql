-- 1206-substrate-merge-cursor-snapshot-apply-mark.sql
-- p2p-join-catchup-speed-2026-09-23 P-008 (endgame D-060, WI-10002783 / WI-10002774):
-- durable snapshot bookkeeping beside each log's merge position.
--
-- A reader that already folded a log's prefix [0, coversUpTo) op by op gains
-- nothing from that log's snapshot set at coversUpTo. Re-applying it cost one PG
-- apply per live row (after a restart the in-memory winners are empty, so none are
-- deduped): 1.24M rows at ~25 rows/s on the P-203 VM. The fold now skips such a set
-- and applies only the sets this cursor OWES. It needs these columns to know, across
-- a restart, which set that is:
--
--   snapshot_apply_through  the highest coversUpTo whose set this cursor owes (the
--                           set it was seeded at or jumped to). NULL = none.
--   snapshot_hole           the highest position the cursor moved past WITHOUT
--                           applying the op there (a version-gated or unreadable
--                           op). The next set re-delivers it. NULL = none.
--   snapshot_mark_position  the position the two marks above were recorded at.
--
-- The marks are trusted ONLY when snapshot_mark_position = position. Any writer that
-- moves `position` without re-stamping leaves a mismatch: an older or rolled-back
-- build, or a manual SQL edit of `position`. The reader then treats the row as
-- unstamped, meaning it owes the next set, which is the pre-P-008 behaviour for that
-- one set. It never treats the row as "skip". So no backfill is needed, and existing
-- rows stay correct as they are.
--
-- Expand-only: the currently deployed release neither reads nor writes these
-- columns, and its position-only upserts leave them untouched (which is exactly what
-- invalidates the stamp).

ALTER TABLE harness_shared.substrate_merge_cursor
  ADD COLUMN IF NOT EXISTS snapshot_apply_through bigint,
  ADD COLUMN IF NOT EXISTS snapshot_hole bigint,
  ADD COLUMN IF NOT EXISTS snapshot_mark_position bigint;

COMMENT ON COLUMN harness_shared.substrate_merge_cursor.snapshot_apply_through IS
  'P-008: highest snapshot-set coversUpTo this cursor owes (seeded/jumped set); chunks at or below it are applied row by row, other skip-eligible sets are skipped as redundant. NULL = none. Trusted only when snapshot_mark_position = position.';

COMMENT ON COLUMN harness_shared.substrate_merge_cursor.snapshot_hole IS
  'P-008: highest log position the cursor advanced past without applying the op (version-gated drop, undecodable, WI-2003 dead-letter); the next snapshot set is applied to re-deliver it. NULL = none. Trusted only when snapshot_mark_position = position.';

COMMENT ON COLUMN harness_shared.substrate_merge_cursor.snapshot_mark_position IS
  'P-008: the position at which snapshot_apply_through / snapshot_hole were recorded. A mismatch with position (a writer that moved position without re-stamping) makes the row unstamped: the reader then owes the next snapshot set rather than skipping it.';
