/**
 * One-time shared-host acknowledgement banner.
 *
 * Fires `GET /api/provision/host-check` on first mount; if the response
 * is `{ decision: 'gate' }`, surfaces a sticky banner asking the user to
 * acknowledge before any provision script can run. Once acknowledged
 * (`POST /api/provision/host-check { acknowledge: true }`), the banner
 * vanishes for the lifetime of the host signature.
 *
 * Spec: /docs/snapshots/build-scripts#single-user-host-detection.
 *
 * Auth-bootstrap race (found investigating a spurious 403 on this route
 * while a non-default env, e.g. staging :3170, was freshly selected):
 * `/provision/host-check` requires `trust: ['verified','trusted']` (D3
 * auth-tightening, 621bdb713 — deliberate; CSRF/DNS-rebinding protection).
 * For a passwordless single-user desktop install, that trust is normally
 * satisfied by the auto-established session cookie GET `/api/auth/me`
 * mints on first paint (see auth/me.ts's "auto-establish a real session
 * for passwordless users"). But that mint is fired independently by
 * SIBLING components (UserPicker, AutoLoginWelcomeToast) with no
 * ordering guarantee against this component's own effect — and each
 * physical operator backend (dev/prod/staging) validates a session
 * cookie against ITS OWN session store, so switching the env-switcher's
 * `/api` target to a backend that has never seen this cookie leaves the
 * request with no valid session until *something* re-primes it for that
 * backend. Either way, firing this GET before that priming lands means
 * the request resolves via the loopback fallback (`unverified-loopback`)
 * and 403s — a benign, cosmetic race (this banner just doesn't show),
 * but real console noise. Fix: prime the session for whichever backend
 * is currently active by awaiting `/api/auth/me` first — cheap (each
 * sibling already fires the same call; the browser dedupes nothing here
 * but the endpoint is trivial) and fully order-independent. The probe is
 * also conditional: a password-protected auto-login fallback (or a degraded
 * auth response) proves that no verified user session is available, so it
 * must not call the trust-gated endpoint at all. A passwordless auto-login
 * response is the intentional browser-cookie or desktop-bearer path.
 */
'use client';

import { useEffect, useState } from 'react';

interface HostCheckResult {
  decision: 'allow' | 'allow-acked' | 'gate';
  signals: { activeUsers: string[]; configuredUsers: string[]; isShared: boolean };
}

interface AuthMeResult {
  user?: { has_password?: boolean } | null;
  autoLogin?: boolean;
  degraded?: boolean;
  pgUnavailable?: boolean;
}

/**
 * Host-check is trust-gated. Only a real session (`autoLogin: false`) or the
 * passwordless auto-login path may reach it; the latter covers both a browser
 * cookie mint and the passwordless desktop sys:http bearer. Degraded auth and
 * password-protected fallback users are not evidence of either path.
 */
function canRunHostCheck(auth: AuthMeResult): boolean {
  if (!auth.user || auth.degraded === true || auth.pgUnavailable === true) return false;
  if (auth.autoLogin === false) return true;
  return auth.autoLogin === true && auth.user.has_password === false;
}

export function HostCheckBanner() {
  const [result, setResult] = useState<HostCheckResult | null>(null);
  const [acking, setAcking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Ensure the passwordless auto-session is established (and, crucially,
    // established against whichever backend the env-switcher currently
    // targets) BEFORE the trust-gated host-check fetch — see the race
    // explained in the docstring above. Do not probe when auth cannot prove
    // that a verified or passwordless desktop-bearer path is available.
    void (async () => {
      try {
        const authResponse = await fetch('/api/auth/me', { cache: 'no-store' });
        if (!authResponse.ok) return;
        const auth = (await authResponse.json()) as AuthMeResult;
        if (cancelled || !canRunHostCheck(auth)) return;

        const hostCheck = await fetch('/api/provision/host-check', { cache: 'no-store' });
        if (!hostCheck.ok) return;
        const data = (await hostCheck.json()) as HostCheckResult & { ok?: boolean };
        if (!cancelled && data.ok) setResult(data);
      } catch {
        /* auth or endpoint may not be available — stay silent */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!result || result.decision !== 'gate') return null;

  async function acknowledge() {
    setAcking(true);
    try {
      const r = await fetch('/api/provision/host-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ acknowledge: true }),
      });
      if (r.ok) setResult({ ...result!, decision: 'allow-acked' });
    } finally {
      setAcking(false);
    }
  }

  const userCount = Math.max(result.signals.activeUsers.length, result.signals.configuredUsers.length);

  return (
    <div role="alert" style={banner}>
      <div style={{ flex: 1 }}>
        <strong>Shared host detected.</strong>{' '}
        Papercusp V1 is designed for single-user dev/desktop. This host appears to have{' '}
        <strong>{userCount} users</strong>{' '}
        ({result.signals.activeUsers.length} active, {result.signals.configuredUsers.length} configured).
        Provisioning scripts can still run, but you should be aware of cross-user side effects.
      </div>
      <button onClick={acknowledge} disabled={acking} style={btn}>
        {acking ? 'Saving…' : 'I understand'}
      </button>
    </div>
  );
}

const banner: React.CSSProperties = {
  position: 'fixed', top: 56, left: 0, right: 0, zIndex: 1000,
  display: 'flex', alignItems: 'center', gap: 16,
  padding: '10px 16px', fontSize: 13,
  background: 'var(--warn-bg)', borderBottom: '1px solid var(--warn-border)',
  color: 'var(--warn)',
};
const btn: React.CSSProperties = {
  padding: '6px 14px', background: 'var(--warn)', color: 'var(--accent-ink)',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600,
};
