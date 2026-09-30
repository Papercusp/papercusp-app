-- 956: Persist provisioning intent (WorkspaceHostDesiredSpec) on the host record.
--
-- WHY THIS EXISTS (P-046 / WI-40474)
-- ----------------------------------
-- Initialization is a lifecycle action on an ALREADY-PROVISIONED host, so the controller is
-- handed a hostId and must recover which concrete cloud instance that host is. That derivation
-- (`resolveGcpWorkspaceHostInstanceIdentity`) needs the DESIRED SPEC — target, scope.id
-- (project), region, zone, and any explicit provider.instanceName.
--
-- None of that survives provisioning today. `workspace_hosts` records the host's OBSERVED shape
-- (region, size, image, network) but not the chosen zone, not the project id, and not the
-- provider block; `workspace_host_connections` lists the regions/scopes a connection MAY use,
-- not the ones a given host DID use. So the provisioning intent was unrecoverable, and an
-- initialization keyed on hostId could not name the instance it must SSH to.
--
-- Storing the spec on the host row keeps one writer for one fact: the provisioner records the
-- intent it acted on, and initialization reads back that same intent rather than re-deriving it
-- from partial columns. Re-deriving is the failure this prevents — two independent derivations
-- of an instance name agree in tests and diverge against real cloud, where the only symptom is
-- a tunnel opened to an instance that does not exist.
--
-- EXPAND ONLY. The column is nullable with no default and nothing reads it unconditionally, so
-- the currently-deployed release is unaffected: a host row written before this migration simply
-- has no recorded intent, which the reader reports as an explicit, named gap rather than
-- guessing. No FORWARD-COMPAT acknowledgment is required — this migration drops, renames and
-- tightens nothing.
--
-- SECRETS: `WorkspaceHostDesiredSpec.credentials` holds credential REFERENCES, never credential
-- material, and the writer asserts that invariant (`assertWorkspaceHostSecretIsolation`) before
-- this column is ever written. The CHECK below enforces only the shape; the secret-isolation
-- assertion is the writer's job and is tested there.

ALTER TABLE harness_shared.workspace_hosts
  ADD COLUMN IF NOT EXISTS desired_spec JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspace_hosts_desired_spec_object'
  ) THEN
    ALTER TABLE harness_shared.workspace_hosts
      ADD CONSTRAINT workspace_hosts_desired_spec_object
      CHECK (desired_spec IS NULL OR jsonb_typeof(desired_spec) = 'object');
  END IF;
END $$;

COMMENT ON COLUMN harness_shared.workspace_hosts.desired_spec IS
  'WorkspaceHostDesiredSpec the provisioner acted on: the single recorded source of this host''s '
  'provider identity (target, scope, region, zone, provider block) for later lifecycle actions '
  'such as initialization. Credential REFERENCES only — never credential material.';
