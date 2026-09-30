-- 398-memory-canonical-promote-scope-columns.sql
--
-- data-scoping-audit-2026-06-22 P-006 (structural half) — promote the memory scope
-- keys from `payload` jsonb to first-class, indexed columns so workspace-scoped recall
-- and any future RLS filter on REAL columns, not a `payload->>'...'` dig (D-001 REC: the
-- scope living in jsonb is the structural smell; D-004: memory → workspace-scoped floor).
--
-- Shape: two GENERATED ALWAYS AS (payload->>'<key>') STORED columns on memory_canonical.
--   • user_id      — mem0's per-owner scope key (every one of the 7,743 live rows carries it).
--   • workspace_id — the writing agent's workspace (remember.ts already stamps
--                    metadata.workspace_id = ctx.principal.workspaceId; ~2.1k live rows carry
--                    it today, the rest NULL = written before that fix / owner-global).
--
-- Why GENERATED STORED (not plain columns + a backfill UPDATE + a write-path change):
--   • Auto-backfills EVERY existing row at ADD time — the D-006 backfill, for free.
--   • Stays in PERFECT lockstep with `payload` (the store's source of truth) on every
--     future write — no staleness, no trigger, and NO code change anywhere. The store keeps
--     writing payload exactly as today; these columns just project the scope for indexed
--     filtering. So this migration is strictly BEHAVIOR-NEUTRAL: the running operator's
--     INSERT (id,payload,created_at,updated_at) and its payload->>'user_id' reads are
--     untouched (generated cols are computed, never inserted into).
--   • `payload->>'<key>'` is immutable → valid as a generation expression.
--
-- The workspace-scoped RECALL behavior change (filter recall on workspace_id, with the
-- owner-tier user/feedback/reference exception per D-004) is a SEPARATE, deferred follow-up
-- (canonical-store.ts + the recall callers) — it rides on these columns once the gate is calm.
--
-- 7,743 rows / ~6 MB → the table rewrite (ADD ... STORED) is sub-second. Idempotent +
-- non-destructive (additive columns + indexes only). NO workspace_id DEFAULT — these are
-- derived, never defaulted, so lint:no-workspace-default stays clean.

ALTER TABLE harness_shared.memory_canonical
  ADD COLUMN IF NOT EXISTS user_id text
    GENERATED ALWAYS AS (payload->>'user_id') STORED;

ALTER TABLE harness_shared.memory_canonical
  ADD COLUMN IF NOT EXISTS workspace_id text
    GENERATED ALWAYS AS (payload->>'workspace_id') STORED;

-- Real-column indexes for the scoped-recall code phase (the existing
-- (payload->>'user_id') expression index keeps serving the store until it switches).
CREATE INDEX IF NOT EXISTS memory_canonical_user_id_col_idx
  ON harness_shared.memory_canonical (user_id);
CREATE INDEX IF NOT EXISTS memory_canonical_workspace_id_idx
  ON harness_shared.memory_canonical (workspace_id);
-- Composite for the per-(workspace,user) recall the P-006 code phase will issue.
CREATE INDEX IF NOT EXISTS memory_canonical_ws_user_idx
  ON harness_shared.memory_canonical (workspace_id, user_id);

COMMENT ON COLUMN harness_shared.memory_canonical.user_id IS
  'GENERATED from payload->>''user_id'' (data-scoping-audit P-006). mem0''s per-owner scope key, promoted to a first-class indexed column; the payload jsonb remains the store''s source of truth.';
COMMENT ON COLUMN harness_shared.memory_canonical.workspace_id IS
  'GENERATED from payload->>''workspace_id'' (data-scoping-audit P-006 / D-004). The writing agent''s workspace (remember.ts stamps it into metadata); NULL for pre-fix / owner-global rows. The workspace-scoped recall filter rides on this column in the deferred code phase.';
