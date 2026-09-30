-- 684 — gym task CORPUS label (plan gym-real-fitness-signal-2026-07-27, P-003).
--
-- WHY. Until now every gym champion was crowned on three hardcoded toy tasks
-- (`gym-loop-health` / `-version` / `-ready`) against a synthetic 4-line service the
-- gym generates itself (`index.js` = `export function handle(req){ return { status:
-- 404 }; }`, sole build gate `node --check`). Nothing in the schema recorded that,
-- so a prompt promoted on toy work is indistinguishable from one promoted on real
-- work — and the release gate stayed green through six scorecards because every
-- criterion measured MECHANISM health (error rate, ledger reconciliation, lens
-- diversity) and none asked whether the thing being optimized was real.
--
-- This migration makes the corpus a FIRST-CLASS, QUERYABLE FACT:
--   * harness_gym_durable.gym_tasks.corpus       — which corpus a task belongs to
--   * harness_shared.gym_proposals.task_corpus   — what a challenger was judged on
--
-- Both default to 'synthetic' and existing rows are backfilled to 'synthetic',
-- because that is the honest reading of every artifact produced before this point.
-- P-011 then hangs a `fitness-signal-is-real` release-gate criterion off
-- gym_tasks.corpus so a green gate is IMPOSSIBLE while the active corpus is a stub.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS + guarded constraint adds) per repo policy.

-- ── gym_tasks.corpus ───────────────────────────────────────────────────────────
ALTER TABLE harness_gym_durable.gym_tasks
  ADD COLUMN IF NOT EXISTS corpus text NOT NULL DEFAULT 'synthetic';

-- 'synthetic' = a generated stub substrate (proves the MECHANISM only).
-- 'real'      = a task derived from genuinely shipped work with a known outcome.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'gym_tasks_corpus_check'
       AND conrelid = 'harness_gym_durable.gym_tasks'::regclass
  ) THEN
    ALTER TABLE harness_gym_durable.gym_tasks
      ADD CONSTRAINT gym_tasks_corpus_check CHECK (corpus IN ('synthetic', 'real'));
  END IF;
END $$;

-- The release gate reads "does this harness have any REAL task", so index the axis
-- it filters on rather than scanning every task row.
CREATE INDEX IF NOT EXISTS gym_durable_tasks_ws_harness_corpus_idx
  ON harness_gym_durable.gym_tasks (workspace_id, harness_slug, corpus);

-- ── gym_proposals.task_corpus ─────────────────────────────────────────────────
-- The provenance stamp that stops a toy-earned champion from ever reading as a
-- real one in the Gym tab or in an audit.
ALTER TABLE harness_shared.gym_proposals
  ADD COLUMN IF NOT EXISTS task_corpus text NOT NULL DEFAULT 'synthetic';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'gym_proposals_task_corpus_check'
       AND conrelid = 'harness_shared.gym_proposals'::regclass
  ) THEN
    ALTER TABLE harness_shared.gym_proposals
      ADD CONSTRAINT gym_proposals_task_corpus_check
      CHECK (task_corpus IN ('synthetic', 'real', 'mixed'));
  END IF;
END $$;

-- Backfill is implicit in the NOT NULL DEFAULT above for existing rows; state it
-- explicitly anyway so a re-run after a manual NULLing still converges.
UPDATE harness_gym_durable.gym_tasks SET corpus = 'synthetic' WHERE corpus IS NULL;
UPDATE harness_shared.gym_proposals SET task_corpus = 'synthetic' WHERE task_corpus IS NULL;
