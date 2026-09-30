-- Migration 482 — code:run batch-nudge fire telemetry
-- (code-run-self-state-adoption-2026-07-03 P-005).
--
-- The inline batch/fan-out nudge (code-run-batch-nudge.ts) had A/B flags
-- (CODE_RUN_BATCH_NUDGE / CODE_RUN_FANOUT_NUDGE) but its FIRES were recorded
-- nowhere, so nudge→conversion — did the nudged session then call code:run? —
-- was unmeasurable and the adoption metric could not attribute movement to the
-- nudge. One narrow append-only row per fire, written best-effort from the MCP
-- handler (a failed insert never affects the tool result).
--
-- LOCAL telemetry, NOT federated (the mig 472 carry_notes precedent): no
-- author_pubkey/origin/fed_ts columns and no sync/hyperbee projection — a
-- machine's nudge fires are its own diagnostics. Prune-safe: age-trimmable via
-- storage:prune-style deletes at any time; readers only aggregate.
CREATE TABLE IF NOT EXISTS harness_shared.code_run_nudge_fires (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  -- The nudge module's per-session key (replayOwnerKey = uiClientId ?? spawnId):
  -- join against tool_invocations.spawn_id / uiClientId to compute conversion.
  session_key  TEXT NOT NULL,
  role         TEXT NOT NULL,
  -- Which trigger fired: 'same-tool' | 'fanout' (BatchNudgeKind).
  kind         TEXT NOT NULL,
  -- The tool call the hint was attached to.
  tool_name    TEXT NOT NULL,
  fired_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The conversion read: fires for a window, joined by session.
CREATE INDEX IF NOT EXISTS code_run_nudge_fires_at
  ON harness_shared.code_run_nudge_fires (fired_at);
CREATE INDEX IF NOT EXISTS code_run_nudge_fires_session
  ON harness_shared.code_run_nudge_fires (session_key, fired_at);

GRANT SELECT, INSERT, DELETE ON harness_shared.code_run_nudge_fires TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.code_run_nudge_fires TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.code_run_nudge_fires ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS code_run_nudge_fires_workspace_isolation ON harness_shared.code_run_nudge_fires;
CREATE POLICY code_run_nudge_fires_workspace_isolation ON harness_shared.code_run_nudge_fires
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)));
