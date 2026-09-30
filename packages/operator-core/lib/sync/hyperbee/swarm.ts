/**
 * Hyperswarm join + corestore.replicate plumbing for one harness.
 *
 * Plan: this loop's final substrate piece. The bootHarnessSubstrate
 * comment ("Hyperswarm replication setup [...] intentionally
 * separated") finally getting unwound. Without this, the substrate
 * runs single-engineer-only — local writes federate via the in-
 * process Autobase but never reach another machine.
 *
 * What this does:
 *   1. Constructs a Hyperswarm instance (singleton-per-process via a
 *      shared module-level handle — Hyperswarm is heavy, costs ~50ms
 *      to instantiate, and one swarm can join many topics).
 *   2. Joins the harness's topic (server + client).
 *   3. On every `connection` event, pipes the peer socket through
 *      `corestore.replicate(socket)` so the harness's Hypercores
 *      exchange data with the peer.
 *   4. Returns a handle with `close()` that leaves the topic + drops
 *      the per-harness connection listener (NOT destroying the
 *      shared swarm — other harnesses may still need it).
 *
 * Pure-injectable: the swarm factory + corestore + topic are all
 * parameters so unit tests can fully exercise the join/leave/connect
 * cascade without touching the network. The runtime caller pins the
 * factory to `new Hyperswarm()` from the real module.
 */

import type Corestore from 'corestore';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import Protomux from 'protomux';
import c from 'compact-encoding';
import { getSwarmGuard, type SwarmGuard } from './swarm-guard';
import { getResourceProfile } from '../../resource-profile';
import type { SignedAnnounce } from './announce';
import type { AdmissionResult } from './read-admission';
import { wireHiveGitServe, type PotGitServeConfig } from '../pot-git/serve-wiring';
import { wireHiveGitDial, resolveVerifiedDevicePubkeyForSocket } from '../pot-git/peer-dial-registry';
import { loadOrGenerateSwarmSeed } from '../../identity/swarm-keypair';
import {
  readWireStats,
  dataPathProven,
  SocketInboundLedger,
  DEFAULT_SOCKET_LIVENESS_WINDOW_MS,
  type PeerWireStats,
} from './wire-stats';

/** Protomux protocol id for the signed-announce exchange (Model B Stage 4b).
 *  Exported for the A-002 multi-hive demonstrator test. */
export const ANNOUNCE_PROTOCOL = 'papercusp/announce';

export interface SwarmHandle {
  /** Leave the topic + detach this harness's connection handler.
   * Idempotent. Does NOT destroy the shared swarm. */
  close(): Promise<void>;
  /** Hex topic, for diagnostics + the substrate dashboard. */
  topicHex: string;
  /** Number of times the connection handler has fired since join. */
  connectionCount: number;
  /**
   * Number of currently-OPEN peer connections on this handle (incremented on
   * connect, decremented on socket close). Feeds the replication-liveness
   * `connected_never_replicated` axis (WI-183/WI-1840): swarm-level
   * connectivity is the discriminator between "peer offline" (never alarms)
   * and "connected-but-dead replication" (the zombie-connection class).
   */
  liveConnectionCount: number;
  /**
   * EI-13317 rung (b): force a fresh topic leave()+join() NOW (a new discovery
   * session/DHT announce), bypassing the severed-link timer. Extracted from
   * the escalation ladder's own leave+rejoin action (below) so an EXTERNAL
   * repair escalation can invoke the identical recovery lever.
   *
   * Motivating case (gate run 050615, forensics on EI-13317): a "live-socket,
   * dead-replication" failure — the swarm topic re-pairs repeatedly
   * (`connection` keeps firing, `liveConnectionCount` never sits at 0) while a
   * specific admitted log's content replication never (re-)attaches. Rung
   * (a)'s `severedEscalationMs` trigger is `connectionCount > 0 &&
   * liveConnectionCount === 0` — structurally blind to this case. Wired as
   * the escalation boot.ts's WI-3684 repair-on-detect reaches for once its
   * per-log SESSION re-attach budget (`REPAIR_MAX_ATTEMPTS_PER_LOG`) is
   * exhausted and the log has re-stalled anyway: a session-level re-attach
   * alone didn't fix it, so force the heavier topic-level rejoin.
   *
   * Best-effort + idempotent-safe: concurrent/rapid calls just re-run
   * leave+join (Hyperswarm treats a re-leave/re-join of the same topic as
   * safe); the caller is expected to rate-limit its OWN triggering (this
   * method applies none itself — it is a raw lever, not a policy).
   */
  forceRejoin(): Promise<void>;
  /**
   * Re-send this harness's signed announce on every currently-open peer
   * connection, rebuilding it first so `log_length` reflects the latest own-log
   * append. Receivers use that verified high-water to distinguish caught-up from
   * attached-but-frozen replication and drive repair-on-detect.
   *
   * Optional for structural test/sidecar handles that predate writer-progress
   * announces. The production `joinHarnessSwarm` handle always implements it.
   */
  refreshAnnounce?(): void;
  /**
   * EI-18682571591024156: per-live-socket DATA-PATH evidence for this topic —
   * hyperdht's signalling outcome plus the UDX wire counters, with an explicit
   * tri-state `proven`.
   *
   * This is what a UI or health check should read instead of counting
   * `onPeerConnected` fires: `connectionCount`/`liveConnectionCount` and
   * `peer_connected` all measure SIGNALLING, so a peer whose data path never
   * came up reports "connected" forever. `proven: false` here means the counters
   * were readable and NO bytes have arrived — a live socket that is not carrying
   * data.
   */
  dataPathSnapshot(): DataPathSnapshotEntry[];
}

/** EI-13317: one topic's severed-link escalation event, carried by
 *  {@link JoinHarnessSwarmOpts.onSeveredLink}. */
export interface SeveredLinkInfo {
  /** Hex topic that tripped the escalation. */
  topicHex: string;
  /** How long (ms) the topic had zero live peers before escalating. */
  severedMs: number;
}

/** EI-18662944242304583: one topic's pre-admission (never-paired) escalation
 *  event, carried by {@link JoinHarnessSwarmOpts.onUnpairedLink}. */
export interface UnpairedLinkInfo {
  /** Hex topic that tripped the escalation. */
  topicHex: string;
  /** How long (ms) since the FIRST announce-channel open attempt on it. */
  unpairedMs: number;
  /** Announce-channel open attempts made without a single pairing. */
  attempts: number;
}

/**
 * WI-6063: one topic's share of the process-global peer budget, as seen by the
 * fairness evaluator. Carried on {@link PeerCapInfo.topics} so the near-cap
 * signal answers "WHICH topics are holding the budget" — previously it reported
 * only a total (`245/256`), which named the pressure without naming the cause.
 */
export interface TopicPeerShare {
  /** The topic this share describes. */
  topicHex: string;
  /** Live peers this topic is actually content-replicating with — see
   *  {@link contentPeerCountForTopic}. Counts INBOUND peers as well as dialled
   *  ones (announce-channel pairing is symmetric). */
  peers: number;
  /** The per-topic allowance in force at this evaluation (see
   *  {@link evaluateSwarmFairness}); `null` when fairness is not engaged, i.e.
   *  the budget is not under pressure and no topic is being held back. */
  fairShare: number | null;
  /** True while this topic's OUTBOUND dialling is paused because it holds more
   *  than its fair share. Its announce (server) side stays up throughout, so it
   *  still accepts inbound peers. */
  dialPaused: boolean;
}

/** Snapshot of the shared swarm's peer-budget pressure at a near-cap crossing
 *  (P-004). Carried by {@link JoinHarnessSwarmOpts.onNearPeerCap}. */
export interface PeerCapInfo {
  /** Live peer connections on the shared swarm at the moment of the signal. */
  liveConnections: number;
  /** The process-global `maxPeers` ceiling the swarm was constructed with. */
  maxPeers: number;
  /** True once `liveConnections` has actually REACHED the ceiling — Hyperswarm
   *  will now silently refuse further peers until a slot frees. */
  atCap: boolean;
  /**
   * WI-6063: per-topic breakdown of who holds the budget, when the fairness
   * registry knows about any topics on this swarm (absent on minimal test fakes
   * and before any join registers). The whole harm this signal exists to expose
   * is one topic monopolising a shared ceiling, so reporting the total WITHOUT
   * the breakdown states the symptom and withholds the diagnosis.
   */
  topics?: readonly TopicPeerShare[];
}

/**
 * WI-6063: an edge-triggered change in one topic's outbound-dial permission.
 * Emitted only on a TRANSITION (pause↔resume), never per-tick, so it can be
 * recorded durably without spamming. Carried by
 * {@link JoinHarnessSwarmOpts.onTopicDialThrottle}.
 */
export interface TopicDialThrottleInfo {
  /** The topic whose dialling just changed. */
  topicHex: string;
  /** True = dialling was just PAUSED (topic is over its share); false = RESUMED. */
  paused: boolean;
  /** This topic's live content-replication peer count at the transition. */
  peers: number;
  /** The per-topic allowance that triggered the transition. */
  fairShare: number;
  /** Live connections / ceiling on the shared swarm at the transition. */
  liveConnections: number;
  maxPeers: number;
  /** How many topics were sharing the budget when the allowance was computed. */
  topicCount: number;
}

/**
 * Minimal Hyperswarm-like surface — matches the holepunch.d.ts shim.
 * Lets us test without depending on the real module.
 */
export interface HyperswarmLike {
  join(
    topic: Buffer,
    opts?: { server?: boolean; client?: boolean },
  ): {
    flushed?: () => Promise<void>;
    /** Re-run the topic's DHT announce + lookup round. The ONLY driver that
     *  reliably connects a standalone (non-corestore) transport — see
     *  directory-swarm.ts's module header. */
    refresh?: (opts?: object) => unknown;
    /**
     * WI-5923: the REFCOUNTED per-caller teardown a real Hyperswarm `join()`
     * returns (`PeerDiscoverySession.destroy()` — hyperswarm/lib/peer-
     * discovery.js). Decrements this session's share of the underlying
     * PeerDiscovery and only actually leaves the topic (`swarm.leave`
     * internally) once EVERY session on it has destroyed. `close()` below
     * prefers this over the process-wide `swarm.leave(topic)` precisely so
     * one harness closing its join can never destroy a SIBLING harness's still-
     * live session on the same (per-Hive) topic. Optional because a minimal
     * test fake's `join()` may not return one — `close()` falls back to
     * `swarm.leave` in that case, unchanged from before.
     */
    destroy?: () => Promise<void> | void;
  };
  leave(topic: Buffer): Promise<void> | void;
  on(event: 'connection', listener: (socket: unknown, info?: unknown) => void): unknown;
  off?(event: 'connection', listener: (socket: unknown, info?: unknown) => void): unknown;
  /** Live peer sockets (real Hyperswarm exposes a Set). A topic joined on a
   *  shared swarm AFTER a socket exists never re-emits 'connection' for it, so
   *  late joiners must attach to these retroactively. */
  connections?: Iterable<unknown>;
  /** The process-global total-connection ceiling this swarm was constructed with
   *  (Hyperswarm stores its `maxPeers` here). Read for the near-cap pressure
   *  signal (P-004); undefined on minimal test fakes. */
  maxPeers?: number;
}

export interface JoinHarnessSwarmOpts {
  /** The harness's per-corestore (one per harness, shared with Autobase). */
  store: Corestore;
  /** 32-byte topic — derive via `deriveSwarmTopic`. */
  topic: Buffer;
  /** Test seam: supply a swarm; runtime wrapper auto-instantiates. */
  swarm: HyperswarmLike;
  /**
   * Hook fires every time a peer completes the Noise handshake + is wired for
   * replication. Receives the peer's Noise public key (hex) when Hyperswarm
   * surfaces it (P-002), plus (EI-18682571591024156) a {@link PeerSignallingInfo}
   * describing WHAT WAS ACTUALLY PROVEN.
   *
   * ⚠ THIS IS SIGNALLING SUCCESS, NOT A WORKING CONNECTION. hyperdht completes
   * the handshake as a DHT RPC and hands `secret-stream` an already-finished
   * session over a UDX stream that has carried ZERO bytes, so this fires
   * identically for a connection that works and one that will send 4.9KB,
   * receive nothing, and die on RTO exhaustion 13s later. `info.signallingOnly`
   * is always `true` and `info.dataPathProven` is the honest tri-state (`null`
   * here by construction). A UI or health check that renders "peer connected"
   * off this alone can be showing a permanently false state — read
   * {@link SwarmHandle.dataPathSnapshot} for demonstrated data paths instead.
   */
  onPeerConnected?: (remotePublicKeyHex?: string, info?: PeerSignallingInfo) => void;
  /**
   * EI-18682571591024156: fires when a socket that signalled successfully CLOSES
   * having never received a single byte — a link that never came up at the data
   * layer while every layer above reported success. This is the signal whose
   * absence sent WI-5863's investigation to the wrong layer for hours: without
   * it the only symptom is a generic ~13s UV_ETIMEDOUT. Best-effort; a throw is
   * swallowed.
   */
  onDataPathNeverUp?: (info: DataPathNeverUpInfo) => void;
  /** DoS guard (ban-list + connection rate-limit). Defaults to the process-global
   *  guard (the same one the shared swarm's firewall reads). Injectable for tests. */
  guard?: SwarmGuard;
  /** Fires when a connection is dropped because the peer was already banned
   *  (P-007 observability). NOTE: the constructor firewall rejects most banned
   *  *keys* pre-handshake — those never reach this handler, so this only sees
   *  in-flight/IP-ban drops. */
  onPeerRejected?: (remotePublicKeyHex?: string, remoteIp?: string) => void;
  /** Fires when a connection trips the per-peer connection-rate limit and is
   *  banned + dropped (P-007 observability). */
  onPeerRateLimited?: (remotePublicKeyHex?: string, remoteIp?: string) => void;
  /**
   * P-004 observability: fires when the SHARED swarm's live peer count crosses
   * into the near-cap zone (>= {@link PEER_CAP_NEAR_RATIO} × the process-global
   * `maxPeers`). Hyperswarm SILENTLY stops accepting/opening connections once
   * `maxPeers` is reached — so peer N+1 just never connects, with no signal. This
   * makes that pressure VISIBLE before (and at) the cap so the caller can wire a
   * metric/alert. Best-effort + rate-limited (fires once per crossing via
   * hysteresis, re-arms after the count drops back below the threshold).
   */
  onNearPeerCap?: (info: PeerCapInfo) => void;
  /**
   * WI-6063: fired when THIS topic's outbound dialling is paused or resumed by
   * the per-topic fairness evaluator. Edge-triggered (transitions only), so it
   * can be recorded durably without rate-limiting. The failure mode of a
   * fairness bound is SILENT starvation — identical in appearance to the bug it
   * fixes — so this is how the mechanism is verified rather than assumed.
   */
  onTopicDialThrottle?: (info: TopicDialThrottleInfo) => void;
  /**
   * OUR signed announce — sent to every (non-dropped) peer right after the
   * `papercusp/announce` channel opens, binding our log core to our device
   * identity. Omit on a swarm that only replicates (no announce exchange);
   * then no announce is sent + inbound announces are ignored.
   */
  ourAnnounce?: SignedAnnounce;
  /**
   * WI-559 issue-2 — a FACTORY that builds a FRESH signed announce (current `ts`, re-signed) for
   * EACH connection's channel-open. A single frozen-`ts` frame (built once at boot and reused) is
   * rejected by the peer's `verifyAnnounce` once it is >5min old (DEFAULT_ANNOUNCE_WINDOW_MS), so a
   * post-window / post-reconnect connection sent a stale announce → 0 admitted → own-only set. When
   * supplied, the channel-open flush builds a fresh frame per send via this; `ourAnnounce` is kept
   * for the static `log_core_key` (the swarm entry key) and as the fallback when no factory is set.
   */
  buildOurAnnounce?: () => Promise<SignedAnnounce>;
  /**
   * Handle an inbound signed announce from a peer. Verifies the sig, runs the
   * read-admission decision, and on admit opens + admits the peer's remote log
   * and triggers a merge (boot.ts wires this to its `onAnnounce`). Required for
   * the announce exchange to do anything; omit alongside `ourAnnounce`.
   */
  onAnnounce?: (
    frame: SignedAnnounce,
    ctx?: AnnounceConnectionContext,
  ) => Promise<AdmissionResult> | void;
  /**
   * SUBSTRATE_SIDECAR Option B (WI-604) replication-offload seam. When supplied,
   * the connection handler calls this with each accepted peer socket INSTEAD of
   * `store.replicate(socket)`. A truthy return means the offload claimed the
   * socket (it is being handed to / replicated by the sidecar) so the in-process
   * `store.replicate` is SKIPPED — handing the merkle-verify CPU + replication
   * RSS off the main event loop (the EI-79 win). A falsy return means the offload
   * declined (no sidecar / not wired) and the handler replicates in-process as
   * usual. OMITTED (the default + the flag-OFF path) ⇒ byte-identical in-process
   * replication. MUST be synchronous + non-throwing (a throw is treated as
   * declined → in-process fallback).
   */
  offloadReplication?: (socket: unknown, peerInfo?: unknown) => boolean;
  /**
   * WI-752 / FED-2 self-heal: FAST per-topic `discovery.refresh()` cadence (ms)
   * during the post-join / post-peer-loss window. Default
   * `DEFAULT_SUBSTRATE_REFRESH_MS`. `0` DISABLES the self-heal loop entirely
   * (byte-identical to the pre-WI-752 join — tests that drive refresh by hand).
   */
  refreshMs?: number;
  /** How long the FAST cadence runs after a join / losing the last peer (ms).
   *  Default `DEFAULT_SUBSTRATE_FAST_WINDOW_MS`. */
  fastWindowMs?: number;
  /** Steady-state keepalive cadence once the fast window lapses (ms).
   *  Default `DEFAULT_SUBSTRATE_SLOW_REFRESH_MS`. */
  slowRefreshMs?: number;
  /**
   * WI-1534 anti-entropy: best-effort predicate — true when at least one
   * ADMITTED remote log on this harness currently shows ZERO live replicator
   * peers (attached-but-dead OR never-attached), i.e. the merge pass has
   * something it cannot pull. On a QUIESCENT hive (no connection churn to
   * naturally re-arm the FAST post-join/post-peer-loss window) the self-heal
   * loop otherwise settles into the 60s `slowRefreshMs` keepalive and stays
   * there indefinitely — observed as an 80+min stall until an unrelated event
   * (the next owner append) happens to coincide with a working DHT/holepunch
   * retry (known-limitations §NAT, WI-1534). Polled once per refresh tick
   * (cheap — a Map scan, no I/O); a throw is treated as false (never blocks
   * the keepalive). Omitted ⇒ byte-identical pre-WI-1534 behavior (fast window
   * only, then flat 60s slow cadence).
   */
  hasStalledLogs?: () => boolean;
  /**
   * EI-13317 escalation ladder: once this topic HAD a live peer and then sits
   * at ZERO live peers for this long — DESPITE the refresh() self-heal loop
   * actively ticking — force a topic-level leave()+rejoin() (a fresh
   * discovery session/DHT announce) and fire `onSeveredLink`. Forensics
   * (tower↔VM rig, 2026-07-16/17) show refresh() alone does NOT recover a
   * link severed by a ONE-SIDE RESTART: the surviving side's fast-window
   * ticks fire every ~2.5s with zero paired peers for 20+ minutes; only a
   * full process restart (== a fresh swarm.join) ever reconnects — this is
   * the cheapest in-process analog of that recovery, scoped to one topic
   * rather than tearing down the whole shared swarm. Default
   * `DEFAULT_SUBSTRATE_SEVERED_ESCALATION_MS`. `0` disables the escalation
   * entirely (byte-identical pre-EI-13317 behavior).
   */
  severedEscalationMs?: number;
  /**
   * P-203 / EI-22137294505377834: how recently a peer socket must have shown
   * INBOUND activity (UDX `bytesReceived` advancing between refresh ticks) for
   * a forced rejoin to SPARE it — see `DEFAULT_SOCKET_LIVENESS_WINDOW_MS` in
   * ./wire-stats.ts for the forensics. Default
   * `min(DEFAULT_SOCKET_LIVENESS_WINDOW_MS, severedEscalationMs)`. `0`
   * disables the predicate (the escalating participant then evicts
   * unconditionally — WI-6324 behavior).
   */
  socketLivenessWindowMs?: number;
  /**
   * EI-13317 observability: fires when the severed-link escalation trips
   * (see `severedEscalationMs`) — the LOUD signal the "correct state"
   * requires instead of a silently-frozen rail. Best-effort; a throw is
   * swallowed.
   */
  onSeveredLink?: (info: SeveredLinkInfo) => void;
  /**
   * EI-18662944242304583 rung (c): how long this topic may hold LIVE
   * connections while NEVER once pairing its announce channel before forcing a
   * topic leave+rejoin. Closes the pre-admission blind window that every
   * replication-liveness axis is structurally below. Default
   * `DEFAULT_SUBSTRATE_UNPAIRED_ESCALATION_MS`; `0` disables the rung.
   */
  unpairedEscalationMs?: number;
  /**
   * EI-18662944242304583 observability: fires when the never-paired escalation
   * trips (see `unpairedEscalationMs`). Best-effort; a throw is swallowed.
   */
  onUnpairedLink?: (info: UnpairedLinkInfo) => void;
  /**
   * EI-18662944242304583 test seam (same convention as `hasStalledLogs`):
   * override the announce-pairing probe rung (c) reads. Defaults to the live
   * module-level tracker `announcePairingStateForTopic`, so production behavior
   * is unchanged when omitted.
   */
  announcePairingState?: (topicHex: string) => AnnouncePairingState;
  /**
   * P-201 (p2p-git-live-activation-2026-07-09): register this harness's
   * connections to SERVE `papercusp/pot-git` fetch requests (a peer member
   * fetching our namespace) — omitted for a non-hive harness (the common
   * case), so byte-for-byte unchanged when not set. Actual serving is further
   * mode-gated PER REQUEST inside the wiring (a legacy-mode hive always
   * refuses, re-checked live — no re-seed needed on a mode flip).
   */
  hiveGitServe?: PotGitServeConfig;
  /**
   * WI-3583 (p2p-git-live-activation-2026-07-09 Phase-3 prerequisite):
   * register this connection on the pot-git dial-hello channel, so a
   * device-pubkey → live-socket registry (`peer-dial-registry.ts`) can
   * resolve "which live connection reaches device X" for a REAL cross-
   * machine `openDuplex` (worktree-bridge-tick.ts / ref-announce-tick.ts's
   * own `openDuplex` seam — currently omitted/local-mirror-only without
   * this). Omitted for a non-pot-git harness, so byte-for-byte unchanged
   * when not set. Independent of `hiveGitServe` — either can be set alone.
   */
  hiveGitDial?: {
    selfDevicePubkeyBase64: string;
    /** WI-3641: signs OUR hello frame (Ed25519 over the hello sign-context)
     *  so the peer's `wireHiveGitServe` can verify it owns `selfDevicePubkeyBase64`
     *  before binding it to this socket. Required — a dial registration with no
     *  signer can announce a device_pubkey without proving it, which is exactly
     *  what the signed-hello handshake exists to prevent. */
    sign: (bytes: Buffer) => Promise<Buffer> | Buffer;
  };
}

/**
 * Per-connection context handed to `onAnnounce` alongside each inbound frame
 * (P-006 §5.2/§5.3). Lets the admission layer act on THIS specific connection:
 *   - `send` a DIRECTED follow-up announce back to only this peer (the scoped-
 *     log disclosure rides a follow-up frame after the peer's identity is known,
 *     since the first announce is identity-blind);
 *   - `muxer` is the shared Protomux for this connection — the object scoped
 *     cores attach to (`session.replicate(muxer)`) so the §5.3 serve gate serves
 *     a scope on exactly the connections whose peer is in its roster.
 * OPTIONAL 2nd arg: pre-§5.2 `onAnnounce` implementations ignore it, unchanged.
 */
export interface AnnounceConnectionContext {
  /** Send a signed frame to THIS peer on the announce channel (directed). */
  send(frame: SignedAnnounce): void;
  /** The shared Protomux muxer for this connection (scoped-core attach target). */
  muxer: object;
}

/** Announce-channel opts for one hive on one peer connection. */
export type AnnounceChannelOpts = {
  ourAnnounce?: SignedAnnounce;
  /** WI-559 issue-2: fresh-announce-per-connection factory (see JoinHarnessSwarmOpts). */
  buildOurAnnounce?: () => Promise<SignedAnnounce>;
  onAnnounce?: JoinHarnessSwarmOpts['onAnnounce'];
  /**
   * Handle-scoped identity for this registration. `joinHarnessSwarm` supplies
   * one so `SwarmHandle.close()` can remove exactly its entry from a shared
   * (muxer, topic) state without disturbing same-topic sibling harnesses.
   * Direct callers may omit it and retain the historical log-key dedup.
   * @internal
   */
  registrationKey?: symbol;
};

/**
 * Per-topic announce-channel state on one muxer — keyed by `muxer × topicHex`.
 *
 * A shared-swarm muxer serves MANY topics over one socket. The announce channel
 * is discriminated per topic — protomux keys `createChannel`/`pair` by
 * `(protocol, id)`, so we use the 32-byte topic as the channel `id` (both peers
 * derive the SAME per-hive topic, so they agree on it). Keying this state by
 * `muxer × topicHex` (not `muxer` alone) is the A-002 fix: previously a 2nd hive
 * on the muxer overwrote the 1st's opts + collided on the protocol-only channel
 * key (createChannel → null) → its admission exchange was silently dropped.
 *
 * A-003 (a′) generalizes this from ONE log per topic to MANY: an instance may
 * run more than one local harness on the SAME hive topic (e.g. a hive's MEMBER
 * harness + its HIVE-HOME harness, so hive_members/hive_settings federate). They
 * share one announce channel (one (protocol, topic) channel per muxer), but the
 * channel now carries EVERY local log's announce on that topic — `entries` maps
 * each local harness (keyed by its own `log_core_key`) to its opts. On open (and
 * on a late-joining harness) we flush every not-yet-sent `ourAnnounce`; an
 * inbound announce is delivered to EVERY registered `onAnnounce` on the topic.
 *
 * CALLER CONTRACT: register `onAnnounce` only for harnesses that should ADMIT
 * inbound logs on this topic (the member). A send-only harness (the hive-home,
 * which only needs its own log announced so members admit it) passes
 * `ourAnnounce` WITHOUT `onAnnounce`, so it is never delivered a remote announce
 * to mis-admit. `paired` is the once-per-(muxer,topic) lazy-accept notifier;
 * `sentKeys` dedups sends by log_core_key (idempotent across re-pair/reconnect).
 */
type TopicAnnounceState = {
  /** Local harnesses on this topic, keyed by handle token or log key (dedup). */
  entries: Map<string | symbol, AnnounceChannelOpts>;
  /** Lazy-accept pair-notifier registered for this (muxer, topic). */
  paired: boolean;
  /** The live channel's message sink, set once the channel is created. */
  message: { send(value: SignedAnnounce): void } | null;
  /** Whether the channel's `onopen` has fired (safe to send late announces). */
  opened: boolean;
  /** log_core_keys already sent on the wire — guards double-send. */
  sentKeys: Set<string>;
};

const announceTopicStateByMuxer = new WeakMap<object, Map<string, TopicAnnounceState>>();
const announcePairedMuxers = new WeakSet<object>();
const guardCountedSockets = new WeakSet<object>();

/**
 * WI-5355 (EI-13317 downstream, mirrored from topic-gossip.ts's identical
 * `socketTopics` registry): module-level, shared across EVERY `joinHarnessSwarm`
 * call in this process — tracks, per live peer socket, which harness topic-hexes
 * currently consider it connected (added on that join's own `connection` handler,
 * removed on that join's own socket `close`). A single Hyperswarm A↔B socket is
 * shared across every topic/harness that peer participates in (Hyperswarm dedupes
 * connections per peer — see topic-gossip.ts's module header for the canonical
 * explanation), so a socket must never be destroyed while ANY OTHER harness's join
 * still holds it live — this registry is what lets `forceRejoinNow` (below) tell
 * "this socket is dead weight for every topic sharing it" apart from "still
 * serving some other harness perfectly well".
 */
const swarmJoinSocketTopics = new WeakMap<object, Set<string>>();


/**
 * WI-5923 (the "harder half" — the close()-side session-vs-leave fix landed
 * separately, see `HyperswarmLike.join().destroy` above). THE DEFECT: Shared-
 * Hive topics are joined ONCE PER MEMBER HARNESS on a topic that is per-HIVE
 * (boot.ts), so a shared process swarm can hold MULTIPLE `joinHarnessSwarm`
 * instances — one per harness — live on the SAME topic, sharing ONE underlying
 * Hyperswarm `PeerDiscovery` (hyperswarm dedupes `join()` by topic and hands
 * back a refcounted session — see the `HyperswarmLike.join().destroy` doc
 * above). Each instance ran its OWN independent escalation ladder (severed /
 * unpaired rungs) and, on firing, called the OLD `forceRejoinNow` which did a
 * raw `opts.swarm.leave(opts.topic)` — the PROCESS-WIDE, unconditional
 * teardown (`discovery.destroy()` regardless of any sibling's still-live
 * session — hyperswarm/index.js). With detectors typically ~2.5s out of phase,
 * each harness's "repair" destroyed the discovery the OTHER harness had just
 * rebuilt, in a self-cancelling loop bounded only by `MAX_UNPAIRED_ESCALATIONS`
 * (ratified defect, WI-5923 thread).
 *
 * THE FIX: a forced rejoin cannot be scoped to just ONE harness's session
 * without leaving siblings orphaned (session-preserving teardown — the
 * close()-side fix — is not "fresh" enough to clear stale DHT announce/lookup
 * state, which is WHY a forced rejoin exists in the first place; see
 * `forceRejoinNow`'s original doc). So a forced rejoin is inherently a
 * TOPIC-WIDE operation. This registry gives every `joinHarnessSwarm` instance
 * sharing a (swarm, topic) pair ONE shared `TopicRejoinCoordinator` instead of
 * acting alone: any instance's escalation ladder still fires independently
 * (each harness's own connection/pairing state is still its own business), but
 * the actual repair — evict this topic's dead sockets, ONE real
 * `swarm.leave(topic)`, then EVERY registered sibling re-joins to get a fresh
 * session on the new shared discovery — happens EXACTLY ONCE per coordinated
 * rejoin, with concurrent requests (the very same ~2.5s-apart firing pattern
 * that used to cause the ping-pong) collapsing onto the SAME in-flight
 * operation instead of each triggering their own. No sibling is ever left
 * holding a reference to a discovery some OTHER harness silently destroyed.
 *
 * Keyed by swarm instance (WeakMap — multiple test swarms/process teardown
 * never collide or leak) then by topic hex (a plain Map, cleaned up in
 * `close()` once the last participant on that topic unregisters — a
 * long-lived shared process swarm joins/leaves many distinct topics over its
 * life, so this must not grow unbounded).
 */
interface TopicRejoinParticipant {
  /** Evict THIS participant's own dead/zombie sockets and drop its claim on
   *  them in `swarmJoinSocketTopics`, BEFORE the shared `swarm.leave()` — the
   *  same per-instance eviction the old (pre-WI-5923-topic-fix) `forceRejoinNow`
   *  did for itself alone. Never throws (best-effort, mirrors the original).
   *
   *  `escalating` is TRUE only for the participant whose OWN detector fired this
   *  rejoin, and FALSE for the siblings dragged along by the topic-wide repair —
   *  see the WI-6324 block on the implementation for why that distinction is
   *  load-bearing. */
  evictOwnSockets(escalating: boolean): void;
  /** Re-`swarm.join()` to obtain a fresh session for THIS participant on the
   *  coordinator's newly-recreated shared discovery, and re-arm this
   *  participant's own fast self-heal window — called once per participant
   *  AFTER the coordinator's single shared `swarm.leave()`. */
  rejoinOwnSession(): void;
}

class TopicRejoinCoordinator {
  private readonly participants = new Map<symbol, TopicRejoinParticipant>();
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly swarm: HyperswarmLike,
    private readonly topic: Buffer,
  ) {}

  register(token: symbol, participant: TopicRejoinParticipant): void {
    this.participants.set(token, participant);
  }

  unregister(token: symbol): void {
    this.participants.delete(token);
  }

  get participantCount(): number {
    return this.participants.size;
  }

  /**
   * Perform (or join) ONE topic-wide forced rejoin. A caller mid-flight when
   * another caller's rejoin is already running just awaits that SAME
   * operation — this is what stops the WI-5923 ping-pong: two siblings firing
   * ~2.5s apart used to independently destroy-then-rebuild the one shared
   * discovery, undoing each other's repair every cycle forever. Now the
   * second (and any later) request during an in-flight rejoin is folded into
   * the first's single leave()+rejoin() sequence.
   */
  async requestRejoin(requester?: symbol): Promise<void> {
    if (this.inFlight) {
      // WI-6324: coalescing must not swallow the REQUESTER's own eviction. The
      // in-flight run was started by a different participant, so it already
      // passed (or will pass) this requester through the SIBLING branch — and a
      // sibling is deliberately spared any socket with a proven data path. That
      // is right for a sibling and wrong for the escalating participant, whose
      // own link is proven dead. Evict its sockets here, unconditionally, before
      // folding into the shared rejoin; the leave()+rejoin() itself still
      // happens exactly once, which is all the WI-5923 ping-pong fix required.
      if (requester !== undefined) {
        const self = this.participants.get(requester);
        try {
          self?.evictOwnSockets(true);
        } catch {
          /* best-effort, mirrors the per-instance eviction below */
        }
      }
      await this.inFlight;
      return;
    }
    const run = this.performRejoin(requester).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    await run;
  }

  private async performRejoin(requester?: symbol): Promise<void> {
    // Snapshot: a participant can unregister (its own `close()`) mid-flight —
    // iterate a copy so a concurrent close() can't mutate the Map we're
    // walking, and a since-unregistered participant simply won't be asked to
    // rejoin (its own close() already tore its session down correctly).
    const participants = Array.from(this.participants.entries());
    for (const [token, p] of participants) {
      try {
        p.evictOwnSockets(token === requester);
      } catch {
        /* best-effort, mirrors the original per-instance eviction */
      }
    }
    // The ONE real, topic-wide teardown — deliberately NOT session.destroy():
    // a forced rejoin exists precisely to clear stale DHT announce/lookup
    // state that a refcounted session-decrement alone cannot clear (see
    // `forceRejoinNow`'s doc). Every registered sibling below rebuilds its own
    // session on the fresh discovery this creates, so nobody is left orphaned.
    await Promise.resolve(this.swarm.leave(this.topic)).catch(() => {});
    for (const [, p] of participants) {
      try {
        p.rejoinOwnSession();
      } catch {
        // best-effort — a participant whose own rejoin failed is retried at
        // its OWN next escalation tick, same as the original single-instance
        // forceRejoinNow's failure handling.
      }
    }
  }
}

const topicRejoinCoordinators = new WeakMap<HyperswarmLike, Map<string, TopicRejoinCoordinator>>();

function getTopicRejoinCoordinator(
  swarm: HyperswarmLike,
  topic: Buffer,
  topicHex: string,
): TopicRejoinCoordinator {
  let byTopic = topicRejoinCoordinators.get(swarm);
  if (!byTopic) {
    byTopic = new Map();
    topicRejoinCoordinators.set(swarm, byTopic);
  }
  let coordinator = byTopic.get(topicHex);
  if (!coordinator) {
    coordinator = new TopicRejoinCoordinator(swarm, topic);
    byTopic.set(topicHex, coordinator);
  }
  return coordinator;
}

/** Drop a (swarm, topicHex)'s coordinator once its last participant
 *  unregisters — called from `close()`. Without this a long-lived shared
 *  process swarm that joins/leaves many distinct topics over its life would
 *  leak one Map entry per ever-joined topic. */
function releaseTopicRejoinCoordinatorIfEmpty(swarm: HyperswarmLike, topicHex: string): void {
  const byTopic = topicRejoinCoordinators.get(swarm);
  const coordinator = byTopic?.get(topicHex);
  if (coordinator && coordinator.participantCount === 0) {
    byTopic?.delete(topicHex);
  }
}

/**
 * EI-1599 — content-replication peer accounting. `announceTopicStateByMuxer`
 * is a WeakMap (keyed by muxer, for GC) and therefore NOT enumerable, so it
 * cannot answer "how many peers is hive X actually content-syncing with" —
 * exactly the gap findings-M/EI-1599 flagged once Brief H (A-002) made the
 * announce channel per-topic instead of per-muxer. These plain (non-weak)
 * side-structures mirror topic-gossip.ts's `channels: Set<...>` /
 * `openChannelCount` pattern for the SHARED content substrate swarm: a topic's
 * entry is added when its (muxer, topic) announce channel OPENS and removed
 * when it CLOSES, so the count only ever reflects live, paired peers — never
 * unbounded (a dead/rekeyed connection's entry is always reclaimed on close).
 */
const contentPeerMuxersByTopic = new Map<string, Set<object>>();
/** ms-epoch of the last inbound signed-announce frame received on a topic's
 *  content-announce channel — the most recent evidence of live content-sync
 *  activity with SOME peer on that hive. This is a RECEIVE-side proxy (an
 *  announce arrived), not an admission/merge timestamp — admission is the
 *  caller's business (`onAnnounce`), which this module doesn't see the result
 *  of. Callers should label it accordingly (e.g. "last synced with a peer",
 *  not "last merged"). */
const lastContentAnnounceRecvMsByTopic = new Map<string, number>();

function trackContentPeerOpen(topicHex: string, mux: object): void {
  let set = contentPeerMuxersByTopic.get(topicHex);
  if (!set) {
    set = new Set();
    contentPeerMuxersByTopic.set(topicHex, set);
  }
  set.add(mux);
}

function trackContentPeerClose(topicHex: string, mux: object): void {
  const set = contentPeerMuxersByTopic.get(topicHex);
  if (!set) return;
  set.delete(mux);
  if (set.size === 0) contentPeerMuxersByTopic.delete(topicHex);
}

/**
 * EI-1599: the number of DISTINCT live peers whose content-announce channel is
 * currently OPEN for `topicHex` — i.e. peers this hive is actually content-
 * replicating with, not merely reachable-for-discovery. Omit `topicHex` for
 * the total across every topic (mirrors topic-gossip.ts's `openChannelCount`).
 * Unlike `reachablePeersForHive` (the hive-directory's discovery/announce-
 * topic count) or the shared swarm's raw `connectionCount`/`liveConnectionCount`
 * (process-global across every hive sharing the singleton swarm — see the
 * A-002 header above), this is scoped to ONE hive's content topic.
 */
export function contentPeerCountForTopic(topicHex?: string): number {
  if (topicHex) return contentPeerMuxersByTopic.get(topicHex)?.size ?? 0;
  let n = 0;
  for (const set of contentPeerMuxersByTopic.values()) n += set.size;
  return n;
}

/**
 * EI-1599: ms-epoch of the last inbound signed-announce frame received on
 * `topicHex`'s content-announce channel, or `null` if none has ever been
 * received (including "no peer has ever paired on this topic").
 */
export function lastContentAnnounceRecvMs(topicHex: string): number | null {
  return lastContentAnnounceRecvMsByTopic.get(topicHex) ?? null;
}

/**
 * EI-18662944242304583 rung (c) telemetry: per-topic announce-channel PAIRING
 * progress — how many times we created+`open()`d an announce channel for the
 * topic, and whether ANY of them ever reached Protomux `onopen`.
 *
 * Why this is tracked separately from {@link contentPeerCountForTopic}: that
 * count is a LIVE gauge (peers whose channel is open right now), so it reads 0
 * both when we never paired and when a paired peer just closed. The
 * pre-admission stall axis needs the *cumulative, latching* distinction —
 * "we have been trying to pair on this topic since T and have never once
 * succeeded" — which a live gauge structurally cannot express.
 */
const announcePairingByTopic = new Map<
  string,
  {
    attempts: number;
    firstAttemptMs: number;
    everPaired: boolean;
    remoteOpenObserved: boolean;
  }
>();

/** Cumulative announce-channel pairing progress for one topic. */
export interface AnnouncePairingState {
  /**
   * EI-18680482533031746: explicit presence witness — true only when this
   * topic has a real tracked entry (at least one open attempt or a pairing
   * ever recorded). A diagnostic accessor that synthesises a zero-state for
   * "no entry" (attempts:0/everPaired:false) makes "never attempted" and
   * "attempted and measured zero" read identically through the numeric
   * fields alone — exactly the information-destroying-at-the-boundary shape
   * the empty swarm-connection catch (WI-5895) had one layer down. Callers
   * MUST check this before trusting `attempts`/`everPaired` as a real
   * measurement; `firstAttemptMs === null` happens to correlate with
   * `present === false` today (both writers always stamp it), but that is an
   * accident of the current writers, not a contract — check `present`.
   */
  present: boolean;
  /** How many announce channels we have created+`open()`d for this topic. */
  attempts: number;
  /** True once ANY announce channel on this topic reached `onopen` (paired). */
  everPaired: boolean;
  /**
   * True once a peer opened this SAME topic's announce channel toward us.
   *
   * A physical Hyperswarm socket is process-global and every locally joined
   * topic's connection handler sees it, even when the remote peer joined only
   * a different topic. Local open attempts therefore do not prove the peer is
   * a participant in this topic. The never-paired repair rung must require
   * this remote-intent witness or an unrelated private topic can repeatedly
   * evict a healthy shared socket used by another topic.
   */
  remoteOpenObserved: boolean;
  /** ms-epoch of the FIRST open attempt, or null when we've never attempted. */
  firstAttemptMs: number | null;
}

function recordAnnounceOpenAttempt(topicHex: string): void {
  const cur = announcePairingByTopic.get(topicHex);
  if (cur) cur.attempts += 1;
  else
    announcePairingByTopic.set(topicHex, {
      attempts: 1,
      firstAttemptMs: Date.now(),
      everPaired: false,
      remoteOpenObserved: false,
    });
}

function recordAnnounceRemoteOpen(topicHex: string): void {
  const cur = announcePairingByTopic.get(topicHex);
  if (cur) cur.remoteOpenObserved = true;
  else
    announcePairingByTopic.set(topicHex, {
      attempts: 0,
      firstAttemptMs: Date.now(),
      everPaired: false,
      remoteOpenObserved: true,
    });
}

function recordAnnouncePaired(topicHex: string): void {
  const cur = announcePairingByTopic.get(topicHex);
  if (cur) {
    cur.everPaired = true;
    cur.remoteOpenObserved = true;
  }
  else
    announcePairingByTopic.set(topicHex, {
      attempts: 0,
      firstAttemptMs: Date.now(),
      everPaired: true,
      remoteOpenObserved: true,
    });
}

/** EI-18662944242304583: cumulative announce-channel pairing state for a topic
 *  (the default source for the pre-admission stall axis' probe). */
export function announcePairingStateForTopic(topicHex: string): AnnouncePairingState {
  const cur = announcePairingByTopic.get(topicHex);
  if (!cur)
    return {
      present: false,
      attempts: 0,
      everPaired: false,
      remoteOpenObserved: false,
      firstAttemptMs: null,
    };
  return {
    present: true,
    attempts: cur.attempts,
    everPaired: cur.everPaired,
    remoteOpenObserved: cur.remoteOpenObserved,
    firstAttemptMs: cur.firstAttemptMs,
  };
}

// ── WI-1544 (defect iii): periodic announce re-flush ──
// The announce exchange is ONE-SHOT per (muxer, topic): `sentKeys` dedups
// forever, and the receive side never re-requests. So any single loss — a
// send that raced the channel teardown, a receiver whose admission threw once,
// a topic rejoin over a surviving connection — permanently suppressed this
// log's announce until a process restart (the WI-1544 m-run A→B stall class).
// A slow sweep clears each LIVE topic state's dedup set and re-flushes fresh
// signed frames. Receivers are idempotent (an already-admitted log is a cheap
// map hit; a pending one re-buffers with its grace clock preserved), so the
// steady-state cost is one small frame per log per interval — and every
// one-shot-loss failure mode self-heals in ≤ the interval.
const ANNOUNCE_REFLUSH_MS = (() => {
  const raw = Number(process.env.PAPERCUSP_ANNOUNCE_REFLUSH_MS);
  return Number.isFinite(raw) ? raw : 5 * 60 * 1000;
})();
type AnnounceReflushEntry = {
  state: TopicAnnounceState;
  stream: { destroyed?: boolean };
};
const announceReflushEntries = new Set<AnnounceReflushEntry>();
let announceReflushTimer: ManagedHandle | null = null;
function sweepAnnounceReflush(): void {
  for (const entry of announceReflushEntries) {
    if (entry.stream.destroyed === true) {
      announceReflushEntries.delete(entry);
      continue;
    }
    if (!entry.state.opened || !entry.state.message) continue;
    entry.state.sentKeys.clear();
    flushTopicAnnounces(entry.state);
  }
  if (announceReflushEntries.size === 0 && announceReflushTimer) {
    announceReflushTimer.stop();
    announceReflushTimer = null;
  }
}
function trackAnnounceReflush(entry: AnnounceReflushEntry): void {
  if (ANNOUNCE_REFLUSH_MS <= 0) return; // env kill-switch (tests / diagnostics)
  announceReflushEntries.add(entry);
  if (!announceReflushTimer) {
    announceReflushTimer = managedSetInterval(
      'hyperbee-announce-reflush',
      ANNOUNCE_REFLUSH_MS,
      () => sweepAnnounceReflush(),
      { category: 'lifecycle' },
    );
  }
}

function announceDebug(message: string): void {
  if (process.env.PAPERCUSP_ANNOUNCE_DEBUG !== '1') return;
   
  console.info(`[announce-debug] ${message}`);
}

/** Render the signed writer-progress fields on every sent/received announce.
 * Kept behind PAPERCUSP_ANNOUNCE_DEBUG with the rest of this channel trace: the
 * rig needs to distinguish "the writer never advanced its own log" from "the
 * receiver saw an ahead high-water but transport/apply still stalled" without
 * making these per-frame details noisy in production. Legacy frames omit both
 * optional fields, so make that absence explicit instead of printing an
 * ambiguous `undefined`. */
function announceDebugFrame(frame: SignedAnnounce): string {
  const harness = frame.harness_slug ?? '<absent>';
  const logLength = frame.log_length === undefined ? '<absent>' : String(frame.log_length);
  return `harness=${harness} log=${frame.log_core_key.slice(0, 12)}... log_length=${logLength}`;
}

const announceMuxDebugIds = new WeakMap<object, number>();
let nextAnnounceMuxDebugId = 1;

function announceMuxDebugId(mux: object): number {
  let id = announceMuxDebugIds.get(mux);
  if (!id) {
    id = nextAnnounceMuxDebugId++;
    announceMuxDebugIds.set(mux, id);
  }
  return id;
}

function announceDebugCtor(value: unknown): string {
  return (
    (value as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name as
      | string
      | undefined
  ) ?? typeof value;
}

/** Get-or-create the per-topic announce-state map for a muxer. */
function announceTopicStatesFor(mux: object): Map<string, TopicAnnounceState> {
  let m = announceTopicStateByMuxer.get(mux);
  if (!m) {
    m = new Map();
    announceTopicStateByMuxer.set(mux, m);
  }
  return m;
}

/**
 * Resolve the already-created announce state for one live swarm socket without
 * creating a second Protomux wrapper. `openAnnounceChannel` stores the mux in
 * `userData`; the WeakMap check keeps this safe for minimal test streams whose
 * `userData` may hold something unrelated.
 */
function announceStateForSocket(socket: unknown, topicHex: string): TopicAnnounceState | null {
  const muxStream = ((socket as { noiseStream?: unknown } | null)?.noiseStream ?? socket) as {
    userData?: unknown;
  } | null;
  if (!muxStream || typeof muxStream !== 'object') return null;
  const mux = muxStream.userData;
  if (!mux || typeof mux !== 'object') return null;
  return announceTopicStateByMuxer.get(mux)?.get(topicHex) ?? null;
}

/** Create + open the announce channel on a muxer (returns silently when the
 *  channel already exists on it). Split from openAnnounceChannel so the
 *  protomux pair-notifier can re-create the channel synchronously. */
/** Flush every not-yet-sent local `ourAnnounce` on a topic over its live
 *  channel. Idempotent via `state.sentKeys` — a duplicate onopen, a re-pair, or
 *  a late-joining harness can call this without double-sending. */
function flushTopicAnnounces(state: TopicAnnounceState): void {
  const msg = state.message;
  if (!msg) return;
  for (const entry of state.entries.values()) {
    // WI-559 issue-2 — send a FRESH announce (current ts, re-signed) per connection when a factory
    // is supplied: a frozen-ts frame is rejected by the peer's verifyAnnounce once it is >5min old,
    // so a reconnect after the window admitted nothing → own-only set. Dedup by log_core_key so a
    // re-pair / late-join on the SAME channel doesn't double-send; a NEW connection gets a fresh
    // `state` (fresh sentKeys) → re-flushes → a fresh frame, which IS the per-connection refresh.
    if (entry.buildOurAnnounce) {
      const key = entry.ourAnnounce?.log_core_key;
      if (!key || state.sentKeys.has(key)) continue;
      state.sentKeys.add(key);
      void entry
        .buildOurAnnounce()
        .then((fresh) => {
          try {
            msg.send(fresh);
            announceDebug(`sent fresh ${announceDebugFrame(fresh)}`);
          } catch (e) {
            // best-effort — replication still proceeds. WI-1544: this drop is
            // one-shot per connection (sentKeys already marked) — make it loud.
            announceDebug(
              `send-failed log=${fresh.log_core_key.slice(0, 12)}... err=${e instanceof Error ? e.message : String(e)}`,
            );
          }
        })
        .catch((e: unknown) => {
          // a build/sign failure must never crash the swarm handler — but it
          // silently suppresses this core's announce for the whole connection
          // (WI-1544 round-1 candidate), so trace it.
          announceDebug(
            `build-failed log=${key.slice(0, 12)}... err=${e instanceof Error ? e.message : String(e)}`,
          );
        });
      continue;
    }
    const ann = entry.ourAnnounce;
    if (!ann || state.sentKeys.has(ann.log_core_key)) continue;
    state.sentKeys.add(ann.log_core_key);
    try {
      msg.send(ann);
      announceDebug(`sent static ${announceDebugFrame(ann)}`);
    } catch (e) {
      // best-effort — replication still proceeds (loud: one-shot per connection)
      announceDebug(
        `send-failed static log=${ann.log_core_key.slice(0, 12)}... err=${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/** Create + open the single announce channel for a topic on a muxer (one
 *  `(protocol, topic)` channel), then drive it from the per-topic `state`:
 *  every local log's announce is sent on `onopen` (Protomux fires it only once
 *  the channel is fully PAIRED — sending before that drops the frame, and
 *  announces aren't re-sent), and each inbound announce is delivered to every
 *  registered `onAnnounce`. Returns silently when the channel already exists on
 *  the muxer (the lazy-accept re-create / a 2nd harness on the same topic). */
function createAnnounceChannel(
  mux: ReturnType<typeof Protomux.from>,
  channelId: Buffer,
  state: TopicAnnounceState,
): void {
  const muxId = announceMuxDebugId(mux as object);
  const channel = mux.createChannel({
    protocol: ANNOUNCE_PROTOCOL,
    // Discriminate the announce channel PER TOPIC by the hive topic (A-002).
    // Without an id, a 2nd hive on the same muxer collides on the protocol-only
    // key and createChannel returns null — dropping its admission exchange.
    id: channelId,
    onopen: () => {
      state.opened = true;
      announceDebug(
        `open topic=${channelId.toString('hex').slice(0, 16)} entries=${state.entries.size}`,
      );
      // EI-18662944242304583: this topic has now PAIRED at least once, which
      // permanently disarms the pre-admission stall axis for it (everything
      // after first pairing is the downstream liveness detector's business).
      recordAnnouncePaired(channelId.toString('hex'));
      // EI-1599: this (muxer, topic) pairing succeeded — count this peer
      // toward the topic's content-replication peer count until it closes.
      trackContentPeerOpen(channelId.toString('hex'), mux as object);
      flushTopicAnnounces(state); // send ALL local logs' announces on this topic
    },
    onclose: () => {
      announceDebug(`close mux=${muxId} topic=${channelId.toString('hex').slice(0, 16)}`);
      // EI-1599: this peer's content-announce channel is gone — stop
      // counting it (a dead/rekeyed connection never inflates the count).
      trackContentPeerClose(channelId.toString('hex'), mux as object);
    },
  });
  if (!channel) {
    announceDebug(`create-null mux=${muxId} topic=${channelId.toString('hex').slice(0, 16)}`);
    return; // already open on this muxer for this topic — nothing to do
  }
  announceDebug(
    `create mux=${muxId} topic=${channelId.toString('hex').slice(0, 16)} entries=${state.entries.size}`,
  );
  const message = channel.addMessage<SignedAnnounce>({
    encoding: c.json,
    onmessage: (frame: SignedAnnounce) => {
      announceDebug(
        `recv topic=${channelId.toString('hex').slice(0, 16)} ${announceDebugFrame(frame)}`,
      );
      // EI-1599: a frame arrived on this topic — record it as the most recent
      // live content-sync activity, regardless of what admission decides.
      lastContentAnnounceRecvMsByTopic.set(channelId.toString('hex'), Date.now());
      // A-003 (a′): deliver an inbound announce to EVERY local harness that
      // admits on this topic (send-only harnesses register no onAnnounce).
      // P-006 §5.2/§5.3: hand each a per-connection context — `send` for a
      // DIRECTED scoped-log follow-up back to this peer, `muxer` for the
      // scoped-core serve gate. `mux` is the shared Protomux for this
      // connection; `state.message` is this (muxer,topic) channel's sink, so a
      // send reaches ONLY this peer.
      const ctx: AnnounceConnectionContext = {
        muxer: mux as object,
        send: (f: SignedAnnounce) => {
          try {
            state.message?.send(f);
          } catch {
            // best-effort — replication still proceeds if a follow-up drops
          }
        },
      };
      for (const entry of state.entries.values()) {
        if (!entry.onAnnounce) continue;
        try {
          // onAnnounce may be async; never let a rejection crash the muxer.
          void Promise.resolve(entry.onAnnounce(frame, ctx)).catch(() => {});
        } catch {
          // synchronous throw — swallow
        }
      }
    },
  });
  state.message = message;
  channel.open();
  announceDebug(`open-request mux=${muxId} topic=${channelId.toString('hex').slice(0, 16)}`);
  // EI-18662944242304583: count the ATTEMPT. Recorded after open() so the axis
  // only ever arms on topics where we genuinely expect a pairing — a topic that
  // opens no announce channel at all (a reader with neither `onAnnounce` nor
  // `ourAnnounce`, which returns early in openAnnounceChannel) never arms it.
  recordAnnounceOpenAttempt(channelId.toString('hex'));
}

/** Open the `papercusp/announce` channel on the shared muxer for one peer
 *  connection, wire inbound announces to `onAnnounce`, and send `ourAnnounce`.
 *  Defensive: any protomux error is swallowed — a peer that can't speak the
 *  announce protocol still replicates over the same connection. */
export function openAnnounceChannel(socket: unknown, topic: Buffer, opts: AnnounceChannelOpts): () => void {
  // Keep the disposer stable across every setup phase. A handle may close
  // while the stream's `opened` promise is still pending; recording that early
  // release prevents the eventual setup from resurrecting a retired entry.
  let released = false;
  let releaseImpl: (() => void) | null = null;
  const release = (): void => {
    released = true;
    releaseImpl?.();
  };
  if (!opts.onAnnounce && !opts.ourAnnounce) return release;
  try {
    // Corestore/Hypercore attaches Protomux to the NoiseSecretStream, not always
    // the outer Hyperswarm socket. Use `socket.noiseStream` when present so the
    // announce channel shares the same muxer as Hypercore replication; otherwise
    // live peers connect but never exchange announce/admission frames.
    const muxStream = ((socket as { noiseStream?: unknown } | null)?.noiseStream ?? socket) as {
      userData?: unknown;
      isProtomux?: unknown;
    };
    const beforeUserData = muxStream.userData;
    const mux = Protomux.from(muxStream);
    const muxId = announceMuxDebugId(mux as object);
    if (!muxStream.userData) muxStream.userData = mux;
    announceDebug(
      `mux mux=${muxId} topic=${topic
        .toString('hex')
        .slice(0, 16)} stream=${announceDebugCtor(muxStream)} streamIsMux=${muxStream.isProtomux === true} userData=${announceDebugCtor(
        beforeUserData,
      )} userDataIsMux=${(beforeUserData as { isProtomux?: unknown } | null | undefined)?.isProtomux === true}`,
    );
    // Per-topic state, keyed by topicHex (A-002). A-003 (a′): MULTIPLE local
    // harnesses can share one topic — accumulate each (keyed by its own log
    // core) so the single topic channel carries every local log's announce.
    const topicHex = topic.toString('hex');
    const states = announceTopicStatesFor(mux);
    let state = states.get(topicHex);
    if (!state) {
      state = { entries: new Map(), paired: false, message: null, opened: false, sentKeys: new Set() };
      states.set(topicHex, state);
      // WI-1544 (defect iii): enroll this live topic state in the slow
      // announce re-flush sweep so a one-shot announce loss self-heals.
      trackAnnounceReflush({ state, stream: muxStream as { destroyed?: boolean } });
    }
    // Register/refresh THIS harness's entry, keyed by its own log_core_key so a
    // reconnect/replay on the same muxer de-dups rather than double-registering.
    // (A send-only harness with no ourAnnounce falls back to a positional key.)
    const entryKey = opts.registrationKey ?? opts.ourAnnounce?.log_core_key ?? `__reader-${state.entries.size}`;
    // WI-1544 (defect iii): a RE-registration of an already-known log on this
    // (muxer, topic) means the harness re-joined the topic over a surviving
    // connection (rekey / join-retry). The peer may have missed (or dropped)
    // the original announce, and sentKeys would suppress it forever — clear
    // this log's dedup mark so the flush below re-sends a fresh signed frame
    // (receivers are idempotent).
    const announceLogKey = opts.ourAnnounce?.log_core_key;
    if (state.entries.has(entryKey) && announceLogKey) state.sentKeys.delete(announceLogKey);
    state.entries.set(entryKey, opts);
    // A socket/muxer can outlive one harness join because the process swarm is
    // shared. Return a handle-scoped release instead of waiting for WeakMap GC:
    // the latter happens only when the physical socket dies, so a closed or
    // restarted harness otherwise remains in `entries` and is re-announced by
    // every periodic sweep forever. Identity-check the value because a later
    // refresh may have replaced this registration under the same key.
    releaseImpl = (): void => {
      if (state.entries.get(entryKey) !== opts) return;
      state.entries.delete(entryKey);
      if (announceLogKey) state.sentKeys.delete(announceLogKey);
    };
    if (released) releaseImpl();
    // LAZY-ACCEPT pair-notifier, ONCE per muxer. Register at protocol scope and
    // dispatch by the incoming topic id, matching directory-swarm.ts. Live
    // Protomux delivers late remote opens to the protocol-level pair notifier;
    // registering pair({ protocol, id: topic }) leaves the pending open
    // unaccepted, so the channel never reaches onopen and announces never send.
    if (!announcePairedMuxers.has(mux)) {
      announcePairedMuxers.add(mux);
      try {
        mux.pair({ protocol: ANNOUNCE_PROTOCOL }, (id: Buffer | null) => {
          if (!id) {
            announceDebug(`pair mux=${muxId} topic=<null>`);
            return;
          }
          const remoteTopicHex = id.toString('hex');
          const cur = states.get(remoteTopicHex);
          // WI-40008: this callback is the positive witness that the REMOTE
          // peer opened the same topic. A process-global swarm connection by
          // itself proves only that the peer shares some topic; without this
          // witness a private side-topic's local channel attempts can trigger
          // the unpaired repair and tear down a healthy socket used elsewhere.
          // Record only topics this muxer already tracks: a remote can propose
          // arbitrary ids, and the module-level pairing map must not become an
          // unbounded registry of peer-controlled unknown topics.
          if (cur) recordAnnounceRemoteOpen(remoteTopicHex);
          announceDebug(
            `pair mux=${muxId} topic=${id.toString('hex').slice(0, 16)} hasState=${Boolean(
              cur,
            )} entries=${cur?.entries.size ?? 0}`,
          );
          if (cur) {
            try {
              createAnnounceChannel(mux, id, cur);
            } catch {
              // best-effort — a failed lazy accept degrades to the old reject
            }
          }
        });
      } catch {
        // pair() unsupported on this muxer build — connect-time channels still pair
      }
    }
    // Create the topic channel once the underlying Noise stream is open. This
    // mirrors corestore's own `noiseStream.opened.then(uncork)` timing: opening
    // our app channel before the transport is ready can leave the local open
    // frame corked forever on packaged shared-swarm sockets, so the peer never
    // sees it and `onopen` never fires.
    const createWhenReady = () => {
      // The owning handle may have closed while the Noise stream was still
      // opening. Do not create an orphan channel for an empty state; a sibling
      // that joined before this callback ran still makes the channel here.
      if (state.entries.size === 0) return;
      createAnnounceChannel(mux, topic, state);
      // If the channel had already opened, flush this late-joining harness's
      // announce now (the onopen flush already fired and won't re-run for it).
      if (state.opened) flushTopicAnnounces(state);
    };
    const opened = (muxStream as { opened?: Promise<unknown> } | null | undefined)?.opened;
    if (opened && typeof opened.then === 'function') {
      announceDebug(`defer-open mux=${muxId} topic=${topic.toString('hex').slice(0, 16)}`);
      void opened.then(createWhenReady, createWhenReady);
    } else {
      createWhenReady();
    }
  } catch {
    // Announce channel is best-effort; replication still proceeds.
  }
  return release;
}

/**
 * Pull the remote peer's IP out of a Hyperswarm connection socket, defensively
 * — the encrypted stream exposes the underlying UDX stream's `remoteHost`. The
 * DoS guard keys its connection-rate limit on IP when available (robust to a
 * peer rotating its Noise key — see hyperswarm-dos-hardening D-003). Returns
 * undefined for test fakes / shapes that don't expose it.
 */
export function extractRemoteIp(socket: unknown): string | undefined {
  const host = (socket as { rawStream?: { remoteHost?: unknown } } | null | undefined)?.rawStream
    ?.remoteHost;
  return typeof host === 'string' && host.length > 0 ? host : undefined;
}

/** Best-effort close of a live peer connection (Hyperswarm's `ban()` prevents
 *  RECONNECT but does NOT close an open connection — D-003). */
function destroySocket(socket: unknown): void {
  try {
    (socket as { destroy?: () => void } | null | undefined)?.destroy?.();
  } catch {
    // best-effort; a peer we're dropping doesn't get to crash us
  }
}

/** Invoke an optional diagnostic callback without letting it crash the handler. */
function fireSafely(
  cb: ((keyHex?: string, ip?: string) => void) | undefined,
  keyHex?: string,
  ip?: string,
): void {
  if (!cb) return;
  try {
    cb(keyHex, ip);
  } catch {
    // diagnostic-only callback; swallow
  }
}

/**
 * P-004 near-cap signal. Hyperswarm's `maxPeers` is a PROCESS-GLOBAL ceiling on
 * total live connections across every joined topic; once it's reached Hyperswarm
 * SILENTLY stops opening/accepting — so peer N+1 just never connects, with no
 * log/event. This fraction of `maxPeers` is the threshold at which we emit a
 * LOUD, rate-limited signal so that silent drop is VISIBLE before (and at) the
 * cap. 0.9 leaves ~10% headroom to act (raise the budget / scale the box).
 */
export const PEER_CAP_NEAR_RATIO = 0.9;

/** Hysteresis state, keyed by swarm: have we already warned for the CURRENT
 *  approach to the cap? Re-armed once the live count drops back below threshold
 *  so a later re-approach warns again, but a steady stream of connections at the
 *  cap doesn't spam the log/event on every single `connection`. */
const peerCapNearState = new WeakMap<object, boolean>();

/** Count live peer sockets on a swarm. Real Hyperswarm exposes a Set (cheap
 *  `.size`); fakes may expose any Iterable or nothing. Returns undefined when
 *  the count is unknowable (no `connections`). */
export function countLiveConnections(swarm: HyperswarmLike): number | undefined {
  const conns = swarm.connections;
  if (!conns) return undefined;
  const size = (conns as { size?: unknown }).size;
  if (typeof size === 'number') return size;
  let n = 0;
  for (const _ of conns) n++;
  return n;
}

/** Fire the near-cap callback without letting a diagnostic throw crash the handler. */
function fireNearCapSafely(cb: ((info: PeerCapInfo) => void) | undefined, info: PeerCapInfo): void {
  if (!cb) return;
  try {
    cb(info);
  } catch {
    // diagnostic-only callback; swallow
  }
}

/** Fire the severed-link escalation callback without letting a diagnostic
 *  throw crash the handler (EI-13317). */
/** EI-18662944242304583: invoke the never-paired escalation callback without
 *  letting a throwing observer block the actual repair below it. */
function fireUnpairedLinkSafely(
  cb: ((info: UnpairedLinkInfo) => void) | undefined,
  info: UnpairedLinkInfo,
): void {
  if (!cb) return;
  try {
    cb(info);
  } catch {
    // diagnostic-only callback; swallow
  }
}

function fireSeveredLinkSafely(
  cb: ((info: SeveredLinkInfo) => void) | undefined,
  info: SeveredLinkInfo,
): void {
  if (!cb) return;
  try {
    cb(info);
  } catch {
    // diagnostic-only callback; swallow
  }
}

/**
 * P-004: emit the near-cap pressure signal (a loud `console.warn` + the optional
 * `onNearPeerCap` event) when the shared swarm's live peer count first crosses
 * into the near-cap zone, so the otherwise-SILENT refusal of peer N+1 is
 * observable. Hysteresis (via {@link peerCapNearState}) makes it fire ONCE per
 * approach and re-arm after the count recedes, so it can be called on every
 * `connection` without spamming. No-op (returns null) when `maxPeers` or the
 * live count can't be read (minimal fakes). Exported for unit testing.
 */
export function reportPeerCapPressure(
  swarm: HyperswarmLike,
  onNearPeerCap?: (info: PeerCapInfo) => void,
): PeerCapInfo | null {
  const maxPeers =
    typeof swarm.maxPeers === 'number' && swarm.maxPeers > 0 ? swarm.maxPeers : undefined;
  if (!maxPeers) return null;
  const live = countLiveConnections(swarm);
  if (live === undefined) return null;
  const key = swarm as unknown as object;
  const near = live >= Math.ceil(maxPeers * PEER_CAP_NEAR_RATIO);
  if (!near) {
    // Re-arm so the NEXT approach to the cap warns again.
    if (peerCapNearState.get(key)) peerCapNearState.set(key, false);
    return null;
  }
  if (peerCapNearState.get(key)) return null; // already warned for this approach
  peerCapNearState.set(key, true);
  const atCap = live >= maxPeers;
  // WI-6063: attach the per-topic breakdown. Reporting "245/256" alone names the
  // pressure but withholds the diagnosis — the actionable question at the cap is
  // always WHICH topic is holding the budget.
  let topics: readonly TopicPeerShare[] = [];
  try {
    topics = swarmFairnessSnapshot(swarm);
  } catch {
    // diagnostic enrichment only — never let it suppress the cap signal itself
  }
  const info: PeerCapInfo = {
    liveConnections: live,
    maxPeers,
    atCap,
    ...(topics.length > 0 ? { topics } : {}),
  };
  // console.warn (a genuine defect/pressure signal — never fires in clean tests,
  // which stay well below 90% of maxPeers; same convention as the DHT-bootstrap
  // misconfig warn above).
  console.warn(
    `[swarm] ⚠ peer cap pressure: ${live}/${maxPeers} live peer connections ` +
      `(>= ${Math.round(PEER_CAP_NEAR_RATIO * 100)}% of the process-global maxPeers). ` +
      (atCap
        ? 'AT CAP — Hyperswarm will SILENTLY refuse further peers until a slot frees.'
        : 'Approaching cap — further peers will be silently refused once full.') +
      ' Raise PAPERCUSP_SWARM_MAX_PEERS or run on a larger host to grow the budget.' +
      // WI-6063: name the topics holding the budget, biggest first.
      (topics.length > 0
        ? ' Per-topic: ' +
          [...topics]
            .sort((a, b) => b.peers - a.peers)
            .map(
              (t) =>
                `${t.topicHex.slice(0, 8)}…=${t.peers}` +
                (t.fairShare !== null ? `/${t.fairShare}` : '') +
                (t.dialPaused ? ' (dial paused)' : ''),
            )
            .join(' ') +
          '.'
        : ''),
  );
  fireNearCapSafely(onNearPeerCap, info);
  return info;
}

/**
 * EI-18682571591024156 — the DHT SIGNALLING outcome for one connection, read off
 * the socket hyperswarm hands us.
 *
 * `hyperdht` computes `relayed` / `serverAddress` / `clientAddress` while
 * completing the Noise handshake as a DHT RPC, and our `patches/hyperdht+6.32.0`
 * patch exposes them on the returned `encryptedSocket` (`udxRelayed`,
 * `udxServerAddress`, `udxClientAddress`; plus `udxRelayHost`/`udxRelayPort` on
 * the relayed ACCEPT path). NOTHING in this repo read them, so a connection that
 * signalled fine and then never carried a byte was indistinguishable from a
 * working one — see {@link readWireStats}.
 *
 * `present` is an EXPLICIT presence witness, not a convenience: a shape that
 * synthesises `relayed: false` for an ABSENT reading makes "hyperdht said
 * not-relayed" and "we could not read it" identical to every consumer — the
 * absent-vs-zero trap this very bug class is about. Check `present` before
 * trusting any other field.
 */
export interface PeerConnectionPath {
  /** True only when the socket actually exposed at least one `udx*` reading. */
  present: boolean;
  /** hyperdht's own verdict: was the data path relayed rather than punched? */
  relayed?: boolean;
  /** Server-side address hyperdht signalled through (`host:port` when parseable). */
  serverAddress?: string;
  /** Client-side address hyperdht signalled through (`host:port` when parseable). */
  clientAddress?: string;
  /** Relay host/port on the relayed ACCEPT path (server.js half of the patch). */
  relayHost?: string;
  relayPort?: number;
  /**
   * WI-5943 — the address the UDX stream is ACTUALLY pointed at, read straight
   * off `rawStream` (plain `udx-native` instance props, so unlike the `udx*`
   * fields above these need no patch to be readable).
   *
   * This is the INDEPENDENT ground truth for {@link PeerConnectionPath.relayed},
   * and it exists because `relayed` on its own is not always evidence:
   *  - on the DIRECT ACCEPT path the patch sets `relayed: false` BY CONSTRUCTION
   *    (from which code path ran, not from a measurement), so a `false` there is
   *    a tautology that says nothing about whether the data path came up;
   *  - on a small isolated test DHT there may be no relay available at all, which
   *    FORCES `relayed: false` by topology rather than by a successful punch.
   * The address discriminates in both cases: a genuinely punched connection points
   * at the PEER's own address, a relayed one at the relay's. Read these ALONGSIDE
   * `relayed` — a `relayed: false` on its own is not proof of a punch.
   */
  remoteHost?: string;
  remotePort?: number;
  /**
   * WI-5980 — WHICH BRANCH in hyperdht resolved the address we dialled, and what
   * candidates it had. These exist because `relayed` + the addresses tell you the
   * data path was dead but not WHY the address was wrong.
   *
   * WI-6025 makes this a terminal branch discriminator:
   *  - `open`: unverified fast path; no punch.
   *  - `passive`: local firewall is open, so hyperdht waits passively; no punch.
   *  - `lan`: same-link shortcut (including its ping-failure exit); no punch.
   *  - `cannot-holepunch`: remote refused/cannot punch; no punch.
   *  - `holepunch-real`: a Holepuncher was actually constructed; this is the
   *    ONLY value admissible in a real-punch failure-rate denominator.
   *
   * Legacy bundles emitted the ambiguous value `holepunch` before WI-6025. Keep
   * reading it so old diagnostic corpora remain parseable, but never count it as
   * a proven attempt: it pooled the last four exits above into one value.
   *
   * `addressFromFallback` is the load-bearing one: hyperdht picks the first
   * NON-BOGON entry of `addresses4` and otherwise falls back to `serverAddress` —
   * which is only ever the OBSERVED SOURCE of an inbound packet, never a declared
   * listener. On an all-private-subnet deployment every candidate is a bogon
   * (`addresses4AllBogon`), so the fallback is the only reachable path and we
   * dial an address the peer may not own.
   */
  punchPath?:
    | 'open'
    | 'passive'
    | 'lan'
    | 'cannot-holepunch'
    | 'holepunch-real'
    | 'holepunch';
  addressFromFallback?: boolean;
  addresses4AllBogon?: boolean;
  addresses4?: Array<{ host?: string; port?: number; bogon?: boolean }>;
  remoteHolepunchable?: boolean;
  firewall?: number;
  punchStats?: { open?: number; consistent?: number; random?: number };
}

function formatUdxAddress(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  const addr = value as { host?: unknown; port?: unknown } | null | undefined;
  const host = typeof addr?.host === 'string' ? addr.host : undefined;
  const port = typeof addr?.port === 'number' ? addr.port : undefined;
  if (host && port !== undefined) return `${host}:${port}`;
  if (host) return host;
  return undefined;
}

/**
 * Read the DHT signalling outcome off a connection socket (see
 * {@link PeerConnectionPath}). Never throws — an unexpected/fake shape yields
 * `{ present: false }` rather than a fabricated verdict.
 */
export function extractConnectionPath(socket: unknown): PeerConnectionPath {
  const s = socket as
    | {
        udxRelayed?: unknown;
        udxServerAddress?: unknown;
        udxClientAddress?: unknown;
        udxRelayHost?: unknown;
        udxRelayPort?: unknown;
        udxPunchPath?: unknown;
        udxAddressFromFallback?: unknown;
        udxAddresses4AllBogon?: unknown;
        udxAddresses4?: unknown;
        udxRemoteHolepunchable?: unknown;
        udxFirewall?: unknown;
        udxPunchStats?: unknown;
      }
    | null
    | undefined;
  if (!s || typeof s !== 'object') return { present: false };
  const out: PeerConnectionPath = { present: false };
  if (typeof s.udxRelayed === 'boolean') {
    out.relayed = s.udxRelayed;
    out.present = true;
  }
  const serverAddress = formatUdxAddress(s.udxServerAddress);
  if (serverAddress) {
    out.serverAddress = serverAddress;
    out.present = true;
  }
  const clientAddress = formatUdxAddress(s.udxClientAddress);
  if (clientAddress) {
    out.clientAddress = clientAddress;
    out.present = true;
  }
  if (typeof s.udxRelayHost === 'string' && s.udxRelayHost.length > 0) {
    out.relayHost = s.udxRelayHost;
    out.present = true;
  }
  if (typeof s.udxRelayPort === 'number') {
    out.relayPort = s.udxRelayPort;
    out.present = true;
  }
  // WI-5943: the raw stream's own remote address — the independent check on
  // `relayed` (see PeerConnectionPath.remoteHost). Read defensively off
  // `rawStream`: same explicit-presence rule as everything above, so an
  // unreadable stream yields nothing rather than a fabricated address.
  const raw = (socket as { rawStream?: Record<string, unknown> } | null | undefined)?.rawStream;
  if (raw && typeof raw === 'object') {
    if (typeof raw.remoteHost === 'string' && raw.remoteHost.length > 0) {
      out.remoteHost = raw.remoteHost;
      out.present = true;
    }
    if (typeof raw.remotePort === 'number' && Number.isFinite(raw.remotePort)) {
      out.remotePort = raw.remotePort;
      out.present = true;
    }
  }
  // WI-5980: the branch/candidate fields (see PeerConnectionPath.punchPath). Same
  // explicit-presence rule as everything above — each is recorded only when the
  // socket actually exposed it, so "hyperdht took the holepunch path" and "we
  // could not read which path it took" never collapse into the same value. That
  // distinction is the whole point here: an absent punchPath rendered as 'open'
  // would fabricate exactly the finding this instrumentation exists to test.
  switch (s.udxPunchPath) {
    case 'open':
    case 'passive':
    case 'lan':
    case 'cannot-holepunch':
    case 'holepunch-real':
    case 'holepunch':
      out.punchPath = s.udxPunchPath;
      out.present = true;
      break;
  }
  if (typeof s.udxAddressFromFallback === 'boolean') {
    out.addressFromFallback = s.udxAddressFromFallback;
    out.present = true;
  }
  if (typeof s.udxAddresses4AllBogon === 'boolean') {
    out.addresses4AllBogon = s.udxAddresses4AllBogon;
    out.present = true;
  }
  if (Array.isArray(s.udxAddresses4)) {
    out.addresses4 = (s.udxAddresses4 as Array<Record<string, unknown>>).map((a) => ({
      host: typeof a?.host === 'string' ? a.host : undefined,
      port: typeof a?.port === 'number' ? a.port : undefined,
      bogon: typeof a?.bogon === 'boolean' ? a.bogon : undefined,
    }));
    out.present = true;
  }
  if (typeof s.udxRemoteHolepunchable === 'boolean') {
    out.remoteHolepunchable = s.udxRemoteHolepunchable;
    out.present = true;
  }
  if (typeof s.udxFirewall === 'number') {
    out.firewall = s.udxFirewall;
    out.present = true;
  }
  if (s.udxPunchStats && typeof s.udxPunchStats === 'object') {
    const ps = s.udxPunchStats as Record<string, unknown>;
    out.punchStats = {
      open: typeof ps.open === 'number' ? ps.open : undefined,
      consistent: typeof ps.consistent === 'number' ? ps.consistent : undefined,
      random: typeof ps.random === 'number' ? ps.random : undefined,
    };
    out.present = true;
  }
  return out;
}

/**
 * WI-5980 — flatten the branch/candidate diagnostics to TOP-LEVEL SCALAR keys for
 * the churn / never-came-up log lines.
 *
 * `console.*` renders objects via util.inspect at DEPTH 2. `path.addresses4` (an
 * array of objects) and `path.punchStats` sit one level deeper than that, so
 * logging them nested inside `path` prints `[Object]` — the fields would be
 * emitted and still unreadable, which is the worst kind of instrumentation
 * failure because the log looks like it worked. Emitting them as SIBLINGS of
 * `path` keeps them at depth 1, and keeps each value a scalar so the triage
 * parsers that scrape these records stay line-oriented.
 *
 * Absent-stays-absent, as everywhere else here: a field the socket never exposed
 * is omitted rather than rendered as a confident `false`/`0`.
 */
export function flattenPathDiagnostics(path: PeerConnectionPath): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (path.punchPath !== undefined) out.punchPath = path.punchPath;
  if (path.addressFromFallback !== undefined) out.addrFromFallback = path.addressFromFallback;
  if (path.addresses4AllBogon !== undefined) out.addrs4AllBogon = path.addresses4AllBogon;
  if (path.remoteHolepunchable !== undefined) out.remoteHolepunchable = path.remoteHolepunchable;
  if (path.firewall !== undefined) out.firewall = path.firewall;
  if (path.addresses4) {
    out.addrs4 =
      path.addresses4
        .map((a) => `${a.host ?? '?'}:${a.port ?? '?'}${a.bogon ? '(bogon)' : ''}`)
        .join(' ') || '(none)';
  }
  if (path.punchStats) {
    const p = path.punchStats;
    out.punchStats = `open=${p.open ?? '?'} consistent=${p.consistent ?? '?'} random=${p.random ?? '?'}`;
  }
  // EI-18700336768867234: also emit each field under the RAW `udx*` name
  // `patches/hyperdht+6.32.0.patch` actually stamps on the socket — the source of
  // truth for these fields. extractConnectionPath (above) renames udxPunchPath ->
  // punchPath etc. on the way in, and this function renames some again
  // (addresses4AllBogon -> addrs4AllBogon, addresses4 -> addrs4) on the way to the
  // log — so `grep -c udxPunchPath <serve.log>` finds ZERO on a fully-instrumented
  // run, which a name-keyed stale-bundle-vs-absent detector (elsewhere) cannot tell
  // apart from a genuinely un-rebuilt sidecar. Emit BOTH spellings (never rename —
  // preference order in EI-18700336768867234) rather than pick one: existing
  // consumers of the short keys are unaffected, and any grep/analyser keyed on the
  // patch's own `udx*` names now finds real data instead of a false refusal.
  if (path.punchPath !== undefined) out.udxPunchPath = path.punchPath;
  if (path.addressFromFallback !== undefined) out.udxAddressFromFallback = path.addressFromFallback;
  if (path.addresses4AllBogon !== undefined) out.udxAddresses4AllBogon = path.addresses4AllBogon;
  if (path.remoteHolepunchable !== undefined) out.udxRemoteHolepunchable = path.remoteHolepunchable;
  if (path.firewall !== undefined) out.udxFirewall = path.firewall;
  if (out.addrs4 !== undefined) out.udxAddresses4 = out.addrs4;
  if (out.punchStats !== undefined) out.udxPunchStats = out.punchStats;
  return out;
}

/**
 * EI-18682571591024156 — the UDX wire counters (`PeerWireStats` / `readWireStats`
 * / `dataPathProven`) now live in ./wire-stats.ts, a leaf module with no imports,
 * so topic-gossip.ts's severed-link liveness predicate (P-203 /
 * EI-22137294505377834) can read them without pulling in this whole module graph.
 * Re-exported here so every existing caller (and test) is unchanged.
 */
export { readWireStats, dataPathProven, type PeerWireStats } from './wire-stats';

/**
 * EI-18682571591024156 — what `onPeerConnected` actually proves.
 *
 * Handed to {@link JoinHarnessSwarmOpts.onPeerConnected} so no consumer can read
 * that callback as terminal success by accident: `signallingOnly` is always
 * `true` there, and `dataPathProven` is the honest tri-state at fire time
 * (essentially always `null` — zero bytes have crossed yet by construction).
 */
export interface PeerSignallingInfo {
  /** Hex Noise public key of the peer, when Hyperswarm surfaced it. */
  remotePublicKeyHex?: string;
  /** Peer IP, when the raw stream exposed it. */
  remoteIp?: string;
  /** hyperdht's signalling outcome (relayed / addresses). */
  path: PeerConnectionPath;
  /** UDX counters at fire time. */
  wire: PeerWireStats;
  /**
   * ALWAYS true on this callback: what fired is SIGNALLING success, not a
   * demonstrated data path. Named so a reader of the call site cannot mistake
   * one for the other.
   */
  signallingOnly: true;
  /** {@link dataPathProven} at fire time — `null` means "not demonstrated yet". */
  dataPathProven: boolean | null;
}

/** EI-18682571591024156 — a connection that signalled successfully and then died
 *  WITHOUT ever receiving a byte, reported at socket close. */
export interface DataPathNeverUpInfo {
  topicHex: string;
  remotePublicKeyHex?: string;
  remoteIp?: string;
  path: PeerConnectionPath;
  wire: PeerWireStats;
  /** How long the socket lived before closing (ms). */
  ageMs: number;
}

/** EI-18682571591024156 — live per-socket data-path evidence for one topic, for a
 *  UI/health check that must not report "connected" off the signalling signal. */
export interface DataPathSnapshotEntry {
  remotePublicKeyHex?: string;
  path: PeerConnectionPath;
  wire: PeerWireStats;
  /** Tri-state: true = bytes received, false = readable-and-zero, null = unknown. */
  proven: boolean | null;
}

/**
 * Pull the remote peer's Noise public key (hex) out of Hyperswarm's PeerInfo
 * (the 2nd arg of the `connection` event), defensively — the substrate's
 * per-peer accounting + DoS guard key off this. Returns undefined when the
 * shape isn't what we expect (older builds / test fakes).
 */
export function extractPublicKeyHex(peerInfo: unknown): string | undefined {
  const pk = (peerInfo as { publicKey?: { toString?: (enc: string) => string } } | null | undefined)
    ?.publicKey;
  if (pk && typeof pk.toString === 'function') {
    try {
      return pk.toString('hex');
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * SELF-HEAL re-peer cadence (WI-752 / FED-2). The per-harness substrate swarm
 * joins its topic ONCE; if an established peer connection later dies (idle /
 * timeout / reset / mid-replication death) or the topic's DHT announce ages out,
 * NOTHING re-announces + re-looks-up the topic, so the peer is never
 * rediscovered and federation stays DEAD until an operator restart re-runs the
 * whole join (the WI-559/WI-752 "federation sat dead ~7h" symptom). So
 * `joinHarnessSwarm` runs the SAME two-speed `discovery.refresh()` loop the
 * hive-directory gossip already uses (directory-swarm.ts):
 *
 *   - FAST cadence (`DEFAULT_SUBSTRATE_REFRESH_MS`) inside the post-join /
 *     post-peer-loss window (`DEFAULT_SUBSTRATE_FAST_WINDOW_MS`). The first DHT
 *     announce/lookup round reliably MISSES on a fresh node and nothing internal
 *     retries for minutes — `discovery.refresh()` is empirically the ONLY
 *     reliable reconnect driver (see directory-swarm.ts's module header + the
 *     swarm-chaos test, which only converges because it calls refresh itself).
 *   - SLOW keepalive (`DEFAULT_SUBSTRATE_SLOW_REFRESH_MS`) otherwise, so the
 *     topic stays announced (a FUTURE drop can always re-pair) without hammering
 *     the public DHT forever.
 *
 * Losing the last peer re-arms the fast window (the connection handler's socket
 * `close` listener) so reconnection is snappy. `refreshMs: 0` disables the loop
 * entirely — the byte-identical pre-WI-752 join (used by tests that drive
 * refresh by hand). The timer is `unref()`d (never holds the process open) and
 * cleared on `close()`.
 */
export const DEFAULT_SUBSTRATE_REFRESH_MS = 2500;
// D-045 (shared-hive-member-content-federation): widened 30_000 → 120_000. A
// freshly-SPAWNED sidecar process joining over the PUBLIC DHT reliably misses the
// first several announce/lookup rounds (cold start); with the old 30s fast window
// the next announce after 30s fell to the 60s SLOW cadence → a ~90s dead zone where
// two genuinely-separate machines never peer_connected (live run-12 'no peer in
// ~90s'; local testnet peers instantly so it was invisible to tests). 120s of 2.5s
// re-announces keeps a cold node aggressively discoverable until it pairs, then drops
// to the bounded SLOW keepalive — a real join-latency fix for a user joining a hive,
// still bounded (no forever-hammering). Re-armed on last-peer-loss for snappy reheal.
export const DEFAULT_SUBSTRATE_FAST_WINDOW_MS = 120_000;
export const DEFAULT_SUBSTRATE_SLOW_REFRESH_MS = 60_000;
/**
 * EI-13317: how long a topic that previously had a live peer must sit at
 * ZERO live peers — despite the refresh() self-heal loop actively ticking —
 * before escalating to a forced topic leave+rejoin (a fresh discovery
 * session/DHT announce). Forensics (tower↔VM rig, 2026-07-16/17) show
 * refresh() alone does NOT recover a link severed by a one-side restart: the
 * surviving side's fast-window ticks fire every ~2.5s with zero paired peers
 * for 20+ minutes; only a full process restart (== a fresh swarm.join) ever
 * reconnects. 5 minutes matches the "correct state" requirement that a
 * persistent severed link raise a loud signal instead of silently freezing.
 * `0` disables the escalation (status-quo pre-EI-13317 behavior).
 */
export const DEFAULT_SUBSTRATE_SEVERED_ESCALATION_MS = 5 * 60_000;

/**
 * EI-18662944242304583 rung (c): how long a topic may hold LIVE connections
 * while never once pairing its announce channel before escalating to a forced
 * topic leave+rejoin.
 *
 * Why this rung exists at the SWARM layer rather than in the replication-
 * liveness detector: every liveness axis is sampled from
 * `for (const log of admitted.values())` (boot.ts), so with zero ADMITTED
 * remote logs the sampler is never invoked and all three axes are dead code.
 * Admission requires an announce, an announce requires a paired announce
 * channel — so the entire pre-admission window is unobservable from down
 * there, and "wedged" and "healthy" both emit silence.
 *
 * Live proof (gate run 20260725-183831, frames a+b): 188 established
 * connections over 20.5 minutes with 91 announce-channel open attempts and
 * ZERO inbound frames in either direction — the data path was dead, so nothing
 * was ever admitted and the detector logged nothing at all. The moment one
 * connection finally paired (23:07:16.096) admission followed in 400ms and the
 * zombie axis fired correctly 15s later. The detector was never wrong; it was
 * never *reached*.
 *
 * 60s is deliberately far above a healthy pairing (milliseconds — the observed
 * good path was 4ms from channel create to `onopen`) and far below the 20.5min
 * blind window it closes. `0` disables the rung.
 */
export const DEFAULT_SUBSTRATE_UNPAIRED_ESCALATION_MS = 60_000;

/**
 * Minimum announce-channel open ATTEMPTS before rung (c) may fire. Guards the
 * single-connection case where one slow pairing is still in flight: the
 * failure this detects is a REPEATED one (91 attempts in the live proof), so
 * requiring a few attempts costs nothing and removes a whole false-positive
 * class.
 */
const MIN_UNPAIRED_ATTEMPTS = 3;

/**
 * Cap on rung (c) escalations per topic per process. A peer that genuinely
 * cannot speak the announce protocol (a partially-rolled-out fleet; a Protomux
 * build without `pair()`) would otherwise re-join every
 * `unpairedEscalationMs` forever. After the cap the axis goes quiet, having
 * emitted enough loud signals for forensics — a bounded repair attempt, never
 * an unbounded rejoin loop.
 */
const MAX_UNPAIRED_ESCALATIONS = 5;

/**
 * ── P-007: ONE shared refresh loop per swarm, instead of one timer per join ──
 *
 * `joinHarnessSwarm` used to arm its OWN `managedSetInterval`, and boot.ts calls
 * it once per MEMBER HARNESS against the process-singleton shared swarm
 * (`getSharedSwarm` — "one Hyperswarm per process"). So N shared hives meant N
 * independent timers, each waking the event loop on its own phase to run a full
 * per-topic tick: the plan's per-topic refresh storm. The tick WORK is
 * irreducibly per-topic (every topic needs its own DHT announce+lookup), but the
 * TIMERS are not — one loop can drive every registered join.
 *
 * Mirrors `topic-gossip.ts`'s single-loop pattern (ONE timer whose body is
 * `for (const st of topics.values())`, each entry applying its OWN cadence gate
 * inside the shared tick). The only difference is where per-entry state lives:
 * topic-gossip owns a Map of topic state, whereas each `joinHarnessSwarm` call
 * already owns its state in a closure that the connection handler, the
 * socket-close fast-window re-arm, `rejoinOwnSession` and the handle getters all
 * read and write. So an entry registers that closure as its `tick` rather than
 * re-homing a dozen mutable locals — same consolidation, without moving
 * load-bearing state out from under its existing writers.
 *
 * Scoped PER SWARM rather than module-global: in production the swarm is a
 * process singleton, so every harness's join lands on the SAME loop (one timer —
 * the whole point), while a test that builds its own fake swarm gets its own
 * loop and cannot leak ticks into the next test through module state. The
 * WeakMap entry dies with the swarm.
 *
 * Two load-bearing invariants this preserves (see the tick body for why):
 *   - the escalation ladders are evaluated on EVERY one of a join's ticks,
 *     independent of that join's refresh-cadence gate. An entry's `refreshMs`
 *     therefore gates the WHOLE tick body, exactly as its private timer's
 *     interval did, and the ladders keep their own thresholds inside it.
 *   - joins may request DIFFERENT cadences, so the shared timer is armed at the
 *     FINEST registered `refreshMs` and each entry computes its own due-ness
 *     against that base — never one shared cadence.
 */
type SwarmRefreshEntry = {
  /** this join's requested tick cadence — its OWN due-ness gate, not the loop's */
  readonly refreshMs: number;
  /** last time this entry's tick body actually ran */
  lastTickMs: number;
  /** this join's tick body (closes over that join's state) */
  readonly tick: (now: number) => void;
};

type SwarmRefreshLoop = {
  readonly entries: Set<SwarmRefreshEntry>;
  timer: ManagedHandle | null;
  /** the interval `timer` is currently armed at (0 = not armed) */
  baseMs: number;
  /** WI-6063: the swarm this loop drives — the per-topic fairness evaluator runs
   *  once per tick against it (see {@link evaluateSwarmFairness}). */
  readonly swarm: HyperswarmLike;
};

const swarmRefreshLoops = new WeakMap<object, SwarmRefreshLoop>();

/**
 * Arm (or re-arm, or stop) a loop's single timer so it ticks at the FINEST
 * cadence any registered entry asked for. Phase is irrelevant: every entry gates
 * on its own `lastTickMs`, so re-arming can never speed up or slow down an
 * already-registered entry's cadence.
 */
function syncSwarmRefreshTimer(loop: SwarmRefreshLoop): void {
  let base = 0;
  for (const e of loop.entries) base = base === 0 ? e.refreshMs : Math.min(base, e.refreshMs);
  if (base === loop.baseMs) return;
  if (loop.timer) {
    try {
      loop.timer.stop();
    } catch {
      /* no-op — best-effort teardown of the previous arming */
    }
    loop.timer = null;
  }
  loop.baseMs = base;
  if (base <= 0) return; // no entries left — stay unarmed
  loop.timer = managedSetInterval(
    'hyperbee-swarm-refresh',
    base,
    () => {
      const now = Date.now();
      // WI-6063: re-evaluate the per-topic peer-budget share ONCE per tick,
      // before the per-join bodies. Timer-driven by necessity, not convenience:
      // at the peer cap no `connection` events fire, so an evaluator hung off
      // connections could never resume a paused topic (see evaluateSwarmFairness).
      try {
        evaluateSwarmFairness(loop.swarm);
      } catch {
        // Fairness is an optimisation over a working swarm — it must never be
        // able to stop the refresh loop that keeps every join peered.
      }
      // Iterate a SNAPSHOT: a tick can force a rejoin, and a `close()` from
      // anywhere (including inside a tick) may deregister mid-iteration.
      for (const entry of [...loop.entries]) {
        if (!loop.entries.has(entry)) continue; // deregistered during this tick
        if (now - entry.lastTickMs < entry.refreshMs) continue; // not due yet
        entry.lastTickMs = now;
        try {
          entry.tick(now);
        } catch {
          // One join's tick must NEVER stop the shared loop from serving every
          // OTHER join on this swarm. A private timer had no such blast radius,
          // so consolidating without this guard would be a regression.
        }
      }
    },
    { category: 'lifecycle', instanced: true },
  );
}

/**
 * Register a join's tick on its swarm's shared refresh loop. Returns an
 * idempotent release that deregisters the entry and stops the shared timer once
 * the last join on that swarm has released.
 */
function registerSwarmRefresh(swarm: HyperswarmLike, entry: SwarmRefreshEntry): () => void {
  const key = swarm as unknown as object;
  let loop = swarmRefreshLoops.get(key);
  if (!loop) {
    loop = { entries: new Set(), timer: null, baseMs: 0, swarm };
    swarmRefreshLoops.set(key, loop);
  }
  const own = loop;
  own.entries.add(entry);
  syncSwarmRefreshTimer(own);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    own.entries.delete(entry);
    syncSwarmRefreshTimer(own);
  };
}

/**
 * ── WI-6063: per-topic connection fairness on the shared swarm ──
 *
 * THE BUG. `maxPeers` is a PROCESS-GLOBAL ceiling on the ONE shared Hyperswarm,
 * with no per-topic share. Every harness joins its own topic on that same swarm,
 * so a busy or large topic can consume the whole budget and the remaining topics
 * are starved — and Hyperswarm enforces the ceiling SILENTLY (peer N+1 simply
 * never connects, no error, no event), so the starvation is invisible. A topic
 * that joins LATE is the usual victim: the established topics already filled the
 * budget, and nothing ever hands a slot back.
 *
 * THE LEVER. `swarm.join()` returns a `PeerDiscoverySession` whose
 * `refresh({ client, server })` toggles that topic's CLIENT (lookup/dial) side
 * independently of its SERVER (announce) side. Turning `client` off stops the
 * topic enqueueing new dial candidates; it does NOT touch a single established
 * connection, and it is fully reversible. That makes it the one safe control
 * point here: the alternative levers are the firewall (topic-blind — Hyperswarm
 * only hands it a public key) and eviction (drops live peers, i.e. causes the
 * very harm we are fixing).
 *
 * THE METRIC. {@link contentPeerCountForTopic} — peers whose content-announce
 * channel is currently OPEN for the topic, i.e. peers this hive is genuinely
 * replicating with. Deliberately NOT hyperswarm's `peerInfo.topics`: that is
 * populated only on the client/lookup path (`_handlePeer`), so INBOUND peers
 * arrive with an empty topic list and any count built on it silently under-reads
 * an inbound-heavy topic. Announce-channel pairing is symmetric, so this metric
 * sees both directions. (It is also our own structure, where `peerInfo.topics`
 * is marked `TODO: remove on next major` upstream.)
 *
 * THE SAFETY PROPERTY. Fairness ENGAGES ONLY UNDER GLOBAL PRESSURE. Below
 * {@link FAIRNESS_ENGAGE_RATIO} of the ceiling there is no scarcity to arbitrate,
 * so every topic dials freely and this code is a no-op — the common case has
 * exactly zero behavioural delta. Under pressure, only topics ABOVE their share
 * are held back; a starved topic is never throttled, so the mechanism can only
 * ever move slots TOWARD the starved and never away.
 *
 * HONEST LIMITATION. This is CONVERGENT fairness, not instantaneous: pausing a
 * hog's dialling does not free slots it already holds, it stops it re-taking the
 * slots that churn frees, so the balance corrects as connections turn over. The
 * instantaneous alternative is eviction, which we deliberately reject — a fix
 * that drops healthy peers to prove a point is worse than the bug.
 */
export const FAIRNESS_ENGAGE_RATIO = 0.85;

/**
 * The per-topic floor. No topic is ever throttled below this many peers, however
 * many topics share the swarm — a fair share that rounds down to 1-2 peers would
 * make the "fix" itself a starvation mechanism on a host with many harnesses.
 * With the ≥256 floor from {@link resolveDefaultMaxPeers}, the floor only starts
 * binding past ~32 joined topics.
 */
export const MIN_PEERS_PER_TOPIC = 8;

/** One topic's registration in its swarm's fairness registry. */
type TopicFairnessEntry = {
  readonly topicHex: string;
  /**
   * Reads the topic's CURRENT discovery session. A getter, not a captured
   * session: `rejoinOwnSession` REPLACES the session on a forced rejoin, and a
   * captured reference would leave us toggling a destroyed one.
   */
  readonly session: () => { refresh?: (opts?: object) => unknown } | undefined;
  /** Last applied dial state — the latch that makes the callback edge-triggered. */
  paused: boolean;
  readonly onThrottle?: (info: TopicDialThrottleInfo) => void;
};

type SwarmFairnessState = {
  readonly entries: Map<string, TopicFairnessEntry>;
  /** The swarm itself, so the shared refresh tick can evaluate without a closure. */
  readonly swarm: HyperswarmLike;
};

const swarmFairness = new WeakMap<object, SwarmFairnessState>();

/**
 * Apply a dial-permission change to one topic, and fire the edge-triggered
 * callback. `server: true` is ALWAYS retained — `refresh()` throws when both
 * sides are false, and more importantly a paused topic must keep ANNOUNCING so
 * it can still be found and dialled BY peers; pausing is a decision to stop
 * competing for the dial budget, never to leave the hive.
 */
function applyTopicDialState(
  entry: TopicFairnessEntry,
  paused: boolean,
  ctx: { peers: number; fairShare: number; live: number; maxPeers: number; topicCount: number },
): void {
  if (entry.paused === paused) return; // level-based evaluator, edge-triggered effect
  const session = entry.session();
  const refresh = session?.refresh;
  if (typeof refresh !== 'function') return; // minimal fake / no session yet — stay unlatched
  try {
    // May reject asynchronously (a rejoin racing us); the next tick re-evaluates
    // from the real level, so a lost toggle self-corrects rather than sticking.
    void Promise.resolve(refresh.call(session, { client: !paused, server: true })).catch(() => {});
  } catch {
    return; // could not apply — do NOT latch, so the next tick retries
  }
  entry.paused = paused;
  const short = entry.topicHex.slice(0, 16);
  if (paused) {
    // A genuine pressure/defect signal (never fires in clean tests, which sit far
    // below the engage ratio) — same convention as reportPeerCapPressure above.
    console.warn(
      `[swarm] ⚠ peer-budget fairness: topic ${short}… holds ${ctx.peers} peers vs a fair share of ` +
        `${ctx.fairShare} (${ctx.live}/${ctx.maxPeers} live, ${ctx.topicCount} topics) — PAUSING its outbound ` +
        `dialling so starved topics can take the slots that free up. It keeps announcing and still accepts inbound peers.`,
    );
  } else {
    console.info(
      `[swarm] peer-budget fairness: topic ${short}… back within its share ` +
        `(${ctx.peers}/${ctx.fairShare}) — resuming outbound dialling.`,
    );
  }
  if (entry.onThrottle) {
    try {
      entry.onThrottle({
        topicHex: entry.topicHex,
        paused,
        peers: ctx.peers,
        fairShare: ctx.fairShare,
        liveConnections: ctx.live,
        maxPeers: ctx.maxPeers,
        topicCount: ctx.topicCount,
      });
    } catch {
      // diagnostic-only callback; swallow
    }
  }
}

/**
 * WI-6063: recompute every registered topic's dial permission from the CURRENT
 * level. Deliberately level-based rather than event-driven: at the cap no
 * `connection` events fire at all, so an evaluator hung off connections could
 * never RESUME a paused topic — it would starve it exactly like the bug it
 * fixes. Runs on the P-007 shared refresh tick (no new timer; repo rule).
 *
 * Exported for unit testing.
 */
export function evaluateSwarmFairness(
  swarm: HyperswarmLike,
  /** Test seam: how to read a topic's live peer count. Defaults to the real
   *  announce-channel gauge; injectable so the policy can be unit-tested without
   *  standing up real Protomux channels. */
  peerCountForTopic: (topicHex: string) => number = contentPeerCountForTopic,
): readonly TopicPeerShare[] {
  const state = swarmFairness.get(swarm as unknown as object);
  if (!state || state.entries.size === 0) return [];
  const entries = [...state.entries.values()];
  const maxPeers =
    typeof swarm.maxPeers === 'number' && swarm.maxPeers > 0 ? swarm.maxPeers : undefined;
  const live = countLiveConnections(swarm);
  const topicCount = entries.length;
  // Unknowable budget (minimal fake), or a single topic — there is no scarcity to
  // arbitrate. Release anything held so a fake/degraded read can never leave a
  // topic latched off.
  const engaged =
    maxPeers !== undefined &&
    live !== undefined &&
    topicCount > 1 &&
    live >= Math.ceil(maxPeers * FAIRNESS_ENGAGE_RATIO);
  if (!engaged) {
    for (const entry of entries) {
      applyTopicDialState(entry, false, {
        peers: peerCountForTopic(entry.topicHex),
        fairShare: 0,
        live: live ?? 0,
        maxPeers: maxPeers ?? 0,
        topicCount,
      });
    }
    return entries.map((entry) => ({
      topicHex: entry.topicHex,
      peers: peerCountForTopic(entry.topicHex),
      fairShare: null,
      dialPaused: entry.paused,
    }));
  }
  const fairShare = computeFairShare(maxPeers, topicCount);
  const shares: TopicPeerShare[] = [];
  for (const entry of entries) {
    const peers = peerCountForTopic(entry.topicHex);
    // STRICTLY greater: a topic sitting exactly AT its share is not a hog, and
    // throttling it would be the same off-by-one that starves the marginal topic.
    applyTopicDialState(entry, peers > fairShare, {
      peers,
      fairShare,
      live: live as number,
      maxPeers: maxPeers as number,
      topicCount,
    });
    shares.push({ topicHex: entry.topicHex, peers, fairShare, dialPaused: entry.paused });
  }
  return shares;
}

/**
 * WI-6063: read-only view of the fairness state for a swarm — the per-topic
 * budget breakdown, without applying anything. For tests, health checks and the
 * near-cap signal's `topics` field.
 */
export function swarmFairnessSnapshot(
  swarm: HyperswarmLike,
  peerCountForTopic: (topicHex: string) => number = contentPeerCountForTopic,
): readonly TopicPeerShare[] {
  const state = swarmFairness.get(swarm as unknown as object);
  if (!state || state.entries.size === 0) return [];
  const entries = [...state.entries.values()];
  const maxPeers =
    typeof swarm.maxPeers === 'number' && swarm.maxPeers > 0 ? swarm.maxPeers : undefined;
  const live = countLiveConnections(swarm);
  const engaged =
    maxPeers !== undefined &&
    live !== undefined &&
    entries.length > 1 &&
    live >= Math.ceil(maxPeers * FAIRNESS_ENGAGE_RATIO);
  const fairShare = engaged ? computeFairShare(maxPeers as number, entries.length) : null;
  return entries.map((entry) => ({
    topicHex: entry.topicHex,
    peers: peerCountForTopic(entry.topicHex),
    fairShare,
    dialPaused: entry.paused,
  }));
}

/**
 * The per-topic allowance under pressure: an even split of the ceiling, but
 * never below {@link MIN_PEERS_PER_TOPIC}. Pure + exported so the arithmetic —
 * including the floor that stops the fix becoming its own starvation mechanism
 * on a many-harness host — is directly testable.
 */
export function computeFairShare(maxPeers: number, topicCount: number): number {
  if (topicCount <= 0) return maxPeers;
  return Math.max(MIN_PEERS_PER_TOPIC, Math.floor(maxPeers / topicCount));
}

/**
 * Test seam: register a topic in a swarm's fairness registry directly, without
 * standing up a real `joinHarnessSwarm`. Returns the same release closure the
 * production path gets.
 */
export function _registerTopicFairnessForTests(
  swarm: HyperswarmLike,
  entry: {
    topicHex: string;
    session: () => { refresh?: (opts?: object) => unknown } | undefined;
    onThrottle?: (info: TopicDialThrottleInfo) => void;
  },
): () => void {
  return registerTopicFairness(swarm, { ...entry, paused: false });
}

/**
 * Register one topic in its swarm's fairness registry. Returns an idempotent
 * release that deregisters it AND resumes its dialling first — a join closing
 * while paused must never leave a destroyed session latched off in the registry,
 * and must never hand the next join a stale entry.
 *
 * Keyed by topicHex: several harnesses can share one topic, and they share one
 * discovery session, so the budget entry is per TOPIC, not per join.
 */
function registerTopicFairness(swarm: HyperswarmLike, entry: TopicFairnessEntry): () => void {
  const key = swarm as unknown as object;
  let state = swarmFairness.get(key);
  if (!state) {
    state = { entries: new Map(), swarm };
    swarmFairness.set(key, state);
  }
  const own = state;
  // First registration for this topic wins; a sibling join on the SAME topic
  // rides the existing entry rather than replacing a live one out from under it.
  if (!own.entries.has(entry.topicHex)) own.entries.set(entry.topicHex, entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = own.entries.get(entry.topicHex);
    if (current !== entry) return; // a sibling join owns this topic's entry
    if (current.paused) {
      // Restore the topic's own dialling before dropping it from the registry —
      // otherwise a close-while-paused leaves the underlying discovery session
      // permanently client-off for any sibling that re-registers it later.
      applyTopicDialState(current, false, {
        peers: contentPeerCountForTopic(current.topicHex),
        fairShare: 0,
        live: 0,
        maxPeers: 0,
        topicCount: own.entries.size,
      });
    }
    own.entries.delete(entry.topicHex);
  };
}

export function _resetSwarmFairnessForTests(swarm: HyperswarmLike): void {
  swarmFairness.delete(swarm as unknown as object);
}

export async function joinHarnessSwarm(
  opts: JoinHarnessSwarmOpts,
): Promise<SwarmHandle> {
  if (!opts.store) throw new Error('joinHarnessSwarm: store required');
  if (!opts.topic || opts.topic.length !== 32) {
    throw new Error('joinHarnessSwarm: topic must be a 32-byte Buffer');
  }
  if (!opts.swarm) throw new Error('joinHarnessSwarm: swarm required');

  const guard = opts.guard ?? getSwarmGuard();
  const topicHex = opts.topic.toString('hex');
  // WI-5923: this instance's slot in the shared per-(swarm,topic) forced-rejoin
  // coordinator (see its doc above `swarmJoinSocketTopics`) — a forced rejoin is
  // topic-wide, never scoped to just this harness. Registered once the initial
  // join succeeds (below); unregistered in `close()`.
  const topicRejoinCoordinator = getTopicRejoinCoordinator(opts.swarm, opts.topic, topicHex);
  const rejoinParticipantToken = Symbol(`joinHarnessSwarm:${topicHex.slice(0, 16)}`);
  // Stable across this handle's connection callbacks. The announce state is
  // keyed by muxer, so wrappers around one physical muxer stay deduplicated;
  // same-topic sibling handles receive distinct symbols.
  const announceRegistrationToken = Symbol(`announce:${topicHex.slice(0, 16)}`);
  let connectionCount = 0;
  let liveConnectionCount = 0;
  // WI-752 self-heal state: the start of the current FAST-refresh window (join
  // time; re-armed on every peer-socket `close`) and the last refresh tick (for
  // the slow keepalive). Declared before `handler` so the close listener can
  // re-arm the window.
  let fastWindowStartMs = Date.now();
  let lastRefreshMs = 0;
  // EI-13317 escalation-ladder state: last time the severed-link escalation
  // fired (rate-limits repeated escalations to once per severedEscalationMs).
  let lastEscalationMs = 0;
  // EI-18662944242304583 rung (c) state: last never-paired escalation (rate
  // limit) and how many have fired for this join (bounded by
  // MAX_UNPAIRED_ESCALATIONS so an un-pairable peer can't rejoin-loop forever).
  let lastUnpairedEscalationMs = 0;
  let unpairedEscalations = 0;
  // WI-5355: sockets THIS join currently considers connected (added on
  // `connection`, removed on that socket's own `close` — see the handler +
  // close listener below). Mirrors topic-gossip.ts's per-instance `sockets` Set;
  // `forceRejoinNow` sweeps this (filtered through the cross-harness
  // `swarmJoinSocketTopics` registry) before every leave()+join().
  const mySockets = new Set<unknown>();
  /** P-203: per-socket inbound-activity ledger behind `evictOwnSockets`'s
   *  liveness predicate — sampled every refresh tick below. NO connect grace
   *  here (unlike topic-gossip): `handle.forceRejoin()` is an explicit "this
   *  link is dead" lever and must not be blunted by a fresh-socket allowance. */
  const inboundLedger = new SocketInboundLedger();
  /** Per-live-socket release for THIS handle's announce registration. */
  const releaseAnnounceBySocket = new Map<unknown, () => void>();
  /**
   * EI-18687938054040755: sockets whose data path has ALREADY been reported as
   * proven, so the positive is logged exactly once per socket.
   *
   * Why this latch exists at all: until now the swarm logged the NEGATIVE
   * ("data path never came up", ~:1712) and logged the CONNECT as
   * `peer_connected(signalling-only) (data path NOT yet demonstrated)`, but
   * NEVER logged success — `dataPathProven` was computed at four call sites and
   * the `true` case was always discarded. That absence is not cosmetic: the
   * federation rig's load-bearing gate (`_fed_disc_probe` strict, in
   * bin/lib/federation-asserts.sh) greps `\[swarm\] peer_connected` with no
   * terminator, which MATCHES the signalling-only line — so "✓ holepunch
   * succeeded" / "✓ peers discovered" could pass on a connection that never
   * received a byte. There was no correct marker for it to gate on. This emits
   * one.
   */
  const dataPathProvenReported = new WeakSet<object>();
  const handler = (socket: unknown, peerInfo?: unknown): void => {
    connectionCount++;
    liveConnectionCount++;
    mySockets.add(socket);
    inboundLedger.track(socket, Date.now());
    // WI-5672/WI-5355/WI-5481 diagnostic (env-gated, off by default): the live
    // gate has shown a recurring HIGH-RATE reconnect churn on this exact
    // 'connection' handler (100s of opens/closes per two-frame session) that
    // correlates with content/plan-part/coord bidir-merge failures and an
    // empty joiner roster — but with NO visibility into WHY a socket closes
    // (clean vs erroring) or HOW LONG it lived before this instrumentation.
    // Set PAPERCUSP_SWARM_CHURN_DEBUG=1 to log each open/error/close with the
    // socket's lifetime + whether an 'error' preceded its 'close', so the next
    // live run can distinguish "genuine hyperswarm-level churn" from a local
    // bug (e.g. a repeated forced rejoin) without guessing from connection
    // counts alone. Never touches control flow — pure diagnostic, off by
    // default; symmetrical to hive-epoch-boot-deps.ts's PAPERCUSP_EPOCH_BOOT_DEBUG.
    const churnDbg = process.env.PAPERCUSP_SWARM_CHURN_DEBUG
      ? (msg: string, o?: unknown) => console.error('[swarm-churn]', msg, o ?? '')
      : () => {};
    const churnOpenedAtMs = Date.now();
    let churnSawError: string | null = null;
    // EI-18694945517907886: this `handler` is registered once PER JOINED
    // HARNESS on the same process-global shared swarm (see the N+1-listeners
    // doc near `setMaxListeners` below) — a single physical peer connection
    // therefore invokes it once per harness, all synchronously, for the SAME
    // socket. Every diagnostic LOG LINE emitted unconditionally below
    // (`[swarm-churn] open/error/close`, `[swarm] ⚠ data path NEVER came up`)
    // was therefore printed (joined harnesses + 1)x per real connection/close
    // — byte-identical blocks, differing only by ~1-3ms — silently inflating
    // every log-derived connection metric (measured: 78 close records / 39
    // distinct sockets == 2 harnesses joined; a 25-harness host sees 26x).
    // This directly corrupted the WI-5980 corpus analysis, which counts these
    // printed lines. Fix: print the diagnostic lines exactly once per socket,
    // using `swarmJoinSocketTopics` (already populated just below, keyed by
    // socket) as the "have I already logged this socket" latch — checked
    // BEFORE this call's own registration. This changes ONLY what gets
    // PRINTED: every harness's own `onDataPathNeverUp` callback (→
    // boot-history) still fires exactly as before, unconditionally, for every
    // joined harness — that's a separate per-harness functional signal
    // (symmetric with the unconditional per-harness `onPeerConnected` above),
    // not the log-text corpus this bug is about.
    const alreadyLoggedSocket = swarmJoinSocketTopics.has(socket as object);
    if (!alreadyLoggedSocket) churnDbg('open', { topic: topicHex.slice(0, 8), n: connectionCount });
    {
      let set = swarmJoinSocketTopics.get(socket as object);
      if (!set) {
        set = new Set<string>();
        swarmJoinSocketTopics.set(socket as object, set);
      }
      set.add(topicHex);
    }
    // An unclean peer disconnect (reset / timeout / mid-replication death)
    // emits 'error' on the connection socket; with no listener Node escalates
    // it to an UNCAUGHT EXCEPTION — i.e. a remote peer dying could crash this
    // whole host process. Found by the P-004 swarm-chaos test
    // (coord-system-e2e-testing-2026-06-10); hyperswarm's own docs require the
    // consumer to handle connection errors. The reconnect path is discovery's
    // job — the error itself is just churn.
    (socket as { on?: (ev: string, fn: (e: unknown) => void) => unknown })?.on?.('error', (e) => {
      churnSawError = e instanceof Error ? e.message : String(e);
      if (!alreadyLoggedSocket) churnDbg('error', { topic: topicHex.slice(0, 8), msg: churnSawError });
    });
    // WI-752 self-heal: re-arm the FAST refresh window when this peer socket
    // closes, so a dropped peer re-pairs snappily (the DHT round after a loss
    // reliably needs several refreshes — see directory-swarm.ts). Best-effort;
    // counting ALL peer closes (the shared swarm dedups one socket per peer
    // across topics) only ever schedules a few extra harmless refreshes.
    (socket as { once?: (ev: string, fn: () => void) => unknown })?.once?.('close', () => {
      const closeAgeMs = Date.now() - churnOpenedAtMs;
      const closeWire = readWireStats(socket);
      const closePath = extractConnectionPath(socket);
      // EI-18694945517907886: printed once per socket (see the latch doc
      // above) — every other joined harness reaches this same close event but
      // stays silent here.
      if (!alreadyLoggedSocket) {
        churnDbg('close', {
          topic: topicHex.slice(0, 8),
          ageMs: closeAgeMs,
          precededByError: churnSawError,
          // EI-18682571591024156: the close log now carries hyperdht's signalling
          // outcome + the UDX counters. `bytesReceived: 0` with a nonzero
          // `bytesTransmitted` IS the never-came-up signature (WI-5863), and it was
          // previously unavailable at every layer.
          path: closePath,
          // WI-5980: which branch resolved the address, flattened to depth 1 so
          // util.inspect cannot swallow it (see flattenPathDiagnostics).
          ...flattenPathDiagnostics(closePath),
          wire: closeWire,
        });
      }
      // EI-18684689702957309: hyperswarm itself destroys a socket with this
      // exact message (`ERR_DUPLICATE` in node_modules/hyperswarm/index.js)
      // the instant it detects two live connections to the same peer — by
      // construction that socket never carries a byte, so it is NOT the
      // WI-5863 "never came up" defect. Confirmed false-positive source:
      // swarm-chaos.test.ts red 13x in a row, 23/23 loud warns fired with
      // precededByError:'Duplicate connection' and ageMs in [1,19] — a
      // near-instant teardown, nothing like WI-5863's measured 13000ms+
      // deaths on the live rig. Left unguarded this also fed
      // `onDataPathNeverUp` → boot-history `replication_stalled` events,
      // inflating any stall count taken from that log under reconnect churn.
      const isDuplicateConnectionTeardown = churnSawError === 'Duplicate connection';
      // EI-18682571591024156: a socket that signalled successfully and closed
      // WITHOUT ever receiving a byte never had a data path — the failure that
      // `peer_connected` actively mis-reported as success. Loud + unconditional
      // otherwise (not behind the churn-debug env gate): this is a genuine
      // defect signal, it is rare on a healthy link, and its absence is
      // exactly what redirected WI-5863's investigation to the wrong layer
      // for hours.
      if (dataPathProven(closeWire) === false && !isDuplicateConnectionTeardown) {
        // EI-18694945517907886: the PRINTED warning is deduped per socket
        // (same latch as above — this text is what the WI-5980 corpus parses
        // and was measured 2-26x inflated). `onDataPathNeverUp` below is left
        // UNGATED: it still fires for every joined harness, unchanged — that
        // callback is a per-harness functional signal into boot-history, not
        // the log-text corpus this fix targets (see the latch doc above).
        if (!alreadyLoggedSocket) {
          console.warn(
            '[swarm] ⚠ data path NEVER came up for a peer that reported connected — ' +
              'the Noise handshake completed as a DHT RPC (signalling success) but zero bytes ' +
              'were ever received on the UDX stream. `peer_connected` for this peer was a ' +
              'false success report, not a working connection.',
            {
              topicHex,
              remotePublicKeyHex,
              remoteIp,
              ageMs: closeAgeMs,
              precededByError: churnSawError,
              path: closePath,
              // WI-5980: the branch that chose this (unreachable) address, flattened
              // to depth 1 so util.inspect cannot swallow it. On this record in
              // particular `addrFromFallback` + `addrs4AllBogon` say whether the
              // address was a real advertisement or a guess at the packet source.
              ...flattenPathDiagnostics(closePath),
              wire: closeWire,
            },
          );
        }
        try {
          opts.onDataPathNeverUp?.({
            topicHex,
            remotePublicKeyHex,
            remoteIp,
            path: closePath,
            wire: closeWire,
            ageMs: closeAgeMs,
          });
        } catch {
          // diagnostic-only callback; swallow
        }
      }
      fastWindowStartMs = Date.now();
      liveConnectionCount = Math.max(0, liveConnectionCount - 1);
      // WI-5355: this socket genuinely closed (Hyperswarm's own `close` handler
      // prunes it from both `connections` and the internal `_allConnections` in
      // the SAME synchronous tick — verified against node_modules/hyperswarm —
      // so a real close never needs eviction help). Prune our own bookkeeping so
      // a later forceRejoinNow doesn't waste a destroy() on an already-dead ref.
      mySockets.delete(socket);
      inboundLedger.forget(socket);
      releaseAnnounceBySocket.get(socket)?.();
      releaseAnnounceBySocket.delete(socket);
      swarmJoinSocketTopics.get(socket as object)?.delete(topicHex);
    });
    const remotePublicKeyHex = extractPublicKeyHex(peerInfo);
    const remoteIp = extractRemoteIp(socket);

    // Drop an already-banned peer BEFORE replicating (sync). The constructor
    // firewall rejects banned *keys* pre-handshake, but two cases land here: a
    // connection already in flight when the ban took effect, and any connect
    // from a banned IP (the key-only firewall can't see IPs). ban() doesn't
    // close a live connection (P-004 / D-003), so we destroy the socket.
    if (
      (remotePublicKeyHex && guard.isBannedKey(remotePublicKeyHex)) ||
      (remoteIp && guard.isBannedIp(remoteIp))
    ) {
      destroySocket(socket);
      fireSafely(opts.onPeerRejected, remotePublicKeyHex, remoteIp);
      return;
    }

    // Per-connection rate-limit (P-005). Over the ceiling → the guard bans the
    // key + IP (future connects are firewall-/handler-rejected) and we drop this
    // tripping connection. Fire-and-forget: the in-memory limiter is a microtask,
    // and we don't block replication of legitimate peers on it.
    const socketObj = typeof socket === 'object' && socket !== null ? (socket as object) : null;
    if (!socketObj || !guardCountedSockets.has(socketObj)) {
      if (socketObj) guardCountedSockets.add(socketObj);
      void guard
        .recordConnection(remotePublicKeyHex, remoteIp)
        .then((v) => {
          if (v.allow) return;
          destroySocket(socket);
          const cb = v.reason === 'rate_limited' ? opts.onPeerRateLimited : opts.onPeerRejected;
          fireSafely(cb, remotePublicKeyHex, remoteIp);
        })
        .catch(() => {});
    }

    try {
      // SUBSTRATE_SIDECAR Option B (WI-604): offer the raw socket to the sidecar
      // for replication. When it CLAIMS the socket (truthy), the merkle-verify
      // CPU + replication RSS run in the sidecar and we MUST NOT also replicate
      // in-process. When it declines (no sidecar / not wired) — or the seam is
      // omitted (flag OFF, the default) — fall through to the byte-identical
      // in-process path. A throw is treated as declined (fail-safe to local).
      let offloaded = false;
      if (opts.offloadReplication) {
        try {
          offloaded = opts.offloadReplication(socket, peerInfo) === true;
        } catch {
          offloaded = false; // fail-safe → in-process replication below
        }
      }
      if (!offloaded) {
        // corestore.replicate(socket) plugs the corestore into the peer's
        // connection as an EXTERNAL stream (replaces the old replicate(true) +
        // manual bidi pipe). This both starts Hypercore replication AND attaches
        // the shared muxer at `socket.userData` — which the announce channel then
        // rides (spike Step 5). corestore handles the stream lifecycle.
        opts.store.replicate(socket);
      }
      // Open the announce channel on the SAME connection's muxer: exchange
      // signed announces so admitted peer logs get aggregated (Model B Stage 4b).
      // NOTE (Option B caveat): when `offloaded` is true the raw socket has been
      // handed to the sidecar, so this in-process announce channel cannot ride
      // it — admission must move to / be driven from the sidecar in the full
      // cutover. See substrate-replication-offload.ts "KNOWN LIMITATION".
      // A connection event may be replayed for the same socket. Release this
      // handle's prior registration first; the stable token keeps wrappers
      // around one muxer deduplicated while siblings remain isolated.
      releaseAnnounceBySocket.get(socket)?.();
      const releaseAnnounce = openAnnounceChannel(socket, opts.topic, {
        ourAnnounce: opts.ourAnnounce,
        buildOurAnnounce: opts.buildOurAnnounce,
        onAnnounce: opts.onAnnounce,
        registrationKey: announceRegistrationToken,
      });
      releaseAnnounceBySocket.set(socket, releaseAnnounce);
      // P-201: register the pot-git serve plane on the SAME connection/muxer
      // the announce channel just rode — additive, never-throwing, no-op when
      // `hiveGitServe` is omitted (every non-pot-git harness, unchanged).
      if (opts.hiveGitServe) {
        // WI-3641: default the scope-repo authorization resolver to the
        // signed-hello registry's verified-device lookup unless the caller
        // already supplied one — every real caller wants this; only a
        // hermetic test wiring its own resolver would ever override it.
        wireHiveGitServe(socket, opts.topic, {
          ...opts.hiveGitServe,
          resolvePeerDevicePubkey:
            opts.hiveGitServe.resolvePeerDevicePubkey ?? resolveVerifiedDevicePubkeyForSocket,
        });
      }
      // WI-3583: register the dial-hello handshake on the SAME connection so
      // this device's live socket becomes resolvable by device_pubkey for a
      // REAL cross-machine fetch (additive, never-throwing — see
      // peer-dial-registry.ts's header for why this rides its own channel
      // rather than extending wireHiveGitServe's wire format).
      if (opts.hiveGitDial) {
        wireHiveGitDial(socket, opts.topic, opts.hiveGitDial.selfDevicePubkeyBase64, opts.hiveGitDial.sign);
      }
    } catch (e) {
      releaseAnnounceBySocket.get(socket)?.();
      releaseAnnounceBySocket.delete(socket);
      // WI-5895: a throw here (store.replicate / openAnnounceChannel /
      // wireHiveGitServe / wireHiveGitDial) means this socket completed the
      // Noise handshake and LOOKS alive on every liveness check, but is
      // incapable of ever ACKing/replicating a byte — a zombie connection.
      // This used to be swallowed silently, so the only visible symptom was a
      // ~13s UDX RTO-exhaustion timeout (UV_ETIMEDOUT) with nothing pointing
      // at the cause (the WI-5863 diagnosis). Two durable fixes, not a
      // diagnostic-log-only patch:
      //   1. Fail LOUDLY, with enough context to diagnose immediately instead
      //      of inferring it 13s later from a generic timeout.
      //   2. Tear the half-wired connection down NOW instead of leaving it
      //      looking alive for the full RTO-exhaustion window — the peer can
      //      then fail fast + redial against a real error instead of quietly
      //      waiting out a timeout that looks like network flakiness.
      // The swarm handler itself must still never throw (a peer's connection
      // failure can't crash every other peer's handling) — destroySocket is
      // its own best-effort try/catch, and console.error never throws.
      console.error(
        '[swarm] replication wiring failed for peer — tearing connection down (never silently swallowed)',
        {
          topicHex: opts.topic.toString('hex'),
          remotePublicKeyHex,
          remoteIp,
          error: e instanceof Error ? (e.stack ?? e.message) : String(e),
        },
      );
      destroySocket(socket);
      // Don't fire onPeerConnected / count this peer as live below — a
      // connection whose wiring threw never actually replicated anything.
      return;
    }
    if (opts.onPeerConnected) {
      try {
        // EI-18682571591024156: hand the callback an explicit statement of what
        // this fire PROVES (signalling, not a data path) plus hyperdht's own
        // signalling outcome — so a downstream log/UI/health check can render
        // the truth instead of an outcome-named precondition.
        const wire = readWireStats(socket);
        opts.onPeerConnected(remotePublicKeyHex, {
          remotePublicKeyHex,
          remoteIp,
          path: extractConnectionPath(socket),
          wire,
          signallingOnly: true,
          dataPathProven: dataPathProven(wire),
        });
      } catch {
        // Diagnostic-only callback; swallow.
      }
    }
    // P-004: now that this peer is live, check the process-global peer budget and
    // loudly surface near-cap pressure BEFORE the next peer is silently refused.
    reportPeerCapPressure(opts.swarm, opts.onNearPeerCap);
  };

  opts.swarm.on('connection', handler);
  // Shared-swarm late join: a socket opened by an EARLIER topic's join (the
  // hive-directory gossip, another harness) never re-emits 'connection', so a
  // topic joined later must attach replication + the announce channel to the
  // EXISTING sockets itself — otherwise two peers already connected via the
  // directory silently never federate the harness (found by the packaged
  // browse→join→federate smoke).
  try {
    for (const socket of opts.swarm.connections ?? []) {
      const pk = (socket as { remotePublicKey?: unknown } | null)?.remotePublicKey;
      try {
        handler(socket, pk ? { publicKey: pk } : undefined);
      } catch {
        // per-socket best-effort — a bad existing socket can't block the join
      }
    }
  } catch {
    // connections iteration is best-effort (absent on minimal fakes)
  }
  // Brief 10 / WI-1089 — exception-safe setup after the 'connection' listener is
  // registered (above). swarm.join() / the refresh-timer setup can throw — most
  // plausibly on a degraded long-running federated node (e.g. EMFILE when the
  // DHT opens its announce socket). If one does, the listener we just added
  // would be ORPHANED on the process-singleton shared swarm with no handle to
  // remove it, and boot.ts's join-retry loop (armSwarmJoinRetry) re-calls
  // joinHarnessSwarm on every failed attempt — so a flapping join would
  // accumulate one leaked 'connection' listener per retry, unbounded, with
  // setMaxListeners(0) hiding the count. Undo the listener (+ any shared-refresh
  // registration) on any setup failure so a failed join leaks nothing.
  let releaseRefresh: (() => void) | null = null;
  /** WI-6063: this topic's slot in the swarm-wide peer-budget fairness registry. */
  let releaseFairness: (() => void) | null = null;
  // Hoisted above the try block (was `let discovery = ...` scoped to the try
  // block) so `forceRejoinNow` — defined once, below, and called both by the
  // escalation ladder tick and by `handle.forceRejoin()` — can reassign it.
  let discovery: ReturnType<HyperswarmLike['join']> | undefined;
  /**
   * WI-5355: true when `socket` currently holds ZERO live registrations across
   * EVERY harness/topic sharing it (the cross-harness `swarmJoinSocketTopics`
   * registry) — i.e. every join that once considered it connected has since
   * seen it close, yet the socket OBJECT itself never fired its own `close`
   * (a true zombie: still open at the transport layer, doing nothing for
   * anyone). Mirrors topic-gossip.ts's `isSocketIdleAcrossAllTopics` — see
   * that function's doc for the full hyperswarm `_handlePeer`/`_allConnections`
   * trace this is defending against.
   */
  const isSocketIdleAcrossAllTopics = (socket: unknown): boolean => {
    const set = swarmJoinSocketTopics.get(socket as object);
    return !set || set.size === 0;
  };

  /**
   * WI-5355: best-effort evict a zombie socket — one every harness/topic
   * sharing it has already stopped relying on, but that never fired its own
   * `close` — so the NEXT `leave()+join()` can result in a genuinely fresh
   * connection attempt instead of `_handlePeer` silently no-op'ing against a
   * stale `_allConnections` entry (confirmed by reading node_modules/hyperswarm:
   * `connections`/`_allConnections` are only pruned together, synchronously, on
   * the socket's OWN `close` event — a socket that never closes blocks
   * rediscovery of that peer forever). Duck-typed `.destroy()`, same convention
   * hyperswarm's own duplicate-connection handling uses internally
   * (`_handleServerConnection`'s `existing.destroy(...)`).
   */
  const evictIdleZombieSocket = (socket: unknown): void => {
    try {
      (socket as { destroy?: (err?: Error) => void }).destroy?.(
        new Error('papercusp: WI-5355 zombie-socket eviction on forced topic rejoin'),
      );
    } catch {
      /* best-effort — a socket that can't be destroyed is left for Hyperswarm's own cleanup */
    }
  };

  /**
   * The actual leave+rejoin action, shared by the severed-link escalation
   * tick (rung (a)) and the external `forceRejoin()` lever on the handle
   * (rung (b) callers — see the SwarmHandle.forceRejoin doc). A fresh join
   * re-arms the fast self-heal window too, same as a cold boot would.
   *
   * WI-5355: rung (a) fires only once THIS join's own `liveConnectionCount`
   * hits zero, which (per the trace above) means `mySockets` is already empty
   * by the time we get here — nothing to evict, byte-identical to before this
   * fix. Rung (b) — `handle.forceRejoin()` — is exactly the opposite case: its
   * own doc's motivating scenario is a socket that stays live (never closes)
   * while replication silently dies, i.e. precisely the socket still sitting in
   * `mySockets`. For each such socket: first UNREGISTER this topic's own claim
   * on it (proactively performing the bookkeeping a genuine `close` would do),
   * THEN destroy it.
   *
   * EI-13317/WI-5481 (shared-socket eviction DEADLOCK): the original guard only
   * destroyed a socket if NO other harness/topic still claimed it
   * (`isSocketIdleAcrossAllTopics`) — "never touch a socket another join still
   * needs". But ONE peer socket is muxed across every harness sharing that peer
   * (the live-fed rig runs hello-world-pot + hello-world + papercusp over a
   * single connection). When the peer restarts, that shared socket half-opens
   * (stays live at the transport layer, dead for replication) and ALL of those
   * topics go `connected_never_replicated` at once. Each topic's forced rejoin
   * then refused to evict — the OTHERS still claimed the same dead socket — so
   * NOBODY evicted it and the connection sat connected-but-dead until the OS TCP
   * timeout finally closed it ~6 min later (full-suite gate RED: forced-rejoin
   * fired promptly but replicator re-attach took 341-378s, past the 90s SLA).
   * Reaching a FORCED rejoin means this topic's link is already proven dead, and
   * a dead handshake is dead for EVERY topic muxed over the same socket — so we
   * now destroy it unconditionally. The destroy fires the socket's own `close`,
   * every sharing topic prunes cleanly, and Hyperswarm redials a fresh
   * connection that re-attaches replication for all of them within seconds. (The
   * cost — a brief reconnect blip for a co-tenant topic that was genuinely
   * healthy on the same peer — is bounded by the redial and far cheaper than a
   * multi-minute federation freeze; a forced rejoin is a rare recovery action.)
   *
   * WI-5923 (topic-scoped rejoin): the actual leave()+rejoin() sequence below
   * used to run inline, scoped to only THIS `joinHarnessSwarm` instance —
   * including a raw `opts.swarm.leave(opts.topic)`, the PROCESS-WIDE teardown
   * that destroys every SIBLING harness's still-live session on the same
   * (per-Hive) topic with no callback/event to warn them (see the
   * `TopicRejoinCoordinator` doc above `swarmJoinSocketTopics`). It now
   * delegates to the shared per-(swarm,topic) coordinator, which evicts every
   * registered sibling's dead sockets, performs ONE real topic-wide
   * `swarm.leave()`, then has every sibling — not just this one — rejoin onto
   * the fresh discovery. This function's own eviction/rejoin behavior
   * (`evictOwnSockets` / `rejoinOwnSession` below) is BYTE-IDENTICAL to what
   * used to run inline here; only the orchestration moved out.
   */
  const evictOwnSockets = (escalating: boolean): void => {
    // WI-6324 explicit-presence diagnostic. A forced rejoin is a rare recovery
    // action, so one line per pass is cheap — and its ABSENCE of detail is what
    // made "escalated but never reconnected" undiagnosable twice: the eviction
    // half could silently decline to evict ANYTHING (see the WI-5971 data-path
    // skip below) and look identical, from every log, to a clean eviction that
    // simply failed to re-dial. State the outcome positively instead: how many
    // sockets were considered, how many were actually destroyed, and how many
    // were SKIPPED as having a proven live data path — with the wire counters
    // the decision was made on.
    const considered = mySockets.size;
    let evicted = 0;
    let skippedLiveDataPath = 0;
    let skippedRecentInbound = 0;
    const wireDetail: string[] = [];
    const now = Date.now();
    const livenessWindowMs =
      opts.socketLivenessWindowMs ??
      Math.min(
        DEFAULT_SOCKET_LIVENESS_WINDOW_MS,
        opts.severedEscalationMs ?? DEFAULT_SUBSTRATE_SEVERED_ESCALATION_MS,
      );
    for (const socket of mySockets) {
      // WI-5971: WI-5923 made this function fire for EVERY sibling registered
      // on the same (swarm,topic) whenever ANY ONE participant's own link
      // escalates to a forced rejoin — not just the escalating instance
      // itself. That broke this function's original premise ("reaching a
      // forced rejoin means THIS topic's link is already proven dead"),
      // which only held when it ran solely for the instance whose own
      // detector fired. A sibling's socket can have a fully live,
      // actively-replicating data path (proven via readWireStats/
      // dataPathProven — real bytesReceived across many packets) purely
      // because a CO-TENANT topic on the same swarm died. Destroying it
      // anyway is a false-positive zombie eviction (ratified via live rig
      // evidence: 8/8 closed sockets in one frame carried 7472-8589 bytes
      // received across 87-146 packets). Skip — never touch — any socket
      // with a DEMONSTRATED live data path; only a genuinely
      // dead-or-unproven one still gets evicted below.
      const wire = readWireStats(socket);
      const proven = dataPathProven(wire);
      // P-203 / EI-22137294505377834: the RECENT-DELTA reading — did this
      // socket's bytesReceived advance within the liveness window? Unlike
      // `proven` (cumulative), a zombie cannot satisfy it, and a socket that is
      // busy for OTHER topics/pots muxed over the same peer connection does —
      // which is what the tower kept destroying (measured 2026-09-02 08:27:57Z:
      // role=escalating considered=1 evicted=1 wire=[br=783878 pr=6667]).
      const recent = inboundLedger.recentlyLive(socket, now, livenessWindowMs);
      if (wireDetail.length < 4) {
        wireDetail.push(
          `[br=${wire.bytesReceived ?? '?'} pr=${wire.packetsReceived ?? '?'} proven=${proven === null ? 'unknown' : proven} ` +
            `recent=${recent === null ? 'unknown' : recent}]`,
        );
      }
      // WI-6324: this guard applies to SIBLINGS ONLY — never to the participant
      // whose own detector fired this rejoin.
      //
      // WI-5971 added it because WI-5923 made this function run for every
      // participant registered on the (swarm, topic), so a topic that never
      // escalated could have a healthily-replicating socket destroyed just
      // because a CO-TENANT topic died. That reasoning is sound, and for a
      // sibling it still holds — but it was applied to ALL participants, which
      // silently disabled the eviction for the ESCALATING one and so undid
      // EI-13317's entire fix. `dataPathProven` reads a CUMULATIVE, monotone
      // counter (`bytesReceived > 0`), so it cannot mean "replicating now"; it
      // means "has ever received a byte" — which is true of every socket that
      // completed a Noise handshake, INCLUDING a zombie that has replicated
      // nothing since. Measured on the WI-6324 repro: the zombie socket sat at
      // br=988 pr=3 → proven=true → considered=1 evicted=0, so the forced
      // rejoin evicted nothing, hyperswarm still believed the peer connected,
      // never re-dialled, and the repair ladder detected-but-never-healed.
      //
      // Reaching a forced rejoin as the ESCALATING participant is itself the
      // positive evidence that this link is dead, and a dead handshake is dead
      // for every topic muxed over the same socket (EI-13317) — so it evicts
      // unconditionally, exactly as it did before WI-5971. A sibling that is
      // ALSO zombied is not stranded by this: its own detector escalates
      // independently, and it is the escalating participant on that pass.
      //
      // P-203 refinement of BOTH rules above: a socket whose counter ADVANCED
      // within the liveness window is live for something — spare it in every
      // role (the escalating participant's own link on this topic is dead, but
      // the peer is not: it stopped serving this topic, or this topic's channel
      // wedged, and the channel re-open + DHT rejoin below still run). A socket
      // with a frozen counter is evicted in every role once it has been
      // sampled (a zombie sibling no longer waits for its own detector). The
      // cumulative `proven` rule survives only where the ledger has NO
      // evidence yet (untracked / never sampled), and only for a sibling —
      // exactly WI-5971's original guard.
      if (recent === true) {
        skippedRecentInbound++;
        continue;
      }
      if (proven === true && !escalating && recent === null) {
        skippedLiveDataPath++;
        continue;
      }
      swarmJoinSocketTopics.get(socket as object)?.delete(topicHex);
      // Diagnostic-only: note when we are breaking the shared-socket deadlock
      // (destroying a socket another topic still claims). Never let a throwing
      // console block the eviction below (same VITEST-gating as elsewhere).
      if (!isSocketIdleAcrossAllTopics(socket) && !process.env.VITEST) {
        try {
          console.error(
            `[swarm] force-evicting a peer socket still shared with other topics ` +
              `(topic ${topicHex.slice(0, 16)}…) — a forced rejoin means the link is ` +
              `proven dead for every muxed topic; breaking the shared-socket ` +
              `eviction deadlock (EI-13317/WI-5481).`,
          );
        } catch {
          /* diagnostic-only; swallow */
        }
      }
      evictIdleZombieSocket(socket);
      mySockets.delete(socket);
      evicted++;
    }
    try {
      console.info(
        `[swarm] force-rejoin eviction topic=${topicHex.slice(0, 16)}… ` +
          `role=${escalating ? 'escalating' : 'sibling'} considered=${considered} ` +
          `evicted=${evicted} skippedLiveDataPath=${skippedLiveDataPath} ` +
          `skippedRecentInbound=${skippedRecentInbound} livenessWindowMs=${livenessWindowMs}` +
          (wireDetail.length > 0 ? ` wire=${wireDetail.join('')}` : ''),
      );
    } catch {
      /* diagnostic-only; never let logging break the eviction */
    }
  };
  const rejoinOwnSession = (): void => {
    discovery = opts.swarm.join(opts.topic, { server: true, client: true });
    fastWindowStartMs = Date.now();
  };
  async function forceRejoinNow(): Promise<void> {
    // WI-6324: identify THIS instance as the escalating participant — both
    // callers (the ladder tick, rung (a), and `handle.forceRejoin()`, rung (b))
    // are by definition the instance whose own link is proven dead.
    await topicRejoinCoordinator.requestRejoin(rejoinParticipantToken);
  }
  try {
    discovery = opts.swarm.join(opts.topic, { server: true, client: true });
    // WI-5923: register THIS instance with the shared topic-wide rejoin
    // coordinator now that the initial join has actually succeeded (a failed
    // join below throws before this point and unwinds via the catch block, so
    // a never-successfully-joined instance is never registered to receive a
    // sibling's rejoin callback).
    topicRejoinCoordinator.register(rejoinParticipantToken, { evictOwnSockets, rejoinOwnSession });
    // WI-6063: enrol this topic in the shared swarm's peer-budget fairness
    // registry now that it genuinely holds a discovery session. `session` is a
    // GETTER, not the session value: `rejoinOwnSession` reassigns `discovery` on
    // a forced rejoin, and a captured reference would leave the evaluator
    // toggling a destroyed session while the live one dialled on unthrottled.
    releaseFairness = registerTopicFairness(opts.swarm, {
      topicHex,
      session: () => discovery,
      paused: false,
      onThrottle: opts.onTopicDialThrottle,
    });
    // Best-effort flush — some Hyperswarm builds expose this, some
    // don't. Either way, returning before flush is fine because peers
    // can connect any time after the join call returns.
    if (discovery && typeof discovery.flushed === 'function') {
      // P-302: this used to be `.catch(() => {})`. The flush is the ONLY signal
      // that the announce/lookup round actually reached the DHT, and discarding
      // its rejection is one of the four stacked swallows that let a completely
      // unreachable transport keep printing "joined topic" forever. Returning
      // before the flush settles is still fine (peers may connect at any point
      // after `join()` returns) — but a REJECTION is now reported.
      void discovery.flushed().catch((e: unknown) => {
        console.warn(
          `[swarm] ⚠ topic ${topicHex.slice(0, 12)} join flush REJECTED — this topic's announce/` +
            `lookup did not complete, so peers may never discover it: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }

    // ── WI-752 / FED-2 self-heal re-peer loop ──
    // Re-run this topic's DHT announce+lookup on a two-speed cadence so a dropped
    // peer / aged-out announce re-pairs WITHOUT an operator restart (see the
    // constant block above + directory-swarm.ts). FAST inside the post-join /
    // post-peer-loss window, then a SLOW keepalive. `refreshMs: 0` disables it.
    const refreshMs = opts.refreshMs ?? DEFAULT_SUBSTRATE_REFRESH_MS;
    const fastWindowMs = opts.fastWindowMs ?? DEFAULT_SUBSTRATE_FAST_WINDOW_MS;
    const slowRefreshMs = opts.slowRefreshMs ?? DEFAULT_SUBSTRATE_SLOW_REFRESH_MS;
    if (refreshMs > 0) {
      // P-007: this join's tick body. It is registered on the swarm's ONE shared
      // refresh loop (see registerSwarmRefresh above) instead of arming a timer
      // of its own — `now` is supplied by the shared tick, and `refreshMs` still
      // gates THIS body, so the cadence (and the ladders' every-tick evaluation
      // within it) is exactly what a private timer gave us.
      const refreshTick = (now: number): void => {

        // ── EI-18687938054040755: emit the POSITIVE data-path signal ──
        // Rides this existing managed tick deliberately — no new timer (repo
        // rule: no bare setInterval / no second scheduler), and `readWireStats`
        // is a pure read, so this cannot perturb the replication stream. (A
        // 'data'/'readable' listener would have switched the socket to flowing
        // mode and could CONSUME replication bytes — never do that here.)
        // Fires at most once per socket; the WeakSet lets closed sockets be GC'd.
        //
        // ⚠ EI-18808621019872598 — MEASURED VOLUME, MECHANISM STILL OPEN. On
        // papercup-bg-host this line was 873,539 entries in 24h: 21% of that
        // unit's whole 4,076,943-line journal, from only 36 distinct
        // (topic,peer) pairs and exactly ONE peer. The identical line
        // (topic=d85dc18c0bac0c9a… peer=95ae30fc8272… bytesReceived=5925
        // packetsReceived=9) repeated 8,268 times, and one topic held 448,811
        // of the 873,539.
        //
        // The dedupe below is NOT the bug, and two tempting "fixes" were
        // checked and FALSIFIED: (a) "a self-heal rejoin resets this per-join
        // WeakSet" is wrong — joinHarnessSwarm has ONE production caller
        // (boot.ts) and forceRejoinNow re-joins at the DISCOVERY level without
        // re-entering it, so the set is never reset; (b) re-keying it per
        // (socket, topic) process-wide is a NO-OP, since each invocation only
        // ever tests its own topicHex.
        //
        // What the volume actually is: an hourly histogram shows a STEADY
        // ~50-77k/hour for ~18h (2026-08-08T14 → 2026-08-09T07) then exactly
        // ZERO once the peer stopped pairing — so it tracks peer connectivity,
        // i.e. fresh sockets, not re-reporting of stale ones. ~15 lines/s ÷ the
        // 36 joined topics ≈ one physical reconnect every 2.4s, which matches
        // DEFAULT_REFRESH_MS (2500) — the re-dial cadence. Each new socket is
        // then reported once PER JOINED HARNESS, because this handler is
        // registered per join on one process-global swarm
        // (EI-18694945517907886). That also explains the identical repeated
        // line: every re-dial dies after the same deterministic handshake, so
        // bytesReceived is the same number each time.
        //
        // So the honest reduction here is to collapse the ~36x fan-out — the
        // data path is a property of the SOCKET (readWireStats reads the
        // socket), not of a topic — which needs a process-wide per-socket
        // dedupe and a decision about what the `topic=` label then means.
        // Deliberately NOT done blind: it must be verified against a window
        // where the churn reproduces, and it was NOT reproducing at
        // 2026-08-09T14:30Z (zero swarm connections across a 50-minute uptime).
        // The upstream fix is to stop the re-dial storm, not to log it quieter.
        for (const socket of mySockets) {
          if (typeof socket !== 'object' || socket === null) continue;
          if (dataPathProvenReported.has(socket)) continue;
          const wire = readWireStats(socket);
          if (dataPathProven(wire) !== true) continue;
          dataPathProvenReported.add(socket);
          if (process.env.VITEST) continue;
          try {
            const path = extractConnectionPath(socket);
            const peerHex = extractPublicKeyHex({
              publicKey: (socket as { remotePublicKey?: unknown }).remotePublicKey,
            });
            console.info(
              `[swarm] peer_data_path_up topic=${topicHex.slice(0, 16)}…` +
                (peerHex ? ` peer=${peerHex.slice(0, 12)}…` : '') +
                ` bytesReceived=${wire.bytesReceived ?? '?'}` +
                ` packetsReceived=${wire.packetsReceived ?? '?'}` +
                (path.relayed !== undefined ? ` relayed=${path.relayed}` : '') +
                (path.remoteHost ? ` remoteHost=${path.remoteHost}` : ''),
            );
          } catch {
            // Diagnostic-only; never let logging break the refresh tick.
          }
        }

        // ── EI-13317 escalation ladder ──
        // Evaluated on EVERY tick, independent of the refresh cadence below
        // (inFastWindow/slowDue gates when to call discovery.refresh(), NOT
        // when to check for a severed link — a topic can sit past the
        // severed threshold DURING the dead zone between the fast window
        // lapsing and the next slow-keepalive tick, and that gap must not
        // delay detection).
        // refresh() alone does NOT recover a link severed by a ONE-SIDE
        // RESTART (forensics: fast-window ticks fire every ~2.5s with zero
        // paired peers for 20+ minutes; only a fresh process/swarm.join ever
        // reconnects — the surviving side's local discovery session holds
        // stale DHT announce/lookup state that refresh() cannot clear). Once
        // this topic HAD a live peer (connectionCount > 0) and has sat at
        // ZERO live peers (the LOCAL per-join counter — deliberately NOT the
        // shared swarm's global connection count, which would mask this
        // topic's severed state behind an unrelated peer on a DIFFERENT
        // harness/topic sharing the same swarm) for `severedEscalationMs`,
        // force a topic-level leave+rejoin (a fresh discovery session) and
        // fire the loud, rate-limited health signal the "correct state"
        // requires instead of a silently-frozen rail.
        const severedEscalationMs = opts.severedEscalationMs ?? DEFAULT_SUBSTRATE_SEVERED_ESCALATION_MS;
        // P-203: sample every live socket's wire counter each tick so a forced
        // rejoin can tell a socket that is STILL receiving (spare) from a zombie.
        inboundLedger.sample(mySockets, now);
        if (severedEscalationMs > 0) {
          const severedMs = now - fastWindowStartMs;
          const genuinelySevered = connectionCount > 0 && liveConnectionCount === 0;
          if (
            genuinelySevered &&
            severedMs >= severedEscalationMs &&
            now - lastEscalationMs >= severedEscalationMs
          ) {
            lastEscalationMs = now;
            const topicHex = opts.topic.toString('hex');
            const info: SeveredLinkInfo = { topicHex, severedMs };
            // The loud signal is diagnostic-only — a throwing/misbehaving
            // console (a custom transport, a test harness that turns
            // console.error into a hard failure) must NEVER prevent the
            // actual recovery action below from running. Same VITEST-gating
            // convention as topic-gossip.ts's diagnostic logs (this codebase
            // relies on `onSeveredLink`/callbacks as the test-observable
            // signal, not console scraping).
            try {
              if (!process.env.VITEST) {
                // EI-18680482533031746: `[swarm:severed]` is a DISTINCT stable
                // token from the unpaired rung's `[swarm:unpaired]` below —
                // both rungs' messages otherwise share the substring "fresh
                // topic leave+rejoin", which conflated their counts under a
                // plain log grep (a real ~10-vs-5 false anomaly). Count by
                // this tag, never by the shared phrase.
                console.error(
                  `[swarm:severed] ⚠ topic ${topicHex.slice(0, 16)}… severed for ${Math.round(severedMs / 1000)}s ` +
                    'despite refresh() ticking — forcing a fresh topic leave+rejoin ' +
                    '(the local discovery session likely holds stale DHT announce/lookup state).',
                );
              }
            } catch {
              /* diagnostic-only; swallow */
            }
            fireSeveredLinkSafely(opts.onSeveredLink, info);
            void forceRejoinNow().catch(() => {
              // best-effort — a failed rejoin attempt is retried at the
              // next escalation tick (lastEscalationMs already advanced,
              // so this waits a full severedEscalationMs before retrying).
            });
          }
        }

        // ── EI-18662944242304583 rung (c): pre-admission NEVER-PAIRED axis ──
        // The mirror image of rung (a). Rung (a) catches "we HAD peers and now
        // have none"; this catches "peers keep arriving and the announce
        // channel has never once paired" — connections churn, `open()` is
        // called every time, and not one frame ever traverses in either
        // direction. Nothing downstream can see this: admission needs an
        // announce, an announce needs a paired channel, and every
        // replication-liveness axis is sampled per ADMITTED log — so with zero
        // admissions the detector is not merely quiet, it never executes.
        // Live proof + the constant's rationale: see
        // DEFAULT_SUBSTRATE_UNPAIRED_ESCALATION_MS above.
        //
        // False-positive discipline (the WI-5686 lesson — a too-eager axis that
        // tears down healthy sessions is worse than a blind one). All must hold:
        //   - live connections RIGHT NOW (a genuinely offline peer never fires);
        //   - we actually attempted ≥ MIN_UNPAIRED_ATTEMPTS pairings, so a topic
        //     that opens no announce channel at all can never arm the rung;
        //   - this topic has NEVER paired in this process (a single successful
        //     pairing disarms it permanently — churn after that belongs to the
        //     downstream detector, which by then genuinely can see it);
        //   - sustained past the threshold, rate-limited, and capped.
        const unpairedEscalationMs =
          opts.unpairedEscalationMs ?? DEFAULT_SUBSTRATE_UNPAIRED_ESCALATION_MS;
        if (unpairedEscalationMs > 0 && unpairedEscalations < MAX_UNPAIRED_ESCALATIONS) {
          const probe = opts.announcePairingState ?? announcePairingStateForTopic;
          let pairing: AnnouncePairingState | null = null;
          try {
            pairing = probe(topicHex);
          } catch {
            // a throwing probe is treated as "no signal", never a fire
            pairing = null;
          }
          // EI-18680482533031746: gate on the explicit `present` witness, not
          // the `firstAttemptMs !== null` coincidence — a topic we've never
          // tracked at all must never be mistaken for one we've tracked and
          // measured zero attempts on.
          const unpairedMs =
            pairing && pairing.present && pairing.firstAttemptMs !== null
              ? now - pairing.firstAttemptMs
              : 0;
          if (
            pairing &&
            pairing.present &&
            liveConnectionCount > 0 &&
            pairing.remoteOpenObserved &&
            !pairing.everPaired &&
            pairing.attempts >= MIN_UNPAIRED_ATTEMPTS &&
            unpairedMs >= unpairedEscalationMs &&
            now - lastUnpairedEscalationMs >= unpairedEscalationMs
          ) {
            lastUnpairedEscalationMs = now;
            unpairedEscalations += 1;
            const info: UnpairedLinkInfo = {
              topicHex,
              unpairedMs,
              attempts: pairing.attempts,
            };
            // Diagnostic-only; a throwing console must never block the repair.
            // EI-18680482533031746: `[swarm:unpaired]` is a DISTINCT stable
            // token from the severed rung's `[swarm:severed]` above — see
            // that call site's comment for why (shared "fresh topic
            // leave+rejoin" substring conflated their counts under a plain
            // log grep). Count by this tag, never by the shared phrase.
            try {
              if (!process.env.VITEST) {
                console.error(
                  `[swarm:unpaired] ⚠ topic ${topicHex.slice(0, 16)}… has held live connections for ` +
                    `${Math.round(unpairedMs / 1000)}s across ${pairing.attempts} announce-channel ` +
                    'open attempts WITHOUT ever pairing — no announce can be exchanged, so nothing ' +
                    'is admitted and the replication-liveness axes never run at all. Forcing a ' +
                    'fresh topic leave+rejoin (likely a dead data path behind a connected socket).',
                );
              }
            } catch {
              /* diagnostic-only; swallow */
            }
            fireUnpairedLinkSafely(opts.onUnpairedLink, info);
            void forceRejoinNow().catch(() => {
              // best-effort — retried at the next escalation tick (bounded by
              // MAX_UNPAIRED_ESCALATIONS).
            });
          }
        }

        // ── WI-752 / FED-2 self-heal re-peer loop ──
        const inFastWindow = now - fastWindowStartMs < fastWindowMs;
        // WI-1534: a stalled admitted log re-arms the FAST cadence exactly
        // like a fresh join/peer-loss would — best-effort, never throws past
        // this call (a caller predicate that throws is treated as "no stall").
        let stalled = false;
        if (opts.hasStalledLogs) {
          try {
            stalled = opts.hasStalledLogs();
          } catch {
            stalled = false;
          }
        }
        const slowDue = now - lastRefreshMs >= slowRefreshMs;
        if (!inFastWindow && !stalled && !slowDue) return;
        lastRefreshMs = now;
        try {
          // Re-announce (server) + re-lookup (client) — the same call the
          // swarm-chaos test uses as its deterministic reconnect driver. A throw
          // / rejection must never crash the host.
          void Promise.resolve(discovery?.refresh?.({ client: true, server: true })).catch(() => {});
        } catch {
          // best-effort — refresh is keepalive, not load-bearing for this tick
        }
      };
      releaseRefresh = registerSwarmRefresh(opts.swarm, {
        refreshMs,
        lastTickMs: Date.now(),
        tick: refreshTick,
      });
    }
  } catch (e) {
    // Setup failed after the listener was registered — undo it (and any
    // shared-refresh registration) so a failed/flapping join never
    // orphan-accumulates 'connection' listeners or shared-loop entries.
    if (releaseRefresh) {
      try { releaseRefresh(); } catch { /* no-op */ }
      releaseRefresh = null;
    }
    // WI-6063: and its fairness-registry slot — a half-built join must not leave
    // a topic entry behind holding a session it never finished setting up.
    if (releaseFairness) {
      try { releaseFairness(); } catch { /* no-op */ }
      releaseFairness = null;
    }
    try {
      opts.swarm.off?.('connection', handler);
    } catch {
      /* no-op — best-effort listener cleanup on the error path */
    }
    throw e;
  }

  const handle: SwarmHandle = {
    topicHex: opts.topic.toString('hex'),
    get connectionCount() {
      return connectionCount;
    },
    get liveConnectionCount() {
      // Prefer the shared swarm's OWN live socket set (real Hyperswarm exposes
      // a Set). The per-join counter below only sees 'connection' events fired
      // AFTER this join registered — a socket that pre-dates the join is
      // INVISIBLE to it (the shared swarm dedups one socket per peer across
      // topics, and rekey() replaces the handle with a fresh zero counter), so
      // the counter read 0 on live rigs while a peer was demonstrably
      // replicating, silently disarming the connected_never_replicated axis on
      // exactly the WI-183 zombie class it exists for (rig run m1783120511:
      // registry sampling every ~1s, axis silent for 20min). The swarm's set
      // has no such blind spot. Counter kept as the fallback for minimal test
      // fakes that don't expose `connections`.
      const set = opts.swarm.connections;
      if (set) {
        const size = (set as { size?: number }).size;
        if (typeof size === 'number') return size;
        let n = 0;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const _ of set) n++;
        return n;
      }
      return liveConnectionCount;
    },
    async forceRejoin() {
      await forceRejoinNow();
    },
    refreshAnnounce() {
      const logKey = opts.ourAnnounce?.log_core_key;
      if (!logKey) return;
      for (const socket of mySockets) {
        const state = announceStateForSocket(socket, topicHex);
        if (!state) continue;
        // Clear ONLY this harness's log. A same-topic sibling has its own
        // writer length and must not be re-signed merely because we appended.
        state.sentKeys.delete(logKey);
        flushTopicAnnounces(state);
      }
    },
    dataPathSnapshot() {
      const out: DataPathSnapshotEntry[] = [];
      for (const socket of mySockets) {
        const wire = readWireStats(socket);
        out.push({
          remotePublicKeyHex: extractPublicKeyHex({
            publicKey: (socket as { remotePublicKey?: unknown } | null)?.remotePublicKey,
          }),
          path: extractConnectionPath(socket),
          wire,
          proven: dataPathProven(wire),
        });
      }
      return out;
    },
    async close() {
      // WI-752: leave the self-heal loop FIRST so no refresh fires after leave.
      // P-007: this deregisters THIS join's tick from the swarm's shared loop
      // (and stops that loop's timer once the last join on the swarm releases) —
      // it must never stop a sibling harness's ticks.
      if (releaseRefresh) {
        releaseRefresh();
        releaseRefresh = null;
      }
      // WI-6063: leave the peer-budget fairness registry too. The release
      // RESUMES this topic's dialling first, so closing while throttled can
      // never leave the underlying discovery session latched client-off for a
      // sibling harness that shares the topic.
      if (releaseFairness) {
        releaseFairness();
        releaseFairness = null;
      }
      // WI-5923: unregister from the shared topic-wide rejoin coordinator
      // BEFORE tearing this instance down — an in-flight coordinated rejoin
      // (triggered by a SIBLING's escalation) must never call back into a
      // participant that's mid-close. Release the coordinator entry entirely
      // once the last participant on this (swarm,topic) leaves, so a
      // long-lived shared process swarm doesn't accumulate one Map entry per
      // ever-joined topic.
      topicRejoinCoordinator.unregister(rejoinParticipantToken);
      releaseTopicRejoinCoordinatorIfEmpty(opts.swarm, topicHex);
      // The muxer/socket can stay live for a same-topic sibling after this
      // handle closes. Remove only THIS harness's announce entry now; otherwise
      // periodic reflush keeps advertising its retired log and inbound frames
      // keep reaching its closed callback until the physical socket dies.
      for (const releaseAnnounce of releaseAnnounceBySocket.values()) {
        try {
          releaseAnnounce();
        } catch {
          /* best-effort — announce cleanup must not block swarm teardown */
        }
      }
      releaseAnnounceBySocket.clear();
      if (opts.swarm.off) opts.swarm.off('connection', handler);
      try {
        // WI-5923: prefer the REFCOUNTED session-level teardown
        // (`discovery.destroy()`) over the process-wide `swarm.leave(topic)`.
        // Shared-Hive topics are joined ONCE PER MEMBER HARNESS on a topic that
        // is per-HIVE (boot.ts), so a shared swarm can hold MULTIPLE sessions
        // for the same topic — one per harness. `swarm.leave()` ignores that
        // entirely (hyperswarm/index.js: `discovery.destroy()` unconditionally,
        // then deletes the topic's map entry) and destroys every sibling
        // harness's session too, with no callback/event to tell them it
        // happened — they're left holding a reference to a destroyed
        // PeerDiscovery while their refresh timer and detector keep running
        // against a corpse. `discovery.destroy()` (the session Hyperswarm
        // itself returned from `join()`) instead only decrements THIS
        // session's share and defers the real `swarm.leave` internally until
        // every session on the topic has destroyed (hyperswarm/lib/peer-
        // discovery.js `_destroyMaybe`) — so closing one harness's join can
        // never tear down a sibling's. Falls back to the old `swarm.leave`
        // when a test fake's `join()` doesn't return a `destroy` (unchanged
        // behavior for existing fakes).
        if (discovery && typeof discovery.destroy === 'function') {
          await discovery.destroy();
        } else {
          await opts.swarm.leave(opts.topic);
        }
      } catch {
        // Leaving a non-joined topic (or destroying an already-destroyed
        // session) is a no-op in Hyperswarm; safe.
      }
    },
  };
  return handle;
}

// ─── shared singleton swarm (process-level) ────────────────────────

let _sharedSwarm: HyperswarmLike | null = null;

/** WI-37465: the IN-FLIGHT construction, memoized so concurrent callers share
 *  ONE build instead of each starting their own.
 *
 *  `_sharedSwarm` alone cannot serialize this: it is assigned only at the END
 *  of construction, and `buildSharedSwarm()` awaits three times before it gets
 *  there (`import('hyperswarm')`, `loadOrGenerateSwarmSeed()`,
 *  `import('hyperdht')`). A `if (_sharedSwarm) return` guard followed by an
 *  await is a classic check-then-act race: every caller entering during those
 *  awaits sees `null`, passes the guard, and constructs its own Hyperswarm.
 *  There are ≥6 callers and several run concurrently at boot
 *  (hive-directory-boot, cross-hive-boundary-boot, substrate-wake-wiring).
 *
 *  Measured 2026-08-09 on the rig (172.31.44.2, pid 24727): THREE swarms
 *  constructed at 04:00:13.412/.413/.414 — 2ms apart — holding three UDP
 *  sockets (49737/49738/49739). The tower's process built exactly one.
 *
 *  That is not merely wasteful. `identity/swarm-keypair.ts` scopes the seed to
 *  `machineFingerprint()` — PER MACHINE — so every instance loads the SAME
 *  seed and therefore the SAME public key, and all of them join the SAME DHT
 *  announcing the same topics. swarm-keypair.ts's own header reasons that a
 *  duplicated identity is harmless only because the two processes it considered
 *  sit on different DHTs ("an identical keypair on each never actually collides
 *  on the wire"); N instances inside ONE process are the case that reasoning
 *  excluded. It also silently multiplies the peer dedup, the maxPeers /
 *  maxClientConnections budget, and the WI-6063 per-topic fairness — each
 *  becomes per-INSTANCE rather than per-process.
 *
 *  Cleared on failure so a construction error is retryable rather than
 *  poisoning the process with a permanently-rejected promise. */
let _sharedSwarmPromise: Promise<HyperswarmLike> | null = null;

/** FLOOR for the total-connection ceiling, and the fallback when the host's
 *  resource profile can't be read. Hyperswarm's own default is unlimited; this
 *  bounds a connection-flood DoS regardless of the data layer. 256 so a single
 *  shared hive can fill to its full 256 peers even on the smallest host (P-004);
 *  the EFFECTIVE default scales UP from here with cores/RAM (see
 *  {@link resolveDefaultMaxPeers}), and PAPERCUSP_SWARM_MAX_PEERS overrides both. */
const DEFAULT_MAX_PEERS = 256;

/**
 * P-004: the effective default `maxPeers` for the shared swarm, DERIVED from the
 * host's resource profile (`resource-profile.maxSwarmPeers` — cores/RAM, floored
 * at 256, ceiled at 2048) instead of a hardcoded constant. So a single shared
 * hive can actually reach 256 peers AND a capable box gets headroom for its
 * OTHER topics rather than starving them. Falls back to the 256 floor if the
 * profile can't be read (best-effort — a swarm must never fail to construct over
 * a host-detection hiccup). `PAPERCUSP_SWARM_MAX_PEERS` still wins in
 * {@link swarmConstructorOpts}.
 */
export function resolveDefaultMaxPeers(): number {
  try {
    const derived = getResourceProfile().maxSwarmPeers;
    return Number.isFinite(derived) && derived > 0 ? derived : DEFAULT_MAX_PEERS;
  } catch {
    return DEFAULT_MAX_PEERS;
  }
}

/** One DHT bootstrap node (host + UDP port). */
export interface DhtBootstrapNode {
  host: string;
  port: number;
}

/** Parse `PAPERCUSP_DHT_HOST` — an optional local bind/advertise host for
 * hyperdht. Hyperswarm does not forward `host` to HyperDHT, so callers that
 * need an explicit interface (notably the fed-a/fed-b VM rig, whose default
 * route can be duplicate/unreachable while the private L2 is stable) need us to
 * construct HyperDHT directly and pass it through Hyperswarm's `dht` option. */
export function parseDhtHost(raw: string | undefined): string | undefined {
  const host = raw?.trim();
  return host || undefined;
}

/**
 * Parse `PAPERCUSP_DHT_BOOTSTRAP` — a comma-separated `host:port` list — into
 * hyperdht bootstrap nodes. Returns undefined when unset/empty/all-malformed
 * (→ the swarm uses the real public DHT, the default). When set, every peer
 * that shares the value joins the SAME isolated DHT — which is how two
 * instances on ONE box deterministically discover each other without relying on
 * public-DHT NAT hairpinning (the same trick the in-process p079 live test uses
 * via `hyperdht/testnet`). Exported for unit testing.
 */
export function parseDhtBootstrap(raw: string | undefined): DhtBootstrapNode[] | undefined {
  if (!raw) return undefined;
  const nodes = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s): DhtBootstrapNode | null => {
      const i = s.lastIndexOf(':'); // lastIndexOf tolerates IPv6-ish hosts minimally
      if (i <= 0) return null;
      const host = s.slice(0, i);
      const port = Number.parseInt(s.slice(i + 1), 10);
      return host && Number.isFinite(port) && port > 0 ? { host, port } : null;
    })
    .filter((n): n is DhtBootstrapNode => n !== null);
  return nodes.length ? nodes : undefined;
}

/**
 * WI-3604 (split-DHT-universe recurrence guard). The DHT universe this
 * process's shared swarm actually resolved to, at construction time:
 * `'isolated'` (a custom bootstrap list, e.g. the fed-a/fed-b rig DHT),
 * `'public'` (no `PAPERCUSP_DHT_BOOTSTRAP` set — the real public DHT), or
 * `'misconfigured'` (the env var WAS set but resolved to zero usable
 * bootstrap nodes — {@link parseDhtBootstrap}'s all-malformed case — which
 * silently falls back to the PUBLIC DHT, the exact "isolated federation
 * quietly breaks" failure this guards against).
 */
export type DhtUniverseState =
  | { mode: 'isolated'; bootstrap: DhtBootstrapNode[] }
  | { mode: 'public' }
  | { mode: 'misconfigured'; envValue: string };

/** Pure classifier: given the raw `PAPERCUSP_DHT_BOOTSTRAP` value, resolve
 * which DHT universe a swarm constructed with it would join. Exported for
 * unit testing (no I/O). */
export function resolveDhtUniverseState(envBootstrapRaw: string | undefined): DhtUniverseState {
  const trimmed = envBootstrapRaw?.trim();
  if (!trimmed) return { mode: 'public' };
  const bootstrap = parseDhtBootstrap(trimmed);
  if (bootstrap?.length) return { mode: 'isolated', bootstrap };
  return { mode: 'misconfigured', envValue: trimmed };
}

/** Result of comparing this process's resolved {@link DhtUniverseState}
 * against the operator's DECLARED expectation (see
 * {@link readExpectedDhtBootstrap}). `ok:true` also covers "no expectation
 * configured" — an unconfigured expectation can't be violated. */
export interface DhtUniverseAssertion {
  ok: boolean;
  detail: string;
}

function bootstrapKey(nodes: DhtBootstrapNode[]): string {
  return nodes
    .map((n) => `${n.host}:${n.port}`)
    .sort()
    .join(',');
}

/**
 * Pure comparator: does `actual` (this process's resolved DHT universe)
 * match `expectedBootstrapRaw` (the operator's declared expectation, e.g.
 * "this box should always join the isolated rig DHT")? This is the WI-3604
 * recurrence guard for the 2026-07-09 Mac VM incident: a Server.app instance
 * launched WITHOUT `PAPERCUSP_DHT_BOOTSTRAP` (a macOS LaunchAgent's
 * `EnvironmentVariables` are not inherited by a manual app relaunch) silently
 * joined the PUBLIC DHT while every peer expected the isolated rig DHT —
 * severing the federation plane with no loud error. Exported for unit
 * testing (no I/O — callers read the expected value via
 * {@link readExpectedDhtBootstrap} first).
 */
export function assertDhtUniverse(
  actual: DhtUniverseState,
  expectedBootstrapRaw: string | undefined,
): DhtUniverseAssertion {
  const expectedTrimmed = expectedBootstrapRaw?.trim();
  if (!expectedTrimmed) {
    return { ok: true, detail: 'no expected DHT bootstrap configured — assertion skipped' };
  }
  const expected = parseDhtBootstrap(expectedTrimmed);
  if (!expected?.length) {
    // The EXPECTATION itself is unparsable — don't false-positive on a bad
    // config; just say so.
    return {
      ok: true,
      detail: `expected DHT bootstrap ("${expectedTrimmed}") is unparsable — assertion skipped`,
    };
  }
  const expectedKey = bootstrapKey(expected);
  if (actual.mode === 'public') {
    return {
      ok: false,
      detail:
        `expected isolated DHT bootstrap ${expectedKey} but this process resolved to the ` +
        `PUBLIC DHT — PAPERCUSP_DHT_BOOTSTRAP is likely unset/not-inherited on this host`,
    };
  }
  if (actual.mode === 'misconfigured') {
    return {
      ok: false,
      detail:
        `expected isolated DHT bootstrap ${expectedKey} but PAPERCUSP_DHT_BOOTSTRAP resolved to ` +
        `no usable nodes ("${actual.envValue}") — this process fell back to the PUBLIC DHT`,
    };
  }
  const actualKey = bootstrapKey(actual.bootstrap);
  if (actualKey !== expectedKey) {
    return {
      ok: false,
      detail: `expected isolated DHT bootstrap ${expectedKey} but this process resolved to ${actualKey}`,
    };
  }
  return { ok: true, detail: `DHT bootstrap matches expected isolated universe (${expectedKey})` };
}

/**
 * Read the operator's DECLARED expected DHT bootstrap, independent of
 * whatever `PAPERCUSP_DHT_BOOTSTRAP` this process happened to actually
 * inherit. An env-var-only "expected" value can't catch a whole env block
 * being skipped by a non-LaunchAgent-mediated launch (the 2026-07-09
 * incident) — if the real var can silently go missing, an "expected" var set
 * the SAME way would too. So this prefers `PAPERCUSP_EXPECTED_DHT_BOOTSTRAP`
 * but falls back to a marker FILE
 * (`PAPERCUSP_EXPECTED_DHT_BOOTSTRAP_FILE` or `~/.papercusp/expected-dht-bootstrap`)
 * that a provisioning/install script writes independently of this process's
 * own launch-time environment — the one detection path that would have
 * caught that incident. Best-effort: a missing file is not an error.
 */
export function readExpectedDhtBootstrap(): string | undefined {
  const envVal = process.env.PAPERCUSP_EXPECTED_DHT_BOOTSTRAP?.trim();
  if (envVal) return envVal;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('node:os') as typeof import('node:os');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const filePath =
      process.env.PAPERCUSP_EXPECTED_DHT_BOOTSTRAP_FILE?.trim() ||
      path.join(os.homedir(), '.papercusp', 'expected-dht-bootstrap');
    const contents = fs.readFileSync(filePath, 'utf8').trim();
    return contents || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the EFFECTIVE `PAPERCUSP_DHT_BOOTSTRAP` value this process should join —
 * the raw string, preferring the env var but falling back to a marker FILE
 * (`PAPERCUSP_DHT_BOOTSTRAP_FILE` or `~/.papercusp/dht-bootstrap`) when the env
 * is unset/empty. This is the input to {@link parseDhtBootstrap} everywhere the
 * swarm actually resolves its bootstrap (see {@link swarmConstructorOpts} and
 * {@link getSharedSwarm}), so a file-provided value drives BOTH the real
 * hyperdht bootstrap AND the boot banner / {@link assertDhtUniverse} guard.
 *
 * EI-8893 (durable fix — kills the whole env-inheritance failure class): on
 * macOS a Server.app that SELF-RELAUNCHES via LaunchServices (update/restart
 * path) does NOT inherit its LaunchAgent's `EnvironmentVariables`, so the
 * relaunched process comes up env-less and silently joins the PUBLIC DHT
 * instead of the isolated testnet — severing federation with no loud error,
 * and the `launchctl setenv` mitigation does not survive reboot. Reading the
 * bootstrap from a file that a provisioning/install script writes independently
 * of this process's launch-time environment makes the isolated-DHT selection
 * immune to the relaunch path entirely (the same file-fallback trick
 * {@link readExpectedDhtBootstrap} uses for the DECLARED expectation). The env
 * var still WINS when present, so nothing changes for env-configured hosts.
 * Best-effort: a missing/unreadable file is not an error. Exported for unit
 * testing (I/O redirectable via `PAPERCUSP_DHT_BOOTSTRAP_FILE`).
 */
export function readEffectiveDhtBootstrapRaw(): string | undefined {
  const envVal = process.env.PAPERCUSP_DHT_BOOTSTRAP?.trim();
  if (envVal) return envVal;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('node:os') as typeof import('node:os');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const filePath =
      process.env.PAPERCUSP_DHT_BOOTSTRAP_FILE?.trim() ||
      path.join(os.homedir(), '.papercusp', 'dht-bootstrap');
    const contents = fs.readFileSync(filePath, 'utf8').trim();
    return contents || undefined;
  } catch {
    return undefined;
  }
}

let _dhtUniverseAssertion: DhtUniverseAssertion | null = null;

/** The DHT-universe assertion computed once, alongside the shared swarm's
 * construction (see {@link getSharedSwarm}). `null` before the shared swarm
 * has been constructed at least once in this process. */
export function getDhtUniverseAssertion(): DhtUniverseAssertion | null {
  return _dhtUniverseAssertion;
}

export function _resetDhtUniverseAssertionForTests(): void {
  _dhtUniverseAssertion = null;
}

/**
 * Constructor options for the shared Hyperswarm — the DoS resource ceiling
 * (P-001 of hyperswarm-dos-hardening). `maxPeers` caps total concurrent peer
 * connections; `bootstrap` (when `PAPERCUSP_DHT_BOOTSTRAP` is set) points the
 * underlying hyperdht at a custom/isolated DHT instead of the public one.
 * Exported so the wiring is unit-testable without constructing the real
 * (network-touching) swarm.
 *
 * `maxPeers` precedence (P-004): `PAPERCUSP_SWARM_MAX_PEERS` > the host-derived
 * default ({@link resolveDefaultMaxPeers} — cores/RAM, ≥256). Pass
 * `defaultMaxPeers` to inject the host-derived value (keeps the function pure
 * for unit tests); omitted, it reads the real resource profile.
 */
/**
 * WI-6063: how much of the peer budget is held back for INBOUND peers, as a
 * fraction of `maxPeers`.
 *
 * Hyperswarm's `maxClientConnections` defaults to `Infinity`, so outbound
 * dialling alone can consume 100% of `maxPeers` — and once it has, EVERY topic's
 * inbound peers are silently refused, including topics with no outbound peers at
 * all. That is a starvation axis the per-topic fairness gate cannot reach: it
 * arbitrates BETWEEN topics, while this reserves capacity for a direction.
 *
 * Deliberately small, and clamped: it must only bind deep at scale, never in the
 * small-N topologies the tests and a single-box fleet actually run. At the ≥256
 * floor this reserves 32 slots, so dialling is unaffected until 224 outbound
 * connections exist.
 */
export const INBOUND_PEER_RESERVE_RATIO = 0.125;
const INBOUND_PEER_RESERVE_MIN = 8;
const INBOUND_PEER_RESERVE_MAX = 64;

/**
 * The outbound-dial ceiling to construct the swarm with — `maxPeers` minus the
 * inbound reserve. Exported (and pure) so the reserve is unit-testable without
 * constructing a real swarm. `PAPERCUSP_SWARM_INBOUND_RESERVE` overrides the
 * computed reserve; `0` disables it (restoring hyperswarm's unbounded default).
 */
export function resolveMaxClientConnections(maxPeers: number): number {
  const override = Number.parseInt(process.env.PAPERCUSP_SWARM_INBOUND_RESERVE ?? '', 10);
  const reserve = Number.isFinite(override)
    ? Math.max(0, override)
    : Math.min(
        INBOUND_PEER_RESERVE_MAX,
        Math.max(INBOUND_PEER_RESERVE_MIN, Math.floor(maxPeers * INBOUND_PEER_RESERVE_RATIO)),
      );
  // Never let the reserve swallow the whole budget: a tiny/overridden maxPeers
  // must still be able to dial out, or the "fix" is a total outbound blackout.
  // Floor of 1 rather than 0 — `maxClientConnections: 0` would mean this node can
  // NEVER dial, which is indistinguishable from a broken swarm.
  return Math.max(1, maxPeers - reserve);
}

export function swarmConstructorOpts(args?: {
  defaultMaxPeers?: number;
}): {
  maxPeers: number;
  maxClientConnections: number;
  bootstrap?: DhtBootstrapNode[];
  dhtHost?: string;
} {
  const raw = Number.parseInt(process.env.PAPERCUSP_SWARM_MAX_PEERS ?? '', 10);
  const fallback = args?.defaultMaxPeers ?? resolveDefaultMaxPeers();
  const maxPeers = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  // EI-8893: resolve the bootstrap via the env→file fallback so a
  // self-relaunched macOS Server.app (whose LaunchAgent env is stripped by
  // LaunchServices) still reads its isolated-DHT bootstrap from
  // ~/.papercusp/dht-bootstrap instead of silently defaulting to the public DHT.
  const bootstrap = parseDhtBootstrap(readEffectiveDhtBootstrapRaw());
  const dhtHost = parseDhtHost(process.env.PAPERCUSP_DHT_HOST);
  return {
    maxPeers,
    maxClientConnections: resolveMaxClientConnections(maxPeers),
    ...(bootstrap ? { bootstrap } : {}),
    ...(dhtHost ? { dhtHost } : {}),
  };
}

/**
 * P-302 (EI-20584279536840151): how long a freshly-constructed swarm's DHT gets
 * to reach its OWN bootstrap before we declare the transport broken. The
 * isolated rig populates a routing table in <50ms and the public DHT in a
 * second or two, so this is a "something is structurally wrong" threshold, not
 * a latency budget.
 */
export const DHT_BOOTSTRAP_GRACE_MS = 15_000;

/**
 * The handful of LIVE dht-rpc fields that decide whether this process can talk
 * to its bootstrap at all. Split out from the reading so the VERDICT is a pure
 * function and can be tested without a network — see
 * {@link classifyDhtReachability}.
 */
export interface DhtReachabilitySample {
  /** Bootstrap nodes the LIVE node actually holds — NOT what we passed in.
   *  These differ exactly in the failure modes worth catching. */
  bootstrapNodeCount: number;
  /** Routing-table size. Still zero after the grace window ⇒ nobody ever answered. */
  routingTableSize: number;
  /** dht-rpc `io.stats.requests` counters. */
  requestsTotal: number;
  responses: number;
  timeouts: number;
}

export type DhtReachabilityVerdict =
  | { level: 'ok'; code: 'reachable'; message: null }
  | {
      level: 'warn';
      code: 'no-bootstrap-nodes' | 'never-queried' | 'bootstrap-unreachable' | 'degraded';
      message: string;
    };

/**
 * Decide what a DHT sample MEANS, loudly.
 *
 * This exists because the P-302 failure was invisible at every layer above the
 * socket: dht-rpc sends via udx's fire-and-forget `trySend`, which reports no
 * error, so a hard `EHOSTUNREACH` on EVERY packet looked identical to a healthy
 * idle swarm. The counters below are the only place the truth survives —
 * `requestsTotal` climbing while `responses` stays 0 is a transport that cannot
 * reach anyone, and it is not otherwise distinguishable from silence.
 */
export function classifyDhtReachability(s: DhtReachabilitySample): DhtReachabilityVerdict {
  if (s.bootstrapNodeCount === 0) {
    return {
      level: 'warn',
      code: 'no-bootstrap-nodes',
      message:
        'the DHT holds ZERO bootstrap nodes, so it will never issue a query and can never ' +
        'discover a peer — check PAPERCUSP_DHT_BOOTSTRAP and parseDhtBootstrap',
    };
  }
  // A populated routing table is proof that packets flow BOTH ways.
  if (s.routingTableSize > 0) return { level: 'ok', code: 'reachable', message: null };
  if (s.requestsTotal === 0) {
    return {
      level: 'warn',
      code: 'never-queried',
      message:
        'the DHT has bootstrap nodes but has not sent a single request — its bootstrap query ' +
        'never ran (a swallowed rejection in the join/bootstrap path)',
    };
  }
  if (s.responses === 0) {
    return {
      level: 'warn',
      code: 'bootstrap-unreachable',
      message:
        `sent ${s.requestsTotal} request(s) to its bootstrap and got ZERO responses ` +
        `(${s.timeouts} timeouts). The bootstrap is UNREACHABLE FROM THIS PROCESS. Because ` +
        'dht-rpc sends via udx `trySend` (fire-and-forget), a hard socket error is reported ' +
        'NOWHERE — verify with a `dgram.send` callback to the same host:port from inside this ' +
        'process. A per-process EHOSTUNREACH to a LOCAL-SUBNET peer while loopback and the ' +
        'public internet still work is macOS Local Network privacy (grant the app Local ' +
        'Network permission; the bundle needs NSLocalNetworkUsageDescription)',
    };
  }
  return {
    level: 'warn',
    code: 'degraded',
    message:
      `got ${s.responses} response(s) but the routing table is still empty — peers are ` +
      'answering yet none is being retained',
  };
}

/**
 * Read the live sample off a Hyperswarm. Every hop is defensive: `dht`, `table`
 * and `io.stats` are dht-rpc internals, so a version bump may move them — and a
 * diagnostic that THROWS while diagnosing is worse than one that abstains.
 * Returns null when the shape is unrecognisable, which callers report as
 * "could not determine" rather than as health.
 */
export function sampleDhtReachability(swarm: unknown): DhtReachabilitySample | null {
  try {
    const dht = (swarm as { dht?: Record<string, unknown> })?.dht;
    if (!dht) return null;
    const bootstrapNodes = dht.bootstrapNodes as unknown[] | undefined;
    const table = dht.table as { size?: number } | undefined;
    const stats = (dht.io as { stats?: { requests?: Record<string, number> } } | undefined)?.stats
      ?.requests;
    if (!Array.isArray(bootstrapNodes) || !table || !stats) return null;
    return {
      bootstrapNodeCount: bootstrapNodes.length,
      routingTableSize: typeof table.size === 'number' ? table.size : 0,
      requestsTotal: stats.total ?? 0,
      responses: stats.responses ?? 0,
      timeouts: stats.timeouts ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * After the grace window, say out loud whether this process's DHT can actually
 * reach its bootstrap. One-shot and `unref`'d, so it never holds the process
 * open and never becomes a recurring timer (no `managedSetInterval` needed).
 */
export function scheduleDhtReachabilityCheck(
  swarm: unknown,
  graceMs: number = DHT_BOOTSTRAP_GRACE_MS,
): void {
  const timer = setTimeout(() => {
    const sample = sampleDhtReachability(swarm);
    if (!sample) {
      console.info(
        '[swarm] DHT reachability: could not read the live DHT counters (unrecognised ' +
          'hyperdht/dht-rpc shape) — reachability UNKNOWN, not confirmed',
      );
      return;
    }
    const verdict = classifyDhtReachability(sample);
    if (verdict.level === 'ok') {
      console.info(
        `[swarm] DHT reachable: routing table ${sample.routingTableSize} node(s), ` +
          `${sample.responses}/${sample.requestsTotal} request(s) answered`,
      );
      return;
    }
    console.warn(
      `[swarm] ⚠ DHT TRANSPORT BROKEN (${verdict.code}) — ${verdict.message}. ` +
        `[bootstrapNodes=${sample.bootstrapNodeCount} routingTable=${sample.routingTableSize} ` +
        `requests=${sample.requestsTotal} responses=${sample.responses} timeouts=${sample.timeouts}]`,
    );
  }, graceMs);
  // Never keep the event loop alive for a diagnostic.
  (timer as { unref?: () => void }).unref?.();
}

/**
 * Lazy-construct ONE Hyperswarm for the entire process. Hyperswarm
 * is heavy (~50ms cold start + a UDP socket + DHT bootstrapping);
 * sharing it across harnesses cuts that cost to once per process.
 *
 * Tests override via `_setSharedSwarmForTests` so they never touch
 * the real module.
 *
 * WI-37465: this is the PROMISE-MEMOIZING entry point. The actual construction
 * lives in `buildSharedSwarm()` below; the memo is assigned SYNCHRONOUSLY here,
 * with no await between the check and the set, so N concurrent callers share
 * one build. Do NOT reintroduce an `await` before `_sharedSwarmPromise = …`.
 */
export function getSharedSwarm(): Promise<HyperswarmLike> {
  // A test override (or a completed build) short-circuits without touching the memo.
  if (_sharedSwarm) return Promise.resolve(_sharedSwarm);
  if (_sharedSwarmPromise) return _sharedSwarmPromise;
  // Assigned synchronously — this is the line that closes the race.
  _sharedSwarmPromise = buildSharedSwarm().catch((err: unknown) => {
    // Let the next caller retry rather than inheriting a rejected memo.
    _sharedSwarmPromise = null;
    throw err;
  });
  return _sharedSwarmPromise;
}

async function buildSharedSwarm(): Promise<HyperswarmLike> {
  if (_sharedSwarm) return _sharedSwarm;
  const mod = await import('hyperswarm');
  const Swarm = (
    mod as {
      default: new (opts?: {
        maxPeers?: number;
        /** WI-6063: outbound-dial ceiling — the inbound reserve (see
         *  {@link resolveMaxClientConnections}). Hyperswarm defaults it to
         *  Infinity, which lets dialling consume the entire `maxPeers` budget. */
        maxClientConnections?: number;
        bootstrap?: DhtBootstrapNode[];
        dht?: unknown;
        firewall?: (remotePublicKey: Buffer) => boolean;
        seed?: Buffer;
      }) => HyperswarmLike;
    }
  ).default;
  const guard = getSwarmGuard();
  const opts = swarmConstructorOpts();
  // EI-18683526122026208: persist the transport identity across restarts.
  // Without a `seed`/`keyPair`, hyperswarm mints `DHT.keyPair(undefined)` — a
  // fresh cryptographically random keypair on EVERY process boot — so this
  // process could never reconnect to a peer as the SAME identity after a
  // restart. loadOrGenerateSwarmSeed() persists a 32-byte seed the first time
  // this box constructs the shared swarm and reuses it on every later boot
  // (see identity/swarm-keypair.ts for the scope decision). Best-effort: a
  // keychain failure must not block swarm construction — fall back to an
  // ephemeral random identity (today's behavior) rather than throwing.
  let swarmSeed: Buffer | undefined;
  try {
    swarmSeed = await loadOrGenerateSwarmSeed();
  } catch (e) {
    console.warn(
      `[swarm] ⚠ failed to load/persist the swarm transport identity seed — falling back to an ` +
        `EPHEMERAL random identity for this boot (no cross-restart reconnect): ${e instanceof Error ? e.message : e}`,
    );
  }
  // B-FED-DHT observability (2026-06-24, su-34db4): make the effective DHT visible at
  // construction. Without this, "did this process join the ISOLATED testnet or the PUBLIC
  // DHT?" required tcpdump archaeology — and the silent-fallback failure mode (env set but
  // resolved bootstrap empty → hyperdht's `opts.bootstrap || BOOTSTRAP_NODES` quietly uses
  // the public DHT → isolated 2-machine federation breaks via public-DHT NAT hairpin) was
  // invisible. Loud-warn that exact case so it never has to be re-diagnosed by packet capture.
  // EI-8893: classify against the SAME env→file effective value swarmConstructorOpts
  // resolves, so a file-provided bootstrap (relaunch-immune) is reported ISOLATED, not
  // a false PUBLIC, and the assertDhtUniverse guard checks the value actually used.
  const dhtUniverse = resolveDhtUniverseState(readEffectiveDhtBootstrapRaw());
  if (dhtUniverse.mode === 'isolated') {
    // Informational (console.info, not warn) so the fail-on-console test gate stays
    // a defect signal — still captured in the operator's stdout log for observability.
    console.info(`[swarm] DHT bootstrap = ISOLATED ${bootstrapKey(dhtUniverse.bootstrap)}`);
  } else if (dhtUniverse.mode === 'misconfigured') {
    // The genuine misconfig (env set but resolved empty) — keep this LOUD (console.warn):
    // it is a real defect signal, and it never fires in clean tests (they don't set the var).
    console.warn(
      `[swarm] ⚠ PAPERCUSP_DHT_BOOTSTRAP is set ("${dhtUniverse.envValue}") but resolved to NO bootstrap — ` +
        `this swarm will join the PUBLIC DHT, so isolated 2-machine federation is BROKEN ` +
        `(public-DHT NAT hairpin). Check parseDhtBootstrap + that the var reaches THIS process before first swarm use.`,
    );
  } else {
    console.info('[swarm] DHT bootstrap = PUBLIC DHT (no PAPERCUSP_DHT_BOOTSTRAP set)');
  }
  // WI-3604: compute + memoize the split-DHT-universe recurrence-guard
  // assertion once, alongside the shared swarm's construction — reflects the
  // actual env this process resolved at THIS boot.
  _dhtUniverseAssertion = assertDhtUniverse(dhtUniverse, readExpectedDhtBootstrap());
  if (!_dhtUniverseAssertion.ok) {
    console.warn(`[swarm] ⚠ DHT universe mismatch: ${_dhtUniverseAssertion.detail}`);
  }
  let dht: unknown;
  if (opts.dhtHost) {
    const dhtMod = await import('hyperdht');
    const DHT = (
      dhtMod as {
        default?: new (opts?: { bootstrap?: DhtBootstrapNode[]; host?: string }) => unknown;
      }
    ).default;
    if (!DHT) throw new Error('hyperdht default export missing');
    dht = new DHT({ bootstrap: opts.bootstrap, host: opts.dhtHost });
    console.info(`[swarm] DHT host = ${opts.dhtHost}`);
  }
  // P-003: the firewall runs BEFORE the Noise handshake completes — it cheaply
  // rejects banned keys without spending handshake CPU. Hyperswarm only hands
  // the firewall the remote public key, so IP-level bans are enforced in the
  // connection handler instead.
  _sharedSwarm = new Swarm({
    maxPeers: opts.maxPeers,
    maxClientConnections: opts.maxClientConnections,
    ...(dht ? { dht } : opts.bootstrap ? { bootstrap: opts.bootstrap } : {}),
    ...(swarmSeed ? { seed: swarmSeed } : {}),
    firewall: (remotePublicKey: Buffer) => guard.firewall(remotePublicKey),
  });
  // WI-6063: make the budget split VISIBLE at construction. The reserve only
  // binds deep at scale, so without this line a dial refusal at 224/256 would
  // look like an unexplained connectivity failure rather than a deliberate bound.
  console.info(
    `[swarm] peer budget: maxPeers=${opts.maxPeers} maxClientConnections=${opts.maxClientConnections} ` +
      `(${opts.maxPeers - opts.maxClientConnections} slots reserved for INBOUND peers; ` +
      `override with PAPERCUSP_SWARM_INBOUND_RESERVE)`,
  );
  if (swarmSeed) {
    console.info('[swarm] transport identity: persisted (stable across restarts)');
  } else {
    console.info('[swarm] transport identity: EPHEMERAL (random this boot — see warning above)');
  }
  // P-005 (bg-host-freeze-eventloop-stall-2026-06-30): with 25+ harnesses each
  // adding ONE 'connection' listener (via joinHarnessSwarm) plus the hive-directory
  // gossip listener (createDirectoryGossip), the process-global shared swarm
  // accumulates N+1 listeners — all intentional, all permanent for the process
  // lifetime, none of them leaks. Node.js's default maxListeners=10 fires a
  // MaxListenersExceededWarning at the 11th harness, a false-positive alarm. Call
  // setMaxListeners(0) (= unlimited) to silence it. This does NOT hide a genuine
  // leak: every joinHarnessSwarm returns a SwarmHandle whose close() removes the
  // listener via swarm.off('connection', handler), and the listener-count test
  // (swarm-listener-count.test.ts) asserts bounded count after boot + close.
  (_sharedSwarm as { setMaxListeners?: (n: number) => void })?.setMaxListeners?.(0);
  // P-302: the log lines above report what we CONFIGURED. This one reports what
  // actually happened on the wire — the distinction that cost ~7h of packet
  // archaeology when a correctly-configured DHT could not reach its bootstrap.
  scheduleDhtReachabilityCheck(_sharedSwarm);
  return _sharedSwarm;
}

export function _setSharedSwarmForTests(s: HyperswarmLike | null): void {
  _sharedSwarm = s;
  // WI-37465: the in-flight memo must be dropped in lockstep. Without this a
  // test that resets to null would still be handed the PREVIOUS build's
  // promise by getSharedSwarm(), so the override would silently not take.
  _sharedSwarmPromise = null;
}

export function _peekSharedSwarmForTests(): HyperswarmLike | null {
  return _sharedSwarm;
}
