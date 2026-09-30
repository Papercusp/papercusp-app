/**
 * voice-mesh-child.ts — one symmetric voice-mesh peer for the P-014 measurement
 * (holepunch-voice-channels-2026-06-05; runbook brief12 §4; WI-101).
 *
 * Unlike peer-child.ts (writer/reader substrate replication), every voice peer
 * is identical: join ONE voice channel over a real Hyperswarm + real Opus
 * (the production `@papercusp/p2p-voice` core + `getOpusCodec()` — the exact
 * stack `voice-node/manager.ts` runs), push a 20ms tone frame cadence, and
 * record wall-clock send/receive times per remote peer.
 *
 * The mouth-to-ear number this child yields is pushMic(sender) →
 * onPeerFrame(receiver): Opus encode + wire + Opus decode, BEFORE the playout
 * mix (the mixer adds ≤ frameMs on top). Frames ride ordered, reliable Noise
 * streams, so the k-th received frame from a peer IS that peer's k-th sent
 * frame — arrival-order counting aligns the two timelines with no in-band
 * timestamps (Opus is lossy; embedded timestamps would not survive).
 *
 * ndjson protocol (same shape as peer-child.ts, driven by PeerChildHandle):
 *   out:  {evt:'ready', id}                — node up, channel announced
 *         {evt:'mesh-ready', tMs, peers}   — saw all `peers-1` remote peers
 *         {evt:'pong', tRemote}            — clock probe reply
 *         {evt:'send-done', sent}          — finished the frame schedule
 *         {evt:'result', …}                — final measurements (on `stop`)
 *         {evt:'error', message}           — fatal; exit 1
 *   in:   `ping` | `go` | `stop`
 *
 * Config via $VOICE_MESH_CHILD (JSON) — SSH cannot forward arbitrary env, so
 * the launcher inlines it, exactly like P2P_PERF_CHILD.
 */

import { createVoiceNode, type DuplexLike, type SwarmLike } from '@papercusp/p2p-voice';
import { getOpusCodec, VOICE_FRAME_SAMPLES } from '../../voice-node/codec';

export interface VoiceMeshChildConfig {
  peerIndex: number;
  /** Total mesh size — this child waits for `peers - 1` remote peers. */
  peers: number;
  /** Shared 32-byte channel topic (hex). */
  topicHex: string;
  /** Frames to send after `go` (20ms each → frames×20ms of audio). */
  frames: number;
  /** Send cadence (default 20 — the production voice frame). */
  frameMs?: number;
  /** Local-testnet DHT bootstrap. ABSENT → the PUBLIC DHT (real frames). */
  bootstrap?: Array<{ host: string; port: number }>;
}

export interface VoiceMeshChildResult {
  evt: 'result';
  peerIndex: number;
  id: string;
  framesSent: number;
  /** Wall-clock ms of each pushMic, in order. */
  sendTimes: number[];
  /** Per-remote-peer wall-clock ms of each onPeerFrame, in arrival order. */
  recv: Record<string, number[]>;
  /** Raw bytes in/out across all swarm connections (mesh bandwidth). */
  bytesIn: number;
  bytesOut: number;
  /** Boot → all peers visible (ms). Null = mesh never completed. */
  meshReadyMs: number | null;
  peersSeen: string[];
  cpu: { userMs: number; systemMs: number };
  rssPeakBytes: number;
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Minimal async line reader over stdin (mirrors peer-child.ts). */
function createLineReader(): { next(): Promise<string | null> } {
  let buf = '';
  const queue: string[] = [];
  let resolveWait: ((v: string | null) => void) | null = null;
  let eof = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (resolveWait) {
        resolveWait(line);
        resolveWait = null;
      } else queue.push(line);
    }
  });
  process.stdin.on('end', () => {
    eof = true;
    if (resolveWait) {
      resolveWait(null);
      resolveWait = null;
    }
  });
  return {
    next(): Promise<string | null> {
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (eof) return Promise.resolve(null);
      return new Promise((r) => {
        resolveWait = r;
      });
    },
  };
}

/** One 20ms 440Hz tone frame — realistic non-silent audio for Opus. */
function toneFrame(samples: number): Int16Array {
  const f = new Int16Array(samples);
  for (let i = 0; i < samples; i++) f[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
  return f;
}

async function main(): Promise<void> {
  const cfg = JSON.parse(process.env.VOICE_MESH_CHILD ?? '{}') as VoiceMeshChildConfig;
  if (!cfg.topicHex || !cfg.peers) throw new Error('voice-mesh-child: VOICE_MESH_CHILD config missing');
  const frameMs = cfg.frameMs ?? 20;
  const bootT0 = Date.now();

  let bytesIn = 0;
  let bytesOut = 0;
  let rssPeak = process.memoryUsage().rss;
  const rssTimer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > rssPeak) rssPeak = rss;
  }, 250);
  rssTimer.unref();

  const { default: Hyperswarm } = (await import('hyperswarm')) as unknown as {
    default: new (o?: unknown) => SwarmLike & { destroy(): Promise<void> };
  };
  const swarm = new Hyperswarm(
    cfg.bootstrap && cfg.bootstrap.length ? { bootstrap: cfg.bootstrap } : undefined,
  );

  // Byte-counting facade: same SwarmLike surface, with every connection's
  // write/data instrumented. The voice core sees the wrapped duplex only.
  const cbMap = new Map<(c: DuplexLike, i?: unknown) => void, (c: DuplexLike, i?: unknown) => void>();
  const countingSwarm: SwarmLike = {
    join: (t, o) => swarm.join(t, o),
    leave: (t) => swarm.leave(t),
    on(ev, cb) {
      const wrapped = (conn: DuplexLike, info?: unknown) => {
        const counted = {
          write(d: Uint8Array) {
            bytesOut += d.byteLength;
            return conn.write(d);
          },
          on(event: 'data' | 'error' | 'close', cb2: unknown) {
            if (event === 'data') {
              const dataCb = cb2 as (chunk: Uint8Array) => void;
              return conn.on('data', (chunk: Uint8Array) => {
                bytesIn += chunk.byteLength;
                dataCb(chunk);
              });
            }
            return conn.on(event, cb2 as (err?: unknown) => void);
          },
          destroy: (e?: unknown) => conn.destroy(e),
        } as DuplexLike;
        cb(counted, info);
      };
      cbMap.set(cb, wrapped);
      return swarm.on(ev, wrapped);
    },
    off(ev, cb) {
      const wrapped = cbMap.get(cb);
      return swarm.off?.(ev, wrapped ?? cb);
    },
  };

  const codec = await getOpusCodec();
  const id = `peer-${cfg.peerIndex}`;
  const node = createVoiceNode({ swarm: countingSwarm, codec, identity: { id, label: id } });
  const channel = node.joinChannel(cfg.topicHex);

  const sendTimes: number[] = [];
  const recv: Record<string, number[]> = {};
  channel.onPeerFrame((peerId) => {
    (recv[peerId] ??= []).push(Date.now());
  });

  let meshReadyMs: number | null = null;
  const meshReady = new Promise<void>((resolve) => {
    const check = () => {
      if (channel.peers().length >= cfg.peers - 1 && meshReadyMs === null) {
        meshReadyMs = Date.now() - bootT0;
        out({ evt: 'mesh-ready', tMs: meshReadyMs, peers: channel.peers().length });
        resolve();
      }
    };
    channel.onPeersChanged(check);
    check();
  });

  await channel.announced();

  // Standalone-hyperswarm discovery gotcha (see the hyperswarm-discovery
  // insight + directory-swarm.ts): N fresh processes joining one topic
  // simultaneously can each announce AFTER the others' lookup pass — and a
  // quiet swarm never re-queries, so the mesh silently never forms. Re-join
  // returns the SAME PeerDiscovery session; drive its refresh() until the
  // full mesh is visible, then stop (keeps the measurement window clean).
  const discovery = swarm.join(Buffer.from(cfg.topicHex, 'hex'), {
    server: true,
    client: true,
  }) as { refresh?: (o?: { client?: boolean; server?: boolean }) => unknown };
  const refreshTimer = setInterval(() => {
    try {
      void discovery.refresh?.({ client: true, server: true });
    } catch {
      /* discovery torn down */
    }
  }, 2_000);
  refreshTimer.unref();
  void meshReady.then(() => clearInterval(refreshTimer));

  out({ evt: 'ready', id });

  const frame = toneFrame(VOICE_FRAME_SAMPLES);
  const stdinLines = createLineReader();

  for (;;) {
    const line = await stdinLines.next();
    if (line === null || line === 'stop') break;
    if (line === 'ping') {
      out({ evt: 'pong', tRemote: Date.now() });
      continue;
    }
    if (line === 'go') {
      // Absolute schedule (drift-corrected) — the per-frame send time is
      // recorded regardless, so cadence jitter never corrupts the metric.
      let next = Date.now();
      for (let k = 0; k < cfg.frames; k++) {
        next += frameMs;
        const wait = next - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        sendTimes.push(Date.now());
        channel.pushMic(frame);
      }
      out({ evt: 'send-done', sent: sendTimes.length });
    }
  }

  const cpu = process.cpuUsage();
  const result: VoiceMeshChildResult = {
    evt: 'result',
    peerIndex: cfg.peerIndex,
    id,
    framesSent: sendTimes.length,
    sendTimes,
    recv,
    bytesIn,
    bytesOut,
    meshReadyMs,
    peersSeen: channel.peers().map((p) => p.id),
    cpu: { userMs: cpu.user / 1000, systemMs: cpu.system / 1000 },
    rssPeakBytes: rssPeak,
  };
  out(result);

  try {
    await channel.leave();
    await node.destroy();
    await swarm.destroy();
    codec.dispose();
  } catch {
    /* teardown best-effort — the result is already out */
  }
  process.exit(0);
}

main().catch((e) => {
  out({ evt: 'error', message: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
