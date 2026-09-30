/**
 * Frame screen-track publisher
 * (`hive-frame-desktops-live-view-2026-06-06` P-012, D-004).
 *
 * On a desktop-enabled frame, publish each ACTIVE display (one with a leased
 * agent — the display-allocator pool) as a video track on the harness's
 * deterministic video channel (`vid-<slug>` — the same channel the operator's
 * VideoGrid / Frames tab tunes to). "One track per active display" with ZERO
 * wire-protocol changes: each display joins as its OWN peer (its own
 * VoiceNode + swarm), labeled `frame:<slug>:<display>`, so receivers demux by
 * peerId exactly like camera peers and the label carries the display identity.
 *
 * Cost control: a track encodes ONLY while the channel has ≥1 other peer —
 * no watcher, no ffmpeg (the same viewer-driven discipline as the SSH pull).
 *
 * The poll loop watches the lease set (display leased → track up; released →
 * track down). Dependency-injected (`makeTrack`) so lifecycle is unit-tested
 * without hyperswarm/ffmpeg.
 */
import { encodeVideoPayload } from '@papercusp/p2p-voice';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { agentDisplayPool } from '../../deployment/display-allocator';
import { startScreenCapture, type ScreenCapture } from './screen-capture-source';

export const SCREEN_PEER_LABEL_PREFIX = 'frame:';

/** The label receivers match on: `frame:<slug>:<display>`. */
export function screenPeerLabel(slug: string, display: number): string {
  return `${SCREEN_PEER_LABEL_PREFIX}${slug}:${display}`;
}

/** Parse a screen-peer label back into its identity (or undefined). */
export function parseScreenPeerLabel(label: string): { slug: string; display: number } | undefined {
  if (!label.startsWith(SCREEN_PEER_LABEL_PREFIX)) return undefined;
  const rest = label.slice(SCREEN_PEER_LABEL_PREFIX.length);
  const i = rest.lastIndexOf(':');
  if (i <= 0) return undefined;
  const display = Number(rest.slice(i + 1));
  if (!Number.isInteger(display)) return undefined;
  return { slug: rest.slice(0, i), display };
}

export interface DisplayTrack {
  display: number;
  stop(): Promise<void>;
}

export interface ScreenPublisherOpts {
  harnessSlug: string;
  /** Active display numbers (default: the agent display pool's lease set). */
  displays?: () => number[];
  pollMs?: number;
  /** Injectable track factory (tests). Default: real swarm peer + ffmpeg. */
  makeTrack?: (display: number) => Promise<DisplayTrack>;
}

export interface ScreenPublisher {
  /** Displays currently published (ascending). */
  tracks(): number[];
  stop(): Promise<void>;
}

export function startFrameScreenPublisher(opts: ScreenPublisherOpts): ScreenPublisher {
  // Default: publish LEASED displays (one track per active agent). The 'all'
  // mode (PAPERCUSP_DESKTOP_SCREEN_TRACKS=all) publishes the whole pool —
  // used by the live E2E (no agents leased yet) and as an operator knob.
  const defaultDisplays = () => {
    const pool = agentDisplayPool();
    if (!pool) return [];
    if (process.env.PAPERCUSP_DESKTOP_SCREEN_TRACKS === 'all') {
      return Array.from({ length: pool.size }, (_, n) => pool.base + n);
    }
    return pool.leased();
  };
  const displays = opts.displays ?? defaultDisplays;
  const makeTrack = opts.makeTrack ?? ((display: number) => makeRealTrack(opts.harnessSlug, display));
  const live = new Map<number, Promise<DisplayTrack | undefined>>();
  let stopped = false;

  const reconcile = async () => {
    if (stopped) return;
    const want = new Set(displays());
    for (const d of want) {
      if (!live.has(d)) {
        live.set(
          d,
          makeTrack(d).catch((e) => {
            console.warn(`[screen-track] :${d} track failed to start: ${(e as Error).message}`);
            live.delete(d); // retry on a later tick
            return undefined;
          }),
        );
      }
    }
    for (const [d, trackP] of live) {
      if (!want.has(d)) {
        live.delete(d);
        void trackP.then((t) => t?.stop()).catch(() => {});
      }
    }
  };

  void reconcile();
  const timer = managedSetInterval('screen-publisher-reconcile', opts.pollMs ?? 5_000, () => void reconcile(), { category: 'lifecycle', instanced: true });

  return {
    tracks: () => [...live.keys()].sort((a, b) => a - b),
    async stop() {
      stopped = true;
      timer.stop();
      const all = [...live.values()];
      live.clear();
      await Promise.all(all.map((p) => p.then((t) => t?.stop()).catch(() => {})));
    },
  };
}

/**
 * The real track: a dedicated VoiceNode peer (own swarm, labeled for the
 * display) joined to the harness's video channel, feeding ffmpeg VP9 frames
 * into `pushVideo` — but only while someone else is in the channel.
 */
async function makeRealTrack(slug: string, display: number): Promise<DisplayTrack> {
  const { randomBytes } = await import('node:crypto');
  const { createVoiceNode } = await import('@papercusp/p2p-voice');
  const { getOpusCodec } = await import('../codec');
  const { ensureVideoChannel } = await import('../registry');
  const { swarmConstructorOpts } = await import('../../sync/hyperbee/swarm');
  const mod = (await import('hyperswarm')) as {
    default: new (opts?: unknown) => import('@papercusp/p2p-voice').SwarmLike & { destroy(): Promise<void> };
  };

  const channel = await ensureVideoChannel(slug);
  const swarm = new mod.default(swarmConstructorOpts());
  const node = createVoiceNode({
    swarm,
    codec: await getOpusCodec(),
    identity: {
      id: `frame-${slug}-${display}-${randomBytes(3).toString('hex')}`,
      label: screenPeerLabel(slug, display),
    },
  });
  const handle = node.joinChannel(channel.topicHex);
  handle.setMuted(true); // a screen has no microphone
  handle.setCameraOn(true); // announce "this peer has video" (the camera flag IS the video flag)

  let capture: ScreenCapture | null = null;
  const syncCapture = () => {
    const audience = handle.peers().length > 0;
    if (audience && !capture) {
      console.log(`[screen-track] :${display} audience present — starting capture`);
      capture = startScreenCapture({
        display,
        onFrame: (f) => {
          try {
            handle.pushVideo(encodeVideoPayload({ key: f.key, timestamp: f.timestampUs }, f.data));
          } catch {
            /* channel mid-teardown */
          }
        },
        onExit: () => {
          capture = null;
        },
      });
    } else if (!audience && capture) {
      console.log(`[screen-track] :${display} audience gone — stopping capture`);
      capture.stop();
      capture = null;
    }
  };
  const offPeers = handle.onPeersChanged(() => syncCapture());
  syncCapture();

  return {
    display,
    async stop() {
      offPeers();
      capture?.stop();
      capture = null;
      try {
        await handle.leave();
      } catch {
        /* already left */
      }
      try {
        await node.destroy();
      } catch {
        /* gone */
      }
      try {
        await (swarm as { destroy(): Promise<void> }).destroy();
      } catch {
        /* gone */
      }
    },
  };
}
