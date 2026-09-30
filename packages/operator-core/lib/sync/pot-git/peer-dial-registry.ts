/**
 * pot-git/peer-dial-registry.ts — WI-3583 (p2p-git-live-activation-2026-07-09
 * Phase-3 prerequisite): the missing device-pubkey → live-swarm-socket
 * resolution that P-204's worktree-bridge-tick and P-202's ref-announce
 * receive-tick both documented as a KNOWN LIMITATION — `openHiveGitFetchDuplex`
 * (P-201, serve-wiring.ts) is the CLIENT dial primitive, but nothing maps "the
 * device that signed this staging-advance / ref-announce" to "the live socket
 * I'd dial to fetch from it". This module is that registry.
 *
 * WHY A SEPARATE tiny channel/protocol instead of extending serve-wiring.ts's
 * existing six-slot pot-git fetch channel: `serveUploadPack`'s wire format
 * (P-201, su-164d8's lane, mid-fix at the time this was written) is a stable
 * req/refuse/data/end contract with no notion of peer identity — bolting a
 * HELLO onto it would be a wire-format change to another lane's in-flight
 * file, and every future consumer of THIS registry (any pot-git driver that
 * needs "dial device X") stays decoupled from serve-wiring.ts's own evolution.
 * Instead this mirrors `authority-rpc-swarm-transport.ts`'s OWN precedent
 * exactly: a dedicated HELLO channel addressing peers by `device_pubkey`,
 * riding the SAME shared muxer, additive and independent of any other channel
 * on that muxer (same seam family as `openAnnounceChannel` / `wireHiveGitServe`
 * — never throws, never disturbs the shared connection handler).
 *
 * Protocol: ONE Protomux channel per (muxer, hive topic), protocol
 * `papercusp/pot-git-hello`, ONE message slot (`hello { device_pubkey }`)
 * sent by BOTH sides immediately once the channel opens (symmetric — either
 * peer may later dial the other). On receipt, the (topic, device_pubkey) →
 * socket mapping is recorded; on channel close it is removed, so a dropped
 * connection can never resolve to a stale/dead socket.
 *
 * Consumers (`resolvePotGitPeerSocket` / `openHiveGitDuplexToDevice`) never
 * throw and fail soft to "no live connection to that device yet" — exactly
 * `openHiveGitFetchDuplex`'s own contract — so a caller with no registry hit
 * degrades to its existing documented fallback (local-mirror-only /
 * `fetch-failed`) rather than crashing.
 *
 * Registration entry point: `wireHiveGitDial(socket, topic,
 * selfDevicePubkeyBase64, sign)` — called once per connection alongside
 * `wireHiveGitServe` (swarm.ts's connection handler).
 *
 * WI-3641 hardening: the hello used to carry a BARE, UNSIGNED
 * `{device_pubkey}` claim — any peer able to reach the hive's swarm topic
 * (DHT topics aren't secret) could open this channel and claim ANY
 * device_pubkey, including a genuine member's. Nothing downstream could then
 * trust "this socket is device X" for an authorization decision (exactly the
 * gap WI-3641 found in serve-wiring.ts's scope-repo refusal). The hello now
 * carries a `signature` over a fixed, topic-bound context string, produced
 * with the SAME device Ed25519 keypair bound to the peer's GitHub attestation
 * (`signWithDeviceKey` / the `announceIdentityOverride.sign` test seam boot.ts
 * already uses for the announce channel) — so only the actual private-key
 * holder can produce a hello that verifies, and a signature over `topic`
 * prevents a captured hello being replayed on a different hive's channel. An
 * unverified/forged hello is DROPPED (never registered) rather than trusted.
 */
import { Duplex } from 'node:stream';
import { appendFileSync } from 'node:fs';
import Protomux, { type ProtomuxChannel } from 'protomux';
import c, { type CompactEncoding } from 'compact-encoding';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { verifyEd25519 } from '../../identity/ed25519';
import { openHiveGitFetchDuplex } from './serve-wiring';

/** The fixed, topic-bound context a hello's signature is over — binding the
 *  signature to THIS hive's topic so a captured hello can't be replayed to
 *  claim the same device on a different hive's channel. */
function helloSignContext(topic: Buffer): Buffer {
  return Buffer.concat([Buffer.from('papercusp/pot-git-hello:v1:'), topic]);
}

// TEMP debug trace (WI-3583 diagnosis) — writes to a file, NOT console.error,
// because this repo's vitest setup (vitest-fail-on-console) fails any test
// that calls console.error, which a raw debug log would trip. Gated on its
// OWN env var (HGDIALDEBUG), deliberately DECOUPLED from serve-wiring.ts's
// HGDEBUG (which still drives raw console.error there) — turning this on
// alone must not also trip serve-wiring.ts's console.error tracing and
// self-sabotage the very test being debugged. To be removed once the root
// cause is confirmed & the fix lands.
function dbg(...args: unknown[]): void {
  if (!process.env.HGDIALDEBUG) return;
  try {
    appendFileSync('/tmp/hgdial-trace.log', `${new Date().toISOString()} ${JSON.stringify(args)}\n`);
  } catch {
    /* best-effort */
  }
}

export const POT_GIT_HELLO_PROTOCOL = 'papercusp/pot-git-hello';

// ─── wire frame ────────────────────────────────────────────────────────────

interface HelloFrame {
  device_pubkey: string;
  /** Raw 64-byte Ed25519 signature over `helloSignContext(topic)`, proving
   *  possession of `device_pubkey`'s private key (WI-3641). */
  signature: Buffer;
}

const helloEncoding: CompactEncoding<HelloFrame> = {
  preencode(state, v) {
    c.string.preencode(state, v.device_pubkey);
    c.buffer.preencode(state, v.signature);
  },
  encode(state, v) {
    c.string.encode(state, v.device_pubkey);
    c.buffer.encode(state, v.signature);
  },
  decode(state) {
    const device_pubkey = c.string.decode(state);
    const signature = c.buffer.decode(state);
    return { device_pubkey, signature };
  },
};

// ─── registry: topicHex -> devicePubkeyBase64 -> live socket ──────────────
// Only ever populated from a SIGNATURE-VERIFIED hello (see handleHello) —
// never a bare claim.

const registryByTopic = new Map<string, Map<string, unknown>>();

function registryFor(topicHex: string): Map<string, unknown> {
  let m = registryByTopic.get(topicHex);
  if (!m) {
    m = new Map();
    registryByTopic.set(topicHex, m);
  }
  return m;
}

/** Reverse index: socket -> the VERIFIED remote device_pubkey bound to it (one
 *  per socket — a connection is one peer). Populated/cleared alongside
 *  `registryByTopic`. This is what `resolveVerifiedDevicePubkeyForSocket`
 *  (serve-wiring.ts's WI-3641 consumer) reads: "which device, if any, has
 *  PROVEN it owns this specific live connection". */
const verifiedDeviceBySocket = new WeakMap<object, string>();

/** Is `socket` still the registered dial target for ANY (topic, device)?
 *  `verifiedDeviceBySocket` is keyed per-SOCKET, but a socket is shared by every
 *  topic multiplexed on that connection — so evicting it when ONE topic's channel
 *  closes silently drops the verified-device binding the OTHER topics' live
 *  channels still depend on (serve-wiring.ts's scope-repo authorization gate reads
 *  it). Call this AFTER removing this channel's own registry entry. */
function socketStillRegisteredAnywhere(socket: unknown): boolean {
  for (const m of registryByTopic.values()) {
    for (const s of m.values()) if (s === socket) return true;
  }
  return false;
}

// ─── EI-18740968796318403: surviving a sub-second channel gap ───────────────
// The pot-git hello channel churns constantly (measured on the live rig: 5028
// opens on ONE topic, ~1 every 2.6s), and `onclose` evicts the registry entry.
// `resolvePotGitPeerSocket` is an INSTANTANEOUS point lookup, so a periodic
// sampler like git-sync's bootstrap leg lands in a gap and concludes "no live
// dial path" for a peer that is demonstrably connected — measured duty cycle
// 57.9%, i.e. a ~42% false-miss rate per dial. That cost the cold-join ladder a
// whole 10-minute tick every time it lost the coin flip.
//
// Fix: remember WHEN each (topic, device) was last registered, and let a dial
// briefly WAIT for the channel to come back instead of sampling one instant.
// Bounded on both sides: a device never seen (or not seen recently) misses
// IMMEDIATELY, so a large mostly-offline member set costs nothing — only a peer
// we have positive evidence is live is ever waited on.

/** How recently a (topic, device) must have been registered for a dial to bother
 *  waiting for it to come back. Long enough to cover the observed churn period
 *  by a wide margin; short enough that a genuinely departed peer misses fast. */
const RECENT_SIGHTING_MS = 120_000;

/** Default dial wait. The channel re-opens every ~1-3s under the observed churn,
 *  so a few seconds converts a ~42% false miss into a near-certain hit. */
const DEFAULT_REGISTRATION_WAIT_MS = 4_000;

const lastRegisteredAt = new Map<string, number>();
const registrationWaiters = new Map<string, Array<() => void>>();

function sightingKey(topicHex: string, devicePubkeyBase64: string): string {
  // '|' is safe as a separator: topicHex is hex and devicePubkeyBase64 is base64,
  // so neither side can contain it. (Do NOT use a NUL here — it makes this file
  // read as BINARY to grep/rg and silently hides it from every text search.)
  return `${topicHex}|${devicePubkeyBase64}`;
}

/** Record a (topic, device) registration and wake anyone waiting to dial it. */
function noteRegistered(topicHex: string, devicePubkeyBase64: string): void {
  const k = sightingKey(topicHex, devicePubkeyBase64);
  lastRegisteredAt.set(k, Date.now());
  const waiters = registrationWaiters.get(k);
  if (!waiters) return;
  registrationWaiters.delete(k);
  for (const w of waiters) {
    try {
      w();
    } catch {
      /* best-effort: one bad waiter never blocks the rest */
    }
  }
}

/** Wait (bounded) for a recently-seen (topic, device) to re-register, then
 *  re-resolve. Returns undefined without waiting when we have no recent evidence
 *  the device is live — the fail-soft contract is unchanged, only better-timed. */
async function awaitRegistration(
  topicHex: string,
  devicePubkeyBase64: string,
  waitMs: number,
): Promise<unknown | undefined> {
  if (!(waitMs > 0)) return undefined;
  const k = sightingKey(topicHex, devicePubkeyBase64);
  const seen = lastRegisteredAt.get(k);
  if (seen === undefined || Date.now() - seen > RECENT_SIGHTING_MS) return undefined;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const list = registrationWaiters.get(k) ?? [];
    list.push(finish);
    registrationWaiters.set(k, list);
    const timer = setTimeout(() => {
      const current = registrationWaiters.get(k);
      if (current) {
        const i = current.indexOf(finish);
        if (i >= 0) current.splice(i, 1);
        if (current.length === 0) registrationWaiters.delete(k);
      }
      finish();
    }, waitMs);
    // Never hold the process open for a dial that nobody is waiting on.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return registryByTopic.get(topicHex)?.get(devicePubkeyBase64);
}

// ─── per-(muxer, topic) channel state ──────────────────────────────────────
// Mirrors serve-wiring.ts's `ensureChannel`/`resolveMuxStream` pattern
// EXACTLY (WI-3583 follow-up: su-164d8's P-201/WI-3490 raw-byte trace found
// the root cause of the hello-handshake hang shared by BOTH modules — see
// that file's `resolveMuxStream` comment for the full mechanism). Without
// this, a remote's channel-open control frame arriving before OUR OWN
// `createChannel()` call (e.g. during the `await opened` gap below) gets
// asynchronously REJECTED by protomux with no `pair()` registered, so our
// `onopen` never fires and the hello is never sent/received on that side.

interface ChannelState {
  channel: ProtomuxChannel | null;
  hello: { send(v: HelloFrame): void } | null;
  opened: boolean;
  openedWaiters: Array<() => void>;
  /** Set by `wireHiveGitDial` once known — read by `onopen` (which may fire
   *  before this is set, if the channel was materialized early by the lazy
   *  `pair()` notifier below) to send our own hello as soon as both are true. */
  selfDevicePubkeyBase64: string | null;
  /** Signer for `selfDevicePubkeyBase64`'s private key — set alongside it by
   *  `wireHiveGitDial`. Null until then (channel materialized early by the
   *  lazy `pair()` notifier), matching `selfDevicePubkeyBase64`'s own gate in
   *  `maybeSendHello`. */
  sign: ((bytes: Buffer) => Promise<Buffer> | Buffer) | null;
  /** A hello send has been INITIATED on this channel (not proof it landed —
   *  the peer never acks). Latches the FIRST send; a deliberate re-send passes
   *  `{ resend: true }` past it. See `maybeSendHello`. */
  helloSent: boolean;
  /** WHICH device_pubkey the last initiated hello carried; null when none was
   *  sent yet (or on state built before this field existed — treated as
   *  UNKNOWN, never as a mismatch). P-203 Leg A (2026-09-02): the identity a
   *  hello left under was seeded from the per-MUXER config that every harness
   *  sharing the connection overwrites, so on a box hosting harnesses under
   *  two accounts the papercusp topic greeted as the other account's device;
   *  the peer filed our socket under it and every dial of our announcing
   *  device missed for the connection's life. `helloSent` cannot see that —
   *  the send happened. This records AS WHOM, so an identity correction
   *  (`register()` applying the topic's own identity, or `healSweep`)
   *  re-sends instead of trusting the latch. */
  helloSentAs: string | null;
  /** A hello send is mid-flight (the signature is async). Separate from
   *  `helloSent` because that one must stay latched forever while this must
   *  clear — without the split, a re-send racing the first send could emit two
   *  hellos on one channel (WI-5210). */
  helloInFlight: boolean;
  remoteDevicePubkey: string | null;
  /** The connection socket THIS side registered with (set by
   *  `wireHiveGitDial` — may still be null if the channel was materialized
   *  early by the lazy `pair()` notifier and the direct call hasn't run yet;
   *  a hello received before then is a genuine race and is simply dropped,
   *  the peer's next reconnect/retry re-sends it). Read by the hello
   *  `onmessage` handler to record the REMOTE device against OUR socket. */
  localSocket: unknown;
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

/** Per-MUXER dial identity/config, hoisted OUT of per-topic ChannelState
 *  (WI-3496/WI-5177 live-drill finding): a channel re-created after a close
 *  (see the onclose eviction below) or materialized early by the lazy `pair()`
 *  notifier would otherwise have `selfDevicePubkeyBase64`/`sign`/`localSocket`
 *  all null FOREVER — `wireHiveGitDial` runs once per connection, so nothing
 *  ever back-fills them, the hello is never sent, and a received hello is
 *  dropped for want of a socket. One record per muxer is correct: every topic
 *  on a connection shares the same device identity and the same socket. */
interface MuxerDialConfig {
  selfDevicePubkeyBase64: string;
  sign: (bytes: Buffer) => Promise<Buffer> | Buffer;
  socket: unknown;
  /** Topics `wireHiveGitDial` was EXPLICITLY called for on this muxer — the
   *  only topics we will SIGN a hello for on a pair-materialized channel. A
   *  remote can open a channel with an ARBITRARY id; never produce a signature
   *  over a topic this box did not itself join+wire. */
  topics: Set<string>;
  /** Re-dial attempts per topicHex for never-opened closes (reset on open). */
  retries: Map<string, number>;
}

const dialConfigByMuxer = new WeakMap<object, MuxerDialConfig>();

/** Topic hexes THIS BOX has explicitly wired via `wireHiveGitDial` on ANY
 *  connection (process-global), mapped to their topic bytes. WI-5210 (P-303
 *  Leg B live drill): `MuxerDialConfig.topics` is per-connection, so a channel
 *  pair-materialized on a muxer whose own `wireHiveGitDial(topic)` call never
 *  ran (connection churn — the wire landed on an earlier, since-dead
 *  connection) could RECEIVE the peer's hello but never SIGN/SEND its own:
 *  one fetch direction stayed dead for the life of the connection (hours),
 *  while the other worked. Membership here widens ONLY the topic gate —
 *  "this box deliberately joined+wired that topic somewhere" — the signing
 *  IDENTITY always comes from the muxer's own `MuxerDialConfig` (never a
 *  global), and the gate this must NEVER weaken is signing for a
 *  remote-chosen id nobody here wired. */
const wiredTopics = new Map<string, Buffer>();

/** The identity that EXPLICITLY wired each topic — process-global, keyed by
 *  topicHex, last wire wins per topic. This is the signer a hello on that
 *  topic must carry. `MuxerDialConfig.selfDevicePubkeyBase64` is per
 *  CONNECTION and is overwritten by every harness that wires any topic on it,
 *  so on a box hosting harnesses under more than one account it holds
 *  "whichever harness wired last", which is the wrong device for every other
 *  harness's topic (P-203 Leg A live finding, 2026-09-02: the tower's
 *  papercusp topic sent its hello as the ownerhandle device XPAsvso1 while its
 *  announcements were signed by the papercupai device IXfGu216 — the VM
 *  filed the tower's socket under the wrong key and every VM→tower dial
 *  missed for 210+ minutes). A topic's own wiring identity cannot be confused
 *  by a sibling harness on another topic; the muxer config stays the
 *  fallback only for a topic this box never explicitly wired. */
const wiredTopicIdentity = new Map<
  string,
  { selfDevicePubkeyBase64: string; sign: (bytes: Buffer) => Promise<Buffer> | Buffer }
>();

/** Apply the topic's own wiring identity to `state` when it has one — the
 *  seed every channel materialization and heal pass must prefer. Returns
 *  whether an identity was applied. */
function applyWiredTopicIdentity(state: ChannelState, topicHex: string): boolean {
  const wired = wiredTopicIdentity.get(topicHex);
  if (!wired) return false;
  state.selfDevicePubkeyBase64 = wired.selfDevicePubkeyBase64;
  state.sign = wired.sign;
  return true;
}

/** A hello went out under a device that is no longer this channel's identity
 *  (the muxer-config race above, or a later re-wire under another account).
 *  An unknown `helloSentAs` (legacy state) is NOT stale — only positive
 *  evidence of a mismatch may bypass the first-send latch. */
function helloIdentityStale(state: ChannelState): boolean {
  return (
    state.helloSentAs !== null &&
    state.selfDevicePubkeyBase64 !== null &&
    state.helloSentAs !== state.selfDevicePubkeyBase64
  );
}

/** Muxers with pot-git-hello state worth heal-sweeping (see `healSweep`).
 *  Strong refs are fine: entries are dropped on the first sweep after their
 *  stream destroys, so retention is bounded by live-connection count + 60s. */
const trackedMuxers = new Set<Protomux>();

const HEAL_SWEEP_MS = 60_000;
let healSweepTimer: ManagedHandle | null = null;

function ensureHealSweep(): void {
  if (healSweepTimer) return;
  healSweepTimer = managedSetInterval('pot-git-dial-heal', HEAL_SWEEP_MS, () => healSweep(), {
    category: 'lifecycle',
  });
}

/** WI-5210: the pot-git analogue of the hyperbee plane's repair-on-detect.
 *  Every 60s, for each live tracked muxer: (a) re-dial any EXPLICITLY-wired
 *  topic whose channel state is missing (evicted after a never-opened close
 *  once `maybeScheduleRedial`'s capped fast retries exhausted — this sweep is
 *  the uncapped steady-state tail, so a churn-window rejection heals in ≤60s
 *  instead of never); (b) for any live open channel whose handshake is still
 *  one-sided — ours never sent, OR theirs never received — seed identity from
 *  `wiredTopicConfig` if needed and (re-)send now. Without (b) a one-sided
 *  hello gap leaves one fetch direction dead until a simultaneous pair restart
 *  (the live fence-25 incident this WI documents).
 *
 *  ⚠ (b) originally gated on `!helloSent` alone, which cannot heal the incident
 *  it was written for. A hello has no ack, so `helloSent` means "we called
 *  send()", NOT "the peer has it" — and fence-25 was a hello SENT and lost in
 *  the churn window. Both sides then sat at helloSent=true with the tower
 *  missing the VM's device, and every re-send path skipped them for the life of
 *  the connection. `!remoteDevicePubkey` is the missing half of the condition:
 *  it is the only positive evidence available that our own hello may not have
 *  landed, so it is what re-arms the send. */
function healSweep(): void {
  for (const mux of [...trackedMuxers]) {
    const muxKey = mux as unknown as object;
    const stream = (mux as unknown as { stream?: { destroyed?: boolean } }).stream;
    if (stream?.destroyed) {
      trackedMuxers.delete(mux);
      continue;
    }
    const states = statesFor(muxKey);
    const cfg = dialConfigByMuxer.get(muxKey);
    if (cfg) {
      for (const topicHex of cfg.topics) {
        const topicBuf = wiredTopics.get(topicHex);
        if (!topicBuf) continue;
        if (!states.has(topicHex)) {
          try {
            ensureChannel(mux, topicBuf);
          } catch {
            /* best-effort */
          }
        }
      }
    }
    for (const [topicHex, state] of states) {
      if (!state.opened) continue;
      // Sweep while EITHER half of the handshake is outstanding:
      //   !helloSent            — ours never went out (pair-materialized before
      //                           this box's identity was known);
      //   !remoteDevicePubkey   — theirs never arrived, which is ALSO the only
      //                           signal available that OURS may not have landed
      //                           (there is no ack). WI-5210: the fence-25
      //                           incident had helloSent=true on both sides and
      //                           a hello lost in flight, so the old
      //                           `helloSent`-only gate skipped it forever.
      //   helloSentAs ≠ self    — ours went out under the WRONG device (the
      //                           per-muxer identity race; P-203 Leg A). As
      //                           dead as a lost hello: the peer holds our
      //                           socket under a key no dial will ask for.
      applyWiredTopicIdentity(state, topicHex);
      if (state.helloSent && state.remoteDevicePubkey && !helloIdentityStale(state)) continue;
      if (!state.selfDevicePubkeyBase64 || !state.sign) {
        if (!cfg || !wiredTopics.has(topicHex)) continue;
        state.selfDevicePubkeyBase64 = cfg.selfDevicePubkeyBase64;
        state.sign = cfg.sign;
      }
      // `resend` so a hello already marked sent — but demonstrably not
      // reciprocated — actually goes out again. Bounded: this stops the moment
      // the peer's hello arrives, and runs at the 60s sweep, never hotter.
      maybeSendHello(state, wiredTopics.get(topicHex) ?? Buffer.from(topicHex, 'hex'), {
        resend: true,
      });
    }
  }
  if (trackedMuxers.size === 0 && healSweepTimer) {
    healSweepTimer.stop();
    healSweepTimer = null;
  }
}

/** Muxers on which the lazy-accept `pair()` notifier is already registered —
 *  `pair()` is idempotent to call twice, but this avoids redundant
 *  re-registration on every `resolveMuxStream` call. */
const potGitDialPairedMuxers = new WeakSet<object>();

function newState(): ChannelState {
  return {
    channel: null,
    hello: null,
    opened: false,
    openedWaiters: [],
    selfDevicePubkeyBase64: null,
    sign: null,
    helloSent: false,
    helloSentAs: null,
    helloInFlight: false,
    remoteDevicePubkey: null,
    localSocket: null,
  };
}

/**
 * Send our hello on this channel.
 *
 * `resend: true` sends past the first-send latch — WI-5210. A hello is
 * fire-and-forget with NO ack, so `helloSent` records only that we INITIATED a
 * send; it is not evidence the peer received one. The live fence-25 incident is
 * exactly that gap: the VM's hello was sent and lost in the churn window, so
 * `helloSent` latched true on the VM and every re-send path skipped it forever,
 * leaving the tower unable to resolve the VM's device for the life of the
 * connection (hours). Anything that has POSITIVE evidence our hello did not
 * land must be able to send again.
 *
 * The signature is async, so a re-send can race the first send. `helloInFlight`
 * (not `helloSent`, which must stay latched) is the guard that keeps one
 * channel to one in-flight hello.
 */
function maybeSendHello(state: ChannelState, topic: Buffer, opts?: { resend?: boolean }): void {
  dbg('maybeSendHello', {
    opened: state.opened,
    helloSent: state.helloSent,
    helloInFlight: state.helloInFlight,
    resend: !!opts?.resend,
    hasSelf: !!state.selfDevicePubkeyBase64,
    hasSign: !!state.sign,
    hasHello: !!state.hello,
    self: state.selfDevicePubkeyBase64?.slice(0, 8),
  });
  if (!state.opened || !state.selfDevicePubkeyBase64 || !state.sign || !state.hello) return;
  // One in-flight hello per channel, always — a re-send must never overlap the
  // send it is retrying.
  if (state.helloInFlight) return;
  // The first-send latch. `resend` deliberately bypasses it, and so does a
  // hello that demonstrably went out under a DIFFERENT device than this
  // channel's identity now is (`helloSentAs` ≠ self — the per-muxer identity
  // race; see `wiredTopicIdentity`). Nothing else does.
  if (state.helloSent && !opts?.resend && !helloIdentityStale(state)) return;
  // Mark sent BEFORE the async sign resolves — a second `maybeSendHello` call
  // racing in (onopen firing while register() is still mid-flight, or vice
  // versa) must not send two hellos on the same channel.
  state.helloSent = true;
  state.helloInFlight = true;
  const self = state.selfDevicePubkeyBase64;
  const sign = state.sign;
  state.helloSentAs = self;
  void (async () => {
    try {
      const signature = await sign(helloSignContext(topic));
      state.hello?.send({ device_pubkey: self, signature });
      dbg('hello sent OK', { self: self.slice(0, 8) });
    } catch (e) {
      // Deliberately swallowed, as before — but note `helloSent` stays true on a
      // throw, so this channel is now latched having sent NOTHING. That used to
      // be permanent; `healSweep` re-sends while the peer's hello is missing, so
      // it now self-heals in <=60s instead.
      dbg('hello send THREW', { err: String(e) });
    } finally {
      state.helloInFlight = false;
    }
  })();
}

/** Get-or-create the hello channel + its message slot for (mux, topic).
 *  Idempotent per muxer — a late `pair()`-triggered materialization and a
 *  direct `wireHiveGitDial` call both resolve to the SAME state object. */
function ensureChannel(mux: Protomux, topic: Buffer): ChannelState {
  const states = statesFor(mux as unknown as object);
  const topicHex = topic.toString('hex');
  let state = states.get(topicHex);
  if (state) return state;
  state = newState();
  states.set(topicHex, state);
  // Seed from the muxer-level dial config (see MuxerDialConfig): a channel
  // materialized by the lazy `pair()` notifier — or re-created after the
  // onclose eviction below — must still be able to send its hello (self+sign,
  // only for topics this box explicitly wired) and register a received one
  // (localSocket), even though `wireHiveGitDial` will never run again for
  // this connection.
  const cfg = dialConfigByMuxer.get(mux as unknown as object);
  if (cfg) {
    state.localSocket = cfg.socket;
    // WI-5210: sign+send for a topic this box explicitly wired on THIS muxer
    // — or on ANY earlier connection (`wiredTopics`): connection churn can
    // land the wire on a since-dead muxer, leaving the surviving muxer's
    // pair-materialized channel able to RECEIVE the peer's hello but never
    // answer, so one fetch direction stays dead for the connection's life.
    // The global set only widens the topic gate, never the signer — and the
    // signer is the identity that WIRED THIS TOPIC (`wiredTopicIdentity`),
    // never the muxer's "whoever wired last" config: `onopen` can fire
    // synchronously inside `createChannel()` below when the peer's open is
    // already pending, i.e. BEFORE `wireHiveGitDial`'s `register()` gets to
    // apply the topic's own identity, and that seeded identity is what the
    // latched first hello then carries (P-203 Leg A, 2026-09-02). The muxer
    // config is the fallback only for a topic never explicitly wired here.
    if (!applyWiredTopicIdentity(state, topicHex) && cfg.topics.has(topicHex)) {
      state.selfDevicePubkeyBase64 = cfg.selfDevicePubkeyBase64;
      state.sign = cfg.sign;
    }
  }
  trackedMuxers.add(mux);
  ensureHealSweep();
  dbg('[HGDEBUG-dial] ensureChannel: calling createChannel', { topicHex });
  const channel: ProtomuxChannel | null = mux.createChannel({
    protocol: POT_GIT_HELLO_PROTOCOL,
    id: topic,
    onopen: () => {
      dbg('[HGDEBUG-dial] onopen fired', { topicHex });
      dialConfigByMuxer.get(mux as unknown as object)?.retries.delete(topicHex);
      state!.opened = true;
      const waiters = state!.openedWaiters.splice(0);
      for (const w of waiters) w();
      maybeSendHello(state!, topic);
    },
    onclose: () => {
      dbg('[HGDEBUG-dial] onclose fired', { topicHex, everOpened: state!.opened });
      // COMPARE-AND-DELETE (EI-18740968796318403): under connection churn a NEWER
      // connection to the same device can re-register before this older channel's
      // close fires. An unconditional delete then clobbers that LIVE registration
      // and the device reads as unreachable while a working socket exists. Only
      // ever evict our OWN entry.
      // Evict EVERY device this channel's socket was registered under on this
      // topic — not only the last-remembered remote. A peer that corrected
      // its hello identity mid-connection (the identity-race repair above,
      // run on ITS side) registers twice on one channel; evicting one would
      // leave the other pointing at a dead socket for a future dial to hit.
      if (state!.localSocket) {
        const reg = registryFor(topicHex);
        for (const [device, socket] of reg) {
          if (socket === state!.localSocket) reg.delete(device);
        }
      }
      // The verified-device binding is keyed per-SOCKET, and one socket carries
      // every topic multiplexed on that connection — so only drop it once NO
      // topic still maps a device to this socket. Dropping it here unconditionally
      // silently de-authorized the other topics' still-live channels.
      if (state!.localSocket && typeof state!.localSocket === 'object') {
        if (!socketStillRegisteredAnywhere(state!.localSocket)) {
          verifiedDeviceBySocket.delete(state!.localSocket as object);
        }
      }
      // WI-3496/WI-5177 live-drill root cause: a closed channel cached forever
      // poisons this (muxer, topic) BOTH ways — our own re-wires resolve to a
      // dead channel that can never open, and the remote's re-open hits the
      // `pair()` notifier, whose ensureChannel ALSO resolves to the dead state
      // and creates no protomux channel, so protomux REJECTS the remote's open.
      // Evict so the next dial / pair notification re-creates a live channel.
      if (states.get(topicHex) === state) states.delete(topicHex);
      maybeScheduleRedial(mux, topic, topicHex, state!);
    },
  });
  dbg('[HGDEBUG-dial] createChannel returned', { topicHex, channel: !!channel });
  if (!channel) {
    // Defensive: a (protocol,id) collision on this muxer (shouldn't happen —
    // POT_GIT_HELLO_PROTOCOL is private to this module). Fail soft rather
    // than throw, same contract as serve-wiring.ts's ensureChannel.
    return state;
  }
  state.channel = channel;
  state.hello = channel.addMessage<HelloFrame>({
    encoding: helloEncoding,
    onmessage: (v) => {
      dbg('[HGDEBUG-dial] hello received', { topicHex, from: v.device_pubkey.slice(0, 8), hasLocalSocket: !!state!.localSocket });
      // WI-3641: verify possession of `v.device_pubkey`'s private key BEFORE
      // trusting/registering anything — an unsigned or badly-signed hello is
      // dropped exactly like a not-yet-arrived one (fail soft, never throws;
      // the registry simply stays "not resolvable" for the claimed device).
      if (!verifyEd25519(helloSignContext(topic), v.device_pubkey, v.signature)) {
        dbg('[HGDEBUG-dial] hello signature INVALID — dropping', { topicHex, from: v.device_pubkey.slice(0, 8) });
        return;
      }
      // WI-5210: was this device's hello ALREADY recorded on this channel? If
      // so the peer is RE-sending, and the only reason it does that is
      // `healSweep` finding OUR hello missing on its side. That is the one
      // positive signal we ever get that our own hello did not land — so a
      // repeat, and ONLY a repeat, earns a re-send below.
      const peerIsResending = state!.remoteDevicePubkey === v.device_pubkey;
      state!.remoteDevicePubkey = v.device_pubkey;
      // `localSocket` is normally set by `wireHiveGitDial`'s register() (or
      // seeded from the muxer dial config above). If BOTH are missing — a
      // pair-materialized channel on a muxer `wireHiveGitDial` never ran on —
      // fall back to the muxer's own stream: it IS the connection, and
      // `openHiveGitFetchDuplex`/`resolveMuxStream` resolve it back to the
      // same shared Protomux, so a registry entry built on it dials fine.
      // (WI-3496 drill: the old drop-on-null path silently discarded every
      // verified hello on such channels, leaving the registry empty.)
      if (!state!.localSocket) {
        state!.localSocket =
          dialConfigByMuxer.get(mux as unknown as object)?.socket ??
          (mux as unknown as { stream?: unknown }).stream ??
          null;
      }
      if (state!.localSocket) {
        registryFor(topicHex).set(v.device_pubkey, state!.localSocket);
        if (typeof state!.localSocket === 'object') {
          verifiedDeviceBySocket.set(state!.localSocket as object, v.device_pubkey);
        }
        // Wake any dial parked on this (topic, device) coming back — see
        // awaitRegistration. Must run AFTER the registry write so a woken
        // waiter re-resolves to the live socket, never to the gap it slept in.
        noteRegistered(topicHex, v.device_pubkey);
      } else {
        dbg('[HGDEBUG-dial] verified hello had NO resolvable socket — not registered', { topicHex });
      }
      // WI-5210: a received hello PROVES the channel is open both ways — if
      // ours hasn't gone out yet (materialized before identity was known,
      // any ordering gap), complete the handshake now instead of leaving the
      // peer's registry one-sided. Idempotent via `helloSent`.
      //
      // A REPEAT hello additionally means the peer is still missing ours, so it
      // gets an answer past the latch. This terminates: the peer only repeats
      // while its `remoteDevicePubkey` is null, and our answer is what fills it.
      // Gating on `peerIsResending` is what stops two peers that each answer
      // every hello from ping-ponging at receive speed — a first-time hello is
      // answered under the latch (at most once), and repeats arrive no faster
      // than the 60s sweep.
      maybeSendHello(state!, topic, { resend: peerIsResending });
    },
  });
  channel.open();
  dbg('[HGDEBUG-dial] channel.open() called', { topicHex });
  return state;
}

/** Backoff for re-dialing a channel that closed WITHOUT EVER OPENING — i.e.
 *  the remote protomux-rejected our open because its side of this topic wasn't
 *  wired yet (boot-order race: the WI-3496 drill measured a ~100s skew between
 *  the two machines' swarm wirings). Reconnects are rare (EI-13317), so an
 *  unhealed race is effectively permanent — a short capped retry converts it
 *  into a self-healing blip. A channel that closed AFTER opening is normal
 *  teardown and is never re-dialed (the next connection re-wires it). */
const REDIAL_DELAYS_MS = [5_000, 20_000, 60_000];

function maybeScheduleRedial(mux: Protomux, topic: Buffer, topicHex: string, closed: ChannelState): void {
  if (closed.opened) return;
  const muxKey = mux as unknown as object;
  const cfg = dialConfigByMuxer.get(muxKey);
  if (!cfg || !cfg.topics.has(topicHex)) return;
  const stream = (mux as unknown as { stream?: { destroyed?: boolean } }).stream;
  if (stream?.destroyed) return;
  const attempt = cfg.retries.get(topicHex) ?? 0;
  if (attempt >= REDIAL_DELAYS_MS.length) return;
  cfg.retries.set(topicHex, attempt + 1);
  const t = setTimeout(() => {
    try {
      if (stream?.destroyed) return;
      if (statesFor(muxKey).has(topicHex)) return; // already re-materialized (pair notifier / re-wire)
      dbg('[HGDEBUG-dial] re-dial after never-opened close', { topicHex, attempt: attempt + 1 });
      ensureChannel(mux, topic);
    } catch {
      /* best-effort */
    }
  }, REDIAL_DELAYS_MS[attempt]);
  (t as { unref?: () => void }).unref?.();
}

/** Resolve the shared Protomux for a connection socket — corestore attaches it
 *  at `socket.noiseStream`, not always the outer Hyperswarm socket (mirrors
 *  the identical resolution in swarm.ts / serve-wiring.ts) — AND register the
 *  lazy-accept `pair()` notifier once per muxer, closing the client-open race
 *  described above.
 *
 *  ALSO caches the resolved mux onto `muxStream.userData` (mirrors
 *  `openAnnounceChannel`'s identical fixup in swarm.ts). This is NOT
 *  optional: `Protomux.from()`'s own caching only activates when
 *  `stream.userData` was already strictly `null` before the FIRST call on
 *  that stream (its constructor does `if (stream.userData === null)
 *  stream.userData = this`) — a bare socket's `userData` starts as
 *  `undefined`, not `null`, so that guard silently never fires, and every
 *  independent `Protomux.from(sameSocket)` call (this module's, and
 *  `wireHiveGitServe`'s/`openHiveGitFetchDuplex`'s own, in serve-wiring.ts)
 *  would otherwise construct a SEPARATE Protomux instance competing to
 *  parse/write the SAME underlying byte stream — corrupting BOTH channels'
 *  framing. Whichever wiring function runs first on a socket "wins" the
 *  cache; every later caller (any module) then retrieves the SAME instance
 *  via `Protomux.from`'s own `stream.userData.isProtomux` fast path. */
function resolveMuxStream(socket: unknown): { mux: Protomux; opened?: Promise<unknown> } {
  const muxStream = ((socket as { noiseStream?: unknown } | null)?.noiseStream ?? socket) as {
    opened?: Promise<unknown>;
    userData?: unknown;
  };
  const mux = Protomux.from(muxStream as never);
  if (!muxStream.userData) muxStream.userData = mux;
  if (!potGitDialPairedMuxers.has(mux as unknown as object)) {
    potGitDialPairedMuxers.add(mux as unknown as object);
    try {
      mux.pair({ protocol: POT_GIT_HELLO_PROTOCOL }, (id: Buffer | null) => {
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

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Register this connection on the pot-git dial-hello channel for `topic`:
 * announce OUR device_pubkey to the peer and learn THEIRS. Fire-and-forget,
 * NEVER throws (mirrors `wireHiveGitServe`'s contract) — a wiring bug here
 * must never crash the shared swarm connection handler. Call once per
 * connection, alongside `wireHiveGitServe` / `openAnnounceChannel`.
 */
export function wireHiveGitDial(
  socket: unknown,
  topic: Buffer,
  selfDevicePubkeyBase64: string,
  sign: (bytes: Buffer) => Promise<Buffer> | Buffer,
): void {
  try {
    dbg('[HGDEBUG-dial] wireHiveGitDial called', { self: selfDevicePubkeyBase64.slice(0, 8) });
    const { mux, opened } = resolveMuxStream(socket);
    dbg('[HGDEBUG-dial] resolved mux', { hasOpened: !!opened });
    // Record the muxer-level dial config SYNCHRONOUSLY (before the async
    // register below) so a pair-materialized or re-created channel for this
    // topic can send/register hellos on its own — see MuxerDialConfig.
    const muxKey = mux as unknown as object;
    let cfg = dialConfigByMuxer.get(muxKey);
    if (!cfg) {
      cfg = { selfDevicePubkeyBase64, sign, socket, topics: new Set(), retries: new Map() };
      dialConfigByMuxer.set(muxKey, cfg);
    } else {
      cfg.selfDevicePubkeyBase64 = selfDevicePubkeyBase64;
      cfg.sign = sign;
      cfg.socket = socket;
    }
    const topicHex = topic.toString('hex');
    cfg.topics.add(topicHex);
    // Process-global (survives this connection): any later muxer may sign
    // hellos for this explicitly-wired topic — under THIS topic's identity —
    // and the heal sweep watches the muxer from now on (WI-5210).
    wiredTopics.set(topicHex, topic);
    wiredTopicIdentity.set(topicHex, { selfDevicePubkeyBase64, sign });
    trackedMuxers.add(mux);
    ensureHealSweep();
    const register = (): void => {
      try {
        dbg('[HGDEBUG-dial] register() running');
        const state = ensureChannel(mux, topic);
        state.selfDevicePubkeyBase64 = selfDevicePubkeyBase64;
        state.sign = sign;
        state.localSocket = socket;
        // `onopen` may already have fired (the channel was materialized
        // early by the lazy `pair()` notifier in `resolveMuxStream`, before
        // this register() ran) — send now if so; otherwise `onopen` itself
        // calls `maybeSendHello` once it fires.
        maybeSendHello(state, topic);
        dbg('[HGDEBUG-dial] register() done', { opened: state.opened, helloSent: state.helloSent });
      } catch (e) {
        dbg('[HGDEBUG-dial] register() threw', e);
        /* best-effort */
      }
    };
    if (opened && typeof opened.then === 'function') void opened.then(register, register);
    else register();
  } catch (e) {
    dbg('[HGDEBUG-dial] wireHiveGitDial threw', e);
    /* best-effort — dial registration is additive, never breaks the swarm connection */
  }
}

/** Resolve the live socket for `devicePubkeyBase64` on `topic`'s hive, or
 *  `undefined` when no connection has completed the hello handshake with that
 *  device yet (not connected / connection dropped / hello still in flight —
 *  all indistinguishable from "no live dial path right now"). */
export function resolvePotGitPeerSocket(topic: Buffer, devicePubkeyBase64: string): unknown | undefined {
  return registryByTopic.get(topic.toString('hex'))?.get(devicePubkeyBase64);
}

/**
 * WI-3641: the VERIFIED device_pubkey bound to `socket` (this specific live
 * connection), or `undefined` if no signature-verified hello has been
 * received on it yet (not connected via pot-git-hello at all, hello still
 * in flight, or a forged hello was dropped — all indistinguishable from "not
 * verified", matching this module's fail-soft contract throughout). This is
 * the one thing safe to feed an authorization decision (e.g.
 * serve-wiring.ts's scope-repo gate) — never the wire-level `req` frame's
 * self-reported `peerGithubUserId`, which nothing here verifies.
 */
export function resolveVerifiedDevicePubkeyForSocket(socket: unknown): string | undefined {
  if (typeof socket !== 'object' || socket === null) return undefined;
  return verifiedDeviceBySocket.get(socket);
}

/** Transport-neutral request carried by every pot-git per-device dial.
 * Exported so the relocated substrate proxy can forward the exact same request
 * into the sidecar-owned dial registry without duplicating its shape. */
export interface HiveGitDuplexRequest {
  repoKey: string;
  peerGithubUserId?: number;
  waitForRegistrationMs?: number;
}

/**
 * Build (or fail soft) a live fetch Duplex to `devicePubkeyBase64` on
 * `topic`'s pot-git channel — the real cross-machine `openDuplex` seam
 * `worktree-bridge-tick.ts` / `ref-announce-tick.ts` document as a KNOWN
 * LIMITATION when omitted. No live connection to that device yet ⇒ an
 * immediately-destroyed Duplex (fail-soft, matches `openHiveGitFetchDuplex`'s
 * own "never throws" contract) so a caller degrades to a `fetch-failed`
 * outcome (retried next tick) rather than crashing.
 */
export async function openHiveGitDuplexToDevice(
  topic: Buffer,
  devicePubkeyBase64: string,
  req: HiveGitDuplexRequest,
): Promise<Duplex> {
  let socket = resolvePotGitPeerSocket(topic, devicePubkeyBase64);
  if (!socket) {
    // EI-18740968796318403: the instantaneous lookup above misses ~42% of the
    // time purely because the hello channel is mid-churn. Give a peer we have
    // recent positive evidence for a brief chance to come back before declaring
    // it unreachable. A never-seen device returns immediately, so the common
    // "20 candidates, 19 offline" dial costs nothing extra.
    socket = await awaitRegistration(
      topic.toString('hex'),
      devicePubkeyBase64,
      req.waitForRegistrationMs ?? DEFAULT_REGISTRATION_WAIT_MS,
    );
  }
  if (!socket) {
    const d = new Duplex({
      read() {
        /* no data — destroyed below */
      },
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    // Fail-soft contract (see file header): callers check `.destroyed`, they
    // never `.on('error', ...)` — so swallow the destroy-time error here.
    // Without this, `.destroy(err)` with no attached 'error' listener
    // schedules an UNHANDLED 'error' emission on the next tick (a genuine
    // Node stream footgun, not test-only — it would just as surely surface
    // in production as an uncaught exception on the process).
    d.on('error', () => {
      /* fail-soft: caller reads `.destroyed`, never the error event */
    });
    d.destroy(new Error(`pot-git: no live connection to device ${devicePubkeyBase64.slice(0, 12)}…`));
    return d;
  }
  return openHiveGitFetchDuplex(socket, topic, req);
}

export const _testing = {
  registryByTopic,
  wiredTopics,
  trackedMuxers,
  healSweep,
  // EI-18740968796318403 dial-gap handling — exposed so a unit test can drive the
  // registered/de-registered/re-registered sequence without standing up protomux.
  lastRegisteredAt,
  registrationWaiters,
  noteRegistered,
  RECENT_SIGHTING_MS,
  DEFAULT_REGISTRATION_WAIT_MS,
  // WI-5210 one-sided-hello healing — exposed so a unit test can drive the
  // lost-hello / re-send sequence without standing up protomux or a second box.
  // `REDIAL_DELAYS_MS` is exposed so the redial-tail suite's control can be
  // pinned to the REAL ladder instead of a hardcoded length that could drift
  // away from it.
  REDIAL_DELAYS_MS,
  statesFor,
  dialConfigByMuxer,
  maybeSendHello,
  newState,
  // P-203 Leg A identity-race repair — exposed so a unit test can drive a
  // synchronous-onopen channel materialization through a fake muxer and assert
  // WHICH device the first hello carries.
  wiredTopicIdentity,
  ensureChannel,
  reset(): void {
    registryByTopic.clear();
    wiredTopics.clear();
    wiredTopicIdentity.clear();
    trackedMuxers.clear();
    lastRegisteredAt.clear();
    registrationWaiters.clear();
    if (healSweepTimer) {
      healSweepTimer.stop();
      healSweepTimer = null;
    }
  },
};
