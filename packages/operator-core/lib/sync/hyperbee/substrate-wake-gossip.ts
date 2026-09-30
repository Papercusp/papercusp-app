/**
 * substrate-wake-gossip — the SWARM-PRESENCE half of the lazy-boot keepalive
 * (shared-hive-cross-machine-scale-10k-2026-06-29 P-012 slice B / WI-6071).
 *
 * WHY THIS EXISTS. substrate-eviction-policy's header has always described the
 * keepalive that makes eviction SAFE as "swarm presence + a LISTEN
 * substrate_outbox watch". Only the LISTEN half was ever built
 * (substrate-outbox-keepalive), which covers LOCAL writes. The swarm half —
 * hearing that a REMOTE member has something for us — did not exist, so the
 * boot layer fail-closed everywhere it mattered:
 *
 *   · gatherBootedHarnessFacts used to pin every `hasSwarm` handle;
 *   · evictBootedHarnessEngine used to refuse every swarmed handle;
 *   · boot-all used to pass `deferFederating:false` by default.
 *
 * Now boot-all defaults federating deferral ON and idle in-process swarmed
 * handles enter the eviction candidate set. Both paths still fail closed per
 * harness unless this keepalive actually covers the federation topic.
 *
 * The net effect: EVERY shared-hive harness is permanently resident, so the
 * plan's O(active hives) goal is unreachable no matter how good the LRU is.
 * There is, today, no state in the system where a topic is JOINED but the
 * engine is NOT. Creating that state is this module's entire job.
 *
 * WHAT IT IS. A process-wide gossip family over the shared swarm on its own
 * Protomux protocol, carrying one tiny frame type. A harness watched here is
 * joined to its hive's federation topic while holding NO corestore, NO
 * autobase, NO merge loop and NO announce channel — a few hundred bytes and a
 * DHT refresh timer instead of a resident engine. When a peer that joined the
 * same topic pairs (or writes), we hear a frame and hand the key back to the
 * caller, which re-boots the real engine through the EXISTING on-demand wake
 * path (takeWakeEligible → rebootOnAccess). The engine then does the actual
 * replication; nothing here ever touches hypercore data.
 *
 * WHY A PEER'S HELLO IS ITSELF A WAKE. D-005's dominating rule is "NEVER leave
 * a harness with an ACTIVE swarm peer un-replicated" — evicting one is the
 * EI-126 silent-divergence class. So "a member of this hive is online and
 * reachable RIGHT NOW" is already sufficient reason to bring the engine up; we
 * do not wait for it to prove it has content. `kind` distinguishes the two
 * sources for telemetry, and a future refinement can carry a watermark so a
 * hello with nothing new is ignorable — but the conservative direction (wake
 * on any peer contact) is the correct one to ship first.
 *
 * WHAT THIS SLICE DELIBERATELY DOES NOT DO — store-and-forward. If NO member
 * is online when a write happens, there is no one to gossip to, and this
 * module cannot help: the dark member learns nothing until some peer is
 * concurrently online again. That case is P-013's relay tier (its text: the
 * relay nodes "deliver the idle-member wake signal"), and P-012's own text ends
 * "Depends on the Phase 3 relay tier" for exactly this reason. Do not try to
 * fake it here — in particular NOT over the hive DIRECTORY topic, which (a) is
 * equally online-only, and (b) deliberately excludes private/unpublished hives,
 * so broadcasting "hive X has activity" there would leak private-hive metadata
 * to non-members.
 *
 * AUTHENTICITY — a deliberate v1 boundary, stated plainly. Unlike presence
 * frames (which mutate a PG projection and are therefore device-signed), a wake
 * frame's ONLY effect is "boot the local engine". Booting runs the full
 * existing admission path, so a forged frame cannot inject, read, or admit
 * anything — the real trust boundary is untouched. What a forger COULD do is
 * burn our CPU/RSS by repeatedly waking engines, and the frame is cheap to send
 * to anyone who knows the topic (which is derived from the hive pubkey, itself
 * membership-adjacent, not public). The proportionate control for a
 * resource-amplification vector is a rate limit, not a signature, so wakes are
 * cooled down per topic ({@link DEFAULT_WAKE_COOLDOWN_MS}). If wake frames ever
 * grow a side effect beyond "boot", they must be signed like presence frames.
 *
 * Pure over an injected `HyperswarmLike` (the same seam swarm.ts and
 * topic-gossip use), so every path here unit-tests against a fake swarm with no
 * DHT, no corestore and no engine.
 */

import { createTopicGossip, type TopicGossipHandle } from './topic-gossip';
import type { HyperswarmLike } from './swarm';

/** Protomux protocol id for the substrate wake exchange. Its own id (not the
 *  substrate announce protocol, not hive-presence) so the channel pairs — and
 *  can be joined — completely independently of a resident engine. */
export const SUBSTRATE_WAKE_PROTOCOL = 'papercusp/substrate-wake';

/** Wake frame schema version. */
export const WAKE_FRAME_VERSION = 1;

/**
 * Minimum gap between wakes fired for ONE topic. Bounds the boot amplification
 * an unauthenticated frame can cause (see the module header's authenticity
 * note) AND the ordinary thundering-herd case where several peers pair at once
 * — each pair sends its own hello, and one boot serves them all.
 */
export const DEFAULT_WAKE_COOLDOWN_MS = 30_000;

/** Why a wake frame was sent. Telemetry only — both wake. */
export type WakeFrameKind =
  /** Sent to a freshly-paired peer: "a member of this hive is online". */
  | 'hello'
  /** Broadcast by a live member after a local write reached its outbox. */
  | 'activity';

/** The wire frame. Kept minimal on purpose: it carries no hive identity, because
 *  the Protomux channel is keyed BY the hive topic — pairing is the scoping, so
 *  a frame can only ever arrive on the topic both ends joined. */
export interface SubstrateWakeFrame {
  v: number;
  kind: WakeFrameKind;
  /** Sender's epoch-ms clock. Diagnostics/freshness only — never trusted for
   *  ordering or admission (no clock here is authoritative). */
  ts: number;
}

/** One fired wake, handed to {@link SubstrateWakeGossipOpts.onWake}. */
export interface SubstrateWakeEvent {
  /** The boot-all handle-map key (workspace_id|harness_slug) to re-boot. */
  key: string;
  topicHex: string;
  frame: SubstrateWakeFrame;
}

export interface SubstrateWakeGossipOpts {
  /** The shared process swarm (getSharedSwarm()); a fake in tests. */
  swarm: HyperswarmLike;
  /**
   * Fired for each watched key that is currently DARK when a peer frame lands
   * on its topic. The caller re-boots through its own on-demand wake path;
   * this module never boots anything itself. Best-effort — a throw is swallowed
   * so one bad listener cannot break the gossip loop.
   */
  onWake: (event: SubstrateWakeEvent) => void;
  /**
   * True when this key's ENGINE is currently resident. Injected because the
   * handle map is boot-all's, not ours: a live engine is already replicating,
   * so its frames are noise and must not fire a wake. Defaults to "never
   * resident" (every frame wakes) — correct for a standalone/test wiring.
   */
  isResident?: (key: string) => boolean;
  /** Min ms between wakes for one topic. Default {@link DEFAULT_WAKE_COOLDOWN_MS}; 0 disables. */
  wakeCooldownMs?: number;
  /** Clock seam (tests). Default Date.now. */
  now?: () => number;
  /** Passed through to createTopicGossip — see its docs. */
  refreshMs?: number;
  fastWindowMs?: number;
  slowRefreshMs?: number;
  severedEscalationMs?: number;
}

export interface SubstrateWakeGossipHandle {
  /**
   * Start watching one harness's federation topic. Idempotent per key; joining
   * a topic another key already watches reuses the SAME topic join (one DHT
   * session, many keys — several harnesses can share one hive's topic).
   * Re-joining a key under a DIFFERENT topic (a re-key) moves it.
   */
  watch(key: string, topic: Buffer): void;
  /** Stop watching one key. Leaves the underlying topic only when no other
   *  watched key still maps to it. Idempotent. */
  unwatch(key: string): Promise<void>;
  /** Broadcast an `activity` frame on one watched key's topic — the live side
   *  of the exchange, called after a local write is captured. No-op for an
   *  unwatched key. */
  announceActivity(key: string): void;
  /** Leave every topic + tear down the gossip family. Idempotent. */
  close(): Promise<void>;
  /** Watched keys (diagnostics). */
  readonly watchedKeys: string[];
  /** Distinct topics joined (diagnostics). */
  readonly topicCount: number;
  /** The topic one key is watched under, if any (diagnostics). */
  topicHexFor(key: string): string | undefined;
  /** Live paired channels — for one topic, or all (diagnostics). */
  openChannelCount(topicHex?: string): number;
}

/**
 * Create the process's substrate-wake gossip family. One instance per process
 * (topics are added/removed through the handle), mirroring how directory-swarm
 * and presence-gossip each own one createTopicGossip instance.
 */
export function createSubstrateWakeGossip(
  opts: SubstrateWakeGossipOpts,
): SubstrateWakeGossipHandle {
  if (!opts.swarm) throw new Error('createSubstrateWakeGossip: swarm required');
  if (typeof opts.onWake !== 'function') {
    throw new Error('createSubstrateWakeGossip: onWake required');
  }

  const now = opts.now ?? (() => Date.now());
  const isResident = opts.isResident ?? (() => false);
  const cooldownMs = opts.wakeCooldownMs ?? DEFAULT_WAKE_COOLDOWN_MS;

  /** key → topicHex. The watched set. */
  const keyToTopic = new Map<string, string>();
  /** topicHex → the keys watching it (a hive topic can carry >1 local harness). */
  const topicToKeys = new Map<string, Set<string>>();
  /** topicHex → the Buffer we joined with (topic-gossip wants the Buffer to leave). */
  const topicBuffers = new Map<string, Buffer>();
  /** topicHex → last wake fired (the cooldown). */
  const lastWakeMs = new Map<string, number>();
  let closed = false;

  const frame = (kind: WakeFrameKind): SubstrateWakeFrame => ({
    v: WAKE_FRAME_VERSION,
    kind,
    ts: now(),
  });

  /** A frame is only actionable if it is shaped like one of ours. Everything
   *  else is dropped silently — a peer on a newer schema must never be able to
   *  throw into the gossip loop. */
  const isWakeFrame = (f: unknown): f is SubstrateWakeFrame => {
    if (!f || typeof f !== 'object') return false;
    const k = (f as { kind?: unknown }).kind;
    return k === 'hello' || k === 'activity';
  };

  const gossip: TopicGossipHandle<SubstrateWakeFrame> = createTopicGossip<SubstrateWakeFrame>({
    swarm: opts.swarm,
    protocol: SUBSTRATE_WAKE_PROTOCOL,
    name: 'createSubstrateWakeGossip',
    refreshLabel: 'substrate-wake-gossip-refresh',
    refreshMs: opts.refreshMs,
    fastWindowMs: opts.fastWindowMs,
    slowRefreshMs: opts.slowRefreshMs,
    severedEscalationMs: opts.severedEscalationMs,
    // A freshly-paired peer hears "someone for this hive is here". That IS the
    // wake signal for a dark peer on the other end (see the module header).
    getHelloFrames: () => [frame('hello')],
    onFrame: (f, topicHex) => {
      if (closed || !isWakeFrame(f)) return;
      const keys = topicToKeys.get(topicHex);
      if (!keys || keys.size === 0) return;
      // Dark keys only — a resident engine is already replicating this topic.
      const dark: string[] = [];
      for (const k of keys) {
        let resident = false;
        try {
          resident = isResident(k);
        } catch {
          // A throwing residency probe must not strand the wake: treat it as
          // dark. A redundant boot is cheap and idempotent; a missed one is the
          // divergence class this whole module exists to prevent.
          resident = false;
        }
        if (!resident) dark.push(k);
      }
      if (dark.length === 0) return;
      // Cooldown is per TOPIC, applied only once we know a wake would actually
      // fire — so a stream of frames arriving while every key is resident can
      // never consume the budget a genuinely dark key needs later.
      const t = now();
      if (cooldownMs > 0) {
        const last = lastWakeMs.get(topicHex);
        if (last != null && t - last < cooldownMs) return;
      }
      lastWakeMs.set(topicHex, t);
      for (const k of dark) {
        try {
          opts.onWake({ key: k, topicHex, frame: f });
        } catch {
          /* best-effort per key — one bad listener never breaks the rest */
        }
      }
    },
  });

  const detach = (key: string): string | null => {
    const prevHex = keyToTopic.get(key);
    if (!prevHex) return null;
    keyToTopic.delete(key);
    const keys = topicToKeys.get(prevHex);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) {
        topicToKeys.delete(prevHex);
        return prevHex; // caller leaves the now-unreferenced topic
      }
    }
    return null;
  };

  return {
    watch(key: string, topic: Buffer): void {
      if (closed) return;
      if (!key) throw new Error('createSubstrateWakeGossip.watch: key required');
      if (!topic || topic.length === 0) {
        throw new Error('createSubstrateWakeGossip.watch: topic required');
      }
      const topicHex = topic.toString('hex');
      const prevHex = keyToTopic.get(key);
      if (prevHex === topicHex) return; // already watched under this topic
      if (prevHex) {
        // A re-key: move the key, and drop the old topic if it is now orphaned.
        const orphaned = detach(key);
        if (orphaned) {
          topicBuffers.delete(orphaned);
          lastWakeMs.delete(orphaned);
          void gossip.leaveTopic(Buffer.from(orphaned, 'hex')).catch(() => {});
        }
      }
      keyToTopic.set(key, topicHex);
      let keys = topicToKeys.get(topicHex);
      if (!keys) {
        keys = new Set<string>();
        topicToKeys.set(topicHex, keys);
      }
      const first = keys.size === 0;
      keys.add(key);
      if (first) {
        topicBuffers.set(topicHex, topic);
        // joinTopic is idempotent + retro-opens the channel on existing sockets.
        gossip.joinTopic(topic);
      }
    },

    async unwatch(key: string): Promise<void> {
      const orphaned = detach(key);
      if (!orphaned) return;
      const buf = topicBuffers.get(orphaned) ?? Buffer.from(orphaned, 'hex');
      topicBuffers.delete(orphaned);
      lastWakeMs.delete(orphaned);
      try {
        await gossip.leaveTopic(buf);
      } catch {
        /* best-effort — a topic we can't leave is left to close() */
      }
    },

    announceActivity(key: string): void {
      if (closed) return;
      const topicHex = keyToTopic.get(key);
      if (!topicHex) return;
      try {
        gossip.broadcast(topicHex, frame('activity'));
      } catch {
        /* best-effort — gossip is never load-bearing for correctness */
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      keyToTopic.clear();
      topicToKeys.clear();
      topicBuffers.clear();
      lastWakeMs.clear();
      try {
        await gossip.close();
      } catch {
        /* best-effort */
      }
    },

    get watchedKeys(): string[] {
      return [...keyToTopic.keys()];
    },

    get topicCount(): number {
      return topicToKeys.size;
    },

    topicHexFor(key: string): string | undefined {
      return keyToTopic.get(key);
    },

    openChannelCount(topicHex?: string): number {
      return gossip.openChannelCount(topicHex);
    },
  };
}
