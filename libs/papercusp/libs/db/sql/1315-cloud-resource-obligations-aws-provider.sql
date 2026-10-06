-- aws-byoc-gcp-parity-2026-10-01 P-003 (WI-10005027): the teardown-obligation ledger accepts AWS.
--
-- Migration 1040 created cloud_resource_obligations with CHECK (provider IN ('gcp')), so an AWS
-- EC2 instance or EBS volume could never be recorded and an AWS leak would be invisible to the
-- overdue-teardown sweep. This widens the provider CHECK to the set the TypeScript writer accepts
-- (CLOUD_RESOURCE_OBLIGATION_PROVIDERS in packages/operator-core/lib/workspace-host/
-- cloud-resource-obligations.ts). project_id holds the AWS account id for an 'aws' row.
--
-- FORWARD-COMPAT: the currently deployed release only ever writes provider 'gcp', which the widened constraint still accepts, and it never reads the constraint, so dropping and re-adding it under a wider predicate cannot break live code.

ALTER TABLE harness_shared.cloud_resource_obligations
  DROP CONSTRAINT IF EXISTS cloud_resource_obligations_provider_check;

ALTER TABLE harness_shared.cloud_resource_obligations
  ADD CONSTRAINT cloud_resource_obligations_provider_check CHECK (provider IN ('gcp', 'aws'));
