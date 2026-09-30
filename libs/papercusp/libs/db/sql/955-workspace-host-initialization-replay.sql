-- 955: workspace-host initialization replay receipts (P-046 / WI-40474)
--
-- The initialization contract in libs/generic/deployment-driver/src/workspace-host-initialization.ts
-- declares a WorkspaceHostInitializationReplayStore seam whose runOnce() must EITHER return the
-- prior receipt for a completed identity OR own and persist exactly one execution. Until now that
-- seam had no durable implementation, which is why the whole initialization module had zero
-- production callers. This is that store's table.
--
-- FORWARD-COMPAT: the only change to an existing relation WIDENS
-- workspace_host_operations.action to additionally admit 'initialize'. The currently-deployed
-- release never writes that value (initialization has no caller at all today), so replacing the
-- CHECK constraint cannot break code that is still live on :3070. No column or table is dropped,
-- renamed, or tightened, and nothing is SET NOT NULL on existing data.

ALTER TABLE harness_shared.workspace_host_operations
  DROP CONSTRAINT IF EXISTS workspace_host_operations_action_check;

ALTER TABLE harness_shared.workspace_host_operations
  ADD CONSTRAINT workspace_host_operations_action_check
  CHECK (action IN (
    'provision', 'start', 'stop', 'restart', 'snapshot',
    'restore', 'upgrade', 'repair', 'destroy', 'initialize'
  ));

-- One row per initialization step identity. The primary key IS the idempotency key, so
-- concurrent controllers racing the same step collide on INSERT rather than double-executing.
CREATE TABLE IF NOT EXISTS harness_shared.workspace_host_initialization_steps (
  workspace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  host_id TEXT NOT NULL,

  -- Populated from the receipt the closure returns. Deliberately no step_kind column: runOnce()
  -- receives only { idempotencyKey, stepFingerprint } and the receipt carries no kind, so a
  -- step_kind column could never be populated honestly on the replay path.
  step_id TEXT,

  -- SHA-256 over canonical step JSON. Detects same-key/different-input reuse, which must fail
  -- loudly rather than silently returning another step's receipt.
  step_fingerprint TEXT NOT NULL CHECK (step_fingerprint ~ '^[0-9a-f]{64}$'),

  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded')),

  -- In-flight ownership. Exactly one controller holds a live lease; an expired lease is
  -- reclaimable so a crashed controller cannot wedge the step forever.
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,

  observed_at TIMESTAMPTZ,
  public_evidence JSONB
    CHECK (public_evidence IS NULL OR jsonb_typeof(public_evidence) = 'object'),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, idempotency_key),

  CONSTRAINT workspace_host_initialization_steps_host_fk
    FOREIGN KEY (workspace_id, host_id)
    REFERENCES harness_shared.workspace_hosts (workspace_id, id) ON DELETE CASCADE,

  -- A succeeded row is a complete receipt or it is not a receipt at all.
  CONSTRAINT workspace_host_initialization_steps_succeeded_complete
    CHECK (status <> 'succeeded' OR (observed_at IS NOT NULL AND step_id IS NOT NULL)),

  -- A running row must name its lease holder, so ownership is never ambiguous.
  CONSTRAINT workspace_host_initialization_steps_running_leased
    CHECK (status <> 'running' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS workspace_host_initialization_steps_host_idx
  ON harness_shared.workspace_host_initialization_steps (workspace_id, host_id, updated_at DESC);

-- Supports reclaiming leases stranded by a crashed controller.
CREATE INDEX IF NOT EXISTS workspace_host_initialization_steps_stale_lease_idx
  ON harness_shared.workspace_host_initialization_steps (lease_expires_at)
  WHERE status = 'running';

-- Same workspace-isolation posture as the six tables created by migration 887. The store runs
-- through withWorkspace(), i.e. as the RLS-SUBJECT harness_app role, so without this block every
-- read and write on the replay path fails with permission denied.
DO $workspace_host_init_security$
DECLARE
  table_name TEXT := 'workspace_host_initialization_steps';
  policy_name TEXT := 'workspace_host_initialization_steps_workspace_isolation';
BEGIN
  EXECUTE format('ALTER TABLE harness_shared.%I ENABLE ROW LEVEL SECURITY', table_name);
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'harness_shared' AND tablename = table_name AND policyname = policy_name
  ) THEN
    EXECUTE format(
      'CREATE POLICY %I ON harness_shared.%I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      policy_name, table_name
    );
  END IF;
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.%I TO harness_app', table_name);
  BEGIN
    EXECUTE format('GRANT SELECT ON harness_shared.%I TO harness_zero', table_name);
  EXCEPTION WHEN undefined_object THEN NULL;
  END;
END
$workspace_host_init_security$;
