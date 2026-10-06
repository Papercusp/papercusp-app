/**
 * The production organization binding for hosted delegations: the GCP half (per-org service
 * account, D-397) and the AWS half (per-org IAM role + ExternalId, aws-byoc-gcp-parity D-001)
 * composed into one {@link HostedDelegationOrganization}. The hosted runtime and the first-
 * workspace flow both default to this, so neither cloud can be silently left unbound.
 */
import { awsDelegationOrganization, type HostedAwsAuthDependencies } from './hosted-aws-auth';
import { gcpDelegationOrganization } from './hosted-gcp-auth';
import type { HostedDelegationOrganization } from './hosted-provider-delegation';

export function hostedDelegationOrganization(
  organizationId: string,
  options: { gcp?: Parameters<typeof gcpDelegationOrganization>[1]; aws?: HostedAwsAuthDependencies } = {},
): HostedDelegationOrganization {
  return {
    ...gcpDelegationOrganization(organizationId, options.gcp),
    ...awsDelegationOrganization(organizationId, options.aws),
  };
}
