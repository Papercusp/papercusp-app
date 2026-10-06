/**
 * Hosted FIRST-WORKSPACE bootstrap — the one entry into the hosted steady state.
 *
 * WHY THIS EXISTS (plan byoc-cloud-workspaces-gcp-aws-azure-2026-08-22, D-381/D-383/D-384).
 * A brand-new hosted organization cannot reach any workspace-scoped route, because every
 * one of them requires an already-selected workspace. Underneath that HTTP gate, the data
 * model is a cycle that no hosted_app transaction can enter:
 *
 *   connection  needs a host that references it   (migration 979 hosted_app RLS, D-384)
 *   host        needs a connection                 (workspace_hosts.connection_id NOT NULL)
 *   binding     needs a host                       (customer_workspaces.workspace_host_id NOT NULL)
 *   every route needs a selected binding           (selectedHostedPrincipal)
 *
 * This module breaks the cycle from OUTSIDE it, under control-plane privilege, exactly once
 * per organization. It is an ADDITIONAL narrow door: it relaxes none of the hosted_app
 * predicates, none of the NOT NULLs, and not `selectedHostedPrincipal`.
 *
 * WHAT MAKES CONTROL-PLANE PRIVILEGE SAFE HERE — every identifier is SERVER-DERIVED.
 * Under control-plane privilege the organization predicate that protects tenants is not in
 * force, so a caller-chosen identifier would be a cross-tenant write primitive: a caller
 * naming another organization's connection id would overwrite its credential reference.
 * The workspace id, host id, provisioning operation id, connection id AND the credential
 * reference are all derived from `admissionIdentity(organizationId, operationKey)`, a digest
 * that mixes in the caller's (session-authenticated) organization. The request body supplies
 * only display text and the provider delegation configuration.
 *
 * IDEMPOTENT BY ATTEMPT KEY. The same attempt key always derives the same identifiers, so the
 * browser can call this repeatedly: the first call records the delegation and returns the
 * grant template the customer must apply in their cloud; later calls re-verify the SAME
 * delegation and, once it verifies, admit the workspace and select it on the session.
 *
 * ORGANIZATION-BOUND DELEGATION (D-397, closes the D-384 confused deputy). The customer grants
 * THIS organization's own Papercusp service account, and credentials resolve only through it,
 * so naming another customer's service account can never verify. `isEnabledFor` still gates
 * the route per organization until that is verified live; do not replace it with `() => true`.
 *
 * TWO WAYS TO HOST IT (D-399). `papercusp`: the host runs in Papercusp's own cloud and the
 * request carries no cloud configuration at all — the delegation reserves the derived host for
 * the organization, and the browser's configuration, if any, is ignored. `byoc`: the customer's
 * own GCP project, granted as above, or their own AWS account (aws-byoc-gcp-parity D-008/D-009):
 * the browser names only the account and region; the role, its trusted principal and ExternalId
 * are server-derived, and the customer's CloudFormation stack builds the host's network, which
 * the server reads back through the verified role before admitting the workspace.
 */
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import {
  bindDelegationToOrganization,
  bindPapercuspHostedDelegation,
  buildHostedProviderDelegationOnboarding,
  type HostedDelegationOrganization,
  type HostedProviderDelegationConfiguration,
  type HostedProviderDelegationOnboarding,
  type HostedProviderDelegationOnboardingInput,
  type HostedProviderDelegationRecord,
  type HostedProviderDelegationTemplate,
  type PapercuspHostedProvider,
} from '../../workspace-host/hosted-provider-delegation';
import { HostedGcpNotReadyError, PAPERCUSP_HOSTED_GCP_LOCATION } from '../../workspace-host/hosted-gcp-hosting';
import {
  HostedAwsHostingUnconfiguredError,
  HostedAwsNotReadyError,
  PAPERCUSP_HOSTED_AWS_LOCATION,
} from '../../workspace-host/hosted-aws-hosting';
import {
  HOSTED_AWS_DEFAULT_REGION,
  HOSTED_AWS_REGION,
  HostedAwsHostInfrastructurePendingError,
  type HostedAwsHostInfrastructure,
} from '../../workspace-host/hosted-aws-host-stack';
import { HOSTED_AWS_CUSTOMER_ROLE_NAME_PREFIX } from '../../workspace-host/hosted-aws-identity';
import {
  PAPERCUSP_HOSTED_BRING_UP_AGENTS,
  hostedBringUpSupportsProvider,
  type WorkspaceHostBringUp,
} from '../../workspace-host/hosted-bring-up';
import { admissionIdentity, HostedWorkspaceAdmissionError } from './workspace-admission';
import type { HostedWorkspaceAdmissionDependencies } from './workspace-admission';
import type { HostedOnboardingWorkspacePort } from './onboarding';

/** A browser-generated attempt key: opaque, bounded, and safe inside derived identifiers. */
export const HOSTED_FIRST_WORKSPACE_ATTEMPT_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const MAX_TEXT = 160;

/** D-399: Papercusp's own cloud, or the customer's. */
export type HostedFirstWorkspaceHosting = 'papercusp' | 'byoc';

export interface HostedFirstWorkspaceRequest {
  readonly organizationId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly sessionVersion: number;
  readonly attemptKey: string;
  readonly displayName: string;
  readonly label: string;
  readonly hosting: HostedFirstWorkspaceHosting;
  /**
   * Papercusp hosting only (aws-byoc-gcp-parity D-017 rule 6): which of Papercusp's clouds runs
   * the host. Defaults to GCP. Bring-your-own-cloud takes the cloud from `configuration`.
   */
  readonly provider?: PapercuspHostedProvider;
  /** Bring-your-own-cloud only; Papercusp hosting derives every cloud field on the server. */
  readonly configuration?: HostedProviderDelegationConfiguration;
}

export type ResolveFirstWorkspaceSpec = HostedWorkspaceAdmissionDependencies['resolveDesiredSpec'];

export interface HostedFirstWorkspaceDependencies {
  /** Per-organization gate; see the OPEN SECURITY GATE note in the file header. */
  isEnabledFor(organizationId: string): boolean;
  /** A workspace that cannot be provisioned must not be admitted. */
  provisioningAvailable(): boolean;
  /**
   * The organization's delegation binding (D-397): the identity ITS customers grant, which
   * only the server knows, so it is never read from the request body.
   */
  delegationOrganization(organizationId: string): HostedDelegationOrganization;
  /** Ids of the organization's live (non-deleted) workspace bindings. */
  organizationWorkspaceIds(organizationId: string): Promise<readonly string[]>;
  /** Control-plane-privileged delegation store/manager, keyed by the derived workspace id. */
  readDelegation(workspaceId: string, connectionId: string): Promise<HostedProviderDelegationRecord | null>;
  onboardDelegation(input: HostedProviderDelegationOnboardingInput): Promise<HostedProviderDelegationOnboarding>;
  /** D-399: records a Papercusp-hosted delegation for the server-derived host only. */
  onboardPapercuspHostedDelegation(
    organizationId: string,
    input: Omit<HostedProviderDelegationOnboardingInput, 'organizationId' | 'configuration'>,
    hostId: string,
    provider: PapercuspHostedProvider,
  ): Promise<HostedProviderDelegationOnboarding>;
  verifyDelegation(organizationId: string, workspaceId: string, connectionId: string): Promise<HostedProviderDelegationRecord>;
  /**
   * AWS only (D-009): read the host's network, instance profile, KMS key and launch template
   * back from the customer's stack through the VERIFIED role, plus the Ubuntu image to run.
   * Throws {@link HostedAwsHostInfrastructurePendingError} while the stack is still building.
   */
  discoverAwsHostInfrastructure(record: HostedProviderDelegationRecord): Promise<HostedAwsHostInfrastructure>;
  /**
   * Builds the admission port around a spec resolver bound to THIS verified delegation. A
   * `bringUp` sets the machine up once it is built (D-401); passed for every GCP and AWS host,
   * whoever's project/account it runs in (aws-byoc-gcp-parity D-015).
   */
  createAdmission(
    resolveDesiredSpec: ResolveFirstWorkspaceSpec,
    options?: { bringUp?: Pick<WorkspaceHostBringUp, 'requestedAgents'> },
  ): HostedOnboardingWorkspacePort;
  /** Rotate the caller's session onto the new workspace; null when the session moved on. */
  selectWorkspace(input: {
    sessionId: string;
    workspaceId: string;
    expectedPermissionVersion: number;
  }): Promise<{ sessionId: string; expiresAt: Date } | null>;
}

export type HostedFirstWorkspaceFailureCode =
  | 'invalid_request'
  | 'first_workspace_not_enabled'
  | 'organization_already_has_workspace'
  | 'provider_not_supported'
  | 'provisioning_unavailable'
  | 'delegation_source_unavailable'
  | 'delegation_conflict'
  | 'delegation_revoked'
  | 'delegation_pending'
  /** Papercusp is still preparing the reserved host's permissions; retry shortly. */
  | 'papercusp_cloud_preparing'
  /** The Papercusp cloud the browser picked (AWS) is not offered on this deployment; retrying will not help. */
  | 'papercusp_cloud_provider_unavailable'
  | 'workspace_admission_failed'
  | 'session_selection_failed';

export type HostedFirstWorkspaceResult =
  | {
      readonly ok: true;
      readonly workspaceId: string;
      readonly connectionId: string;
      readonly provisionOperationId: string;
      readonly sessionId: string;
      readonly sessionExpiresAt: Date;
    }
  | {
      readonly ok: false;
      readonly code: HostedFirstWorkspaceFailureCode;
      readonly status: number;
      readonly retryable: boolean;
      /** Present on `delegation_pending`: the grant the customer must apply, then retry. */
      readonly template?: HostedProviderDelegationTemplate;
      readonly connectionId?: string;
    };

export interface HostedWorkspaceSelectionRequest {
  readonly organizationId: string;
  readonly sessionId: string;
  readonly sessionVersion: number;
}

export type HostedWorkspaceSelectionResult =
  | {
      readonly ok: true;
      readonly workspaceId: string;
      readonly sessionId: string;
      readonly sessionExpiresAt: Date;
    }
  | {
      readonly ok: false;
      readonly code: 'invalid_request' | 'no_workspace' | 'session_selection_failed';
      readonly status: number;
      readonly retryable: boolean;
    };

export interface HostedFirstWorkspaceIdentity {
  readonly operationKey: string;
  readonly workspaceId: string;
  readonly hostId: string;
  readonly provisionOperationId: string;
  readonly connectionId: string;
  readonly credentialRef: string;
}

/**
 * Every identifier this bootstrap writes, derived from the organization and attempt key.
 * The connection id and credential reference reuse the admission digest so the delegation
 * and the workspace it provisions can never disagree across replays.
 */
export function firstWorkspaceIdentity(organizationId: string, attemptKey: string): HostedFirstWorkspaceIdentity {
  const operationKey = `hosted-first-workspace:${attemptKey}`;
  const derived = admissionIdentity(organizationId, operationKey);
  const digest = derived.hostId.slice('host-'.length);
  const connectionId = `conn-${digest}`;
  return {
    operationKey,
    ...derived,
    connectionId,
    credentialRef: `delegation://${derived.workspaceId}/${connectionId}`,
  };
}

/** Pinned defaults, taken from the canary host proven end to end on 2026-09-22 (P-318 r38). */
export const GCP_FIRST_WORKSPACE_DEFAULTS = {
  region: 'us-central1',
  zone: 'us-central1-c',
  size: 'e2-standard-4',
  image: {
    id: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260918',
    version: 'ubuntu-2404-noble-amd64-v20260918',
  },
  volumeGiB: 100,
} as const;

/**
 * The provisioning model of a NEW Papercusp-hosted host (WI-10005210, plan
 * agent-capacity-and-cost-gcp-2026-09-30 D-028): spot, which roughly halves the cost per active
 * agent. A reclaim stops the VM and keeps its data disk, and the controller's 2-minute spot-reclaim
 * sweep restarts it. A customer-delegated host is NOT defaulted: its project, quota and bill are the
 * customer's, so spot there is their choice (`provider.provisioningModel` on the desired spec).
 */
export const PAPERCUSP_HOSTED_GCP_PROVISIONING_MODEL = 'spot' as const;

/**
 * Default spec for a first GCP workspace. Everything tenant-specific comes from the VERIFIED
 * delegation. A Papercusp-hosted host (D-399) runs where its grant's name conditions point.
 *
 * NO hosted host holds a service account, whoever's project it runs in. The delegation's
 * `serviceAccountEmail` is the CONTROLLER identity Papercusp acts as; attaching it to the VM would
 * hand every agent on the machine the controller's power over the project through the metadata
 * server. It would also need `iam.serviceAccounts.actAs` on that account, which no delegation
 * grants, so GCP refused every customer-project create with SERVICE_ACCOUNT_ACCESS_DENIED
 * (measured 2026-10-02, WI-10005297). The controller identity travels only as the credential
 * reference.
 */
export function gcpFirstWorkspaceDesiredSpec(input: {
  hostId: string;
  record: HostedProviderDelegationRecord;
}): WorkspaceHostDesiredSpec {
  if (input.record.configuration.provider !== 'gcp') {
    throw new HostedWorkspaceAdmissionError('first-workspace spec supports GCP only', 'invalid_input');
  }
  const source = input.record.configuration.source;
  const papercuspHosted = source.method === 'papercusp-hosted';
  if (papercuspHosted && source.hostId !== input.hostId) {
    throw new HostedWorkspaceAdmissionError('Papercusp-hosted delegation reserves a different host', 'invalid_input');
  }
  const location = papercuspHosted ? PAPERCUSP_HOSTED_GCP_LOCATION : GCP_FIRST_WORKSPACE_DEFAULTS;
  return {
    hostId: input.hostId,
    target: 'gcp',
    scope: { kind: 'project', id: source.projectId },
    region: location.region,
    zone: location.zone,
    size: GCP_FIRST_WORKSPACE_DEFAULTS.size,
    image: { ...GCP_FIRST_WORKSPACE_DEFAULTS.image },
    data: { encrypted: true, volumeGiB: GCP_FIRST_WORKSPACE_DEFAULTS.volumeGiB },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: input.record.credentialRef } },
    provider: {
      projectId: source.projectId,
      network: { mode: 'managed' },
      ...(papercuspHosted ? { provisioningModel: PAPERCUSP_HOSTED_GCP_PROVISIONING_MODEL } : {}),
    },
  } as WorkspaceHostDesiredSpec;
}

/**
 * The provisioning model of a NEW Papercusp-hosted AWS host (WI-10005389): spot, matching
 * `PAPERCUSP_HOSTED_GCP_PROVISIONING_MODEL` and for the same cost reason. On AWS it is a persistent
 * spot request that stops on interruption, so a reclaim keeps both EBS volumes and EC2 restarts
 * the instance itself (aws-provider.ts `AWS_SPOT_MARKET_OPTIONS`). A bring-your-own-cloud host is
 * not defaulted: the account and the bill are the customer's.
 */
export const PAPERCUSP_HOSTED_AWS_PROVISIONING_MODEL = 'spot' as const;

/** D-008/D-009: the e2-standard-4 equivalent (4 vCPU, 16 GiB) and the same data volume. */
export const AWS_FIRST_WORKSPACE_DEFAULTS = {
  size: 'm6i.xlarge',
  volumeGiB: GCP_FIRST_WORKSPACE_DEFAULTS.volumeGiB,
} as const;

/**
 * Default spec for a first AWS workspace. The account and credential come from the VERIFIED
 * delegation; the network, instance profile, KMS key, launch template and image come from the
 * customer's own stack, read back through that delegation (D-009).
 */
export function awsFirstWorkspaceDesiredSpec(input: {
  hostId: string;
  record: HostedProviderDelegationRecord;
  infrastructure: HostedAwsHostInfrastructure;
}): WorkspaceHostDesiredSpec {
  const configuration = input.record.configuration;
  if (configuration.provider !== 'aws') {
    throw new HostedWorkspaceAdmissionError('AWS first-workspace spec needs an AWS delegation', 'invalid_input');
  }
  const infra = input.infrastructure;
  if (configuration.papercuspHosted) {
    // D-017: the hosting role is confined to exactly this host, so the spec must be it too.
    if (configuration.papercuspHosted.hostId !== input.hostId) {
      throw new HostedWorkspaceAdmissionError('Papercusp-hosted delegation reserves a different host', 'invalid_input');
    }
    if (configuration.region !== PAPERCUSP_HOSTED_AWS_LOCATION.region) {
      throw new HostedWorkspaceAdmissionError('Papercusp-hosted AWS runs in its hosting region only', 'invalid_input');
    }
  }
  if (infra.region !== (configuration.region ?? HOSTED_AWS_DEFAULT_REGION)) {
    throw new HostedWorkspaceAdmissionError('AWS host infrastructure is in a different region', 'invalid_input');
  }
  return {
    hostId: input.hostId,
    target: 'aws',
    scope: { kind: 'account', id: configuration.accountId },
    region: infra.region,
    zone: infra.zone,
    size: AWS_FIRST_WORKSPACE_DEFAULTS.size,
    image: { ...infra.image },
    data: { encrypted: true, volumeGiB: AWS_FIRST_WORKSPACE_DEFAULTS.volumeGiB },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: input.record.credentialRef } },
    provider: {
      vpcId: infra.vpcId,
      subnetId: infra.subnetId,
      securityGroupIds: [infra.securityGroupId],
      instanceProfileArn: infra.instanceProfileArn,
      launchTemplateId: infra.launchTemplateId,
      kmsKeyArn: infra.kmsKeyArn,
      ...(configuration.papercuspHosted ? { provisioningModel: PAPERCUSP_HOSTED_AWS_PROVISIONING_MODEL } : {}),
    },
  } as WorkspaceHostDesiredSpec;
}

const AWS_ACCOUNT_ID = /^\d{12}$/;

/**
 * The AWS bring-your-own-cloud configuration, built from the account and region alone (D-008).
 * The role is the one the served template creates; its trusted principal and ExternalId are
 * filled from the organization by `bindDelegationToOrganization`, so whatever the browser sent
 * for any of them is discarded. Only a customer role is accepted: OIDC would federate every
 * organization as the same Papercusp subject.
 */
function awsByocConfiguration(
  configuration: Record<string, unknown>,
): HostedProviderDelegationConfiguration | 'invalid' | 'unsupported' {
  const source = configuration.source as { environment?: unknown; method?: unknown } | undefined;
  if (source !== undefined && (source === null || typeof source !== 'object')) return 'invalid';
  if (source && (source.method !== 'customer-role' || (source.environment ?? 'hosted') !== 'hosted')) return 'unsupported';
  const accountId = configuration.accountId;
  if (typeof accountId !== 'string' || !AWS_ACCOUNT_ID.test(accountId)) return 'invalid';
  const region = configuration.region ?? HOSTED_AWS_DEFAULT_REGION;
  if (typeof region !== 'string' || !HOSTED_AWS_REGION.test(region)) return 'invalid';
  return {
    provider: 'aws',
    accountId,
    region,
    source: {
      environment: 'hosted',
      method: 'customer-role',
      roleArn: `arn:aws:iam::${accountId}:role/${HOSTED_AWS_CUSTOMER_ROLE_NAME_PREFIX}${accountId}`,
      // Placeholders: bindDelegationToOrganization replaces both with the organization's own.
      trustedPrincipalArn: '',
      externalIdRef: '',
    },
  };
}

function boundedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_TEXT ? normalized : null;
}

function failure(
  code: HostedFirstWorkspaceFailureCode,
  status: number,
  retryable: boolean,
  extra: { template?: HostedProviderDelegationTemplate; connectionId?: string } = {},
): HostedFirstWorkspaceResult {
  return { ok: false, code, status, retryable, ...extra };
}

export function createHostedFirstWorkspace(deps: HostedFirstWorkspaceDependencies) {
  return {
    /**
     * Select the organization's existing workspace for a session that holds none.
     *
     * Sign-in never selects a workspace (hosted-identity-binding.ts), and every
     * workspace-scoped route refuses `workspace_not_selected`. Without this, a member
     * returning to an organization that already has its workspace landed on the
     * first-workspace form, where creating again is refused
     * (`organization_already_has_workspace`): a dead end, measured 2026-09-23 on the
     * owner's own account. The workspace is read from the SESSION's organization and is
     * never named by the browser, so this cannot select someone else's workspace.
     */
    async selectExisting(request: HostedWorkspaceSelectionRequest): Promise<HostedWorkspaceSelectionResult> {
      const organizationId = boundedText(request.organizationId);
      if (!organizationId || !boundedText(request.sessionId) || !Number.isSafeInteger(request.sessionVersion)) {
        return { ok: false, code: 'invalid_request', status: 400, retryable: false };
      }
      // One live workspace per organization (migration 1200), so there is nothing to choose.
      const [workspaceId, ...others] = await deps.organizationWorkspaceIds(organizationId);
      if (!workspaceId || others.length > 0) {
        return { ok: false, code: 'no_workspace', status: 404, retryable: false };
      }
      const selected = await deps.selectWorkspace({
        sessionId: request.sessionId,
        workspaceId,
        expectedPermissionVersion: request.sessionVersion,
      });
      if (!selected) return { ok: false, code: 'session_selection_failed', status: 409, retryable: true };
      return { ok: true, workspaceId, sessionId: selected.sessionId, sessionExpiresAt: selected.expiresAt };
    },


    async run(request: HostedFirstWorkspaceRequest): Promise<HostedFirstWorkspaceResult> {
      const organizationId = boundedText(request.organizationId);
      const userId = boundedText(request.userId);
      const displayName = boundedText(request.displayName);
      const label = boundedText(request.label);
      const hosting = request.hosting;
      const configuration = request.configuration;
      if (
        !organizationId || !userId || !displayName || !label ||
        !boundedText(request.sessionId) ||
        !Number.isSafeInteger(request.sessionVersion) ||
        typeof request.attemptKey !== 'string' ||
        !HOSTED_FIRST_WORKSPACE_ATTEMPT_KEY.test(request.attemptKey) ||
        (hosting !== 'papercusp' && hosting !== 'byoc') ||
        (hosting === 'byoc' && (!configuration || typeof configuration !== 'object')) ||
        (hosting === 'papercusp' && request.provider !== undefined && request.provider !== 'gcp' && request.provider !== 'aws')
      ) {
        return failure('invalid_request', 400, false);
      }
      // D-017 rule 6: Papercusp hosting runs on GCP unless the browser picked AWS.
      const papercuspProvider: PapercuspHostedProvider = request.provider ?? 'gcp';
      if (!deps.isEnabledFor(organizationId)) return failure('first_workspace_not_enabled', 403, false);
      let byocConfiguration: HostedProviderDelegationConfiguration | undefined;
      if (hosting === 'byoc') {
        if (configuration!.provider === 'gcp') {
          // Only impersonation chains through the organization's own account (D-397).
          const method = (configuration!.source as { method?: unknown } | undefined)?.method;
          if (method !== 'service-account-impersonation') return failure('provider_not_supported', 422, false);
          byocConfiguration = configuration!;
        } else if (configuration!.provider === 'aws') {
          const aws = awsByocConfiguration(configuration as unknown as Record<string, unknown>);
          if (aws === 'invalid') return failure('invalid_request', 400, false);
          if (aws === 'unsupported') return failure('provider_not_supported', 422, false);
          byocConfiguration = aws;
        } else {
          return failure('provider_not_supported', 422, false);
        }
      }
      const identity = firstWorkspaceIdentity(organizationId, request.attemptKey);
      // "First" is per organization. The workspace THIS attempt derives is not a conflict:
      // a replay after a failed session selection must be able to finish selecting it.
      const held = await deps.organizationWorkspaceIds(organizationId);
      if (held.some((workspaceId) => workspaceId !== identity.workspaceId)) {
        return failure('organization_already_has_workspace', 409, false);
      }
      if (!deps.provisioningAvailable()) return failure('provisioning_unavailable', 503, true);

      // The grant names THIS organization's own Papercusp account (D-397), created here so the
      // customer can bind it; a browser-supplied principal is discarded. Papercusp hosting
      // reserves exactly the host this attempt derives, never one the browser names.
      const organization = deps.delegationOrganization(organizationId);
      const delegationBase = {
        workspaceId: identity.workspaceId,
        connectionId: identity.connectionId,
        label,
        credentialRef: identity.credentialRef,
      };
      let onboardingInput: HostedProviderDelegationOnboardingInput;
      try {
        onboardingInput = hosting === 'papercusp'
          ? await bindPapercuspHostedDelegation(delegationBase, organization, identity.hostId, papercuspProvider)
          : await bindDelegationToOrganization(
            { ...delegationBase, organizationId, configuration: byocConfiguration! },
            organization,
          );
      } catch (error) {
        // A brand-new organization's account (GCP) or role (AWS) is often not yet visible to IAM:
        // that is Papercusp's own cloud catching up, which the browser already waits out on its own.
        if (hosting === 'papercusp' && (error instanceof HostedGcpNotReadyError || error instanceof HostedAwsNotReadyError)) {
          return failure('papercusp_cloud_preparing', 409, true, { connectionId: identity.connectionId });
        }
        // No AWS hosting account on this deployment: nothing was written, and no retry will help.
        if (hosting === 'papercusp' && error instanceof HostedAwsHostingUnconfiguredError) {
          return failure('papercusp_cloud_provider_unavailable', 503, false);
        }
        console.error(`[hosted-first-workspace] delegation bind failed for host ${identity.hostId} (${hosting})`, error);
        return failure('delegation_source_unavailable', 503, true);
      }
      let planned: HostedProviderDelegationOnboarding;
      try {
        planned = buildHostedProviderDelegationOnboarding(onboardingInput);
      } catch {
        return failure('invalid_request', 400, false);
      }

      // Record the delegation once; a replay must describe the SAME grant, never a new one.
      const existing = await deps.readDelegation(identity.workspaceId, identity.connectionId);
      if (existing) {
        if (existing.templateDigest !== planned.record.templateDigest) {
          return failure('delegation_conflict', 409, false, { connectionId: identity.connectionId });
        }
        if (existing.status === 'revoked') {
          return failure('delegation_revoked', 409, false, { connectionId: identity.connectionId });
        }
      } else if (hosting === 'papercusp') {
        await deps.onboardPapercuspHostedDelegation(organizationId, delegationBase, identity.hostId, papercuspProvider);
      } else {
        await deps.onboardDelegation(onboardingInput);
      }

      let verified: HostedProviderDelegationRecord;
      try {
        verified = await deps.verifyDelegation(organizationId, identity.workspaceId, identity.connectionId);
      } catch {
        // Not an error from the customer's point of view: the grant is simply not in force yet.
        // Papercusp's own grant takes a minute or two to propagate and needs nothing from them.
        if (hosting === 'papercusp') {
          return failure('papercusp_cloud_preparing', 409, true, { connectionId: identity.connectionId });
        }
        return failure('delegation_pending', 409, true, {
          template: planned.template,
          connectionId: identity.connectionId,
        });
      }

      // D-009: an AWS host launches into the network the customer's stack built, so read it back
      // (as the verified role) before admitting anything. Until the stack finishes, the customer
      // is still mid-setup: answer with the same steps again rather than failing.
      const provider = verified.configuration.provider === 'aws' ? 'aws' : 'gcp';
      let resolveSpec: ResolveFirstWorkspaceSpec;
      if (provider === 'aws') {
        let infrastructure: HostedAwsHostInfrastructure;
        try {
          infrastructure = await deps.discoverAwsHostInfrastructure(verified);
        } catch (error) {
          // Papercusp's own hosting stack (D-017 rule 2) is Papercusp's to finish, never the
          // customer's: there is no template for them to apply.
          if (hosting === 'papercusp' && error instanceof HostedAwsHostInfrastructurePendingError) {
            return failure('papercusp_cloud_preparing', 409, true, { connectionId: identity.connectionId });
          }
          if (error instanceof HostedAwsHostInfrastructurePendingError) {
            return failure('delegation_pending', 409, true, {
              template: planned.template,
              connectionId: identity.connectionId,
            });
          }
          console.error(`[hosted-first-workspace] AWS host infrastructure lookup failed for host ${identity.hostId}`, error);
          return failure('delegation_source_unavailable', 503, true, { connectionId: identity.connectionId });
        }
        resolveSpec = async (spec) =>
          awsFirstWorkspaceDesiredSpec({ hostId: spec.hostId, record: verified, infrastructure });
      } else {
        resolveSpec = async (spec) => gcpFirstWorkspaceDesiredSpec({ hostId: spec.hostId, record: verified });
      }

      // D-401 + aws-byoc-gcp-parity D-015: every GCP and AWS machine this door admits is set up
      // right after it is built, Papercusp-hosted or in the customer's own project/account. A portal
      // customer has no controller of their own and no initialize route, so without the bring-up
      // their workspace would stay 'provisioning' forever. AWS is reached over SSM as the
      // connection's own role (D-015 rule 3, WI-10005354).
      const admission = deps.createAdmission(
        resolveSpec,
        hostedBringUpSupportsProvider(provider)
          ? { bringUp: { requestedAgents: PAPERCUSP_HOSTED_BRING_UP_AGENTS } }
          : {},
      );
      let admitted: { workspaceId: string; provisionOperationId: string };
      try {
        admitted = await admission.ensureProvisioned({
          organizationId,
          userId,
          provider,
          connectionId: identity.connectionId,
          displayName,
          requestedWorkspaceId: identity.workspaceId,
          operationKey: identity.operationKey,
        });
      } catch (error) {
        // A concurrent attempt with a different key won the organization's one slot.
        if (error instanceof HostedWorkspaceAdmissionError && error.code === 'organization_has_live_workspace') {
          return failure('organization_already_has_workspace', 409, false);
        }
        console.error(`[hosted-first-workspace] admission failed for host ${identity.hostId}`, error);
        return failure('workspace_admission_failed', 500, true, { connectionId: identity.connectionId });
      }
      if (hosting === 'papercusp') {
        // An organization holds ONE reservation, so a concurrent attempt under another key can
        // have moved it to a host that will never exist. This attempt won the organization's
        // one workspace: re-assert its host. Idempotent, so a failure is safe to retry.
        try {
          if (papercuspProvider === 'aws') await organization.awsPapercuspHosting(identity.hostId);
          else await organization.gcpPapercuspHosting(identity.hostId);
        } catch (error) {
          console.error(`[hosted-first-workspace] host reservation re-assert failed for host ${identity.hostId}`, error);
          return failure('workspace_admission_failed', 500, true, { connectionId: identity.connectionId });
        }
      }

      const selected = await deps.selectWorkspace({
        sessionId: request.sessionId,
        workspaceId: admitted.workspaceId,
        expectedPermissionVersion: request.sessionVersion,
      });
      if (!selected) return failure('session_selection_failed', 409, true, { connectionId: identity.connectionId });

      return {
        ok: true,
        workspaceId: admitted.workspaceId,
        connectionId: identity.connectionId,
        provisionOperationId: admitted.provisionOperationId,
        sessionId: selected.sessionId,
        sessionExpiresAt: selected.expiresAt,
      };
    },
  };
}

export type HostedFirstWorkspace = ReturnType<typeof createHostedFirstWorkspace>;
