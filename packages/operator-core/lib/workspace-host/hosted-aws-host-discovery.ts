/**
 * Read the customer's hosted AWS host stack back through the VERIFIED customer role
 * (aws-byoc-gcp-parity-2026-10-01 D-009), and pick the Ubuntu image the first workspace runs.
 *
 * Every lookup is by the tag or fixed name the stack template writes (hosted-aws-host-stack.ts),
 * so it never depends on what the customer called the stack, and every call is one the delegated
 * role is granted (AWS_WORKSPACE_HOST_PERMISSION_ACTIONS). A resource that is not there yet means
 * the stack is still being created: that answers {@link HostedAwsHostInfrastructurePendingError},
 * which the first-workspace route turns into "waiting for your AWS setup", not a failure.
 */
import {
  DescribeImagesCommand,
  DescribeLaunchTemplatesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { GetInstanceProfileCommand, IAMClient } from '@aws-sdk/client-iam';
import { DescribeKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { planAwsSdkCredentialProvider } from './aws-connection';
import { createAwsSdkCredentialProvider, type AwsSdkCredentialIdentityProvider } from './aws-sdk-client';
import {
  HOSTED_AWS_DEFAULT_REGION,
  HOSTED_AWS_HOST_KMS_ALIAS,
  HOSTED_AWS_HOST_SUBNET_TAG_KEY,
  HOSTED_AWS_HOST_TAG_KEY,
  HostedAwsHostInfrastructurePendingError,
  hostedAwsHostNames,
  type HostedAwsHostInfrastructure,
} from './hosted-aws-host-stack';
import { resolveOrganizationExternalIdRef } from './hosted-aws-identity';
import type { HostedProviderDelegationRecord } from './hosted-provider-delegation';

/** Canonical's AWS account: the publisher of the official Ubuntu AMIs in every commercial region. */
export const CANONICAL_AWS_IMAGE_OWNER = '099720109477';
/** Ubuntu 24.04 LTS (noble), amd64, gp3 root — the AWS twin of GCP's ubuntu-2404-noble-amd64. */
export const UBUNTU_2404_AMD64_IMAGE_NAME = 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*';

export interface HostedAwsSender {
  send(command: unknown): Promise<unknown>;
}

export interface HostedAwsHostClients {
  readonly ec2: HostedAwsSender;
  readonly iam: HostedAwsSender;
  readonly kms: HostedAwsSender;
}

export interface HostedAwsHostDiscoveryDependencies {
  /** The control-plane principal that starts the role chain (default: the node provider chain). */
  readonly controlPlaneCredentials?: AwsSdkCredentialIdentityProvider;
  /** Clients acting as the customer role in `region` (tests inject fakes). */
  readonly createClients?: (region: string, credentials: AwsSdkCredentialIdentityProvider) => HostedAwsHostClients;
}

function defaultClients(region: string, credentials: AwsSdkCredentialIdentityProvider): HostedAwsHostClients {
  return {
    ec2: new EC2Client({ region, credentials }),
    iam: new IAMClient({ region, credentials }),
    kms: new KMSClient({ region, credentials }),
  };
}

function errorName(error: unknown): string {
  return error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '';
}

const NOT_FOUND = new Set([
  'NoSuchEntity',
  'NoSuchEntityException',
  'NotFoundException',
  'InvalidLaunchTemplateName.NotFoundException',
  'InvalidLaunchTemplateId.NotFound',
]);

async function orPending<T>(missing: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (NOT_FOUND.has(errorName(error))) throw new HostedAwsHostInfrastructurePendingError(missing);
    throw error;
  }
}

function exactlyOne<T>(items: readonly T[] | undefined, missing: string): T {
  if (!items || items.length === 0) throw new HostedAwsHostInfrastructurePendingError(missing);
  // Two stacks in one account and region would make the host's network ambiguous; refuse
  // rather than guess which one the customer meant.
  if (items.length > 1) throw new Error(`hosted_aws_host_infrastructure_ambiguous:${missing}`);
  return items[0]!;
}

function required(value: string | undefined, missing: string): string {
  if (typeof value !== 'string' || !value) throw new HostedAwsHostInfrastructurePendingError(missing);
  return value;
}

interface Ec2Image {
  ImageId?: string;
  Name?: string;
  CreationDate?: string;
  OwnerId?: string;
}

/** The newest available Canonical Ubuntu 24.04 amd64 image visible in the customer's region. */
export function newestUbuntuImage(images: readonly Ec2Image[] | undefined): { id: string; version: string } {
  const candidates = (images ?? [])
    .filter((image) => image.OwnerId === CANONICAL_AWS_IMAGE_OWNER && image.ImageId && image.Name && image.CreationDate)
    .sort((left, right) => (right.CreationDate ?? '').localeCompare(left.CreationDate ?? ''));
  const newest = candidates[0];
  if (!newest) throw new Error('hosted_aws_host_ubuntu_image_unavailable');
  return { id: newest.ImageId!, version: newest.Name!.split('/').pop()! };
}

/**
 * Find the host infrastructure the customer's stack created, as the customer's own role. The
 * record must be a VERIFIED hosted customer-role delegation: the caller verifies first.
 */
export async function discoverHostedAwsHostInfrastructure(
  record: HostedProviderDelegationRecord,
  deps: HostedAwsHostDiscoveryDependencies = {},
): Promise<HostedAwsHostInfrastructure> {
  const configuration = record.configuration;
  if (configuration.provider !== 'aws') throw new Error('hosted_aws_host_discovery_requires_aws');
  const source = configuration.source;
  if (source.environment !== 'hosted' || source.method !== 'customer-role') {
    throw new Error('hosted_provider_delegation_aws_method_not_organization_bound');
  }
  if (record.status !== 'verified') throw new Error('hosted_aws_host_discovery_requires_verified_delegation');
  const accountId = configuration.accountId;
  const region = configuration.region ?? HOSTED_AWS_DEFAULT_REGION;
  const credentials = createAwsSdkCredentialProvider(planAwsSdkCredentialProvider(source), region, {
    resolveExternalId: resolveOrganizationExternalIdRef,
    ...(deps.controlPlaneCredentials ? { controlPlaneCredentials: deps.controlPlaneCredentials } : {}),
  });
  const clients = (deps.createClients ?? defaultClients)(region, credentials);
  const names = hostedAwsHostNames(accountId);
  const ownTag = { Name: `tag:${HOSTED_AWS_HOST_TAG_KEY}`, Values: [accountId] };

  const subnets = (await clients.ec2.send(new DescribeSubnetsCommand({
    Filters: [ownTag, { Name: `tag:${HOSTED_AWS_HOST_SUBNET_TAG_KEY}`, Values: ['private'] }, { Name: 'state', Values: ['available'] }],
  }))) as { Subnets?: Array<{ SubnetId?: string; VpcId?: string; AvailabilityZone?: string }> };
  const subnet = exactlyOne(subnets.Subnets, 'private-subnet');
  const vpcId = required(subnet.VpcId, 'vpc');

  const groups = (await clients.ec2.send(new DescribeSecurityGroupsCommand({
    Filters: [ownTag, { Name: 'vpc-id', Values: [vpcId] }],
  }))) as { SecurityGroups?: Array<{ GroupId?: string }> };
  const group = exactlyOne(groups.SecurityGroups, 'security-group');

  // The stack creates its launch template LAST (after the NAT route), so finding it means the
  // host's outbound path to Session Manager exists.
  const templates = (await orPending('launch-template', () => clients.ec2.send(new DescribeLaunchTemplatesCommand({
    LaunchTemplateNames: [names.launchTemplateName],
  })))) as { LaunchTemplates?: Array<{ LaunchTemplateId?: string }> };
  const template = exactlyOne(templates.LaunchTemplates, 'launch-template');

  const profile = (await orPending('instance-profile', () => clients.iam.send(new GetInstanceProfileCommand({
    InstanceProfileName: names.instanceProfileName,
  })))) as { InstanceProfile?: { Arn?: string } };

  const key = (await orPending('kms-key', () => clients.kms.send(new DescribeKeyCommand({
    KeyId: HOSTED_AWS_HOST_KMS_ALIAS,
  })))) as { KeyMetadata?: { Arn?: string; KeyState?: string } };
  if (key.KeyMetadata?.KeyState && key.KeyMetadata.KeyState !== 'Enabled') {
    throw new Error(`hosted_aws_host_kms_key_not_enabled:${key.KeyMetadata.KeyState}`);
  }

  const images = (await clients.ec2.send(new DescribeImagesCommand({
    Owners: [CANONICAL_AWS_IMAGE_OWNER],
    Filters: [
      { Name: 'name', Values: [UBUNTU_2404_AMD64_IMAGE_NAME] },
      { Name: 'state', Values: ['available'] },
      { Name: 'architecture', Values: ['x86_64'] },
    ],
  }))) as { Images?: Ec2Image[] };

  return {
    region,
    zone: required(subnet.AvailabilityZone, 'availability-zone'),
    vpcId,
    subnetId: required(subnet.SubnetId, 'private-subnet'),
    securityGroupId: required(group.GroupId, 'security-group'),
    instanceProfileArn: required(profile.InstanceProfile?.Arn, 'instance-profile'),
    launchTemplateId: required(template.LaunchTemplateId, 'launch-template'),
    kmsKeyArn: required(key.KeyMetadata?.Arn, 'kms-key'),
    image: newestUbuntuImage(images.Images),
  };
}
