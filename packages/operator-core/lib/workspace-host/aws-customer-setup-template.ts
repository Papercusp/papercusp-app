/**
 * Customer-run AWS setup template (plan aws-byoc-gcp-parity-2026-10-01, P-013 / D-011).
 *
 * The hosted path (app.papercusp.com) already hands the customer a CloudFormation template built by
 * hosted-provider-delegation.ts. The desktop path has none: its connection form asks for a VPC,
 * subnet, security group, launch template, instance profile and KMS key the customer would otherwise
 * build by hand, while the GCP provider builds its network itself. This module closes that gap with
 * ONE template the customer creates in their own account:
 *
 *   - a role whose only policy is AWS_WORKSPACE_HOST_PERMISSION_ACTIONS (the same least-privilege set
 *     the preflight checks and the hosted role carries), trusting a principal the customer names;
 *   - the host network, instance profile, KMS key and launch template from hostedAwsHostStackFragment,
 *     the same resources a hosted customer's stack builds (D-009).
 *
 * Every Output maps onto one connection-form field (AWS_CUSTOMER_SETUP_CONNECTION_FIELDS), so the
 * customer copies stack outputs into the form instead of looking resource IDs up. The workspace image
 * still comes from the image catalog (D-005), not the stack.
 *
 * Nothing here is secret: no ExternalId is required on this path because the trusted principal is the
 * customer's own account or a principal inside it, never Papercusp's.
 */
import { assertWorkspaceHostSecretIsolation } from '@papercusp/deployment-driver';
import { AWS_WORKSPACE_HOST_PERMISSION_ACTIONS } from './aws-connection';
import {
  HOSTED_AWS_HOST_TAG_KEY,
  HOSTED_AWS_REGION,
  awsSpotServiceLinkedRoleStatement,
  hostedAwsHostStackFragment,
  type AwsSpotServiceLinkedRoleStatement,
} from './hosted-aws-host-stack';

export const AWS_CUSTOMER_SETUP_TEMPLATE_VERSION = 'aws-customer-setup-template-v1';
export const AWS_CUSTOMER_OPERATOR_ROLE_NAME_PREFIX = 'PapercuspWorkspaceHostOperator-';
export const AWS_CUSTOMER_OPERATOR_ROLE_LOGICAL_ID = 'WorkspaceHostOperatorRole';
export const AWS_CUSTOMER_OPERATOR_POLICY_NAME = 'PapercuspWorkspaceHostLifecycle';

const AWS_ACCOUNT = /^\d{12}$/;
/** An IAM role, user or account-root principal inside one account, in any commercial partition. */
const AWS_PRINCIPAL_ARN = /^arn:aws(?:-[a-z]+)*:iam::(\d{12}):(?:root|role\/[\w+=,.@/-]{1,512}|user\/[\w+=,.@/-]{1,512})$/;

/**
 * Stack output → connection-form field. The desktop connection route
 * (routes/workspace-hosts/connection.ts) reads these field names; the template's Outputs carry
 * exactly these keys. `securityGroupIds` takes the one group as a single-element list, and the role
 * goes into a local assume-role credential source (`credentialSource.roleArn`).
 */
export const AWS_CUSTOMER_SETUP_CONNECTION_FIELDS = {
  OperatorRoleArn: 'credentialSource.roleArn',
  VpcId: 'vpcId',
  PrivateSubnetId: 'subnetId',
  SecurityGroupId: 'securityGroupIds',
  LaunchTemplateId: 'launchTemplateId',
  InstanceProfileArn: 'instanceProfileArn',
  KmsKeyArn: 'kmsKeyArn',
} as const;

export type AwsCustomerSetupOutputKey = keyof typeof AWS_CUSTOMER_SETUP_CONNECTION_FIELDS;

export interface AwsCustomerSetupTemplateRequest {
  /** The 12-digit account the stack is created in. */
  accountId: string;
  /** The region the workspace host runs in; the template refuses to create anywhere else. */
  region: string;
  /**
   * The principal allowed to assume the operator role — the identity behind the customer's local AWS
   * profile. Must live in `accountId`. Defaults to the account root, which delegates the choice to the
   * customer's own IAM policies (a principal still needs sts:AssumeRole on the role to use it).
   */
  principalArn?: string;
}

export interface AwsCustomerSetupTemplate {
  version: typeof AWS_CUSTOMER_SETUP_TEMPLATE_VERSION;
  format: 'aws-cloudformation-json';
  accountId: string;
  region: string;
  roleName: string;
  principalArn: string;
  /** Suggested stack name; the template does not depend on it. */
  stackName: string;
  document: Record<string, unknown>;
}

/**
 * The least-privilege policy alone, for a customer who attaches it to an existing role or user.
 * The second statement lets a spot host's first launch create EC2's Spot service-linked role
 * (WI-10005389) and no other role; an identity policy only reaches its own account, so the
 * account segment is a wildcard and the same document works standalone and in the stack.
 */
export function awsWorkspaceHostLeastPrivilegePolicy(): {
  Version: '2012-10-17';
  Statement: [
    { Sid: string; Effect: 'Allow'; Action: string[]; Resource: '*' },
    AwsSpotServiceLinkedRoleStatement,
  ];
} {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'PapercuspWorkspaceHostLifecycle',
        Effect: 'Allow',
        Action: [...AWS_WORKSPACE_HOST_PERMISSION_ACTIONS],
        Resource: '*',
      },
      awsSpotServiceLinkedRoleStatement('*'),
    ],
  };
}

function validated(request: AwsCustomerSetupTemplateRequest): Required<AwsCustomerSetupTemplateRequest> {
  const accountId = String(request.accountId ?? '').trim();
  if (!AWS_ACCOUNT.test(accountId)) throw new Error('accountId must be a 12-digit AWS account ID');
  const region = String(request.region ?? '').trim();
  if (!HOSTED_AWS_REGION.test(region)) throw new Error('region must be a commercial AWS region such as us-east-1');
  const principalArn = request.principalArn === undefined || String(request.principalArn).trim() === ''
    ? `arn:aws:iam::${accountId}:root`
    : String(request.principalArn).trim();
  const match = AWS_PRINCIPAL_ARN.exec(principalArn);
  if (!match) throw new Error('principalArn must be an IAM role, user or account root ARN');
  if (match[1] !== accountId) throw new Error('principalArn must belong to accountId');
  return { accountId, region, principalArn };
}

export function awsCustomerSetupTemplate(request: AwsCustomerSetupTemplateRequest): AwsCustomerSetupTemplate {
  const { accountId, region, principalArn } = validated(request);
  const host = hostedAwsHostStackFragment(accountId, region, AWS_CUSTOMER_OPERATOR_ROLE_LOGICAL_ID);
  const roleName = `${AWS_CUSTOMER_OPERATOR_ROLE_NAME_PREFIX}${accountId}`;
  const hostOutputs = host.Outputs as Record<string, unknown>;
  const document: Record<string, unknown> = {
    AWSTemplateFormatVersion: '2010-09-09',
    Description:
      'Papercusp workspace host for the desktop app: a least-privilege operator role and the network, '
      + 'instance profile, KMS key and launch template the host launches into',
    Rules: host.Rules,
    Resources: {
      [AWS_CUSTOMER_OPERATOR_ROLE_LOGICAL_ID]: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: roleName,
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { AWS: principalArn }, Action: 'sts:AssumeRole' }],
          },
          Policies: [{ PolicyName: AWS_CUSTOMER_OPERATOR_POLICY_NAME, PolicyDocument: awsWorkspaceHostLeastPrivilegePolicy() }],
          Tags: [{ Key: HOSTED_AWS_HOST_TAG_KEY, Value: accountId }],
        },
      },
      ...host.Resources,
    },
    Outputs: {
      OperatorRoleArn: {
        Description: 'Role ARN for the desktop connection form',
        Value: { 'Fn::GetAtt': [AWS_CUSTOMER_OPERATOR_ROLE_LOGICAL_ID, 'Arn'] },
      },
      VpcId: { Description: 'VPC ID for the desktop connection form', Value: { Ref: 'HostVpc' } },
      ...hostOutputs,
    },
  };
  const template: AwsCustomerSetupTemplate = {
    version: AWS_CUSTOMER_SETUP_TEMPLATE_VERSION,
    format: 'aws-cloudformation-json',
    accountId,
    region,
    roleName,
    principalArn,
    stackName: `papercusp-workspace-host-${region}`,
    document,
  };
  assertWorkspaceHostSecretIsolation(template, 'awsCustomerSetupTemplate');
  return template;
}
