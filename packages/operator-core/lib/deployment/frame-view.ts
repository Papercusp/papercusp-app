/**
 * Operator-side frame live-view service
 * (`hive-frame-desktops-live-view-2026-06-06` P-005, transport per D-003).
 *
 * Viewer-driven SSH pull: while ≥1 subscriber is watching a harness's frame,
 * poll the frame's `/run/papercusp/desktop` (latest-frame JPEGs + the
 * `leases.json` role map, both written frame-side) over the SAME RemoteExec SSH
 * channel the deploy layer already uses, and fan the thumbnails out to
 * subscribers (the SSE route). No subscribers → no polling, zero cost. Media
 * never touches PG (D-003).
 *
 * The pull leg is the explicitly-justified polling exception: the operator is
 * loopback-bound, so a frame cannot push to it today; v3 (the holepunch screen
 * track, D-004) replaces this with a real push transport.
 */
import type { DeploymentConfig, Frame } from '@papercusp/deployment-driver';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import type { RemoteExec } from './remote-exec';
import { defaultMakeRemoteExec } from './frame-installer';
import { DESKTOP_CAPTURE_DIR } from './desktop-capture';
import type { DisplayLeaseInfo } from './display-allocator';
import { loadDeployedFrame } from './deployed-frame';
import { activeVncSessions } from './frame-vnc';

/** One thumbnail event fanned to subscribers. */
export interface FrameThumb {
  slug: string;
  display: number;
  jpegBase64: string;
  /** Operator-receive time (epoch ms) — capture is at most one interval older. */
  capturedAtMs: number;
  /** Role driving this display, when the frame's lease snapshot names one. */
  role?: string;
  leaseSinceMs?: number;
}

/** Poller status events (frame missing, ssh failures, displays seen). */
export interface FrameViewStatus {
  slug: string;
  state: 'polling' | 'no-frame' | 'error';
  frameId?: string;
  host?: string;
  displays?: number[];
  error?: string;
  /** Live VNC viewers on this frame (D-002 session indicator). */
  viewers?: { display: number; mode: string; sinceMs: number }[];
}

export interface FrameViewSubscriber {
  onThumb(t: FrameThumb): void;
  onStatus?(s: FrameViewStatus): void;
}

export interface FrameViewDeps {
  /** Resolve the harness's deployed frame + config (registry-backed by default). */
  loadFrame: (slug: string, workspaceId: string) => Promise<{ frame: Frame; config: DeploymentConfig } | undefined>;
  makeExec?: (frame: Frame, config: DeploymentConfig) => RemoteExec;
  intervalMs?: number;
}

/** The single SSH round-trip per tick: lease snapshot + every fresh JPEG, framed
 *  by marker lines so one exec ships everything. */
export const FRAME_PULL_SCRIPT = [
  `cd ${DESKTOP_CAPTURE_DIR} 2>/dev/null || { echo NO_CAPTURE_DIR; exit 0; }`,
  `if [ -f leases.json ]; then echo "LEASES"; base64 -w0 leases.json; echo; fi`,
  `for f in display-*.jpg; do`,
  `  [ -f "$f" ] || continue`,
  `  echo "THUMB $f"`,
  `  base64 -w0 "$f"; echo`,
  `done`,
].join('\n');

export interface ParsedFramePull {
  /** Frame had no capture dir at all (desktop off / not yet booted). */
  noCaptureDir: boolean;
  leases: DisplayLeaseInfo[];
  thumbs: { display: number; jpegBase64: string }[];
}

/** Parse the marker-framed pull output. Exported for unit tests. */
export function parseFramePull(stdout: string): ParsedFramePull {
  const out: ParsedFramePull = { noCaptureDir: false, leases: [], thumbs: [] };
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === 'NO_CAPTURE_DIR') {
      out.noCaptureDir = true;
    } else if (line === 'LEASES') {
      const b64 = (lines[++i] ?? '').trim();
      try {
        const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as {
          leases?: DisplayLeaseInfo[];
        };
        if (Array.isArray(parsed.leases)) out.leases = parsed.leases;
      } catch {
        /* torn/garbled snapshot — skip; next tick repairs */
      }
    } else {
      const m = /^THUMB display-(\d+)\.jpg$/.exec(line);
      if (m) {
        const jpegBase64 = (lines[++i] ?? '').trim();
        if (jpegBase64) out.thumbs.push({ display: Number(m[1]), jpegBase64 });
      }
    }
  }
  return out;
}

const DEFAULT_INTERVAL_MS = 5_000;

class FramePoller {
  private subs = new Set<FrameViewSubscriber>();
  private timer: ManagedHandle | undefined;
  private ticking = false;
  private resolved: { frame: Frame; config: DeploymentConfig; exec: RemoteExec } | undefined;

  constructor(
    private readonly slug: string,
    private readonly workspaceId: string,
    private readonly deps: FrameViewDeps,
  ) {}

  get empty(): boolean {
    return this.subs.size === 0;
  }

  add(sub: FrameViewSubscriber): void {
    this.subs.add(sub);
    if (!this.timer) {
      this.timer = managedSetInterval('frame-view-poll', this.deps.intervalMs ?? DEFAULT_INTERVAL_MS, () => void this.tick(), { category: 'lifecycle', instanced: true });
      void this.tick(); // first frame immediately, not one interval late
    }
  }

  remove(sub: FrameViewSubscriber): void {
    this.subs.delete(sub);
    if (this.subs.size === 0) this.stop();
  }

  stop(): void {
    if (this.timer) this.timer.stop();
    this.timer = undefined;
    this.resolved = undefined;
  }

  private status(s: Omit<FrameViewStatus, 'slug'>): void {
    for (const sub of this.subs) sub.onStatus?.({ slug: this.slug, ...s });
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.subs.size === 0) return; // ssh slower than interval → skip, don't stack
    this.ticking = true;
    try {
      if (!this.resolved) {
        const loaded = await this.deps.loadFrame(this.slug, this.workspaceId);
        if (!loaded) {
          this.status({ state: 'no-frame' });
          return;
        }
        const makeExec = this.deps.makeExec ?? defaultMakeRemoteExec;
        this.resolved = { ...loaded, exec: makeExec(loaded.frame, loaded.config) };
      }
      const { frame, exec } = this.resolved;
      const { stdout } = await exec.runScript(FRAME_PULL_SCRIPT);
      const parsed = parseFramePull(stdout);
      const now = Date.now();
      const roleByDisplay = new Map(parsed.leases.map((l) => [l.number, l]));
      this.status({
        state: 'polling',
        frameId: frame.id,
        host: frame.host,
        displays: parsed.thumbs.map((t) => t.display),
        // D-002: surface who is watching/driving so the view (and anything
        // reading the stream) can show the session indicator.
        viewers: activeVncSessions(this.slug).map((v) => ({
          display: v.display,
          mode: v.mode,
          sinceMs: v.sinceMs,
        })),
      });
      for (const t of parsed.thumbs) {
        const lease = roleByDisplay.get(t.display);
        const thumb: FrameThumb = {
          slug: this.slug,
          display: t.display,
          jpegBase64: t.jpegBase64,
          capturedAtMs: now,
          role: lease?.role,
          leaseSinceMs: lease?.sinceMs,
        };
        for (const sub of this.subs) sub.onThumb(thumb);
      }
    } catch (e) {
      // Drop the cached exec so a recycled/redeployed frame re-resolves.
      this.resolved = undefined;
      this.status({ state: 'error', error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    } finally {
      this.ticking = false;
    }
  }
}

const pollers = new Map<string, FramePoller>();

export { loadDeployedFrame } from './deployed-frame';

/**
 * Subscribe to a harness frame's live thumbnails. Starts the (per-slug, shared)
 * SSH poller on the first subscriber; stops it when the last one leaves.
 * Returns the unsubscribe.
 */
export function subscribeFrameView(
  slug: string,
  workspaceId: string,
  sub: FrameViewSubscriber,
  deps: FrameViewDeps = { loadFrame: loadDeployedFrame },
): () => void {
  const key = `${workspaceId}::${slug}`;
  let poller = pollers.get(key);
  if (!poller) {
    poller = new FramePoller(slug, workspaceId, deps);
    pollers.set(key, poller);
  }
  poller.add(sub);
  return () => {
    poller.remove(sub);
    if (poller.empty) pollers.delete(key);
  };
}

export function _resetFrameViewForTests(): void {
  for (const p of pollers.values()) p.stop();
  pollers.clear();
}
