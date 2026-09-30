/**
 * VideoGrid — desktop P2P participant grid for a shared harness (plan
 * holepunch-video-shared-harnesses-2026-06-05 P-006, D-004).
 *
 * Self-contained: given a shared-harness slug it owns the whole video session —
 * the WS to the operator's desktop voice bridge, getUserMedia + WebCodecs encode,
 * per-peer decode → canvas tiles, self-view PiP, active-speaker highlight, the
 * mic/camera/screen-share/leave control bar, and the audio-only + permission
 * degrade states. The workbench voice/video pane mounts it; this component owns
 * everything inside its container (contract agreed with desktop-workbench-shell).
 *
 * Audio I/O (mic capture / mix playback) is the holepunch-voice P-015 desktop
 * slice; this grid carries presence + active-speaker (from the status stream) and
 * the video path. User-meaningful toggles live in the URL via nuqs so an agent
 * (ui:dispatch) and a deep link can drive them.
 *
 * Most of this file is browser glue verified live at P-010; the grid's pure shape
 * is in video-grid-state.ts (unit-tested) and the transport in the lib/video/*
 * modules (unit-tested).
 */
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import {
  connectDesktopVideo,
  type DesktopVideoSession,
  type VoiceSessionStatus,
} from '../../lib/video/desktop-video-client';
import { resolveDesktopVoiceWsUrl } from '../../lib/voice/resolve-voice-ws-url';
import { webCodecsSupported, type VideoFrameLike } from '../../lib/video/video-codec';
import { startCameraCapture, type CameraCapture } from '../../lib/video/camera-capture';
import { buildGridModel, type GridModel, type GridTile } from './video-grid-state';
import { useShortcutAction } from '@/lib/hotkeys';
import './VideoGrid.css';

export interface VideoGridProps {
  /** Shared-harness slug → the deterministic per-harness video channel (D-003). */
  harnessSlug: string;
  /** The pane sizes the grid; it fills its container. */
  className?: string;
}

const EMPTY_STATUS: VoiceSessionStatus = { channel: null, muted: false, peers: [] };

export default function VideoGrid({ harnessSlug, className }: VideoGridProps): JSX.Element {
  const [cameraOn, setCameraOn] = useQueryState('vcam', parseAsBoolean.withDefault(false));
  const [screenOn, setScreenOn] = useQueryState('vscreen', parseAsBoolean.withDefault(false));
  const [muted, setMuted] = useQueryState('vmute', parseAsBoolean.withDefault(false));
  // Discord-parity Mod+Shift+V camera toggle (discord-shortcuts 2026-06-06).
  // Registered here (not a global mount) so the combo only acts while a
  // video surface is actually on screen — VideoGrid itself is flag-gated
  // behind VIDEO_CHANNELS by its hosts, so the binding inherits the gate.
  useShortcutAction('video.toggleCamera', () => void setCameraOn(!cameraOn));

  const [status, setStatus] = useState<VoiceSessionStatus>(EMPTY_STATUS);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const sessionRef = useRef<DesktopVideoSession | null>(null);
  const captureRef = useRef<CameraCapture | null>(null);
  const selfCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const peerCanvasRefs = useRef(new Map<string, HTMLCanvasElement>());
  /** Peers we've already keyframed for — a NEW peer needs the next frame to be a
   *  keyframe or its KeyframeGate drops our deltas forever (found in the live
   *  P-010 run: late joiners would never get a decodable stream). */
  const keyframedPeersRef = useRef(new Set<string>());

  const codecOk = useMemo(() => webCodecsSupported(), []);
  // Video can't run → render audio-only avatars (D-005).
  const audioOnly = !codecOk || cameraError !== null;

  // Draw one decoded frame to a canvas (peer tile or self PiP), then free it.
  const drawFrame = useCallback((canvas: HTMLCanvasElement | null, frame: VideoFrameLike) => {
    const f = frame as VideoFrameLike & { displayWidth?: number; displayHeight?: number };
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
  }, []);

  // --- session lifecycle (per harness) ---
  useEffect(() => {
    if (!harnessSlug) return;
    let cancelled = false;
    let session: DesktopVideoSession | null = null;
    // Resolve the bridge URL via runtime-config first (P-015 D-014): with
    // several operators on one box each walks to its own port, so the
    // webview must ask ITS operator rather than assume :3076.
    void resolveDesktopVoiceWsUrl().then((url) => {
      if (cancelled) return;
      session = connectDesktopVideo({
        url,
        harness: harnessSlug,
        onStatus: (s) => {
          setStatus(s);
          // A newly-joined peer must receive a keyframe before our deltas decode.
          const known = keyframedPeersRef.current;
          let hasNew = false;
          for (const p of s.peers) {
            if (!known.has(p.id)) {
              known.add(p.id);
              hasNew = true;
            }
          }
          if (hasNew) captureRef.current?.encoder.requestKeyframe();
        },
        onPeerFrame: (peerId, frame) => drawFrame(peerCanvasRefs.current.get(peerId) ?? null, frame),
        onError: (e) => console.warn('[video-grid] session error', e),
      });
      sessionRef.current = session;
    });
    return () => {
      cancelled = true;
      captureRef.current?.stop();
      captureRef.current = null;
      session?.close();
      sessionRef.current = null;
      keyframedPeersRef.current.clear();
      setStatus(EMPTY_STATUS);
    };
  }, [harnessSlug, drawFrame]);

  // --- mute toggle ---
  useEffect(() => {
    sessionRef.current?.setMuted(muted);
  }, [muted]);

  // --- camera / screen-share capture ---
  const wantCapture = (cameraOn || screenOn) && !audioOnly;
  const captureSource: 'camera' | 'screen' = screenOn ? 'screen' : 'camera';
  useEffect(() => {
    let cancelled = false;
    const session = sessionRef.current;
    if (!wantCapture || !session) {
      captureRef.current?.stop();
      captureRef.current = null;
      session?.setCameraOn(false);
      return;
    }
    void startCameraCapture({
      source: captureSource,
      onFrame: (f) => sessionRef.current?.sendCamFrame(f),
      onError: (e) => console.warn('[video-grid] capture error', e),
    })
      .then((cap) => {
        if (cancelled) {
          cap.stop();
          return;
        }
        captureRef.current = cap;
        // Render self preview from the same stream.
        const v = document.createElement('video');
        v.srcObject = cap.stream;
        v.muted = true;
        void v.play().catch(() => {});
        const draw = () => {
          if (cancelled || !captureRef.current) return;
          const c = selfCanvasRef.current;
          const ctx = c?.getContext('2d');
          if (ctx && c) ctx.drawImage(v, 0, 0, c.width, c.height);
          requestAnimationFrame(draw);
        };
        requestAnimationFrame(draw);
        session.setCameraOn(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setCameraError(e instanceof Error ? e.message : 'camera unavailable');
        void setCameraOn(false);
        void setScreenOn(false);
      });
    return () => {
      cancelled = true;
    };
  }, [wantCapture, captureSource, setCameraOn, setScreenOn]);

  const model: GridModel = useMemo(
    () =>
      buildGridModel({
        peers: status.peers,
        self: {
          id: status.identity?.id ?? 'self',
          label: status.identity?.label ?? 'You',
          cameraOn: cameraOn || screenOn,
          muted,
        },
        audioOnly,
      }),
    [status.peers, status.identity, cameraOn, screenOn, muted, audioOnly],
  );

  const registerPeerCanvas = useCallback((peerId: string, el: HTMLCanvasElement | null) => {
    if (el) peerCanvasRefs.current.set(peerId, el);
    else peerCanvasRefs.current.delete(peerId);
  }, []);

  return (
    <div className={`pc-video-grid${className ? ` ${className}` : ''}`} data-audio-only={audioOnly}>
      {cameraError && (
        <div className="pc-video-grid__banner" role="alert">
          Camera unavailable: {cameraError}. Joined audio-only.
        </div>
      )}
      {!codecOk && (
        <div className="pc-video-grid__banner" role="status">
          This webview doesn't support video encoding — joined audio-only.
        </div>
      )}

      <div className="pc-video-grid__tiles" data-empty={model.empty}>
        {model.empty && <div className="pc-video-grid__empty">Waiting for others to join…</div>}
        {model.peerTiles.map((tile) => (
          <PeerTile key={tile.id} tile={tile} registerCanvas={registerPeerCanvas} />
        ))}
        {model.hiddenCount > 0 && (
          <div className="pc-video-grid__overflow">+{model.hiddenCount} more</div>
        )}
      </div>

      {/* Self-view PiP */}
      <div className="pc-video-grid__self" data-camera={model.self.cameraOn} data-muted={model.self.muted}>
        {model.self.cameraOn ? (
          <canvas ref={selfCanvasRef} width={160} height={90} className="pc-video-grid__self-canvas" />
        ) : (
          <Avatar label={model.self.label} />
        )}
        <span className="pc-video-grid__self-label">{model.self.label} (you)</span>
      </div>

      {/* Control bar */}
      <div className="pc-video-grid__controls" role="toolbar" aria-label="Call controls">
        <button
          type="button"
          className="pc-video-grid__btn"
          aria-pressed={!muted}
          data-active={!muted}
          onClick={() => void setMuted(!muted)}
        >
          {muted ? '🔇 Unmute' : '🎤 Mute'}
        </button>
        <button
          type="button"
          className="pc-video-grid__btn"
          aria-pressed={cameraOn}
          data-active={cameraOn}
          disabled={audioOnly || screenOn}
          onClick={() => void setCameraOn(!cameraOn)}
        >
          {cameraOn ? '📷 Stop camera' : '📷 Camera'}
        </button>
        <button
          type="button"
          className="pc-video-grid__btn"
          aria-pressed={screenOn}
          data-active={screenOn}
          disabled={audioOnly || cameraOn}
          onClick={() => void setScreenOn(!screenOn)}
        >
          {screenOn ? '🖥 Stop share' : '🖥 Share screen'}
        </button>
        <button
          type="button"
          className="pc-video-grid__btn pc-video-grid__btn--leave"
          onClick={() => {
            void setCameraOn(false);
            void setScreenOn(false);
            sessionRef.current?.close();
            sessionRef.current = null;
            setStatus(EMPTY_STATUS);
          }}
        >
          ✖ Leave
        </button>
      </div>
    </div>
  );
}

function PeerTile({
  tile,
  registerCanvas,
}: {
  tile: GridTile;
  registerCanvas: (peerId: string, el: HTMLCanvasElement | null) => void;
}): JSX.Element {
  return (
    <div
      className="pc-video-grid__tile"
      data-speaking={tile.isActiveSpeaker}
      data-camera={tile.cameraOn}
      aria-label={`${tile.label}${tile.isActiveSpeaker ? ' (speaking)' : ''}`}
    >
      {tile.cameraOn ? (
        <canvas
          ref={(el) => registerCanvas(tile.id, el)}
          width={640}
          height={360}
          className="pc-video-grid__tile-canvas"
        />
      ) : (
        <Avatar label={tile.label} />
      )}
      <span className="pc-video-grid__tile-label">
        {tile.muted ? '🔇 ' : ''}
        {tile.label}
      </span>
    </div>
  );
}

function Avatar({ label }: { label: string }): JSX.Element {
  const initial = (label.trim()[0] ?? '?').toUpperCase();
  return (
    <div className="pc-video-grid__avatar" aria-hidden="true">
      <span>{initial}</span>
    </div>
  );
}
