import { useCallback, useEffect, useRef, useState } from 'react';
import { Tooltip } from '@/app/harness/Tooltip';

/**
 * VersionBadge — bottom-right "what's running" pill + out-of-date detector.
 *
 * Polls `GET /api/desktop/version` every 30s (the route's own purpose — see
 * endpoint-route/routes/desktop/version.ts: "sha change between polls → amber
 * pill → click-to-reload"). It captures the FIRST `sidecarSha` it sees, and when
 * a later poll returns a different sha — i.e. the operator we're talking to
 * (in the desktop, the green :3070 host that `/api` rides IPC to) restarted with
 * new code — it flips to a loud amber "↻ reload" that hard-reloads the SPA.
 *
 * Ported from Restart's harness VersionBadge (a Next.js sidecar) to this Vite +
 * React app: same poll/compare logic, inline styles (the Restart copy imported a
 * CSS file that didn't exist), and the same `window.location.reload()` on click.
 * Subtle when current, prominent only when stale — you only care when it's stale.
 */
interface VersionInfo {
  appVersion: string;
  sidecarSha: string;
  sidecarStartedAtMs: number;
  nowMs: number;
  isDesktop: boolean;
}

const POLL_MS = 30_000;

export default function VersionBadge() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [stale, setStale] = useState(false);
  const initialShaRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch('/api/desktop/version', { cache: 'no-store' });
        if (!r.ok) return;
        const data = (await r.json()) as VersionInfo;
        if (cancelled) return;
        setInfo(data);
        if (initialShaRef.current === null) {
          initialShaRef.current = data.sidecarSha;
        } else if (data.sidecarSha !== initialShaRef.current) {
          setStale(true);
        }
      } catch {
        // network blip — keep the prior value, try again next tick
      }
    }
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const onClick = useCallback(() => {
    if (stale) window.location.reload();
  }, [stale]);

  if (!info) return null;

  const title = stale
    ? 'A newer build is running on the server — click to reload and pick it up'
    : `app v${info.appVersion} · ${info.sidecarSha}\nstarted ${new Date(
        info.sidecarStartedAtMs,
      ).toLocaleString()}\n${info.isDesktop ? 'desktop' : 'browser'}`;

  return (
    <Tooltip label={title}>
      <button
        type="button"
        onClick={onClick}
        aria-label={title}
        style={{
          position: 'fixed',
          right: 10,
          bottom: 8,
          zIndex: 2147483640,
          // The current-build badge is informational and its no-op click
          // handler must not intercept controls underneath it. Re-enable hit
          // testing only when a stale build makes reload actionable.
          pointerEvents: stale ? 'auto' : 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 9px',
          borderRadius: 8,
          font: '600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace',
          cursor: stale ? 'pointer' : 'default',
          border: `1px solid ${stale ? 'color-mix(in oklab, var(--warn), transparent 45%)' : 'var(--border)'}`,
          background: stale
            ? 'color-mix(in oklab, var(--warn), transparent 84%)'
            : 'color-mix(in oklab, var(--bg), transparent 20%)',
          color: stale ? 'var(--warn)' : 'var(--fg-mute)',
          opacity: stale ? 1 : 0.6,
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          transition: 'opacity 120ms ease, background 120ms ease, color 120ms ease, border-color 120ms ease',
        }}
      >
        <span>v{info.appVersion}</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>{info.sidecarSha}</span>
        {stale && <span style={{ fontWeight: 800 }}>↻ reload</span>}
      </button>
    </Tooltip>
  );
}
