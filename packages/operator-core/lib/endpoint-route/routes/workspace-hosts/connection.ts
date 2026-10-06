/** POST /workspace-hosts/connection — admit, refresh and update one local provider connection. */
import { defineTool } from '@papercusp/agent-mcp';
import {
  assertWorkspaceHostSecretIsolation,
  type WorkspaceHostConnectionValidation,
  type WorkspaceHostImage,
  type WorkspaceHostProviderConnection,
  type WorkspaceHostRegion,
  type WorkspaceHostScope,
  type WorkspaceHostSize,
} from '@papercusp/deployment-driver';
import { activeWorkspaceId } from '../../../workspace-registry';
import { createConfiguredGcpWorkspaceHostProvider } from '../../../workspace-host/gcp-provider';
import { parseGcpBillingExportDescriptor } from '../../../workspace-host/gcp-api-client';
import {
  buildAwsWorkspaceHostProviderConnection,
  planAwsSdkCredentialProvider,
  type AwsPartition,
  type AwsWorkspaceHostCredentialSource,
} from '../../../workspace-host/aws-connection';
import {
  AWS_WORKSPACE_HOST_ADMISSION_QUOTAS,
  inspectAwsWorkspaceHostConnection,
} from '../../../workspace-host/aws-connection-inspection';
import { awsPartitionForRegion } from '../../../workspace-host/aws-sdk-client';
import {
  readWorkspaceHostConnection,
  upsertWorkspaceHostConnection,
  type StoredWorkspaceHostConnection,
  type WorkspaceHostConnectionInput,
} from '../../../workspace-host/observability-store';

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;
const GCP_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const GCP_SERVICE_ACCOUNT = /^[^@\s]+@(?:developer|[^@\s]+\.(?:iam|developer))\.gserviceaccount\.com$/i;

const AWS_ACCOUNT_ID = /^\d{12}$/;
/** Commercial, China, GovCloud and ISO region names: `us-east-2`, `cn-north-1`, `us-gov-west-1`, `us-isob-east-1`. */
const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const AWS_PARTITION_PREFIX = 'arn:aws(?:-[a-z]+)*';
const AWS_ROLE_ARN = new RegExp(`^${AWS_PARTITION_PREFIX}:iam::\\d{12}:role\\/[\\w+=,.@\\/-]{1,512}$`);
const AWS_INSTANCE_PROFILE_ARN = new RegExp(
  `^${AWS_PARTITION_PREFIX}:iam::\\d{12}:instance-profile\\/[\\w+=,.@\\/-]{1,512}$`,
);
const AWS_KMS_KEY_ARN = new RegExp(`^${AWS_PARTITION_PREFIX}:kms:[a-z0-9-]+:\\d{12}:(?:key|alias)\\/[\\w\\/-]{1,256}$`);
const AWS_SUBNET_ID = /^subnet-[0-9a-f]{8,17}$/;
const AWS_IMAGE_ID = /^ami-[0-9a-f]{8,17}$/;
const AWS_PARTITIONS: readonly AwsPartition[] = [
  'aws',
  'aws-cn',
  'aws-us-gov',
  'aws-iso',
  'aws-iso-b',
  'aws-iso-e',
  'aws-iso-f',
];

const SUPPORTED_TARGETS = ['gcp', 'aws'] as const;
type SupportedTarget = (typeof SUPPORTED_TARGETS)[number];
const ACTIONS = ['connect', 'validate-connection', 'update'] as const;
type ConnectionAction = (typeof ACTIONS)[number];

/** Target-specific connection fields, accepted on `connect` and (as overrides of the stored values) on `update`. */
const CONNECTION_FIELDS = [
  'credentialRef',
  // GCP
  'projectId',
  'serviceAccountEmail',
  'billingExport',
  // AWS
  'accountId',
  'partition',
  'region',
  'subnetId',
  'imageId',
  'kmsKeyArn',
  'instanceProfileArn',
  'credentialSource',
  'vpcId',
  'securityGroupIds',
  'launchTemplateId',
] as const;
type ConnectionFields = Partial<Record<(typeof CONNECTION_FIELDS)[number], unknown>>;

export interface WorkspaceHostConnectionInspection {
  validation: WorkspaceHostConnectionValidation;
  scopes: readonly WorkspaceHostScope[];
  regions: readonly WorkspaceHostRegion[];
  sizes: readonly WorkspaceHostSize[];
  images: readonly WorkspaceHostImage[];
}

export interface WorkspaceHostConnectionRouteDependencies {
  activeWorkspaceId: () => string;
  readConnection: (workspaceId: string, connectionId: string) => Promise<StoredWorkspaceHostConnection | null>;
  upsertConnection: (input: WorkspaceHostConnectionInput) => Promise<void>;
  inspectConnection: (input: {
    workspaceId: string;
    connectionId: string;
    connection: WorkspaceHostProviderConnection;
  }) => Promise<WorkspaceHostConnectionInspection>;
}

type Parsed = { ok: true; connection: WorkspaceHostProviderConnection } | { ok: false; response: Response };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSupportedTarget(value: string): value is SupportedTarget {
  return (SUPPORTED_TARGETS as readonly string[]).includes(value);
}

function isAction(value: string): value is ConnectionAction {
  return (ACTIONS as readonly string[]).includes(value);
}

function requestError(error: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error, message: error, ...extra }, { status });
}

function refused(error: string, extra: Record<string, unknown> = {}): Parsed {
  return { ok: false, response: requestError(error, 400, extra) };
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeConnectionProblem(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code.includes('service_account_key_forbidden')) {
    return 'Service-account key ADC is forbidden; use authorized-user or impersonated ADC.';
  }
  if (code.includes('cloud_credential_ref_unsupported')) {
    return 'GCP credential reference must use adc://default or gcloud://active-user.';
  }
  if (
    code.includes('hosted_auth_resolver_required') ||
    code.includes('external_id_resolver_required') ||
    code.includes('web_identity_token_source_required')
  ) {
    return 'Hosted credential references are unavailable on the local control plane.';
  }
  if (code.includes('aws_workspace_host_credential_source_required')) {
    return 'AWS connection has no credential source; reconnect it with one.';
  }
  if (code.includes('aws_workspace_host_connection_field_missing')) {
    return 'AWS connection is missing a required resource field; reconnect it.';
  }
  return 'Provider connection validation failed.';
}

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export function workspaceHostConnectionId(target: string, label: string): string {
  return `${target}:${slug(label) || 'connection'}`;
}

function parseCredentialRef(fields: ConnectionFields): string | null {
  const credentialRef = trimmed(fields.credentialRef);
  return credentialRef && credentialRef.length <= 500 ? credentialRef : null;
}

function parseGcpConnection(fields: ConnectionFields): Parsed {
  const credentialRef = parseCredentialRef(fields);
  if (!credentialRef) return refused('credentialRef must be a non-empty reference');
  const projectId = trimmed(fields.projectId);
  const serviceAccountEmail = trimmed(fields.serviceAccountEmail);
  if (!GCP_PROJECT_ID.test(projectId)) return refused('invalid GCP projectId');
  if (!GCP_SERVICE_ACCOUNT.test(serviceAccountEmail)) return refused('invalid GCP runtime serviceAccountEmail');
  let billingExport;
  if (fields.billingExport !== undefined) {
    try {
      billingExport = parseGcpBillingExportDescriptor(fields.billingExport);
    } catch {
      return refused('invalid GCP billingExport descriptor');
    }
  }
  return {
    ok: true,
    connection: {
      target: 'gcp',
      cloudCredentialRef: { kind: 'cloud', ref: credentialRef },
      scope: { kind: 'project', id: projectId },
      provider: { projectId, serviceAccountEmail, ...(billingExport ? { billingExport } : {}) },
    },
  };
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize the caller's credential source to exactly the fields its method uses, refusing a role
 * ARN that is not an IAM role ARN with a NAMED error. Unknown keys are dropped rather than stored;
 * secret-shaped keys are refused by `planAwsSdkCredentialProvider`'s secret-isolation assertion,
 * which runs on the raw input before this normalization.
 */
function normalizeAwsCredentialSource(raw: Record<string, unknown>): AwsWorkspaceHostCredentialSource | string {
  const environment = raw.environment;
  const method = raw.method;
  const roleArn = optionalString(raw, 'roleArn');
  const roleSessionName = optionalString(raw, 'roleSessionName');
  const withSession = roleSessionName !== undefined ? { roleSessionName } : {};
  const needsRole = method === 'assume-role' || method === 'customer-role' || method === 'oidc';
  if (needsRole && !AWS_ROLE_ARN.test(roleArn ?? '')) return 'invalid AWS roleArn';

  if (environment === 'local' && method === 'default-chain') return { environment, method };
  if (environment === 'local' && method === 'shared-profile') {
    return { environment, method, profile: optionalString(raw, 'profile') ?? '' };
  }
  if (environment === 'local' && method === 'assume-role') {
    const sourceProfile = optionalString(raw, 'sourceProfile');
    const externalIdRef = optionalString(raw, 'externalIdRef');
    return {
      environment,
      method,
      roleArn: roleArn!,
      ...(sourceProfile !== undefined ? { sourceProfile } : {}),
      ...(externalIdRef !== undefined ? { externalIdRef } : {}),
      ...withSession,
    };
  }
  if (environment === 'hosted' && method === 'customer-role') {
    const trustedPrincipalArn = optionalString(raw, 'trustedPrincipalArn') ?? '';
    if (!AWS_ROLE_ARN.test(trustedPrincipalArn)) return 'invalid AWS trustedPrincipalArn';
    return {
      environment,
      method,
      roleArn: roleArn!,
      trustedPrincipalArn,
      externalIdRef: optionalString(raw, 'externalIdRef') ?? '',
      ...withSession,
    };
  }
  if (environment === 'hosted' && method === 'oidc') {
    return {
      environment,
      method,
      roleArn: roleArn!,
      providerArn: optionalString(raw, 'providerArn') ?? '',
      issuer: optionalString(raw, 'issuer') ?? '',
      audience: optionalString(raw, 'audience') ?? '',
      subject: optionalString(raw, 'subject') ?? '',
      ...withSession,
    };
  }
  return 'invalid AWS credentialSource';
}

function parseAwsConnection(fields: ConnectionFields): Parsed {
  const credentialRef = parseCredentialRef(fields);
  if (!credentialRef) return refused('credentialRef must be a non-empty reference');
  const accountId = trimmed(fields.accountId);
  if (!AWS_ACCOUNT_ID.test(accountId)) return refused('invalid AWS accountId');
  const region = trimmed(fields.region);
  if (!AWS_REGION.test(region)) return refused('invalid AWS region');
  let partition: AwsPartition;
  if (fields.partition === undefined) {
    partition = awsPartitionForRegion(region);
  } else {
    const requested = trimmed(fields.partition);
    if (!(AWS_PARTITIONS as readonly string[]).includes(requested)) return refused('invalid AWS partition');
    partition = requested as AwsPartition;
  }
  const subnetId = trimmed(fields.subnetId);
  if (!AWS_SUBNET_ID.test(subnetId)) return refused('invalid AWS subnetId');
  const imageId = trimmed(fields.imageId);
  if (!AWS_IMAGE_ID.test(imageId)) return refused('invalid AWS imageId');
  const kmsKeyArn = trimmed(fields.kmsKeyArn);
  if (!AWS_KMS_KEY_ARN.test(kmsKeyArn)) return refused('invalid AWS kmsKeyArn');
  const instanceProfileArn = trimmed(fields.instanceProfileArn);
  if (!AWS_INSTANCE_PROFILE_ARN.test(instanceProfileArn)) return refused('invalid AWS instanceProfileArn');
  // Preserve legacy admissions; new desktop connections provide the complete launch set.
  const launchResources: Record<string, unknown> = {};
  for (const [key, pattern] of [
    ['vpcId', /^vpc-[0-9a-f]{8,17}$/],
    ['launchTemplateId', /^lt-[0-9a-f]{8,17}$/],
  ] as const) {
    if (fields[key] !== undefined) {
      const value = trimmed(fields[key]);
      if (!pattern.test(value)) return refused(`invalid AWS ${key}`);
      launchResources[key] = value;
    }
  }
  if (fields.securityGroupIds !== undefined) {
    if (!Array.isArray(fields.securityGroupIds) || fields.securityGroupIds.length === 0 ||
        fields.securityGroupIds.some((value) => typeof value !== 'string' || !/^sg-[0-9a-f]{8,17}$/.test(value.trim()))) {
      return refused('invalid AWS securityGroupIds');
    }
    launchResources.securityGroupIds = [...new Set(fields.securityGroupIds.map((value: string) => value.trim()))];
  }
  if (!isRecord(fields.credentialSource)) return refused('invalid AWS credentialSource');
  const credentialSource = normalizeAwsCredentialSource(fields.credentialSource);
  if (typeof credentialSource === 'string') return refused(credentialSource);
  try {
    // On the RAW input, so a smuggled secret field is refused rather than silently dropped by
    // normalization. The thrown message is not echoed: it names the offending field path.
    assertWorkspaceHostSecretIsolation(fields.credentialSource, 'aws.credentialSource');
  } catch {
    return refused('invalid AWS credentialSource: secret material is not accepted; pass a reference');
  }
  try {
    planAwsSdkCredentialProvider(credentialSource);
  } catch (error) {
    return refused('invalid AWS credentialSource', { problems: [error instanceof Error ? error.message : 'invalid'] });
  }

  try {
    const connection = buildAwsWorkspaceHostProviderConnection({
      cloudCredentialRef: { kind: 'cloud', ref: credentialRef },
      credentialSource,
      selection: {
        accountId,
        partition,
        region,
        subnetId,
        imageId,
        kmsKeyArn,
        instanceProfileArn,
        quotas: AWS_WORKSPACE_HOST_ADMISSION_QUOTAS,
      },
    });
    return { ok: true, connection: { ...connection, provider: { ...connection.provider, ...launchResources } } };
  } catch (error) {
    return refused('invalid AWS connection', { problems: [error instanceof Error ? error.message : 'invalid'] });
  }
}

const PARSERS: Record<SupportedTarget, (fields: ConnectionFields) => Parsed> = {
  gcp: parseGcpConnection,
  aws: parseAwsConnection,
};

/** The stored connection, expressed as request fields, so `update` can override a subset. */
function storedConnectionFields(connection: WorkspaceHostProviderConnection): ConnectionFields {
  const provider = (connection.provider ?? {}) as Record<string, unknown>;
  const fields: ConnectionFields = { credentialRef: connection.cloudCredentialRef.ref };
  if (connection.target === 'aws') {
    fields.accountId = connection.scope?.id;
    for (const key of ['partition', 'region', 'subnetId', 'imageId', 'kmsKeyArn', 'instanceProfileArn', 'credentialSource', 'vpcId', 'securityGroupIds', 'launchTemplateId'] as const) {
      fields[key] = provider[key];
    }
  } else {
    for (const key of ['projectId', 'serviceAccountEmail', 'billingExport'] as const) {
      if (provider[key] !== undefined) fields[key] = provider[key];
    }
  }
  return fields;
}

function requestConnectionFields(body: Record<string, unknown>): ConnectionFields {
  const fields: ConnectionFields = {};
  for (const key of CONNECTION_FIELDS) {
    if (body[key] !== undefined) fields[key] = body[key];
  }
  return fields;
}

/**
 * Read-only validation and catalog refresh for one provider connection.
 * GCP: provider validation, then catalog discovery. AWS: the fail-closed onboarding preflight
 * (identity, region, subnet, image, KMS, IAM permission simulation including SSM, quotas), then
 * catalog discovery. Any other target is refused.
 */
export async function inspectWorkspaceHostConnection(input: {
  workspaceId: string;
  connectionId: string;
  connection: WorkspaceHostProviderConnection;
}): Promise<WorkspaceHostConnectionInspection> {
  if (input.connection.target === 'aws') {
    return inspectAwsWorkspaceHostConnection({ connection: input.connection });
  }
  if (input.connection.target !== 'gcp') {
    throw new Error(`workspace_host_connection_target_${input.connection.target}_unsupported`);
  }
  // This provider exists for this inspection only. Catalog discovery makes
  // several REST calls; acquire the same short-lived authority once for them.
  // A later validation creates a new provider and resolves credentials again.
  const provider = createConfiguredGcpWorkspaceHostProvider(input.connection, {
    reuseAuthWithinInstance: true,
  });
  const context = {
    workspaceId: input.workspaceId,
    requestId: `connection:${input.connectionId}`,
    connection: input.connection,
  };
  const validation = await provider.validateConnection(context);
  if (!validation.ok) {
    return { validation, scopes: [], regions: [], sizes: [], images: [] };
  }

  const scopes = await provider.listScopes(context);
  const scope = scopes[0];
  if (!scope) {
    return {
      validation: {
        ok: false,
        checkedAt: validation.checkedAt,
        warnings: validation.warnings,
        errors: ['Provider validation returned no usable project.'],
      },
      scopes: [],
      regions: [],
      sizes: [],
      images: [],
    };
  }
  const regions = await provider.listRegions({ scope }, context);
  const region = regions.find((candidate) => candidate.available) ?? regions[0];
  const query = { scope, ...(region ? { region: region.id } : {}) };
  const [sizes, images] = await Promise.all([provider.listSizes(query, context), provider.listImages(query, context)]);
  return { validation, scopes, regions, sizes, images };
}

const DEFAULT_DEPENDENCIES: WorkspaceHostConnectionRouteDependencies = {
  activeWorkspaceId,
  readConnection: readWorkspaceHostConnection,
  upsertConnection: upsertWorkspaceHostConnection,
  inspectConnection: inspectWorkspaceHostConnection,
};

function connectionNetworks(connection: WorkspaceHostProviderConnection): WorkspaceHostConnectionInput['networks'] {
  if (connection.target === 'aws') {
    // AWS hosts launch into the customer's own subnet, named on the connection and proved usable
    // by preflight; there is no Papercusp-managed network to offer.
    const subnetId = (connection.provider as Record<string, unknown> | undefined)?.subnetId;
    return typeof subnetId === 'string' ? [{ id: subnetId, label: `Subnet ${subnetId}` }] : [];
  }
  // GCP provisioning owns a deterministic private network when selected.
  // Existing-network discovery is intentionally not faked by the provider-neutral contract.
  return [{ id: 'managed', label: 'Papercusp-managed private network' }];
}

function connectionInput(
  workspaceId: string,
  connectionId: string,
  label: string,
  connection: WorkspaceHostProviderConnection,
  inspection: WorkspaceHostConnectionInspection,
): WorkspaceHostConnectionInput {
  const connected = inspection.validation.ok;
  // WI-1743793: a transport-class failure proves nothing about the connection, so it must NOT be
  // recorded as 'invalid' — that verdict is sticky, and every later lifecycle action is refused
  // against a connection that was never actually disproved. 'degraded' says "last inspection could
  // not reach the provider" without condemning it.
  const status = connected ? 'connected' : inspection.validation.retryable ? 'degraded' : 'invalid';
  return {
    workspaceId,
    id: connectionId,
    target: connection.target,
    label,
    credentialRef: connection.cloudCredentialRef.ref,
    provider: connection.provider,
    status,
    ...(connected && inspection.validation.identity?.trim()
      ? { authenticatedIdentity: inspection.validation.identity.trim() }
      : {}),
    statusDetail: connected
      ? inspection.validation.warnings.join('; ') || undefined
      : inspection.validation.errors.join('; ') || 'Provider validation failed.',
    lastValidatedAt: inspection.validation.checkedAt,
    scopes: connected ? inspection.scopes.map(({ kind: _kind, ...scope }) => scope) : [],
    regions: connected
      ? inspection.regions
          .filter((region) => region.available)
          .map(({ id, label: regionLabel, zones }) => ({ id, label: regionLabel, ...(zones?.length ? { zones } : {}) }))
      : [],
    sizes: connected
      ? inspection.sizes
          .filter((size) => size.available)
          .map(({ id, label: sizeLabel, cpuCount, memoryMiB }) => ({
            id,
            label: sizeLabel,
            vcpu: cpuCount,
            memoryGiB: memoryMiB / 1024,
          }))
      : [],
    images: connected
      ? inspection.images
          .filter((image) => !image.deprecated)
          .map(({ id, label: imageLabel, version }) => ({ id, label: imageLabel, ...(version ? { version } : {}) }))
      : [],
    networks: connected ? connectionNetworks(connection) : [],
  };
}

function parseLabel(value: unknown): string | null {
  const label = trimmed(value);
  return label && label.length <= 160 ? label : null;
}

const LABEL_ERROR = 'label must be a non-empty string of at most 160 characters';

export function createWorkspaceHostConnectionRoute(
  dependencies: WorkspaceHostConnectionRouteDependencies = DEFAULT_DEPENDENCIES,
) {
  return defineTool({
    method: 'POST',
    path: '/workspace-hosts/connection',
    auth: 'loopback',
    async handler(req) {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return requestError('invalid json', 400);
      }
      if (!isRecord(body)) return requestError('body must be an object', 400);

      const action = typeof body.action === 'string' ? body.action : '';
      if (!isAction(action)) {
        return requestError('workspace-host connection action is not implemented', 501, {
          action: action || null,
        });
      }

      const workspaceId = dependencies.activeWorkspaceId();
      let connectionId: string;
      let label: string;
      let connection: WorkspaceHostProviderConnection;

      if (action === 'connect') {
        const target = trimmed(body.target);
        if (!isSupportedTarget(target)) {
          return requestError('workspace-host connection target is not implemented', 501, { target: target || null });
        }
        const parsedLabel = parseLabel(body.label);
        if (!parsedLabel) return requestError(LABEL_ERROR, 400);
        label = parsedLabel;
        const parsed = PARSERS[target](requestConnectionFields(body));
        if (!parsed.ok) return parsed.response;
        connectionId = workspaceHostConnectionId(target, label);
        connection = parsed.connection;
      } else {
        connectionId = trimmed(body.connectionId);
        if (!SAFE_ID.test(connectionId)) return requestError('invalid connectionId', 400);
        const stored = await dependencies.readConnection(workspaceId, connectionId);
        if (!stored) return requestError('workspace-host connection not found', 404);
        if (!isSupportedTarget(stored.target)) {
          return requestError('workspace-host connection target is not implemented', 501, {
            target: stored.target,
          });
        }
        label = stored.label ?? stored.id;
        connection = stored.connection;
        if (action === 'update') {
          // An update keeps the connection's identity (id + target) and re-admits it with the
          // supplied fields layered over the stored ones, so a partial edit cannot silently drop
          // the rest of the configuration.
          if (body.target !== undefined && trimmed(body.target) !== stored.target) {
            return requestError('workspace-host connection target cannot change on update', 400, {
              target: stored.target,
            });
          }
          if (body.label !== undefined) {
            const parsedLabel = parseLabel(body.label);
            if (!parsedLabel) return requestError(LABEL_ERROR, 400);
            label = parsedLabel;
          }
          const parsed = PARSERS[stored.target]({
            ...storedConnectionFields(stored.connection),
            ...requestConnectionFields(body),
          });
          if (!parsed.ok) return parsed.response;
          connection = parsed.connection;
        }
      }

      let inspection: WorkspaceHostConnectionInspection;
      try {
        inspection = await dependencies.inspectConnection({ workspaceId, connectionId, connection });
      } catch (error) {
        const problem = safeConnectionProblem(error);
        inspection = {
          validation: {
            ok: false,
            checkedAt: new Date().toISOString(),
            warnings: [],
            errors: [problem],
          },
          scopes: [],
          regions: [],
          sizes: [],
          images: [],
        };
      }

      // "The provider answered" is not authenticated connection identity. A successful
      // validation must name the non-secret principal it proved; otherwise the controller could
      // later mutate resources without being able to show which authority was admitted.
      if (inspection.validation.ok && !inspection.validation.identity?.trim()) {
        inspection = {
          validation: {
            ok: false,
            checkedAt: inspection.validation.checkedAt,
            warnings: inspection.validation.warnings,
            errors: ['Provider validation did not return an authenticated identity.'],
          },
          scopes: [],
          regions: [],
          sizes: [],
          images: [],
        };
      }

      await dependencies.upsertConnection(connectionInput(workspaceId, connectionId, label, connection, inspection));
      if (!inspection.validation.ok) {
        const problems = inspection.validation.errors;
        return requestError(problems[0] ?? 'Provider connection validation failed.', 422, {
          connectionId,
          problems,
        });
      }
      const message =
        action === 'connect'
          ? `${label} connected and validated`
          : action === 'update'
            ? `${label} connection updated and validated`
            : `${label} connection validated`;
      return Response.json({
        ok: true,
        status: 'connected',
        connectionId,
        authenticatedIdentity: inspection.validation.identity,
        message,
      });
    },
  });
}

export default createWorkspaceHostConnectionRoute();
