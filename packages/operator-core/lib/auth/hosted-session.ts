/**
 * Revocable hosted browser sessions for app.papercusp.com.
 *
 * Hosted sessions deliberately do not reuse the local `papercusp_session`
 * contract in ../auth.ts. The local session can carry wildcard capabilities
 * and is intended for a loopback desktop install. A hosted session stores only
 * tenant identity plus a permission-version snapshot; current permissions are
 * derived from the membership/grant model on every authorization path.
 *
 * The database stores a random opaque id, never the cookie value or an upstream
 * identity-provider token. The cookie HMAC authenticates that id. Rotation
 * replaces the primary key in-place, invalidating the old cookie while keeping
 * the provider-session uniqueness and revocation history on one row.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org/connection';
import { serializeDeleteCookie, serializeSetCookie } from '../endpoint-route/cookies';

export const HOSTED_SESSION_COOKIE = '__Host-papercusp_session';
export const HOSTED_SESSION_ID_BYTES = 32;
export const HOSTED_SESSION_COOKIE_VERSION = 'v1';

const HOSTED_SESSION_ID_RE = /^hs_[A-Za-z0-9_-]{43}$/;
const MIN_COOKIE_SECRET_BYTES = 32;

/**
 * A root pool OR a caller's open transaction. The hosted service context
 * (`withHostedServiceContext`) hands the store a TransactionSql, which has no
 * `.begin()` — see `rotate`.
 */
type SqlClient = ReturnType<typeof getOrgPg>['sql'] | TransactionSql;

export type HostedSessionErrorCode =
  | 'hosted_session_invalid_input'
  | 'hosted_session_authority_forbidden'
  | 'hosted_session_expired'
  | 'hosted_session_cookie_secret_invalid';

export interface HostedSessionError extends Error {
  code: HostedSessionErrorCode;
}

export interface HostedSession {
  id: string;
  userId: string;
  organizationId: string;
  workspaceId: string | null;
  permissionVersion: number;
  upstreamProvider: string;
  upstreamSessionId: string;
  createdAt: Date;
  rotatedAt: Date | null;
  expiresAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  revocationReason: string | null;
  updatedAt: Date;
}

export interface CreateHostedSessionInput {
  userId: string;
  organizationId: string;
  workspaceId?: string | null;
  permissionVersion: number;
  upstreamProvider: string;
  upstreamSessionId: string;
  expiresAt: Date;
}

export interface ResolveHostedSessionOptions {
  /** Fail closed when the caller's current authority version differs. */
  expectedPermissionVersion?: number;
  at?: Date;
}

export interface RotateHostedSessionInput {
  /** Optimistic authority check against the row being rotated. */
  expectedPermissionVersion?: number;
  permissionVersion?: number;
  /** Omitted preserves the current selection; null explicitly clears it. */
  workspaceId?: string | null;
  expiresAt?: Date;
  at?: Date;
}

interface HostedSessionRow {
  id: string;
  user_id: string;
  organization_id: string;
  workspace_id: string | null;
  permission_version: number | string;
  upstream_provider: string;
  upstream_session_id: string;
  created_at: Date | string;
  rotated_at: Date | string | null;
  expires_at: Date | string;
  last_seen_at: Date | string | null;
  revoked_at: Date | string | null;
  revocation_reason: string | null;
  updated_at: Date | string;
}

const SELECT_COLUMNS = `
  id, user_id, organization_id, workspace_id, permission_version,
  upstream_provider, upstream_session_id, created_at, rotated_at, expires_at,
  last_seen_at, revoked_at, revocation_reason, updated_at
`;

function fail(code: HostedSessionErrorCode, message: string): never {
  throw Object.assign(new Error(message), { code }) as HostedSessionError;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('hosted_session_invalid_input', `${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > 512) {
    fail('hosted_session_invalid_input', `${field} is too long`);
  }
  return normalized;
}

function optionalId(value: unknown, field: string): string | null {
  if (value == null) return null;
  return nonEmpty(value, field);
}

function permissionVersion(value: unknown, field = 'permissionVersion'): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    fail('hosted_session_invalid_input', `${field} must be a non-negative safe integer`);
  }
  return n;
}

function validDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail('hosted_session_invalid_input', `${field} must be a valid Date`);
  }
  return value;
}

function futureDate(value: unknown, now: Date, field = 'expiresAt'): Date {
  const date = validDate(value, field);
  if (date.getTime() <= now.getTime()) {
    fail('hosted_session_expired', `${field} must be in the future`);
  }
  return date;
}

function dateFromPg(value: Date | string, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    fail('hosted_session_invalid_input', `database returned invalid ${field}`);
  }
  return date;
}

function nullableDateFromPg(value: Date | string | null, field: string): Date | null {
  return value == null ? null : dateFromPg(value, field);
}

function fromRow(row: HostedSessionRow): HostedSession {
  return {
    id: row.id,
    userId: row.user_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    permissionVersion: permissionVersion(row.permission_version, 'permission_version'),
    upstreamProvider: row.upstream_provider,
    upstreamSessionId: row.upstream_session_id,
    createdAt: dateFromPg(row.created_at, 'created_at'),
    rotatedAt: nullableDateFromPg(row.rotated_at, 'rotated_at'),
    expiresAt: dateFromPg(row.expires_at, 'expires_at'),
    lastSeenAt: nullableDateFromPg(row.last_seen_at, 'last_seen_at'),
    revokedAt: nullableDateFromPg(row.revoked_at, 'revoked_at'),
    revocationReason: row.revocation_reason,
    updatedAt: dateFromPg(row.updated_at, 'updated_at'),
  };
}

function newSessionId(): string {
  return `hs_${randomBytes(HOSTED_SESSION_ID_BYTES).toString('base64url')}`;
}

function assertSessionId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !HOSTED_SESSION_ID_RE.test(id)) {
    fail('hosted_session_invalid_input', 'invalid hosted session id');
  }
}

function assertNoSessionAuthority(input: object): void {
  const record = input as Record<string, unknown>;
  if ('capabilities' in record || 'permissions' in record) {
    fail(
      'hosted_session_authority_forbidden',
      'hosted sessions cannot carry capabilities or permissions; derive them from current grants',
    );
  }
}

function normalizeCreateInput(input: CreateHostedSessionInput, now: Date) {
  assertNoSessionAuthority(input);
  return {
    userId: nonEmpty(input.userId, 'userId'),
    organizationId: nonEmpty(input.organizationId, 'organizationId'),
    workspaceId: optionalId(input.workspaceId, 'workspaceId'),
    permissionVersion: permissionVersion(input.permissionVersion),
    upstreamProvider: nonEmpty(input.upstreamProvider, 'upstreamProvider'),
    upstreamSessionId: nonEmpty(input.upstreamSessionId, 'upstreamSessionId'),
    expiresAt: futureDate(input.expiresAt, now),
  };
}

function normalizeReason(reason: string | undefined, fallback: string): string {
  const normalized = (reason ?? fallback).trim();
  if (!normalized || normalized.length > 256) {
    fail('hosted_session_invalid_input', 'revocation reason must be 1-256 characters');
  }
  return normalized;
}

/**
 * HMAC codec for the Secure/HttpOnly/host-only browser cookie.
 *
 * The `__Host-` prefix plus Secure + Path=/ + no Domain attribute makes a
 * browser reject any attempt to widen the cookie to `*.papercusp.com`.
 */
export class HostedSessionCookieCodec {
  private readonly secret: Buffer;

  constructor(secret: string | Uint8Array) {
    const bytes = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
    if (bytes.byteLength < MIN_COOKIE_SECRET_BYTES) {
      fail(
        'hosted_session_cookie_secret_invalid',
        `hosted session cookie secret must be at least ${MIN_COOKIE_SECRET_BYTES} bytes`,
      );
    }
    this.secret = Buffer.from(bytes);
  }

  encode(sessionId: string): string {
    assertSessionId(sessionId);
    const payload = Buffer.from(sessionId, 'utf8').toString('base64url');
    const signed = `${HOSTED_SESSION_COOKIE_VERSION}.${payload}`;
    const signature = createHmac('sha256', this.secret).update(signed).digest('base64url');
    return `${signed}.${signature}`;
  }

  decode(value: string | null | undefined): string | null {
    if (!value) return null;
    const parts = value.split('.');
    if (parts.length !== 3 || parts[0] !== HOSTED_SESSION_COOKIE_VERSION) return null;
    const signed = `${parts[0]}.${parts[1]}`;
    const expected = createHmac('sha256', this.secret).update(signed).digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(parts[2], 'base64url');
    } catch {
      return null;
    }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    let sessionId: string;
    try {
      sessionId = Buffer.from(parts[1], 'base64url').toString('utf8');
    } catch {
      return null;
    }
    return HOSTED_SESSION_ID_RE.test(sessionId) ? sessionId : null;
  }

  read(headers: Headers): string | null {
    const header = headers.get('cookie');
    if (!header) return null;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0 || part.slice(0, eq).trim() !== HOSTED_SESSION_COOKIE) continue;
      try {
        return this.decode(decodeURIComponent(part.slice(eq + 1).trim()));
      } catch {
        return null;
      }
    }
    return null;
  }

  serialize(sessionId: string, expiresAt: Date, now = new Date()): string {
    const expiry = futureDate(expiresAt, now);
    const maxAge = Math.max(1, Math.floor((expiry.getTime() - now.getTime()) / 1000));
    return serializeSetCookie(HOSTED_SESSION_COOKIE, this.encode(sessionId), {
      expires: expiry,
      httpOnly: true,
      maxAge,
      path: '/',
      sameSite: 'Lax',
      secure: true,
    });
  }

  delete(): string {
    return serializeDeleteCookie(HOSTED_SESSION_COOKIE, '/', {
      httpOnly: true,
      sameSite: 'Lax',
      secure: true,
    });
  }
}

export class HostedSessionStore {
  constructor(
    private readonly sql: SqlClient = getOrgPg().sql,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async create(input: CreateHostedSessionInput): Promise<HostedSession> {
    const now = this.clock();
    const normalized = normalizeCreateInput(input, now);
    const id = newSessionId();
    // The identity provider keeps its own session far longer than the access
    // token a local session is bound to, so signing in again from the same
    // browser returns an upstream session id we have already seen. That is a
    // re-authentication of the same person: retire their earlier local session
    // for it. Only the SAME user's rows are retired — a live row for this
    // upstream session owned by anyone else still refuses the insert below
    // (unique among unrevoked rows, migration 1203).
    await this.sql`
      UPDATE papercusp_auth.hosted_sessions
         SET revoked_at = ${now.toISOString()},
             revocation_reason = 'superseded_by_reauthentication',
             updated_at = ${now.toISOString()}
       WHERE upstream_provider = ${normalized.upstreamProvider}
         AND upstream_session_id = ${normalized.upstreamSessionId}
         AND user_id = ${normalized.userId}
         AND revoked_at IS NULL
    `;
    const rows = await this.sql<HostedSessionRow[]>`
      INSERT INTO papercusp_auth.hosted_sessions
        (id, user_id, organization_id, workspace_id, permission_version,
         upstream_provider, upstream_session_id, created_at, expires_at, updated_at)
      VALUES
        (${id}, ${normalized.userId}, ${normalized.organizationId}, ${normalized.workspaceId},
         ${normalized.permissionVersion}, ${normalized.upstreamProvider}, ${normalized.upstreamSessionId},
         ${now.toISOString()}, ${normalized.expiresAt.toISOString()}, ${now.toISOString()})
      RETURNING ${this.sql.unsafe(SELECT_COLUMNS)}
    `;
    return fromRow(rows[0]);
  }

  async resolve(id: string, opts: ResolveHostedSessionOptions = {}): Promise<HostedSession | null> {
    if (!HOSTED_SESSION_ID_RE.test(id)) return null;
    const at = opts.at ?? this.clock();
    validDate(at, 'at');
    if (opts.expectedPermissionVersion !== undefined) {
      permissionVersion(opts.expectedPermissionVersion, 'expectedPermissionVersion');
    }
    const rows = await this.sql<HostedSessionRow[]>`
      SELECT ${this.sql.unsafe(SELECT_COLUMNS)}
        FROM papercusp_auth.hosted_sessions
       WHERE id = ${id}
         AND revoked_at IS NULL
         AND expires_at > ${at.toISOString()}
       LIMIT 1
    `;
    if (rows.length === 0) return null;
    const session = fromRow(rows[0]);
    if (
      opts.expectedPermissionVersion !== undefined
      && session.permissionVersion !== opts.expectedPermissionVersion
    ) {
      return null;
    }
    return session;
  }

  async rotate(id: string, input: RotateHostedSessionInput = {}): Promise<HostedSession | null> {
    if (!HOSTED_SESSION_ID_RE.test(id)) return null;
    assertNoSessionAuthority(input);
    const at = input.at ?? this.clock();
    validDate(at, 'at');
    const expected = input.expectedPermissionVersion === undefined
      ? undefined
      : permissionVersion(input.expectedPermissionVersion, 'expectedPermissionVersion');
    const requestedVersion = input.permissionVersion === undefined
      ? undefined
      : permissionVersion(input.permissionVersion);
    const requestedExpiry = input.expiresAt === undefined
      ? undefined
      : futureDate(input.expiresAt, at);
    const hasWorkspaceOverride = Object.prototype.hasOwnProperty.call(input, 'workspaceId');
    const requestedWorkspace = hasWorkspaceOverride
      ? optionalId(input.workspaceId, 'workspaceId')
      : undefined;
    const nextId = newSessionId();

    const rotateInTransaction = async (tx: TransactionSql): Promise<HostedSession | null> => {
      const currentRows = (await tx<HostedSessionRow[]>`
        SELECT ${tx.unsafe(SELECT_COLUMNS)}
          FROM papercusp_auth.hosted_sessions
         WHERE id = ${id}
         FOR UPDATE
      `) as HostedSessionRow[];
      if (currentRows.length === 0) return null;
      const current = fromRow(currentRows[0]);
      if (current.revokedAt || current.expiresAt.getTime() <= at.getTime()) return null;
      if (expected !== undefined && current.permissionVersion !== expected) return null;

      const nextVersion = requestedVersion ?? current.permissionVersion;
      const nextWorkspace = hasWorkspaceOverride ? requestedWorkspace ?? null : current.workspaceId;
      const nextExpiry = requestedExpiry ?? current.expiresAt;
      if (nextExpiry.getTime() <= at.getTime()) return null;

      const rows = (await tx<HostedSessionRow[]>`
        UPDATE papercusp_auth.hosted_sessions
           SET id = ${nextId},
               workspace_id = ${nextWorkspace},
               permission_version = ${nextVersion},
               expires_at = ${nextExpiry.toISOString()},
               rotated_at = ${at.toISOString()},
               updated_at = ${at.toISOString()}
         WHERE id = ${id}
         RETURNING ${tx.unsafe(SELECT_COLUMNS)}
      `) as HostedSessionRow[];
      return rows.length === 0 ? null : fromRow(rows[0]);
    };
    // Selecting a workspace runs inside the hosted service context, which already holds a
    // transaction and exposes no nested `.begin()`: calling it threw `this.sql.begin is not a
    // function`, so every workspace selection 500'd (measured live 2026-09-23 on the owner's
    // organization). Reuse that transaction; the FOR UPDATE lock holds within it.
    return 'begin' in this.sql ? this.sql.begin(rotateInTransaction) : rotateInTransaction(this.sql);
  }

  async revoke(id: string, reason = 'logout', at = this.clock()): Promise<boolean> {
    if (!HOSTED_SESSION_ID_RE.test(id)) return false;
    validDate(at, 'at');
    const normalizedReason = normalizeReason(reason, 'logout');
    const rows = await this.sql<Array<{ id: string }>>`
      UPDATE papercusp_auth.hosted_sessions
         SET revoked_at = ${at.toISOString()},
             revocation_reason = ${normalizedReason},
             updated_at = ${at.toISOString()}
       WHERE id = ${id}
         AND revoked_at IS NULL
      RETURNING id
    `;
    return rows.length > 0;
  }

  async revokeByUpstreamSession(
    upstreamProvider: string,
    upstreamSessionId: string,
    reason = 'upstream_revoked',
    at = this.clock(),
  ): Promise<number> {
    const provider = nonEmpty(upstreamProvider, 'upstreamProvider');
    const upstreamId = nonEmpty(upstreamSessionId, 'upstreamSessionId');
    validDate(at, 'at');
    const normalizedReason = normalizeReason(reason, 'upstream_revoked');
    const rows = await this.sql<Array<{ id: string }>>`
      UPDATE papercusp_auth.hosted_sessions
         SET revoked_at = ${at.toISOString()},
             revocation_reason = ${normalizedReason},
             updated_at = ${at.toISOString()}
       WHERE upstream_provider = ${provider}
         AND upstream_session_id = ${upstreamId}
         AND revoked_at IS NULL
      RETURNING id
    `;
    return rows.length;
  }
}

function defaultStore(): HostedSessionStore {
  return new HostedSessionStore(getOrgPg().sql);
}

export function createHostedSession(input: CreateHostedSessionInput): Promise<HostedSession> {
  return defaultStore().create(input);
}

export function resolveHostedSession(
  id: string,
  opts?: ResolveHostedSessionOptions,
): Promise<HostedSession | null> {
  return defaultStore().resolve(id, opts);
}

export function rotateHostedSession(
  id: string,
  input?: RotateHostedSessionInput,
): Promise<HostedSession | null> {
  return defaultStore().rotate(id, input);
}

export function revokeHostedSession(id: string, reason?: string): Promise<boolean> {
  return defaultStore().revoke(id, reason);
}

export function revokeHostedSessionsByUpstreamSession(
  upstreamProvider: string,
  upstreamSessionId: string,
  reason?: string,
): Promise<number> {
  return defaultStore().revokeByUpstreamSession(upstreamProvider, upstreamSessionId, reason);
}
