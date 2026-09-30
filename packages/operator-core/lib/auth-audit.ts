/**
 * Auth audit log (Step E, Tier-2 follow-up arc).
 *
 * Append-only writes to `harness_shared.auth_audit_log`. Fire-and-forget
 * by convention (callers should `void recordAuthEvent(...)`) so PG
 * latency never blocks the auth response.
 *
 * Session-token HMAC: when a token is logged, we store HMAC-SHA256
 * truncated to 16 hex chars rather than the token itself or a prefix.
 * The HMAC key derives from the superuser-token file (stable across
 * restarts, never persisted). Sufficient for cross-row correlation in
 * a security review; not sufficient to hijack a session.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';

export type AuthAuditKind =
  | 'login_ok'
  | 'login_bad_password'
  | 'login_unknown_user'
  | 'login_rate_limited'
  | 'login_failed'
  | 'change_password_ok'
  | 'change_password_bad_old'
  | 'change_password_no_session'
  | 'change_password_failed'
  | 'logout';

export interface AuthAuditEvent {
  kind: AuthAuditKind;
  username?: string;
  ip?: string;
  userAgent?: string;
  ok: boolean;
  errorCode?: string;
  sessionToken?: string;  // hashed via HMAC before insert
  metadata?: Record<string, unknown>;
}

let _hmacKey: Buffer | null = null;

function loadHmacKey(): Buffer {
  if (_hmacKey) return _hmacKey;
  try {
    const tokenPath = join(homedir(), '.papercusp', 'superuser-token');
    const tok = readFileSync(tokenPath, 'utf8').trim();
    if (tok.length >= 16) {
      _hmacKey = Buffer.from(tok, 'utf8');
      return _hmacKey;
    }
  } catch {
    /* fall through to ephemeral key */
  }
  // Fall back to an ephemeral key generated this process. Audit rows
  // won't be cross-correlatable across operator restarts, but at least
  // they won't expose token material.
  _hmacKey = randomBytes(32);
  return _hmacKey;
}

export function hmacSessionToken(token: string): string {
  const key = loadHmacKey();
  return createHmac('sha256', key).update(token).digest('hex').slice(0, 16);
}

/**
 * Insert a single audit event. Best-effort: any failure is swallowed
 * with a single console.warn so the auth response is never delayed.
 */
export async function recordAuthEvent(event: AuthAuditEvent): Promise<void> {
  try {
    const { sql } = getOrgPg();
    const sessionHmac = event.sessionToken ? hmacSessionToken(event.sessionToken) : null;
    await sql`
      INSERT INTO harness_shared.auth_audit_log
        (kind, username, ip, user_agent, ok, error_code, session_hmac, metadata)
      VALUES (
        ${event.kind},
        ${event.username ?? null},
        ${event.ip ?? null},
        ${event.userAgent ?? null},
        ${event.ok},
        ${event.errorCode ?? null},
        ${sessionHmac},
        ${event.metadata ? JSON.stringify(event.metadata) : null}::text::jsonb
      )
    `;
  } catch (err) {
     
    console.warn('[auth-audit] write failed:', (err as Error).message);
  }
}

/* Test seam. */
export function _resetHmacKey(): void {
  _hmacKey = null;
}
