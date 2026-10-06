/**
 * Local-account auth + per-user session lookup.
 *
 * Replaces the legacy magic-link system (per project_operator_auth_loopback —
 * magic links were removed; loopback bind + Host check is the perimeter).
 * This module is the multi-user layer on top of loopback security: which
 * user is the current session for? Memory and per-user preferences key
 * off `getSessionUser().id`.
 *
 * Design:
 *   - Server-side opaque session tokens (32-byte hex). No JWT — we're
 *     loopback only; no distributed verification need.
 *   - Optional password (NULL = passwordless login). bcrypt via pgcrypto.
 *   - On fresh install, `ensureDefaultUser` seeds username='default'.
 *
 * See PLAN-operator-arc-2026-05-12.md and migration 058.
 */

import { randomBytes } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { TtlMap } from './ttl-map';
import { activeWorkspaceId } from './workspace-registry';
import { REMOTE_OPERATOR_CAPABILITY } from './remote-auth-policy';
import { currentLoopbackPeerIsForeign } from './auth/loopback-peer-trust';

export const SESSION_COOKIE = 'papercusp_session';
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Server-owned upper bound; remember-device callers may request any shorter TTL. */
export const MAX_SESSION_TTL_MS = DEFAULT_SESSION_TTL_MS;

/**
 * Per-token debounce for the best-effort `last_seen_at` write. last_seen_at only
 * feeds the coarse login-time session sweep ("actively used" = last_seen_at past
 * created_at + 1 min) — nothing latency-sensitive — yet it was written on EVERY
 * cookie-authed request, adding a second PG round-trip to the hot read path
 * (operator-scalability-event-loop-2026-06-16 P1-3). A bounded TtlMap whose
 * entry-presence means "written within the window" collapses that to at most one
 * write per token per window; the first hit (no entry) always writes, so a fresh
 * session is still marked active immediately. Bounded so the thousands of
 * single-use desktop tokens can't grow it without limit.
 */
export const LAST_SEEN_DEBOUNCE_MS = 60_000;
const lastSeenWritten = new TtlMap<true>({ ttlMs: LAST_SEEN_DEBOUNCE_MS, maxEntries: 4096 });

/** Test-only — clear the last_seen_at debounce so cases don't bleed into each other. */
export function _resetLastSeenDebounceForTests(): void {
  lastSeenWritten.clear();
}

export interface User {
  id: string;
  username: string;
  display_name: string;
  has_password: boolean;
}

/** Authorization claims fixed when an opaque browser session is minted. */
export interface SessionUser extends User {
  workspace_id: string;
  capabilities: string[];
}

export interface Session {
  token: string;
  user_id: string;
  expires_at: number; // ms
}

function newToken(): string {
  return randomBytes(32).toString('hex');
}

function resolveSessionTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined) return DEFAULT_SESSION_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_SESSION_TTL_MS) {
    throw Object.assign(new Error('invalid session ttl'), { code: 'invalid_session_ttl' });
  }
  return ttlMs;
}

/** Parse a `Cookie` request header into a name→value map. */
function parseCookieHeader(header: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    out.set(k, decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return out;
}

/**
 * Resolve the session token. The Next-free path: pass the request's
 * `Headers` (every `defineTool` handler does — `req.headers`) and the
 * token is read from the `Cookie` header. The legacy path: omit `headers`
 * and the token comes from Next's ambient `cookies()` — used only by
 * `route.ts` handlers still served by Next during the endpoint migration.
 *
 * The Next fallback is a *dynamic* import so a fully-ported, Next-removed
 * build carries no static `next/headers` dependency, and is wrapped in
 * try/catch because `cookies()` throws outside a Next request scope.
 */
async function resolveSessionToken(headers?: Headers): Promise<string | undefined> {
  if (headers) {
    return parseCookieHeader(headers.get('cookie')).get(SESSION_COOKIE);
  }
  try {
    // @vite-ignore: `next` is a PHANTOM package (no package.json declares it;
    // absent from the lock) — present on long-lived dev boxes, absent on any
    // clean install (cloud frames — found live 2026-06-06). Without the ignore,
    // Rolldown fails the whole SPA build trying to resolve this fallback.
    const { cookies } = await import(/* @vite-ignore */ 'next/headers');
    const jar = await cookies();
    return jar.get(SESSION_COOKIE)?.value;
  } catch {
    return undefined;
  }
}

/**
 * Look up the current session user from the request cookie. Returns null
 * if no session, expired, or user inactive. Updates last_seen_at on hit.
 *
 * Pass `headers` from a `defineTool` handler (`req.headers`); omit it
 * only from legacy Next `route.ts` handlers (ambient-cookie fallback).
 */
export async function getSessionUser(headers?: Headers): Promise<SessionUser | null> {
  const token = await resolveSessionToken(headers);
  if (!token) return null;
  // Do not acquire the database pool until the request actually presents a
  // session cookie. Unauthenticated requests are expected to resolve to null
  // without touching Postgres; besides preserving the cheap no-session path,
  // this keeps auth denials safe during partial/early host initialization.
  const { sql } = getOrgPg();

  const rows = await sql<{
    user_id: string;
    expires_at: Date;
    id: string;
    username: string;
    display_name: string;
    password_hash: string | null;
    workspace_id: string;
    capabilities: string[];
  }[]>`
    SELECT s.user_id, s.expires_at,
           s.workspace_id, s.capabilities,
           u.id, u.username, u.display_name, u.password_hash
      FROM harness_shared.user_sessions s
      JOIN harness_shared.users u ON u.id = s.user_id
     WHERE s.token = ${token}
       AND s.expires_at > now()
       AND s.workspace_id IS NOT NULL
       AND u.is_active = true
     LIMIT 1
  `;
  if (rows.length === 0) return null;

  const row = rows[0];
  // Best-effort last_seen_at update; failure is non-fatal. Debounced per token
  // (see lastSeenWritten) so an active session refreshes at most once per window
  // instead of issuing a PG round-trip on every authed request.
  if (lastSeenWritten.get(token) === undefined) {
    lastSeenWritten.set(token, true);
    await sql`
      UPDATE harness_shared.user_sessions
         SET last_seen_at = now()
       WHERE token = ${token}
    `.catch(() => { /* non-fatal */ });
  }

  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    has_password: row.password_hash !== null,
    workspace_id: row.workspace_id,
    capabilities: [...row.capabilities],
  };
}

/**
 * Resolve current user OR fall back to 'default' when no session present.
 * Used by routes that always need a user_id for per-user data (memory,
 * preferences) but want to silently use the default user when unauthenticated
 * (single-user installs).
 */
export async function getSessionUserOrDefault(headers?: Headers): Promise<User> {
  const { sql } = getOrgPg();
  const user = await getSessionUser(headers);
  if (user) return user;
  await ensureDefaultUser();
  const rows = await sql<{ id: string; username: string; display_name: string; password_hash: string | null }[]>`
    SELECT id, username, display_name, password_hash
      FROM harness_shared.users
     WHERE username = 'default'
       AND is_active = true
     LIMIT 1
  `;
  if (rows.length === 0) {
    throw new Error('default user not present after ensureDefaultUser');
  }
  const r = rows[0];
  return { id: r.id, username: r.username, display_name: r.display_name, has_password: r.password_hash !== null };
}

/**
 * Authenticate a username + optional password, return new session token on
 * success. Throws { code: 'unknown_user' | 'bad_password' | 'inactive' }
 * on failure.
 */
export async function login(
  username: string,
  password: string | null,
  meta?: {
    user_agent?: string;
    remote_addr?: string;
    ttl_ms?: number;
    workspace_id?: string;
    capabilities?: readonly string[];
    remote?: boolean;
  },
): Promise<{ token: string; user: SessionUser; expires_at: Date }> {
  // WI-10003621: on a hosted workspace host the loopback interface is shared with the
  // customer account, whose uid runs arbitrary code (PTY, customer-driven agents). A
  // loopback peer whose socket is not owned by the service uid proves nothing about who
  // is calling, so it may not mint an operator session at all: a passwordless login here
  // handed uid 1001 a '*' session (measured on avi-test r57 through GET /api/auth/me) and
  // with it every principal-tier route, which is the D-417 exposure through a cookie.
  // Refused BEFORE the user lookup so a foreign peer cannot enumerate accounts either.
  // The customer's legitimate entry points (the portal via the controller, the direct
  // remote surface) never arrive as a foreign loopback socket, so nothing else changes.
  if (currentLoopbackPeerIsForeign()) {
    throw Object.assign(new Error('foreign loopback peer'), { code: 'foreign_loopback_peer' });
  }
  const { sql } = getOrgPg();
  const rows = await sql<{ id: string; display_name: string; password_hash: string | null; is_active: boolean }[]>`
    SELECT id, display_name, password_hash, is_active
      FROM harness_shared.users
     WHERE username = ${username}
     LIMIT 1
  `;
  if (rows.length === 0) throw Object.assign(new Error('unknown user'), { code: 'unknown_user' });
  const u = rows[0];
  if (!u.is_active) throw Object.assign(new Error('inactive'), { code: 'inactive' });

  // Passwordless accounts are intentionally auto-loginable only through the
  // local desktop path. A direct remote request must not be able to turn an
  // arbitrary nonempty password into proof of identity just because the
  // password hash is NULL. Keep the capability check as defense-in-depth for
  // callers that identify the remote surface through session claims alone.
  const remoteLogin =
    meta?.remote === true ||
    meta?.capabilities?.some((capability) => capability.trim() === REMOTE_OPERATOR_CAPABILITY) === true;
  if (remoteLogin && u.password_hash === null) {
    throw Object.assign(new Error('bad password'), { code: 'bad_password' });
  }

  if (u.password_hash !== null) {
    if (!password) throw Object.assign(new Error('password required'), { code: 'bad_password' });
    const check = await sql<{ ok: boolean }[]>`
      SELECT crypt(${password}, ${u.password_hash}) = ${u.password_hash} AS ok
    `;
    if (!check[0]?.ok) throw Object.assign(new Error('bad password'), { code: 'bad_password' });
  }

  // Session lifetime is a server-owned policy. Keep explicit shorter values
  // for remember-device choices, but never accept malformed or overlong TTLs.
  const ttl = resolveSessionTtl(meta?.ttl_ms);

  // Opportunistic sweep (EI-338): drop sessions that will never be presented
  // again — expired rows, plus never-reused rows past a generous grace (the
  // cookie-less desktop webview minted thousands of single-use rows before
  // the /auth/me mint guard; stragglers still arrive via the HTTP-fallback
  // path). last_seen_at refreshes on every cookie hit, so an actively-used
  // session is never swept. Logged-not-swallowed so a real PG error surfaces.
  await sql`
    DELETE FROM harness_shared.user_sessions
     WHERE expires_at < now()
        OR (created_at < now() - interval '48 hours'
            AND (last_seen_at IS NULL OR last_seen_at < created_at + interval '1 minute'))
  `.catch((err) => console.error('[auth] session sweep failed (non-fatal):', err));

  const token = newToken();
  const expires = new Date(Date.now() + ttl);
  // Local callers may bind at mint time from their request-scoped active
  // workspace. Remote callers pass an explicit request claim from login.ts.
  // Resolution never falls back to mutable process state (getSessionUser
  // rejects legacy rows whose claim is NULL).
  const workspaceId = (meta?.workspace_id ?? activeWorkspaceId()).trim();
  if (!workspaceId) {
    throw Object.assign(new Error('workspace required'), { code: 'workspace_required' });
  }
  const capabilities = [...new Set(meta?.capabilities ?? ['*'])]
    .map((capability) => capability.trim())
    .filter(Boolean);
  if (capabilities.length === 0) {
    throw Object.assign(new Error('capabilities required'), { code: 'capabilities_required' });
  }
  // postgres.js in this version doesn't accept Date instances directly
  // for timestamptz params — pass ISO string.
  await sql`
    INSERT INTO harness_shared.user_sessions
      (token, user_id, expires_at, user_agent, remote_addr, workspace_id, capabilities)
    VALUES
      (${token}, ${u.id}, ${expires.toISOString()}, ${meta?.user_agent ?? null}, ${meta?.remote_addr ?? null}, ${workspaceId}, ${capabilities})
  `;
  await sql`
    UPDATE harness_shared.users SET last_login_at = now() WHERE id = ${u.id}
  `;

  return {
    token,
    user: {
      id: u.id,
      username,
      display_name: u.display_name,
      has_password: u.password_hash !== null,
      workspace_id: workspaceId,
      capabilities,
    },
    expires_at: expires,
  };
}

export async function logout(token: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.user_sessions WHERE token = ${token}`;
}

export async function signup(
  username: string,
  display_name: string,
  password: string | null,
): Promise<User> {
  const { sql } = getOrgPg();
  username = username.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,32}$/.test(username)) {
    throw Object.assign(new Error('invalid username'), { code: 'bad_username' });
  }
  if (!display_name.trim()) {
    throw Object.assign(new Error('display name required'), { code: 'bad_display_name' });
  }
  const passwordHash = password
    ? (await sql<{ hash: string }[]>`SELECT crypt(${password}, gen_salt('bf')) AS hash`)[0].hash
    : null;

  const rows = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name, password_hash)
    VALUES (${username}, ${display_name.trim()}, ${passwordHash})
    RETURNING id
  `;
  return {
    id: rows[0].id,
    username,
    display_name: display_name.trim(),
    has_password: passwordHash !== null,
  };
}

export async function changePassword(
  user_id: string,
  current: string | null,
  next: string | null,
): Promise<void> {
  const { sql } = getOrgPg();
  const rows = await sql<{ password_hash: string | null }[]>`
    SELECT password_hash FROM harness_shared.users WHERE id = ${user_id} LIMIT 1
  `;
  if (rows.length === 0) throw Object.assign(new Error('not found'), { code: 'unknown_user' });
  const current_hash = rows[0].password_hash;

  if (current_hash !== null) {
    if (!current) throw Object.assign(new Error('current password required'), { code: 'bad_password' });
    const check = await sql<{ ok: boolean }[]>`
      SELECT crypt(${current}, ${current_hash}) = ${current_hash} AS ok
    `;
    if (!check[0]?.ok) throw Object.assign(new Error('bad password'), { code: 'bad_password' });
  }

  const next_hash = next
    ? (await sql<{ hash: string }[]>`SELECT crypt(${next}, gen_salt('bf')) AS hash`)[0].hash
    : null;
  await sql`UPDATE harness_shared.users SET password_hash = ${next_hash} WHERE id = ${user_id}`;
  await sql`DELETE FROM harness_shared.user_sessions WHERE user_id = ${user_id}`;
}

/**
 * Seed the `default` user on first boot. Idempotent.
 * Called from instrumentation-node.ts.
 */
let _ensureDefaultDone = false;
export async function ensureDefaultUser(): Promise<void> {
  const { sql } = getOrgPg();
  if (_ensureDefaultDone) return;
  await sql`
    INSERT INTO harness_shared.users (username, display_name, password_hash)
    VALUES ('default', 'User', NULL)
    ON CONFLICT (username) DO NOTHING
  `;
  _ensureDefaultDone = true;
}

export async function updateDisplayName(user_id: string, display_name: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.users
       SET display_name = ${display_name}
     WHERE id = ${user_id}
  `;
}

export async function listUsers(): Promise<User[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{ id: string; username: string; display_name: string; password_hash: string | null }[]>`
    SELECT id, username, display_name, password_hash
      FROM harness_shared.users
     WHERE is_active = true
     ORDER BY username
  `;
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    display_name: r.display_name,
    has_password: r.password_hash !== null,
  }));
}
