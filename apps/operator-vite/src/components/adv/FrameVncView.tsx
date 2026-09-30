import { useEffect, useRef, useState } from 'react';

/**
 * FrameVncView — the live VNC leg of the Swarm view
 * (`hive-frame-desktops-live-view-2026-06-06` P-009, D-002).
 *
 * Mints a single-use session via POST /api/deploy/:slug/vnc-session, then
 * points noVNC's RFB client at the operator's loopback VNC bridge (which is
 * piping `x11vnc -inetd` over SSH — no VNC port on the frame, ever).
 *
 * `drive=false` (the default) is READ-ONLY twice over: x11vnc runs -viewonly
 * server-side AND rfb.viewOnly suppresses client input. Takeover (D-002) is a
 * fresh, explicitly-requested session — the server-side flag changes, the
 * session is audited, and the indicator goes red.
 */

export type VncViewState = 'connecting' | 'connected' | 'ended' | 'error';

export default function FrameVncView({
  slug,
  display,
  drive,
  target = 'frame',
  onState,
}: {
  slug: string;
  display: number;
  drive: boolean;
  /**
   * 'frame' (default) = a deployed frame over SSH; 'local' = an Xvfb desktop on
   * this host (P-004). The server refuses a local display that no agent desktop
   * registered, so passing 'local' is a request, not a grant.
   */
  target?: 'frame' | 'local';
  onState?: (s: VncViewState) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<VncViewState>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let rfb: import('@novnc/novnc').default | undefined;
    const set = (s: VncViewState) => {
      if (cancelled) return;
      setState(s);
      onState?.(s);
    };
    set('connecting');
    (async () => {
      try {
        const res = await fetch(`/api/deploy/${encodeURIComponent(slug)}/vnc-session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ display, mode: drive ? 'takeover' : 'watch', target }),
        });
        const data = (await res.json()) as { ok: boolean; wsUrl?: string; error?: string };
        if (!res.ok || !data.ok || !data.wsUrl) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (cancelled || !containerRef.current) return;
        const { default: RFB } = await import('@novnc/novnc');
        rfb = new RFB(containerRef.current, data.wsUrl);
        rfb.viewOnly = !drive;
        rfb.scaleViewport = true;
        rfb.background =
          getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#07101d';
        rfb.addEventListener('connect', () => set('connected'));
        rfb.addEventListener('disconnect', () => set('ended'));
      } catch (e) {
        if (!cancelled) {
          setError((e instanceof Error ? e.message : String(e)).slice(0, 200));
          set('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      try {
        rfb?.disconnect(); // viewer-left → the bridge kills the desktop-side x11vnc
      } catch {
        /* already gone */
      }
    };
  }, [slug, display, drive, target, onState]);

  return (
    <div className="pc-frame-vnc" data-state={state}>
      <div ref={containerRef} className="pc-frame-vnc__screen" />
      {state !== 'connected' && (
        <div className="pc-frame-vnc__overlay">
          {state === 'connecting' && 'Connecting to the frame…'}
          {state === 'ended' && 'Live session ended.'}
          {state === 'error' && `Live view failed: ${error}`}
        </div>
      )}
      <style>{`
        .pc-frame-vnc { position: relative; flex: 1; min-height: 0; display: flex; }
        .pc-frame-vnc__screen { flex: 1; min-height: 0; }
        .pc-frame-vnc__screen > div { width: 100%; height: 100%; }
        .pc-frame-vnc__overlay {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
          font-size: 12px; color: var(--fg-mute, #7f9bb4);
          background: rgb(from var(--bg, #07101d) r g b / 0.6);
          pointer-events: none;
        }
      `}</style>
    </div>
  );
}
