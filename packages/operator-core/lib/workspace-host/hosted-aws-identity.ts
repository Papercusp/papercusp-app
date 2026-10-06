/**
 * The AWS half of the hosted identity model (aws-byoc-gcp-parity-2026-10-01 D-001, P-008):
 * pure naming and ExternalId derivation, kept free of the AWS SDK so the delegation module and
 * its template builder can import it without pulling SDK clients into their graph.
 *
 * Papercusp acts in a customer account only through a role chain:
 *   control-plane principal -> the organization's OWN role in the Papercusp control-plane account
 *   (path /papercusp/orgs/) -> the customer's role, whose trust policy names only that per-org role
 *   and requires the organization's ExternalId.
 */
import { createHash } from 'node:crypto';

/** The AWS account that holds one Papercusp IAM role per organization. */
export const HOSTED_AWS_CONTROL_PLANE_ACCOUNT_ENV = 'PAPERCUSP_HOSTED_AWS_CONTROL_PLANE_ACCOUNT_ID';
/** The control-plane principal every per-org role trusts (and nothing else does). */
export const HOSTED_AWS_CONTROL_PLANE_PRINCIPAL_ENV = 'PAPERCUSP_HOSTED_AWS_CONTROL_PLANE_PRINCIPAL_ARN';

export const HOSTED_AWS_ORGANIZATION_ROLE_PATH = '/papercusp/orgs/';
/** Customer roles are created by the onboarding template under this name prefix. */
export const HOSTED_AWS_CUSTOMER_ROLE_NAME_PREFIX = 'PapercuspWorkspaceHost-';
export const HOSTED_AWS_EXTERNAL_ID_REF_PREFIX = 'resolver://aws-external-id/';

const AWS_ACCOUNT_ID = /^\d{12}$/;
const IAM_PRINCIPAL_ARN = /^arn:(aws|aws-us-gov|aws-cn):iam::\d{12}:(role|user)\/[\w+=,.@/-]{1,512}$/;
const ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

type Env = Readonly<Record<string, string | undefined>>;

function requireOrganizationId(organizationId: string): string {
  const id = organizationId.trim();
  if (!ORGANIZATION_ID.test(id)) throw new Error('aws_workspace_host_organization_invalid');
  return id;
}

export function hostedAwsControlPlaneAccount(env: Env = process.env): string {
  const account = env[HOSTED_AWS_CONTROL_PLANE_ACCOUNT_ENV]?.trim();
  if (!account) throw new Error('aws_workspace_host_control_plane_account_unconfigured');
  if (!AWS_ACCOUNT_ID.test(account)) throw new Error('aws_workspace_host_control_plane_account_invalid');
  return account;
}

export function hostedAwsControlPlanePrincipal(env: Env = process.env): string {
  const arn = env[HOSTED_AWS_CONTROL_PLANE_PRINCIPAL_ENV]?.trim();
  if (!arn) throw new Error('aws_workspace_host_control_plane_principal_unconfigured');
  if (!IAM_PRINCIPAL_ARN.test(arn)) throw new Error('aws_workspace_host_control_plane_principal_invalid');
  return arn;
}

/**
 * The organization's role name: the same digest GCP uses for its per-org service account, so
 * one organization is recognisable across clouds while revealing nothing about it to a customer
 * who sees the ARN in their trust policy.
 */
export function organizationDelegationRoleName(organizationId: string): string {
  const id = requireOrganizationId(organizationId);
  return `pco-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
}

export function organizationDelegationRoleArn(organizationId: string, accountId: string, partition = 'aws'): string {
  if (!AWS_ACCOUNT_ID.test(accountId)) throw new Error('aws_workspace_host_control_plane_account_invalid');
  return `arn:${partition}:iam::${accountId}:role${HOSTED_AWS_ORGANIZATION_ROLE_PATH}${organizationDelegationRoleName(organizationId)}`;
}

/**
 * The organization's ExternalId (D-007): derived from the organization alone, so the customer
 * never chooses it and every connection of one organization presents the same value. It is not a
 * secret — AWS documents ExternalId as a confused-deputy guard, and the per-org principal is the
 * primary isolation — but it is unique per organization and stable across rotations.
 */
export function organizationExternalId(organizationId: string): string {
  const id = requireOrganizationId(organizationId);
  return `pcx-${createHash('sha256').update(`papercusp-aws-external-id-v1:${id}`).digest('hex').slice(0, 40)}`;
}

export function organizationExternalIdRef(organizationId: string): string {
  return `${HOSTED_AWS_EXTERNAL_ID_REF_PREFIX}${requireOrganizationId(organizationId)}`;
}

/** The organization an ExternalId reference belongs to, or null when it is not one of ours. */
export function externalIdRefOrganization(externalIdRef: string): string | null {
  if (!externalIdRef.startsWith(HOSTED_AWS_EXTERNAL_ID_REF_PREFIX)) return null;
  const id = externalIdRef.slice(HOSTED_AWS_EXTERNAL_ID_REF_PREFIX.length);
  return ORGANIZATION_ID.test(id) ? id : null;
}

/** Resolve `resolver://aws-external-id/<org>`; any other reference is refused. */
export async function resolveOrganizationExternalIdRef(externalIdRef: string): Promise<string> {
  const organizationId = externalIdRefOrganization(externalIdRef);
  if (!organizationId) throw new Error('aws_workspace_host_external_id_ref_unrecognized');
  return organizationExternalId(organizationId);
}
