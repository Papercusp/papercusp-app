-- 012-resource-max-holders.sql — counting-semaphore capacity on named resources.
-- Plan: locks-correctness-hardening-2026-06-04 (D-008). Runs against papercusp_su. Idempotent.
--
-- A real gap sat between binary `exclusive` (N=1) and unbounded `shared` (N=∞):
-- "≤2 agents run the test suite", "≤1 migration but ≤3 readers". A counting
-- semaphore fills it. `max_holders` on a resource is its shared capacity: a NEW
-- shared acquire is granted only while the live distinct shared holders < N. The
-- grant cascade already counts holders for the drain, so this is just gating the
-- grant on that count. NULL = unbounded (the existing shared behaviour, default).
ALTER TABLE agent_resource_registry
  ADD COLUMN IF NOT EXISTS max_holders int;

-- A capacity must be positive when set.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_resource_registry_max_holders_chk'
  ) THEN
    ALTER TABLE agent_resource_registry
      ADD CONSTRAINT agent_resource_registry_max_holders_chk
      CHECK (max_holders IS NULL OR max_holders > 0);
  END IF;
END;
$do$;
