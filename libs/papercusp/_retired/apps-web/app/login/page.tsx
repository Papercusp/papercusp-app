'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

function LoginForm() {
  const sp = useSearchParams();
  const error = sp.get('error');

  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [devUrl, setDevUrl] = useState<string | null>(null);

  useEffect(() => {
    if (error === 'expired') toast.error('That magic link expired. Request a new one.');
    else if (error === 'consumed') toast.error('That magic link was already used.');
    else if (error === 'invalid_token') toast.error('That magic link is invalid.');
    else if (error) toast.error(`login error: ${error}`);
  }, [error]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes('@')) {
      toast.error('Please enter a valid email');
      return;
    }
    setSubmitting(true);
    setDevUrl(null);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? 'request failed');
      toast.success('Magic link sent. Check your email (or the dev console).');
      if (d?.devMagicUrl) setDevUrl(d.devMagicUrl);
    } catch (err: any) {
      toast.error(`failed: ${err?.message ?? err}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="pc-shell">
      <h1>Sign in</h1>
      <p>
        Enter your email and we&rsquo;ll send a one-time link. No passwords.
      </p>

      <div className="pc-card" style={{ maxWidth: 460 }}>
        <form onSubmit={onSubmit}>
          <div className="pc-form-row">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              className="pc-input"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </div>
          <button type="submit" className="pc-button primary" disabled={submitting}>
            {submitting ? 'Sending…' : 'Send magic link'}
          </button>
        </form>

        {devUrl && (
          <div className="pc-warn" style={{ marginTop: 16 }}>
            🔧 <strong>Dev mode.</strong> Email isn&rsquo;t wired yet — open this link to sign in:
            <br />
            <a href={devUrl} style={{ wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
              {devUrl}
            </a>
          </div>
        )}
      </div>

      <div style={{ marginTop: 32, color: 'var(--fg-mute)', fontSize: 12 }}>
        <p>
          You don&rsquo;t need an account to use Papercusp locally. Visit{' '}
          <a href="/settings/api-keys">settings</a> to add your API keys
          and start running harnesses on your own machine right now.
          Sign-in is for syncing profile preferences across devices.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="pc-shell"><h1>Sign in</h1><p>loading…</p></div>}>
      <LoginForm />
    </Suspense>
  );
}
