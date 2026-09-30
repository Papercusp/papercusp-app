-- 1127-workspace-host-domain-contracts.sql — P-312 / D-295.
--
-- Extend the existing workspace-host registry with explicit domain/control state. workspace_id
-- remains the stable Workspace/data identity; workspace_hosts.id remains the replaceable Host.
-- This is expand-only so the prior release can continue writing while the new controller rolls out.

ALTER TABLE harness_shared.workspace_host_connections
  ADD COLUMN IF NOT EXISTS authenticated_identity TEXT;

ALTER TABLE harness_shared.workspace_hosts
  ADD COLUMN IF NOT EXISTS host_generation BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS desired_revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS observed_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS runtime_release JSONB,
  ADD COLUMN IF NOT EXISTS controller_id TEXT,
  ADD COLUMN IF NOT EXISTS controller_fence BIGINT NOT NULL DEFAULT 0;

ALTER TABLE harness_shared.workspace_host_operations
  ADD COLUMN IF NOT EXISTS desired_revision BIGINT,
  ADD COLUMN IF NOT EXISTS controller_id TEXT,
  ADD COLUMN IF NOT EXISTS controller_fence BIGINT;

DO $workspace_host_domain_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_host_connections_authenticated_identity_ck'
      AND conrelid = 'harness_shared.workspace_host_connections'::regclass
  ) THEN
    ALTER TABLE harness_shared.workspace_host_connections
      ADD CONSTRAINT workspace_host_connections_authenticated_identity_ck CHECK (
        authenticated_identity IS NULL OR btrim(authenticated_identity) <> ''
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_hosts_host_generation_ck'
      AND conrelid = 'harness_shared.workspace_hosts'::regclass
  ) THEN
    ALTER TABLE harness_shared.workspace_hosts
      ADD CONSTRAINT workspace_hosts_host_generation_ck CHECK (host_generation > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_hosts_revision_ck'
      AND conrelid = 'harness_shared.workspace_hosts'::regclass
  ) THEN
    ALTER TABLE harness_shared.workspace_hosts
      ADD CONSTRAINT workspace_hosts_revision_ck CHECK (
        desired_revision > 0 AND observed_revision >= 0 AND observed_revision <= desired_revision
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_hosts_runtime_release_ck'
      AND conrelid = 'harness_shared.workspace_hosts'::regclass
  ) THEN
    ALTER TABLE harness_shared.workspace_hosts
      ADD CONSTRAINT workspace_hosts_runtime_release_ck CHECK (
        runtime_release IS NULL OR (
          jsonb_typeof(runtime_release) = 'object'
          AND runtime_release ?& ARRAY[
            'version', 'bundleSha256', 'signingKeySha256', 'protocolVersion', 'schemaVersion'
          ]
          AND runtime_release - ARRAY[
            'version', 'bundleSha256', 'signingKeySha256', 'protocolVersion', 'schemaVersion'
          ] = '{}'::jsonb
          AND jsonb_typeof(runtime_release->'version') = 'string'
          AND btrim(runtime_release->>'version') <> ''
          AND jsonb_typeof(runtime_release->'bundleSha256') = 'string'
          AND runtime_release->>'bundleSha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof(runtime_release->'signingKeySha256') = 'string'
          AND runtime_release->>'signingKeySha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof(runtime_release->'protocolVersion') = 'string'
          AND btrim(runtime_release->>'protocolVersion') <> ''
          AND jsonb_typeof(runtime_release->'schemaVersion') = 'string'
          AND btrim(runtime_release->>'schemaVersion') <> ''
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_hosts_controller_authority_ck'
      AND conrelid = 'harness_shared.workspace_hosts'::regclass
  ) THEN
    ALTER TABLE harness_shared.workspace_hosts
      ADD CONSTRAINT workspace_hosts_controller_authority_ck CHECK (
        (controller_id IS NULL AND controller_fence = 0)
        OR (controller_id IS NOT NULL AND btrim(controller_id) <> '' AND controller_fence > 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_host_operations_domain_revision_ck'
      AND conrelid = 'harness_shared.workspace_host_operations'::regclass
  ) THEN
    ALTER TABLE harness_shared.workspace_host_operations
      ADD CONSTRAINT workspace_host_operations_domain_revision_ck CHECK (
        desired_revision IS NULL OR desired_revision > 0
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_host_operations_controller_authority_ck'
      AND conrelid = 'harness_shared.workspace_host_operations'::regclass
  ) THEN
    ALTER TABLE harness_shared.workspace_host_operations
      ADD CONSTRAINT workspace_host_operations_controller_authority_ck CHECK (
        (controller_id IS NULL AND controller_fence IS NULL)
        OR (
          controller_id IS NOT NULL
          AND controller_fence IS NOT NULL
          AND btrim(controller_id) <> ''
          AND controller_fence > 0
          AND desired_revision IS NOT NULL
          AND desired_revision > 0
        )
      );
  END IF;
END
$workspace_host_domain_constraints$;

COMMENT ON COLUMN harness_shared.workspace_host_connections.authenticated_identity IS
  'Non-secret provider identity proved by the latest successful connection validation.';
COMMENT ON COLUMN harness_shared.workspace_hosts.host_generation IS
  'Monotonic Host replacement generation within stable workspace_id; a replacement uses a new id.';
COMMENT ON COLUMN harness_shared.workspace_hosts.desired_revision IS
  'Monotonic desired-state revision assigned when controller authority begins an operation.';
COMMENT ON COLUMN harness_shared.workspace_hosts.observed_revision IS
  'Highest desired revision confirmed by a fenced provider observation; never exceeds desired_revision.';
COMMENT ON COLUMN harness_shared.workspace_hosts.runtime_release IS
  'Closed URL/key-free signed RuntimeRelease identity plus protocol/schema compatibility.';
COMMENT ON COLUMN harness_shared.workspace_hosts.controller_id IS
  'Controller identity currently authorized to mutate this Host; meaningful only with controller_fence.';
COMMENT ON COLUMN harness_shared.workspace_hosts.controller_fence IS
  'Monotonic controller fencing token paired with controller_id.';
COMMENT ON COLUMN harness_shared.workspace_host_operations.desired_revision IS
  'Host desired revision governed by this lifecycle operation.';
COMMENT ON COLUMN harness_shared.workspace_host_operations.controller_id IS
  'Controller identity that acquired authority for this operation.';
COMMENT ON COLUMN harness_shared.workspace_host_operations.controller_fence IS
  'Controller fencing token captured when this operation acquired authority.';
