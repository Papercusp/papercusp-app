/**
 * Frame-side screen-capture video source
 * (`hive-frame-desktops-live-view-2026-06-06` P-012, D-004).
 *
 * The Node-side analogue of the webview's WebCodecs camera encoder: ffmpeg
 * grabs an Xvfb display (`-f x11grab`) and encodes VP9 (libvpx-vp9, realtime
 * deadline) — matching the channel's browser decoder config (vp09, yuv420p
 * profile 0) — muxed as IVF on stdout so we get exact frame boundaries.
 * Keyframe flags come from the VP9 uncompressed header (`vp9IsKeyframe`),
 * which the receiving KeyframeGate needs to admit a new subscriber.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createIvfStreamParser } from './ivf';
import { vp9IsKeyframe } from './vp9';

export interface ScreenEncodedFrame {
  key: boolean;
  /** Microseconds — the video-channel wire convention (WebCodecs parity). */
  timestampUs: number;
  data: Uint8Array;
}

export interface ScreenCaptureOpts {
  /** X display number to grab (e.g. 99). */
  display: number;
  /** Capture size `WxH` (default 1280x720 — stream cost over fidelity). */
  videoSize?: string;
  fps?: number;
  bitrateKbps?: number;
  /** Keyframe interval in frames (default 2s worth). */
  gopFrames?: number;
  onFrame: (f: ScreenEncodedFrame) => void;
  onExit?: (code: number | null) => void;
  /** Injectable for tests. */
  spawn?: typeof nodeSpawn;
}

/** The ffmpeg argv (pure — unit-tested without a process). */
export function ffmpegScreenArgs(opts: Pick<ScreenCaptureOpts, 'display' | 'videoSize' | 'fps' | 'bitrateKbps' | 'gopFrames'>): string[] {
  const fps = opts.fps ?? 15;
  return [
    '-loglevel', 'error',
    '-f', 'x11grab',
    '-framerate', String(fps),
    '-video_size', opts.videoSize ?? '1280x720',
    '-i', `:${opts.display}`,
    '-an',
    '-c:v', 'libvpx-vp9',
    // Realtime encode on a shared frame: speed over compression.
    '-deadline', 'realtime',
    '-cpu-used', '8',
    '-pix_fmt', 'yuv420p', // profile 0 — matches the browser decoder config
    '-b:v', `${opts.bitrateKbps ?? 800}k`,
    '-g', String(opts.gopFrames ?? fps * 2),
    '-f', 'ivf',
    'pipe:1',
  ];
}

export interface ScreenCapture {
  stop(): void;
  readonly child: ChildProcess;
}

export function startScreenCapture(opts: ScreenCaptureOpts): ScreenCapture {
  const spawn = opts.spawn ?? nodeSpawn;
  const child = spawn('ffmpeg', ffmpegScreenArgs(opts), {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own group → tree-kill on stop
  });
  const parser = createIvfStreamParser();
  child.stdout?.on('data', (chunk: Buffer) => {
    let frames;
    try {
      frames = parser.push(chunk);
    } catch (e) {
      console.warn(`[screen-track] :${opts.display} ivf parse failed: ${(e as Error).message}`);
      stop();
      return;
    }
    for (const f of frames) {
      opts.onFrame({ key: vp9IsKeyframe(f.data), timestampUs: f.timestampUs, data: f.data });
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const line = String(chunk).trim();
    if (line) console.warn(`[screen-track] :${opts.display} ffmpeg: ${line.slice(0, 300)}`);
  });
  child.on('close', (code) => opts.onExit?.(code));

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    const pid = child.pid;
    let killed = false;
    if (pid) {
      try {
        process.kill(-pid, 'SIGTERM');
        killed = true;
      } catch {
        /* fall through */
      }
    }
    if (!killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
    }
  };
  return { stop, child };
}
