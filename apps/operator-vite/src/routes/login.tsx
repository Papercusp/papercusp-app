import { Suspense, useEffect, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryState, parseAsStringLiteral } from 'nuqs';
import { toast } from 'sonner';
import { Select } from '@/app/harness/Select';
import { Checkbox } from '@/app/harness/Checkbox';

/**
 * /login — sign-in surface. Translated from `apps/operator/app/login/page.tsx`.
 *
 * next → TSR translation:
 *   - `useRouter().replace(x)` → `useNavigate()({ to: x, replace: true })`
 *   - `useSearchParams().get('redirect_to')` → `Route.useSearch().redirect_to`
 *   - The previous file's `<Suspense>` boundary existed to satisfy Next's
 *     useSearchParams rule. TSR doesn't require it, but we keep the
 *     boundary so the login form mounts behind a fallback while the route's
 *     children settle on first paint.
 */

interface LoginSearch {
  redirect_to?: string;
  switch?: 1;
  mode?: 'login' | 'signup';
}

export const Route = createFileRoute('/login')({
  validateSearch: (search): LoginSearch => ({
    redirect_to: typeof search.redirect_to === 'string' ? search.redirect_to : undefined,
    // `?switch=1` opts into switch-account mode. Normalize to the NUMBER 1
    // (TSR coerces `?switch=1` to 1 and round-trips numbers verbatim); a
    // normalized STRING '1' would be JSON-quoted to `?switch="1"` and drift
    // across re-serialisations, breaking the `=== '1'` check. Mirrors the
    // dock fix in harness/$slug. Accept '1' too for self-heal.
    switch: search.switch === 1 || search.switch === '1' ? 1 : undefined,
    mode: search.mode === 'signup' ? 'signup' : search.mode === 'login' ? 'login' : undefined,
  }),
  component: LoginPage,
});

interface AvailableUser {
  id: string;
  username: string;
  display_name: string;
  has_password: boolean;
}

const LOGIN_MODES = ['login', 'signup'] as const;
type LoginMode = (typeof LOGIN_MODES)[number];

function LoginForm() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const redirectTo = search.redirect_to || '/';
  // When the user navigates here from UserPicker → "Switch user" we set
  // `?switch=1`. In that mode we (a) never auto-redirect even if a session
  // exists, (b) skip the one-user autofill, and (c) show a banner so the
  // user understands the in-flight session will be replaced.
  const isSwitching = search.switch === 1;

  const [available, setAvailable] = useState<AvailableUser[]>([]);
  const [mode, setMode] = useQueryState<LoginMode>(
    'mode',
    parseAsStringLiteral(LOGIN_MODES).withDefault('login'),
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [usePassword, setUsePassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/auth/me');
        if (!r.ok) return;
        const j = await r.json();
        // Switching: never auto-redirect even if a session exists. The
        // user is deliberately on /login to swap accounts.
        //
        // pgUnavailable: skip the redirect — /api/auth/me returns a
        // synthetic default user when embedded-pg is unreachable. If
        // we treated that as an active session, the login page would
        // bounce users away every time PG hiccupped, leaving no path
        // to actually sign in. Defer to a real /me response (Bug 28
        // from the post-Tier-3 audit; sibling to AutoLoginWelcomeToast
        // suppression in commit bde1e061).
        if (j.user && !isSwitching && !j.pgUnavailable) {
          navigate({ to: redirectTo, replace: true });
          return;
        }
        const users = (j.available ?? []) as AvailableUser[];
        setAvailable(users);
        // Switching: skip the single-user autofill so the form is empty
        // and the user can pick a different account from scratch.
        if (!isSwitching && users.length === 1) {
          setUsername(users[0].username);
          setUsePassword(users[0].has_password);
        }
      } catch {
        /* network failure — show empty form */
      }
    })();
  }, [navigate, redirectTo, isSwitching]);

  // When username changes via dropdown, infer whether password is needed
  useEffect(() => {
    if (!username) return;
    const u = available.find((a) => a.username === username);
    if (u) setUsePassword(u.has_password);
  }, [username, available]);

  const onLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: usePassword ? password : null }),
      });
      const j = await r.json();
      if (!r.ok) {
        toast.error(
          j.error === 'bad_password' ? 'Wrong password.' : j.error === 'unknown_user' ? 'No such user.' : `Login failed: ${j.error}`,
          { description: `Login attempt for username "${username}" (${j.error})` },
        );
        return;
      }
      // Stash a one-shot welcome flag for OperatorConversationProvider
      // to consume on mount → fires user_welcomed trigger with the
      // display name in the prompt context (Plan 4.8).
      try {
        sessionStorage.setItem('papercusp_just_logged_in', j.user.display_name);
      } catch { /* sessionStorage may be unavailable */ }
      // When switching, clear AutoLoginWelcomeToast stamps for OTHER users
      // so the next session for those accounts gets a fresh welcome on
      // its 4am cycle. Cheap — runs in localStorage only. Uses the
      // official Storage API (length + key(i)) rather than Object.keys
      // for correctness against shimmed environments (test fixtures, etc).
      if (isSwitching && j.user?.id) {
        try {
          const toRemove: string[] = [];
          for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (
              key &&
              key.startsWith('papercusp_user_welcomed_') &&
              key !== `papercusp_user_welcomed_${j.user.id}`
            ) {
              toRemove.push(key);
            }
          }
          for (const key of toRemove) localStorage.removeItem(key);
        } catch { /* localStorage unavailable */ }
      }
      toast.success(`Welcome, ${j.user.display_name}`);
      navigate({ to: redirectTo, replace: true });
    } finally {
      setSubmitting(false);
    }
  };

  const onSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const r = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username,
          display_name: displayName,
          password: usePassword ? password : null,
          auto_login: true,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        toast.error(
          j.error === 'username_taken' ? 'That username is taken.' : `Signup failed: ${j.error}`,
          { description: `Signup attempt for username "${username}" (${j.error})` },
        );
        return;
      }
      try {
        sessionStorage.setItem('papercusp_just_logged_in', j.user.display_name);
      } catch { /* sessionStorage may be unavailable */ }
      toast.success(`Welcome, ${j.user.display_name}`);
      navigate({ to: redirectTo, replace: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh', padding: 32,
    }}>
      <form
        onSubmit={mode === 'login' ? onLogin : onSignup}
        style={{
          display: 'flex', flexDirection: 'column', gap: 16,
          minWidth: 320, padding: 32,
          borderRadius: 12, border: '1px solid var(--border)',
          background: 'var(--bg-2)',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 20 }}>
          {mode === 'login' ? 'Sign in' : 'Create a user'}
        </h1>
        {isSwitching && (
          <div
            role="status"
            style={{
              fontSize: 12,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'var(--bg-3, transparent)',
              opacity: 0.85,
            }}
          >
            Signing in as a different user. Your current session will be replaced.
          </div>
        )}

        {mode === 'login' && available.length > 1 ? (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>User</span>
            <Select
              value={username}
              onChange={setUsername}
              placeholder="Pick a user…"
              ariaLabel="User"
              options={available.map((u) => ({
                value: u.username,
                label: `${u.display_name} (${u.username})`,
              }))}
            />
          </label>
        ) : (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Username</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
              autoComplete="username"
              required
              minLength={2}
              maxLength={32}
              pattern="[a-z0-9_-]{2,32}"
            />
          </label>
        )}

        {mode === 'signup' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Display name</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </label>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Checkbox
            checked={usePassword}
            onChange={setUsePassword}
            disabled={mode === 'login' && !!available.find((a) => a.username === username && a.has_password)}
            ariaLabel={mode === 'signup' ? 'Set a password (optional)' : 'Use password'}
          />
          <span>{mode === 'signup' ? 'Set a password (optional)' : 'Use password'}</span>
        </label>

        {usePassword && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={1}
              required
            />
          </label>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? '…' : mode === 'login' ? 'Sign in' : 'Create user'}
        </button>

        <button
          type="button"
          onClick={() => void setMode(mode === 'login' ? 'signup' : 'login')}
          style={{
            background: 'none', border: 'none',
            color: 'var(--fg-mute)', cursor: 'pointer',
            fontSize: 13, padding: 0, textAlign: 'left',
          }}
        >
          {mode === 'login' ? "Create a new user instead" : "Sign in to an existing user"}
        </button>
      </form>
    </div>
  );
}

function LoginPage() {
  return (
    <Suspense fallback={<div style={{ padding: 32 }}>Loading…</div>}>
      <LoginForm />
    </Suspense>
  );
}
