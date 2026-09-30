-- 635-liveness-flap-state.sql — EI-15126 fix.
--
-- operator_liveness_flap_state — one JSONB row per workspace holding the
-- infra-liveness alarm's EI-9939 flap-episode counters (per-signature
-- fireCount + quietSinceMs), durably shared across every :3070 cluster
-- REQUEST WORKER.
--
-- Root cause this replaces: system-health/liveness-alarm.ts's `flapEpisodes`
-- was a module-level in-memory `Map`, so in a multi-worker cluster each
-- worker kept its OWN independent counter. Since which worker's periodic
-- tick happens to observe a given fire/recover transition is effectively
-- uncorrelated across cycles, no single worker's local counter ever climbed
-- past `flapThreshold`, so the fleet-wide page()/pageResolved() broadcast
-- suppression EI-9939 was built to provide never actually engaged — a
-- genuinely flapping condition (e.g. `panel:bees`) kept re-broadcasting a
-- fire+recovery pair every cycle indefinitely (observed: every ~1-4min for
-- hours, confirmed via harness_shared.coord_event_log). This is the SAME
-- architecture class as the EI-2146 / WI-4181 in-memory-dedup bugs this file
-- already carries scar tissue for — applied to a newer piece of state.
--
-- payload shape: { [signature: string]: { fireCount: number, quietSinceMs:
--   number | null, updatedAt: number } } — read+mutated+written once per
-- alarm tick (see readFlapState/writeFlapState in liveness-alarm.ts).
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.operator_liveness_flap_state (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_liveness_flap_state TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.operator_liveness_flap_state TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.operator_liveness_flap_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_liveness_flap_state_workspace_isolation ON harness_shared.operator_liveness_flap_state;
CREATE POLICY operator_liveness_flap_state_workspace_isolation ON harness_shared.operator_liveness_flap_state
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
