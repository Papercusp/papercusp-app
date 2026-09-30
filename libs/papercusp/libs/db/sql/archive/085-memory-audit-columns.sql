-- 085-memory-audit-columns.sql
--
-- Memory-audit substrate for the layered audit pipeline.
-- Plan: apps/operator/docs/plans/papercusp-su-memory-2026-05-25.md
--   - Phase 5 P-018 (this migration)
--   - Phase 5 P-019 (Layer 1 nightly anchor structural check, consumes
--                    `memory_anchors` + the new `state` column)
--   - Phase 5 P-020 (Layer 2 correction-driven invalidation, writes
--                    `state='contradicted'` via memory:forget)
--   - Phase 5 P-021 (bumps `last_surfaced_at` on every injection)
--
-- Two changes:
--
--   1. Audit columns on `memory_canonical`:
--      - `last_validated_at`  timestamptz  — when Layer 3 last LLM-checked
--      - `last_surfaced_at`   timestamptz  — when injection last picked this
--      - `state`              text         — active | broken_anchor |
--                                            superseded | contradicted |
--                                            forgotten
--      All three are nullable / defaulted so existing rows pick up
--      sensible values without backfill. `state` defaults to 'active'.
--
--   2. New table `memory_anchors`:
--      - One row per (memory_id, kind, value) triple
--      - Populated at memory:remember write time (P-015)
--      - Layer 1 (P-019) queries this table directly for cheap shell-only
--        validation (file existence, F-NNN existence, plan/migration
--        existence). Indexed for the "give me all memories whose anchor X
--        is now broken" sweep.
--
-- Idempotent + non-destructive. Safe to re-run.

\set ON_ERROR_STOP on
BEGIN;

-- ─── 1. Audit columns on memory_canonical ─────────────────────────────

ALTER TABLE harness_shared.memory_canonical
  ADD COLUMN IF NOT EXISTS last_validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_surfaced_at  timestamptz,
  ADD COLUMN IF NOT EXISTS state             text NOT NULL DEFAULT 'active';

-- Loose enum via CHECK constraint — easier to evolve than a real enum
-- (adding a value to a pg enum needs an ALTER + restart; check-constraint
-- DDL is plain ALTER + idempotent re-add). Drop+re-add when extending.
DO $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'memory_canonical_state_check'
      AND conrelid = 'harness_shared.memory_canonical'::regclass
  ) THEN
    ALTER TABLE harness_shared.memory_canonical
      ADD CONSTRAINT memory_canonical_state_check
      CHECK (state IN (
        'active',
        'broken_anchor',
        'superseded',
        'contradicted',
        'forgotten'
      ));
  END IF;
END
$body$;

-- Layer-1 sweep: "find all non-active memories" should be sub-millisecond.
CREATE INDEX IF NOT EXISTS memory_canonical_state_idx
  ON harness_shared.memory_canonical (state)
  WHERE state <> 'active';

-- Layer-3 picker: "audit memories actually used recently AND stale-validation".
-- Partial index keeps it tiny (most rows have null last_surfaced_at).
CREATE INDEX IF NOT EXISTS memory_canonical_recently_surfaced_idx
  ON harness_shared.memory_canonical (last_surfaced_at DESC NULLS LAST)
  WHERE last_surfaced_at IS NOT NULL;


-- ─── 2. memory_anchors table ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS harness_shared.memory_anchors (
  memory_id  uuid        NOT NULL
    REFERENCES harness_shared.memory_canonical(id) ON DELETE CASCADE,
  kind       text        NOT NULL,
  value      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Layer 1 nightly check stamps this when it last verified the anchor.
  -- Null = never checked. last_check_ok=false marks a confirmed-broken
  -- anchor (and the parent memory's state should flip to 'broken_anchor').
  last_checked_at timestamptz,
  last_check_ok   boolean,
  PRIMARY KEY (memory_id, kind, value)
);

-- Kind values mirror AnchorKind in apps/operator/lib/memory/anchors.ts:
-- 'file' | 'feature' | 'plan' | 'migration' | 'symbol'
DO $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'memory_anchors_kind_check'
      AND conrelid = 'harness_shared.memory_anchors'::regclass
  ) THEN
    ALTER TABLE harness_shared.memory_anchors
      ADD CONSTRAINT memory_anchors_kind_check
      CHECK (kind IN ('file', 'feature', 'plan', 'migration', 'symbol'));
  END IF;
END
$body$;

-- "Give me every memory that references this file/feature/plan/etc."
-- Used by Layer 1 when a file is deleted or a feature deprecated — sweep
-- all memories that pointed at it and re-validate (or flag broken).
CREATE INDEX IF NOT EXISTS memory_anchors_lookup_idx
  ON harness_shared.memory_anchors (kind, value);

-- "Give me every anchor never checked yet OR checked > N days ago."
-- Drives the nightly cron's work-queue.
CREATE INDEX IF NOT EXISTS memory_anchors_recheck_idx
  ON harness_shared.memory_anchors (last_checked_at NULLS FIRST);


-- ─── 3. comment grants on new table for harness_app role ──────────────
-- harness_app needs SELECT + INSERT + DELETE for memory:remember /
-- memory:forget paths. UPDATE for Layer 1's recheck-stamp writes.

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.memory_anchors
  TO harness_app;

GRANT SELECT, UPDATE
  ON harness_shared.memory_canonical
  TO harness_app;
-- (SELECT + INSERT already granted by 081; this re-asserts UPDATE for
-- the audit-column writes.)

COMMIT;
