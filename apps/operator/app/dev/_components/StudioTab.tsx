'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Drizzle Studio embed.
 *
 * WHY THE PROXY:
 *   Drizzle Studio's SPA lives at https://local.drizzle.studio (Cloudflare).
 *   When that HTTPS page tries to fetch http://localhost:<port> (the local
 *   gateway), Chrome's Private Network Access policy blocks it — public HTTPS
 *   origin → private localhost is denied even with the correct CORS headers.
 *
 *   Fix: next.config.js rewrites /drizzle-studio/* → https://local.drizzle.studio/*.
 *   The SPA loads same-origin (http://localhost:3055/drizzle-studio), so its
 *   fetches to http://localhost:<port> are localhost→localhost (both private
 *   network), which Chrome allows.
 *
 * The gateway is spawned on-demand via POST /api/dev/drizzle-studio. Status
 * is polled every 2.5s; if the gateway dies, we revert to the empty state.
 */

interface Status {
  running: boolean;
  pid?: number;
  port?: number;
  since?: number;
  lastStderr?: string;
}

export default function StudioTab() {
  const [s, setS] = useState<Status>({ running: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/dev/drizzle-studio', { cache: 'no-store' });
      setS(await r.json());
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Documented polling exception (audit P-058): drizzle-studio is an
    // external process probe (running? port?) with no sync invalidation
    // source. Was 2.5s — process state only changes on start/stop, so 10s
    // while visible (paused hidden) is plenty; the action buttons refresh
    // immediately on completion anyway.
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  const start = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/dev/drizzle-studio', { method: 'POST' });
      const d = await r.json();
      setS(d);
      if (d.error) setErr(d.error);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, []);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await fetch('/api/dev/drizzle-studio', { method: 'DELETE' });
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (checking) {
    return (
      <div className="pc-studio-state">
        <span className="pc-studio-state-text">Connecting to Drizzle Studio…</span>
      </div>
    );
  }

  if (!s.running) {
    return (
      <div className="pc-studio-state pc-studio-state-down">
        <span className="pc-studio-state-icon">offline</span>
        <strong className="pc-studio-state-title">Drizzle Studio is not running</strong>
        <p className="pc-studio-state-body">
          The local gateway will spawn as a child of this Next.js server,
          pointed at the introspected schema in{' '}
          <code>libs/papercusp/libs/db/src/schema/generated.ts</code>.
        </p>
        {err && <p className="pc-studio-state-err">{err}</p>}
        {s.lastStderr && (
          <pre className="pc-studio-state-stderr">{s.lastStderr}</pre>
        )}
        <button className="pc-studio-start-btn" disabled={busy} onClick={start}>
          {busy ? 'Starting…' : 'Start Drizzle Studio'}
        </button>
      </div>
    );
  }

  // SPA loaded through our Next.js proxy so its hardcoded localhost fetches
  // aren't blocked by Chrome's Private Network Access policy.
  const studioUrl = `/drizzle-studio?host=127.0.0.1&port=${s.port}`;
  const studioUrlAbs = `https://local.drizzle.studio/?host=127.0.0.1&port=${s.port}`;

  return (
    <div className="pc-studio-running">
      <div className="pc-studio-toolbar">
        <strong className="pc-studio-toolbar-title">Drizzle Studio</strong>
        <span className="pc-studio-toolbar-status">
          <span className="pc-studio-dot" /> running on :{s.port}
        </span>
        <div style={{ flex: 1 }} />
        <a
          href={studioUrlAbs}
          target="_blank"
          rel="noopener noreferrer"
          className="pc-studio-toolbar-link"
        >
          Open in new tab ↗
        </a>
        <button className="pc-studio-toolbar-btn" disabled={busy} onClick={stop}>
          Stop
        </button>
      </div>
      <iframe
        src={studioUrl}
        className="pc-studio-iframe"
        title="Drizzle Studio"
      />
    </div>
  );
}
