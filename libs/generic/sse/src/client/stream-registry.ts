/**
 * Live SSE stream registry + per-host connection-budget warning.
 *
 * WHY THIS EXISTS (owner incident, 2026-07-26/27 — "gym runs never show up").
 * A browser engine allows a fixed number of concurrent connections PER HOST
 * (WebKit: 6, measured in-app: the 7th EventSource never leaves CONNECTING).
 * A standing SSE stream holds one of those slots for its entire life, so a page
 * with 6 standing streams has ZERO slots left and every ordinary REST fetch
 * queues forever — the UI sits on "Loading…" while the server answers the same
 * query in ~13ms. That is invisible from the server side and nearly invisible
 * from the client (no error, just a promise that never settles), which is how it
 * survived for days.
 *
 * On the packaged desktop this is masked: `/api/*` fetches and EventSource ride
 * Tauri IPC (no sockets at all). In the DEV shell there is no sidecar, so IPC is
 * unavailable and everything falls back to HTTP — the 6-slot budget is real, and
 * this registry is what makes exceeding it observable instead of mysterious.
 *
 * Deliberately dependency-free and cheap: a Map of live streams, a monotonic id,
 * and one throttled console warning when the count reaches the danger line. Also
 * exposed as `window.__papercuspStreams()` so an operator/agent can enumerate the
 * live streams of a running page (`tauri-agent-tools eval`) without a rebuild.
 */

export interface LiveStreamRecord {
  id: number;
  url: string;
  /** Host (origin) the stream connects to — the budget is per host. */
  host: string;
  openedAtMs: number;
}

/**
 * Standing streams per host at which we warn. WebKit's cap is 6; warn at 4 so
 * there is still headroom to act (2 slots left for REST) when the log appears.
 */
export const STREAM_BUDGET_WARN_AT = 4;

/**
 * DELIBERATELY NOT `pinModuleState` (EI-22185890226391209 investigated this).
 * The repo convention ("shared-lib singletons: pin through the primitive")
 * assumes any two module records within a process SHOULD collapse into one
 * shared instance. Two independent reasons say the opposite here:
 *
 * 1. BORROWABILITY (same reason already documented at ./  ../server/channel.ts
 *    and tracked on EI-19479108855357092, still awaiting a plan Decision):
 *    `libs/generic/*` are standalone, dependency-free submodules meant to be
 *    borrowed as-is by projects that do not inherit this monorepo's hoisting.
 *    Declaring `@papercusp/module-singleton` as a dependency, with no
 *    `configure*()` seam to inject it through instead, couples this generic
 *    lib to Papercusp for every downstream borrower.
 *
 * 2. THIS MODULE'S STATE IS INTENTIONALLY PER-REALM, not a process-wide
 *    singleton that accidentally split. Every container below (live streams,
 *    REALM_ID, peers, the channel) exists to represent exactly ONE execution
 *    context — one document/iframe, each of which already has its own real
 *    `globalThis` in a browser, so genuine separate realms are correctly
 *    independent with NO pinning at all. `pinModuleState`'s
 *    globalThis-under-Symbol.for sharing would be harmless for that legitimate
 *    case (different real global objects never collide) but is actively wrong
 *    for `stream-registry.cross-realm.test.ts`, whose entire method of
 *    SIMULATING separate realms (`vi.resetModules()` + a fresh `import()`
 *    within one test process, sharing one real `globalThis`) relies on two
 *    module records NOT sharing state — precisely what pinning removes.
 *    Applying the primitive here silently merges that test's two fake realms
 *    into one and breaks its very first assertion ("two loads of the registry
 *    do not share the live Map").
 *
 * Residual, unmeasured risk (this module accidentally double-evaluating
 * WITHIN one real document, e.g. a bundler/symlink split): bounded and mostly
 * self-healing. The two records would announce as ordinary peers over
 * BroadcastChannel, so `countStreamsForHostAllRealms` still sums to the true
 * total; the only effects are a duplicate console warning and a slightly more
 * conservative yield cooldown — never a wrong count. `listModuleDuplications()`
 * would confirm whether that split has ever actually happened in a real
 * loader; nothing here indicates it has.
 */
const live = new Map<number, LiveStreamRecord>();
let nextId = 1;
const warnedHosts = new Set<string>();

/* -------------------------------------------------------------------------
 * Cross-realm accounting (WI-2141694).
 *
 * `live` above is module-scoped, so its denominator is the JS REALM. The
 * browser's connection limit is per ORIGIN-per-process. Three same-origin
 * iframes holding 2-3 standing streams each sit at 6-9 sockets against a cap
 * of 6 while every realm reads 2-3 and stays silent — the accountant is
 * structurally blind to the constraint this module exists to police.
 *
 * Realms of one origin are joined with BroadcastChannel, which is itself
 * origin-scoped: exactly the documents that share a connection pool share a
 * channel, and a parent page on another origin neither hears nor pollutes it.
 *
 * There is deliberately NO heartbeat timer. A standing interval in a generic
 * client lib is both a repo-wide lint failure and a thing every embedder then
 * has to own. Freshness is instead maintained by demand: every registration
 * broadcasts a `query`, so at precisely the moments the total matters, every
 * live peer re-announces. A realm that has gone away answers nothing and ages
 * out of the count lazily, with no timer to fire in a torn-down document.
 * ---------------------------------------------------------------------- */

/** Identifies this module realm. Two iframes (or two module records) differ. */
const REALM_ID = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** Origin-scoped channel name. Shared by every realm of one origin. */
const BUDGET_CHANNEL_NAME = 'papercusp.sse-budget';

/**
 * How long a peer realm's last announcement is trusted. Refreshed by the
 * `query` every registration broadcasts, so a live peer is re-heard whenever
 * the total is about to be consulted; only a genuinely departed realm ages out.
 */
export const PEER_STALE_AFTER_MS = 30_000;

/** Minimal transport, so tests (and non-DOM hosts) need no BroadcastChannel. */
export interface BudgetChannel {
  post(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  close(): void;
}

interface PeerRealm {
  countsByHost: Record<string, number>;
  /** That realm's best yieldable stream per host — the yield-arbitration input. */
  candidatesByHost?: Record<string, { p: number; o: number }>;
  lastSeenMs: number;
}

const peers = new Map<string, PeerRealm>();

function defaultChannelFactory(): BudgetChannel | null {
  const Ctor = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  if (typeof Ctor !== 'function') return null;
  const bc = new Ctor(BUDGET_CHANNEL_NAME);
  return {
    post: (message) => bc.postMessage(message),
    onMessage: (handler) => {
      bc.onmessage = (ev: MessageEvent) => handler(ev.data);
    },
    close: () => bc.close(),
  };
}

let channelFactory: () => BudgetChannel | null = defaultChannelFactory;
let channel: BudgetChannel | null = null;
let channelReady = false;

/** Streams this realm holds, grouped by host — the payload we announce. */
function localCountsByHost(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of live.values()) out[r.host] = (out[r.host] ?? 0) + 1;
  return out;
}

function announce(): void {
  // `candidates` rides along with the counts so yield arbitration needs no
  // extra round-trip: every realm learns every other realm's best yieldable
  // stream at exactly the moments the budget is already being restated.
  channel?.post({
    t: 'announce',
    realm: REALM_ID,
    counts: localCountsByHost(),
    candidates: localCandidatesByHost(),
  });
}

function onBudgetMessage(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const msg = raw as {
    t?: unknown;
    realm?: unknown;
    counts?: unknown;
    candidates?: unknown;
    host?: unknown;
  };
  if (typeof msg.realm !== 'string' || msg.realm === REALM_ID) return;

  if (msg.t === 'bye') {
    peers.delete(msg.realm);
    return;
  }
  if (msg.t === 'query') {
    // Someone is about to make a budget decision — tell them what we hold.
    announce();
    return;
  }
  if (msg.t === 'yield-request') {
    // A peer hit the line. Every realm evaluates the SAME total order and only
    // the owner of the globally best candidate actually yields, so this is a
    // broadcast rather than an addressed command.
    if (typeof msg.host === 'string') considerYield(msg.host);
    return;
  }
  if (msg.t === 'announce') {
    const counts = (msg.counts ?? {}) as Record<string, number>;
    const candidates = (msg.candidates ?? {}) as Record<string, CandidateWire>;
    peers.set(msg.realm, {
      countsByHost: { ...counts },
      candidatesByHost: { ...candidates },
      lastSeenMs: Date.now(),
    });
    // A peer's streams can push US over the line even though nothing changed
    // locally — that is the whole class of starvation this fix exists to see.
    for (const host of new Set([...Object.keys(counts), ...Object.keys(localCountsByHost())])) {
      maybeWarnForHost(host);
      // A peer RELEASING streams is also how pressure clears for a parked
      // consumer of ours; nothing local fires in that case.
      maybeInviteResume(host);
    }
  }
}

function ensureChannel(): void {
  if (channelReady) return;
  channelReady = true;
  try {
    channel = channelFactory();
  } catch {
    channel = null; // no transport — degrade to single-realm accounting
  }
  if (!channel) return;
  try {
    channel.onMessage(onBudgetMessage);
    // Pull peers' current holdings. We do not announce here — callers that
    // change our own count announce explicitly, so a realm that merely reads
    // the budget never advertises itself as a stream holder.
    channel.post({ t: 'query', realm: REALM_ID });
  } catch {
    /* a transport that refuses to wire up is the same as none */
  }
}

/** Drop peers we have not heard from recently. Lazy — no timer anywhere. */
function pruneStalePeers(nowMs: number): void {
  const cutoff = nowMs - PEER_STALE_AFTER_MS;
  for (const [realm, p] of peers) if (p.lastSeenMs < cutoff) peers.delete(realm);
}

function hostOf(url: string): string {
  try {
    return new URL(url, typeof location !== 'undefined' ? location.href : 'http://localhost').host;
  } catch {
    return '<unparsed>';
  }
}

/** Snapshot of the live streams, oldest first. */
export function listLiveStreams(): LiveStreamRecord[] {
  return [...live.values()].sort((a, b) => a.openedAtMs - b.openedAtMs);
}

/**
 * How many standing streams THIS realm holds against `host`.
 *
 * Deliberately local: a caller asking what it can release needs its own set.
 * For a budget decision use {@link countStreamsForHostAllRealms} — the browser
 * caps connections per origin-per-process, not per document.
 */
export function countLiveStreamsForHost(host: string): number {
  let n = 0;
  for (const r of live.values()) if (r.host === host) n += 1;
  return n;
}

/**
 * How many standing streams every known realm of this origin holds against
 * `host` — the number that is actually measured against the browser's cap.
 *
 * Equals {@link countLiveStreamsForHost} when no peers are reachable (no
 * BroadcastChannel, a single document, or a non-DOM host), so single-realm
 * behaviour is unchanged.
 */
export function countStreamsForHostAllRealms(host: string): number {
  pruneStalePeers(Date.now());
  let n = countLiveStreamsForHost(host);
  for (const p of peers.values()) n += p.countsByHost[host] ?? 0;
  return n;
}

export interface StreamBudgetSnapshot {
  host: string;
  /** Streams held by this document. */
  local: number;
  /** Streams held by every other known document of this origin. */
  peer: number;
  /** local + peer — the figure the browser's per-origin cap applies to. */
  total: number;
  warnAt: number;
  /** Other realms currently contributing to `peer`. 0 ⇒ accounting is local-only. */
  peerRealms: number;
  realmId: string;
}

/**
 * The budget as this realm currently understands it. Exposed for diagnostics
 * and as the input a future yield-on-contention policy needs — deciding WHICH
 * stream to drop requires knowing the total first, which is why accounting
 * lands before policy.
 */
export function getStreamBudgetSnapshot(host: string): StreamBudgetSnapshot {
  pruneStalePeers(Date.now());
  const local = countLiveStreamsForHost(host);
  let peer = 0;
  for (const p of peers.values()) peer += p.countsByHost[host] ?? 0;
  return {
    host,
    local,
    peer,
    total: local + peer,
    warnAt: STREAM_BUDGET_WARN_AT,
    peerRealms: peers.size,
    realmId: REALM_ID,
  };
}

/**
 * Warn once per host when the ORIGIN-WIDE total reaches the danger line.
 * Naming the split matters: "4 streams, 2 of them in this document" is what
 * tells a reader the problem is cross-document, which is exactly the fact the
 * per-realm count hid.
 */
function maybeWarnForHost(host: string): void {
  const { local, total, peerRealms } = getStreamBudgetSnapshot(host);
  if (total < STREAM_BUDGET_WARN_AT || warnedHosts.has(host)) return;
  warnedHosts.add(host);
  const urls = listLiveStreams()
    .filter((r) => r.host === host)
    .map((r) => r.url)
    .join(', ');
  const spread =
    peerRealms > 0
      ? ` across ${peerRealms + 1} documents of this origin (${local} in this one)`
      : '';
  // eslint-disable-next-line no-console
  console.warn(
    `[sse-budget] ${total} standing SSE streams open to ${host}${spread}. Browser engines ` +
      `allow ~6 connections per host, and each standing stream holds one for its whole life — ` +
      `at the cap, ordinary REST fetches queue forever ("Loading…" that never resolves). ` +
      `Streams in this document: ${urls}. Enumerate live: window.__papercuspStreams(); ` +
      `budget: window.__papercuspStreamBudget('${host}').`,
  );
}

/* -------------------------------------------------------------------------
 * Yield on contention (WI-2141694).
 *
 * Counting the pool told us we were starving; it did not stop the starving.
 * This is the acting half — and its shape is forced by two measurements, not
 * by taste:
 *
 * 1. THE TRIGGER MUST BE PROACTIVE. Measured 2026-09-02: at the per-origin cap
 *    the next request does NOT error. No `onerror`, no timeout — it queues
 *    silently and indefinitely. There is therefore no failure event to react
 *    to, and a reactive design (retry-on-error, timeout-and-recover) would
 *    have looked correct and never fired once. We act off the budget snapshot
 *    at REGISTRATION, which is the moment the total is about to matter.
 *
 * 2. THE VICTIM MUST BE CHOSEN CROSS-REALM. Measured the same day: a realm
 *    holding ZERO streams was fully starved by streams in sibling iframes, and
 *    closing one in a CHILD realm freed the parent in 31ms. A registry that
 *    only ever yielded its own streams would sit blocked while the stream that
 *    actually needed to go lived one document over.
 *
 * ── WHY THIS MODULE NEVER PICKS A VICTIM ON ITS OWN ────────────────────────
 * `libs/generic/sse` is domain-free: it cannot know that the chat pane matters
 * more than a background poller. So a stream is yieldable ONLY if its consumer
 * passed `onYieldRequested`, and consumers rank themselves with `priority`.
 * No callback ⇒ never yielded. That default is what keeps this change
 * inert for every existing caller.
 *
 * ⚠ The visibility-pause precedent proves the pause/resume MECHANISM works; it
 * does NOT license yielding anything. Visibility-pause fires when nobody is
 * watching. A contention-yield can pause a stream the user is looking at, so
 * data arrives late on a VISIBLE pane. That asymmetry is exactly why priority
 * is load-bearing and why "just drop the oldest" is the wrong rule.
 *
 * ── ARBITRATION WITHOUT A NEGOTIATION ROUND-TRIP ───────────────────────────
 * N realms must not all yield for one contended slot. Rather than a
 * request/offer/command handshake (which needs a collection window, i.e. a
 * timer this module deliberately does not have), every realm PUBLISHES its
 * best yieldable candidate on the announce it already sends. Each realm can
 * then compute the SAME global winner from the SAME data by a total order —
 * (priority, openedAtMs, realmId) — and only the realm that owns the winner
 * acts. Ties cannot be split differently by different realms because realmId
 * makes the order total.
 *
 * The residual race is a divergent peer table, which can over-yield by one.
 * The cooldown below bounds it; hysteresis (yield at 5, invite back under 3)
 * stops a yielded stream re-registering straight into another yield.
 * ---------------------------------------------------------------------- */

/** Origin-wide standing streams at which we start yielding. Above the warn line. */
export const STREAM_YIELD_AT = 5;

/**
 * Invite parked streams back only once the origin is comfortably clear.
 * The GAP to {@link STREAM_YIELD_AT} is the hysteresis: resuming at the yield
 * line would re-trigger contention on the next registration and oscillate.
 */
export const STREAM_RESUME_UNDER = 3;

/** Minimum spacing between yields for one host, so a burst cannot cascade. */
export const YIELD_COOLDOWN_MS = 5_000;

/** Consumer-supplied policy. Absent `onYieldRequested` ⇒ this stream is never yielded. */
export interface RegisterStreamOptions {
  /**
   * Higher survives longer. Default 0. Compared only against other streams of
   * the SAME origin, so callers need no global scale — just an ordering.
   */
  priority?: number;
  /**
   * Release the socket NOW; contention was detected. The consumer is expected
   * to close its transport (which calls the unregister fn) and wait for
   * {@link RegisterStreamOptions.onResumeAllowed}. Throwing is swallowed.
   */
  onYieldRequested?: () => void;
  /** Pressure has cleared — safe to reconnect. Throwing is swallowed. */
  onResumeAllowed?: () => void;
}

interface YieldableEntry {
  id: number;
  host: string;
  priority: number;
  openedAtMs: number;
  onYieldRequested: () => void;
  onResumeAllowed?: () => void;
}

/** Yield policy for live streams that opted in, keyed by the same id as `live`. */
const yieldable = new Map<number, YieldableEntry>();

/** Consumers that yielded and are waiting to be invited back, oldest first. */
const parked: Array<{ host: string; yieldedAtMs: number; onResumeAllowed?: () => void }> = [];

/** Last yield per host, for {@link YIELD_COOLDOWN_MS}. */
const lastYieldAtMs = new Map<string, number>();

/** A realm's best yieldable stream for one host, as published on the wire. */
interface CandidateWire {
  /** priority */ p: number;
  /** openedAtMs */ o: number;
}

/** This realm's best (most-yieldable) candidate per host — lowest priority, then oldest. */
function localCandidatesByHost(): Record<string, CandidateWire> {
  const out: Record<string, CandidateWire> = {};
  for (const e of yieldable.values()) {
    const cur = out[e.host];
    if (!cur || e.priority < cur.p || (e.priority === cur.p && e.openedAtMs < cur.o)) {
      out[e.host] = { p: e.priority, o: e.openedAtMs };
    }
  }
  return out;
}

/**
 * The local entry matching {@link localCandidatesByHost} for `host`.
 *
 * `excludeId` guards a re-entrancy hazard: the evaluation runs INSIDE
 * `registerLiveStream`, so the stream being registered could be picked as its
 * own victim — and at that moment its consumer does not yet hold the
 * unregister fn, so the close it performs could not remove it from `live`.
 * That leaks a phantom stream into the very count this module exists to keep
 * honest. A stream becomes eligible on the NEXT contention event instead.
 */
function bestLocalYieldable(host: string, excludeId?: number): YieldableEntry | null {
  let best: YieldableEntry | null = null;
  for (const e of yieldable.values()) {
    if (e.host !== host || e.id === excludeId) continue;
    if (
      !best
      || e.priority < best.priority
      || (e.priority === best.priority && e.openedAtMs < best.openedAtMs)
    ) {
      best = e;
    }
  }
  return best;
}

/**
 * Which realm owns the globally most-yieldable stream for `host`.
 *
 * Total order — priority, then openedAtMs, then realmId — so every realm
 * computing this over the same peer table reaches the same answer, which is
 * what removes the need for a negotiation round-trip. `null` ⇒ nothing
 * anywhere has opted in.
 */
function yieldWinnerRealm(host: string): string | null {
  pruneStalePeers(Date.now());
  let winner: { realm: string; p: number; o: number } | null = null;
  const consider = (realm: string, c: CandidateWire) => {
    if (
      !winner
      || c.p < winner.p
      || (c.p === winner.p && c.o < winner.o)
      || (c.p === winner.p && c.o === winner.o && realm < winner.realm)
    ) {
      winner = { realm, p: c.p, o: c.o };
    }
  };
  const mine = localCandidatesByHost()[host];
  if (mine) consider(REALM_ID, mine);
  for (const [realm, p] of peers) {
    const c = p.candidatesByHost?.[host];
    if (c) consider(realm, c);
  }
  return winner ? (winner as { realm: string }).realm : null;
}

/**
 * Yield one stream for `host` IF this realm owns the globally best candidate.
 *
 * Every realm runs this on a `yield-request`; the total order above ensures at
 * most one of them finds itself the winner.
 */
function considerYield(host: string, excludeId?: number): void {
  const now = Date.now();
  const last = lastYieldAtMs.get(host) ?? 0;
  if (now - last < YIELD_COOLDOWN_MS) return;
  if (countStreamsForHostAllRealms(host) < STREAM_YIELD_AT) return;
  if (yieldWinnerRealm(host) !== REALM_ID) return;

  const victim = bestLocalYieldable(host, excludeId);
  if (!victim) return;

  lastYieldAtMs.set(host, now);
  // Park BEFORE calling out: the callback synchronously closes the transport,
  // which re-enters this module through the unregister fn.
  parked.push({
    host,
    yieldedAtMs: now,
    onResumeAllowed: victim.onResumeAllowed,
  });
  yieldable.delete(victim.id);
  try {
    victim.onYieldRequested();
  } catch {
    /* a consumer's callback must never break the registry */
  }
}

/**
 * Invite ONE parked consumer back once the origin is clear.
 *
 * One at a time on purpose: releasing every parked stream at once would
 * re-contend the pool in a single tick, which is the stampede the hysteresis
 * gap exists to prevent. The next unregister invites the next one.
 */
function maybeInviteResume(host: string): void {
  if (countStreamsForHostAllRealms(host) >= STREAM_RESUME_UNDER) return;
  const idx = parked.findIndex((p) => p.host === host);
  if (idx < 0) return;
  const [entry] = parked.splice(idx, 1);
  try {
    entry?.onResumeAllowed?.();
  } catch {
    /* ignore */
  }
}

/**
 * Register a stream that now holds a connection. Returns its unregister fn —
 * call it whenever the socket is released (close, visibility/bfcache pause, a
 * zombie rebuild), so the count tracks REAL socket usage rather than intent.
 *
 * `opts.onYieldRequested` opts this stream in to yield-on-contention; without
 * it the stream is counted but never asked to step aside.
 */
export function registerLiveStream(url: string, opts?: RegisterStreamOptions): () => void {
  const id = nextId++;
  const host = hostOf(url);
  const openedAtMs = Date.now();
  live.set(id, { id, url, host, openedAtMs });
  if (opts?.onYieldRequested) {
    yieldable.set(id, {
      id,
      host,
      priority: opts.priority ?? 0,
      openedAtMs,
      onYieldRequested: opts.onYieldRequested,
      onResumeAllowed: opts.onResumeAllowed,
    });
  }
  ensureChannel();
  // A registration is exactly when the origin-wide total is about to matter:
  // publish what we now hold, and ask peers to restate theirs so the figure we
  // warn on is current rather than remembered.
  channel?.post({ t: 'query', realm: REALM_ID });
  announce();
  maybeWarnForHost(host);
  maybeRequestYield(host, id);
  return () => {
    live.delete(id);
    yieldable.delete(id);
    announce();
    // Re-arm the warning once the host drops back under the line, so a later
    // regression warns again instead of being swallowed by the first one.
    if (countStreamsForHostAllRealms(host) < STREAM_BUDGET_WARN_AT) warnedHosts.delete(host);
    maybeInviteResume(host);
  };
}

/**
 * Ask the origin to free a slot, if it is contended.
 *
 * Broadcast first, then evaluate locally: peers and this realm run the same
 * `considerYield`, and only the owner of the globally best candidate acts.
 */
function maybeRequestYield(host: string, justRegisteredId?: number): void {
  if (countStreamsForHostAllRealms(host) < STREAM_YIELD_AT) return;
  channel?.post({ t: 'yield-request', realm: REALM_ID, host });
  considerYield(host, justRegisteredId);
}

/** Test seam — drop all registry state, including cross-realm accounting. */
export function _resetStreamRegistry(): void {
  live.clear();
  warnedHosts.clear();
  nextId = 1;
  peers.clear();
  yieldable.clear();
  parked.length = 0;
  lastYieldAtMs.clear();
  try {
    channel?.close();
  } catch {
    /* closing a spent transport must never fail a reset */
  }
  channel = null;
  channelReady = false;
}

/**
 * Test seam — supply the cross-realm transport.
 *
 * Required because jsdom does not implement BroadcastChannel, so the only way
 * to exercise multi-realm accounting deterministically is to inject a bus.
 * Pass `null` to restore the real one.
 */
export function _setBudgetChannelFactory(factory: (() => BudgetChannel | null) | null): void {
  channelFactory = factory ?? defaultChannelFactory;
  try {
    channel?.close();
  } catch {
    /* ignore */
  }
  channel = null;
  channelReady = false;
}

// Expose for live inspection from a running page (devtools or an agent's
// bridge-eval). Assigned once, defensively — never throws in a non-DOM host.
try {
  if (typeof window !== 'undefined') {
    const w = window as unknown as {
      __papercuspStreams?: () => LiveStreamRecord[];
      __papercuspStreamBudget?: (host?: string) => StreamBudgetSnapshot[];
    };
    w.__papercuspStreams = listLiveStreams;
    // The cross-realm figure: what `__papercuspStreams()` alone cannot show,
    // because it enumerates only THIS document's share of the origin's pool.
    w.__papercuspStreamBudget = (host?: string) => {
      const hosts = host
        ? [host]
        : [...new Set([...Object.keys(localCountsByHost()), ...peerHostNames()])];
      return hosts.map((h) => getStreamBudgetSnapshot(h));
    };
    // Leaving without a goodbye would leave our streams counted against peers
    // until they age out; `pagehide` covers bfcache and ordinary navigation.
    window.addEventListener('pagehide', () => {
      try {
        channel?.post({ t: 'bye', realm: REALM_ID });
      } catch {
        /* the document is going away regardless */
      }
    });
  }
} catch {
  /* non-DOM host — registry still works in-process */
}

function peerHostNames(): string[] {
  const out: string[] = [];
  for (const p of peers.values()) out.push(...Object.keys(p.countsByHost));
  return out;
}
