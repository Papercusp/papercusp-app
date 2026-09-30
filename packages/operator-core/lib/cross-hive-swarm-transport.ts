/**
 * cross-hive-swarm-transport — the LIVE CrossHiveTransport adapter
 * (cross-hive-boundary-2026-06-08 P-006). Implements the injectable
 * `CrossHiveTransport` PORT (cross-hive-transport.ts) over the shared Hyperswarm,
 * so a directed Hive→Hive envelope is delivered cross-machine over the real
 * public DHT — `send` dials a peer Hive by PUBKEY, `subscribe` listens on OUR
 * Hive's topic.
 *
 * Mirrors directory-swarm.ts exactly (a dedicated Protomux protocol over the
 * shared swarm, NO corestore replication — there is nothing to replicate, just
 * signed envelopes to pass). The sovereignty boundary is preserved: we never
 * replicate a peer Hive's cores; we only open the `papercusp/cross-hive` channel
 * and exchange envelopes that the receiver still admits per its own grants
 * (receiveCrossHive → admitCrossHiveEnvelope).
 *
 * Addressing: on channel pair each side sends a HELLO carrying its own Hive
 * pubkey, so `send(toHivePubkey, env)` routes the envelope to ONLY the channel
 * whose remote is that Hive — never a broadcast that leaks an A→B envelope to a
 * third connected Hive C. A Hive is SERVER on its own topic (reachable) and
 * CLIENT on a peer's topic it dials.
 *
 * Pure over an injected `HyperswarmLike` + `deriveTopic` (the same seams swarm.ts
 * / directory-swarm.ts use), so the dial/pair/hello/send/receive lifecycle
 * unit-tests with a fake swarm + fake Protomux, and runs live over a real
 * Hyperswarm in the cross-machine E2E.
 */
import Protomux from 'protomux';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import c from 'compact-encoding';
import type { HyperswarmLike } from './sync/hyperbee/swarm';
import { deriveHiveFederationTopic } from './sync/hyperbee/derive-swarm-topic';
import type { CrossHiveTransport, CrossHiveWireEnvelope } from './cross-hive-transport';

/** Protomux protocol id for the cross-Hive envelope exchange. */
export const CROSS_HIVE_PROTOCOL = 'papercusp/cross-hive';

/**
 * A wire frame on the cross-hive channel: a HELLO (announce my Hive pubkey, so
 * the peer can route addressed envelopes to me) or an ENV (a signed envelope).
 */
type CrossHiveFrame =
  | { t: 'hello'; hivePubkey: string }
  | { t: 'env'; env: CrossHiveWireEnvelope };

interface OpenChannel {
  send(frame: CrossHiveFrame): void;
  /** The remote Hive's pubkey, learned from its HELLO (null until it arrives). */
  remotePubkey: string | null;
}

export interface SwarmCrossHiveTransportOpts {
  /** The shared process swarm (getSharedSwarm()); a fake in tests. */
  swarm: HyperswarmLike;
  /** THIS Hive's pubkey (base64). We join its topic as SERVER so peers can dial us. */
  selfHivePubkey: string;
  /** Topic derivation (default deriveHiveFederationTopic). Injected for tests. */
  deriveTopic?: (hivePubkeyBase64: string) => Buffer;
  /** How long send() waits for a paired channel to the target Hive (default 5000ms). */
  sendWaitMs?: number;
  /** Poll cadence while waiting for a channel (default 50ms). */
  pollMs?: number;
  /**
   * Background FAST re-announce cadence (default 2500ms). The transport
   * periodically re-runs each joined topic's DHT announce+lookup round
   * (discovery.refresh()) so BOTH a receiver (re-announcing its topic) and a
   * sender (re-driving its lookup) stay continuously discoverable — the first
   * rounds after a join reliably miss. 0 disables the background loop.
   */
  reannounceMs?: number;
  /** How long the fast cadence runs after a topic join before backing off
   *  (default 30s). send() still refreshes unconditionally while dialing. */
  fastWindowMs?: number;
  /** Steady-state keepalive cadence after the fast window (default 60s). */
  slowRefreshMs?: number;
  /**
   * Fired when a channel's HELLO identifies the remote Hive — i.e. a peer Hive
   * just became reachable (connect OR reconnect). The boot wiring uses it to
   * force-drain that peer's durable outbox (hive-network-surface-2026-06-11
   * P-001). Best-effort: a throwing callback is swallowed.
   */
  onPeerHello?: (hivePubkey: string) => void;
}

export interface SwarmCrossHiveTransport extends CrossHiveTransport {
  /** Leave every joined topic + detach the connection handler. Idempotent. */
  close(): Promise<void>;
  /** Connections seen since construction (diagnostics). */
  readonly connectionCount: number;
  /** Currently-open (paired) cross-hive channels (diagnostics). */
  readonly openChannelCount: number;
  /** Hex of our own Hive topic (diagnostics). */
  readonly selfTopicHex: string;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Build a live CrossHiveTransport over the shared swarm. Construction joins our
 * own Hive topic (server+client) and registers the connection handler, so we are
 * immediately reachable; `subscribe` sets the inbound handler (buffered until
 * then); `send` dials the target Hive's topic (client) and pushes the envelope to
 * the matching channel.
 */
export function makeSwarmCrossHiveTransport(opts: SwarmCrossHiveTransportOpts): SwarmCrossHiveTransport {
  if (!opts.swarm) throw new Error('makeSwarmCrossHiveTransport: swarm required');
  if (!opts.selfHivePubkey) throw new Error('makeSwarmCrossHiveTransport: selfHivePubkey required');
  const deriveTopic = opts.deriveTopic ?? deriveHiveFederationTopic;
  const sendWaitMs = opts.sendWaitMs ?? 5000;
  const pollMs = opts.pollMs ?? 50;
  const reannounceMs = opts.reannounceMs ?? 2500;
  const fastWindowMs = opts.fastWindowMs ?? 30_000;
  const slowRefreshMs = opts.slowRefreshMs ?? 60_000;

  const channels = new Set<OpenChannel>();
  interface JoinedTopic {
    discovery: { refresh?: (o?: object) => unknown } | undefined;
    fastWindowStartMs: number;
    lastRefreshMs: number;
  }
  const joined = new Map<string, JoinedTopic>(); // topicHex → discovery + cadence state
  let inbound: ((env: CrossHiveWireEnvelope) => void | Promise<unknown>) | null = null;
  const inboundBuffer: CrossHiveWireEnvelope[] = [];
  let connectionCount = 0;

  const deliver = (env: CrossHiveWireEnvelope): void => {
    if (inbound) void Promise.resolve(inbound(env)).catch(() => {});
    else inboundBuffer.push(env); // received before subscribe() → flush on subscribe
  };

  /** Open the cross-hive channel on one connection's muxer (best-effort). */
  const openChannel = (socket: unknown): void => {
    try {
      const mux = Protomux.from(socket);
      const oc: OpenChannel = { send: () => {}, remotePubkey: null };
      let message: { send(v: CrossHiveFrame): void } | null = null;
      const channel = mux.createChannel({
        protocol: CROSS_HIVE_PROTOCOL,
        onopen: () => {
          channels.add(oc);
          // Announce our identity so the peer can route addressed envelopes to us.
          try {
            message?.send({ t: 'hello', hivePubkey: opts.selfHivePubkey });
          } catch {
            /* best-effort */
          }
        },
        onclose: () => {
          channels.delete(oc);
        },
      });
      if (!channel) return; // already open on this muxer (duplicate) — nothing to do
      message = channel.addMessage<CrossHiveFrame>({
        encoding: c.json,
        onmessage: (frame: CrossHiveFrame) => {
          if (!frame || typeof frame !== 'object') return;
          if (frame.t === 'hello' && typeof frame.hivePubkey === 'string') {
            oc.remotePubkey = frame.hivePubkey;
            try {
              opts.onPeerHello?.(frame.hivePubkey);
            } catch {
              /* best-effort — a reconnect hook must never break the channel */
            }
            return;
          }
          if (frame.t === 'env' && frame.env && typeof frame.env === 'object') {
            deliver(frame.env);
          }
        },
      });
      oc.send = (frame: CrossHiveFrame) => {
        try {
          message!.send(frame);
        } catch {
          /* best-effort */
        }
      };
      channel.open();
    } catch {
      // The channel is best-effort; a peer that can't speak it is ignored.
    }
  };

  const handler = (socket: unknown): void => {
    connectionCount++;
    openChannel(socket);
  };

  // Join a Hive topic as BOTH server + client. Cross-Hive rendezvous is the
  // recipient's topic: the recipient is always server there, and a sender joins
  // it too — both announce + look up so mutual discovery is reliable (a
  // client-only sender connects unreliably over the DHT). Announcing on a peer's
  // topic is not an impersonation: every connection still Noise-handshakes our
  // own key and our HELLO carries our real pubkey; addressing is still validated
  // by the receiver, so a stray connection mis-delivers nothing.
  //
  // CRITICAL: discovery is driven by a per-topic `discovery.refresh()` LOOP —
  // empirically the ONLY driver that connects a standalone (non-corestore)
  // transport on the current hyperswarm/hyperdht. The first announce/lookup
  // round after `join` reliably misses (fresh DHT node) and nothing internal
  // retries for minutes; `discovery.flushed()` and swarm-level `swarm.flush()`
  // (this transport's ORIGINAL driver — since rotted) never form a connection.
  // Verified on a loopback testnet: join + refresh-loop connects in ~1.1s; join
  // + flushed / flush(-loop) / dht.ready()+join all sit at 0 connections.
  // See directory-swarm.ts (the same driver) + its live two-peer test.
  const ensureJoined = (topic: Buffer): void => {
    const hex = topic.toString('hex');
    if (joined.has(hex)) return;
    joined.set(hex, {
      discovery: opts.swarm.join(topic, { server: true, client: true }) as JoinedTopic['discovery'],
      fastWindowStartMs: Date.now(),
      lastRefreshMs: 0,
    });
  };

  /** Re-run every joined topic's DHT announce + lookup round (best-effort).
   *  UNCONDITIONAL — used by send()'s dial loop + subscribe(), where the caller
   *  actively needs convergence now. The background timer applies the two-speed
   *  cadence itself. */
  const refreshAll = async (): Promise<void> => {
    const now = Date.now();
    await Promise.all(
      [...joined.values()].map(async (t) => {
        t.lastRefreshMs = now;
        try {
          await t.discovery?.refresh?.();
        } catch {
          /* best-effort per topic */
        }
      }),
    );
  };

  // Reachable immediately: register the handler + join our own topic (server) so
  // peers can dial us; the refresh loop announces it on the DHT.
  opts.swarm.on('connection', handler);
  const selfTopic = deriveTopic(opts.selfHivePubkey);
  ensureJoined(selfTopic);

  // Keep BOTH sides continuously discoverable: a periodic per-topic refresh
  // re-runs each topic's announce + lookup round, so a sender and a receiver
  // converge even when a round is missed. Cleared on close.
  let reannounceTimer: ManagedHandle | null = null;
  if (reannounceMs > 0) {
    reannounceTimer = managedSetInterval('cross-hive-reannounce', reannounceMs, () => {
      const now = Date.now();
      for (const t of joined.values()) {
        const inFastWindow = now - t.fastWindowStartMs < fastWindowMs;
        const slowDue = now - t.lastRefreshMs >= slowRefreshMs;
        if (!inFastWindow && !slowDue) continue;
        t.lastRefreshMs = now;
        try {
          void Promise.resolve(t.discovery?.refresh?.()).catch(() => {});
        } catch {
          /* best-effort per topic */
        }
      }
    }, { category: 'lifecycle', instanced: true });
  }

  return {
    selfTopicHex: selfTopic.toString('hex'),
    get connectionCount() {
      return connectionCount;
    },
    get openChannelCount() {
      return channels.size;
    },

    subscribe(handlerFn: (env: CrossHiveWireEnvelope) => Promise<void>): void {
      inbound = handlerFn;
      // Flush anything that arrived before we had a handler.
      const buffered = inboundBuffer.splice(0);
      for (const env of buffered) void Promise.resolve(handlerFn(env)).catch(() => {});
      // Now that we're listening, (re)announce our self-topic so senders find us.
      void refreshAll();
    },

    async send(toHivePubkey: string, env: CrossHiveWireEnvelope): Promise<void> {
      // Rendezvous on the target Hive's topic (it is server there; we join too).
      ensureJoined(deriveTopic(toHivePubkey));
      const targets = (): OpenChannel[] => [...channels].filter((ch) => ch.remotePubkey === toHivePubkey);
      // Wait for the channel to the target to pair + exchange HELLOs, driving a
      // per-topic discovery.refresh() round each iteration — the refresh is what
      // re-runs announce+lookup until the connection forms (the first round
      // after join reliably misses; see the driver note above ensureJoined).
      const start = Date.now();
      while (targets().length === 0 && Date.now() - start < sendWaitMs) {
        await refreshAll();
        if (targets().length > 0) break;
        await delay(pollMs);
      }
      const t = targets();
      if (t.length === 0) {
        throw new Error(
          `cross-hive: no paired channel to Hive ${toHivePubkey.slice(0, 8)}… within ${sendWaitMs}ms`,
        );
      }
      for (const ch of t) ch.send({ t: 'env', env });
    },

    async close(): Promise<void> {
      if (reannounceTimer) {
        reannounceTimer.stop();
        reannounceTimer = null;
      }
      if (opts.swarm.off) opts.swarm.off('connection', handler);
      channels.clear();
      for (const hex of joined.keys()) {
        try {
          await opts.swarm.leave(Buffer.from(hex, 'hex'));
        } catch {
          /* leaving a non-joined topic is a no-op */
        }
      }
      joined.clear();
    },
  };
}
