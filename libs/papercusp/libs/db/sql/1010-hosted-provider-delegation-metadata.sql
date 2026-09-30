-- 1010-hosted-provider-delegation-metadata.sql — WI-40507 / P-038.
--
-- Persist the non-secret provider metadata needed to resolve hosted workload/
-- federated identities. Credential material remains outside this table; only
-- its opaque resolver reference is stored in credential_ref.

ALTER TABLE harness_shared.workspace_host_connections
  ADD COLUMN IF NOT EXISTS provider_config JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $provider_config_object_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'harness_shared.workspace_host_connections'::regclass
      AND conname = 'workspace_host_connections_provider_config_check'
  ) THEN
    ALTER TABLE harness_shared.workspace_host_connections
      ADD CONSTRAINT workspace_host_connections_provider_config_check
      CHECK (jsonb_typeof(provider_config) = 'object');
  END IF;
END
$provider_config_object_check$;

COMMENT ON COLUMN harness_shared.workspace_host_connections.provider_config IS
  'Non-secret provider metadata for local or hosted delegated auth; credential material is resolver-owned.';
