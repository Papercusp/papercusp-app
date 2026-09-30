/**
 * Cookie-based session helpers for Papercusp.
 *
 * No external email dep — magic links are logged to the dev console.
 * Wire a real provider (Resend / SES / Sendgrid) by replacing
 * `sendMagicLinkEmail` below.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { getLegacyClient } from '@papercusp/db-org';

export const SESSION_COOKIE = 'papercusp_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;       // 30 days
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;              // 15 min

function tokenBytes(n = 24): string {
  return randomBytes(n).toString('base64url');
}

function nowMs(): number {
  return Date.now();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Email provider abstraction.
 *
 * Provider selection via `PAPERCUSP_EMAIL_PROVIDER`:
 *   "console" (default) — log the magic link to stdout. Dev only.
 *   "resend"            — POST to api.resend.com using `RESEND_API_KEY`.
 *
 * Adding a new provider: implement `(email, magicUrl) => Promise<void>` and
 * add a case below. The seam is intentionally narrow so this is easy to
 * swap when papercuspai.com goes live.
 */
type EmailProvider = (email: string, magicUrl: string) => Promise<void>;

const consoleProvider: EmailProvider = async (email, magicUrl) => {
  console.log('━'.repeat(72));
  console.log(`📧 magic link for ${email}`);
  console.log(`   ${magicUrl}`);
  console.log(`   (expires in 15 min)`);
  console.log('━'.repeat(72));
};

const resendProvider: EmailProvider = async (email, magicUrl) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY missing (set it or change PAPERCUSP_EMAIL_PROVIDER)');
  const from = process.env.PAPERCUSP_EMAIL_FROM ?? 'Papercusp <noreply@papercuspai.com>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'Your Papercusp sign-in link',
      text: `Sign in to Papercusp by opening this link (expires in 15 minutes):\n\n${magicUrl}\n\nIf you didn't request this, you can ignore this email.`,
      html: `
        <p>Sign in to Papercusp by clicking the link below (expires in 15 minutes):</p>
        <p><a href="${magicUrl}" style="background:#4f8df0;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-family:system-ui,sans-serif">Sign in</a></p>
        <p style="color:#888;font-size:12px">Or paste this into your browser: <code>${magicUrl}</code></p>
        <p style="color:#888;font-size:12px">If you didn't request this, you can safely ignore it.</p>
      `,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`resend HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
};

export async function sendMagicLinkEmail(email: string, magicUrl: string): Promise<void> {
  const provider = (process.env.PAPERCUSP_EMAIL_PROVIDER ?? 'console').toLowerCase();
  switch (provider) {
    case 'resend': return resendProvider(email, magicUrl);
    case 'console':
    default:       return consoleProvider(email, magicUrl);
  }
}

export async function requestMagicLink(email: string, ip: string | null): Promise<{ token: string }> {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('invalid email');
  }
  const token = tokenBytes(24);
  const now = nowMs();
  const c = getLegacyClient();
  await c.prepare(`
    INSERT INTO papercusp_auth.magic_link_requests (token, email, created_ts, expires_ts, ip)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, normalized, now, now + MAGIC_LINK_TTL_MS, ip);
  return { token };
}

export interface VerifyResult {
  ok: boolean;
  user?: { id: string; email: string; displayName: string | null };
  reason?: 'invalid_token' | 'expired' | 'consumed';
}

export async function verifyMagicLink(token: string, ua: string | null, ip: string | null): Promise<VerifyResult & { sessionId?: string }> {
  const c = getLegacyClient();
  const row = await c.prepare(`
    SELECT token, email, expires_ts, consumed_ts FROM papercusp_auth.magic_link_requests WHERE token = ?
  `).get(token) as { token: string; email: string; expires_ts: number; consumed_ts: number | null } | undefined;
  if (!row) return { ok: false, reason: 'invalid_token' };
  if (row.consumed_ts) return { ok: false, reason: 'consumed' };
  if (Number(row.expires_ts) < nowMs()) return { ok: false, reason: 'expired' };

  // Find or create user.
  let user = await c.prepare(`SELECT id, email, display_name FROM papercusp_auth.users WHERE email = ?`).get(row.email) as
    { id: string; email: string; display_name: string | null } | undefined;
  const now = nowMs();
  if (!user) {
    const id = randomUUID();
    await c.prepare(`
      INSERT INTO papercusp_auth.users (id, email, display_name, created_ts, last_login_ts)
      VALUES (?, ?, NULL, ?, ?)
    `).run(id, row.email, now, now);
    user = { id, email: row.email, display_name: null };
  } else {
    await c.prepare(`UPDATE papercusp_auth.users SET last_login_ts = ? WHERE id = ?`).run(now, user.id);
  }

  // Mint session.
  const sessionId = tokenBytes(32);
  await c.prepare(`
    INSERT INTO papercusp_auth.sessions (id, user_id, created_ts, expires_ts, user_agent, ip)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, user.id, now, now + SESSION_TTL_MS, ua, ip);

  // Mark magic link consumed.
  await c.prepare(`UPDATE papercusp_auth.magic_link_requests SET consumed_ts = ? WHERE token = ?`).run(now, token);

  return {
    ok: true,
    sessionId,
    user: { id: user.id, email: user.email, displayName: user.display_name },
  };
}

export async function getSessionUser(): Promise<{ id: string; email: string; displayName: string | null } | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const c = getLegacyClient();
  const row = await c.prepare(`
    SELECT u.id, u.email, u.display_name, s.expires_ts
    FROM papercusp_auth.sessions s
    JOIN papercusp_auth.users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(token) as { id: string; email: string; display_name: string | null; expires_ts: number } | undefined;
  if (!row) return null;
  if (Number(row.expires_ts) < nowMs()) return null;
  return { id: row.id, email: row.email, displayName: row.display_name };
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    const c = getLegacyClient();
    await c.prepare(`DELETE FROM papercusp_auth.sessions WHERE id = ?`).run(token);
  }
  cookieStore.delete(SESSION_COOKIE);
}

export async function setSessionCookie(sessionId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set({
    name: SESSION_COOKIE,
    value: sessionId,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function ipFromHeaders(): Promise<string | null> {
  const h = await headers();
  const xff = h.get('x-forwarded-for') ?? h.get('cf-connecting-ip') ?? null;
  return xff?.split(',')[0]?.trim() ?? null;
}

export async function uaFromHeaders(): Promise<string | null> {
  const h = await headers();
  return h.get('user-agent') ?? null;
}
