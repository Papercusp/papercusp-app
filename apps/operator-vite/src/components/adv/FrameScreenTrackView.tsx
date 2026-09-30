import { useCallback, useEffect, useRef, useState } from 'react';
import { connectDesktopVideo } from '../../lib/video/desktop-video-client';
import type { VideoFrameLike } from '../../lib/video/video-codec';
import { webCodecsSupported } from '../../lib/video/video-codec';

/**
 * FrameScreenTrackView — the v3 transport leg of the Swarm live view
 * (`hive-frame-desktops-live-view-2026-06-06` P-013, D-004).
 *
 * Renders the holepunch SCREEN TRACK a desktop frame publishes for one
 * display (a channel peer labeled `frame:<slug>:<display>` on the harness's
 * deterministic video channel, `vid-<slug>`). Watch path only — VNC remains
 * the input path (P-013).
 *
 * Fallback contract (the "transparent" in P-013): this view calls
 * `onUnavailable(reason)` — and the parent drops to VNC — when:
 *   - WebCodecs can't run in this webview, or
 *   - the operator's voice surface is in a DIFFERENT channel (never hijack a
 *     live call to watch a screen), or
 *   - no `frame:<slug>:<display>` peer shows up / no frame arrives in time.
 * Joining when the operator is idle (no channel) or already tuned to
 * `vid-<slug>` is side-effect-safe, so those paths just connect.
 */

const FIRST_FRAME_TIMEOUT_MS = 8_000;

export default function FrameScreenTrackView({
  slug,
  display,
  onUnavailable,
}: {
  slug: string;
  display: number;
  onUnavailable: (reason: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [streaming, setStreaming] = useState(false);
  const unavailable = useRef(false);
  const bail = useCallback(
    (reason: string) => {
      if (unavailable.current) return;
      unavailable.current = true;
      onUnavailable(reason);
    },
    [onUnavailable],
  );

  useEffect(() => {
    let cancelled = false;
    let session: { close(): void } | undefined;
    let firstFrameTimer: ReturnType<typeof setTimeout> | undefined;
    let gotFrame = false;
    const wantLabel = `frame:${slug}:${display}`;
    let wantPeerId: string | null = null;

    (async () => {
      if (!webCodecsSupported()) {
        bail('WebCodecs unavailable in this webview');
        return;
      }
      // Never hijack a live call: only join when idle or already on vid-<slug>.
      try {
        const res = await fetch('/api/agent-tools/voice/status', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          cache: 'no-store',
        });
        const data = (await res.json()) as { status?: { channel?: { id?: string } | null } };
        const current = data?.status?.channel?.id ?? null;
        if (current && current !== `vid-${slug}`) {
          bail(`operator is in voice channel '${current}' — not switching it`);
          return;
        }
      } catch {
        /* status unreadable — proceed; the join itself will fail loudly if broken */
      }
      if (cancelled) return;

      session = connectDesktopVideo({
        harness: slug,
        onStatus: (s) => {
          const peer = s.peers.find((p) => p.label === wantLabel);
          wantPeerId = peer?.id ?? null;
        },
        onPeerFrame: (peerId, frame: VideoFrameLike) => {
          if (peerId !== wantPeerId) {
            frame.close();
            return;
          }
          gotFrame = true;
          if (!streaming) setStreaming(true);
          const f = frame as VideoFrameLike & { displayWidth?: number; displayHeight?: number };
          const canvas = canvasRef.current;
          try {
            const ctx = canvas?.getContext('2d');
            if (ctx && canvas) {
              if (f.displayWidth && f.displayHeight) {
                canvas.width = f.displayWidth;
                canvas.height = f.displayHeight;
              }
              ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, canvas.width, canvas.height);
            }
          } finally {
            frame.close();
          }
        },
        onError: () => bail('video channel error'),
      });
      firstFrameTimer = setTimeout(() => {
        if (!cancelled && !gotFrame) bail('no screen track for this display (frame not publishing?)');
      }, FIRST_FRAME_TIMEOUT_MS);
    })();

    return () => {
      cancelled = true;
      if (firstFrameTimer) clearTimeout(firstFrameTimer);
      try {
        session?.close();
      } catch {
        /* gone */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- streaming is render state, not a session input
  }, [slug, display, bail]);

  return (
    <div className="pc-frame-track" data-streaming={streaming}>
      <canvas ref={canvasRef} className="pc-frame-track__canvas" />
      {!streaming && <div className="pc-frame-track__overlay">Tuning to the screen track…</div>}
      <style>{`
        .pc-frame-track { position: relative; flex: 1; min-height: 0; display: flex; background: #000; }
        .pc-frame-track__canvas { flex: 1; min-height: 0; width: 100%; height: 100%; object-fit: contain; }
        .pc-frame-track__overlay {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
          font-size: 12px; color: var(--fg-mute, #7f9bb4);
          background: rgba(7, 16, 29, 0.6);
          pointer-events: none;
        }
      `}</style>
    </div>
  );
}
