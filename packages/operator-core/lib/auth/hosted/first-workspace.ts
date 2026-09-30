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
 * own GCP project, granted as above.
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
} from '../../workspace-host/hosted-provider-delegation';
import { HostedGcpNotReadyError, PAPERCUSP_HOSTED_GCP_LOCATION } from '../../workspace-host/hosted-gcp-hosting';
import {
  PAPERCUSP_HOSTED_BRING_UP_AGENTS,
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
  ): Promise<HostedProviderDelegationOnboarding>;
  verifyDelegation(organizationId: string, workspaceId: string, connectionId: string): Promise<HostedProviderDelegationRecord>;
  /**
   * Builds the admission port around a spec resolver bound to THIS verified delegation. A
   * `bringUp` sets the machine up once it is built (D-401); only Papercusp hosting passes one.
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
 * Default spec for a first GCP workspace. Everything tenant-specific comes from the VERIFIED
 * delegation. A Papercusp-hosted host (D-399) runs where its grant's name conditions point and
 * holds NO service account: nothing on the machine can act in Papercusp's project.
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
      ...(papercuspHosted ? {} : { serviceAccountEmail: source.serviceAccountEmail }),
      network: { mode: 'managed' },
    },
  } as WorkspaceHostDesiredSpec;
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
        (hosting === 'byoc' && (!configuration || typeof configuration !== 'object'))
      ) {
        return failure('invalid_request', 400, false);
      }
      if (!deps.isEnabledFor(organizationId)) return failure('first_workspace_not_enabled', 403, false);
      if (hosting === 'byoc') {
        if (configuration!.provider !== 'gcp') return failure('provider_not_supported', 422, false);
        // Only impersonation chains through the organization's own account (D-397).
        const method = (configuration!.source as { method?: unknown } | undefined)?.method;
        if (method !== 'service-account-impersonation') return failure('provider_not_supported', 422, false);
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
          ? await bindPapercuspHostedDelegation(delegationBase, organization, identity.hostId)
          : await bindDelegationToOrganization(
            { ...delegationBase, organizationId, configuration: configuration! },
            organization,
          );
      } catch (error) {
        // A brand-new organization's account is often not yet visible to IAM: that is Papercusp's
        // own cloud catching up, which the browser already waits out on its own.
        if (hosting === 'papercusp' && error instanceof HostedGcpNotReadyError) {
          return failure('papercusp_cloud_preparing', 409, true, { connectionId: identity.connectionId });
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
        await deps.onboardPapercuspHostedDelegation(organizationId, delegationBase, identity.hostId);
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

      // D-401: a Papercusp-hosted machine is set up right after it is built; the customer's own
      // cloud is left as they provisioned it.
      const admission = deps.createAdmission(
        async (spec) => gcpFirstWorkspaceDesiredSpec({ hostId: spec.hostId, record: verified }),
        hosting === 'papercusp' ? { bringUp: { requestedAgents: PAPERCUSP_HOSTED_BRING_UP_AGENTS } } : {},
      );
      let admitted: { workspaceId: string; provisionOperationId: string };
      try {
        admitted = await admission.ensureProvisioned({
          organizationId,
          userId,
          provider: 'gcp',
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
          await organization.gcpPapercuspHosting(identity.hostId);
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
