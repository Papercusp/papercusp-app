/**
 * hyperbee/remote-core-host.ts — ONE Hypercore instance per (machine, log key).
 *
 * WHY THIS EXISTS (WI-5673 root cause; WI-6076 is the mechanism filing)
 * --------------------------------------------------------------------
 * Sibling harnesses that belong to the SAME Hive join the SAME swarm topic, so
 * they admit the SAME set of remote peer-log keys (verified on the live-fed rig:
 * `hello-world` and `hello-world-pot` both join topic 8fd050e6… and both emit
 * `announce_admitted` for the same two keys). Each harness has its OWN Corestore
 * (`.papercusp/<slug>/hyperbee`), so before this module each of those harnesses
 * opened its own on-disk REPLICA of the very same hypercore.
 *
 * That is fatal on a shared peer socket, and the reason is upstream and
 * structural, not tunable:
 *
 *   - every harness shares ONE process-wide Hyperswarm, so one peer is reached
 *     over ONE socket ⇒ ONE Protomux muxer for all of them (swarm.ts);
 *   - `hypercore/lib/replicator.js` `_makePeer()` opens the replication channel
 *     with `protomux.createChannel({ protocol: 'hypercore/alpha', id: <the
 *     core's discoveryKey> })` and bails out FIRST via
 *     `if (protomux.opened({ protocol: 'hypercore/alpha', id: discoveryKey }))
 *     return onnochannel()`;
 *   - `protomux.createChannel` defaults `unique = true` and returns `null` when
 *     a channel for that (protocol, id) is already open (protomux index.js:437).
 *
 * ⇒ A muxer carries AT MOST ONE hypercore/alpha channel per discovery key. Two
 * local replicas of one key can never both replicate over one socket: whichever
 * attaches first wins, and the loser sits at `peersCount === 0` FOREVER while
 * the socket stays fully handshaken and live.
 *
 * The starved replica is not merely idle — it drives a churn engine. It trips
 * the `replication_stalled` detector, which runs repair-on-detect (structurally
 * incapable here: re-attaching a session that still cannot win the single slot),
 * then repair-exhausted escalates to a FORCED TOPIC REJOIN, which (WI-5481,
 * deliberately) destroys the SHARED socket — killing replication for the
 * co-tenant harnesses that were perfectly healthy. The reconnect reshuffles
 * which store wins each key, so a different sibling starves next round. That is
 * the intermittent, order-dependent, direction-selective federation failure.
 *
 * THE FIX: a remote log is opened in exactly ONE Corestore per machine. Sibling
 * harnesses that admit the same key share that single core (each still gets its
 * own Corestore SESSION via `store.get()`, so per-harness `close()` semantics,
 * refcounting and lifetime are unchanged). One core ⇒ one channel ⇒ no
 * collision, and every sibling reads the same replicated blocks.
 *
 * SCOPE — deliberately narrow:
 *   - Only REMOTE (read-only) logs are deduplicated. A harness's OWN writable
 *     log is per-harness by construction and can never collide.
 *   - Only stores minted by the `corestore.ts` factory participate; a store the
 *     factory never registered (an ad-hoc RAM store in a unit test, a fake) is
 *     returned unchanged, so hermetic tests that simulate two machines IN ONE
 *     PROCESS keep two independent replicas exactly as before.
 *   - Dedup is keyed by MACHINE (the workspace root), never globally, for the
 *     same reason: two workspace roots in one process are two machines.
 *
 * LIFETIME. The shared core physically lives in the HOST harness's store
 * directory, so removing that harness takes its blocks with it. That is handled
 * rather than prevented: `closeHarnessStore` calls `forgetStore` BEFORE the
 * close, so the next `openRemoteLog` for one of those keys re-homes it onto a
 * live store (re-downloading from the peer, exactly as a first admission does).
 * A sibling holding a session across that close sees its handle die, which is
 * the same shape as any replica loss — boot.ts's stall detector re-opens
 * through `openRemoteLog`, which re-homes it. Sessions are refcounted by
 * Corestore, so an ordinary per-harness `close()` never disturbs a sibling.
 *
 * NOT fixed here: the distinct-key `protomux.pair()` wildcard clobber (WI-6076)
 * — a SECOND store's `replicate()` on one socket overwrites the first's
 * `hypercore/alpha` notify slot, which strands cores that are on disk but NOT
 * OPEN. Open cores are eagerly attached by each store's own `replicate()`, so
 * that defect is narrower and is tracked separately on WI-6076.
 */

import type Corestore from 'corestore';

/** Store → the machine (workspace root) it belongs to. Set by the factory. */
const machineOfStore = new WeakMap<object, string>();
/** `${machineId}::${keyHex}` → the Corestore that hosts that remote core. */
const hostByKey = new Map<string, Corestore>();
/** Store → the host-registry keys it owns, so `forgetStore` can evict them. */
const keysOwnedByStore = new WeakMap<object, Set<string>>();

function registryKey(machineId: string, keyHex: string): string {
  return `${machineId}::${keyHex.toLowerCase()}`;
}

/**
 * Duck-typed "this Corestore is gone" check. Corestore extends ReadyResource,
 * which exposes `closed` / `closing`; a store closed OUT-OF-BAND (not through
 * `closeHarnessStore`) must not keep hosting keys, or every sibling that later
 * asks for one of its keys would get a session on a dead store.
 */
function isUnusable(store: Corestore): boolean {
  const s = store as unknown as { closed?: boolean; closing?: unknown };
  return s.closed === true || (s.closing !== undefined && s.closing !== null);
}

/**
 * Declare which machine a Corestore belongs to. Called by the `corestore.ts`
 * factory for the MAIN per-harness store only — the scoped store
 * (`hyperbee-scoped`) is never replicated and never hosts admitted remote logs,
 * so it deliberately does not participate.
 */
export function registerStoreMachine(store: Corestore, machineId: string): void {
  machineOfStore.set(store as unknown as object, machineId);
  wrapReplicateForBorrowedCores(store);
}

// ── WI-10003481: a BORROWED core must replicate over the CALLER's connections ──
//
// corestore 7.9.2 attaches a core only to streams its OWN root store replicated:
// `streamTracker.attachAll(core)` on the downloading transition, and `replicate()`
// iterating `this.cores`. A harness that got a SESSION on a sibling-hosted core
// (resolveRemoteCoreHost above) therefore never carried it over its own sockets.
// When the host store had not replicated the socket a peer arrived on, the log
// sat at peersCount 0 on a live connection (tower 2026-09-27: 38 siblings hosted
// the VM log; the root harness admitted it 3h later and stayed no_replicator).
// So the caller attaches the borrowed core to every muxer it has replicated, now
// and on each later replicate().

/** Minimal structural view of the hypercore surface this attach needs. */
interface AttachableCore {
  closed?: boolean;
  core?: { replicator?: { attached(muxer: unknown): boolean; attachTo(muxer: unknown): void } } | null;
}

/** Caller store → borrowed sessions (cores it opened on a sibling host). */
const borrowedByStore = new WeakMap<object, Set<AttachableCore>>();
const replicateWrapped = new WeakSet<object>();

function muxerOfStream(stream: unknown): unknown {
  const noise = (stream as { noiseStream?: { userData?: unknown } } | null)?.noiseStream;
  return noise?.userData ?? null;
}

function attachCoreToMuxer(session: AttachableCore, muxer: unknown): void {
  if (!muxer || session.closed) return;
  const replicator = session.core?.replicator;
  if (!replicator || replicator.attached(muxer)) return;
  replicator.attachTo(muxer);
}

/** The muxers of every live stream this store (its root) has replicated. */
function liveMuxersOf(store: Corestore): unknown[] {
  const tracker = (store as unknown as { streamTracker?: { records?: Array<{ stream?: unknown }> } }).streamTracker;
  const records = tracker?.records ?? [];
  const out: unknown[] = [];
  for (const record of records) {
    const muxer = muxerOfStream(record.stream);
    if (muxer) out.push(muxer);
  }
  return out;
}

function wrapReplicateForBorrowedCores(store: Corestore): void {
  const target = store as unknown as { replicate: (...args: unknown[]) => unknown };
  if (replicateWrapped.has(target) || typeof target.replicate !== 'function') return;
  replicateWrapped.add(target);
  const original = target.replicate.bind(store);
  target.replicate = (...args: unknown[]) => {
    const stream = original(...args);
    const borrowed = borrowedByStore.get(target);
    if (borrowed && borrowed.size > 0) {
      const muxer = muxerOfStream(stream);
      for (const session of [...borrowed]) {
        if (session.closed) {
          borrowed.delete(session);
          continue;
        }
        attachCoreToMuxer(session, muxer);
      }
    }
    return stream;
  };
}

/**
 * Record that `caller` holds a session on a core HOSTED by another store, and
 * attach it to every connection `caller` has already replicated. Later
 * `caller.replicate()` calls attach it too (see {@link registerStoreMachine}).
 * A no-op for a caller that hosts the core itself.
 */
export function attachBorrowedCore(caller: Corestore, host: Corestore, session: unknown): void {
  if (caller === host) return;
  const key = caller as unknown as object;
  const s = session as AttachableCore;
  let borrowed = borrowedByStore.get(key);
  if (borrowed === undefined) {
    borrowed = new Set();
    borrowedByStore.set(key, borrowed);
  }
  borrowed.add(s);
  wrapReplicateForBorrowedCores(caller);
  for (const muxer of liveMuxersOf(caller)) attachCoreToMuxer(s, muxer);
}

/**
 * Drop a closing store from the registry so the next opener re-homes its keys
 * onto a live store instead of handing out sessions on a dead one.
 */
export function forgetStore(store: Corestore): void {
  const owned = keysOwnedByStore.get(store as unknown as object);
  if (owned) {
    for (const k of owned) {
      if (hostByKey.get(k) === store) hostByKey.delete(k);
    }
    keysOwnedByStore.delete(store as unknown as object);
  }
  machineOfStore.delete(store as unknown as object);
}

/**
 * Resolve which Corestore should hold the remote log `keyHex` for the machine
 * `store` belongs to.
 *
 * Returns `store` itself — i.e. today's behaviour, byte for byte — when the
 * store was never registered by the factory (unit-test fakes/RAM stores), or
 * when this machine has not opened that key yet. Otherwise returns the store
 * that already hosts it, so the caller opens a SESSION on the existing core
 * rather than minting a second on-disk replica.
 */
export function resolveRemoteCoreHost(store: Corestore, keyHex: string): Corestore {
  const machineId = machineOfStore.get(store as unknown as object);
  // Unregistered store ⇒ not a factory-minted harness store ⇒ no dedup.
  if (machineId === undefined) return store;

  const k = registryKey(machineId, keyHex);
  const existing = hostByKey.get(k);
  if (existing !== undefined && existing !== store && !isUnusable(existing)) {
    return existing;
  }
  if (existing !== undefined && existing !== store) {
    // The recorded host died out-of-band — re-home onto the caller below.
    forgetStore(existing);
  }

  hostByKey.set(k, store);
  let owned = keysOwnedByStore.get(store as unknown as object);
  if (owned === undefined) {
    owned = new Set<string>();
    keysOwnedByStore.set(store as unknown as object, owned);
  }
  owned.add(k);
  return store;
}

/** Diagnostics/tests: how many remote keys this process is hosting, by machine. */
export function remoteCoreHostStats(): { hostedKeys: number } {
  return { hostedKeys: hostByKey.size };
}

/** Test-only: clear the process-wide registry between cases. */
export function __resetRemoteCoreHostsForTest(): void {
  hostByKey.clear();
}
