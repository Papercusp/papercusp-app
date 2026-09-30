'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

interface Status {
  signedIn: boolean;
  user: { id: string; email: string; displayName: string | null } | null;
}

export default function SessionIndicator() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((d) => setStatus(d))
      .catch(() => setStatus({ signedIn: false, user: null }));
  }, []);

  const signOut = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/';
    } catch (e: any) {
      toast.error(`logout failed: ${e?.message ?? e}`);
    }
  };

  if (!status) return <span style={{ fontSize: 13, color: 'var(--fg-mute)' }}>…</span>;
  if (!status.signedIn) {
    return (
      <a href="/login" style={{ fontSize: 13, color: 'var(--fg-dim)' }}>
        Sign in
      </a>
    );
  }
  return (
    <span style={{ fontSize: 13, display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <span style={{ color: 'var(--fg-dim)' }}>
        {status.user?.displayName ?? status.user?.email}
      </span>
      <button
        type="button"
        onClick={signOut}
        style={{ background: 'none', border: 'none', color: 'var(--fg-mute)', fontSize: 12, cursor: 'pointer', padding: 0 }}
      >
        sign out
      </button>
    </span>
  );
}
