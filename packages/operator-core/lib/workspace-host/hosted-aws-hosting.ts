/**
 * "Use Papercusp's cloud" on AWS (aws-byoc-gcp-parity-2026-10-01 P-015, D-017): the AWS twin of
 * hosted-gcp-hosting.ts. ONE workspace host for ONE organization inside Papercusp's own AWS
 * hosting account, confined by AWS itself rather than by Papercusp's code alone.
 *
 * It is the hosted customer-role chain (D-001) with Papercusp's hosting account standing in for
 * the customer's:
 *
 *   control-plane principal -> the organization's own role (/papercusp/orgs/pco-…)
 *     -> that organization's HOSTING role in the hosting account (+ the org's ExternalId)
 *
 * The hosting role is named with the customer-role prefix, so the per-org chain policy already
 * lets the organization's role assume it and nothing new is granted upstream. Its permissions
 * are the workspace-host client's own action list ({@link AWS_WORKSPACE_HOST_PERMISSION_ACTIONS},
 * pinned to the SDK commands the client really sends), each action classified ONCE below:
 * - observe: describe/list/quota/pricing calls, unconditional. They change nothing.
 * - host: every call that acts on an existing machine, disk, snapshot or session, allowed only
 *   when the resource carries `papercusp:host-id` = the reserved host.
 * - create: RunInstances, CreateVolume, CreateSnapshot and their creation-time tags, allowed only
 *   when the REQUEST stamps the reserved host id; tags can be written only at creation, so no
 *   resource can be retagged into another tenant's host.
 * - scoped: IAM and KMS calls pinned to the shared stack's instance role and key alias.
 * So AWS refuses a change to another tenant's machine even if Papercusp's code named it.
 *
 * The hosting account carries ONE copy of the D-009 host infrastructure (VPC, private subnet,
 * security groups, instance profile, launch template, KMS key; hosted-aws-host-stack.ts), applied
 * by Papercusp, and the server finds it through the same discovery as a customer's stack.
 *
 * Pure: no SDK imports, so first-workspace and the delegation module can use it freely.
 */
import { AWS_WORKSPACE_HOST_PERMISSION_ACTIONS, type AwsWorkspaceHostPermissionAction } from './aws-connection';
import { AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS } from './aws-safety';
import { HOSTED_AWS_HOST_KMS_ALIAS, awsSpotServiceLinkedRoleStatement, hostedAwsHostNames } from './hosted-aws-host-stack';
import { HOSTED_AWS_CUSTOMER_ROLE_NAME_PREFIX, organizationDelegationRoleName } from './hosted-aws-identity';

type Env = Readonly<Record<string, string | undefined>>;

/** The AWS account that holds every Papercusp-hosted AWS workspace host. */
export const HOSTED_AWS_WORKSPACE_ACCOUNT_ENV = 'PAPERCUSP_HOSTED_AWS_WORKSPACE_ACCOUNT_ID';
/**
 * The role in the hosting account that the control plane assumes to write per-organization
 * hosting roles: the AWS twin of the GCP hosting project's IAM-policy admin. Optional when the
 * hosting account IS the control-plane account (the control plane then writes them directly).
 */
export const HOSTED_AWS_HOSTING_ADMIN_ROLE_ENV = 'PAPERCUSP_HOSTED_AWS_HOSTING_ADMIN_ROLE_ARN';

/** Where Papercusp-hosted AWS hosts run: one region, like GCP's single zone. */
export const PAPERCUSP_HOSTED_AWS_LOCATION = { region: 'us-east-1' } as const;

/** Name of the inline policy that confines a hosting role to its reserved host. */
export const PAPERCUSP_HOSTED_AWS_HOST_POLICY = 'PapercuspHostedWorkspaceHost';

const AWS_ACCOUNT_ID = /^\d{12}$/;
const IAM_ROLE_ARN = /^arn:(aws|aws-us-gov|aws-cn):iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * This deployment has no AWS hosting account, so Papercusp's cloud runs on GCP only. A state of
 * the deployment, not a fault: the browser is told AWS is not offered here instead of "try again".
 */
export class HostedAwsHostingUnconfiguredError extends Error {
  override readonly name = 'HostedAwsHostingUnconfiguredError';
  constructor() {
    super('aws_workspace_host_papercusp_hosting_account_unconfigured');
  }
}

export function hostedAwsWorkspaceAccount(env: Env = process.env): string {
  const account = env[HOSTED_AWS_WORKSPACE_ACCOUNT_ENV]?.trim();
  if (!account) throw new HostedAwsHostingUnconfiguredError();
  if (!AWS_ACCOUNT_ID.test(account)) throw new Error('aws_workspace_host_papercusp_hosting_account_invalid');
  return account;
}

/** The hosting-admin role, or `undefined` when none is configured. */
export function hostedAwsHostingAdminRole(env: Env = process.env): string | undefined {
  const arn = env[HOSTED_AWS_HOSTING_ADMIN_ROLE_ENV]?.trim();
  if (!arn) return undefined;
  if (!IAM_ROLE_ARN.test(arn)) throw new Error('aws_workspace_host_papercusp_hosting_admin_role_invalid');
  return arn;
}

/**
 * The organization's hosting role: the customer-role prefix (so the per-org chain policy covers
 * it) plus the same digest as its control-plane role, so one organization is recognisable across
 * both accounts without the name revealing who it is. At most 51 characters (IAM allows 64).
 */
export function papercuspHostingRoleName(organizationId: string): string {
  return `${HOSTED_AWS_CUSTOMER_ROLE_NAME_PREFIX}${organizationDelegationRoleName(organizationId)}`;
}

export function papercuspHostingRoleArn(organizationId: string, accountId: string, partition = 'aws'): string {
  if (!AWS_ACCOUNT_ID.test(accountId)) throw new Error('aws_workspace_host_papercusp_hosting_account_invalid');
  return `arn:${partition}:iam::${accountId}:role/${papercuspHostingRoleName(organizationId)}`;
}

/** Only the organization's own control-plane role, and only with that organization's ExternalId. */
export function papercuspHostingTrustPolicy(input: { organizationRoleArn: string; externalId: string }): Record<string, unknown> {
  if (!IAM_ROLE_ARN.test(input.organizationRoleArn)) throw new Error('aws_workspace_host_papercusp_hosting_principal_invalid');
  if (!input.externalId) throw new Error('aws_workspace_host_papercusp_hosting_external_id_required');
  return {
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { AWS: input.organizationRoleArn },
      Action: 'sts:AssumeRole',
      Condition: { StringEquals: { 'sts:ExternalId': input.externalId } },
    }],
  };
}

/** How the hosting role grants one workspace-host action. */
export type PapercuspHostingGrantClass =
  | 'observe'
  | 'host-instance'
  | 'host-volume'
  | 'host-snapshot'
  | 'host-spot-request'
  | 'create'
  | 'create-tags'
  | 'own-session'
  | 'instance-role'
  | 'self-simulation'
  | 'host-key';

/**
 * Every action the workspace-host client sends, classified once. A `Record` over the action
 * union, so an action added to {@link AWS_WORKSPACE_HOST_PERMISSION_ACTIONS} does not compile
 * until someone decides how a hosting role confines it.
 */
export const PAPERCUSP_HOSTING_ACTION_CLASSES: Readonly<Record<AwsWorkspaceHostPermissionAction, PapercuspHostingGrantClass>> = {
  'ec2:DescribeRegions': 'observe',
  'ec2:DescribeSubnets': 'observe',
  'ec2:DescribeImages': 'observe',
  'ec2:DescribeInstances': 'observe',
  'ec2:DescribeInstanceStatus': 'observe',
  'ec2:DescribeInstanceTypes': 'observe',
  'ec2:DescribeAvailabilityZones': 'observe',
  'ec2:DescribeVolumes': 'observe',
  'ec2:DescribeSnapshots': 'observe',
  'ec2:DescribeSecurityGroups': 'observe',
  'ec2:DescribeLaunchTemplates': 'observe',
  // WI-10005454: the teardown census; Describe* has no resource-level scope.
  'ec2:DescribeSpotInstanceRequests': 'observe',
  'ec2:RunInstances': 'create',
  'ec2:CreateVolume': 'create',
  'ec2:CreateSnapshot': 'create',
  'ec2:CreateTags': 'create-tags',
  'ec2:StartInstances': 'host-instance',
  'ec2:StopInstances': 'host-instance',
  'ec2:RebootInstances': 'host-instance',
  'ec2:TerminateInstances': 'host-instance',
  // Console output can carry another tenant's boot log: host-confined, not an observation.
  'ec2:GetConsoleOutput': 'host-instance',
  'ec2:AttachVolume': 'host-volume',
  'ec2:DetachVolume': 'host-volume',
  'ec2:DeleteVolume': 'host-volume',
  'ec2:DeleteSnapshot': 'host-snapshot',
  // WI-10005389: the persistent spot request behind a spot host, tagged with the host at creation.
  'ec2:CancelSpotInstanceRequests': 'host-spot-request',
  'ssm:DescribeInstanceInformation': 'observe',
  'ssm:GetConnectionStatus': 'observe',
  'ssm:GetCommandInvocation': 'observe',
  'ssm:StartSession': 'host-instance',
  'ssm:SendCommand': 'host-instance',
  'ssm:TerminateSession': 'own-session',
  'iam:GetRole': 'instance-role',
  'iam:GetInstanceProfile': 'instance-role',
  'iam:PassRole': 'instance-role',
  'iam:SimulatePrincipalPolicy': 'self-simulation',
  'kms:DescribeKey': 'host-key',
  'kms:CreateGrant': 'host-key',
  'servicequotas:GetServiceQuota': 'observe',
  'servicequotas:ListServiceQuotas': 'observe',
  'servicequotas:GetAWSDefaultServiceQuota': 'observe',
  'pricing:GetProducts': 'observe',
};

function actionsOf(cls: PapercuspHostingGrantClass): string[] {
  return AWS_WORKSPACE_HOST_PERMISSION_ACTIONS.filter((action) => PAPERCUSP_HOSTING_ACTION_CLASSES[action] === cls);
}

export interface PapercuspHostingPolicyInput {
  organizationId: string;
  accountId: string;
  hostId: string;
  region?: string;
  partition?: string;
}

/**
 * The inline policy that confines an organization's hosting role to `hostId`. Rewritten whenever
 * the organization's host is (re)reserved, as the GCP grant's name conditions are.
 */
export function papercuspHostingPolicy(input: PapercuspHostingPolicyInput): Record<string, unknown> {
  const partition = input.partition ?? 'aws';
  const region = input.region ?? PAPERCUSP_HOSTED_AWS_LOCATION.region;
  const account = input.accountId;
  if (!AWS_ACCOUNT_ID.test(account)) throw new Error('aws_workspace_host_papercusp_hosting_account_invalid');
  if (!HOST_ID.test(input.hostId)) throw new Error('aws_workspace_host_papercusp_hosting_host_invalid');
  const hostTag = AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.hostId;
  const ec2 = (resource: string) => `arn:${partition}:ec2:${region}:${account}:${resource}`;
  const onHost = { StringEquals: { [`aws:ResourceTag/${hostTag}`]: input.hostId } };
  const requestsHost = { StringEquals: { [`aws:RequestTag/${hostTag}`]: input.hostId } };
  const names = hostedAwsHostNames(account);
  const ssmInstanceActions = actionsOf('host-instance').filter((action) => action.startsWith('ssm:'));
  const ec2InstanceActions = actionsOf('host-instance').filter((action) => action.startsWith('ec2:'));
  return {
    Version: '2012-10-17',
    Statement: [
      { Sid: 'Observe', Effect: 'Allow', Action: actionsOf('observe'), Resource: '*' },
      { Sid: 'HostInstance', Effect: 'Allow', Action: ec2InstanceActions, Resource: ec2('instance/*'), Condition: onHost },
      // Session and Run Command need the instance AND the document; only the instance is tenant data.
      { Sid: 'HostInstanceSsm', Effect: 'Allow', Action: ssmInstanceActions, Resource: ec2('instance/*'), Condition: onHost },
      {
        Sid: 'HostSsmDocuments',
        Effect: 'Allow',
        Action: ssmInstanceActions,
        Resource: [
          `arn:${partition}:ssm:${region}::document/AWS-RunShellScript`,
          `arn:${partition}:ssm:${region}::document/AWS-StartSSHSession`,
        ],
      },
      {
        Sid: 'HostVolume',
        Effect: 'Allow',
        Action: actionsOf('host-volume'),
        Resource: [ec2('volume/*')],
        Condition: onHost,
      },
      // Attach/detach name the instance too, which must be this host's.
      { Sid: 'HostVolumeInstance', Effect: 'Allow', Action: ['ec2:AttachVolume', 'ec2:DetachVolume'], Resource: ec2('instance/*'), Condition: onHost },
      { Sid: 'HostSnapshot', Effect: 'Allow', Action: actionsOf('host-snapshot'), Resource: `arn:${partition}:ec2:${region}::snapshot/*`, Condition: onHost },
      // A snapshot is cut FROM this host's volume.
      { Sid: 'SnapshotSource', Effect: 'Allow', Action: 'ec2:CreateSnapshot', Resource: ec2('volume/*'), Condition: onHost },
      {
        // A NEW machine or disk must be stamped with this host. The created snapshot resource is
        // separate below: listing snapshot/* here would let CreateVolume restore FROM another
        // tenant's snapshot as long as the new disk carried this host's tag.
        Sid: 'CreateForHost',
        Effect: 'Allow',
        Action: ['ec2:RunInstances', 'ec2:CreateVolume'],
        Resource: [ec2('instance/*'), ec2('volume/*')],
        Condition: requestsHost,
      },
      {
        // WI-10005389: a spot launch also creates its spot request, tagged with this host.
        Sid: 'CreateSpotRequestForHost',
        Effect: 'Allow',
        Action: 'ec2:RunInstances',
        Resource: ec2('spot-instances-request/*'),
        Condition: requestsHost,
      },
      {
        // Only this host's spot request can be cancelled (destroy cancels it before terminating).
        Sid: 'HostSpotRequest',
        Effect: 'Allow',
        Action: actionsOf('host-spot-request'),
        Resource: ec2('spot-instances-request/*'),
        Condition: onHost,
      },
      // An API spot launch needs EC2's Spot service-linked role to exist; EC2 creates it on the
      // first launch with the caller's permission. Only that one role, for that one service.
      awsSpotServiceLinkedRoleStatement(account, partition),
      {
        Sid: 'CreateSnapshotForHost',
        Effect: 'Allow',
        Action: 'ec2:CreateSnapshot',
        Resource: `arn:${partition}:ec2:${region}::snapshot/*`,
        Condition: requestsHost,
      },
      {
        // Restore reads a snapshot, which must already be this host's.
        Sid: 'RestoreFromHostSnapshot',
        Effect: 'Allow',
        Action: 'ec2:CreateVolume',
        Resource: `arn:${partition}:ec2:${region}::snapshot/*`,
        Condition: onHost,
      },
      {
        // What a launch only references (or creates untagged, the network interface).
        Sid: 'LaunchReferences',
        Effect: 'Allow',
        Action: 'ec2:RunInstances',
        Resource: [
          ec2('subnet/*'),
          ec2('security-group/*'),
          ec2('network-interface/*'),
          ec2('launch-template/*'),
          `arn:${partition}:ec2:${region}::image/*`,
        ],
      },
      {
        Sid: 'TagOnlyAtCreation',
        Effect: 'Allow',
        Action: actionsOf('create-tags'),
        Resource: [
          ec2('instance/*'),
          ec2('volume/*'),
          ec2('spot-instances-request/*'),
          `arn:${partition}:ec2:${region}::snapshot/*`,
        ],
        Condition: {
          StringEquals: {
            'ec2:CreateAction': ['RunInstances', 'CreateVolume', 'CreateSnapshot'],
            [`aws:RequestTag/${hostTag}`]: input.hostId,
          },
        },
      },
      {
        Sid: 'OwnSessions',
        Effect: 'Allow',
        Action: actionsOf('own-session'),
        Resource: `arn:${partition}:ssm:${region}:${account}:session/\${aws:userid}-*`,
      },
      {
        Sid: 'InstanceRoleRead',
        Effect: 'Allow',
        Action: actionsOf('instance-role').filter((action) => action !== 'iam:PassRole'),
        Resource: [
          `arn:${partition}:iam::${account}:role/${names.instanceRoleName}`,
          `arn:${partition}:iam::${account}:instance-profile/${names.instanceProfileName}`,
        ],
      },
      {
        Sid: 'InstanceRolePass',
        Effect: 'Allow',
        Action: 'iam:PassRole',
        Resource: `arn:${partition}:iam::${account}:role/${names.instanceRoleName}`,
        Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
      },
      {
        Sid: 'SelfSimulation',
        Effect: 'Allow',
        Action: actionsOf('self-simulation'),
        Resource: papercuspHostingRoleArn(input.organizationId, account, partition),
      },
      {
        Sid: 'HostKeyRead',
        Effect: 'Allow',
        Action: actionsOf('host-key').filter((action) => action !== 'kms:CreateGrant'),
        Resource: `arn:${partition}:kms:${region}:${account}:key/*`,
        Condition: { 'ForAnyValue:StringEquals': { 'kms:ResourceAliases': HOSTED_AWS_HOST_KMS_ALIAS } },
      },
      {
        // EBS encrypts the host's disks with the shared stack key through a grant for EC2 only.
        Sid: 'HostKeyGrant',
        Effect: 'Allow',
        Action: 'kms:CreateGrant',
        Resource: `arn:${partition}:kms:${region}:${account}:key/*`,
        Condition: {
          'ForAnyValue:StringEquals': { 'kms:ResourceAliases': HOSTED_AWS_HOST_KMS_ALIAS },
          Bool: { 'kms:GrantIsForAWSResource': 'true' },
        },
      },
    ],
  };
}

/** The hosting account's IAM has not caught up with a brand-new organization role yet. */
export class HostedAwsNotReadyError extends Error {
  override readonly name = 'HostedAwsNotReadyError';
}
