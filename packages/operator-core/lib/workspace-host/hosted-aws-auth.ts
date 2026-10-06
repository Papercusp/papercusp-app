/**
 * Hosted AWS delegation (aws-byoc-gcp-parity-2026-10-01 P-008, D-001, D-007): the AWS twin of
 * hosted-gcp-auth.ts. It creates each organization's own IAM role in the Papercusp control-plane
 * account on first use, and verifies a customer delegation by walking the real role chain.
 *
 *   control-plane principal -> per-org role (/papercusp/orgs/pco-…) -> customer role (+ ExternalId)
 */
import {
  CreateRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromNodeProviderChain, fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { planAwsSdkCredentialProvider } from './aws-connection';
import { createAwsSdkCredentialProvider } from './aws-sdk-client';
import {
  HostedAwsNotReadyError,
  PAPERCUSP_HOSTED_AWS_HOST_POLICY,
  PAPERCUSP_HOSTED_AWS_LOCATION,
  hostedAwsHostingAdminRole,
  hostedAwsWorkspaceAccount,
  papercuspHostingPolicy,
  papercuspHostingRoleArn,
  papercuspHostingRoleName,
  papercuspHostingTrustPolicy,
} from './hosted-aws-hosting';
import {
  HOSTED_AWS_CUSTOMER_ROLE_NAME_PREFIX,
  HOSTED_AWS_ORGANIZATION_ROLE_PATH,
  hostedAwsControlPlaneAccount,
  hostedAwsControlPlanePrincipal,
  organizationDelegationRoleArn,
  organizationDelegationRoleName,
  organizationExternalId,
  organizationExternalIdRef,
  resolveOrganizationExternalIdRef,
} from './hosted-aws-identity';
import type {
  HostedDelegationOrganization,
  HostedProviderDelegationAdapter,
  HostedProviderDelegationRecord,
} from './hosted-provider-delegation';

type Env = Readonly<Record<string, string | undefined>>;
type AwsCredentials = ReturnType<typeof fromNodeProviderChain>;

/** The two SDK calls this module makes, as a seam (tests inject fakes; production uses SDK v3). */
export interface HostedAwsSender {
  send(command: unknown): Promise<unknown>;
}

export interface HostedAwsAuthDependencies {
  env?: Env;
  /** The control-plane principal that starts every chain (default: the node provider chain). */
  controlPlaneCredentials?: AwsCredentials;
  /** IAM client acting AS the control plane in its own account. */
  iam?: HostedAwsSender;
  /**
   * IAM client acting in Papercusp's AWS hosting account (P-015, D-017): the hosting-admin role
   * when one is configured, else the control plane itself.
   */
  hostingIam?: HostedAwsSender;
  /** STS client acting as the given credentials. */
  sts?: (credentials: AwsCredentials) => HostedAwsSender;
  /** STS is global; any commercial region serves it. */
  region?: string;
}

const DEFAULT_REGION = 'us-east-1';
const CUSTOMER_ROLE_CHAIN_POLICY = 'PapercuspCustomerRoleChain';

function errorName(error: unknown): string {
  return error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '';
}

function partitionOf(arn: string): string {
  return arn.split(':')[1] || 'aws';
}

function controlPlane(deps: HostedAwsAuthDependencies): AwsCredentials {
  return deps.controlPlaneCredentials ?? fromNodeProviderChain({ clientConfig: { region: deps.region ?? DEFAULT_REGION } });
}

function stsFor(deps: HostedAwsAuthDependencies, credentials: AwsCredentials): HostedAwsSender {
  return deps.sts ? deps.sts(credentials) : new STSClient({ region: deps.region ?? DEFAULT_REGION, credentials });
}

export function organizationRoleTrustPolicy(controlPlanePrincipalArn: string): Record<string, unknown> {
  return {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { AWS: controlPlanePrincipalArn }, Action: 'sts:AssumeRole' }],
  };
}

/** A per-org role may assume ONLY roles the onboarding template creates, in any account. */
export function organizationRoleChainPolicy(partition = 'aws'): Record<string, unknown> {
  return {
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Action: 'sts:AssumeRole',
      Resource: `arn:${partition}:iam::*:role/${HOSTED_AWS_CUSTOMER_ROLE_NAME_PREFIX}*`,
    }],
  };
}

export interface EnsureOrganizationDelegationRoleInput {
  organizationId: string;
  accountId: string;
  controlPlanePrincipalArn: string;
  iam: HostedAwsSender;
}

/**
 * Create the organization's role if it does not exist and converge its trust and chain policy.
 * It must exist BEFORE the customer creates their stack: IAM rejects a trust policy naming a
 * nonexistent principal. Idempotent — an existing role has its trust re-asserted, so a role
 * whose trust drifted is repaired rather than trusted.
 */
export async function ensureOrganizationDelegationRole(input: EnsureOrganizationDelegationRoleInput): Promise<string> {
  const roleName = organizationDelegationRoleName(input.organizationId);
  const partition = partitionOf(input.controlPlanePrincipalArn);
  const trust = JSON.stringify(organizationRoleTrustPolicy(input.controlPlanePrincipalArn));
  try {
    await input.iam.send(new CreateRoleCommand({
      RoleName: roleName,
      Path: HOSTED_AWS_ORGANIZATION_ROLE_PATH,
      AssumeRolePolicyDocument: trust,
      Description: 'Papercusp workspace-host delegation identity for one organization (D-001).',
      MaxSessionDuration: 3600,
      Tags: [
        { Key: 'papercusp:managed', Value: 'true' },
        { Key: 'papercusp:role', Value: 'organization-delegation' },
      ],
    }));
  } catch (error) {
    if (errorName(error) !== 'EntityAlreadyExistsException') throw error;
    await input.iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: roleName, PolicyDocument: trust }));
  }
  await input.iam.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: CUSTOMER_ROLE_CHAIN_POLICY,
    PolicyDocument: JSON.stringify(organizationRoleChainPolicy(partition)),
  }));
  return organizationDelegationRoleArn(input.organizationId, input.accountId, partition);
}

export interface EnsurePapercuspAwsHostingRoleInput {
  organizationId: string;
  hostId: string;
  /** Papercusp's AWS hosting account ({@link hostedAwsWorkspaceAccount}). */
  accountId: string;
  /** The organization's own control-plane role: the only principal the hosting role trusts. */
  organizationRoleArn: string;
  /** IAM acting in the hosting account. */
  iam: HostedAwsSender;
  region?: string;
}

/**
 * IAM refuses a trust policy naming a role it cannot see yet. A brand-new organization role is
 * eventually consistent across IAM, so this is "retry shortly", not a failure.
 */
function isInvalidPrincipal(error: unknown): boolean {
  if (errorName(error) !== 'MalformedPolicyDocumentException') return false;
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? '');
  return /invalid principal/i.test(message);
}

/**
 * "Use Papercusp's cloud" on AWS (P-015, D-017): create or converge the organization's hosting
 * role in Papercusp's hosting account, trusted only by the organization's own control-plane role
 * with the organization's ExternalId, and confine it to `hostId` (the AWS twin of
 * ensurePapercuspHostingGrant). Idempotent: an existing role has its trust re-asserted and its
 * policy rewritten for the host now reserved.
 */
export async function ensurePapercuspAwsHostingRole(input: EnsurePapercuspAwsHostingRoleInput): Promise<string> {
  const roleName = papercuspHostingRoleName(input.organizationId);
  const partition = partitionOf(input.organizationRoleArn);
  const trust = JSON.stringify(papercuspHostingTrustPolicy({
    organizationRoleArn: input.organizationRoleArn,
    externalId: organizationExternalId(input.organizationId),
  }));
  // Build the policy before touching IAM, so an invalid host id writes nothing.
  const policy = JSON.stringify(papercuspHostingPolicy({
    organizationId: input.organizationId,
    accountId: input.accountId,
    hostId: input.hostId,
    region: input.region,
    partition,
  }));
  const notReady = (error: unknown): never => {
    if (isInvalidPrincipal(error)) {
      throw new HostedAwsNotReadyError('aws_workspace_host_papercusp_hosting_principal_not_visible');
    }
    throw error;
  };
  try {
    await input.iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: trust,
      Description: 'Papercusp-hosted workspace host for one organization (P-015, D-017).',
      MaxSessionDuration: 3600,
      Tags: [
        { Key: 'papercusp:managed', Value: 'true' },
        { Key: 'papercusp:role', Value: 'papercusp-hosting' },
      ],
    }));
  } catch (error) {
    if (errorName(error) !== 'EntityAlreadyExistsException') notReady(error);
    await input.iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: roleName, PolicyDocument: trust })).catch(notReady);
  }
  await input.iam.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: PAPERCUSP_HOSTED_AWS_HOST_POLICY,
    PolicyDocument: policy,
  }));
  return papercuspHostingRoleArn(input.organizationId, input.accountId, partition);
}

function accountOfArn(arn: string): string {
  return arn.split(':')[4] ?? '';
}

/**
 * IAM in the hosting account. IAM is per account, so control-plane credentials can write the
 * hosting role only when the hosting account IS the control-plane account; otherwise a
 * hosting-admin role in the hosting account is required, never silently skipped.
 */
function hostingIamFor(deps: HostedAwsAuthDependencies, env: Env, hostingAccount: string): HostedAwsSender {
  if (deps.hostingIam) return deps.hostingIam;
  const region = deps.region ?? DEFAULT_REGION;
  const admin = hostedAwsHostingAdminRole(env);
  if (!admin) {
    if (hostingAccount !== hostedAwsControlPlaneAccount(env)) {
      throw new Error('aws_workspace_host_papercusp_hosting_admin_role_required');
    }
    return deps.iam ?? new IAMClient({ region, credentials: controlPlane(deps) });
  }
  if (accountOfArn(admin) !== hostingAccount) {
    throw new Error('aws_workspace_host_papercusp_hosting_admin_role_account_mismatch');
  }
  return new IAMClient({
    region,
    credentials: fromTemporaryCredentials({
      params: { RoleArn: admin, RoleSessionName: 'papercusp-hosting-admin' },
      masterCredentials: controlPlane(deps),
      clientConfig: { region },
    }),
  });
}

/** The AWS half of an organization's delegation binding: its role, created on first use. */
export function awsDelegationOrganization(
  organizationId: string,
  deps: HostedAwsAuthDependencies = {},
): Pick<HostedDelegationOrganization, 'awsTrustedPrincipal' | 'awsPapercuspHosting'> {
  const env = () => deps.env ?? process.env;
  const ensureOrganizationRole = () => {
    const current = env();
    return ensureOrganizationDelegationRole({
      organizationId,
      accountId: hostedAwsControlPlaneAccount(current),
      controlPlanePrincipalArn: hostedAwsControlPlanePrincipal(current),
      iam: deps.iam ?? new IAMClient({ region: deps.region ?? DEFAULT_REGION, credentials: controlPlane(deps) }),
    });
  };
  return {
    async awsTrustedPrincipal() {
      const principalArn = await ensureOrganizationRole();
      return { principalArn, externalIdRef: organizationExternalIdRef(organizationId) };
    },
    async awsPapercuspHosting(hostId) {
      const current = env();
      // Resolve the hosting configuration first: a misconfigured server writes nothing.
      const accountId = hostedAwsWorkspaceAccount(current);
      const hostingIam = hostingIamFor(deps, current, accountId);
      const region = PAPERCUSP_HOSTED_AWS_LOCATION.region;
      const trustedPrincipalArn = await ensureOrganizationRole();
      const roleArn = await ensurePapercuspAwsHostingRole({
        organizationId,
        hostId,
        accountId,
        organizationRoleArn: trustedPrincipalArn,
        iam: hostingIam,
        region,
      });
      return { accountId, region, roleArn, trustedPrincipalArn, externalIdRef: organizationExternalIdRef(organizationId) };
    },
  };
}

function customerRoleSource(record: HostedProviderDelegationRecord) {
  const configuration = record.configuration;
  if (configuration.provider !== 'aws') throw new Error('hosted_provider_delegation_aws_record_required');
  const source = configuration.source;
  if (source.environment !== 'hosted' || source.method !== 'customer-role') {
    throw new Error('hosted_provider_delegation_aws_method_not_organization_bound');
  }
  if (!record.organizationId) throw new Error('hosted_provider_delegation_organization_required');
  return {
    accountId: configuration.accountId,
    source,
    organizationId: record.organizationId,
    papercuspHosted: configuration.papercuspHosted,
  };
}

/**
 * The production AWS delegation adapter. `verify` proves three things through the real chain:
 * the record is bound to ITS organization (principal and ExternalId are that org's), the chain
 * lands in the customer's account as the customer's role, and the customer's role REFUSES the
 * same per-org principal without the ExternalId — a trust policy that skips the condition is
 * marked invalid rather than accepted. `revoke` records the revocation; credential resolution
 * for the connection is gated on a verified delegation (aws-configured-provider), which is where
 * a revoked delegation stops acting — the same semantics as the GCP adapter.
 */
export function awsProviderDelegationAdapter(deps: HostedAwsAuthDependencies = {}): HostedProviderDelegationAdapter {
  return {
    async verify(record) {
      const { accountId, source, organizationId, papercuspHosted } = customerRoleSource(record);
      const env = deps.env ?? process.env;
      const partition = partitionOf(source.roleArn);
      const expectedPrincipal = organizationDelegationRoleArn(organizationId, hostedAwsControlPlaneAccount(env), partition);
      if (source.trustedPrincipalArn !== expectedPrincipal) {
        throw new Error('hosted_provider_delegation_aws_principal_not_organization');
      }
      if (source.externalIdRef !== organizationExternalIdRef(organizationId)) {
        throw new Error('hosted_provider_delegation_aws_external_id_not_organization');
      }
      if (papercuspHosted) {
        // D-017: a Papercusp-hosted record must name Papercusp's hosting account and THIS
        // organization's hosting role there, never another organization's or a customer's.
        if (accountId !== hostedAwsWorkspaceAccount(env)) {
          throw new Error('hosted_provider_delegation_aws_papercusp_hosted_account_mismatch');
        }
        if (source.roleArn !== papercuspHostingRoleArn(organizationId, accountId, partition)) {
          throw new Error('hosted_provider_delegation_aws_papercusp_hosted_role_not_organization');
        }
      }
      const region = deps.region ?? DEFAULT_REGION;
      const root = controlPlane(deps);
      const customer = createAwsSdkCredentialProvider(planAwsSdkCredentialProvider(source), region, {
        resolveExternalId: resolveOrganizationExternalIdRef,
        controlPlaneCredentials: root,
      });
      const caller = await stsFor(deps, customer).send(new GetCallerIdentityCommand({})) as {
        Account?: string; Arn?: string; $metadata?: { requestId?: string };
      };
      const roleName = source.roleArn.split('/').pop() ?? '';
      if (caller.Account !== accountId) throw new Error('hosted_provider_delegation_aws_account_mismatch');
      if (!caller.Arn?.startsWith(`arn:${partition}:sts::${accountId}:assumed-role/${roleName}/`)) {
        throw new Error('hosted_provider_delegation_aws_role_mismatch');
      }
      const orgRole = fromTemporaryCredentials({
        params: { RoleArn: expectedPrincipal, RoleSessionName: 'papercusp-org-delegation' },
        masterCredentials: root,
        clientConfig: { region },
      });
      try {
        await stsFor(deps, orgRole).send(new AssumeRoleCommand({
          RoleArn: source.roleArn,
          RoleSessionName: 'papercusp-external-id-probe',
          DurationSeconds: 900,
        }));
      } catch (error) {
        if (errorName(error) !== 'AccessDenied' && errorName(error) !== 'AccessDeniedException') throw error;
        return {
          identity: caller.Arn,
          evidenceRef: `aws://accounts/${accountId}/delegations/${record.connectionId}/${record.generation}/sts/${caller.$metadata?.requestId ?? 'unknown'}`,
        };
      }
      throw new Error('hosted_provider_delegation_aws_external_id_not_enforced');
    },
    async revoke(record) {
      return { evidenceRef: `delegation://${record.workspaceId}/${record.connectionId}/${record.generation}/revoked` };
    },
  };
}
