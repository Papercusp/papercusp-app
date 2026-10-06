/**
 * The infrastructure half of the hosted AWS customer-role CloudFormation stack
 * (aws-byoc-gcp-parity-2026-10-01 D-009): the AWS twin of the GCP provider's managed network.
 *
 * The AWS provider launches a host only into infrastructure that already exists (VPC, subnet,
 * security groups, instance profile, launch template, customer KMS key — aws-provider.ts
 * readSettings), and it never gives the host a public IP. The customer applies ONE stack that
 * creates the delegated role (hosted-provider-delegation.ts awsTemplate) together with this
 * infrastructure, so Papercusp's role never needs iam:CreateRole. The server then finds every
 * resource by tag or fixed name through the verified role (hosted-aws-host-discovery.ts).
 *
 * Pure: no SDK imports, so the delegation template and the first-workspace bootstrap can use it
 * without pulling AWS clients into their import graph.
 */

/** Tag carried by every resource the stack creates; its value is the customer's account id. */
export const HOSTED_AWS_HOST_TAG_KEY = 'papercusp:workspace-host';
/** Distinguishes the two subnets; the host launches into the `private` one. */
export const HOSTED_AWS_HOST_SUBNET_TAG_KEY = 'papercusp:workspace-host-subnet';
export const HOSTED_AWS_HOST_KMS_ALIAS = 'alias/papercusp-workspace-host';

/** The service that owns EC2's Spot service-linked role (WI-10005389). */
export const AWS_SPOT_SERVICE_NAME = 'spot.amazonaws.com';
/** IAM path + name of EC2's Spot service-linked role, the same in every account. */
export const AWS_SPOT_SERVICE_LINKED_ROLE = `aws-service-role/${AWS_SPOT_SERVICE_NAME}/AWSServiceRoleForEC2Spot`;

/** The ARN of EC2's Spot service-linked role in `accountId`. */
export function awsSpotServiceLinkedRoleArn(accountId: string, partition = 'aws'): string {
  return `arn:${partition}:iam::${accountId}:role/${AWS_SPOT_SERVICE_LINKED_ROLE}`;
}

/**
 * The one permission a spot launch needs that the workspace-host client never sends itself: EC2
 * calls CreateServiceLinkedRole with the CALLER's permission the first time an account launches a
 * spot instance through the API. It is deliberately not in AWS_WORKSPACE_HOST_PERMISSION_ACTIONS
 * (the client's own SDK calls, which the BYOC template grants on every resource); every policy
 * grants it through {@link awsSpotServiceLinkedRoleStatement}, scoped to that one role.
 */
export const AWS_SPOT_SERVICE_LINKED_ROLE_ACTION = 'iam:CreateServiceLinkedRole';

export interface AwsSpotServiceLinkedRoleStatement {
  Sid: 'SpotServiceLinkedRole';
  Effect: 'Allow';
  Action: typeof AWS_SPOT_SERVICE_LINKED_ROLE_ACTION;
  Resource: string;
  Condition: { StringEquals: { 'iam:AWSServiceName': typeof AWS_SPOT_SERVICE_NAME } };
}

/**
 * Lets the caller create EC2's Spot service-linked role and nothing else: that one role ARN, for
 * that one service. `accountId` may be a CloudFormation `${AWS::AccountId}` reference.
 */
export function awsSpotServiceLinkedRoleStatement(accountId: string, partition = 'aws'): AwsSpotServiceLinkedRoleStatement {
  return {
    Sid: 'SpotServiceLinkedRole',
    Effect: 'Allow',
    Action: AWS_SPOT_SERVICE_LINKED_ROLE_ACTION,
    Resource: awsSpotServiceLinkedRoleArn(accountId, partition),
    Condition: { StringEquals: { 'iam:AWSServiceName': AWS_SPOT_SERVICE_NAME } },
  };
}
export const HOSTED_AWS_DEFAULT_REGION = 'us-east-1';
/** Commercial-partition regions only: GovCloud and China have other partitions and AMI owners. */
export const HOSTED_AWS_REGION = /^(?!us-gov-|cn-)[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
/** The CloudFormation logical id of the delegated role in the same stack. */
export const HOSTED_AWS_WORKSPACE_HOST_ROLE_LOGICAL_ID = 'WorkspaceHostRole';

export interface HostedAwsHostNames {
  readonly instanceRoleName: string;
  readonly instanceProfileName: string;
  readonly launchTemplateName: string;
}

/** Fixed per account, so discovery never depends on what the customer named the stack. */
export function hostedAwsHostNames(accountId: string): HostedAwsHostNames {
  return {
    instanceRoleName: `PapercuspWorkspaceHostInstance-${accountId}`,
    instanceProfileName: `PapercuspWorkspaceHostInstance-${accountId}`,
    launchTemplateName: `papercusp-workspace-host-${accountId}`,
  };
}

/**
 * The stack's resources are not finished yet (or were never created): the customer is still
 * applying the template. Not a failure — the first-workspace route answers `delegation_pending`.
 */
export class HostedAwsHostInfrastructurePendingError extends Error {
  constructor(readonly missing: string) {
    super(`hosted_aws_host_infrastructure_pending:${missing}`);
    this.name = 'HostedAwsHostInfrastructurePendingError';
  }
}

/** What the server reads back from the customer's stack; everything the desired spec needs. */
export interface HostedAwsHostInfrastructure {
  readonly region: string;
  readonly zone: string;
  readonly vpcId: string;
  readonly subnetId: string;
  readonly securityGroupId: string;
  readonly instanceProfileArn: string;
  readonly launchTemplateId: string;
  readonly kmsKeyArn: string;
  readonly image: { readonly id: string; readonly version: string };
}

const VPC_CIDR = '10.88.0.0/16';
const PUBLIC_SUBNET_CIDR = '10.88.0.0/24';
const PRIVATE_SUBNET_CIDR = '10.88.1.0/24';

function tags(accountId: string, extra: Readonly<Record<string, string>> = {}): Array<{ Key: string; Value: string }> {
  return [
    { Key: HOSTED_AWS_HOST_TAG_KEY, Value: accountId },
    ...Object.entries(extra).map(([Key, Value]) => ({ Key, Value })),
  ];
}

const FIRST_AZ = { 'Fn::Select': [0, { 'Fn::GetAZs': '' }] };

/** Key-policy condition that admits exactly this account's Spot service-linked role. */
function spotServiceRoleCondition(): Record<string, unknown> {
  return {
    StringEquals: { 'kms:CallerAccount': { Ref: 'AWS::AccountId' } },
    ArnEquals: {
      'aws:PrincipalArn': { 'Fn::Sub': `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/${AWS_SPOT_SERVICE_LINKED_ROLE}` },
    },
  };
}

/**
 * CloudFormation resources, rules and outputs that build the host's infrastructure in `region`.
 * The Rule refuses to create the stack in any other region, so a template rendered for one
 * region can never quietly build somewhere the server will not look.
 *
 * `operatorRoleLogicalId` names the role, declared by the CALLER's own template, that manages the
 * host and therefore uses the disk key. It is required because each stack names its role
 * differently: the hosted stack declares HOSTED_AWS_WORKSPACE_HOST_ROLE_LOGICAL_ID, the desktop
 * customer setup template declares AWS_CUSTOMER_OPERATOR_ROLE_LOGICAL_ID. A fixed id here made the
 * customer template's key policy point at a resource it never declares, and CloudFormation
 * refused the whole stack (WI-10005783).
 */
export function hostedAwsHostStackFragment(accountId: string, region: string, operatorRoleLogicalId: string): {
  Rules: Record<string, unknown>;
  Resources: Record<string, unknown>;
  Outputs: Record<string, unknown>;
} {
  const names = hostedAwsHostNames(accountId);
  const vpc = { Ref: 'HostVpc' };
  const operatorRoleArn = { 'Fn::GetAtt': [operatorRoleLogicalId, 'Arn'] };
  return {
    Rules: {
      PapercuspRegion: {
        Assertions: [
          {
            Assert: { 'Fn::Equals': [{ Ref: 'AWS::Region' }, region] },
            AssertDescription: `Create this stack in the ${region} region, the region you chose in Papercusp.`,
          },
        ],
      },
    },
    Resources: {
      HostVpc: {
        Type: 'AWS::EC2::VPC',
        Properties: { CidrBlock: VPC_CIDR, EnableDnsSupport: true, EnableDnsHostnames: true, Tags: tags(accountId) },
      },
      HostInternetGateway: { Type: 'AWS::EC2::InternetGateway', Properties: { Tags: tags(accountId) } },
      HostGatewayAttachment: {
        Type: 'AWS::EC2::VPCGatewayAttachment',
        Properties: { VpcId: vpc, InternetGatewayId: { Ref: 'HostInternetGateway' } },
      },
      HostPublicSubnet: {
        Type: 'AWS::EC2::Subnet',
        Properties: {
          VpcId: vpc,
          CidrBlock: PUBLIC_SUBNET_CIDR,
          AvailabilityZone: FIRST_AZ,
          Tags: tags(accountId, { [HOSTED_AWS_HOST_SUBNET_TAG_KEY]: 'public' }),
        },
      },
      HostPublicRouteTable: { Type: 'AWS::EC2::RouteTable', Properties: { VpcId: vpc, Tags: tags(accountId) } },
      HostPublicRoute: {
        Type: 'AWS::EC2::Route',
        DependsOn: 'HostGatewayAttachment',
        Properties: {
          RouteTableId: { Ref: 'HostPublicRouteTable' },
          DestinationCidrBlock: '0.0.0.0/0',
          GatewayId: { Ref: 'HostInternetGateway' },
        },
      },
      HostPublicRouteAssociation: {
        Type: 'AWS::EC2::SubnetRouteTableAssociation',
        Properties: { SubnetId: { Ref: 'HostPublicSubnet' }, RouteTableId: { Ref: 'HostPublicRouteTable' } },
      },
      HostNatAddress: {
        Type: 'AWS::EC2::EIP',
        DependsOn: 'HostGatewayAttachment',
        Properties: { Domain: 'vpc', Tags: tags(accountId) },
      },
      HostNatGateway: {
        Type: 'AWS::EC2::NatGateway',
        Properties: {
          AllocationId: { 'Fn::GetAtt': ['HostNatAddress', 'AllocationId'] },
          SubnetId: { Ref: 'HostPublicSubnet' },
          Tags: tags(accountId),
        },
      },
      HostPrivateSubnet: {
        Type: 'AWS::EC2::Subnet',
        Properties: {
          VpcId: vpc,
          CidrBlock: PRIVATE_SUBNET_CIDR,
          AvailabilityZone: FIRST_AZ,
          Tags: tags(accountId, { [HOSTED_AWS_HOST_SUBNET_TAG_KEY]: 'private' }),
        },
      },
      HostPrivateRouteTable: { Type: 'AWS::EC2::RouteTable', Properties: { VpcId: vpc, Tags: tags(accountId) } },
      HostPrivateRoute: {
        Type: 'AWS::EC2::Route',
        Properties: {
          RouteTableId: { Ref: 'HostPrivateRouteTable' },
          DestinationCidrBlock: '0.0.0.0/0',
          NatGatewayId: { Ref: 'HostNatGateway' },
        },
      },
      HostPrivateRouteAssociation: {
        Type: 'AWS::EC2::SubnetRouteTableAssociation',
        Properties: { SubnetId: { Ref: 'HostPrivateSubnet' }, RouteTableId: { Ref: 'HostPrivateRouteTable' } },
      },
      // No ingress rules at all: Session Manager reaches the host over its outbound connection.
      HostSecurityGroup: {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
          GroupDescription: 'Papercusp workspace host: no inbound access; reached through Session Manager',
          VpcId: vpc,
          SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '0.0.0.0/0' }],
          Tags: tags(accountId),
        },
      },
      HostInstanceRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: names.instanceRoleName,
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
          },
          ManagedPolicyArns: [{ 'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore' }],
          Tags: tags(accountId),
        },
      },
      HostInstanceProfile: {
        Type: 'AWS::IAM::InstanceProfile',
        Properties: { InstanceProfileName: names.instanceProfileName, Roles: [{ Ref: 'HostInstanceRole' }] },
      },
      HostKey: {
        Type: 'AWS::KMS::Key',
        Properties: {
          Description: 'Papercusp workspace host disk encryption',
          EnableKeyRotation: true,
          KeyPolicy: {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'AccountAdministration',
                Effect: 'Allow',
                Principal: { AWS: { 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:root' } },
                Action: 'kms:*',
                Resource: '*',
              },
              {
                Sid: 'WorkspaceHostDiskUse',
                Effect: 'Allow',
                Principal: { AWS: operatorRoleArn },
                Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
                Resource: '*',
              },
              {
                Sid: 'WorkspaceHostDiskGrants',
                Effect: 'Allow',
                Principal: { AWS: operatorRoleArn },
                Action: 'kms:CreateGrant',
                Resource: '*',
                Condition: { Bool: { 'kms:GrantIsForAWSResource': true } },
              },
              // WI-10005389: only EC2 can restart a spot host it interrupted, and it does so as its
              // Spot service-linked role, which must be able to use this key to reattach the host's
              // encrypted disks. Matched by ARN rather than named as the principal: KMS refuses a
              // key policy naming a role that does not exist, and an account that never launched
              // spot has no such role, so naming it would fail stack creation.
              {
                Sid: 'SpotServiceDiskUse',
                Effect: 'Allow',
                Principal: { AWS: '*' },
                Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
                Resource: '*',
                Condition: spotServiceRoleCondition(),
              },
              {
                Sid: 'SpotServiceDiskGrants',
                Effect: 'Allow',
                Principal: { AWS: '*' },
                Action: 'kms:CreateGrant',
                Resource: '*',
                Condition: { ...spotServiceRoleCondition(), Bool: { 'kms:GrantIsForAWSResource': true } },
              },
            ],
          },
          Tags: tags(accountId),
        },
      },
      HostKeyAlias: {
        Type: 'AWS::KMS::Alias',
        Properties: { AliasName: HOSTED_AWS_HOST_KMS_ALIAS, TargetKeyId: { Ref: 'HostKey' } },
      },
      // Created last on purpose: once discovery finds it, the private route through the NAT
      // gateway exists, so a host launched from it can reach Session Manager.
      HostLaunchTemplate: {
        Type: 'AWS::EC2::LaunchTemplate',
        DependsOn: ['HostPrivateRoute', 'HostPrivateRouteAssociation', 'HostInstanceProfile', 'HostKeyAlias'],
        Properties: {
          LaunchTemplateName: names.launchTemplateName,
          LaunchTemplateData: { MetadataOptions: { HttpEndpoint: 'enabled', HttpTokens: 'required' } },
          TagSpecifications: [{ ResourceType: 'launch-template', Tags: tags(accountId) }],
        },
      },
    },
    Outputs: {
      PrivateSubnetId: { Value: { Ref: 'HostPrivateSubnet' } },
      SecurityGroupId: { Value: { Ref: 'HostSecurityGroup' } },
      LaunchTemplateId: { Value: { Ref: 'HostLaunchTemplate' } },
      InstanceProfileArn: { Value: { 'Fn::GetAtt': ['HostInstanceProfile', 'Arn'] } },
      KmsKeyArn: { Value: { 'Fn::GetAtt': ['HostKey', 'Arn'] } },
    },
  };
}
