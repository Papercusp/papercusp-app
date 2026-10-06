/**
 * Explicit public hosted-account admission.
 *
 * This seam is deliberately separate from `bindHostedIdentity`: sign-in is a
 * read-only membership lookup, while sign-up is an owner-authorized write that
 * creates the first Papercusp tenant.  The production adapter runs the whole
 * admission (identity, organization, owner membership, legal records,
 * entitlement, and local session) in one hosted-service transaction.
 */
import { createHash, randomBytes } from 'node:crypto';
import { withHostedServiceContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { HostedIdentityBinding } from '../../endpoint-route/routes/hosted-auth';
import type { HostedSession } from '../hosted-session';
import type { HostedVerifiedIdentity } from './provider';
import { hostedMembershipAuthorityVersion } from '../hosted-membership-authority';
import type { HostedServiceContextRunner } from './workos-lifecycle-postgres';

export type HostedSelfSignupFailureCode =
  | 'invalid_request'
  | 'duplicate_identity'
  | 'rate_limited'
  | 'state_conflict'
  | 'unavailable';

/** Reviewed document versions accepted by the current Portal signup surface. */
export const HOSTED_SELF_SIGNUP_TERMS_VERSION = 'terms-2026-09';
export const HOSTED_SELF_SIGNUP_PRIVACY_VERSION = 'privacy-2026-09';

export interface HostedSelfSignupInput {
  readonly attemptId: string;
  readonly providerId: string;
  readonly identity: HostedVerifiedIdentity;
  readonly upstreamSessionId: string;
  /** When the local hosted session ends — the hosted session lifetime, not the access token's. */
  readonly sessionExpiresAt: Date;
  readonly termsVersion: string;
  readonly privacyVersion: string;
  readonly acceptedAt: Date;
}

export interface HostedSelfSignupSuccess {
  readonly ok: true;
  readonly binding: HostedIdentityBinding;
  readonly session: HostedSession;
}

export interface HostedSelfSignupFailure {
  readonly ok: false;
  readonly code: HostedSelfSignupFailureCode;
  readonly retryable: boolean;
}

export type HostedSelfSignupResult = HostedSelfSignupSuccess | HostedSelfSignupFailure;

export interface HostedSelfSignupAdmission {
  complete(input: HostedSelfSignupInput): Promise<HostedSelfSignupResult>;
}

export class HostedSelfSignupError extends Error {
  constructor(
    readonly code: HostedSelfSignupFailureCode,
    readonly retryable = code === 'unavailable',
  ) {
    super(`hosted_self_signup_${code}`);
    this.name = 'HostedSelfSignupError';
  }
}

function text(value: unknown, max = 512): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max ? normalized : null;
}

function email(value: unknown): string | null {
  const normalized = text(value, 320)?.toLowerCase() ?? null;
  return normalized && normalized.includes('@') ? normalized : null;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validate(input: HostedSelfSignupInput): void {
  if (
    !text(input.attemptId, 2_048) ||
    !text(input.providerId, 64) ||
    !text(input.identity?.externalUserId) ||
    !email(input.identity?.primaryEmail) ||
    input.identity?.emailVerified !== true ||
    !text(input.upstreamSessionId) ||
    !validDate(input.sessionExpiresAt) ||
    input.sessionExpiresAt.getTime() <= Date.now() ||
    !text(input.termsVersion, 128) ||
    !text(input.privacyVersion, 128) ||
    !validDate(input.acceptedAt)
  ) throw new HostedSelfSignupError('invalid_request');
}

function sessionId(): string {
  return `hs_${randomBytes(32).toString('base64url')}`;
}

function organizationExternalId(attemptId: string): string {
  return `self-signup:${createHash('sha256').update(attemptId).digest('hex').slice(0, 40)}`;
}

interface SessionRow {
  id: string;
  user_id: string;
  organization_id: string;
  permission_version: number | string;
  upstream_provider: string;
  upstream_session_id: string;
  created_at: Date | string;
  expires_at: Date | string;
  updated_at: Date | string;
}

function date(value: Date | string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new HostedSelfSignupError('unavailable');
  return parsed;
}

function sessionFromRow(row: SessionRow): HostedSession {
  const createdAt = date(row.created_at);
  return {
    id: row.id,
    userId: row.user_id,
    organizationId: row.organization_id,
    workspaceId: null,
    permissionVersion: Number(row.permission_version),
    upstreamProvider: row.upstream_provider,
    upstreamSessionId: row.upstream_session_id,
    createdAt,
    rotatedAt: null,
    expiresAt: date(row.expires_at),
    lastSeenAt: null,
    revokedAt: null,
    revocationReason: null,
    updatedAt: date(row.updated_at),
  };
}

/** Signup attempts one normalized email may start per rolling hour before refusal. */
export const HOSTED_SELF_SIGNUP_ATTEMPTS_PER_EMAIL_PER_HOUR = 5;

type AttemptGate = 'proceed' | 'rate_limited' | 'state_conflict';

/** Hosted-service adapter. `run` is injectable for hermetic tests. */
export class PostgresHostedSelfSignupAdmission implements HostedSelfSignupAdmission {
  constructor(private readonly run: HostedServiceContextRunner = (fn) => withHostedServiceContext(fn)) {}

  async complete(input: HostedSelfSignupInput): Promise<HostedSelfSignupResult> {
    try {
      validate(input);
      // Two transactions on purpose. The attempt ledger must COMMIT before the
      // admission runs: every refusal inside the admission throws and rolls its
      // transaction back, so a ledger row written there would vanish with it and
      // the per-email limit would only ever count completed signups (which the
      // duplicate check already caps at one) — i.e. it could never fire.
      const gate = await this.run((sql) => this.recordAttempt(sql, input));
      if (gate !== 'proceed') throw new HostedSelfSignupError(gate);
      return await this.run((sql) => this.completeInTransaction(sql, input));
    } catch (error) {
      if (error instanceof HostedSelfSignupError) {
        return { ok: false, code: error.code, retryable: error.retryable };
      }
      // Concurrent admission can win the provider-subject/email unique index
      // between the duplicate probes and the inserts. Surface that as the
      // same deterministic duplicate outcome rather than a retryable 503.
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505') {
        return { ok: false, code: 'duplicate_identity', retryable: false };
      }
      return { ok: false, code: 'unavailable', retryable: true };
    }
  }

  /**
   * Commit this attempt to the ledger and apply the per-email abuse limit.
   *
   * Runs in its OWN transaction and never throws for a refusal, so a
   * `rate_limited` row it writes is committed and counts against the next
   * attempt. A returning user whose provider identity has a membership is not
   * an abuse signal — the route turns their `duplicate_identity` into a sign-in —
   * so they are exempt from the count AND write no ledger row: their click is a
   * sign-in, not an admission attempt, and a row committed here would sit in
   * 'pending' forever because the admission that could resolve it rolls back
   * (measured live 2026-09-29, WI-10002240). completeInTransaction still owns
   * the attempt-id fingerprint check and the completed-attempt replay for them.
   */
  private async recordAttempt(sql: Sql, input: HostedSelfSignupInput): Promise<AttemptGate> {
    const providerId = text(input.providerId, 64) as string;
    const subject = text(input.identity.externalUserId) as string;
    const verifiedEmail = email(input.identity.primaryEmail) as string;
    const attemptId = text(input.attemptId, 2_048) as string;
    const fingerprint = `${providerId}|${subject}|${verifiedEmail}`;

    const linked = await sql<Array<{ hosted_user_id: string }>>`
      SELECT hosted_user_id::text AS hosted_user_id
        FROM papercusp_auth.external_identities AS identity
       WHERE provider = ${providerId} AND subject = ${subject}
         AND EXISTS (
           SELECT 1 FROM papercusp_auth.organization_memberships AS membership
            WHERE membership.user_id = identity.hosted_user_id
         )
       LIMIT 1
    `;
    if (linked[0]) return 'proceed';

    await sql`
      INSERT INTO papercusp_auth.hosted_signup_attempts
        (attempt_id, provider, subject, email, fingerprint, status)
      VALUES (${attemptId}, ${providerId}, ${subject}, ${verifiedEmail}, ${fingerprint}, 'pending')
      ON CONFLICT (attempt_id) DO NOTHING
    `;
    const attempts = await sql<Array<{ fingerprint: string; status: string }>>`
      SELECT fingerprint, status
        FROM papercusp_auth.hosted_signup_attempts
       WHERE attempt_id = ${attemptId}
       FOR UPDATE
    `;
    const attempt = attempts[0];
    if (!attempt || attempt.fingerprint !== fingerprint) return 'state_conflict';
    if (attempt.status === 'completed') return 'proceed';
    if (attempt.status === 'rate_limited') return 'rate_limited';

    const recent = await sql<Array<{ count: number | string }>>`
      SELECT count(*)::int AS count
        FROM papercusp_auth.hosted_signup_attempts
       WHERE email = ${verifiedEmail}
         AND created_at > now() - interval '1 hour'
         AND attempt_id <> ${attemptId}
    `;
    if (Number(recent[0]?.count ?? 0) >= HOSTED_SELF_SIGNUP_ATTEMPTS_PER_EMAIL_PER_HOUR) {
      await sql`
        UPDATE papercusp_auth.hosted_signup_attempts
           SET status = 'rate_limited', updated_at = now()
         WHERE attempt_id = ${attemptId}
      `;
      return 'rate_limited';
    }
    return 'proceed';
  }

  private async completeInTransaction(sql: Sql, input: HostedSelfSignupInput): Promise<HostedSelfSignupSuccess> {
    const providerId = text(input.providerId, 64) as string;
    const subject = text(input.identity.externalUserId) as string;
    const verifiedEmail = email(input.identity.primaryEmail) as string;
    const attemptId = text(input.attemptId, 2_048) as string;
    const fingerprint = `${providerId}|${subject}|${verifiedEmail}`;

    await sql`
      INSERT INTO papercusp_auth.hosted_signup_attempts
        (attempt_id, provider, subject, email, fingerprint, status)
      VALUES (${attemptId}, ${providerId}, ${subject}, ${verifiedEmail}, ${fingerprint}, 'pending')
      ON CONFLICT (attempt_id) DO NOTHING
    `;
    const attempts = await sql<Array<{
      attempt_id: string; provider: string; subject: string; email: string;
      fingerprint: string; status: string; user_id: string | null;
      organization_id: string | null; session_id: string | null;
    }>>`
      SELECT attempt_id, provider, subject, email, fingerprint, status,
             user_id::text AS user_id, organization_id::text AS organization_id, session_id
        FROM papercusp_auth.hosted_signup_attempts
       WHERE attempt_id = ${attemptId}
       FOR UPDATE
    `;
    const attempt = attempts[0];
    if (!attempt || attempt.fingerprint !== fingerprint) throw new HostedSelfSignupError('state_conflict');
    if (attempt.status === 'completed' && attempt.user_id && attempt.organization_id && attempt.session_id) {
      const rows = await sql<SessionRow[]>`
        SELECT id, user_id, organization_id, permission_version, upstream_provider,
               upstream_session_id, created_at, expires_at, updated_at
          FROM papercusp_auth.hosted_sessions
         WHERE id = ${attempt.session_id}
         LIMIT 1
      `;
      if (!rows[0]) throw new HostedSelfSignupError('unavailable');
      const session = sessionFromRow(rows[0]);
      return {
        ok: true,
        session,
        binding: {
          userId: session.userId,
          organizationId: session.organizationId,
          workspaceId: null,
          permissionVersion: session.permissionVersion,
        },
      };
    }

    // The per-email limit was applied by recordAttempt in its own committed
    // transaction; nothing here may record a refusal, because it rolls back.

    // Serialize admissions for one normalized email without introducing a
    // global unique-email rule (existing hosted identities may legitimately
    // share an email across providers). The xact lock releases on rollback.
    await sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${verifiedEmail}, 0))
    `;
    if (providerId === 'workos') {
      // Same key as PostgresWorkosLifecycleProjectionStore.applyInTransaction:
      // serialize even when neither writer has inserted the identity row yet.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workos:workos:user:${subject}`}, 0))`;
    }

    // A WorkOS user.created projection can arrive before the signup callback.
    // It establishes identity existence, never Papercusp membership. Explicit
    // signup may complete that admission only for the exact active identity and
    // verified email, with no prior membership (including revoked membership).
    // Lock both rows before checking membership so concurrent signup attempts
    // cannot each create an owner tenant for the same projected user.
    const existingIdentity = await sql<Array<{
      hosted_user_id: string; identity_status: string; user_status: string; primary_email: string | null;
    }>>`
      SELECT identity.hosted_user_id::text AS hosted_user_id,
             identity.status AS identity_status, user_row.status AS user_status,
             lower(user_row.primary_email) AS primary_email
        FROM papercusp_auth.external_identities AS identity
        JOIN papercusp_auth.hosted_users AS user_row ON user_row.id = identity.hosted_user_id
       WHERE identity.provider = ${providerId} AND identity.subject = ${subject}
       LIMIT 1
       FOR UPDATE OF identity, user_row
    `;
    const linked = existingIdentity[0];
    if (linked) {
      if (linked.identity_status !== 'active' || linked.user_status !== 'active' || linked.primary_email !== verifiedEmail) {
        throw new HostedSelfSignupError('duplicate_identity');
      }
      const memberships = await sql<Array<{ id: string }>>`
        SELECT id::text FROM papercusp_auth.organization_memberships
         WHERE user_id = ${linked.hosted_user_id}::uuid LIMIT 1
      `;
      if (memberships[0]) throw new HostedSelfSignupError('duplicate_identity');
    }

    const existingEmail = await sql<Array<{ id: string }>>`
      SELECT id::text AS id
        FROM papercusp_auth.hosted_users
       WHERE lower(primary_email) = ${verifiedEmail} AND status = 'active'
         AND (${linked?.hosted_user_id ?? null}::uuid IS NULL OR id <> ${linked?.hosted_user_id ?? null}::uuid)
       LIMIT 1
    `;
    if (existingEmail[0]) throw new HostedSelfSignupError('duplicate_identity');

    let userId = linked?.hosted_user_id;
    if (!userId) {
      const users = await sql<Array<{ id: string }>>`
        INSERT INTO papercusp_auth.hosted_users (primary_email, display_name)
        VALUES (${verifiedEmail}, ${text(input.identity.displayName, 512)})
        RETURNING id::text AS id
      `;
      userId = users[0]?.id;
      if (!userId) throw new HostedSelfSignupError('unavailable');
      await sql`
        INSERT INTO papercusp_auth.external_identities
          (hosted_user_id, provider, subject, provider_email, profile)
        VALUES (${userId}::uuid, ${providerId}, ${subject}, ${verifiedEmail}, '{}'::jsonb)
      `;
    }
    const organizations = await sql<Array<{ id: string }>>`
      INSERT INTO papercusp_auth.organizations
        (identity_provider, external_organization_id, display_name)
      VALUES (
        ${providerId}, ${organizationExternalId(attemptId)},
        ${text(input.identity.displayName, 512) ?? `${verifiedEmail}'s organization`}
      )
      RETURNING id::text AS id
    `;
    const organizationId = organizations[0]?.id;
    if (!organizationId) throw new HostedSelfSignupError('unavailable');

    const memberships = await sql<Array<{ id: string; updated_at: Date | string }>>`
      SELECT id::text AS id, updated_at
        FROM papercusp_auth.bootstrap_hosted_self_signup_membership(
          ${organizationId}::uuid, ${userId}::uuid
        )
    `;
    const permissionVersion = hostedMembershipAuthorityVersion(memberships[0]?.updated_at as Date | string);

    for (const [kind, version] of [['terms', input.termsVersion], ['privacy', input.privacyVersion] as const]) {
      await sql`
        SELECT papercusp_auth.record_hosted_self_signup_legal(
          ${organizationId}::uuid, ${userId}::uuid, ${kind}, ${version}, ${input.acceptedAt}
        )
      `;
    }
    await sql`
      INSERT INTO papercusp_auth.hosted_entitlements (organization_id, user_id, kind, source)
      VALUES (${organizationId}::uuid, ${userId}::uuid, 'hosted-free', 'self_signup')
      ON CONFLICT (organization_id, user_id, kind) DO NOTHING
    `;

    const id = sessionId();
    const sessions = await sql<SessionRow[]>`
      INSERT INTO papercusp_auth.hosted_sessions
        (id, user_id, organization_id, workspace_id, permission_version,
         upstream_provider, upstream_session_id, expires_at)
      VALUES (${id}, ${userId}, ${organizationId}, NULL, ${permissionVersion},
              ${providerId}, ${input.upstreamSessionId}, ${input.sessionExpiresAt})
      RETURNING id, user_id, organization_id, permission_version, upstream_provider,
                upstream_session_id, created_at, expires_at, updated_at
    `;
    const session = sessions[0];
    if (!session) throw new HostedSelfSignupError('unavailable');
    await sql`
      UPDATE papercusp_auth.hosted_signup_attempts
         SET status = 'completed', user_id = ${userId}::uuid,
             organization_id = ${organizationId}::uuid, session_id = ${id}, updated_at = now()
       WHERE attempt_id = ${attemptId}
    `;
    const stored = sessionFromRow(session);
    return {
      ok: true,
      session: stored,
      binding: { userId, organizationId, workspaceId: null, permissionVersion },
    };
  }
}
