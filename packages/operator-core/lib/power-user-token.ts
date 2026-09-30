/**
 * power-user-token.ts — HMAC-signed scoped tokens for the
 * `workspace-power-user` auth tier.
 *
 * Two token types, OAuth-style (see
 * docs/plans/omp-power-user-bundle-2026-05-20.md §4.1):
 *
 *   - access  — short TTL (1h). Carries
 *               { t:'access', workspaceId, userId, authSessionId, exp }.
 *               The OMP plugin sends this in `Authorization: Bearer` on
 *               every `?power_user=1` MCP call.
 *   - refresh — long TTL (24h). Carries { t:'refresh', authSessionId, exp }.
 *               The plugin exchanges it for a fresh access token at
 *               `/api/agent-tokens/power-user/refresh`.
 *
 * Wire format: `<base64url(JSON payload)>.<base64url(HMAC-SHA256)>` — a
 * compact JWT-ish envelope. We don't use a JWT lib: the payload schema
 * is fixed and tiny, and the HMAC key already has a home in
 * `harness_shared.operator_secrets` (same store spawn-signing.ts uses).
 *
 * Threat model is identical to spawn-signing.ts: this is friction
 * against a prompt-injected agent rewriting its own scope, NOT
 * enforcement against same-UID code that can read the PG key. The
 * power-user path additionally clamps `workspaceId` server-side (the
 * dispatcher reads it from the verified token, never from the URL) so a
 * tampered URL can't widen scope.
 *
 * Server-only.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { generated } from '@papercusp/db-org';
import { eq } from 'drizzle-orm';
import { decodeOperatorSecretKey } from './operator-secret-key';

const os = generated.operatorSecretsInHarnessShared;
const KEY_NAME = 'power-user-token-key';

/** Default TTLs. Override via the mint* opts. */
export const ACCESS_TTL_SEC = 60 * 60; // 1h
export const REFRESH_TTL_SEC = 24 * 60 * 60; // 24h

export interface AccessClaims {
  t: 'access';
  workspaceId: string;
  userId: string;
  authSessionId: string;
  /** Unix seconds. */
  exp: number;
}

export interface RefreshClaims {
  t: 'refresh';
  authSessionId: string;
  /** Unix seconds. */
  exp: number;
}

type AnyClaims = AccessClaims | RefreshClaims;

/* ─── Signing key ────────────────────────────────────────────────────── */

interface KeyCache {
  buf: Buffer;
  rotatedAt: number;
  loadedAt: number;
}
const __g = globalThis as unknown as { __papercuspPowerUserTokenKey?: KeyCache | null };

/** Force a key reload on next mint/verify. Test helper. */
export function _resetPowerUserTokenKeyCache(): void {
  __g.__papercuspPowerUserTokenKey = null;
}

/**
 * Load (or first-run create) the 32-byte HMAC key from
 * `harness_shared.operator_secrets`. Honors PG's `rotated_at` so a
 * rotate from a sibling process invalidates this cache — same coherence
 * discipline as spawn-signing.ts:loadOrCreateKey.
 */
async function loadOrCreateKey(): Promise<Buffer> {
  const { db } = getOrgPg();
  const rows = await db
    .select({ valueB64: os.valueB64, rotatedAt: os.rotatedAt })
    .from(os)
    .where(eq(os.name, KEY_NAME))
    .limit(1);
  if (rows.length > 0) {
    const rotatedAt = new Date(rows[0].rotatedAt as never).getTime();
    const cached = __g.__papercuspPowerUserTokenKey;
    if (
      cached &&
      cached.rotatedAt === rotatedAt &&
      Date.now() - cached.loadedAt < 5 * 60 * 1000
    ) {
      return cached.buf;
    }
    const buf = decodeOperatorSecretKey(rows[0].valueB64, KEY_NAME);
    __g.__papercuspPowerUserTokenKey = { buf, rotatedAt, loadedAt: Date.now() };
    return buf;
  }
  // First run: mint + persist. ON CONFLICT DO NOTHING handles the race
  // between two operator processes starting simultaneously.
  const fresh = randomBytes(32);
  await db
    .insert(os)
    .values({ name: KEY_NAME, valueB64: fresh.toString('base64') })
    .onConflictDoNothing();
  const after = await db
    .select({ valueB64: os.valueB64, rotatedAt: os.rotatedAt })
    .from(os)
    .where(eq(os.name, KEY_NAME))
    .limit(1);
  const rotatedAt = new Date(after[0]!.rotatedAt as never).getTime();
  const buf = decodeOperatorSecretKey(after[0]!.valueB64, KEY_NAME);
  __g.__papercuspPowerUserTokenKey = { buf, rotatedAt, loadedAt: Date.now() };
  return buf;
}

/* ─── Encode / decode ────────────────────────────────────────────────── */

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(key: Buffer, payloadB64: string): string {
  return b64url(createHmac('sha256', key).update(payloadB64).digest());
}

async function encode(claims: AnyClaims): Promise<string> {
  const key = await loadOrCreateKey();
  const payloadB64 = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  return `${payloadB64}.${sign(key, payloadB64)}`;
}

/**
 * Verify a token's HMAC + expiry and return its claims, or null on any
 * failure (malformed, bad signature, expired, wrong type). Never throws.
 */
async function decode<T extends AnyClaims>(
  token: string | null | undefined,
  wantType: T['t'],
): Promise<T | null> {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const key = await loadOrCreateKey();
  const expectedSig = sign(key, payloadB64);
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: AnyClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || claims.t !== wantType) return null;
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return claims as T;
}

/* ─── Public API ─────────────────────────────────────────────────────── */

/** Allocate a fresh `auth_session_id` for a new power-user session. */
export function newAuthSessionId(): string {
  return `pus-${randomUUID()}`;
}

export async function mintAccessToken(opts: {
  workspaceId: string;
  userId: string;
  authSessionId: string;
  ttlSec?: number;
}): Promise<{ token: string; exp: number }> {
  const exp = Math.floor(Date.now() / 1000) + (opts.ttlSec ?? ACCESS_TTL_SEC);
  const token = await encode({
    t: 'access',
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    authSessionId: opts.authSessionId,
    exp,
  });
  return { token, exp };
}

export async function mintRefreshToken(opts: {
  authSessionId: string;
  ttlSec?: number;
}): Promise<{ token: string; exp: number }> {
  const exp = Math.floor(Date.now() / 1000) + (opts.ttlSec ?? REFRESH_TTL_SEC);
  const token = await encode({ t: 'refresh', authSessionId: opts.authSessionId, exp });
  return { token, exp };
}

/** Verify an access token. Returns claims or null. Never throws. */
export function verifyAccessToken(token: string | null | undefined): Promise<AccessClaims | null> {
  return decode<AccessClaims>(token, 'access');
}

/** Verify a refresh token. Returns claims or null. Never throws. */
export function verifyRefreshToken(token: string | null | undefined): Promise<RefreshClaims | null> {
  return decode<RefreshClaims>(token, 'refresh');
}
