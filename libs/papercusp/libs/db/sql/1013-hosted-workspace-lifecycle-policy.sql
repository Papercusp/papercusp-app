-- Migration 1013 — hosted workspace lifecycle admission, policy, and recovery (P-040 / D-146).
--
-- Expand-only and idempotent. The canonical customer_workspaces directory remains the tenant
-- policy boundary and workspace_host_operations remains the only durable lifecycle-job ledger.
-- DBOS executes/replays jobs but does not become a second source of queue truth.
--
-- FORWARD-COMPAT: every constraint dropped below is net-new to this still-unapplied migration
-- and is recreated under the same name in the same runner-owned transaction, so the deployed
-- release can never observe a constraint-free schema. Existing writers omit all new columns;
-- their nullable definitions or legacy-safe defaults satisfy the new foreign-key/check shapes.

ALTER TABLE harness_shared.customer_workspaces
  ADD COLUMN IF NOT EXISTS tenant_concurrency_limit INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS provider_concurrency_limit INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS monthly_lifecycle_budget_cents BIGINT,
  ADD COLUMN IF NOT EXISTS lifecycle_budget_period_started_at TIMESTAMPTZ
    NOT NULL DEFAULT date_trunc('month', now()),
  ADD COLUMN IF NOT EXISTS billing_owner_kind TEXT,
  ADD COLUMN IF NOT EXISTS billing_owner_id TEXT,
  ADD COLUMN IF NOT EXISTS idle_stop_after_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lifecycle_policy_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE harness_shared.customer_workspaces
  DROP CONSTRAINT IF EXISTS customer_workspaces_tenant_concurrency_ck,
  ADD CONSTRAINT customer_workspaces_tenant_concurrency_ck
    CHECK (tenant_concurrency_limit > 0),
  DROP CONSTRAINT IF EXISTS customer_workspaces_provider_concurrency_ck,
  ADD CONSTRAINT customer_workspaces_provider_concurrency_ck
    CHECK (provider_concurrency_limit > 0),
  DROP CONSTRAINT IF EXISTS customer_workspaces_lifecycle_budget_ck,
  ADD CONSTRAINT customer_workspaces_lifecycle_budget_ck
    CHECK (monthly_lifecycle_budget_cents IS NULL OR monthly_lifecycle_budget_cents >= 0),
  DROP CONSTRAINT IF EXISTS customer_workspaces_billing_owner_ck,
  ADD CONSTRAINT customer_workspaces_billing_owner_ck
    CHECK (
      (billing_owner_kind IS NULL AND billing_owner_id IS NULL)
      OR (
        billing_owner_kind IN ('organization', 'customer', 'platform')
        AND btrim(billing_owner_id) <> ''
      )
    ),
  DROP CONSTRAINT IF EXISTS customer_workspaces_idle_stop_ck,
  ADD CONSTRAINT customer_workspaces_idle_stop_ck
    CHECK (idle_stop_after_minutes IS NULL OR idle_stop_after_minutes > 0);

ALTER TABLE harness_shared.workspace_host_operations
  ADD COLUMN IF NOT EXISTS organization_id TEXT,
  ADD COLUMN IF NOT EXISTS customer_workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_target TEXT,
  ADD COLUMN IF NOT EXISTS estimated_cost_cents BIGINT,
  ADD COLUMN IF NOT EXISTS cost_currency TEXT,
  ADD COLUMN IF NOT EXISTS cost_estimate_source TEXT,
  ADD COLUMN IF NOT EXISTS cost_estimate_ref TEXT,
  ADD COLUMN IF NOT EXISTS cost_estimated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billing_owner_kind TEXT,
  ADD COLUMN IF NOT EXISTS billing_owner_id TEXT,
  ADD COLUMN IF NOT EXISTS risk_tier TEXT,
  ADD COLUMN IF NOT EXISTS approval_status TEXT,
  ADD COLUMN IF NOT EXISTS approved_by_principal_id TEXT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_state TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS orphaned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS emergency_teardown BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS teardown_reason TEXT,
  ADD COLUMN IF NOT EXISTS owner_notification_dedupe_key TEXT;

ALTER TABLE harness_shared.workspace_host_operations
  DROP CONSTRAINT IF EXISTS workspace_host_operations_customer_workspace_fk,
  ADD CONSTRAINT workspace_host_operations_customer_workspace_fk
    FOREIGN KEY (workspace_id, organization_id, customer_workspace_id)
    REFERENCES harness_shared.customer_workspaces (workspace_id, organization_id, id),
  DROP CONSTRAINT IF EXISTS workspace_host_operations_tenant_identity_ck,
  ADD CONSTRAINT workspace_host_operations_tenant_identity_ck
    CHECK (
      (organization_id IS NULL AND customer_workspace_id IS NULL AND provider_target IS NULL)
      OR (
        btrim(organization_id) <> ''
        AND btrim(customer_workspace_id) <> ''
        AND btrim(provider_target) <> ''
      )
    ),
  DROP CONSTRAINT IF EXISTS workspace_host_operations_cost_provenance_ck,
  ADD CONSTRAINT workspace_host_operations_cost_provenance_ck
    CHECK (
      (
        estimated_cost_cents IS NULL
        AND cost_currency IS NULL
        AND cost_estimate_source IS NULL
        AND cost_estimate_ref IS NULL
        AND cost_estimated_at IS NULL
      )
      OR (
        estimated_cost_cents >= 0
        AND cost_currency ~ '^[A-Z]{3}$'
        AND btrim(cost_estimate_source) <> ''
        AND btrim(cost_estimate_ref) <> ''
        AND cost_estimated_at IS NOT NULL
      )
    ),
  DROP CONSTRAINT IF EXISTS workspace_host_operations_billing_owner_ck,
  ADD CONSTRAINT workspace_host_operations_billing_owner_ck
    CHECK (
      (billing_owner_kind IS NULL AND billing_owner_id IS NULL)
      OR (
        billing_owner_kind IN ('organization', 'customer', 'platform')
        AND btrim(billing_owner_id) <> ''
      )
    ),
  DROP CONSTRAINT IF EXISTS workspace_host_operations_risk_ck,
  ADD CONSTRAINT workspace_host_operations_risk_ck
    CHECK (risk_tier IS NULL OR risk_tier IN ('low', 'moderate', 'high', 'critical')),
  DROP CONSTRAINT IF EXISTS workspace_host_operations_approval_ck,
  ADD CONSTRAINT workspace_host_operations_approval_ck
    CHECK (
      approval_status IS NULL
      OR (
        approval_status IN ('not-required', 'pending', 'approved', 'rejected')
        AND (
          (approval_status = 'approved' AND approved_by_principal_id IS NOT NULL AND approved_at IS NOT NULL)
          OR (approval_status <> 'approved' AND approved_by_principal_id IS NULL AND approved_at IS NULL)
        )
      )
    ),
  DROP CONSTRAINT IF EXISTS workspace_host_operations_recovery_ck,
  ADD CONSTRAINT workspace_host_operations_recovery_ck
    CHECK (
      recovery_state IN ('none', 'stuck', 'recovery-pending', 'recovering', 'orphaned', 'exhausted')
      AND recovery_attempts >= 0
      AND ((recovery_state = 'orphaned') = (orphaned_at IS NOT NULL))
    ),
  DROP CONSTRAINT IF EXISTS workspace_host_operations_emergency_teardown_ck,
  ADD CONSTRAINT workspace_host_operations_emergency_teardown_ck
    CHECK (
      NOT emergency_teardown
      OR (
        action = 'destroy'
        AND btrim(teardown_reason) <> ''
        AND organization_id IS NOT NULL
        AND customer_workspace_id IS NOT NULL
        AND billing_owner_kind IS NOT NULL
        AND billing_owner_id IS NOT NULL
      )
    );

CREATE INDEX IF NOT EXISTS workspace_host_operations_tenant_admission_idx
  ON harness_shared.workspace_host_operations
    (workspace_id, customer_workspace_id, status, updated_at, id)
  WHERE customer_workspace_id IS NOT NULL AND status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS workspace_host_operations_provider_admission_idx
  ON harness_shared.workspace_host_operations
    (workspace_id, provider_target, status, updated_at, id)
  WHERE provider_target IS NOT NULL AND status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS workspace_host_operations_recovery_idx
  ON harness_shared.workspace_host_operations
    (workspace_id, recovery_state, heartbeat_at, updated_at, id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS workspace_host_operations_budget_idx
  ON harness_shared.workspace_host_operations
    (workspace_id, customer_workspace_id, created_at, estimated_cost_cents)
  WHERE customer_workspace_id IS NOT NULL AND estimated_cost_cents IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_workspaces_idle_stop_idx
  ON harness_shared.customer_workspaces
    (workspace_id, last_activity_at, id)
  WHERE state = 'active' AND idle_stop_after_minutes IS NOT NULL;

COMMENT ON COLUMN harness_shared.customer_workspaces.monthly_lifecycle_budget_cents IS
  'Papercusp lifecycle-job commitment ceiling for the current billing period; provider billing remains authoritative.';
COMMENT ON COLUMN harness_shared.workspace_host_operations.cost_estimate_ref IS
  'Secret-free immutable evidence reference for the price estimate used at admission time.';
COMMENT ON COLUMN harness_shared.workspace_host_operations.recovery_state IS
  'Controller classification derived from heartbeat age; DBOS recovery acts on this canonical ledger state.';
COMMENT ON COLUMN harness_shared.workspace_host_operations.owner_notification_dedupe_key IS
  'Stable key in the existing attention_notifications ledger for owner-visible lifecycle notices.';
