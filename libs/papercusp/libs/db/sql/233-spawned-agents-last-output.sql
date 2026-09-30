-- Migration 233 — agent-liveness-heartbeat-hardening-2026-06-12 P-008:
-- bee stream-activity stamp. The orchestrator runner already consumes the
-- child's stdout in-process (orchestrator-runner.ts capture path); the spawn
-- engine throttles that signal onto the nursery row so consumers can tell a
-- GENERATING bee (output moving) from a wedged-alive one (fresh heartbeat,
-- silent stream). Display/triage only — never an input to claim release
-- (plan D-002). NULL = no output observed yet (or a pre-233 row).
ALTER TABLE harness_shared.spawned_agents
  ADD COLUMN IF NOT EXISTS last_output_at timestamptz;

COMMENT ON COLUMN harness_shared.spawned_agents.last_output_at IS
  'Last time the supervising host observed the child emit stdout/stderr bytes (liveness-hardening P-008). Fresh heartbeat_at + stale last_output_at = wedged-alive candidate. Annotation only; the claim-release sweep never reads it.';
