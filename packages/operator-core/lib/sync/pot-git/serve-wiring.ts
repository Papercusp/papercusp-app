/**
 * pot-git/serve-wiring.ts — wires `serveUploadPack` (fetch-transport.ts, G-2)
 * onto the shared per-harness Hyperswarm connection, so a peer member can
 * fetch this device's namespace over the `papercusp/pot-git` Protomux channel
 * (P-201, p2p-git-live-activation-2026-07-09). Until this module, the channel
 * was documented (fetch-transport.ts's header) but had no live caller — every
 * fetch ran over a plain test socket pair.
 *
 * WHY A NEW MODULE (not just calling serveUploadPack from the connection
 * handler directly): Protomux channels are MESSAGE-based, not a raw byte
 * duplex — `addMessage({ encoding, onmessage })` sends/receives one discrete
 * frame at a time. `serveUploadPack`/`fetchOverDuplex` need a `node:stream`
 * `Duplex` to pipe a `git upload-pack`/`git fetch` child process's stdio
 * through. So this module MULTIPLEXES many concurrent logical fetch duplexes
 * over ONE Protomux channel per (muxer, hive topic) — mirroring the announce
 * channel's per-(muxer,topic) uniqueness (swarm.ts's `openAnnounceChannel`)
 * but framing REQUEST / DATA / END / REFUSE messages keyed by a per-fetch id
 * instead of one flat gossip frame.
 *
 * Wire shape — SIX message slots on ONE channel (compact-encoding, not JSON:
 * a git pack is binary and can run tens of MB; JSON/base64 would double the
 * bytes on the wire). Both peers construct the channel with these `addMessage`
 * calls in this EXACT order so the wire `type` indices line up (protomux
 * assigns `type` by call order, per-channel):
 *   0 req          { id, repoKey, peerGithubUserId } — open a logical fetch (requester → server)
 *   1 refuse        { id, reason }                    — server refused a req (server → requester)
 *   2 dataToServer  { id, chunk }                      — requester's outgoing bytes (client → server)
 *   3 dataToClient  { id, chunk }                      — server's response bytes (server → client)
 *   4 endToServer   { id, code }                       — requester's write side ended
 *   5 endToClient   { id, code }                       — server's write side ended
 *
 * Every message type is scoped to exactly one role's usage (e.g. `dataToServer`
 * always means "bytes flowing INTO whoever is serving id"), so ids only need to
 * be unique within each PEER's own outgoing-request set — no cross-peer id
 * coordination, and no ambiguity if both peers happen to pick the same id for
 * unrelated requests.
 *
 * SERVER side ({@link wireHiveGitServe}): on `req`, re-checks `hiveGit.mode`
 * (S-5: NEVER cached, so a mode flip needs no re-seed — mirrors
 * git-sync-action's per-tick re-consult of the same setting) and resolves the
 * repo path for `(potHomeSlug, repoKey)` — a `scope:`-prefixed repoKey
 * (`scope-repo.ts`'s `scopeRepoWireKey`/`parseScopeRepoWireKey`) resolves via
 * `scopeRepoPath` instead of the plain `hiveGitRepoPath` join, since a
 * `scopes/<owner>/<slug>.git` path has more path components than a single
 * wire repoKey token can address otherwise. A legacy-mode hive always REFUSEs —
 * no bytes are ever served, so legacy hives are byte-for-byte unchanged. Scope
 * (`scopes/`) repos call `authorizeScopeRepoServe` (scope-serve-gate.ts),
 * which needs a roster-VERIFIED peer identity — never the wire `req` frame's
 * self-reported `peerGithubUserId` (that field is NOT authenticated by
 * anything and a hostile peer could set it to any value). WI-3641: the
 * verified identity comes from `config.resolvePeerDevicePubkey(socket)` — a
 * caller-supplied resolver (swarm.ts wires `resolveVerifiedDevicePubkeyForSocket`
 * from peer-dial-registry.ts's SIGNED hello handshake) that answers "which
 * device, if any, has cryptographically PROVEN it owns this live connection".
 * No resolver, or no verified device on this socket yet ⇒ refuse — serving
 * unauthenticated would be worse than not serving at all.
 *
 * CLIENT side ({@link openHiveGitFetchDuplex}): sends `req`, returns a Duplex
 * the caller drives with `fetchOverDuplex` — the SAME `openDuplex: () =>
 * Promise<Duplex>` seam every downstream consumer already expects
 * (worktree-bridge.ts, github-bridge-tick via the integrator). A `refuse` or a
 * channel/connection loss destroys the duplex with an error; `fetchOverDuplex`
 * never throws on that (fail-soft: a broken fetch resolves nonzero).
 *
 * Fail-soft throughout: every handler is defensive (a throwing peer frame, a
 * missing session, a wiring failure) and NEVER crashes the shared swarm
 * connection handler — same contract as `openAnnounceChannel`.
 */
import { Duplex } from 'node:stream';
import { join } from 'node:path';
import Protomux, { type ProtomuxChannel } from 'protomux';
import c, { type CompactEncoding, type CompactEncodingState } from 'compact-encoding';
import {
  readPotGitMode,
  type PotGitModeRead,
  type PotGitModeSource,
} from '../../harness/git-sync/hive-git-mode';
import { hiveGitRepoPath, pathExists } from './storage';
import { isScopeRepoFamilyPath, parseScopeRepoWireKey, scopeRepoPath } from './scope-repo';
import {
  POT_GIT_PROTOCOL,
  serveUploadPack,
  type GovernedServeExecution,
  type TransportResult,
} from './fetch-transport';
import { runGovernedOperation } from '../../resource-governor/execution';
import { authorizeScopeRepoServe, type ScopeRepoServeGrant } from './scope-serve-gate';
import { getScopeRoster } from '../../p2p/scope-roster';
import { resolveGithubUserIdForDevicePubkey } from '../hyperbee/hive-member-identity-set';
import {
  findSupersededRepoKey,
  supersededRepoKeyRefusal,
  type SupersededRepoKeyVerdict,
} from './repo-identity';
import { loadHarnessRegistry } from '../../harness-registry';

export { POT_GIT_PROTOCOL };

/** Config registered by {@link wireHiveGitServe} — what this connection may serve. */
export interface PotGitServeConfig {
  /** The hive this connection's swarm topic belongs to (repos are resolved
   *  under it — `hiveGitRepoPath(potHomeSlug, repoKey)`). */
  potHomeSlug: string;
  workspaceId: string;
  /** Per-fetch wall-clock ceiling forwarded to `serveUploadPack` (default
   *  DEFAULT_FETCH_TIMEOUT_MS — see fetch-transport.ts). */
  timeoutMs?: number;
  /**
   * WI-3641: resolve the SIGNATURE-VERIFIED device_pubkey bound to a live
   * connection socket, or `undefined` if none has been verified on it yet.
   * Required to authorize a `scopes/` repo fetch — swarm.ts wires
   * `resolveVerifiedDevicePubkeyForSocket` (peer-dial-registry.ts's signed
   * hello handshake) here. Omitted ⇒ every scope-repo fetch refuses
   * (`scope-repo-no-resolver`) — fail-closed, matching the pre-WI-3641
   * deferral's behavior when this config is absent.
   */
  resolvePeerDevicePubkey?: (socket: unknown) => string | undefined;
}

// ─── wire frames ─────────────────────────────────────────────────────────

interface ReqFrame {
  id: number;
  repoKey: string;
  peerGithubUserId: number;
}
interface RefuseFrame {
  id: number;
  reason: string;
}
interface DataFrame {
  id: number;
  chunk: Buffer;
}
interface EndFrame {
  id: number;
  code: number;
}

const reqEncoding: CompactEncoding<ReqFrame> = {
  preencode(state, v) {
    c.uint.preencode(state, v.id);
    c.string.preencode(state, v.repoKey);
    c.uint.preencode(state, v.peerGithubUserId);
  },
  encode(state, v) {
    c.uint.encode(state, v.id);
    c.string.encode(state, v.repoKey);
    c.uint.encode(state, v.peerGithubUserId);
  },
  decode(state) {
    const id = c.uint.decode(state);
    const repoKey = c.string.decode(state);
    const peerGithubUserId = c.uint.decode(state);
    return { id, repoKey, peerGithubUserId };
  },
};

const refuseEncoding: CompactEncoding<RefuseFrame> = {
  preencode(state, v) {
    c.uint.preencode(state, v.id);
    c.string.preencode(state, v.reason);
  },
  encode(state, v) {
    c.uint.encode(state, v.id);
    c.string.encode(state, v.reason);
  },
  decode(state) {
    const id = c.uint.decode(state);
    const reason = c.string.decode(state);
    return { id, reason };
  },
};

const dataEncoding: CompactEncoding<DataFrame> = {
  preencode(state, v) {
    c.uint.preencode(state, v.id);
    c.buffer.preencode(state, v.chunk);
  },
  encode(state, v) {
    c.uint.encode(state, v.id);
    c.buffer.encode(state, v.chunk);
  },
  decode(state) {
    const id = c.uint.decode(state);
    const chunk = c.buffer.decode(state);
    return { id, chunk };
  },
};

const endEncoding: CompactEncoding<EndFrame> = {
  preencode(state, v) {
    c.uint.preencode(state, v.id);
    c.int.preencode(state, v.code);
  },
  encode(state, v) {
    c.uint.encode(state, v.id);
    c.int.encode(state, v.code);
  },
  decode(state) {
    const id = c.uint.decode(state);
    const code = c.int.decode(state);
    return { id, code };
  },
};

// ─── the per-fetch Duplex adapter ───────────────────────────────────────

/** One logical fetch stream, framed over the shared channel. Default
 *  `allowHalfOpen: true` (node's Duplex default) is load-bearing: ending our
 *  WRITE side must not also end our READ side — a git pack negotiation is
 *  asymmetric (the requester's write side legitimately ends well before the
 *  server's response finishes), exactly mirroring `fetchOverDuplex`'s own
 *  `allowHalfOpen` socket-pair contract. */
class FrameDuplex extends Duplex {
  /** EI-18776567787336109: per-session forensics. A channel that dies mid-fetch
   *  used to destroy every session with a bare "serve channel closed", which
   *  cannot distinguish an idle channel being reaped from a live multi-MB
   *  transfer being cut — the exact ambiguity that made a cold-join stall
   *  undiagnosable from the joining machine. */
  readonly startedAt = Date.now();
  bytesOut = 0;
  bytesIn = 0;
  /** WI-6412: wall-clock of the most recent outbound write, i.e. the last moment
   *  this serve made real progress. `0` until the first byte leaves — which is
   *  what lets the admission rule tell "streaming a 4GB pack right now" from
   *  "spawned, never produced anything, requester is long gone".
   *
   *  ⚠ LOAD-BEARING, and silently breakable: this is stamped inside `_write`,
   *  which node re-enters only AFTER the previous write's callback fires. Since
   *  `_write` defers that callback until the wire drains (see the backpressure
   *  note there), a peer that stops reading stalls the callback in
   *  `drainWaiters` and this clock FREEZES. That freeze is the whole reason
   *  rule 0 (`resolveServeAdmission`) is safe: a serve whose requester really
   *  did abandon it stops looking "streaming" on its own, so the refusal lapses
   *  instead of wedging the repo forever. Re-keying this to bytes QUEUED rather
   *  than bytes ACCEPTED — e.g. stamping it from the caller, or hoisting it
   *  above the `sendChunk` call — destroys that property, and no existing test
   *  fails when it does. Verified 2026-08-01 against protomux: a closed channel
   *  returns `false` (not `undefined`) from `send`, so the backpressure branch
   *  is genuinely taken; fact `pot-git-rule0-backpressure-freeze-confirmed-sound`. */
  lastWriteAt = 0;
  constructor(
    /** Returns protomux's `drained` flag — `false` means the wire is backed up
     *  and this duplex must stop writing until `onBackpressure` resolves. */
    private readonly sendChunk: (chunk: Buffer) => boolean | void,
    private readonly onLocalEnd: (code: number) => void,
    /** Defer the pending write callback until the channel drains. Defaults to
     *  resuming immediately, which preserves the old fire-and-forget behaviour
     *  for the fail-soft/decoy duplexes that have no real channel behind them. */
    private readonly onBackpressure: (resume: () => void) => void = (resume) => resume(),
  ) {
    super();
    // Fail-soft AT CONSTRUCTION (WI-5177 live crash, 2026-07-17): this module's
    // contract is that consumers read `.destroyed`, and a refusal/close can
    // destroy(err) this duplex at ANY moment — including the gap before a
    // consumer attaches its own 'error' listener (bootstrap.ts awaits between
    // openDuplex and fetchOverDuplex). With no listener, that destroy(err)
    // becomes an unhandled 'error' → process-fatal uncaughtException (took the
    // bg-host down: "pot-git serve refused: no-such-repo"). A no-op base
    // listener makes every FrameDuplex safe; consumers' own listeners still
    // fire alongside it.
    this.on('error', () => {
      /* fail-soft: consumers read `.destroyed` / attach their own listener */
    });
  }
  override _write(chunk: Buffer, _enc: string, cb: (e?: Error | null) => void): void {
    try {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.bytesOut += buf.length;
      this.lastWriteAt = Date.now();
      // EI-18776567787336109 — REAL BACKPRESSURE.
      //
      // This used to call cb() unconditionally, which told node "that write is
      // done, send more" no matter how backed up the muxer's stream was. For a
      // small warm fetch (100-650ms) that is invisible; for a multi-GB cold
      // join it means the whole pack is shovelled into the connection as fast
      // as upload-pack can produce it, with nothing in git's own pipeline able
      // to slow it down.
      //
      // protomux already reports this: `send()` returns the muxer's `drained`
      // flag (the underlying `stream.write()` result), and a channel can
      // register an `ondrain` callback. Honouring it is what turns this duplex
      // into a properly flow-controlled stream — the write callback is simply
      // deferred until the wire can accept more, which pauses `child.stdout`
      // through the existing pipe.
      const drained = this.sendChunk(buf);
      if (drained === false) this.onBackpressure(cb);
      else cb();
    } catch (e) {
      cb(e instanceof Error ? e : new Error(String(e)));
    }
  }
  override _read(): void {
    /* push-driven from inbound frames — nothing to pull here */
  }
  override _final(cb: (e?: Error | null) => void): void {
    try {
      this.onLocalEnd(0);
    } catch {
      /* best-effort — a dropped connection must not throw out of _final */
    }
    cb();
  }
  override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    cb(err);
  }
  /** Deliver an inbound DATA frame's bytes to the readable side.
   *
   *  The `readableEnded` arm is the load-bearing one: pushing after EOF emits
   *  ERR_STREAM_PUSH_AFTER_EOF, which this class's fail-soft 'error' listener
   *  would silently swallow. The `destroyed` arm is belt-and-braces only —
   *  measured, node already makes push-after-destroy a silent no-op.
   *
   *  NOTE (EI-18765930091826096) — this guard is NOT what stops the session leak,
   *  and must not be mistaken for it. The bytes that degraded a peer channel were
   *  buffered into a duplex that was still ALIVE and merely unread (its reader,
   *  git, had been SIGKILLed), which no condition here can detect: dropping on a
   *  live session would corrupt a healthy fetch. What actually stops it is making
   *  the session UNREACHABLE — `openHiveGitFetchDuplex`'s close-prune plus
   *  `fetchOverDuplex`'s ownership release — so no frame is ever routed here at
   *  all. This only closes the narrow race between those two. */
  pushChunk(chunk: Buffer): void {
    if (this.destroyed || this.readableEnded) return;
    this.bytesIn += chunk.length;
    this.push(chunk);
  }
  /** Deliver an inbound END frame — EOF on the readable side (half-open: the
   *  writable side is untouched). */
  pushEnd(): void {
    this.push(null);
  }
}

// ─── per-(muxer, topic) channel state ───────────────────────────────────

interface ChannelMessages {
  req: { send(v: ReqFrame): void };
  refuse: { send(v: RefuseFrame): void };
  // These two return protomux's `drained` flag (`stream.write()`'s result) —
  // `false` means stop writing until the channel's `ondrain` fires.
  dataToServer: { send(v: DataFrame): boolean | void };
  dataToClient: { send(v: DataFrame): boolean | void };
  endToServer: { send(v: EndFrame): void };
  endToClient: { send(v: EndFrame): void };
}

interface ChannelState {
  channel: ProtomuxChannel | null;
  messages: ChannelMessages | null;
  opened: boolean;
  openedWaiters: Array<() => void>;
  /** Set by `wireHiveGitServe` — null means "not registered to serve on this
   *  connection" (an inbound req refuses `not-serving`, never crashes). */
  serverConfig: PotGitServeConfig | null;
  /** WI-3641: the raw connection socket `wireHiveGitServe` was called with —
   *  threaded through so `handleReq` can resolve the caller's verified device
   *  identity via `serverConfig.resolvePeerDevicePubkey(socket)` for the
   *  `scopes/` repo gate. Null until `wireHiveGitServe` registers. */
  socket: unknown;
  /** Sessions where WE are the server (id allocated by the peer's req). */
  serverSessions: Map<number, FrameDuplex>;
  /** Sessions where WE are the requester (id allocated by us). */
  clientSessions: Map<number, FrameDuplex>;
  nextClientId: number;
  /** Highest live session total already reported by `noteSessionHighWater`, so
   *  a sustained leak reports once per NEW high-water instead of per session. */
  sessionWarnHighWater: number;
  /** Write callbacks parked because the muxer's stream said it was full;
   *  released by the channel's `ondrain` (or by close). See FrameDuplex._write. */
  drainWaiters: Array<() => void>;
  /** The channel id (topic) this state is keyed by, and the muxer it lives on.
   *  Carried purely so a refusal can NAME them: `not-serving` means "no serve
   *  config registered for THIS (muxer, topic)", and a refusal that omits the
   *  lookup key its own reason depends on is structurally undiagnosable — it
   *  cannot distinguish a dialer/server channel-id MISMATCH (this muxer serves
   *  other topics, just not the requested one) from a muxer that was never
   *  wired at all. That ambiguity blocked the live rig<->tower papercusp
   *  diagnosis for hours; see the refusal log in `handleReq`. */
  topicHex: string;
  mux: object | null;
}

const stateByMuxer = new WeakMap<object, Map<string, ChannelState>>();

function statesFor(mux: object): Map<string, ChannelState> {
  let m = stateByMuxer.get(mux);
  if (!m) {
    m = new Map();
    stateByMuxer.set(mux, m);
  }
  return m;
}

/** Per-(muxer, topic) serve registration that SURVIVES the onclose eviction in
 *  `ensureChannel` (WI-3496/WI-5177 drill): `wireHiveGitServe` runs once per
 *  connection, so a channel re-created after a close (or materialized by the
 *  lazy `pair()` notifier) would otherwise have `serverConfig` null forever and
 *  refuse every inbound req `not-serving`. */
const serveConfigByMuxer = new WeakMap<object, Map<string, { serverConfig: PotGitServeConfig; socket: unknown }>>();

function serveConfigsFor(mux: object): Map<string, { serverConfig: PotGitServeConfig; socket: unknown }> {
  let m = serveConfigByMuxer.get(mux);
  if (!m) {
    m = new Map();
    serveConfigByMuxer.set(mux, m);
  }
  return m;
}

/** Topic hexes THIS BOX has explicitly wired serve for via `wireHiveGitServe`
 *  on ANY connection (process-global) — the SERVE-side mirror of
 *  peer-dial-registry.ts's `wiredTopics` (WI-5210).
 *
 *  WHY (EI-18802104888674071, diagnosed 2026-07-27 from a live rig refusal):
 *  `wireHiveGitServe` runs once per swarm connection-handler firing, with THAT
 *  swarm's own topic — so `serveConfigByMuxer` only ever learns the pot whose
 *  swarm handled the connection. But `resolveMuxStream` registers `mux.pair`
 *  at PROTOCOL scope with NO id filter, so `ensureChannel(mux, id)`
 *  materializes a channel for ANY pot-git topic the remote opens on that
 *  muxer. When two pots share one peer connection, whichever pot wired the
 *  muxer wins and the other pot's inbound reqs refuse `not-serving` FOREVER on
 *  that connection — observed live as
 *    `topic=d85dc18c…(papercusp) serveTopics=0edc4b5f…(hello-world-3-pot)`.
 *  The dial plane already solved exactly this; serve was the unfixed half.
 *
 *  SAFETY — this widens ONLY the topic gate, never the authorization:
 *   - lookup is by the SAME topicHex the remote asked for, so the assertion is
 *     precisely "this box deliberately joined + wired serve for that pot
 *     somewhere". It is NEVER "any config on this muxer" — that would serve an
 *     unauthorized pot to a peer that only ever joined a different one.
 *   - the config is pot-scoped data (`potHomeSlug`/`workspaceId`/`timeoutMs`)
 *     plus a resolver that is a pure function of the socket handed to it, so
 *     nothing connection-bound is carried across.
 *   - peer IDENTITY comes from the CURRENT muxer's socket (`socketByMuxer`),
 *     never the socket stored alongside the original registration — reusing
 *     that would authenticate this peer as a different one. */
const serveConfigByTopic = new Map<string, PotGitServeConfig>();

/** The live connection socket for a muxer, recorded wherever this module has
 *  both in hand. Only used to give the `serveConfigByTopic` fallback above the
 *  CURRENT connection's socket for identity resolution. */
const socketByMuxer = new WeakMap<object, unknown>();

/**
 * Decide what a freshly-materialized channel should serve — the whole of the
 * EI-18802104888674071 rule, as a pure function so the safety boundary is
 * directly assertable (the surrounding path needs a live Protomux).
 *
 * @param kept        this (muxer, topic)'s own registration, if `wireHiveGitServe` ran here
 * @param shared      the process-wide registration for the SAME topicHex, if any
 * @param muxerSocket the CURRENT muxer's live socket, if known
 */
function resolveServeRegistration(
  kept: { serverConfig: PotGitServeConfig; socket: unknown } | undefined,
  shared: PotGitServeConfig | undefined,
  muxerSocket: unknown,
): { serverConfig: PotGitServeConfig; socket: unknown } | null {
  // The muxer's own registration always wins — it carries the socket serve was
  // actually wired against.
  if (kept) return { serverConfig: kept.serverConfig, socket: kept.socket };
  // No process-wide registration for this exact topic ⇒ this box never wired
  // serve for that pot anywhere. Refusing `not-serving` is CORRECT here.
  if (!shared) return null;
  // Wired elsewhere, but we cannot identify the peer on this connection —
  // adopt nothing rather than a config we could not authenticate against.
  if (muxerSocket === undefined) return null;
  return { serverConfig: shared, socket: muxerSocket };
}

/** Muxers on which the lazy-accept `pair()` notifier (below) is already
 *  registered — pair() is idempotent to call twice, but this avoids
 *  redundant re-registration on every `resolveMuxStream` call. */
const potGitPairedMuxers = new WeakSet<object>();

function newState(topicHex: string, mux: object | null): ChannelState {
  return {
    topicHex,
    mux,
    channel: null,
    messages: null,
    opened: false,
    openedWaiters: [],
    serverConfig: null,
    socket: null,
    serverSessions: new Map(),
    clientSessions: new Map(),
    nextClientId: 1,
    sessionWarnHighWater: 0,
    drainWaiters: [],
  };
}

/** Release every write parked on backpressure. Called on the channel's
 *  `ondrain` (the wire can take more) AND on close (so a parked write unwinds
 *  instead of stranding the pipe forever — the duplex is being destroyed
 *  anyway, so resuming is always safe). */
function flushDrainWaiters(state: ChannelState): void {
  for (const resume of state.drainWaiters.splice(0)) {
    try {
      resume();
    } catch {
      /* a resumed write must never throw into the muxer */
    }
  }
}

function markOpened(state: ChannelState): void {
  state.opened = true;
  const waiters = state.openedWaiters.splice(0);
  for (const w of waiters) w();
}

/**
 * EI-18752434722211671 — the ceiling on OPENING a pot-git serve channel.
 *
 * Opening a channel on an ALREADY-CONNECTED socket is a single protomux
 * control-frame round trip (milliseconds); the noise `opened` handshake on a
 * fresh connection is the slower of the two and still sub-second on a healthy
 * link. 15s is therefore ~1000x headroom, deliberately matched to the
 * ref-announce leg's own fetch ceiling so a dead peer costs one ceiling, not
 * two stacked ones.
 */
export const POT_GIT_CHANNEL_OPEN_TIMEOUT_MS = 15_000;

/**
 * Resolve true when `p` settles (either way) within `ms`, false on the ceiling.
 * Never rejects — a rejection IS a settle, and every caller here treats "did it
 * finish in time" as the only question. Unref'd so a pending ceiling can never
 * hold the process open.
 */
function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (v: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    timer = setTimeout(() => done(false), ms);
    timer.unref?.();
    void Promise.resolve(p).then(
      () => done(true),
      () => done(true),
    );
  });
}

/**
 * Wait for the channel to open — BOUNDED. Resolves true when it opened, false
 * when `timeoutMs` elapsed first.
 *
 * EI-18752434722211671 (root cause of a device-wide git-sync wedge): this used
 * to be an UNBOUNDED `new Promise(resolve => state.openedWaiters.push(resolve))`
 * — it settled ONLY via `markOpened` (channel opened) or `ensureChannel`'s
 * onclose waiter-flush (channel closed). A channel that does NEITHER — opened
 * but never accepted by a peer that is wired yet wedged, a muxer torn down
 * without that channel's onclose firing — left this await pending FOREVER.
 * `resolveMuxStream`'s own comment above already named the symptom ("our own
 * `onopen` never fires and `waitOpened` hangs forever"), but only ONE cause of
 * it (the pair() open race) was ever fixed; the await itself stayed unbounded,
 * so every other cause still hung.
 *
 * That hang is NOT survivable by the callers' own timeouts: `fetchOverDuplex`'s
 * ceiling covers the FETCH, and this runs strictly BEFORE it — the duplex does
 * not exist yet. Live-observed 2026-07-26 on the P-302 rig: a git-sync fire
 * checkpointed 8 steps, entered `git-sync:ref-announce`, and never recorded a
 * 9th. DBOS faithfully re-claimed the workflow 3 times and each recovery
 * re-entered the same hang, so the routine's dedup pin was never released and
 * EVERY subsequent git-sync enqueue on that device was rejected for hours.
 * Durable infrastructure makes an unbounded await MORE persistent, not less.
 *
 * A timed-out waiter REMOVES itself from `openedWaiters` — otherwise a channel
 * that never opens accumulates one dead waiter per tick, forever.
 */
function waitOpened(state: ChannelState, timeoutMs: number): Promise<boolean> {
  if (state.opened) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiter = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const i = state.openedWaiters.indexOf(waiter);
      if (i >= 0) state.openedWaiters.splice(i, 1);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    state.openedWaiters.push(waiter);
  });
}

/**
 * The fail-soft return of `openHiveGitFetchDuplex`: an already-destroyed
 * duplex carrying `reason`. Callers check `.destroyed` (and `fetchOverDuplex`
 * fast-paths it into a `fetch-failed` result) — they never attach an 'error'
 * listener, so the destroy-time error is swallowed here. Without that no-op
 * listener a `.destroy(err)` schedules an UNHANDLED 'error' emission on the
 * next tick, which is an uncaught exception on the host (the same footgun
 * peer-dial-registry.ts's `openHiveGitDuplexToDevice` fixed).
 */
function failSoftDuplex(reason: string): Duplex {
  const d = new FrameDuplex(
    () => {},
    () => {},
  );
  d.on('error', () => {});
  d.destroy(new Error(reason));
  return d;
}

/** A dropped/closed connection fails every in-flight session loudly (destroy,
 *  never a silent hang) — `fetchOverDuplex`/`serveUploadPack` both treat a
 *  destroyed duplex as a failed (nonzero) result, never a thrown exception. */
function failAllSessions(state: ChannelState): void {
  const live = [...state.serverSessions.values(), ...state.clientSessions.values()];
  // EI-18776567787336109: say WHAT WAS LOST, not just that something closed.
  //
  // A bare "serve channel closed" is the same string whether an idle channel
  // was reaped (harmless, constant background noise — pot-git channels churn
  // 23-36x/min) or a live multi-MB transfer was cut mid-pack (a real fault).
  // The joiner reported only that string, so a cold-join stall was
  // indistinguishable from routine churn and could not be diagnosed from the
  // machine that was actually failing. The counters below are what separate
  // them: sessions in flight, how long they had been running, and how many
  // bytes had already moved.
  const now = Date.now();
  let bytes = 0;
  let oldestMs = 0;
  for (const d of live) {
    bytes += d.bytesOut + d.bytesIn;
    oldestMs = Math.max(oldestMs, now - d.startedAt);
  }
  const sock = state.socket as { destroyed?: boolean } | null | undefined;
  const detail = live.length
    ? ` while ${live.length} session(s) were in flight` +
      ` (oldest ${oldestMs}ms, ${bytes}B moved, socketDestroyed=${sock?.destroyed ?? 'unknown'})`
    : '';
  const reason = `pot-git: serve channel closed${detail}`;
  for (const d of live) d.destroy(new Error(reason));
  state.serverSessions.clear();
  state.clientSessions.clear();
  // Only worth a line when work was actually lost — an idle close is noise.
  if (live.length) potGitLog('warn', `[pot-git] channel CLOSED${detail} peer=${peerTag(state)}`);
}

// ─── WI-6184: serve-side observability ──────────────────────────────────
// Before this, the ENTIRE serving half of the p2p-git plane was silent: an
// inbound fetch that was refused, that threw, or that served a pack left no
// trace on this machine. A peer whose clone hung for the full 120s ceiling
// therefore had nothing to report and we had nothing to read — the documented
// cause of five stalled diagnosis wakes (git-sync-action.ts:1746-1757).
//
// Deliberately NOT env-gated: this is release-grade observability, not a debug
// trace. Volume is controlled instead — a served pack is rare and always logged,
// while REFUSALS (which a misconfigured or looping peer can generate steadily)
// are aggregated per reason, never emitted per event.
const REFUSE_LOG_WINDOW_MS = 30_000;
const refuseLogLast = new Map<string, { at: number; suppressed: number }>();

/**
 * WI-6815 — the serve gate's refusal reason per mode-read state.
 *
 * `mode-legacy` is reserved for an OWNER-CHOSEN legacy hive (source `set`): the
 * one case where refusing is correct and final. The other three each mean "I
 * could not establish that this hive serves", which is an operational fault the
 * dialer must be able to tell apart:
 *
 *   mode-unset       no `hiveGit.mode` row here. On a member that IS meant to
 *                    serve, this is the federation not having landed — the
 *                    setting never replicated, or it replicated under a scope
 *                    this reader is not looking in.
 *   mode-malformed   a row exists but carries a value that is not a known mode.
 *   mode-unreadable  the settings-store read THREW — a PG blip / no pool / a
 *                    migration mid-flight. Says nothing about the hive's intent.
 *
 * These strings are wire-visible (handleRefuse re-raises them on the dialer), so
 * they are part of the diagnostic contract, not local log text — do not collapse
 * them back into one reason.
 */
const POT_GIT_MODE_REFUSAL: Record<PotGitModeSource, string> = {
  set: 'mode-legacy',
  absent: 'mode-unset',
  malformed: 'mode-malformed',
  error: 'mode-unreadable',
};

/** Emit a plane diagnostic. Suppressed under vitest — the repo runs
 *  `vitest-fail-on-console`, so an unconditional diagnostic would fail every
 *  suite that exercises a refusal path (live-caught: serve-wiring's 3 refusal
 *  tests). Same guard swarm.ts's data-path sampler uses for the same reason. */
function potGitLog(level: 'info' | 'warn', msg: string): void {
  if (process.env.VITEST) return;
  if (level === 'warn') console.warn(msg);
  else console.info(msg);
}

/** True when this refusal should be logged now; folds any suppressed repeats
 *  from the current window into the returned count so a storm reports as one
 *  line with a tally instead of N lines. */
function shouldLogRefusal(key: string, now: number): { log: boolean; suppressed: number } {
  const prev = refuseLogLast.get(key);
  if (prev && now - prev.at < REFUSE_LOG_WINDOW_MS) {
    prev.suppressed++;
    return { log: false, suppressed: prev.suppressed };
  }
  const suppressed = prev?.suppressed ?? 0;
  refuseLogLast.set(key, { at: now, suppressed: 0 });
  // Bound the map: these keys are (reason, repoKey, peer) tuples, so a hostile
  // peer varying repoKey could otherwise grow it without limit.
  if (refuseLogLast.size > 512) {
    for (const [k, e] of refuseLogLast) {
      if (now - e.at >= REFUSE_LOG_WINDOW_MS) refuseLogLast.delete(k);
      if (refuseLogLast.size <= 256) break;
    }
  }
  return { log: true, suppressed };
}

/**
 * EI-18765930091826096 RECURRENCE GUARD — the detector whose absence let a
 * session leak run invisibly for days.
 *
 * That incident was not only a lifecycle bug; it was a MONITORING gap. Sessions
 * live in per-(muxer, topic) private maps with no observable surface — the
 * `_testing.sessionCounts` seam below exists only for tests — so on a live peer
 * the leak was unreadable. It presented as "the channel degrades until it can
 * serve nothing, and only a restart clears it", and the only signals available
 * were indirect (RSS growth, zombie `git upload-pack` processes). Root-causing
 * it took days precisely because the decisive number could not be read.
 *
 * WHAT HEALTHY LOOKS LIKE, so the threshold is not arbitrary: a session is
 * per-fetch and is released when the fetch settles, so the live count sits at
 * 0-1 and returns to 0. A cold-join deepen ladder (`bootstrap.ts`
 * INITIAL_DEEPEN_COMMITS 64 -> MAX_DEEPEN_COMMITS 8192) runs its rungs
 * SEQUENTIALLY, so even a full ladder never holds many at once. A leak, by
 * contrast, is MONOTONIC — abandoned sessions are never collected — so it
 * crosses any fixed threshold quickly and keeps going. The gap between "0-1
 * normally" and "grows without bound" is what makes a single fixed threshold
 * reliable here rather than a tuning problem.
 *
 * Volume is controlled the same way the refusal log is (see `potGitLog`): this
 * is release-grade observability, NOT an env-gated debug trace — a leak that
 * only reports when someone already suspected it and set a flag is no detector
 * at all. It is silent in healthy operation, and a sustained leak reports once
 * per NEW high-water rather than once per session, so it can never itself
 * become the storm.
 */
const SESSION_LEAK_WARN_AT = 8;

/**
 * Returns whether it EMITTED (callers ignore it; tests do not). The
 * once-per-new-high-water suppression is the property most likely to rot into
 * either a per-session storm or total silence, and neither is observable from
 * the outside: `potGitLog` is a no-op under vitest, and the high-water VALUE is
 * identical whether a repeat call warned or correctly stayed quiet. Returning
 * the decision is what makes suppression assertable at all — without it those
 * cases pass against a detector that warns every single time.
 */
function noteSessionHighWater(state: ChannelState): boolean {
  const client = state.clientSessions.size;
  const server = state.serverSessions.size;
  const total = client + server;
  if (total < SESSION_LEAK_WARN_AT || total <= state.sessionWarnHighWater) return false;
  state.sessionWarnHighWater = total;
  potGitLog(
    'warn',
    `[pot-git] sessions HIGH client=${client} server=${server} peer=${peerTag(state)} ` +
      `(>= ${SESSION_LEAK_WARN_AT}; sessions are released per-fetch, so a climbing count is a LEAK — see EI-18765930091826096)`,
  );
  return true;
}

/** Short, log-safe tag for the peer that opened this serve session. Uses the
 *  SIGNATURE-VERIFIED device identity where one exists (never the wire frame's
 *  self-reported fields) so the tag can be trusted in a forensic read. */
function peerTag(state: ChannelState): string {
  try {
    const pk = state.serverConfig?.resolvePeerDevicePubkey?.(state.socket);
    return pk ? pk.slice(0, 8) : 'unverified';
  } catch {
    return 'unverified';
  }
}

/**
 * WI-6364 (fix C): is `requestedKey` an ABANDONED alias of a repo this pot
 * serves? The decision itself is pure (`findSupersededRepoKey` in
 * repo-identity.ts, where it is unit-tested); this only supplies the entry set.
 *
 * SCOPED TO THIS POT — the pot home entry (`slug === potHomeSlug`, `self_repo`)
 * plus its members (`hive_slug === potHomeSlug`) — because that is exactly the
 * set whose stores live under `hiveGitRepoPath(potHomeSlug, …)`. A registry-wide
 * scan would let an UNRELATED pot's abandoned alias refuse a fetch here.
 *
 * FAILS OPEN by contract. An unreadable/absent registry means "no verdict", not
 * "refuse": a diagnostic improvement must never be able to take the serve plane
 * down, and falling through leaves exactly today's behaviour (the existence gate
 * below). Same fail-soft posture as `readPotGitMode`'s catch above.
 */
async function resolveSupersededRepoKey(
  potHomeSlug: string,
  requestedKey: string,
): Promise<SupersededRepoKeyVerdict | null> {
  try {
    const { projects } = await loadHarnessRegistry();
    const entries = projects.filter((p) => p.slug === potHomeSlug || p.hive_slug === potHomeSlug);
    return findSupersededRepoKey(requestedKey, entries);
  } catch {
    return null;
  }
}

/**
 * The diagnostic tail of a `serve REFUSED` line: which (muxer, topic) the
 * refusal is ABOUT.
 *
 * `not-serving` is emitted when `state.serverConfig` is null for THIS (muxer,
 * topic) — so a refusal that does not name the topic omits the very lookup key
 * its own reason depends on. Naming the topic alone still is not actionable;
 * what decides the fix is whether the muxer serves OTHER topics:
 *
 *   - `serveTopics=<none>`      the connection handler never wired serve on this
 *                               muxer at all.
 *   - `serveTopics=a…,b…` but   a dialer/server channel-id MISMATCH: the dial
 *     not the requested topic   path opens a pot-git channel on whatever live
 *                               socket reaches the device, while serve is
 *                               registered per (muxer, topic).
 *
 * Deliberately NOT called `wiredTopics`: peer-dial-registry.ts already owns a
 * module-level `wiredTopics` map, and that one is PROCESS-WIDE and belongs to
 * the DIAL plane, whereas this set is per-MUXER and belongs to the SERVE plane.
 * That difference in scope between the two planes is a prime suspect for the
 * refusals this field exists to diagnose, so reusing the name across them would
 * blur exactly the distinction a reader needs.
 *
 * Those two demand different fixes and were indistinguishable from the old log
 * line, which is what made the live rig<->tower papercusp standoff
 * undiagnosable from logs. Pure (no WeakMap reads, no I/O) so the content is
 * directly assertable — `potGitLog` is a no-op under vitest, so a test cannot
 * observe the emitted line itself.
 *
 * @param serveTopicHexes the muxer's SERVE-registered topics, or `null` if they
 *   could not be read — rendered distinctly from a readable-but-empty set.
 */
function formatRefusalTarget(
  reason: string,
  topicHex: string,
  serveTopicHexes: string[] | null,
): string {
  const short = (h: string): string => h.slice(0, 16);
  let tail = ` topic=${topicHex ? short(topicHex) : '<unknown>'}`;
  if (reason === 'not-serving') {
    const served =
      serveTopicHexes === null
        ? '<unreadable>'
        : serveTopicHexes.length > 0
          ? serveTopicHexes.map(short).join(',')
          : '<none>';
    tail += ` serveTopics=${served}`;
  }
  return tail;
}

// ─── EI-18802033487678337: progress-aware serve supersession ────────────
//
// `serveUploadPack` now stands down the moment its requester's duplex dies
// (fetch-transport.ts). Capacity pressure is handled by the shared adaptive
// governor at that process boundary; this transport-side state is retained
// only to supersede an abandoned same-channel request while protecting a
// transfer that is actively moving bytes.

/** WI-6412: the streaming-progress view the admission rule reads. Deliberately
 *  the narrowest shape that answers "is this serve moving bytes right now?", so
 *  a live `FrameDuplex` satisfies it structurally (no second counter to drift
 *  from the real one) while a test can construct it as a plain object. */
export interface ServeProgress {
  /** Total bytes written toward the requester so far.
   *
   *  ⚠ NOT a liveness signal ON ITS OWN — see `bytesIn`. Under protocol v2 the
   *  server writes a fixed capability advertisement before it has read anything,
   *  so this is nonzero for every serve that merely got as far as saying hello. */
  readonly bytesOut: number;
  /** Total bytes received FROM the requester so far — i.e. whether the peer ever
   *  actually asked for anything.
   *
   *  This is the half that makes rule 0's "is it streaming?" question answerable.
   *  `upload-pack` cannot emit a single byte of pack data before receiving the
   *  client's `command=fetch` + want lines, so any genuinely-streaming serve has
   *  this nonzero; a serve wedged at the greeting has it at exactly 0. */
  readonly bytesIn: number;
  /** Wall-clock of the last outbound write; `0` before the first byte. */
  readonly lastWriteAt: number;
}

/** A serve this process is running right now, and the lever to stand it down. */
export interface InFlightServe {
  /** Identity of the requesting channel — one per (muxer, topic), i.e. per
   *  peer connection per pot. Compared by reference. */
  readonly channel: object;
  /** Resolved on-disk repo path — the resource identity used to scope
   *  same-channel supersession. Two wire repoKeys that resolve to one path
   *  share the same supersession domain. */
  readonly repoPath: string;
  readonly repoKey: string;
  readonly sessionId: number;
  readonly startedAt: number;
  /** WI-6412: live progress for this serve. Read by rule 0 below so a serve
   *  that is actively streaming is never discarded for a re-request. */
  readonly progress: ServeProgress;
}

export interface ServeAdmission {
  readonly admit: boolean;
  /** Set iff `admit` is false — the wire reason to refuse with. */
  readonly refuseReason?: string;
  /** In-flight serves this request SUPERSEDES; abort them whether or not this
   *  one is admitted (they are abandoned either way). */
  readonly supersede: readonly InFlightServe[];
}

/** WI-6412: how recently a serve must have written for rule 0 to call it "still
 *  streaming".
 *
 *  Sized by the ASYMMETRY of being wrong, because the two errors are not
 *  comparable:
 *
 *   - TOO SHORT is unbounded. `lastWriteAt` stamps when a chunk was handed to
 *     this duplex, so a peer that stops draining — a slow link, a long
 *     backpressure stall — looks identical to one that vanished. Call a live
 *     transfer stale and we discard it, and the livelock simply returns for
 *     slow peers, who are exactly the peers a 4GB transfer is hardest for.
 *   - TOO LONG is bounded and self-correcting. An abandoned serve remains
 *     visible for at most one extra re-request cycle: the next request is
 *     refused `busy-streaming`, and the one after that (past the window)
 *     supersedes it normally.
 *
 *  So this is deliberately generous rather than tight: comfortably longer than
 *  any plausible drain stall, while still far under the requester's own 120s
 *  idle ceiling (DEFAULT_FETCH_TIMEOUT_MS), which is the point past which the
 *  requester has itself given up and the serve is moot either way. */
export const DEFAULT_SERVE_PROGRESS_WINDOW_MS = 30_000;

/**
 * Decide whether to admit an inbound serve — the whole concurrency rule, as a
 * pure function so it is directly assertable (the surrounding path needs a live
 * Protomux, a spawned `upload-pack`, and a real repo on disk).
 *
 * THREE rules, in order:
 *
 *  0. PROTECT-IN-PROGRESS (WI-6412). If any in-flight serve of R on C is still
 *     actively streaming — the requester has actually sent a request AND bytes
 *     have moved within `progressWindowMs` — refuse the new request
 *     `busy-streaming` and supersede NOTHING.
 *
 *     Both halves are load-bearing. Outbound bytes alone do not mean the serve
 *     is doing anything: protocol v2 opens with a fixed 147B capability
 *     advertisement written before the server reads any input, so a serve that
 *     greeted the peer and then hung forever looked exactly like one streaming a
 *     4GB pack, and protected itself accordingly (WI-6189). See the predicate.
 *
 *     This exists because rule 1's premise below is FALSE against a requester
 *     that re-drives on a timer, and was observed live: one peer re-requested
 *     the same repo every ~15s, superseding our own `upload-pack` nine
 *     consecutive times after it had streamed 145MB → 790MB. ~2.4GB of real
 *     pack data was served and discarded in two minutes at zero progress, and a
 *     ~4.1GB repo could not converge at any link speed, because no attempt was
 *     ever allowed to outlive the re-request period. Note the shape of the
 *     defect: supersession had no notion of PROGRESS, so it discarded a serve
 *     that had streamed 790MB exactly as readily as one that had streamed
 *     nothing — making it maximally destructive precisely when the transfer is
 *     large, which is the case that matters.
 *
 *     Refusing (rather than admitting alongside) is deliberate: the peer already
 *     has a live stream it can simply keep reading, so admitting would run a
 *     SECOND `pack-objects` over the same multi-GB repo — the very cost rule 2
 *     exists to bound.
 *
 *  1. SUPERSEDE. A new request for repo R on channel C means every in-flight
 *     serve of R on C is abandoned — now only reached once rule 0 has
 *     established that none of them is still moving bytes. The original
 *     reasoning was: a pot-git requester drives at most one fetch of a given
 *     repo per channel at a time (the shallow-deepen ladder's rungs are
 *     strictly sequential — see fetch-transport's ladder), so a second live
 *     request for the same repo on the same channel proves the first will never
 *     be read again. Treat that as a heuristic, NOT a proof: it holds for the
 *     ladder, but nothing stops another leg (e.g. ref-announce re-driving on
 *     its own ~15s ceiling) from issuing a second request for a repo whose bulk
 *     transfer is still in flight. Rule 0 is what makes being wrong here cheap.
 *     Superseding still converts "the peer gave up 3 minutes ago" from
 *     something we can only learn by timing out into something we learn
 *     immediately — that case is unaffected, because an abandoned serve is
 *     exactly one whose bytes have stopped.
 *
 * There is intentionally no local concurrency cap. Capacity pressure is
 * admitted and queued by the shared adaptive governor at the `upload-pack`
 * process boundary; this function owns only the progress-aware supersession
 * policy that protects an actively streaming same-channel transfer.
 */
export function resolveServeAdmission(args: {
  repoPath: string;
  channel: object;
  /** Every serve in flight in this process, including ones for other repos. */
  inFlight: readonly InFlightServe[];
  now?: number;
  progressWindowMs?: number;
}): ServeAdmission {
  const now = args.now ?? Date.now();
  const windowMs = args.progressWindowMs ?? DEFAULT_SERVE_PROGRESS_WINDOW_MS;
  const sameRepo = args.inFlight.filter((s) => s.repoPath === args.repoPath);
  const sameChannel = sameRepo.filter((s) => s.channel === args.channel);
  // Rule 0. Keyed on bytes ACTUALLY MOVED, not merely on a fresh timestamp: a
  // serve admitted moments ago that has produced nothing is the abandoned
  // orphan rule 1 exists to reap, and must not be protected just for being
  // young.
  //
  // ⚠ `bytesOut > 0` ALONE CANNOT ANSWER THIS, and believing it did is what let
  // a wedged serve protect itself (WI-6189). Under protocol v2 `upload-pack`
  // writes its capability advertisement UNCONDITIONALLY, before it has read a
  // single byte of input — measured on this box at exactly 147B, identical for a
  // 120K repo and a 4.9M one because it carries no repo content at all:
  //
  //     000eversion 2 / 0015agent=git/2.43.0 / 0013ls-refs=unborn /
  //     0020fetch=shallow wait-for-done / 0012server-option /
  //     0017object-format=sha1 / 0010object-info / 0000
  //
  // So EVERY serve that got as far as spawning satisfies `bytesOut > 0` within
  // milliseconds, including one that then hangs forever because the requester
  // never sent its `command=fetch`. The predicate could not distinguish
  // "streaming a 4GB pack" from "said hello and stopped" — and the latter was
  // then held as `busy-streaming`, refusing the very requests that might have
  // succeeded. Live on the tower 2026-08-02: across six hours EVERY serve to
  // peers nWXvaGiA/Lm1ABoMR died at 0B or exactly 147B, not one ever reaching
  // its first pack byte, with 10 requests refused `busy-streaming` in one 30s
  // window behind a serve stuck at the greeting.
  //
  // `bytesIn > 0` is the half that makes the question answerable, and it is
  // exact rather than a heuristic threshold: the server cannot produce any pack
  // data before receiving the client's `command=fetch` + want lines, so a
  // genuinely-streaming serve ALWAYS has it (no healthy serve is demoted), while
  // a serve wedged at the greeting has it at exactly 0. Prefer it to comparing
  // `bytesOut` against 147 — that number is a function of the git version
  // (`agent=git/2.43.0` is inside it) and would rot silently on an upgrade.
  //
  // This NARROWS rule 0; it does not widen it. The WI-6412 livelock it was built
  // for streamed 145MB-790MB, which necessarily had `bytesIn > 0`, so it stays
  // protected. (Unchanged residual, still worth its own fix: a serve that HAS
  // received its request and is enumerating objects writes nothing further, so
  // once `lastWriteAt` ages past the window it remains supersedable.)
  const streaming = sameChannel.filter(
    (s) =>
      s.progress.bytesIn > 0 &&
      s.progress.bytesOut > 0 &&
      now - s.progress.lastWriteAt <= windowMs,
  );
  if (streaming.length > 0) {
    return { admit: false, refuseReason: 'busy-streaming', supersede: [] };
  }
  const supersede = sameChannel;
  return { admit: true, supersede };
}

/** Live serves, process-wide. A `Set` (not a per-channel map) because
 *  supersession is evaluated across every connection while still matching the
 *  requesting channel. Entries are removed in `handleReq`'s `finally`, so an
 *  entry outliving its serve would require the transport promise never
 *  settling — which its ceilings make impossible. */
const inFlightServes = new Set<InFlightServe>();
/** Abort levers for the entries above, keyed by entry identity. */
const serveAborters = new WeakMap<InFlightServe, AbortController>();

/** Stand down an in-flight serve. Best-effort by construction: the entry may
 *  have retired between the admission decision and this call. */
function standDownServe(entry: InFlightServe, why: string): void {
  const controller = serveAborters.get(entry);
  if (!controller || controller.signal.aborted) return;
  try {
    controller.abort(why);
  } catch {
    /* best-effort */
  }
}

/** Test seam: the live in-flight count for a repo path (0 when idle). */
export function inFlightServeCountForTest(repoPath: string): number {
  let n = 0;
  for (const s of inFlightServes) if (s.repoPath === repoPath) n += 1;
  return n;
}

function handleReq(state: ChannelState, v: ReqFrame): void {
  const startedAt = Date.now();
  const refuse = (reason: string): void => {
    try {
      state.messages?.refuse.send({ id: v.id, reason });
    } catch {
      /* best-effort */
    }
    // The topic is part of the dedup key, not just the message: two refusals
    // that differ ONLY by the topic they arrived on are the single most
    // diagnostic pair this log can emit, so they must never collapse into one
    // another as "identical".
    const { log, suppressed } = shouldLogRefusal(
      `${reason}\x00${v.repoKey}\x00${peerTag(state)}\x00${state.topicHex}`,
      Date.now(),
    );
    if (log) {
      // Read the muxer's serve registrations only for the reason that depends
      // on them. `null` => unreadable, which the formatter renders distinctly
      // from "readable and empty" (a very different diagnosis).
      let serveTopicHexes: string[] | null = [];
      if (reason === 'not-serving') {
        try {
          const m = state.mux ? serveConfigByMuxer.get(state.mux) : undefined;
          serveTopicHexes = m ? [...m.keys()] : [];
        } catch {
          serveTopicHexes = null;
        }
      }
      potGitLog(
        'warn',
        `[pot-git] serve REFUSED reason=${reason} repo=${v.repoKey} peer=${peerTag(state)}` +
          `${formatRefusalTarget(reason, state.topicHex, serveTopicHexes)} id=${v.id}` +
          (suppressed > 0 ? ` (+${suppressed} identical suppressed in the last ${REFUSE_LOG_WINDOW_MS / 1000}s)` : ''),
      );
    }
  };
  void (async () => {
    const cfg = state.serverConfig;
    if (!cfg) return refuse('not-serving');
    // WI-6815: refuse with the reason that names WHICH of the four mode states we
    // are refusing on, not a blanket `mode-legacy`. Only an explicitly-SET legacy
    // is an owner decision; `absent`/`malformed`/`error` mean we could not
    // establish the mode at all, and rendering those as "this hive chose legacy"
    // is what made a peer's misconfiguration undiagnosable without peer-side DB
    // access. The reason string travels back over the wire (handleRefuse), so the
    // DIALER's log now separates "never replicated here" (mode-unset) from "my
    // read is throwing" (mode-unreadable) with no access to the peer at all.
    let read: PotGitModeRead;
    try {
      read = await readPotGitMode(cfg.workspaceId, cfg.potHomeSlug);
    } catch {
      // readPotGitMode is documented never to throw; belt-and-braces so a future
      // regression there degrades to a NAMED refusal rather than an unhandled
      // rejection that presents to the dialer as a timeout.
      read = { mode: 'legacy', source: 'error' };
    }
    if (read.mode === 'legacy') return refuse(POT_GIT_MODE_REFUSAL[read.source]);
    // WI-3641: a `scope:`-prefixed wire repoKey (scopeRepoWireKey) addresses a
    // `scopes/` family repo — hiveGitRepoPath's single-path-component join can
    // never itself PRODUCE a `scopes/<owner>/<slug>.git` path (that's 2
    // components below potHomeSlug), so scope-family requests are resolved via
    // scopeRepoPath directly instead. A malformed scope segment refuses
    // (fail-closed) rather than falling through to the plain-repo path.
    let repoPath: string;
    const wireScopeId = parseScopeRepoWireKey(v.repoKey);
    if (wireScopeId) {
      repoPath = scopeRepoPath(cfg.potHomeSlug, wireScopeId);
    } else {
      try {
        repoPath = hiveGitRepoPath(cfg.potHomeSlug, v.repoKey);
      } catch {
        return refuse('bad-repo-key');
      }
    }
    // WI-3641: the grant `fetch-transport.ts`'s `assertScopeServeAuthorized`
    // backstop DEMANDS for any scopes/-family repoPath — computed here (never
    // skippable: every branch below fails closed) and threaded into
    // `serveUploadPack`'s `scopeServeGrant` option below. Without passing it
    // through, the backstop throws for EVERY scope-repo serve regardless of
    // this gate's decision (a real gap: the gate ran but its answer never
    // reached the enforcement point) — undefined here only for a non-scope
    // repoPath, where the backstop is a no-op anyway.
    let scopeServeGrant: ScopeRepoServeGrant | undefined;
    if (isScopeRepoFamilyPath(repoPath)) {
      // WI-3641: authorize via the roster serve-gate, keyed by the caller's
      // SIGNATURE-VERIFIED device identity (never the wire `req` frame's
      // self-reported `peerGithubUserId` — see module header). Every branch
      // below fails closed: no resolver, no verified device, an unresolvable
      // member, or a roster refusal all refuse rather than serve.
      const devicePubkey = cfg.resolvePeerDevicePubkey?.(state.socket);
      if (!devicePubkey) return refuse('scope-repo-no-verified-peer');
      let githubUserId: number | null;
      try {
        githubUserId = await resolveGithubUserIdForDevicePubkey(
          cfg.workspaceId,
          cfg.potHomeSlug,
          devicePubkey,
        );
      } catch {
        return refuse('scope-repo-member-lookup-error');
      }
      if (githubUserId == null) return refuse('scope-repo-unknown-device');
      const roster = getScopeRoster({ workspaceId: cfg.workspaceId, potSlug: cfg.potHomeSlug });
      const decision = await authorizeScopeRepoServe({
        repoPath,
        peerGithubUserId: githubUserId,
        isScopeMember: roster.predicate,
      });
      if (!decision.ok) return refuse(`scope-repo:${decision.refusal.reason}`);
      scopeServeGrant = decision.grant;
    }
    // WI-6364 (fix C): REFUSE A SUPERSEDED STORE rather than serve week-old
    // bytes out of it. Checked BEFORE the existence gate below deliberately —
    // both outcomes are correct for an abandoned key, but this one CARRIES THE
    // REPAIR (the canonical key), so it is strictly the more useful of the two
    // and must not be pre-empted by a bare `no-such-repo` on a device that
    // never held the old store at all. Non-scope keys only: a `scopes/` repo is
    // addressed by scope id, not by the registry's repoKey ladder.
    if (!wireScopeId) {
      const superseded = await resolveSupersededRepoKey(cfg.potHomeSlug, v.repoKey);
      if (superseded) {
        return refuse(supersededRepoKeyRefusal(superseded.canonical));
      }
    }
    // EI-8863/WI-3643 finding (su-95401d6d's handoff): an unknown-but-validly
    // NAMED repoKey (no traversal, no unsafe chars — so hiveGitRepoPath above
    // never throws) resolves to a path that simply doesn't exist on disk.
    // Without this check, `serveUploadPack` below spawns a REAL `git
    // upload-pack --strict <nonexistent path>` — which does not fail fast:
    // it stalls in the protocol handshake instead of erroring immediately,
    // so the requester never gets a refuse (or any bytes at all) and just
    // sits until ITS OWN ceiling timer fires (serve-wiring.integration.test.ts's
    // "refuses an unknown repoKey" case: ~15s wall time, vs <100ms for every
    // other refusal path). Check existence up front and refuse loudly —
    // matches the fail-fast contract every other refusal reason already gets.
    if (!(await pathExists(join(repoPath, 'HEAD')))) {
      return refuse('no-such-repo');
    }
    // EI-18802033487678337: apply the progress-aware supersession policy
    // before starting this serve. Capacity itself is admitted by the shared
    // adaptive governor below, so there is no local repo cap or `busy` branch.
    const admission = resolveServeAdmission({
      repoPath,
      channel: state,
      inFlight: [...inFlightServes],
    });
    for (const superseded of admission.supersede) {
      potGitLog(
        'warn',
        `[pot-git] serve SUPERSEDED repo=${superseded.repoKey} peer=${peerTag(state)}` +
          ` id=${superseded.sessionId} after ${Date.now() - superseded.startedAt}ms` +
          // WI-6412: discarded bytes as a first-class field ON THE DECISION
          // LINE. The count was not entirely absent before — it could be
          // recovered from the losing serve's stderr on a LATER "serve FAILED"
          // line ("upload-pack aborted: superseded ... (served 789537440B)").
          // But it sat inside a stderr string on the line that reports a
          // FAILURE, not on the line where we CHOSE to discard, so ~2.4GB of
          // destroyed work in two minutes read as ordinary failure noise. A
          // nonzero value here says supersession destroyed real work, at the
          // moment it decided to.
          ` discardedBytes=${superseded.progress.bytesOut}` +
          ` (same channel re-requested the same repo as id=${v.id}; the earlier fetch is abandoned)`,
      );
      standDownServe(superseded, `superseded by a newer request (id=${v.id}) for the same repo`);
    }
    if (!admission.admit) {
      return refuse(admission.refuseReason ?? 'busy-streaming');
    }
    const duplex = new FrameDuplex(
      (chunk) => state.messages?.dataToClient.send({ id: v.id, chunk }),
      (code) => {
        try {
          state.messages?.endToClient.send({ id: v.id, code });
        } catch {
          /* best-effort */
        }
      },
      (resume) => state.drainWaiters.push(resume),
    );
    state.serverSessions.set(v.id, duplex);
    noteSessionHighWater(state);
    const entry: InFlightServe = {
      channel: state,
      repoPath,
      repoKey: v.repoKey,
      sessionId: v.id,
      startedAt,
      // The duplex IS the progress view (it already counts every byte in BOTH
      // directions), so there is no second counter that could disagree with the
      // real one — `bytesIn` in particular comes straight from `pushChunk`.
      progress: duplex,
    };
    const aborter = new AbortController();
    serveAborters.set(entry, aborter);
    inFlightServes.add(entry);
    try {
      const governedExecution: GovernedServeExecution = (run) =>
        runGovernedOperation<TransportResult>(
          {
            workspaceId: cfg.workspaceId,
            namespace: 'pot-git-serve',
            owner: `pot-git-serve:${cfg.potHomeSlug}`,
            admissionClass: 'transfer',
            demand: { cpuWeight: 1, networkBytes: 1 },
            payloadRef: `${cfg.potHomeSlug}/${v.repoKey}`,
            metadata: {
              protocol: POT_GIT_PROTOCOL,
              direction: 'serve',
              repoKey: v.repoKey,
              topic: state.topicHex,
              sessionId: v.id,
            },
            measureActualDemand: () => ({
              cpuWeight: 1,
              networkBytes: duplex.bytesIn + duplex.bytesOut,
            }),
            settle: (result) =>
              result.code === 0 && !result.timedOut
                ? {
                    kind: 'release',
                    actualDemand: {
                      cpuWeight: 1,
                      networkBytes: duplex.bytesIn + duplex.bytesOut,
                    },
                  }
                : {
                    kind: 'cancel',
                    reason: result.timedOut
                      ? 'pot-git upload-pack timed out'
                      : `pot-git upload-pack exited ${result.code}`,
                  },
          },
          async () => run(),
        );
      const res = await serveUploadPack(repoPath, duplex, {
        timeoutMs: cfg.timeoutMs,
        scopeServeGrant,
        signal: aborter.signal,
        governedExecution,
        // EI-18776567787336109 (secondary defect): put the REASON on the wire.
        // This fires before the duplex ends, which is the only window in which
        // it can land — the requester deletes its session on the end frame, so
        // `handleRefuse` would otherwise be a no-op. Reuses the existing
        // `refuse` frame, so this is a zero-wire-change fix: peers running the
        // older build already decode and surface it.
        onFailure: (reason) => {
          try {
            state.messages?.refuse.send({ id: v.id, reason });
          } catch {
            /* best-effort — the channel may already be gone */
          }
        },
      });
      // WI-6184: the one line that says a real fetch was served, and how it
      // ended. `code === 0` is the success signal; timedOut distinguishes "the
      // requester went away / upload-pack wedged" from a clean nonzero exit.
      const ms = Date.now() - startedAt;
      const detail =
        `repo=${v.repoKey} peer=${peerTag(state)} id=${v.id} code=${res.code}` +
        `${res.timedOut ? ' timedOut=true' : ''} ${ms}ms`;
      if (res.code === 0) potGitLog('info', `[pot-git] serve OK ${detail}`);
      else potGitLog('warn', `[pot-git] serve FAILED ${detail} stderr=${res.stderr.trim().slice(0, 300)}`);
    } finally {
      inFlightServes.delete(entry);
      serveAborters.delete(entry);
      state.serverSessions.delete(v.id);
    }
  })().catch((e) => {
    // A bad/hostile request must never crash the shared channel — but it must
    // never SILENTLY STARVE the requester either. This catch used to swallow
    // the error with no frame sent, so any throw above (a wedged `pathExists`,
    // an unexpected `serveUploadPack` failure) left the peer with no refuse and
    // no end: it then hung its FULL 120s fetch ceiling and reported a bare
    // ":failed" with no reason — indistinguishable from a dead transport, and
    // exactly the signature seen on the 2-machine rig. Tell the requester so it
    // fails fast (its `duplex.on('error')` resolves immediately), and say so
    // here so the failing side is diagnosable on THIS machine.
    try {
      state.messages?.refuse.send({ id: v.id, reason: 'serve-error' });
    } catch {
      /* best-effort — the channel may already be gone */
    }
    potGitLog(
      'warn',
      `[pot-git] serve ERROR repo=${v.repoKey} peer=${peerTag(state)} id=${v.id}` +
        ` after ${Date.now() - startedAt}ms: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
  });
}

function handleRefuse(state: ChannelState, v: RefuseFrame): void {
  const d = state.clientSessions.get(v.id);
  if (!d) return;
  state.clientSessions.delete(v.id);
  d.destroy(new Error(`pot-git serve refused: ${v.reason}`));
}
function handleDataToServer(state: ChannelState, v: DataFrame): void {
  state.serverSessions.get(v.id)?.pushChunk(v.chunk);
}
function handleDataToClient(state: ChannelState, v: DataFrame): void {
  state.clientSessions.get(v.id)?.pushChunk(v.chunk);
}
function handleEndToServer(state: ChannelState, v: EndFrame): void {
  state.serverSessions.get(v.id)?.pushEnd();
}
function handleEndToClient(state: ChannelState, v: EndFrame): void {
  const d = state.clientSessions.get(v.id);
  if (!d) return;
  d.pushEnd();
  state.clientSessions.delete(v.id);
}

/** Get-or-create the channel + its six message slots for (mux, topic).
 *  Idempotent per muxer (both `wireHiveGitServe` and `openHiveGitFetchDuplex`
 *  share the SAME channel via this). */
function ensureChannel(mux: Protomux, topic: Buffer): ChannelState {
  const states = statesFor(mux as unknown as object);
  const topicHex = topic.toString('hex');
  let state = states.get(topicHex);
  if (state) return state;
  state = newState(topicHex, mux as unknown as object);
  states.set(topicHex, state);
  // Seed from the muxer-level serve config (see serveConfigByMuxer): a channel
  // re-created after the onclose eviction below — or materialized by the lazy
  // `pair()` notifier before `wireHiveGitServe`'s register() ran — must still
  // serve; `wireHiveGitServe` runs once per connection and never back-fills.
  // EI-18802104888674071: when this muxer never had `wireHiveGitServe` run for
  // THIS topic — usually because a DIFFERENT pot's swarm handled the shared
  // connection — fall back to the process-wide registration for the same
  // topicHex. See `serveConfigByTopic` / `resolveServeRegistration`.
  const adopted = resolveServeRegistration(
    serveConfigByMuxer.get(mux as unknown as object)?.get(topicHex),
    serveConfigByTopic.get(topicHex),
    socketByMuxer.get(mux as unknown as object),
  );
  if (adopted) {
    state.serverConfig = adopted.serverConfig;
    state.socket = adopted.socket;
  }
  const channel = mux.createChannel({
    protocol: POT_GIT_PROTOCOL,
    id: topic,
    onopen: () => {
      markOpened(state!);
    },
    // The wire can accept more — release every write parked by _write.
    ondrain: () => {
      flushDrainWaiters(state!);
    },
    onclose: () => {
      failAllSessions(state!);
      // A parked write must not outlive the channel, or the pipe feeding it
      // never unwinds.
      flushDrainWaiters(state!);
      // WI-3496/WI-5177 drill: same dead-channel-cache class as
      // peer-dial-registry.ts — a closed channel cached forever poisons this
      // (muxer, topic): our next openHiveGitFetchDuplex resolves to a dead
      // channel whose `waitOpened` NEVER resolves (the 120s-ceiling hang), and
      // the remote's re-open is protomux-REJECTED via the pair() notifier
      // resolving to the dead state. Flush waiters (callers re-check
      // `state.opened`) and evict so the next use re-creates a live channel.
      const waiters = state!.openedWaiters.splice(0);
      for (const w of waiters) w();
      if (states.get(topicHex) === state) states.delete(topicHex);
    },
  });
  if (!channel) {
    // Defensive: a (protocol,id) collision on this muxer from outside this
    // module (shouldn't happen — POT_GIT_PROTOCOL is private to it). Leave
    // `channel`/`messages` null so callers fail soft instead of throwing.
    return state;
  }
  state.channel = channel;
  state.messages = {
    req: channel.addMessage<ReqFrame>({ encoding: reqEncoding, onmessage: (v) => handleReq(state!, v) }),
    refuse: channel.addMessage<RefuseFrame>({ encoding: refuseEncoding, onmessage: (v) => handleRefuse(state!, v) }),
    dataToServer: channel.addMessage<DataFrame>({ encoding: dataEncoding, onmessage: (v) => handleDataToServer(state!, v) }),
    dataToClient: channel.addMessage<DataFrame>({ encoding: dataEncoding, onmessage: (v) => handleDataToClient(state!, v) }),
    endToServer: channel.addMessage<EndFrame>({ encoding: endEncoding, onmessage: (v) => handleEndToServer(state!, v) }),
    endToClient: channel.addMessage<EndFrame>({ encoding: endEncoding, onmessage: (v) => handleEndToClient(state!, v) }),
  };
  channel.open();
  return state;
}

/** Resolve the shared Protomux for a connection socket — corestore attaches it
 *  at `socket.noiseStream`, not always the outer Hyperswarm socket (mirrors
 *  `openAnnounceChannel`'s identical resolution in swarm.ts). */
function resolveMuxStream(socket: unknown, topic: Buffer): { mux: Protomux; opened?: Promise<unknown> } {
  const muxStream = ((socket as { noiseStream?: unknown } | null)?.noiseStream ?? socket) as {
    opened?: Promise<unknown>;
    userData?: unknown;
  };
  const mux = Protomux.from(muxStream as never);
  // WI-3583 finding (peer-dial-registry.ts, su-7b21d): `Protomux.from()`'s own
  // instance-caching only activates when `stream.userData` was already
  // strictly `null` before the FIRST call on that stream (its constructor:
  // `if (stream.userData === null) stream.userData = this`) — a bare
  // socket's `userData` starts `undefined`, so that guard silently never
  // fires. A SECOND independent wiring function calling
  // `Protomux.from(sameSocket)` (e.g. peer-dial-registry.ts's
  // `wireHiveGitDial`, wired onto the SAME connection as `wireHiveGitServe`)
  // would otherwise construct a SEPARATE Protomux instance competing to
  // parse/write the same byte stream — corrupting both channels' framing.
  // Mirrors `openAnnounceChannel`'s identical fixup in swarm.ts — whichever
  // wiring fn runs first on a socket "wins" the cache; everyone else then
  // retrieves the SAME instance via the `stream.userData.isProtomux` fast
  // path inside `Protomux.from`.
  if (!muxStream.userData) muxStream.userData = mux;
  // Close a channel-open race: if the REMOTE's "open" control message arrives
  // before OUR OWN `ensureChannel()`/`createChannel()` call runs (e.g. while a
  // caller is still `await`ing `opened` below), Protomux queues it into that
  // channel-info's `incoming` list and — with no `pair()` registered —
  // asynchronously REJECTS it (see protomux's `_requestSession`) before we
  // ever get a chance to pair. When that happens our own `onopen` never fires
  // and `waitOpened` hangs forever (the client never reaches its `req` send,
  // so the server's `handleReq` never fires either).
  //
  // Register the lazy-accept notifier at PROTOCOL scope (no `id`) — NOT
  // `{ protocol, id: topic }`. Swarm.ts's announce channel already learned
  // this the hard way (see its own `mux.pair` comment): an id-scoped pair()
  // leaves a late remote open for that id unaccepted in practice, so dispatch
  // by the `id` protomux hands the notify callback instead. `ensureChannel` is
  // keyed per-topic and idempotent, so this safely materializes (and thus
  // pairs with) whichever topic the remote just opened.
  if (!potGitPairedMuxers.has(mux)) {
    potGitPairedMuxers.add(mux);
    try {
      mux.pair({ protocol: POT_GIT_PROTOCOL }, (id: Buffer | null) => {
        if (!id) return;
        ensureChannel(mux, id);
      });
    } catch {
      // pair() unsupported on this muxer build — connect-time channels still
      // pair the normal (non-lazy) way when both sides create first.
    }
  }
  return { mux, opened: muxStream.opened };
}

// ─── public API ──────────────────────────────────────────────────────────

/**
 * SERVER side (P-201): register this connection to serve `hiveGitServe`
 * requests for `topic`. Call once per connection alongside
 * `openAnnounceChannel` (same connection handler, same muxer) — a no-op-safe,
 * fire-and-forget, NEVER-throwing registration (mirrors `openAnnounceChannel`'s
 * contract so a wiring bug can't crash the shared swarm handler).
 */
export function wireHiveGitServe(socket: unknown, topic: Buffer, config: PotGitServeConfig): void {
  try {
    const { mux, opened } = resolveMuxStream(socket, topic);
    const register = (): void => {
      try {
        // Persist per-muxer FIRST (survives channel eviction — see
        // serveConfigByMuxer), then mirror onto the live state.
        serveConfigsFor(mux as unknown as object).set(topic.toString('hex'), { serverConfig: config, socket });
        // ...and process-wide, so a channel the remote opens for this topic on
        // a DIFFERENT muxer (one wired by another pot's swarm) can still be
        // served — see `serveConfigByTopic` (EI-18802104888674071).
        serveConfigByTopic.set(topic.toString('hex'), config);
        socketByMuxer.set(mux as unknown as object, socket);
        const state = ensureChannel(mux, topic);
        state.serverConfig = config;
        state.socket = socket;
      } catch {
        /* best-effort */
      }
    };
    if (opened && typeof opened.then === 'function') {
      void opened.then(register, register);
    } else {
      register();
    }
  } catch {
    /* best-effort — pot-git serve is additive, never breaks the swarm connection */
  }
}

/**
 * CLIENT side (consumed by P-202's announce→fetch driver + worktree-bridge's
 * `openDuplex` seam): request a fetch duplex for `repoKey` from the peer on
 * the other end of `socket`'s connection, on `topic`'s pot-git channel.
 * Resolves a Duplex immediately after the request is sent (never rejects —
 * a refusal/drop destroys the returned duplex instead, matching
 * `fetchOverDuplex`'s fail-soft "never throws" contract).
 */
export async function openHiveGitFetchDuplex(
  socket: unknown,
  topic: Buffer,
  req: { repoKey: string; peerGithubUserId?: number },
  opts: { openTimeoutMs?: number } = {},
): Promise<Duplex> {
  const openTimeoutMs = opts.openTimeoutMs ?? POT_GIT_CHANNEL_OPEN_TIMEOUT_MS;
  const { mux, opened } = resolveMuxStream(socket, topic);
  // EI-18752434722211671: BOTH of this function's awaits are now bounded. Each
  // ran strictly BEFORE any duplex existed, so neither was covered by
  // `fetchOverDuplex`'s fetch ceiling — an unbounded await here hung the whole
  // calling leg (and, under DBOS, the whole routine's dedup pin) forever.
  if (opened && typeof opened.then === 'function') {
    if (!(await settledWithin(opened, openTimeoutMs))) {
      return failSoftDuplex(`pot-git: connection handshake did not complete within ${openTimeoutMs}ms — will retry`);
    }
  }
  const state = ensureChannel(mux, topic);
  if (!state.channel || !state.messages) {
    return failSoftDuplex('pot-git: could not open the serve channel');
  }
  if (!(await waitOpened(state, openTimeoutMs))) {
    // The channel neither opened NOR closed within the ceiling — the peer is
    // reachable enough to hold the channel but never accepted it. Fail soft so
    // the leg reports `fetch-failed` and re-dials next tick, exactly as it does
    // for every other transport failure.
    return failSoftDuplex(`pot-git: serve channel did not open within ${openTimeoutMs}ms (peer wedged — will retry)`);
  }
  if (!state.opened) {
    // The channel closed WITHOUT ever opening (remote side not wired yet —
    // protomux rejected our open; WI-3496 drill boot-order race). The onclose
    // handler evicted it, so the NEXT attempt re-creates a live channel; this
    // attempt fails soft instead of hanging to the caller's outer timeout.
    return failSoftDuplex('pot-git: serve channel closed before opening (peer not wired yet — will retry)');
  }
  const messages = state.messages;
  const id = state.nextClientId++;
  const duplex = new FrameDuplex(
    (chunk) => messages.dataToServer.send({ id, chunk }),
    (code) => {
      try {
        messages.endToServer.send({ id, code });
      } catch {
        /* best-effort */
      }
    },
    (resume) => state.drainWaiters.push(resume),
  );
  state.clientSessions.set(id, duplex);
  // EI-18765930091826096: release the session on ANY termination, not only the
  // three REMOTE-driven ones (`handleRefuse`, `handleEndToClient`, channel
  // close). A fetch that gives up LOCALLY — `fetchOverDuplex` hitting its
  // ceiling and SIGKILLing git, a caller destroying the duplex — left its entry
  // in `clientSessions` forever, so every later `dataToClient` frame for that id
  // still resolved to the abandoned duplex and was buffered into it. Since the
  // map is a strong ref on a per-connection object, nothing short of the
  // connection dying ever collected it: the exact reason a degraded peer channel
  // was only ever cleared by a process restart.
  duplex.once('close', () => {
    if (state.clientSessions.get(id) === duplex) state.clientSessions.delete(id);
  });
  noteSessionHighWater(state);
  try {
    messages.req.send({ id, repoKey: req.repoKey, peerGithubUserId: req.peerGithubUserId ?? 0 });
  } catch (e) {
    state.clientSessions.delete(id);
    duplex.destroy(e instanceof Error ? e : new Error(String(e)));
  }
  return duplex;
}

/**
 * Test seam for EI-18765930091826096's session-lifecycle guards. Sessions are
 * per-(muxer, topic) private state with no observable surface, so WITHOUT this
 * the leak fixes above are undefendable: a regression that re-strands abandoned
 * sessions keeps every existing test green — they all assert on the fetch's
 * RESULT, which a leak does not change — and resurfaces only as a peer channel
 * that mysteriously stops serving, hours later, on a real 2-machine rig.
 */
export const _testing = {
  /** Live session counts for the (socket, topic) channel — the leak probe.
   *  `null` when no channel state exists (never dialed, or evicted on close). */
  sessionCounts(socket: unknown, topic: Buffer): { client: number; server: number } | null {
    const muxStream = ((socket as { noiseStream?: unknown } | null)?.noiseStream ?? socket) as object;
    const mux = Protomux.from(muxStream as never);
    const state = statesFor(mux as unknown as object).get(topic.toString('hex'));
    if (!state) return null;
    return { client: state.clientSessions.size, server: state.serverSessions.size };
  },
  /** The framed per-fetch duplex, so `pushChunk`'s fail-closed drop is directly
   *  assertable rather than only reachable through a live two-peer fetch. */
  FrameDuplex,
  /** WI-6364: the serve path's superseded-store lookup — the ENTRY SCOPING and
   *  the fail-open contract, neither of which the pure decision function
   *  (`findSupersededRepoKey`) can cover on its own. */
  resolveSupersededRepoKey,
  /** The leak DETECTOR (`noteSessionHighWater`) and a bare state to drive it.
   *  Exposed because `potGitLog` is a no-op under vitest (the repo runs
   *  `vitest-fail-on-console`), so the warn itself is unobservable in a test —
   *  the high-water bookkeeping is set on the SAME branch as the warn, so
   *  asserting it is asserting that the detector fired. */
  SESSION_LEAK_WARN_AT,
  noteSessionHighWater,
  newChannelState: newState,
  /** The refusal line's (muxer, topic) tail. Exposed because `potGitLog` is a
   *  no-op under vitest, so the emitted line is unobservable in a test — and
   *  this tail is the whole diagnostic payload of a `not-serving` refusal. */
  formatRefusalTarget,
  /** EI-18802104888674071: the process-wide serve registry (mirrors
   *  peer-dial-registry.ts's `_testing.wiredTopics`) and the pure rule that
   *  consults it — the live path needs a Protomux, this does not. */
  serveConfigByTopic,
  resolveServeRegistration,
  /** Clear the PROCESS-WIDE serve state between tests. The per-muxer maps are
   *  WeakMaps keyed by a fresh muxer per test, so they self-isolate — but
   *  `serveConfigByTopic` is a strong Map keyed by topic HEX, and tests reuse
   *  topic hexes. Without this, one test wiring serve for a topic would make a
   *  later test's "unwired muxer refuses not-serving" case silently pass by
   *  serving instead. */
  reset(): void {
    serveConfigByTopic.clear();
  },
};
