-- 1012 — distinguish the active gym task corpus from durable task history.
--
-- Durable analytics intentionally retain tasks from every gym run.  The
-- fitness-signal-is-real gate, however, judges the corpus used by the current
-- loop.  Without an explicit active bit, a historical synthetic task remains in
-- the table forever and keeps the gate red even after a fully-real cycle lands.
--
-- Existing rows start active to preserve the pre-migration read semantics.  The
-- next copyRunAnalyticsToDurable transaction atomically deactivates the prior
-- scope and activates exactly the task set copied by that run.

ALTER TABLE harness_gym_durable.gym_tasks
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS gym_durable_tasks_ws_harness_active_corpus_idx
  ON harness_gym_durable.gym_tasks (workspace_id, harness_slug, active, corpus);

