-- 1092-add-operator-announced-quiesce-state.sql — EI-22040647386284200.
--
-- operator_announced_quiesce_state — one JSONB row per workspace holding, per
-- announced "subject" (e.g. 'bg-host'), a bounded-duration deliberate-quiesce
-- window: { [subject: string]: { reason: string, by: string, announcedAt:
-- number, until: number } }.
--
-- WHY: the single-primary guard (packages/operator-core/lib/system-health/
-- single-primary-check.ts) already suppresses its "start the bg-host" alarm
-- for ONE specific, systemd-verified signal (D-026: the release-cut whole-cut
-- unit + its registered restore leg both active). That contract has no trace
-- for an AD-HOC quiesce — an agent that stops bg-host by hand (a plain
-- kill/systemctl stop + a shell EXIT trap, exactly what a P-101 hyperbee
-- corestore seed-cut re-run does) leaves nothing D-026 can observe. The alarm
-- then reads the resulting silence as a genuine crash and instructs every
-- agent on the box to restart bg-host — precisely the action the quiescing
-- agent is relying on nobody taking (observed live 2026-09-01T06:44Z).
--
-- This table is the missing, broader half: any agent can register a bounded
-- window via supervision:announce-quiesce, and any guard willing to trust a
-- self-reported (not systemd-verified) window can read it back — see
-- packages/operator-core/lib/system-health/announced-quiesce.ts. It does NOT
-- replace D-026; D-026 stays the narrower, stronger-evidence check and is
-- consulted first.
--
-- Same single-JSONB-row-per-workspace architecture as migration 812
-- (operator_supervision_pause_state) and 635 (operator_liveness_flap_state):
-- durable, read+mutated+written through the operator-state-pg helpers so an
-- in-memory Map cannot amnesia away the clock on a process restart.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_announced_quiesce_state (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_announced_quiesce_state TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_announced_quiesce_state TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_announced_quiesce_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_announced_quiesce_state_workspace_isolation ON harness_shared.operator_announced_quiesce_state;
CREATE POLICY operator_announced_quiesce_state_workspace_isolation ON harness_shared.operator_announced_quiesce_state
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
