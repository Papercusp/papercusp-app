/**
 * On-demand desktop thumbnails — plan agent-multi-desktops-grid-2026-10-06, P-005 / D-008.
 *
 * WHY on-demand: the frame capture loop (`deployment/desktop-capture.ts`) is generated
 * at frame bootstrap with a FIXED display list, so a desktop an agent starts later
 * never gets a capture file. Rather than add a second loop, a grid READ captures one
 * frame for the display it asks about and caches it briefly. Only an open grid calls
 * this, so its cost is exactly zero when nobody is looking (parent D-035) — no timer.
 *
 * Contract:
 *  - A thumbnail younger than `cacheMs` (default 4s) is served from the cache, so a grid
 *    polling every ~5s sees a fresh frame at most `cacheMs + pollInterval` apart (< 10s).
 *  - Concurrent reads of the same display COALESCE onto one capture.
 *  - At most `maxConcurrent` ffmpeg captures run at once across all displays.
 *  - A failed capture yields `null` (and is cached like a frame, so a dead display is
 *    not re-grabbed on every read); it never throws to the grid.
 */
import { spawn } from 'node:child_process';
import { pinModuleState } from '@papercusp/module-singleton';

export const DESKTOP_THUMBNAIL_CACHE_MS = 4_000;
export const DESKTOP_THUMBNAIL_WIDTH = 480;
export const DESKTOP_THUMBNAIL_MAX_CONCURRENT = 2;
export const DESKTOP_THUMBNAIL_TIMEOUT_MS = 5_000;

export interface GrabFrameOpts {
  width: number;
  timeoutMs: number;
}

/** Capture ONE scaled JPEG of X display `:display`; null when it cannot be grabbed. */
export type GrabFrame = (display: number, opts: GrabFrameOpts) => Promise<Buffer | null>;

export interface DesktopThumbnailerDeps {
  grab?: GrabFrame;
  now?: () => number;
  cacheMs?: number;
  maxConcurrent?: number;
  width?: number;
  timeoutMs?: number;
}

export interface DesktopThumbnailerStats {
  captures: number;
  cacheHits: number;
  coalesced: number;
  inflight: number;
}

export interface DesktopThumbnailer {
  thumbnail(display: number): Promise<Buffer | null>;
  stats(): DesktopThumbnailerStats;
}

const JPEG_MAGIC = [0xff, 0xd8];

/** ffmpeg x11grab, one frame, scaled to `width`, MJPEG to stdout. */
export const grabX11Frame: GrabFrame = (display, { width, timeoutMs }) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // No -video_size: xcbgrab defaults to the whole screen of the display.
    const child = spawn(
      'ffmpeg',
      ['-loglevel', 'error', '-f', 'x11grab', '-i', `:${display}`, '-frames:v', '1',
        '-vf', `scale=${width}:-2`, '-q:v', '6', '-f', 'mjpeg', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      const jpeg = Buffer.concat(chunks);
      const isJpeg = jpeg.length > 2 && jpeg[0] === JPEG_MAGIC[0] && jpeg[1] === JPEG_MAGIC[1];
      finish(code === 0 && isJpeg ? jpeg : null);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
  });

export function createDesktopThumbnailer(deps: DesktopThumbnailerDeps = {}): DesktopThumbnailer {
  const grab = deps.grab ?? grabX11Frame;
  const now = deps.now ?? Date.now;
  const cacheMs = deps.cacheMs ?? DESKTOP_THUMBNAIL_CACHE_MS;
  const maxConcurrent = Math.max(1, deps.maxConcurrent ?? DESKTOP_THUMBNAIL_MAX_CONCURRENT);
  const opts: GrabFrameOpts = {
    width: deps.width ?? DESKTOP_THUMBNAIL_WIDTH,
    timeoutMs: deps.timeoutMs ?? DESKTOP_THUMBNAIL_TIMEOUT_MS,
  };

  const cache = new Map<number, { at: number; jpeg: Buffer | null }>();
  const inflight = new Map<number, Promise<Buffer | null>>();
  const waiters: Array<() => void> = [];
  let running = 0;
  const counters = { captures: 0, cacheHits: 0, coalesced: 0 };

  // A released slot is HANDED to the next waiter rather than returned to the pool, so a
  // caller arriving between the release and the waiter's resumption cannot take it and
  // push `running` past the cap.
  const acquire = async (): Promise<void> => {
    if (running < maxConcurrent) {
      running += 1;
      return;
    }
    await new Promise<void>((wake) => waiters.push(wake));
  };
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else running -= 1;
  };

  const capture = async (display: number): Promise<Buffer | null> => {
    await acquire();
    try {
      counters.captures += 1;
      const jpeg = await grab(display, opts).catch(() => null);
      cache.set(display, { at: now(), jpeg });
      return jpeg;
    } finally {
      release();
    }
  };

  return {
    async thumbnail(display: number): Promise<Buffer | null> {
      const hit = cache.get(display);
      if (hit && now() - hit.at < cacheMs) {
        counters.cacheHits += 1;
        return hit.jpeg;
      }
      const pending = inflight.get(display);
      if (pending) {
        counters.coalesced += 1;
        return pending;
      }
      const promise = capture(display).finally(() => inflight.delete(display));
      inflight.set(display, promise);
      return promise;
    },
    stats: () => ({ ...counters, inflight: inflight.size }),
  };
}

const state = pinModuleState('@papercusp/operator-core.desktop-thumbnail', () => ({
  thumbnailer: null as DesktopThumbnailer | null,
}));

/** The process-wide thumbnailer every grid read shares (one cache, one concurrency cap). */
export function desktopThumbnailer(): DesktopThumbnailer {
  state.thumbnailer ??= createDesktopThumbnailer();
  return state.thumbnailer;
}
