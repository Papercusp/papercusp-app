import type { RefusalContract } from '../capability-envelope/refusal-contract-types';
import {
  assertWorkspaceHostSecretIsolation,
  type CloudCredentialRef,
  type WorkspaceHostProviderConnection,
} from '@papercusp/deployment-driver';

export const AWS_WORKSPACE_HOST_TARGET = 'aws';
export const AWS_WORKSPACE_HOST_PREFLIGHT_VERSION = 'aws-workspace-host-preflight-v1';

export type AwsPartition =
  | 'aws'
  | 'aws-cn'
  | 'aws-us-gov'
  | 'aws-iso'
  | 'aws-iso-b'
  | 'aws-iso-e'
  | 'aws-iso-f';

export type AwsWorkspaceHostCredentialSource =
  | { environment: 'local'; method: 'default-chain' }
  | { environment: 'local'; method: 'shared-profile'; profile: string }
  | {
      environment: 'local';
      method: 'assume-role';
      roleArn: string;
      sourceProfile?: string;
      externalIdRef?: string;
      roleSessionName?: string;
    }
  | {
      environment: 'hosted';
      method: 'customer-role';
      roleArn: string;
      trustedPrincipalArn: string;
      externalIdRef: string;
      roleSessionName?: string;
    }
  | {
      environment: 'hosted';
      method: 'oidc';
      roleArn: string;
      providerArn: string;
      issuer: string;
      audience: string;
      subject: string;
      roleSessionName?: string;
    };

export interface AwsSdkCredentialProviderPlan {
  sdk: 'aws-sdk-js-v3';
  factory: 'defaultProvider' | 'fromIni' | 'fromTemporaryCredentials' | 'fromWebToken';
  source: 'default-chain' | 'shared-profile' | 'control-plane-role' | 'control-plane-oidc';
  profile?: string;
  roleArn?: string;
  externalIdRef?: string;
  roleSessionName?: string;
  hostedTrust?: {
    principalArn?: string;
    providerArn?: string;
    issuer?: string;
    audience?: string;
    subject?: string;
  };
}

export const AWS_WORKSPACE_HOST_PERMISSION_ACTIONS = [
  'ec2:DescribeRegions',
  'ec2:DescribeSubnets',
  'ec2:DescribeImages',
  'ec2:DescribeInstances',
  'ec2:DescribeInstanceStatus',
  'ec2:DescribeInstanceTypes',
  'ec2:DescribeAvailabilityZones',
  'ec2:DescribeVolumes',
  'ec2:DescribeSnapshots',
  'ec2:RunInstances',
  'ec2:CreateTags',
  'ec2:StartInstances',
  'ec2:StopInstances',
  'ec2:RebootInstances',
  'ec2:TerminateInstances',
  'ec2:CreateVolume',
  'ec2:AttachVolume',
  'ec2:DetachVolume',
  'ec2:DeleteVolume',
  'ec2:CreateSnapshot',
  'ec2:DeleteSnapshot',
  // WI-10005389: a spot host is launched by a PERSISTENT spot request, and terminating its instance
  // while that request is still open makes EC2 launch a replacement. Destroy cancels it first.
  'ec2:CancelSpotInstanceRequests',
  // WI-10005454: the teardown census reads live spot requests, so a request that survived destroy
  // is visible to the zero-orphan proof instead of only to the cancel step.
  'ec2:DescribeSpotInstanceRequests',
  // aws-byoc-gcp-parity D-009: the client already makes these calls as the customer role
  // (security-group inbound check, console output, launch-template discovery).
  'ec2:DescribeSecurityGroups',
  'ec2:DescribeLaunchTemplates',
  'ec2:GetConsoleOutput',
  'ssm:DescribeInstanceInformation',
  'ssm:GetConnectionStatus',
  'ssm:StartSession',
  'ssm:TerminateSession',
  // aws-byoc-gcp-parity D-013: the host bootstrap is pushed over Run Command after the data volume
  // attaches (EC2 UserData's 16 KiB cap cannot carry it), and the push waits for its invocation.
  'ssm:SendCommand',
  'ssm:GetCommandInvocation',
  'iam:GetRole',
  'iam:GetInstanceProfile',
  'iam:PassRole',
  'iam:SimulatePrincipalPolicy',
  'kms:DescribeKey',
  'kms:CreateGrant',
  'servicequotas:GetServiceQuota',
  'servicequotas:ListServiceQuotas',
  'servicequotas:GetAWSDefaultServiceQuota',
  'pricing:GetProducts',
] as const;
export type AwsWorkspaceHostPermissionAction = (typeof AWS_WORKSPACE_HOST_PERMISSION_ACTIONS)[number];

export interface AwsWorkspaceHostQuotaRequirement {
  serviceCode: string;
  quotaCode: string;
  minimumValue: number;
  label: string;
}

export interface AwsWorkspaceHostSelection {
  accountId: string;
  partition: AwsPartition;
  region: string;
  subnetId: string;
  imageId: string;
  kmsKeyArn: string;
  instanceProfileArn: string;
  architecture?: string;
  quotas: readonly AwsWorkspaceHostQuotaRequirement[];
}

export interface AwsCallerIdentityEvidence {
  accountId: string;
  arn: string;
  userId: string;
  evidenceRef: string;
}

export interface AwsRegionEvidence {
  id: string;
  partition: AwsPartition;
  available: boolean;
  optInStatus?: string;
  evidenceRef: string;
}

export interface AwsSubnetEvidence {
  id: string;
  region: string;
  availabilityZone: string;
  vpcId: string;
  available: boolean;
  evidenceRef: string;
}

export interface AwsImageEvidence {
  id: string;
  ownerId: string;
  state: string;
  architecture?: string;
  launchAllowed: boolean;
  evidenceRef: string;
}

export interface AwsKmsKeyEvidence {
  arn: string;
  partition: AwsPartition;
  region: string;
  enabled: boolean;
  symmetric: boolean;
  evidenceRef: string;
}

export interface AwsWorkspaceHostPermissionEvidence {
  action: AwsWorkspaceHostPermissionAction;
  allowed: boolean;
  evidenceRef: string;
  reason?: string;
}

export interface AwsWorkspaceHostQuotaEvidence extends AwsWorkspaceHostQuotaRequirement {
  value: number;
  evidenceRef: string;
}

export interface AwsWorkspaceHostPermissionRequest {
  actions: readonly AwsWorkspaceHostPermissionAction[];
  region: string;
  subnetId: string;
  imageId: string;
  kmsKeyArn: string;
  instanceProfileArn: string;
}

/**
 * Host-side adapter over AWS SDK v3 clients. Implementations resolve the
 * credential plan, then use read APIs, IAM simulation, or documented DryRun
 * operations. They return redacted evidence references, never credentials.
 */
export interface AwsWorkspaceHostPreflightClient {
  getCallerIdentity(): Promise<AwsCallerIdentityEvidence>;
  describeRegion(region: string): Promise<AwsRegionEvidence>;
  describeSubnet(subnetId: string): Promise<AwsSubnetEvidence>;
  describeImage(imageId: string): Promise<AwsImageEvidence>;
  describeKmsKey(kmsKeyArn: string): Promise<AwsKmsKeyEvidence>;
  evaluatePermissions(
    request: AwsWorkspaceHostPermissionRequest,
  ): Promise<readonly AwsWorkspaceHostPermissionEvidence[]>;
  getServiceQuota(
    requirement: AwsWorkspaceHostQuotaRequirement,
  ): Promise<AwsWorkspaceHostQuotaEvidence>;
}

export interface AwsWorkspaceHostPreflightIssue {
  code:
    | 'account-mismatch'
    | 'partition-mismatch'
    | 'region-unavailable'
    | 'subnet-unavailable'
    | 'subnet-region-mismatch'
    | 'image-unavailable'
    | 'image-architecture-mismatch'
    | 'kms-key-unavailable'
    | 'permission-denied'
    | 'permission-unverified'
    | 'quota-unverified'
    | 'quota-insufficient'
    | 'probe-failed';
  message: string;
  remediation: string;
  /** Present on fail-closed authority refusals (WI-10005197): what compared, what lifts it, who can. */
  refusal?: RefusalContract;
}

export interface AwsWorkspaceHostPreflightRequest {
  cloudCredentialRef: CloudCredentialRef;
  credentialSource: AwsWorkspaceHostCredentialSource;
  selection: AwsWorkspaceHostSelection;
  now?: () => string;
}

export interface AwsWorkspaceHostPreflightReport {
  version: typeof AWS_WORKSPACE_HOST_PREFLIGHT_VERSION;
  ok: boolean;
  checkedAt: string;
  connection: WorkspaceHostProviderConnection;
  credentialProvider: AwsSdkCredentialProviderPlan;
  identity?: AwsCallerIdentityEvidence;
  region?: AwsRegionEvidence;
  subnet?: AwsSubnetEvidence;
  image?: AwsImageEvidence;
  kmsKey?: AwsKmsKeyEvidence;
  permissions: readonly AwsWorkspaceHostPermissionEvidence[];
  quotas: readonly AwsWorkspaceHostQuotaEvidence[];
  issues: readonly AwsWorkspaceHostPreflightIssue[];
}

interface AwsIamArn {
  partition: AwsPartition;
  accountId: string;
  resourceKind: 'role' | 'oidc-provider';
}

const AWS_ACCOUNT_ID = /^\d{12}$/;
const AWS_PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,127}$/;
const ROLE_SESSION_NAME = /^[\w+=,.@-]{2,64}$/;
const AWS_IAM_ARN = /^arn:(aws|aws-cn|aws-us-gov|aws-iso|aws-iso-b|aws-iso-e|aws-iso-f):iam::(\d{12}):(role|oidc-provider)\/(.+)$/;

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function parseIamArn(value: string, expectedKind: AwsIamArn['resourceKind'], label: string): AwsIamArn {
  const match = AWS_IAM_ARN.exec(value);
  if (!match || match[3] !== expectedKind) {
    throw new Error(`${label} must be an AWS IAM ${expectedKind} ARN`);
  }
  return { partition: match[1] as AwsPartition, accountId: match[2], resourceKind: expectedKind };
}

function validateRoleSessionName(value: string | undefined): void {
  if (value !== undefined && !ROLE_SESSION_NAME.test(value)) {
    throw new Error('roleSessionName must be 2-64 AWS STS-safe characters');
  }
}

/** Produce a non-secret SDK v3 resolver plan; this function never resolves credentials. */
export function planAwsSdkCredentialProvider(source: AwsWorkspaceHostCredentialSource): AwsSdkCredentialProviderPlan {
  assertWorkspaceHostSecretIsolation(source, 'aws.credentialSource');
  validateRoleSessionName('roleSessionName' in source ? source.roleSessionName : undefined);

  if (source.environment === 'local' && source.method === 'default-chain') {
    return { sdk: 'aws-sdk-js-v3', factory: 'defaultProvider', source: 'default-chain' };
  }
  if (source.environment === 'local' && source.method === 'shared-profile') {
    if (!AWS_PROFILE.test(source.profile)) throw new Error('profile must be a valid shared AWS config profile name');
    return { sdk: 'aws-sdk-js-v3', factory: 'fromIni', source: 'shared-profile', profile: source.profile };
  }

  const role = parseIamArn(source.roleArn, 'role', 'roleArn');
  if (source.environment === 'local') {
    if (source.sourceProfile !== undefined && !AWS_PROFILE.test(source.sourceProfile)) {
      throw new Error('sourceProfile must be a valid shared AWS config profile name');
    }
    if (source.externalIdRef !== undefined) nonEmpty(source.externalIdRef, 'externalIdRef');
    return {
      sdk: 'aws-sdk-js-v3',
      factory: 'fromTemporaryCredentials',
      source: source.sourceProfile ? 'shared-profile' : 'default-chain',
      profile: source.sourceProfile,
      roleArn: source.roleArn,
      externalIdRef: source.externalIdRef,
      roleSessionName: source.roleSessionName,
    };
  }

  if (source.method === 'customer-role') {
    const principal = parseIamArn(source.trustedPrincipalArn, 'role', 'trustedPrincipalArn');
    if (principal.partition !== role.partition) {
      throw new Error('trustedPrincipalArn and roleArn must use the same AWS partition');
    }
    nonEmpty(source.externalIdRef, 'externalIdRef');
    return {
      sdk: 'aws-sdk-js-v3',
      factory: 'fromTemporaryCredentials',
      source: 'control-plane-role',
      roleArn: source.roleArn,
      externalIdRef: source.externalIdRef,
      roleSessionName: source.roleSessionName,
      hostedTrust: { principalArn: source.trustedPrincipalArn },
    };
  }

  const provider = parseIamArn(source.providerArn, 'oidc-provider', 'providerArn');
  if (provider.accountId !== role.accountId || provider.partition !== role.partition) {
    throw new Error('OIDC providerArn and roleArn must belong to the same AWS account and partition');
  }
  const issuer = new URL(source.issuer);
  if (issuer.protocol !== 'https:') throw new Error('OIDC issuer must use HTTPS');
  nonEmpty(source.audience, 'OIDC audience');
  nonEmpty(source.subject, 'OIDC subject');
  return {
    sdk: 'aws-sdk-js-v3',
    factory: 'fromWebToken',
    source: 'control-plane-oidc',
    roleArn: source.roleArn,
    roleSessionName: source.roleSessionName,
    hostedTrust: {
      providerArn: source.providerArn,
      issuer: issuer.toString(),
      audience: source.audience,
      subject: source.subject,
    },
  };
}

export function buildAwsWorkspaceHostProviderConnection(
  request: AwsWorkspaceHostPreflightRequest,
): WorkspaceHostProviderConnection {
  if (request.cloudCredentialRef.kind !== 'cloud') throw new Error('AWS cloud credential reference must be typed as cloud');
  nonEmpty(request.cloudCredentialRef.ref, 'cloudCredentialRef.ref');
  if (!AWS_ACCOUNT_ID.test(request.selection.accountId)) throw new Error('AWS accountId must be 12 digits');
  const role = 'roleArn' in request.credentialSource
    ? parseIamArn(request.credentialSource.roleArn, 'role', 'roleArn')
    : undefined;
  if (role && role.accountId !== request.selection.accountId) {
    throw new Error('Selected accountId must match the configured AWS role account');
  }
  if (role && role.partition !== request.selection.partition) {
    throw new Error('Selected partition must match the configured AWS role partition');
  }
  if (!request.selection.quotas.length) throw new Error('At least one AWS service quota must be preflighted');

  const connection: WorkspaceHostProviderConnection = {
    target: AWS_WORKSPACE_HOST_TARGET,
    cloudCredentialRef: request.cloudCredentialRef,
    scope: { kind: 'account', id: request.selection.accountId },
    provider: {
      preflightVersion: AWS_WORKSPACE_HOST_PREFLIGHT_VERSION,
      credentialSource: request.credentialSource,
      partition: request.selection.partition,
      region: request.selection.region,
      subnetId: request.selection.subnetId,
      imageId: request.selection.imageId,
      kmsKeyArn: request.selection.kmsKeyArn,
      instanceProfileArn: request.selection.instanceProfileArn,
    },
  };
  assertWorkspaceHostSecretIsolation(connection, 'aws.connection');
  return connection;
}

type ProbeResult<T> = { ok: true; value: T } | { ok: false; message: string };

async function probe<T>(run: () => Promise<T>): Promise<ProbeResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function probeIssue(label: string, result: ProbeResult<unknown>): AwsWorkspaceHostPreflightIssue | undefined {
  if (result.ok) return undefined;
  return {
    code: 'probe-failed',
    message: `${label} probe failed: ${result.message}`,
    remediation: `Resolve the AWS ${label} API or credential error, then rerun preflight.`,
  };
}

/** Run a fail-closed, read-only onboarding preflight through an injected AWS SDK adapter. */
export async function preflightAwsWorkspaceHostConnection(
  request: AwsWorkspaceHostPreflightRequest,
  client: AwsWorkspaceHostPreflightClient,
): Promise<AwsWorkspaceHostPreflightReport> {
  const credentialProvider = planAwsSdkCredentialProvider(request.credentialSource);
  const connection = buildAwsWorkspaceHostProviderConnection(request);
  const now = request.now ?? (() => new Date().toISOString());
  const permissionRequest: AwsWorkspaceHostPermissionRequest = {
    actions: AWS_WORKSPACE_HOST_PERMISSION_ACTIONS,
    region: request.selection.region,
    subnetId: request.selection.subnetId,
    imageId: request.selection.imageId,
    kmsKeyArn: request.selection.kmsKeyArn,
    instanceProfileArn: request.selection.instanceProfileArn,
  };

  const [identity, region, subnet, image, kmsKey, permissions, ...quotas] = await Promise.all([
    probe(() => client.getCallerIdentity()),
    probe(() => client.describeRegion(request.selection.region)),
    probe(() => client.describeSubnet(request.selection.subnetId)),
    probe(() => client.describeImage(request.selection.imageId)),
    probe(() => client.describeKmsKey(request.selection.kmsKeyArn)),
    probe(() => client.evaluatePermissions(permissionRequest)),
    ...request.selection.quotas.map((requirement) => probe(() => client.getServiceQuota(requirement))),
  ] as const);

  const issues: AwsWorkspaceHostPreflightIssue[] = [];
  [
    probeIssue('STS identity', identity),
    probeIssue('region', region),
    probeIssue('subnet', subnet),
    probeIssue('image', image),
    probeIssue('KMS key', kmsKey),
    probeIssue('permission', permissions),
    ...quotas.map((result, index) => probeIssue(`quota '${request.selection.quotas[index]?.label ?? index}'`, result)),
  ].forEach((issue) => { if (issue) issues.push(issue); });

  if (identity.ok) {
    const arn = /^arn:([^:]+):/.exec(identity.value.arn);
    if (identity.value.accountId !== request.selection.accountId) {
      issues.push({
        code: 'account-mismatch',
        message: `Resolved AWS account '${identity.value.accountId}' does not match '${request.selection.accountId}'.`,
        remediation: 'Select the intended account/profile/role and rerun STS GetCallerIdentity.',
      });
    }
    if (arn?.[1] !== request.selection.partition) {
      issues.push({
        code: 'partition-mismatch',
        message: `Resolved identity partition '${arn?.[1] ?? 'unknown'}' does not match '${request.selection.partition}'.`,
        remediation: 'Use a role and region from the selected AWS partition.',
      });
    }
  }
  if (region.ok && (!region.value.available || region.value.id !== request.selection.region)) {
    issues.push({
      code: 'region-unavailable',
      message: `AWS region '${request.selection.region}' is unavailable for this account.`,
      remediation: 'Choose an enabled region or opt the account into the selected region.',
    });
  }
  if (region.ok && region.value.partition !== request.selection.partition) {
    issues.push({
      code: 'partition-mismatch',
      message: `AWS region '${region.value.id}' belongs to '${region.value.partition}', not '${request.selection.partition}'.`,
      remediation: 'Choose a region in the selected AWS partition.',
    });
  }
  if (subnet.ok && !subnet.value.available) {
    issues.push({
      code: 'subnet-unavailable',
      message: `Subnet '${subnet.value.id}' is not available.`,
      remediation: 'Choose an available subnet with enough addresses for the workspace host.',
    });
  }
  if (subnet.ok && subnet.value.region !== request.selection.region) {
    issues.push({
      code: 'subnet-region-mismatch',
      message: `Subnet '${subnet.value.id}' is in '${subnet.value.region}', not '${request.selection.region}'.`,
      remediation: 'Choose a subnet in the selected region.',
    });
  }
  if (image.ok && (image.value.state !== 'available' || !image.value.launchAllowed)) {
    issues.push({
      code: 'image-unavailable',
      message: `AMI '${image.value.id}' is not launchable by the selected account.`,
      remediation: 'Select an available AMI shared with the account and allowed in the target region.',
    });
  }
  if (
    image.ok &&
    request.selection.architecture &&
    image.value.architecture !== request.selection.architecture
  ) {
    issues.push({
      code: 'image-architecture-mismatch',
      message: `AMI architecture '${image.value.architecture ?? 'unknown'}' does not match '${request.selection.architecture}'.`,
      remediation: 'Select an AMI matching the intended instance architecture.',
    });
  }
  if (
    kmsKey.ok &&
    (!kmsKey.value.enabled || !kmsKey.value.symmetric || kmsKey.value.region !== request.selection.region)
  ) {
    issues.push({
      code: 'kms-key-unavailable',
      message: `KMS key '${kmsKey.value.arn}' is not an enabled symmetric key in '${request.selection.region}'.`,
      remediation: 'Choose an enabled symmetric KMS key in the selected region and grant the workspace role access.',
    });
  }

  const permissionValues = permissions.ok ? permissions.value : [];
  const permissionByAction = new Map(permissionValues.map((entry) => [entry.action, entry]));
  for (const action of AWS_WORKSPACE_HOST_PERMISSION_ACTIONS) {
    const evidence = permissionByAction.get(action);
    if (!evidence) {
      issues.push({
        code: 'permission-unverified',
        message: `Permission '${action}' was not evaluated.`,
        remediation: 'Run an IAM simulation or documented AWS DryRun/read probe for every required action.',
      });
    } else if (!evidence.allowed) {
      issues.push({
        code: 'permission-denied',
        message: `Permission '${action}' is denied${evidence.reason ? `: ${evidence.reason}` : '.'}`,
        remediation: `Grant '${action}' to the selected role with the narrowest applicable resource scope.`,
        refusal: {
          observed: { action, allowed: 'false', reason: evidence.reason ?? null },
          liftsWhen:
            `the selected IAM role is granted '${action}' (an AWS account administrator attaches it with the ` +
            'narrowest applicable resource scope) and the preflight is re-run. Re-running unchanged cannot pass',
          whoCanMakeItTrue: ['owner'],
        } satisfies RefusalContract,
      });
    }
  }

  const quotaValues = quotas.flatMap((result) => result.ok ? [result.value] : []);
  for (const required of request.selection.quotas) {
    const evidence = quotaValues.find(
      (entry) => entry.serviceCode === required.serviceCode && entry.quotaCode === required.quotaCode,
    );
    if (!evidence) {
      issues.push({
        code: 'quota-unverified',
        message: `Quota '${required.label}' was not verified.`,
        remediation: 'Grant Service Quotas read access and rerun the preflight.',
      });
    } else if (evidence.value < required.minimumValue) {
      issues.push({
        code: 'quota-insufficient',
        message: `Quota '${required.label}' is ${evidence.value}; at least ${required.minimumValue} is required.`,
        remediation: 'Request a quota increase or select a smaller workspace host profile.',
      });
    }
  }

  const report: AwsWorkspaceHostPreflightReport = {
    version: AWS_WORKSPACE_HOST_PREFLIGHT_VERSION,
    ok: issues.length === 0,
    checkedAt: now(),
    connection,
    credentialProvider,
    identity: identity.ok ? identity.value : undefined,
    region: region.ok ? region.value : undefined,
    subnet: subnet.ok ? subnet.value : undefined,
    image: image.ok ? image.value : undefined,
    kmsKey: kmsKey.ok ? kmsKey.value : undefined,
    permissions: permissionValues,
    quotas: quotaValues,
    issues,
  };
  assertWorkspaceHostSecretIsolation(report, 'aws.preflightReport');
  return report;
}
