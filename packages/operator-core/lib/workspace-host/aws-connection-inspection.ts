/**
 * Connection admission for AWS workspace hosts (aws-byoc-gcp-parity-2026-10-01 P-004): the AWS twin of
 * the GCP branch of `inspectWorkspaceHostConnection` in
 * `endpoint-route/routes/workspace-hosts/connection.ts`.
 *
 * GCP admission is "validate the connection, then read the catalog". AWS admission runs the full
 * fail-closed onboarding preflight first (`preflightAwsWorkspaceHostConnection`: caller identity,
 * region, subnet, image, KMS key, IAM permission simulation over
 * `AWS_WORKSPACE_HOST_PERMISSION_ACTIONS` including the SSM session actions, and service quotas),
 * because an AWS connection names customer-owned network, image, key and instance-profile resources
 * that must all be usable before a host can be provisioned into them.
 */
import type {
  WorkspaceHostConnectionValidation,
  WorkspaceHostImage,
  WorkspaceHostProviderConnection,
  WorkspaceHostRegion,
  WorkspaceHostScope,
  WorkspaceHostSize,
} from '@papercusp/deployment-driver';
import {
  AWS_WORKSPACE_HOST_TARGET,
  preflightAwsWorkspaceHostConnection,
  type AwsPartition,
  type AwsWorkspaceHostCredentialSource,
  type AwsWorkspaceHostPreflightClient,
  type AwsWorkspaceHostQuotaRequirement,
  type AwsWorkspaceHostSelection,
} from './aws-connection';
import type { AwsWorkspaceHostSdkClient } from './aws-provider';
import {
  createAwsSdkWorkspaceHostClient,
  type AwsConnectionCredentialSource,
  type AwsSdkWorkspaceHostClientOptions,
} from './aws-sdk-client';

/**
 * The quota floor checked when an AWS connection is admitted. One on-demand standard-family vCPU
 * quota (`L-1216C47A`, "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances", counted in
 * vCPUs) at the smallest workspace-host size: an account below it cannot launch any host at all.
 * Per-size headroom is a provisioning-time check, not an admission one.
 */
export const AWS_WORKSPACE_HOST_ADMISSION_QUOTAS: readonly AwsWorkspaceHostQuotaRequirement[] = [
  {
    serviceCode: 'ec2',
    quotaCode: 'L-1216C47A',
    minimumValue: 2,
    label: 'Running On-Demand Standard instances (vCPUs)',
  },
];

export type AwsConnectionInspectionClient = Pick<
  AwsWorkspaceHostSdkClient,
  'listScopes' | 'listRegions' | 'listSizes' | 'listImages'
> & {
  preflight(): AwsWorkspaceHostPreflightClient;
};

export type ConfiguredAwsWorkspaceHostClientOptions = Omit<AwsSdkWorkspaceHostClientOptions, 'connection'>;

export interface AwsConnectionInspection {
  validation: WorkspaceHostConnectionValidation;
  scopes: readonly WorkspaceHostScope[];
  regions: readonly WorkspaceHostRegion[];
  sizes: readonly WorkspaceHostSize[];
  images: readonly WorkspaceHostImage[];
}

function credentialSourceOf(connection: WorkspaceHostProviderConnection): AwsWorkspaceHostCredentialSource | undefined {
  const source = connection.provider?.credentialSource;
  return source && typeof source === 'object' ? (source as AwsWorkspaceHostCredentialSource) : undefined;
}

/**
 * Compose the SDK v3 client for one AWS connection, failing CLOSED at composition time: a hosted
 * customer-role source needs an ExternalId resolver (D-001) and a hosted OIDC source needs a
 * web-identity token minter. Without them every call would fail later with a less specific error.
 */
export function createConfiguredAwsWorkspaceHostClient(
  connection: WorkspaceHostProviderConnection,
  options: ConfiguredAwsWorkspaceHostClientOptions = {},
): AwsConnectionInspectionClient & AwsWorkspaceHostSdkClient & AwsConnectionCredentialSource {
  if (connection.target !== AWS_WORKSPACE_HOST_TARGET) {
    throw new Error(`AWS workspace-host provider cannot compose target '${connection.target}'`);
  }
  const source = credentialSourceOf(connection);
  if (!source) throw new Error('aws_workspace_host_credential_source_required');
  if (source.environment === 'hosted' && source.method === 'customer-role' && !options.resolveExternalId) {
    throw new Error('aws_workspace_host_external_id_resolver_required');
  }
  if (source.environment === 'hosted' && source.method === 'oidc' && !options.getWebIdentityToken) {
    throw new Error('aws_workspace_host_web_identity_token_source_required');
  }
  return createAwsSdkWorkspaceHostClient({ ...options, connection });
}

function stringField(provider: Record<string, unknown>, key: string): string {
  const value = provider[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`aws_workspace_host_connection_field_missing:${key}`);
  }
  return value;
}

/** Rebuild the preflight selection from a persisted AWS connection (see `buildAwsWorkspaceHostProviderConnection`). */
export function awsSelectionFromConnection(connection: WorkspaceHostProviderConnection): AwsWorkspaceHostSelection {
  const provider = (connection.provider ?? {}) as Record<string, unknown>;
  const accountId = connection.scope?.id;
  if (!accountId) throw new Error('aws_workspace_host_connection_field_missing:accountId');
  return {
    accountId,
    partition: stringField(provider, 'partition') as AwsPartition,
    region: stringField(provider, 'region'),
    subnetId: stringField(provider, 'subnetId'),
    imageId: stringField(provider, 'imageId'),
    kmsKeyArn: stringField(provider, 'kmsKeyArn'),
    instanceProfileArn: stringField(provider, 'instanceProfileArn'),
    quotas: AWS_WORKSPACE_HOST_ADMISSION_QUOTAS,
  };
}

function failed(validation: WorkspaceHostConnectionValidation): AwsConnectionInspection {
  return { validation, scopes: [], regions: [], sizes: [], images: [] };
}

/**
 * Read-only admission of one AWS connection: preflight, then (only when it passes) the catalog the
 * Cloud Workspaces UI offers. Every preflight issue becomes one validation error carrying its
 * remediation, so the stored connection status reflects the preflight verdict.
 */
export async function inspectAwsWorkspaceHostConnection(
  input: { connection: WorkspaceHostProviderConnection; now?: () => string },
  createClient: (connection: WorkspaceHostProviderConnection) => AwsConnectionInspectionClient =
    createConfiguredAwsWorkspaceHostClient,
): Promise<AwsConnectionInspection> {
  const { connection } = input;
  const credentialSource = credentialSourceOf(connection);
  if (!credentialSource) throw new Error('aws_workspace_host_credential_source_required');
  const selection = awsSelectionFromConnection(connection);
  const client = createClient(connection);
  const report = await preflightAwsWorkspaceHostConnection(
    {
      cloudCredentialRef: connection.cloudCredentialRef,
      credentialSource,
      selection,
      ...(input.now ? { now: input.now } : {}),
    },
    client.preflight(),
  );
  const identity = report.identity?.arn;
  if (!report.ok) {
    return failed({
      ok: false,
      checkedAt: report.checkedAt,
      ...(identity ? { identity } : {}),
      warnings: [],
      errors: report.issues.map((issue) => `${issue.message} ${issue.remediation}`),
    });
  }

  const validation: WorkspaceHostConnectionValidation = {
    ok: true,
    checkedAt: report.checkedAt,
    ...(identity ? { identity } : {}),
    warnings: [],
    errors: [],
  };
  const scopes = await client.listScopes(connection);
  const scope = scopes[0];
  if (!scope) {
    return failed({ ...validation, ok: false, errors: ['AWS preflight passed but no account scope was returned.'] });
  }
  const regions = await client.listRegions({ scope, region: selection.region }, connection);
  const query = { scope, region: selection.region };
  const [sizes, images] = await Promise.all([
    client.listSizes(query, connection),
    client.listImages(query, connection),
  ]);
  return { validation, scopes, regions, sizes, images };
}
