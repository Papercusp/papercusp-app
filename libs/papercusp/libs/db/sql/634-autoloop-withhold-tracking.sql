-- EI-14483: a fire-gate (backoff/circuit-open) withhold in fireLoopWake/checkFireGate
-- returns early WITHOUT ever calling recordFire, so harness_shared.autoloop_state's
-- last_fired_at/last_status is left untouched — a routine silently denied every tick
-- for hours leaves ZERO durable trace distinguishable from "hasn't been attempted".
-- (Root-caused on the fleet-leader loop went-silent investigation: the DBOS
-- routineFire workflow kept invoking fireLoopWake every ~3-6min the whole "silent"
-- window — it was ATTEMPTED, not un-scheduled — but nothing durable recorded that,
-- only an ephemeral console.warn.) These columns are a SEPARATE write target from
-- last_fired_at/consecutive_errors (the backoff clock) so recording a withhold can
-- never perturb the backoff timer itself — that's the whole point of not touching
-- last_fired_at on a mere gate check.
ALTER TABLE harness_shared.autoloop_state ADD COLUMN IF NOT EXISTS last_withheld_at timestamp with time zone;
ALTER TABLE harness_shared.autoloop_state ADD COLUMN IF NOT EXISTS last_withheld_reason text;
ALTER TABLE harness_shared.autoloop_state ADD COLUMN IF NOT EXISTS last_withheld_detail text;
