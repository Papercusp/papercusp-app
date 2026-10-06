/**
 * Short-lived GCP auth for hosted workspace-provider delegations.
 *
 * THE DELEGATION SOURCE (D-386). A `service-account-impersonation` delegation is the customer
 * granting `roles/iam.serviceAccountTokenCreator` on THEIR service account to ONE Papercusp
 * identity — the source. On GCE the source is the metadata service account. Off GCE there is
 * no metadata server (measured: `metadata.google.internal` does not resolve on the box that
 * runs the hosted control plane and the bg-host), so the source is the service-account key
 * file named by {@link HOSTED_GCP_DELEGATION_SOURCE_ENV}, set on every process that verifies
 * or provisions. It is deliberately NOT the ambient GOOGLE_APPLICATION_CREDENTIALS and never
 * a user login.
 *
 * NO CUSTOMER GRANTS THE SOURCE ITSELF (D-397). If every customer granted the one source, any
 * signed-up organization could name ANOTHER customer's service account and Papercusp would
 * impersonate it on the attacker's behalf. Each organization instead gets its OWN Papercusp
 * service account in a dedicated identity project ({@link HOSTED_GCP_ORGANIZATION_IDENTITY_PROJECT_ENV});
 * the customer grants THAT account, and every token is minted through the chain
 * source -> organization account -> customer account. The source holds token-creator on the
 * identity project only, so it can reach a customer account solely through the organization
 * account that customer named, and a delegation recorded for one organization can never
 * resolve through another's account.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GoogleAuth, type JWTInput } from 'google-auth-library';
import type { GcpResolvedAuth } from '../cloud-workspaces/gcp-preflight';
import { ensurePapercuspHostingGrant, hostedGcpWorkspaceProject, HostedGcpNotReadyError } from './hosted-gcp-hosting';
import type { HostedDelegationOrganization, HostedProviderDelegationRecord } from './hosted-provider-delegation';

const METADATA_ROOT = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default';
const IAM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const IAM_ROOT = 'https://iam.googleapis.com/v1';

/** Path to the delegation source's service-account key file. Unset = the GCE metadata identity. */
export const HOSTED_GCP_DELEGATION_SOURCE_ENV = 'PAPERCUSP_HOSTED_GCP_DELEGATION_SOURCE_CREDENTIALS';

/** The GCP project that holds one Papercusp service account per organization (D-397). */
export const HOSTED_GCP_ORGANIZATION_IDENTITY_PROJECT_ENV = 'PAPERCUSP_HOSTED_GCP_ORGANIZATION_IDENTITY_PROJECT';

const GCP_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export function hostedGcpOrganizationIdentityProject(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const project = env[HOSTED_GCP_ORGANIZATION_IDENTITY_PROJECT_ENV]?.trim();
  if (!project) throw new Error('gcp_workspace_host_organization_identity_project_unconfigured');
  if (!GCP_PROJECT_ID.test(project)) throw new Error('gcp_workspace_host_organization_identity_project_invalid');
  return project;
}

/**
 * The organization's service-account id: a digest, so it is stable, fits GCP's 6-30 character
 * limit, and reveals nothing about the organization to the customer who sees it in a grant.
 */
export function organizationDelegationAccountId(organizationId: string): string {
  const id = organizationId.trim();
  if (!id) throw new Error('gcp_workspace_host_organization_required');
  return `pco-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
}

export function organizationDelegationEmail(organizationId: string, identityProject: string): string {
  return `${organizationDelegationAccountId(organizationId)}@${identityProject}.iam.gserviceaccount.com`;
}

/** The IAM member a customer grants token-creator to, for THIS organization only. */
export function organizationDelegationPrincipal(organizationId: string, identityProject: string): string {
  return `serviceAccount:${organizationDelegationEmail(organizationId, identityProject)}`;
}

export interface EnsureOrganizationDelegationAccountInput {
  organizationId: string;
  identityProject: string;
  source: HostedGcpDelegationSource;
  fetch?: typeof fetch;
}

/**
 * Create the organization's service account if it does not exist yet, and return its IAM
 * member. It must exist BEFORE the customer applies the grant: GCP rejects a policy binding
 * that names a nonexistent service account. Idempotent — an existing account (200 on read,
 * or 409 when a concurrent call created it first) is success.
 */
export async function ensureOrganizationDelegationAccount(
  input: EnsureOrganizationDelegationAccountInput,
): Promise<string> {
  const fetchImpl = input.fetch ?? fetch;
  const accountId = organizationDelegationAccountId(input.organizationId);
  const email = organizationDelegationEmail(input.organizationId, input.identityProject);
  const headers = { authorization: `Bearer ${await input.source.accessToken()}`, 'content-type': 'application/json' };
  const project = encodeURIComponent(input.identityProject);
  const existing = await fetchImpl(`${IAM_ROOT}/projects/${project}/serviceAccounts/${encodeURIComponent(email)}`, { headers });
  if (!existing.ok) {
    if (existing.status !== 404) throw new Error(`gcp_workspace_host_organization_account_read_failed:${existing.status}`);
    const created = await fetchImpl(`${IAM_ROOT}/projects/${project}/serviceAccounts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        accountId,
        serviceAccount: {
          displayName: `Papercusp organization ${accountId.slice('pco-'.length, 'pco-'.length + 8)}`,
          description: 'Papercusp workspace-host delegation identity for one organization (D-397).',
        },
      }),
    });
    if (!created.ok && created.status !== 409) {
      const message = `gcp_workspace_host_organization_account_create_failed:${created.status}`;
      // Measured under concurrent sign-ups: account creation is rate limited (429), then succeeds.
      if (created.status === 429) throw new HostedGcpNotReadyError(message);
      throw new Error(message);
    }
  }
  return `serviceAccount:${email}`;
}

/**
 * The GCP half of an organization's delegation binding: the account customers of THIS
 * organization grant, created on first use.
 */
export function gcpDelegationOrganization(
  organizationId: string,
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    fetch?: typeof fetch;
    source?: HostedGcpDelegationSource;
  } = {},
): Omit<HostedDelegationOrganization, 'awsTrustedPrincipal' | 'awsPapercuspHosting'> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const ensureAccount = () => {
    const source = options.source ?? hostedGcpDelegationSource(env, fetchImpl);
    return ensureOrganizationDelegationAccount({
      organizationId,
      identityProject: hostedGcpOrganizationIdentityProject(env),
      source,
      fetch: fetchImpl,
    }).then((member) => ({ member, source }));
  };
  return {
    organizationId,
    async gcpTrustedPrincipal() {
      return (await ensureAccount()).member;
    },
    async gcpPapercuspHosting(hostId) {
      const projectId = hostedGcpWorkspaceProject(env);
      const { member, source } = await ensureAccount();
      await ensurePapercuspHostingGrant({
        projectId,
        member,
        hostId,
        accessToken: () => source.accessToken(),
        fetch: fetchImpl,
      });
      return { projectId, serviceAccountEmail: organizationDelegationEmail(organizationId, hostedGcpOrganizationIdentityProject(env)) };
    },
  };
}

/** The Papercusp identity that impersonates customer service accounts. */
export interface HostedGcpDelegationSource {
  /** IAM member form, e.g. `serviceAccount:papercusp-delegation@p.iam.gserviceaccount.com`. */
  principal(): Promise<string>;
  accessToken(): Promise<string>;
}

export interface HostedGcpAuthResolverInput {
  credentialRef: string;
  provider: Readonly<Record<string, unknown>>;
}

export interface HostedGcpAuthResolverDependencies {
  fetch?: typeof fetch;
  source?: HostedGcpDelegationSource;
  /** Default: {@link HOSTED_GCP_ORGANIZATION_IDENTITY_PROJECT_ENV}. */
  identityProject?: string;
  /** Default: the configured Papercusp hosting project (hosted-gcp-hosting.ts). */
  hostingProject?: string;
}

type GcpDelegationRecord = HostedProviderDelegationRecord & {
  configuration: Extract<HostedProviderDelegationRecord['configuration'], { provider: 'gcp' }>;
};

function delegation(input: HostedGcpAuthResolverInput): GcpDelegationRecord {
  const value = input.provider.hostedDelegation as HostedProviderDelegationRecord | undefined;
  if (!value || value.schemaVersion !== 'hosted-provider-delegation-v1') {
    throw new Error('gcp_workspace_host_hosted_delegation_metadata_missing');
  }
  if (value.provider !== 'gcp' || value.configuration.provider !== 'gcp') {
    throw new Error('gcp_workspace_host_hosted_delegation_provider_mismatch');
  }
  if (value.credentialRef !== input.credentialRef.trim()) {
    throw new Error('gcp_workspace_host_hosted_delegation_reference_mismatch');
  }
  if (value.status !== 'verified') {
    throw new Error('gcp_workspace_host_hosted_delegation_not_verified');
  }
  return value as GcpDelegationRecord;
}

async function json<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error(`gcp_workspace_host_hosted_auth_exchange_failed:${response.status}`);
  return (await response.json()) as T;
}

async function metadataToken(fetchImpl: typeof fetch): Promise<string> {
  const response = await json<{ access_token?: string }>(fetchImpl, `${METADATA_ROOT}/token`, {
    headers: { 'metadata-flavor': 'Google' },
  });
  if (!response.access_token) throw new Error('gcp_workspace_host_metadata_access_token_missing');
  return response.access_token;
}

/** The GCE metadata service account as the delegation source. */
export function metadataDelegationSource(fetchImpl: typeof fetch = fetch): HostedGcpDelegationSource {
  return {
    async principal() {
      const response = await fetchImpl(`${METADATA_ROOT}/email`, { headers: { 'metadata-flavor': 'Google' } });
      if (!response.ok) throw new Error(`gcp_workspace_host_metadata_email_failed:${response.status}`);
      const email = (await response.text()).trim();
      if (!email) throw new Error('gcp_workspace_host_metadata_email_missing');
      return `serviceAccount:${email}`;
    },
    accessToken: () => metadataToken(fetchImpl),
  };
}

/**
 * A service-account key file as the delegation source. The file is read lazily, once; a key
 * of any other type (an `authorized_user` gcloud login above all) refuses, because every
 * customer grant would otherwise trust a person's account.
 */
export function keyFileDelegationSource(keyFile: string): HostedGcpDelegationSource {
  let loaded: Promise<{ email: string; auth: GoogleAuth }> | null = null;
  const load = () => {
    loaded ??= readFile(keyFile, 'utf8')
      .catch(() => {
        throw new Error('gcp_workspace_host_delegation_source_unreadable');
      })
      .then((text) => {
        const key = JSON.parse(text) as JWTInput;
        if (key.type !== 'service_account' || typeof key.client_email !== 'string' || !key.client_email) {
          throw new Error('gcp_workspace_host_delegation_source_not_service_account');
        }
        return { email: key.client_email, auth: new GoogleAuth({ credentials: key, scopes: [IAM_SCOPE] }) };
      })
      .catch((error: unknown) => {
        loaded = null;
        throw error;
      });
    return loaded;
  };
  return {
    async principal() {
      return `serviceAccount:${(await load()).email}`;
    },
    async accessToken() {
      const token = await (await load()).auth.getAccessToken();
      if (!token) throw new Error('gcp_workspace_host_delegation_source_access_token_missing');
      return token;
    },
  };
}

let configuredSource: { keyFile: string; source: HostedGcpDelegationSource } | null = null;

/** The configured delegation source: the key file in {@link HOSTED_GCP_DELEGATION_SOURCE_ENV}, else metadata. */
export function hostedGcpDelegationSource(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch,
): HostedGcpDelegationSource {
  const keyFile = env[HOSTED_GCP_DELEGATION_SOURCE_ENV]?.trim();
  if (!keyFile) return metadataDelegationSource(fetchImpl);
  // One client per key file, so its token cache survives across resolutions.
  if (configuredSource?.keyFile !== keyFile) configuredSource = { keyFile, source: keyFileDelegationSource(keyFile) };
  return configuredSource.source;
}

/**
 * The organization account a service-account-impersonation delegation must chain through.
 * The recorded grant has to name EXACTLY the owning organization's account: a principal of
 * any other shape — the source itself above all, or another organization's account — is
 * refused before any token is minted.
 */
function organizationDelegate(record: GcpDelegationRecord, identityProject: string): string {
  const organizationId = record.organizationId?.trim();
  if (!organizationId) throw new Error('gcp_workspace_host_delegation_organization_missing');
  const source = record.configuration.source;
  if (source.method !== 'service-account-impersonation') {
    throw new Error('gcp_workspace_host_delegation_method_not_organization_bound');
  }
  if (source.trustedPrincipal !== organizationDelegationPrincipal(organizationId, identityProject)) {
    throw new Error('gcp_workspace_host_delegation_trusted_principal_not_organization_account');
  }
  return organizationDelegationEmail(organizationId, identityProject);
}

/**
 * A Papercusp-hosted delegation (D-399) acts AS the organization's own account, in the ONE
 * configured hosting project; a record naming any other account or project is refused, so a
 * tampered record can neither borrow another organization's reservation nor leave the project.
 */
function papercuspHostedTarget(
  record: GcpDelegationRecord,
  identityProject: string,
  hostingProject: string,
): Extract<GcpDelegationRecord['configuration']['source'], { method: 'papercusp-hosted' }> {
  const organizationId = record.organizationId?.trim();
  if (!organizationId) throw new Error('gcp_workspace_host_delegation_organization_missing');
  const source = record.configuration.source;
  if (source.method !== 'papercusp-hosted') throw new Error('gcp_workspace_host_delegation_method_not_papercusp_hosted');
  if (source.serviceAccountEmail !== organizationDelegationEmail(organizationId, identityProject)) {
    throw new Error('gcp_workspace_host_papercusp_hosted_account_not_organization_account');
  }
  if (source.projectId !== hostingProject) throw new Error('gcp_workspace_host_papercusp_hosted_project_mismatch');
  return source;
}

/**
 * Resolve a verified delegation to a one-hour IAM Credentials token, minted through the owning
 * organization's account (or, Papercusp-hosted, AS it). The persisted record contains metadata
 * and an opaque reference only; the source token and returned access token exist in memory for
 * this call and are never written to the connection store.
 *
 * Workload identity is refused: every organization would federate as the same Papercusp
 * subject, which is exactly the shared identity D-397 removes.
 */
export async function resolveHostedGcpAuth(
  input: HostedGcpAuthResolverInput,
  dependencies: HostedGcpAuthResolverDependencies = {},
): Promise<GcpResolvedAuth> {
  const record = delegation(input);
  const source = record.configuration.source;
  const fetchImpl = dependencies.fetch ?? fetch;
  const identityProject = dependencies.identityProject ?? hostedGcpOrganizationIdentityProject();
  let delegates: string[];
  if (source.method === 'papercusp-hosted') {
    papercuspHostedTarget(record, identityProject, dependencies.hostingProject ?? hostedGcpWorkspaceProject());
    // The organization's account IS the target: the source mints it directly.
    delegates = [];
  } else {
    delegates = [`projects/-/serviceAccounts/${organizationDelegate(record, identityProject)}`];
  }
  const sourceToken = await (dependencies.source ?? hostedGcpDelegationSource(process.env, fetchImpl)).accessToken();
  const serviceAccount = encodeURIComponent(source.serviceAccountEmail);
  const minted = await json<{ accessToken?: string }>(
    fetchImpl,
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${sourceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ delegates, scope: [IAM_SCOPE], lifetime: '3600s' }),
    },
  );
  if (!minted.accessToken) throw new Error('gcp_workspace_host_impersonated_access_token_missing');
  return {
    accessToken: minted.accessToken,
    identity: source.serviceAccountEmail,
    projectId: source.projectId,
  };
}

export function isHostedProviderCredentialRef(value: string): boolean {
  return /^(?:encrypted|resolver|delegation):\/\//.test(value.trim());
}
