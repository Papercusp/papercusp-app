/**
 * Production composition of the AWS workspace-host provider (aws-byoc-gcp-parity-2026-10-01 P-003):
 * the AWS twin of `createConfiguredGcpWorkspaceHostProvider`. `lib/dbos/bootstrap.ts` registers it
 * as the `'aws'` workspace-host provider factory, so every provision / lifecycle / destroy path that
 * resolves a provider for an AWS connection gets the real SDK v3 client
 * (`createAwsSdkWorkspaceHostClient`) and the same teardown-obligation observers as GCP.
 *
 * Kept in its own module so `aws-provider.ts` (the provider logic, unit-tested against an injected
 * client seam) never imports the AWS SDK.
 */
import type { WorkspaceHostProviderConnection } from '@papercusp/deployment-driver';
import { AWS_WORKSPACE_HOST_TARGET, type AwsWorkspaceHostCredentialSource } from './aws-connection';
import { AwsWorkspaceHostProvider } from './aws-provider';
import { createAwsSdkWorkspaceHostClient, type AwsSdkWorkspaceHostClientOptions } from './aws-sdk-client';
import type { WorkspaceHostResourceCreatedObserver, WorkspaceHostResourceDestroyedObserver } from './gcp-provider';
import type { HostedProviderDelegationRecord } from './hosted-provider-delegation';

export type ConfiguredAwsWorkspaceHostProviderOptions = Omit<AwsSdkWorkspaceHostClientOptions, 'connection'> & {
  onResourceCreated?: WorkspaceHostResourceCreatedObserver;
  onResourceDestroyed?: WorkspaceHostResourceDestroyedObserver;
};

function credentialSourceOf(connection: WorkspaceHostProviderConnection): AwsWorkspaceHostCredentialSource | undefined {
  const source = connection.provider?.credentialSource;
  return source && typeof source === 'object' ? (source as AwsWorkspaceHostCredentialSource) : undefined;
}

/**
 * A hosted customer role acts only through a VERIFIED delegation for that same role
 * (aws-byoc-gcp-parity P-008, D-007). This is where a revocation takes effect: revoking flips the
 * stored record off `verified`, so the next provider resolution for the connection refuses —
 * the AWS twin of `gcp_workspace_host_hosted_delegation_not_verified` in hosted-gcp-auth.ts.
 */
function assertVerifiedHostedDelegation(connection: WorkspaceHostProviderConnection, roleArn: string): void {
  const value = connection.provider?.hostedDelegation as Partial<HostedProviderDelegationRecord> | undefined;
  if (!value || typeof value !== 'object' || value.schemaVersion !== 'hosted-provider-delegation-v1') {
    throw new Error('aws_workspace_host_hosted_delegation_metadata_missing');
  }
  if (value.provider !== 'aws' || value.configuration?.provider !== 'aws') {
    throw new Error('aws_workspace_host_hosted_delegation_provider_mismatch');
  }
  const delegated = value.configuration.source;
  if (delegated.environment !== 'hosted' || delegated.method !== 'customer-role' || delegated.roleArn !== roleArn) {
    throw new Error('aws_workspace_host_hosted_delegation_source_mismatch');
  }
  if (value.status !== 'verified') throw new Error('aws_workspace_host_hosted_delegation_not_verified');
}

/**
 * Compose an `AwsWorkspaceHostProvider` for one persisted AWS connection.
 *
 * Fails CLOSED at composition time, the way the GCP factory refuses a hosted credential with no
 * hosted auth resolver: a hosted customer-role source needs an ExternalId resolver (D-001) and a
 * hosted OIDC source needs a web-identity token minter. Without them every call would fail later,
 * mid-operation, with a less specific error.
 */
export function createConfiguredAwsWorkspaceHostProvider(
  connection: WorkspaceHostProviderConnection,
  options: ConfiguredAwsWorkspaceHostProviderOptions = {},
): AwsWorkspaceHostProvider {
  if (connection.target !== AWS_WORKSPACE_HOST_TARGET) {
    throw new Error(`AWS workspace-host provider cannot compose target '${connection.target}'`);
  }
  const source = credentialSourceOf(connection);
  if (!source) throw new Error('aws_workspace_host_credential_source_required');
  if (source.environment === 'hosted' && source.method === 'customer-role') {
    if (!options.resolveExternalId) throw new Error('aws_workspace_host_external_id_resolver_required');
    assertVerifiedHostedDelegation(connection, source.roleArn);
  }
  if (source.environment === 'hosted' && source.method === 'oidc' && !options.getWebIdentityToken) {
    throw new Error('aws_workspace_host_web_identity_token_source_required');
  }
  const { onResourceCreated, onResourceDestroyed, ...clientOptions } = options;
  return new AwsWorkspaceHostProvider(createAwsSdkWorkspaceHostClient({ ...clientOptions, connection }), {
    now: clientOptions.now,
    onResourceCreated,
    onResourceDestroyed,
  });
}
