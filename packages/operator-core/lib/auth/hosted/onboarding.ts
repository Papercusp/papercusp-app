/**
 * Resumable hosted-customer onboarding orchestration (BYOC P-064).
 *
 * WorkOS proves identity and owns account recovery. Papercusp owns admission,
 * organizations, memberships, roles, legal acceptance, entitlements, workspace
 * grants, and provisioning. This module composes those existing authorities
 * without making the identity provider an authorization source.
 *
 * Every mutating port MUST be idempotent for the supplied operationKey. The
 * orchestrator checkpoints after each side effect, so a crash between a side
 * effect and its checkpoint safely replays the same operation instead of
 * granting duplicate membership or provisioning a second workspace.
 */

import type { HostedOrganizationRole } from '../hosted-role-permissions';
import type { HostedVerifiedIdentity } from './provider';

export const HOSTED_ONBOARDING_STEPS = [
  'identity',
  'membership',
  'legal',
  'entitlement',
  'selection',
  'provider-delegation',
  'workspace',
  'session',
] as const;

export type HostedOnboardingStep = (typeof HOSTED_ONBOARDING_STEPS)[number];
/**
 * Re-exported, not re-declared: the role vocabulary has ONE source
 * (`hosted-role-permissions.ts`), which derives it from migration 903's
 * `organization_memberships_role_ck` constraint. A second copy here would drift
 * from the matrix that turns these roles into permissions.
 */
export type { HostedOrganizationRole };

export type HostedOnboardingAdmission =
  | {
      readonly kind: 'invitation';
      readonly invitationId: string;
      readonly organizationId: string;
      readonly expectedEmail: string;
      readonly expiresAt: Date | null;
      readonly role: HostedOrganizationRole;
    }
  | {
      readonly kind: 'beta-approval';
      readonly approvalId: string;
      readonly organizationId: string;
      readonly approvedEmail: string;
      readonly role: 'owner' | 'member';
    }
  | {
      readonly kind: 'existing-membership';
      readonly organizationId: string;
    };

export interface HostedOnboardingRequest {
  readonly attemptId: string;
  readonly providerId: string;
  readonly identity: HostedVerifiedIdentity;
  readonly admission: HostedOnboardingAdmission;
  readonly legal: {
    readonly termsVersion: string;
    readonly privacyVersion: string;
    readonly acceptedAt: Date;
  };
  readonly selection: {
    readonly organizationId: string;
    readonly workspaceId?: string;
  };
  readonly providerDelegation: {
    readonly provider: 'gcp' | 'aws' | 'azure';
    readonly connectionId: string;
  };
  readonly workspace: {
    readonly displayName: string;
    readonly requestedWorkspaceId?: string;
  };
}

export interface HostedOnboardingState {
  readonly attemptId: string;
  readonly requestFingerprint: string;
  readonly providerId: string;
  readonly externalUserId: string;
  readonly verifiedEmail: string;
  readonly admissionKey: string;
  readonly completedSteps: readonly HostedOnboardingStep[];
  readonly userId?: string;
  readonly organizationId?: string;
  readonly role?: HostedOrganizationRole;
  readonly permissionVersion?: number;
  readonly workspaceId?: string;
  readonly provisionOperationId?: string;
  readonly sessionId?: string;
  readonly lastError?: HostedOnboardingFailureCode;
  readonly updatedAt: Date;
}

export interface HostedOnboardingBinding {
  readonly userId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly permissionVersion: number;
  readonly sessionId: string;
}

export const HOSTED_ONBOARDING_FAILURE_CODES = [
  'invalid_request',
  'wrong_email',
  'invitation_expired',
  'invitation_replayed',
  'admission_denied',
  'state_conflict',
  'identity_unavailable',
  'membership_unavailable',
  'legal_acceptance_unavailable',
  'entitlement_denied',
  'selection_mismatch',
  'provider_delegation_failed',
  'workspace_provisioning_failed',
  'session_activation_failed',
  'store_unavailable',
] as const;

export type HostedOnboardingFailureCode = (typeof HOSTED_ONBOARDING_FAILURE_CODES)[number];

export type HostedOnboardingResult =
  | { readonly ok: true; readonly state: HostedOnboardingState; readonly binding: HostedOnboardingBinding }
  | {
      readonly ok: false;
      readonly code: HostedOnboardingFailureCode;
      readonly retryable: boolean;
      readonly state?: HostedOnboardingState;
    };

export interface HostedOnboardingStateStore {
  /** Create or load one durable run. Implementations must compare the fingerprint atomically. */
  loadOrCreate(seed: HostedOnboardingState): Promise<HostedOnboardingState>;
  /** Compare-and-store the complete state for this attempt. */
  checkpoint(state: HostedOnboardingState): Promise<HostedOnboardingState>;
}

export interface HostedOnboardingIdentityPort {
  upsertVerifiedIdentity(input: {
    providerId: string;
    identity: HostedVerifiedIdentity;
    operationKey: string;
  }): Promise<{ userId: string }>;
}

export type HostedMembershipAdmissionResult =
  | {
      readonly ok: true;
      readonly organizationId: string;
      readonly role: HostedOrganizationRole;
      readonly permissionVersion: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'invitation_replayed' | 'admission_denied' | 'unavailable';
      readonly retryable: boolean;
    };

export interface HostedOnboardingMembershipPort {
  /**
   * Perform the Papercusp-authoritative membership transaction. WorkOS data is
   * delivery/identity context only and must never directly assign a role.
   */
  admit(input: {
    userId: string;
    verifiedEmail: string;
    admission: HostedOnboardingAdmission;
    operationKey: string;
  }): Promise<HostedMembershipAdmissionResult>;
  resolveActive(input: {
    userId: string;
    organizationId: string;
  }): Promise<{
    organizationId: string;
    role: HostedOrganizationRole;
    permissionVersion: number;
  } | null>;
}

export interface HostedOnboardingLegalPort {
  recordAcceptance(input: {
    userId: string;
    organizationId: string;
    termsVersion: string;
    privacyVersion: string;
    acceptedAt: Date;
    operationKey: string;
  }): Promise<void>;
}

export interface HostedOnboardingEntitlementPort {
  requireBetaAccess(input: {
    organizationId: string;
    userId: string;
    operationKey: string;
  }): Promise<{ allowed: true } | { allowed: false; retryable: boolean }>;
}

export interface HostedOnboardingProviderDelegationPort {
  ensureDelegation(input: {
    organizationId: string;
    userId: string;
    provider: 'gcp' | 'aws' | 'azure';
    connectionId: string;
    operationKey: string;
  }): Promise<void>;
}

export interface HostedOnboardingWorkspacePort {
  ensureProvisioned(input: {
    organizationId: string;
    userId: string;
    provider: 'gcp' | 'aws' | 'azure';
    connectionId: string;
    displayName: string;
    requestedWorkspaceId?: string;
    operationKey: string;
  }): Promise<{ workspaceId: string; provisionOperationId: string }>;
  resolveSelectable(input: {
    organizationId: string;
    userId: string;
    workspaceId: string;
  }): Promise<boolean>;
}

export interface HostedOnboardingSessionPort {
  activate(input: {
    userId: string;
    organizationId: string;
    workspaceId: string;
    permissionVersion: number;
    operationKey: string;
  }): Promise<{ sessionId: string }>;
  rotateForOrganization(input: {
    sessionId: string;
    userId: string;
    organizationId: string;
    workspaceId: string;
    expectedPermissionVersion: number;
    permissionVersion: number;
    operationKey: string;
  }): Promise<{ sessionId: string } | null>;
}

export interface HostedOnboardingDependencies {
  readonly state: HostedOnboardingStateStore;
  readonly identities: HostedOnboardingIdentityPort;
  readonly memberships: HostedOnboardingMembershipPort;
  readonly legal: HostedOnboardingLegalPort;
  readonly entitlements: HostedOnboardingEntitlementPort;
  readonly providerDelegation: HostedOnboardingProviderDelegationPort;
  readonly workspaces: HostedOnboardingWorkspacePort;
  readonly sessions: HostedOnboardingSessionPort;
  readonly clock?: () => Date;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 512 ? normalized : null;
}

function normalizedEmail(value: unknown): string | null {
  const normalized = text(value)?.toLowerCase() ?? null;
  if (!normalized || normalized.length > 320 || !normalized.includes('@')) return null;
  return normalized;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function admissionKey(admission: HostedOnboardingAdmission): string {
  if (admission.kind === 'invitation') return `invitation:${admission.invitationId}`;
  if (admission.kind === 'beta-approval') return `beta-approval:${admission.approvalId}`;
  return `existing-membership:${admission.organizationId}`;
}

function fingerprint(request: HostedOnboardingRequest): string {
  return [
    request.providerId,
    request.identity.externalUserId,
    normalizedEmail(request.identity.primaryEmail),
    admissionKey(request.admission),
  ].join('|');
}

function operationKey(attemptId: string, step: HostedOnboardingStep): string {
  return `hosted-onboarding:${attemptId}:${step}`;
}

function hasStep(state: HostedOnboardingState, step: HostedOnboardingStep): boolean {
  return state.completedSteps.includes(step);
}

function requireBinding(state: HostedOnboardingState): HostedOnboardingBinding | null {
  const userId = text(state.userId);
  const organizationId = text(state.organizationId);
  const workspaceId = text(state.workspaceId);
  const sessionId = text(state.sessionId);
  const permissionVersion = state.permissionVersion;
  if (
    !userId ||
    !organizationId ||
    !workspaceId ||
    !sessionId ||
    !Number.isSafeInteger(permissionVersion) ||
    (permissionVersion ?? -1) < 0
  ) return null;
  return {
    userId,
    organizationId,
    workspaceId,
    permissionVersion: permissionVersion as number,
    sessionId,
  };
}

function validateRequest(request: HostedOnboardingRequest, now: Date): HostedOnboardingFailureCode | null {
  if (
    !text(request.attemptId) ||
    !text(request.providerId) ||
    !text(request.identity?.externalUserId) ||
    request.identity?.emailVerified !== true ||
    !normalizedEmail(request.identity?.primaryEmail) ||
    !text(request.legal?.termsVersion) ||
    !text(request.legal?.privacyVersion) ||
    !validDate(request.legal?.acceptedAt) ||
    !text(request.selection?.organizationId) ||
    !text(request.providerDelegation?.connectionId) ||
    !text(request.workspace?.displayName)
  ) return 'invalid_request';

  if (request.selection.organizationId !== request.admission.organizationId) {
    return 'selection_mismatch';
  }
  const email = normalizedEmail(request.identity.primaryEmail);
  if (request.admission.kind === 'invitation') {
    if (email !== normalizedEmail(request.admission.expectedEmail)) return 'wrong_email';
    if (request.admission.expiresAt && (!validDate(request.admission.expiresAt)
      || request.admission.expiresAt.getTime() <= now.getTime())) return 'invitation_expired';
  }
  if (
    request.admission.kind === 'beta-approval'
    && email !== normalizedEmail(request.admission.approvedEmail)
  ) return 'wrong_email';
  return null;
}

function retryable(code: HostedOnboardingFailureCode): boolean {
  return new Set<HostedOnboardingFailureCode>([
    'identity_unavailable',
    'membership_unavailable',
    'legal_acceptance_unavailable',
    'entitlement_denied',
    'provider_delegation_failed',
    'workspace_provisioning_failed',
    'session_activation_failed',
    'store_unavailable',
  ]).has(code);
}

/**
 * One resumable onboarding coordinator. It never accepts a password/reset
 * payload and never derives membership or role authority from WorkOS.
 */
export class HostedOnboardingOrchestrator {
  private readonly clock: () => Date;

  constructor(private readonly deps: HostedOnboardingDependencies) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async run(request: HostedOnboardingRequest): Promise<HostedOnboardingResult> {
    const now = this.clock();
    const invalid = validateRequest(request, now);
    if (invalid) return { ok: false, code: invalid, retryable: false };

    const verifiedEmail = normalizedEmail(request.identity.primaryEmail) as string;
    const requestFingerprint = fingerprint(request);
    const seed: HostedOnboardingState = {
      attemptId: request.attemptId.trim(),
      requestFingerprint,
      providerId: request.providerId.trim(),
      externalUserId: request.identity.externalUserId.trim(),
      verifiedEmail,
      admissionKey: admissionKey(request.admission),
      completedSteps: [],
      updatedAt: now,
    };

    let state: HostedOnboardingState;
    try {
      state = await this.deps.state.loadOrCreate(seed);
    } catch {
      return { ok: false, code: 'store_unavailable', retryable: true };
    }
    if (state.requestFingerprint !== requestFingerprint) {
      return { ok: false, code: 'state_conflict', retryable: false, state };
    }

    const fail = async (code: HostedOnboardingFailureCode): Promise<HostedOnboardingResult> => {
      const failed = { ...state, lastError: code, updatedAt: this.clock() };
      try {
        state = await this.deps.state.checkpoint(failed);
      } catch {
        return { ok: false, code: 'store_unavailable', retryable: true, state };
      }
      return { ok: false, code, retryable: retryable(code), state };
    };

    const complete = async (
      step: HostedOnboardingStep,
      patch: Partial<HostedOnboardingState> = {},
    ): Promise<boolean> => {
      const next: HostedOnboardingState = {
        ...state,
        ...patch,
        completedSteps: [...new Set([...state.completedSteps, step])],
        lastError: undefined,
        updatedAt: this.clock(),
      };
      try {
        state = await this.deps.state.checkpoint(next);
        return true;
      } catch {
        return false;
      }
    };

    if (!hasStep(state, 'identity')) {
      try {
        const identity = await this.deps.identities.upsertVerifiedIdentity({
          providerId: request.providerId,
          identity: request.identity,
          operationKey: operationKey(request.attemptId, 'identity'),
        });
        if (!text(identity.userId)) return fail('identity_unavailable');
        if (!await complete('identity', { userId: identity.userId })) {
          return { ok: false, code: 'store_unavailable', retryable: true, state };
        }
      } catch {
        return fail('identity_unavailable');
      }
    }

    if (!hasStep(state, 'membership')) {
      try {
        const admitted = await this.deps.memberships.admit({
          userId: state.userId as string,
          verifiedEmail,
          admission: request.admission,
          operationKey: operationKey(request.attemptId, 'membership'),
        });
        if (!admitted.ok) {
          const code = admitted.reason === 'invitation_replayed'
            ? 'invitation_replayed'
            : admitted.reason === 'unavailable' ? 'membership_unavailable' : 'admission_denied';
          const result = await fail(code);
          return admitted.retryable && !result.ok ? { ...result, retryable: true } : result;
        }
        if (
          admitted.organizationId !== request.selection.organizationId
          || !Number.isSafeInteger(admitted.permissionVersion)
          || admitted.permissionVersion < 0
        ) return fail('selection_mismatch');
        if (!await complete('membership', {
          organizationId: admitted.organizationId,
          role: admitted.role,
          permissionVersion: admitted.permissionVersion,
        })) return { ok: false, code: 'store_unavailable', retryable: true, state };
      } catch {
        return fail('membership_unavailable');
      }
    }

    if (!hasStep(state, 'legal')) {
      try {
        await this.deps.legal.recordAcceptance({
          userId: state.userId as string,
          organizationId: state.organizationId as string,
          ...request.legal,
          operationKey: operationKey(request.attemptId, 'legal'),
        });
        if (!await complete('legal')) return { ok: false, code: 'store_unavailable', retryable: true, state };
      } catch {
        return fail('legal_acceptance_unavailable');
      }
    }

    if (!hasStep(state, 'entitlement')) {
      try {
        const decision = await this.deps.entitlements.requireBetaAccess({
          organizationId: state.organizationId as string,
          userId: state.userId as string,
          operationKey: operationKey(request.attemptId, 'entitlement'),
        });
        if (!decision.allowed) {
          const result = await fail('entitlement_denied');
          return !result.ok ? { ...result, retryable: decision.retryable } : result;
        }
        if (!await complete('entitlement')) return { ok: false, code: 'store_unavailable', retryable: true, state };
      } catch {
        return fail('entitlement_denied');
      }
    }

    if (!hasStep(state, 'selection')) {
      const requestedWorkspace = text(request.selection.workspaceId);
      if (requestedWorkspace) {
        try {
          if (!await this.deps.workspaces.resolveSelectable({
            organizationId: state.organizationId as string,
            userId: state.userId as string,
            workspaceId: requestedWorkspace,
          })) return fail('selection_mismatch');
        } catch {
          return fail('workspace_provisioning_failed');
        }
      }
      if (!await complete('selection', requestedWorkspace ? { workspaceId: requestedWorkspace } : {})) {
        return { ok: false, code: 'store_unavailable', retryable: true, state };
      }
    }

    if (!hasStep(state, 'provider-delegation')) {
      try {
        await this.deps.providerDelegation.ensureDelegation({
          organizationId: state.organizationId as string,
          userId: state.userId as string,
          ...request.providerDelegation,
          operationKey: operationKey(request.attemptId, 'provider-delegation'),
        });
        if (!await complete('provider-delegation')) {
          return { ok: false, code: 'store_unavailable', retryable: true, state };
        }
      } catch {
        return fail('provider_delegation_failed');
      }
    }

    if (!hasStep(state, 'workspace')) {
      try {
        const provisioned = await this.deps.workspaces.ensureProvisioned({
          organizationId: state.organizationId as string,
          userId: state.userId as string,
          ...request.providerDelegation,
          ...request.workspace,
          operationKey: operationKey(request.attemptId, 'workspace'),
        });
        if (!text(provisioned.workspaceId) || !text(provisioned.provisionOperationId)) {
          return fail('workspace_provisioning_failed');
        }
        if (state.workspaceId && state.workspaceId !== provisioned.workspaceId) {
          return fail('selection_mismatch');
        }
        if (!await complete('workspace', provisioned)) {
          return { ok: false, code: 'store_unavailable', retryable: true, state };
        }
      } catch {
        return fail('workspace_provisioning_failed');
      }
    }

    if (!hasStep(state, 'session')) {
      try {
        const activated = await this.deps.sessions.activate({
          userId: state.userId as string,
          organizationId: state.organizationId as string,
          workspaceId: state.workspaceId as string,
          permissionVersion: state.permissionVersion as number,
          operationKey: operationKey(request.attemptId, 'session'),
        });
        if (!text(activated.sessionId)) return fail('session_activation_failed');
        if (!await complete('session', { sessionId: activated.sessionId })) {
          return { ok: false, code: 'store_unavailable', retryable: true, state };
        }
      } catch {
        return fail('session_activation_failed');
      }
    }

    const binding = requireBinding(state);
    if (!binding) return fail('state_conflict');
    return { ok: true, state, binding };
  }

  /**
   * Switch an existing user between organizations only after resolving a fresh
   * Papercusp membership and workspace grant, then rotate the session id.
   */
  async switchOrganization(input: {
    sessionId: string;
    userId: string;
    organizationId: string;
    workspaceId: string;
    expectedPermissionVersion: number;
    operationKey: string;
  }): Promise<HostedOnboardingBinding | null> {
    if (
      !text(input.sessionId) || !text(input.userId) || !text(input.organizationId)
      || !text(input.workspaceId) || !text(input.operationKey)
      || !Number.isSafeInteger(input.expectedPermissionVersion) || input.expectedPermissionVersion < 0
    ) return null;
    const membership = await this.deps.memberships.resolveActive({
      userId: input.userId,
      organizationId: input.organizationId,
    });
    if (!membership || membership.organizationId !== input.organizationId) return null;
    const entitled = await this.deps.entitlements.requireBetaAccess({
      organizationId: input.organizationId,
      userId: input.userId,
      operationKey: `${input.operationKey}:entitlement`,
    });
    if (!entitled.allowed) return null;
    if (!await this.deps.workspaces.resolveSelectable({
      organizationId: input.organizationId,
      userId: input.userId,
      workspaceId: input.workspaceId,
    })) return null;
    const rotated = await this.deps.sessions.rotateForOrganization({
      ...input,
      permissionVersion: membership.permissionVersion,
    });
    if (!rotated || !text(rotated.sessionId) || rotated.sessionId === input.sessionId) return null;
    return {
      userId: input.userId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      permissionVersion: membership.permissionVersion,
      sessionId: rotated.sessionId,
    };
  }
}
