-- 279: add session_id to agent_usage_samples — per-session attribution for the
-- warm-inject carry-cost metric (bee-context-efficiency-2026-06-14 P-001).
--
-- WHY: a Hive bee processes many warm-injected tasks on ONE resumed claude
-- session (`claude --resume <session_id> -p`), its transcript accumulating the
-- full text of every prior task. agent_usage_samples (mig 161) is keyed by
-- run_id, and the warm-inject/resume turns are spawned by the wake-executor's
-- `resume-headless` path (wake-executor.ts) which has NO spawned_agents row to
-- join run_id -> session_id against. Recording session_id directly on the sample
-- lets bee-wake-efficiency GROUP successive samples by session and measure the
-- cache_read growth across tasks (= the carry cost), and lets the resume path
-- emit an attributable sample at all.
--
-- Nullable + additive: existing rows stay NULL; non-claude backends (omp/codex —
-- no forced native session id) stay NULL by design. Behavior-neutral.
--
-- The migration runner wraps each file in its own transaction (and strips psql
-- metacommands), so this file carries NO top-level BEGIN;/COMMIT;/\set
-- (migration-runner.js contract; lint:migrations).

ALTER TABLE harness_shared.agent_usage_samples
  ADD COLUMN IF NOT EXISTS session_id text;

-- Per-session newest-first read (bee-wake-efficiency groups a bee's wakes by
-- the session they resumed, ordered by ts, to see the cache_read trajectory).
CREATE INDEX IF NOT EXISTS agent_usage_samples_ws_session_ts_idx
  ON harness_shared.agent_usage_samples (workspace_id, session_id, ts DESC)
  WHERE session_id IS NOT NULL;
