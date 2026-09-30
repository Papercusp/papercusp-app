/**
 * PostgreSQL production adapter for verified WorkOS lifecycle receipts.
 *
 * Every database operation enters the explicit `hosted_service` transaction
 * boundary. The existing webhook receipt is the dedupe/processing ledger; the
 * small entity-cursor table only serializes and orders events for one upstream
 * identity. No process-local watermark or second event queue is introduced.
 */

import { withHostedServiceContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import {
  compareWorkosLifecycleCursor,
  type WorkosAccessClosureSignal,
  type WorkosAccessClosureSink,
  type WorkosLifecycleClosureTargets,
  type WorkosLifecycleCursor,
  type WorkosLifecycleEvent,
  type WorkosLifecycleMutation,
  type WorkosLifecycleProjectionResult,
  type WorkosLifecycleProjectionStore,
} from './workos-lifecycle-worker';
import type { WorkOsWebhookReceiptResult } from './workos-webhook-intake';

export type HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

interface ReceiptLifecycleRow {
  lifecycle_entity_key: string | null;
  lifecycle_cursor: WorkosLifecycleCursor | null;
  lifecycle_mutation: WorkosLifecycleMutation | null;
  closure_targets: WorkosLifecycleClosureTargets | null;
  closure_acknowledged_at: Date | string | null;
}

interface CursorRow {
  occurred_at: Date | string;
  event_version: string;
  event_id: string;
}

interface IdRow {
  id: string;
}

interface HostedUserRow {
  hosted_user_id: string;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
    throw new TypeError(`${field} must be a non-empty string of at most 512 characters`);
  }
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 512 ? normalized : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function date(value: unknown, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(value as string | number);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${field} must be a valid date`);
  return parsed;
}

function normalizedCursor(cursor: WorkosLifecycleCursor): WorkosLifecycleCursor {
  const eventId = requiredText(cursor.eventId, 'cursor.eventId');
  return {
    eventId,
    occurredAt: date(cursor.occurredAt, 'cursor.occurredAt').toISOString(),
    // Some WorkOS objects do not publish a numeric version. The signed event
    // id is still a stable non-empty final tie-breaker and satisfies the DB
    // cursor constraint without inventing authority.
    version: optionalText(cursor.version) ?? eventId,
  };
}

function cursorFromRow(row: CursorRow): WorkosLifecycleCursor {
  return {
    occurredAt: date(row.occurred_at, 'cursor.occurred_at').toISOString(),
    version: row.event_version,
    eventId: row.event_id,
  };
}

function normalizeTargets(value: WorkosLifecycleClosureTargets | null): WorkosLifecycleClosureTargets | undefined {
  if (!value) return undefined;
  const normalized: WorkosLifecycleClosureTargets = {};
  for (const key of ['hostedSessionIds', 'upstreamSessionIds', 'userIds', 'organizationIds'] as const) {
    const candidates = value[key];
    if (!Array.isArray(candidates)) continue;
    const ids = [...new Set(candidates.map(optionalText).filter((id): id is string => id !== undefined))];
    if (ids.length > 0) normalized[key] = ids;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function mergeTargets(
  ...values: Array<WorkosLifecycleClosureTargets | undefined>
): WorkosLifecycleClosureTargets | undefined {
  const merged: WorkosLifecycleClosureTargets = {};
  for (const key of ['hostedSessionIds', 'upstreamSessionIds', 'userIds', 'organizationIds'] as const) {
    const ids = [...new Set(values.flatMap((value) => value?.[key] ?? []))];
    if (ids.length > 0) merged[key] = ids;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export class PostgresWorkosLifecycleProjectionStore implements WorkosLifecycleProjectionStore {
  constructor(private readonly run: HostedServiceContextRunner = withHostedServiceContext) {}

  async applyOrdered(input: {
    entityKey: string;
    cursor: WorkosLifecycleCursor;
    mutation: WorkosLifecycleMutation;
  }): Promise<WorkosLifecycleProjectionResult> {
    const entityKey = requiredText(input.entityKey, 'entityKey');
    const cursor = normalizedCursor(input.cursor);
    return this.run((sql) => this.applyInTransaction(sql, entityKey, cursor, input.mutation));
  }

  private async applyInTransaction(
    sql: Sql,
    entityKey: string,
    cursor: WorkosLifecycleCursor,
    mutation: WorkosLifecycleMutation,
  ): Promise<WorkosLifecycleProjectionResult> {
    const receipts = await sql<ReceiptLifecycleRow[]>`
      SELECT lifecycle_entity_key, lifecycle_cursor, lifecycle_mutation,
             closure_targets, closure_acknowledged_at
        FROM papercusp_auth.webhook_event_receipts
       WHERE provider = 'workos'
         AND event_id = ${cursor.eventId}
       FOR UPDATE
    `;
    const receipt = receipts[0];
    if (!receipt) throw new Error(`workos_lifecycle_receipt_missing:${cursor.eventId}`);

    if (receipt.lifecycle_entity_key !== null) {
      if (receipt.lifecycle_entity_key !== entityKey || receipt.lifecycle_cursor?.eventId !== cursor.eventId) {
        throw new Error(`workos_lifecycle_receipt_projection_collision:${cursor.eventId}`);
      }
      const pendingClosure = receipt.closure_acknowledged_at ? undefined : normalizeTargets(receipt.closure_targets);
      return { disposition: 'duplicate', ...(pendingClosure ? { pendingClosure } : {}) };
    }

    // Serialize distinct receipts for the same upstream entity before reading
    // its cursor. The lock is transaction-scoped and the key remains a bound
    // value, so upstream text never becomes SQL.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workos:${entityKey}`}, 0))`;
    const cursorRows = await sql<CursorRow[]>`
      SELECT occurred_at, event_version, event_id
        FROM papercusp_auth.workos_lifecycle_entity_cursors
       WHERE provider = 'workos'
         AND entity_key = ${entityKey}
       FOR UPDATE
    `;
    const current = cursorRows[0] ? cursorFromRow(cursorRows[0]) : null;
    if (current && compareWorkosLifecycleCursor(cursor, current) <= 0) {
      await this.finishReceipt(sql, {
        entityKey,
        cursor,
        mutation,
        status: 'ignored',
        errorCode: 'stale_lifecycle_event',
      });
      return { disposition: 'stale' };
    }

    const pendingClosure = await this.applyMutation(sql, mutation, cursor);
    await sql`
      INSERT INTO papercusp_auth.workos_lifecycle_entity_cursors
        (provider, entity_key, occurred_at, event_version, event_id, updated_at)
      VALUES
        ('workos', ${entityKey}, ${cursor.occurredAt}, ${cursor.version}, ${cursor.eventId}, now())
      ON CONFLICT (provider, entity_key) DO UPDATE
        SET occurred_at = EXCLUDED.occurred_at,
            event_version = EXCLUDED.event_version,
            event_id = EXCLUDED.event_id,
            updated_at = now()
    `;
    await this.finishReceipt(sql, {
      entityKey,
      cursor,
      mutation,
      status: mutation.kind === 'ignore-external-authority' ? 'ignored' : 'applied',
      pendingClosure,
      errorCode: mutation.kind === 'ignore-external-authority' ? mutation.cause : null,
    });
    return { disposition: 'applied', ...(pendingClosure ? { pendingClosure } : {}) };
  }

  private async finishReceipt(
    sql: Sql,
    input: {
      entityKey: string;
      cursor: WorkosLifecycleCursor;
      mutation: WorkosLifecycleMutation;
      status: 'applied' | 'ignored';
      pendingClosure?: WorkosLifecycleClosureTargets;
      errorCode?: string | null;
    },
  ): Promise<void> {
    const cursorJson = JSON.stringify(input.cursor);
    const mutationJson = JSON.stringify(input.mutation);
    const closureJson = input.pendingClosure ? JSON.stringify(input.pendingClosure) : null;
    await sql`
      UPDATE papercusp_auth.webhook_event_receipts
         SET lifecycle_entity_key = ${input.entityKey},
             lifecycle_cursor = ${cursorJson}::text::jsonb,
             lifecycle_mutation = ${mutationJson}::text::jsonb,
             closure_targets = ${closureJson}::text::jsonb,
             closure_acknowledged_at = NULL,
             status = ${input.status},
             processing_started_at = COALESCE(processing_started_at, now()),
             processed_at = now(),
             attempt_count = attempt_count + 1,
             last_attempt_at = now(),
             last_error_code = ${input.errorCode ?? null}
       WHERE provider = 'workos'
         AND event_id = ${input.cursor.eventId}
    `;
  }

  private async applyMutation(
    sql: Sql,
    mutation: WorkosLifecycleMutation,
    cursor: WorkosLifecycleCursor,
  ): Promise<WorkosLifecycleClosureTargets | undefined> {
    switch (mutation.kind) {
      case 'upsert-user': {
        const links = await sql<HostedUserRow[]>`
          SELECT hosted_user_id::text AS hosted_user_id
            FROM papercusp_auth.external_identities
           WHERE provider = 'workos'
             AND subject = ${mutation.subject}
           FOR UPDATE
        `;
        let userId = links[0]?.hosted_user_id;
        if (!userId) {
          const users = await sql<IdRow[]>`
            INSERT INTO papercusp_auth.hosted_users
              (primary_email, display_name, status, deactivated_at, deleted_at, updated_at)
            VALUES (${mutation.email}, ${mutation.displayName}, 'active', NULL, NULL, now())
            RETURNING id::text AS id
          `;
          userId = users[0].id;
          await sql`
            INSERT INTO papercusp_auth.external_identities
              (hosted_user_id, provider, subject, provider_email, status,
               deactivated_at, deleted_at, updated_at, last_seen_at)
            VALUES
              (${userId}::uuid, 'workos', ${mutation.subject}, ${mutation.email},
               'active', NULL, NULL, now(), now())
          `;
        } else {
          await sql`
            UPDATE papercusp_auth.hosted_users
               SET primary_email = ${mutation.email},
                   display_name = ${mutation.displayName},
                   status = 'active',
                   deactivated_at = NULL,
                   deleted_at = NULL,
                   updated_at = now()
             WHERE id = ${userId}::uuid
          `;
          await sql`
            UPDATE papercusp_auth.external_identities
               SET provider_email = ${mutation.email},
                   status = 'active',
                   deactivated_at = NULL,
                   deleted_at = NULL,
                   last_seen_at = now(),
                   updated_at = now()
             WHERE provider = 'workos'
               AND subject = ${mutation.subject}
          `;
        }
        return undefined;
      }
      case 'set-user-status': {
        const links = await sql<HostedUserRow[]>`
          SELECT hosted_user_id::text AS hosted_user_id
            FROM papercusp_auth.external_identities
           WHERE provider = 'workos'
             AND subject = ${mutation.subject}
           FOR UPDATE
        `;
        const userId = links[0]?.hosted_user_id;
        if (!userId) return undefined;
        const lifecycleAt = cursor.occurredAt;
        await sql`
          UPDATE papercusp_auth.external_identities
             SET status = ${mutation.status},
                 deactivated_at = ${mutation.status === 'deactivated' ? lifecycleAt : null},
                 deleted_at = ${mutation.status === 'deleted' ? lifecycleAt : null},
                 updated_at = now()
           WHERE provider = 'workos'
             AND subject = ${mutation.subject}
        `;
        await sql`
          UPDATE papercusp_auth.hosted_users
             SET status = ${mutation.status},
                 deactivated_at = ${mutation.status === 'deactivated' ? lifecycleAt : null},
                 deleted_at = ${mutation.status === 'deleted' ? lifecycleAt : null},
                 updated_at = now()
           WHERE id = ${userId}::uuid
        `;
        return { userIds: [userId] };
      }
      case 'upsert-organization': {
        await sql`
          INSERT INTO papercusp_auth.organizations
            (identity_provider, external_organization_id, display_name, status,
             activated_at, suspended_at, offboarding_at, deleted_at, updated_at)
          VALUES
            ('workos', ${mutation.externalOrganizationId}, ${mutation.displayName},
             'active', now(), NULL, NULL, NULL, now())
          ON CONFLICT (identity_provider, external_organization_id) DO UPDATE
            SET display_name = EXCLUDED.display_name,
                status = 'active',
                suspended_at = NULL,
                offboarding_at = NULL,
                deleted_at = NULL,
                updated_at = now()
        `;
        return undefined;
      }
      case 'set-organization-status': {
        const rows = await sql<IdRow[]>`
          UPDATE papercusp_auth.organizations
             SET status = ${mutation.status},
                 suspended_at = ${mutation.status === 'suspended' ? cursor.occurredAt : null},
                 deleted_at = ${mutation.status === 'deleted' ? cursor.occurredAt : null},
                 updated_at = now()
           WHERE identity_provider = 'workos'
             AND external_organization_id = ${mutation.externalOrganizationId}
           RETURNING id::text AS id
        `;
        return rows[0] ? { organizationIds: [rows[0].id] } : undefined;
      }
      case 'upsert-invitation-reference': {
        const organizations = await sql<IdRow[]>`
          SELECT id::text AS id
            FROM papercusp_auth.organizations
           WHERE identity_provider = 'workos'
             AND external_organization_id = ${mutation.externalOrganizationId}
           LIMIT 1
        `;
        if (!organizations[0]) {
          throw new Error(`workos_lifecycle_organization_missing:${mutation.externalOrganizationId}`);
        }
        const rows = await sql<IdRow[]>`
          INSERT INTO papercusp_auth.organization_invitation_refs
            (organization_id, identity_provider, external_invitation_id,
             invitee_email, status, provider_created_at, expires_at, updated_at)
          VALUES
            (${organizations[0].id}::uuid, 'workos', ${mutation.externalInvitationId},
             ${mutation.inviteeEmail}, 'pending', ${mutation.providerCreatedAt},
             ${mutation.expiresAt}, now())
          ON CONFLICT (identity_provider, external_invitation_id) DO UPDATE
            SET invitee_email = EXCLUDED.invitee_email,
                provider_created_at = EXCLUDED.provider_created_at,
                expires_at = EXCLUDED.expires_at,
                updated_at = now()
            WHERE papercusp_auth.organization_invitation_refs.organization_id = EXCLUDED.organization_id
          RETURNING id::text AS id
        `;
        if (!rows[0]) throw new Error(`workos_lifecycle_invitation_collision:${mutation.externalInvitationId}`);
        return undefined;
      }
      case 'set-invitation-status': {
        const accepted = mutation.status === 'accepted';
        const expired = mutation.status === 'expired';
        const revoked = mutation.status === 'revoked';
        await sql`
          UPDATE papercusp_auth.organization_invitation_refs AS invitation
             SET status = ${mutation.status},
                 accepted_at = CASE
                   WHEN ${accepted} AND invitation.accepted_by_user_id IS NOT NULL
                     THEN COALESCE(invitation.accepted_at, ${cursor.occurredAt}::timestamptz)
                   ELSE invitation.accepted_at
                 END,
                 revoked_at = CASE WHEN ${revoked} THEN ${cursor.occurredAt}::timestamptz ELSE invitation.revoked_at END,
                 updated_at = now()
            FROM papercusp_auth.organizations AS organization
           WHERE invitation.organization_id = organization.id
             AND invitation.identity_provider = 'workos'
             AND invitation.external_invitation_id = ${mutation.externalInvitationId}
             AND organization.identity_provider = 'workos'
             AND organization.external_organization_id = ${mutation.externalOrganizationId}
             AND (NOT ${accepted} OR invitation.accepted_by_user_id IS NOT NULL)
             AND (NOT ${expired} OR invitation.expires_at IS NOT NULL)
        `;
        return undefined;
      }
      case 'revoke-session':
        return mergeTargets(
          { upstreamSessionIds: [mutation.upstreamSessionId] },
          mutation.userSubject ? await this.userTargets(sql, mutation.userSubject) : undefined,
          mutation.externalOrganizationId
            ? await this.organizationTargets(sql, mutation.externalOrganizationId)
            : undefined,
        );
      case 'reduce-membership-access': {
        const userTargets = await this.userTargets(sql, mutation.userSubject);
        const organizationTargets = await this.organizationTargets(sql, mutation.externalOrganizationId);
        const userId = userTargets?.userIds?.[0];
        const organizationId = organizationTargets?.organizationIds?.[0];
        if (userId && organizationId) {
          await sql`
            UPDATE papercusp_auth.organization_memberships
               SET status = 'revoked',
                   revoked_at = COALESCE(revoked_at, ${cursor.occurredAt}::timestamptz),
                   updated_at = now()
             WHERE user_id = ${userId}::uuid
               AND organization_id = ${organizationId}::uuid
               AND status <> 'revoked'
          `;
        }
        return mergeTargets(userTargets, organizationTargets);
      }
      case 'ignore-external-authority':
        return undefined;
    }
  }

  private async userTargets(sql: Sql, subject: string): Promise<WorkosLifecycleClosureTargets | undefined> {
    const rows = await sql<HostedUserRow[]>`
      SELECT hosted_user_id::text AS hosted_user_id
        FROM papercusp_auth.external_identities
       WHERE provider = 'workos'
         AND subject = ${subject}
       LIMIT 1
    `;
    return rows[0] ? { userIds: [rows[0].hosted_user_id] } : undefined;
  }

  private async organizationTargets(
    sql: Sql,
    externalOrganizationId: string,
  ): Promise<WorkosLifecycleClosureTargets | undefined> {
    const rows = await sql<IdRow[]>`
      SELECT id::text AS id
        FROM papercusp_auth.organizations
       WHERE identity_provider = 'workos'
         AND external_organization_id = ${externalOrganizationId}
       LIMIT 1
    `;
    return rows[0] ? { organizationIds: [rows[0].id] } : undefined;
  }

  async acknowledgeClosure(eventId: string): Promise<void> {
    const id = requiredText(eventId, 'eventId');
    await this.run(async (sql) => {
      await sql`
        UPDATE papercusp_auth.webhook_event_receipts
           SET closure_targets = NULL,
               closure_acknowledged_at = COALESCE(closure_acknowledged_at, now())
         WHERE provider = 'workos'
           AND event_id = ${id}
      `;
    });
  }

  async markIgnored(eventId: string, reason = 'unsupported_event_type'): Promise<void> {
    const id = requiredText(eventId, 'eventId');
    const code = requiredText(reason, 'reason');
    await this.run(async (sql) => {
      await sql`
        UPDATE papercusp_auth.webhook_event_receipts
           SET status = 'ignored',
               processing_started_at = COALESCE(processing_started_at, now()),
               processed_at = COALESCE(processed_at, now()),
               attempt_count = CASE WHEN processed_at IS NULL THEN attempt_count + 1 ELSE attempt_count END,
               last_attempt_at = now(),
               last_error_code = ${code}
         WHERE provider = 'workos'
           AND event_id = ${id}
           AND lifecycle_entity_key IS NULL
      `;
    });
  }
}

/** Idempotently closes the hosted-session portion of a lifecycle signal. */
export class PostgresWorkosAccessClosureSink implements WorkosAccessClosureSink {
  constructor(private readonly run: HostedServiceContextRunner = withHostedServiceContext) {}

  async closeAffectedAccess(signal: WorkosAccessClosureSignal): Promise<void> {
    const targets = normalizeTargets(signal.targets);
    if (!targets) return;
    const targetsJson = JSON.stringify(targets);
    await this.run(async (sql) => {
      await sql`
        UPDATE papercusp_auth.hosted_sessions AS session
           SET revoked_at = COALESCE(session.revoked_at, now()),
               revocation_reason = COALESCE(session.revocation_reason, ${`workos_${signal.cause}`}),
               updated_at = now()
         WHERE session.revoked_at IS NULL
           AND (
             session.id IN (
               SELECT jsonb_array_elements_text(
                 COALESCE((${targetsJson}::text::jsonb)->'hostedSessionIds', '[]'::jsonb)
               )
             )
             OR session.upstream_session_id IN (
               SELECT jsonb_array_elements_text(
                 COALESCE((${targetsJson}::text::jsonb)->'upstreamSessionIds', '[]'::jsonb)
               )
             )
             OR session.user_id IN (
               SELECT jsonb_array_elements_text(
                 COALESCE((${targetsJson}::text::jsonb)->'userIds', '[]'::jsonb)
               )
             )
             OR session.organization_id IN (
               SELECT jsonb_array_elements_text(
                 COALESCE((${targetsJson}::text::jsonb)->'organizationIds', '[]'::jsonb)
               )
             )
           )
      `;
    });
  }
}

function lifecycleBase(receipt: WorkOsWebhookReceiptResult) {
  const data = record(receipt.payload.data);
  if (!data) throw new TypeError('workos_lifecycle_event_data_missing');
  const providerVersion =
    receipt.eventVersion ?? optionalText(data.updated_at) ?? optionalText(data.updatedAt) ?? receipt.eventId;
  return {
    data,
    eventId: receipt.eventId,
    occurredAt: receipt.eventCreatedAt,
    receivedAt: receipt.receivedAt,
    version: providerVersion,
  };
}

/** Convert a verified WorkOS receipt into the worker's secret-free union. */
export function workosLifecycleEventFromReceipt(receipt: WorkOsWebhookReceiptResult): WorkosLifecycleEvent | null {
  const base = lifecycleBase(receipt);
  const { data } = base;
  switch (receipt.eventType) {
    case 'user.created':
    case 'user.updated': {
      const first = optionalText(data.first_name);
      const last = optionalText(data.last_name);
      const compositeName = [first, last].filter(Boolean).join(' ') || undefined;
      return {
        ...base,
        kind: 'user.upsert',
        userSubject: requiredText(data.id, 'data.id'),
        email: optionalText(data.email) ?? null,
        displayName: optionalText(data.name) ?? compositeName ?? null,
      };
    }
    case 'user.deleted':
      return { ...base, kind: 'user.deleted', userSubject: requiredText(data.id, 'data.id') };
    case 'organization.created':
    case 'organization.updated':
      return {
        ...base,
        kind: 'organization.upsert',
        organizationSubject: requiredText(data.id, 'data.id'),
        displayName: requiredText(data.name, 'data.name'),
      };
    case 'organization.deleted':
      return {
        ...base,
        kind: 'organization.deleted',
        organizationSubject: requiredText(data.id, 'data.id'),
      };
    case 'invitation.created':
    case 'invitation.resent':
      return {
        ...base,
        kind: 'invitation.upsert',
        invitationSubject: requiredText(data.id, 'data.id'),
        organizationSubject: requiredText(data.organization_id, 'data.organization_id'),
        inviteeEmail: requiredText(data.email, 'data.email'),
        providerCreatedAt: optionalText(data.created_at) ? date(data.created_at, 'data.created_at') : null,
        expiresAt: optionalText(data.expires_at) ? date(data.expires_at, 'data.expires_at') : null,
      };
    case 'invitation.accepted':
    case 'invitation.revoked':
      return {
        ...base,
        kind: receipt.eventType === 'invitation.accepted' ? 'invitation.accepted' : 'invitation.revoked',
        invitationSubject: requiredText(data.id, 'data.id'),
        organizationSubject: requiredText(data.organization_id, 'data.organization_id'),
      };
    case 'session.revoked':
      return {
        ...base,
        kind: 'session.revoked',
        sessionSubject: requiredText(data.id, 'data.id'),
        ...(optionalText(data.user_id) ? { userSubject: optionalText(data.user_id) } : {}),
        ...(optionalText(data.organization_id) ? { organizationSubject: optionalText(data.organization_id) } : {}),
      };
    case 'organization_membership.created':
      return {
        ...base,
        kind: 'membership.upsert',
        userSubject: requiredText(data.user_id, 'data.user_id'),
        organizationSubject: requiredText(data.organization_id, 'data.organization_id'),
      };
    case 'organization_membership.deleted':
      return {
        ...base,
        kind: 'membership.revoked',
        userSubject: requiredText(data.user_id, 'data.user_id'),
        organizationSubject: requiredText(data.organization_id, 'data.organization_id'),
      };
    case 'organization_membership.updated':
      return {
        ...base,
        kind: data.status === 'active' ? 'membership.upsert' : 'membership.revoked',
        userSubject: requiredText(data.user_id, 'data.user_id'),
        organizationSubject: requiredText(data.organization_id, 'data.organization_id'),
      };
    default:
      return null;
  }
}
