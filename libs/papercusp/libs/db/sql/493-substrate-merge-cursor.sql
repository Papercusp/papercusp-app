-- 493-substrate-merge-cursor.sql
-- WI-2105 (shared-hive-p2p-release-readiness) REV-leg fix: durable per-log
-- merge-cursor positions.
--
-- The substrate boot merge folds each admitted peer log incrementally via an
-- IN-MEMORY MergeCursor (positions: keyHex -> next index to read). On every
-- bg-host restart that cursor reset to 0, so a large log (e.g. the orphaned
-- 70k-op e06b8704) re-folded from scratch, CPU-starved the DBOS routinesTick
-- past the 240s bghost-watchdog freshness bound, and the watchdog restarted
-- bg-host -> the fold never reached tail (the REV restart loop). Persisting the
-- cursor positions here makes fold progress MONOTONIC across restarts: boot
-- seeds each log's position from this table before the first fold, and the fold
-- checkpoints positions back here persist-AFTER-apply (strictly after the ops up
-- to that position have committed to their projections), so a crash re-folds the
-- last batch idempotently (LWW put/del) rather than skipping it. Unlike
-- snapshot-seeding (own-log only), this resumes ANY admitted log, including an
-- orphaned peer log the tower can no longer snapshot.
--
-- Idempotent (CREATE ... IF NOT EXISTS) per migration policy.

CREATE TABLE IF NOT EXISTS harness_shared.substrate_merge_cursor (
  workspace_id text        NOT NULL,
  harness_slug text        NOT NULL,
  log_keyhex   text        NOT NULL,
  position     bigint      NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, harness_slug, log_keyhex)
);

COMMENT ON TABLE harness_shared.substrate_merge_cursor IS
  'WI-2105: durable per-log substrate merge-cursor positions (keyHex -> next index). Written persist-after-apply so a restart resumes each log''s fold instead of re-folding from 0. See packages/operator-core/lib/sync/hyperbee/read-merge.ts (seedCursorFromPg / persistCursor) + boot.ts wiring.';
