/**
 * WorkOS lifecycle projection and reconciliation leaf.
 *
 * Webhook/route wiring is deliberately outside this module. The ingress layer
 * verifies a WorkOS event and converts it to the secret-free union below; a
 * durable store then applies the ordered projection atomically. In particular,
 * this worker never accepts a raw WorkOS payload, token, password, or Papercusp
 * grant.
 *
 * Authority boundary (BYOC D-067): WorkOS may establish identity and
 * organization existence and may reduce access. It can never create a
 * Papercusp membership, assign an application role, or elevate a grant.
 */

export const WORKOS_REVOCATION_PROPAGATION_MS = 60_000;

export interface WorkosLifecycleCursor {
  occurredAt: string;
  version: string;
  eventId: string;
}

interface WorkosLifecycleEventBase {
  /** Verified, non-secret WorkOS event id. */
  eventId: string;
  occurredAt: Date;
  /** Receipt time starts the D-069 access-closure deadline. */
  receivedAt: Date;
  /** Opaque provider version; decimal versions compare numerically. */
  version?: string | number;
}

export type WorkosLifecycleEvent =
  | (WorkosLifecycleEventBase & {
      kind: 'user.upsert';
      userSubject: string;
      email?: string | null;
      displayName?: string | null;
    })
  | (WorkosLifecycleEventBase & {
      kind: 'user.deactivated' | 'user.deleted';
      userSubject: string;
    })
  | (WorkosLifecycleEventBase & {
      kind: 'organization.upsert';
      organizationSubject: string;
      displayName: string;
    })
  | (WorkosLifecycleEventBase & {
      kind: 'organization.suspended' | 'organization.deleted';
      organizationSubject: string;
    })
  | (WorkosLifecycleEventBase & {
      kind: 'invitation.upsert';
      invitationSubject: string;
      organizationSubject: string;
      inviteeEmail: string;
      providerCreatedAt?: Date | null;
      expiresAt?: Date | null;
    })
  | (WorkosLifecycleEventBase & {
      kind: 'invitation.accepted' | 'invitation.expired' | 'invitation.revoked';
      invitationSubject: string;
      organizationSubject: string;
    })
  | (WorkosLifecycleEventBase & {
      kind: 'session.revoked';
      sessionSubject: string;
      userSubject?: string;
      organizationSubject?: string;
    })
  | (WorkosLifecycleEventBase & {
      kind: 'membership.upsert' | 'membership.revoked';
      userSubject: string;
      organizationSubject: string;
    })
  | (WorkosLifecycleEventBase & {
      kind: 'role.changed';
      userSubject: string;
      organizationSubject: string;
      direction: 'grant-or-elevation' | 'reduction';
    });

export type WorkosLifecycleMutation =
  | {
      kind: 'upsert-user';
      provider: 'workos';
      subject: string;
      email: string | null;
      displayName: string | null;
    }
  | {
      kind: 'set-user-status';
      provider: 'workos';
      subject: string;
      status: 'deactivated' | 'deleted';
    }
  | {
      kind: 'upsert-organization';
      provider: 'workos';
      externalOrganizationId: string;
      displayName: string;
    }
  | {
      kind: 'set-organization-status';
      provider: 'workos';
      externalOrganizationId: string;
      status: 'suspended' | 'deleted';
    }
  | {
      kind: 'upsert-invitation-reference';
      provider: 'workos';
      externalInvitationId: string;
      externalOrganizationId: string;
      inviteeEmail: string;
      providerCreatedAt: string | null;
      expiresAt: string | null;
    }
  | {
      kind: 'set-invitation-status';
      provider: 'workos';
      externalInvitationId: string;
      externalOrganizationId: string;
      status: 'accepted' | 'expired' | 'revoked';
    }
  | {
      kind: 'revoke-session';
      provider: 'workos';
      upstreamSessionId: string;
      userSubject?: string;
      externalOrganizationId?: string;
    }
  | {
      kind: 'reduce-membership-access';
      provider: 'workos';
      userSubject: string;
      externalOrganizationId: string;
      cause: 'membership-revoked' | 'external-role-reduced';
    }
  | {
      /** Persisted for dedupe/audit, with no authorization-table mutation. */
      kind: 'ignore-external-authority';
      provider: 'workos';
      userSubject: string;
      externalOrganizationId: string;
      cause: 'membership-upsert' | 'external-role-grant-or-elevation';
    };

export interface WorkosLifecycleClosureTargets {
  hostedSessionIds?: string[];
  upstreamSessionIds?: string[];
  userIds?: string[];
  organizationIds?: string[];
}

export interface WorkosLifecycleProjectionResult {
  disposition: 'applied' | 'duplicate' | 'stale';
  /**
   * A durable, still-unacknowledged closure obligation. Stores MUST return it
   * on duplicate replay until acknowledgeClosure succeeds, so a sink failure
   * cannot strand access after the database mutation commits.
   */
  pendingClosure?: WorkosLifecycleClosureTargets;
}

export interface WorkosLifecycleProjectionStore {
  /**
   * Atomically dedupe eventId, compare the per-entity cursor, and apply the
   * mutation. Implementations persist the cursor beside the projection or in
   * the verified webhook receipt ledger; a process-local watermark is unsafe.
   */
  applyOrdered(input: {
    entityKey: string;
    cursor: WorkosLifecycleCursor;
    mutation: WorkosLifecycleMutation;
  }): Promise<WorkosLifecycleProjectionResult>;

  /** Clear the durable closure obligation only after the idempotent sink returns. */
  acknowledgeClosure(eventId: string): Promise<void>;
}

export interface WorkosAccessClosureSignal {
  signalId: string;
  source: 'workos-lifecycle';
  eventId: string;
  cause: WorkosLifecycleMutation['kind'];
  receivedAt: string;
  deadlineAt: string;
  maxPropagationMs: typeof WORKOS_REVOCATION_PROPAGATION_MS;
  targets: WorkosLifecycleClosureTargets;
  channels: readonly ['hosted-session', 'sse', 'websocket', 'pty-ticket', 'file-ticket', 'connector-ticket'];
}

export interface WorkosAccessClosureSink {
  /** Must be idempotent by signalId. */
  closeAffectedAccess(signal: WorkosAccessClosureSignal): Promise<void>;
}

export interface WorkosLifecycleSnapshotSource {
  listLifecyclePage(input: {
    cursor?: string;
    limit: number;
  }): Promise<{ events: WorkosLifecycleEvent[]; nextCursor?: string }>;
}

export interface WorkosLifecycleApplyResult extends WorkosLifecycleProjectionResult {
  eventId: string;
  entityKey: string;
  mutation: WorkosLifecycleMutation;
  closureDelivered: boolean;
}

export interface WorkosLifecycleReconciliationResult {
  pages: number;
  examined: number;
  applied: number;
  duplicate: number;
  stale: number;
  closuresDelivered: number;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
    throw new TypeError(`${field} must be a non-empty string of at most 512 characters`);
  }
  return value.trim();
}

function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
  return value;
}

function nullableDate(value: Date | null | undefined, field: string): string | null {
  return value == null ? null : validDate(value, field).toISOString();
}

function normalizeVersion(value: string | number | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('version must be a non-negative safe integer');
    return String(value);
  }
  return requiredText(value, 'version');
}

function compareVersion(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const aa = BigInt(a);
    const bb = BigInt(b);
    return aa < bb ? -1 : aa > bb ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Total ordering used by both webhook delivery and periodic reconciliation. */
export function compareWorkosLifecycleCursor(
  a: WorkosLifecycleCursor,
  b: WorkosLifecycleCursor,
): number {
  const time = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
  if (time !== 0) return time < 0 ? -1 : 1;
  const version = compareVersion(a.version, b.version);
  if (version !== 0) return version;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

export function workosLifecycleCursor(event: WorkosLifecycleEvent): WorkosLifecycleCursor {
  return {
    occurredAt: validDate(event.occurredAt, 'occurredAt').toISOString(),
    version: normalizeVersion(event.version),
    eventId: requiredText(event.eventId, 'eventId'),
  };
}

function entityKey(event: WorkosLifecycleEvent): string {
  switch (event.kind) {
    case 'user.upsert':
    case 'user.deactivated':
    case 'user.deleted':
      return `workos:user:${requiredText(event.userSubject, 'userSubject')}`;
    case 'organization.upsert':
    case 'organization.suspended':
    case 'organization.deleted':
      return `workos:organization:${requiredText(event.organizationSubject, 'organizationSubject')}`;
    case 'invitation.upsert':
    case 'invitation.accepted':
    case 'invitation.expired':
    case 'invitation.revoked':
      return `workos:invitation:${requiredText(event.invitationSubject, 'invitationSubject')}`;
    case 'session.revoked':
      return `workos:session:${requiredText(event.sessionSubject, 'sessionSubject')}`;
    case 'membership.upsert':
    case 'membership.revoked':
    case 'role.changed':
      return `workos:membership:${requiredText(event.organizationSubject, 'organizationSubject')}:${requiredText(event.userSubject, 'userSubject')}`;
  }
}

/** Secret-free mutation projection. Exported so store contract tests can pin it. */
export function projectWorkosLifecycleMutation(event: WorkosLifecycleEvent): WorkosLifecycleMutation {
  switch (event.kind) {
    case 'user.upsert':
      return {
        kind: 'upsert-user',
        provider: 'workos',
        subject: requiredText(event.userSubject, 'userSubject'),
        email: event.email == null ? null : requiredText(event.email, 'email').toLowerCase(),
        displayName: event.displayName == null ? null : requiredText(event.displayName, 'displayName'),
      };
    case 'user.deactivated':
    case 'user.deleted':
      return {
        kind: 'set-user-status',
        provider: 'workos',
        subject: requiredText(event.userSubject, 'userSubject'),
        status: event.kind === 'user.deleted' ? 'deleted' : 'deactivated',
      };
    case 'organization.upsert':
      return {
        kind: 'upsert-organization',
        provider: 'workos',
        externalOrganizationId: requiredText(event.organizationSubject, 'organizationSubject'),
        displayName: requiredText(event.displayName, 'displayName'),
      };
    case 'organization.suspended':
    case 'organization.deleted':
      return {
        kind: 'set-organization-status',
        provider: 'workos',
        externalOrganizationId: requiredText(event.organizationSubject, 'organizationSubject'),
        status: event.kind === 'organization.deleted' ? 'deleted' : 'suspended',
      };
    case 'invitation.upsert':
      return {
        kind: 'upsert-invitation-reference',
        provider: 'workos',
        externalInvitationId: requiredText(event.invitationSubject, 'invitationSubject'),
        externalOrganizationId: requiredText(event.organizationSubject, 'organizationSubject'),
        inviteeEmail: requiredText(event.inviteeEmail, 'inviteeEmail').toLowerCase(),
        providerCreatedAt: nullableDate(event.providerCreatedAt, 'providerCreatedAt'),
        expiresAt: nullableDate(event.expiresAt, 'expiresAt'),
      };
    case 'invitation.accepted':
    case 'invitation.expired':
    case 'invitation.revoked':
      return {
        kind: 'set-invitation-status',
        provider: 'workos',
        externalInvitationId: requiredText(event.invitationSubject, 'invitationSubject'),
        externalOrganizationId: requiredText(event.organizationSubject, 'organizationSubject'),
        status: event.kind.slice('invitation.'.length) as 'accepted' | 'expired' | 'revoked',
      };
    case 'session.revoked':
      return {
        kind: 'revoke-session',
        provider: 'workos',
        upstreamSessionId: requiredText(event.sessionSubject, 'sessionSubject'),
        ...(event.userSubject ? { userSubject: requiredText(event.userSubject, 'userSubject') } : {}),
        ...(event.organizationSubject
          ? { externalOrganizationId: requiredText(event.organizationSubject, 'organizationSubject') }
          : {}),
      };
    case 'membership.revoked':
      return {
        kind: 'reduce-membership-access',
        provider: 'workos',
        userSubject: requiredText(event.userSubject, 'userSubject'),
        externalOrganizationId: requiredText(event.organizationSubject, 'organizationSubject'),
        cause: 'membership-revoked',
      };
    case 'membership.upsert':
      return {
        kind: 'ignore-external-authority',
        provider: 'workos',
        userSubject: requiredText(event.userSubject, 'userSubject'),
        externalOrganizationId: requiredText(event.organizationSubject, 'organizationSubject'),
        cause: 'membership-upsert',
      };
    case 'role.changed':
      return event.direction === 'reduction'
        ? {
            kind: 'reduce-membership-access',
            provider: 'workos',
            userSubject: requiredText(event.userSubject, 'userSubject'),
            externalOrganizationId: requiredText(event.organizationSubject, 'organizationSubject'),
            cause: 'external-role-reduced',
          }
        : {
            kind: 'ignore-external-authority',
            provider: 'workos',
            userSubject: requiredText(event.userSubject, 'userSubject'),
            externalOrganizationId: requiredText(event.organizationSubject, 'organizationSubject'),
            cause: 'external-role-grant-or-elevation',
          };
  }
}

const CLOSURE_CHANNELS = [
  'hosted-session',
  'sse',
  'websocket',
  'pty-ticket',
  'file-ticket',
  'connector-ticket',
] as const;

export class WorkosLifecycleWorker {
  constructor(
    private readonly store: WorkosLifecycleProjectionStore,
    private readonly closureSink: WorkosAccessClosureSink,
  ) {}

  async apply(event: WorkosLifecycleEvent): Promise<WorkosLifecycleApplyResult> {
    const cursor = workosLifecycleCursor(event);
    const receivedAt = validDate(event.receivedAt, 'receivedAt');
    const mutation = projectWorkosLifecycleMutation(event);
    const key = entityKey(event);
    const result = await this.store.applyOrdered({ entityKey: key, cursor, mutation });

    let closureDelivered = false;
    if (result.pendingClosure) {
      await this.closureSink.closeAffectedAccess({
        signalId: `workos-lifecycle:${cursor.eventId}`,
        source: 'workos-lifecycle',
        eventId: cursor.eventId,
        cause: mutation.kind,
        receivedAt: receivedAt.toISOString(),
        deadlineAt: new Date(receivedAt.getTime() + WORKOS_REVOCATION_PROPAGATION_MS).toISOString(),
        maxPropagationMs: WORKOS_REVOCATION_PROPAGATION_MS,
        targets: result.pendingClosure,
        channels: CLOSURE_CHANNELS,
      });
      await this.store.acknowledgeClosure(cursor.eventId);
      closureDelivered = true;
    }

    return {
      ...result,
      eventId: cursor.eventId,
      entityKey: key,
      mutation,
      closureDelivered,
    };
  }

  /**
   * One bounded periodic-reconciliation pass. A scheduler owns cadence; this
   * method owns deterministic paging, ordering, replay safety, and summaries.
   */
  async reconcile(
    source: WorkosLifecycleSnapshotSource,
    opts: { pageSize?: number; maxPages?: number } = {},
  ): Promise<WorkosLifecycleReconciliationResult> {
    const pageSize = opts.pageSize ?? 100;
    const maxPages = opts.maxPages ?? 1_000;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
      throw new RangeError('pageSize must be an integer between 1 and 1000');
    }
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100_000) {
      throw new RangeError('maxPages must be an integer between 1 and 100000');
    }

    const summary: WorkosLifecycleReconciliationResult = {
      pages: 0,
      examined: 0,
      applied: 0,
      duplicate: 0,
      stale: 0,
      closuresDelivered: 0,
    };
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    while (summary.pages < maxPages) {
      const page = await source.listLifecyclePage({ cursor, limit: pageSize });
      summary.pages += 1;
      const ordered = [...page.events].sort((a, b) =>
        compareWorkosLifecycleCursor(workosLifecycleCursor(a), workosLifecycleCursor(b)));
      for (const event of ordered) {
        const result = await this.apply(event);
        summary.examined += 1;
        summary[result.disposition] += 1;
        if (result.closureDelivered) summary.closuresDelivered += 1;
      }

      if (!page.nextCursor) return summary;
      if (page.nextCursor === cursor || seenCursors.has(page.nextCursor)) {
        throw new Error(`WorkOS lifecycle reconciliation cursor repeated: ${page.nextCursor}`);
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error(`WorkOS lifecycle reconciliation exceeded maxPages=${maxPages}`);
  }
}
