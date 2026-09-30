/**
 * peer-log.ts — per-peer single-writer Hypercore op-log (Model B, Stage 1).
 *
 * The lowest layer of the Model B substrate rewrite: it replaces the
 * multi-writer Autobase with one signed, append-only log PER PEER plus a
 * read-merge over the others (later stages). This module exposes:
 *
 *   - `openOwnLog(store)`   — the peer's OWN writable log (`writable === true`).
 *     Appends carry a `PeerLogOp` (a single-writer op envelope); reads decode
 *     back to a plain object via `valueEncoding: 'json'`.
 *
 *   - `openRemoteLog(store, keyHex)` — a READ-ONLY replica handle to another
 *     peer's log, addressed by its hypercore key hex (`writable === false`).
 *     `update()` blocks until the writer's length is known; `get(i)` blocks
 *     until the block downloads. Replication itself is wired in Stage 4 — this
 *     stage only exposes the handle + `update()`.
 *
 * Pure over an injected `Corestore` so it unit-tests without the network.
 * Mirrors `corestore.ts` conventions: `store.get({ name | key, valueEncoding })`.
 *
 * Stage-0-VERIFIED API notes (do not deviate without re-probing):
 *  - Own log: `store.get({ name: 'peer-log', valueEncoding: 'json' })`; with
 *    `valueEncoding:'json'`, `append(obj)` takes an object and `get(i)` returns
 *    a DECODED object — no manual encode/decode.
 *  - `core.key` is a 32-byte Buffer; `keyHex = core.key.toString('hex')` is the
 *    64-char lowercase `log_core_key` used to replicate. It is DISTINCT from the
 *    device-identity pubkey (`PeerLogOp.author_pubkey`); do not conflate them.
 *  - Remote: `store.get({ key, valueEncoding: 'json' })`; a remote needs
 *    `await core.update({ wait: true })` before `core.length` reflects the
 *    writer's appends, and `core.get(i, { wait: true })` to block on download.
 */

import type Corestore from 'corestore';
// Imported for the compile-time field-compat guard below. `PeerLogOp` is
// defined explicitly so this module doesn't depend on the (retiring) Autobase;
// `OpEnvelope` now lives in its own types module (Stage 4d).
import type { OpEnvelope } from './op-envelope-types';
import type { CancellableRead, PrefetchRange } from './read-merge';
import { attachBorrowedCore, resolveRemoteCoreHost } from './remote-core-host';
import { trackDetached } from '../../detached-imports';

/**
 * A single-writer op envelope. This is the `OpEnvelope` shape MINUS the
 * `addWriter` variant (single-writer logs never carry admission ops) PLUS a
 * required `author_pubkey` — the device-identity pubkey of the writer,
 * caller-supplied and DISTINCT from the hypercore `keyHex`.
 */
export interface PeerLogOp {
  type: 'put' | 'del';
  table: string;
  hbKey: string;
  value?: unknown;
  ts: number;
  schema_version: number;
  /**
   * Hex device-identity pubkey of the writer. Caller-supplied; NOT the
   * hypercore key (see `keyHex`). Used by later read-merge/admission stages to
   * attribute an op to a peer identity independent of which core carried it.
   */
  author_pubkey: string;
  /**
   * Hybrid Logical Clock stamp (D-003), `encodeHlc`-encoded (sortable string).
   * Stamped at the append seam (`boot.ts` `handle.append`, P-010) for every
   * LWW-federated write, so `lwwPick` orders cross-peer conflicts by causal HLC
   * instead of bare wall-clock `ts` (skew-robust + happens-before across
   * machines). Optional + additive: ops written without it (e.g. the
   * append-only, never-LWW claim path, or pre-P-010 history) fall back to `ts`.
   * Round-trips through `valueEncoding:'json'` like every other field.
   */
  hlc?: string;
  /**
   * Hive epoch RE-KEY stamp (WI-808 fix; shared-hive-rekey-2026-06-19). The epoch
   * the op's encrypted `value` payload was sealed under — set by the outbox drain's
   * `EpochEncryptCapability` for selected hive-content ops, read on the receive side
   * by the apply-side decrypt-gate to resolve the wrapped epoch key + AAD.
   *
   * MUST be carried on the WIRE: `OpEnvelope.epoch` existed, but this `PeerLogOp`
   * (the single-writer log's on-disk op) never carried it, so the send append +
   * receive `toEnvelope` dropped it → the gate saw `epoch == null` → it treated the
   * ciphertext as plaintext and the content op silently dropped on every joiner
   * (zero decrypt-gate trace). Optional + additive: round-trips through
   * `valueEncoding:'json'` like `hlc`; absent on plaintext ops (today's path).
   */
  epoch?: number;
}

// Compile-time guard that catches field-REMOVAL drift only: if a field named
// here is dropped from OpEnvelope, the `Pick` stops compiling. It does NOT
// catch a type change on those fields — they're all optional on OpEnvelope, so
// a `PeerLogOp` (with its required versions) still satisfies the `Pick`. Purely
// structural; no runtime cost. Keeps the per-peer-log op aligned with the
// projection-layer `OpEnvelope` (op-envelope-types.ts).
type _PeerLogOpSharesEnvelope = Pick<OpEnvelope, 'table' | 'hbKey' | 'value' | 'ts' | 'schema_version' | 'epoch'>;
const _opEnvelopeCompat: (op: PeerLogOp) => _PeerLogOpSharesEnvelope = (op) => op;
void _opEnvelopeCompat;

/** The peer's own writable log handle. */
export interface OwnLog {
  /** Append a single op to the end of the log. */
  append(op: PeerLogOp): Promise<void>;
  /**
   * Append many ops in one Hypercore batch (one signing + flush instead of
   * one per op). Semantically identical to awaiting `append` per op; exists
   * because bulk corpus loads (the p2p-perf suite seeds 10k-1M-op histories)
   * are ~2 orders of magnitude faster batched.
   */
  appendBatch(ops: PeerLogOp[]): Promise<void>;
  /** Read the op at index `i` (decoded), or `null` if out of range. */
  get(i: number): Promise<PeerLogOp | null>;
  /**
   * WI-10002855 — read block `i` as its STORED bytes (the UTF-8 JSON the json session
   * wrote), without decoding, or `null` if out of range. A bulk fold ships these bytes
   * to a worker thread instead of paying `JSON.parse` for every block on the event loop.
   * Optional: test fakes omit it, and callers that need it must feature-detect.
   */
  getRaw?(i: number): Promise<Uint8Array | null>;
  /**
   * WI-10002855 — append pre-encoded blocks in ONE batch. Each block must be exactly the
   * UTF-8 JSON of one `PeerLogOp`, which is byte-for-byte what `appendBatch` would write
   * for the decoded op, so the log's content is identical whichever form wrote it.
   */
  appendRawBatch?(blocks: Uint8Array[]): Promise<void>;
  /**
   * Run `fn` while every other append on this log waits, so the length cannot move
   * under it; appends issued before the hold land first. `fn` appends through the
   * handle it is given — this log's own append methods wait on the hold, so calling
   * them inside `fn` deadlocks. The snapshot producer holds appends from its last
   * re-anchor through its append: on the tower's busy own log a live op otherwise lands
   * between the two and displaces the whole set (the WI-37526 anchor race; plan
   * p2p-join-catchup-speed D-025). Optional: test fakes omit it; callers feature-detect.
   */
  withAppendsHeld?<T>(fn: (log: HeldOwnLogAppender) => Promise<T>): Promise<T>;
  /** Number of ops appended so far. */
  readonly length: number;
  /** 64-char lowercase hex hypercore key — the `log_core_key` to replicate. */
  readonly keyHex: string;
}

/** The appends open to the holder of {@link OwnLog.withAppendsHeld}. */
export interface HeldOwnLogAppender {
  appendBatch(ops: PeerLogOp[]): Promise<void>;
  appendRawBatch?(blocks: Uint8Array[]): Promise<void>;
}

/** A read-only replica handle to another peer's log. */
export interface RemoteLog {
  /**
   * Read the op at index `i`. Returns `null` if `i` is out of the replica's
   * known range (negative, or `>= length` — call `update()` first to refresh
   * `length`); otherwise blocks until the in-range block downloads from the
   * peer, then returns the decoded op.
   */
  get(i: number): Promise<PeerLogOp | null>;
  /**
   * p2p-join-catchup-speed P-533: `get(i)` that the caller can withdraw. `cancel()`
   * rejects `op` and withdraws the block request from the peer, so a block nobody
   * needs any more (a chunk of a snapshot set the merge skips) is not downloaded.
   * Optional: the merge feature-detects it and falls back to `get`.
   */
  getCancellable?(i: number): CancellableRead;
  /** Block until the writer's current length is known to this replica. */
  update(): Promise<void>;
  /**
   * Fire-and-forget RANGED download request for blocks [start, end). Makes the
   * peer stream the whole range continuously instead of paying one round trip
   * per sequential `get(i)` — without it, WAN merge ingest is RTT-bound at
   * ~1/RTT ops/sec per log (EI-92). Never throws and never blocks: subsequent
   * `get(i)` calls resolve as blocks arrive. P-533: returns a handle whose `cancel()`
   * withdraws the range (undefined when no range was requested), so the merge can
   * stop streaming a snapshot set it jumps over.
   */
  prefetch(start: number, end: number): PrefetchRange | undefined;
  /** True iff block `i` is downloaded locally (Hypercore `has`). A snapshot-seeded
   *  joiner never requests blocks before its snapshot index, so this is false there —
   *  the sparse-fetch the compaction buys (substrate-peer-log-compaction P-008).
   *  Async because Hypercore 11's `has` is: a sync wrapper returned `!!Promise`, true
   *  for every block, which let the WI-3288 seed-admission guard admit an empty replica
   *  (WI-10003092). */
  has(i: number): Promise<boolean>;
  /** Length of the contiguous downloaded prefix from index 0 (Hypercore
   *  `contiguousLength`); 0 when block 0 is absent — i.e. a sparse-from-snapshot replica. */
  readonly contiguousLength: number;
  /** Known length of the remote log (call `update()` first to refresh). */
  readonly length: number;
  /** 64-char lowercase hex hypercore key this replica tracks. */
  readonly keyHex: string;
  /**
   * WI-183: number of LIVE replicator peers currently attached to this
   * specific core (`core.peers.length`), or `undefined` when the underlying
   * core doesn't expose `.peers` (a fake/mock in a unit test). `0` here while
   * the swarm otherwise reports an open connection to the same remote party is
   * the "replication silently stalled" symptom — a live transport with no
   * attached replicator session for this log. See boot.ts's stall detector.
   * Optional — feature-detected by the caller — so hand-rolled `RemoteLog`
   * test fixtures elsewhere in the codebase don't need a stub.
   */
  peersCount?(): number | undefined;
  /**
   * WI-1856 (G9): release the underlying Hypercore SESSION this replica opened
   * via `store.get({ key })`. Each `openRemoteLog` call creates a fresh session
   * (Corestore sessions are per-`.get()`, not per-key) — leaving it open after
   * the replica is no longer referenced (e.g. dropped from `boot.ts`'s
   * `admitted` map on `revoke()`) leaks the session's replicator/file-handle
   * state for the life of the process. Idempotent (Hypercore no-ops a repeat
   * `close()`). Optional — feature-detected by the caller, so hand-rolled
   * `RemoteLog` test fixtures elsewhere in the codebase don't need a stub.
   */
  close?(): Promise<void>;
}

/**
 * Minimal structural view of the bits of a Hypercore we touch. Corestore's
 * `.get()` is typed loosely upstream, so we narrow at the boundary rather than
 * leaking `any` through the module.
 */
interface CoreLike {
  ready(): Promise<void>;
  append(value: unknown): Promise<number>;
  /** `activeRequests` (Hypercore): the array this read's network request is filed in,
   *  so the caller can withdraw it with `Hypercore.destroyRequests`. */
  get(index: number, opts?: { wait?: boolean; activeRequests?: unknown[] }): Promise<unknown>;
  update(opts?: { wait?: boolean }): Promise<boolean>;
  /** Hypercore ranged download — returns a Range whose `done()` resolves when
   *  the range is local. Optional in the structural view (present on real cores). */
  download?(range: { start: number; end: number }): { done(): Promise<void>; destroy?(): void };
  /** Whether block `index` is downloaded locally. Present on real cores; async on Hypercore 11. */
  has?(index: number): Promise<boolean>;
  /** Length of the contiguous downloaded prefix from 0. Present on real cores. */
  readonly contiguousLength?: number;
  /**
   * WI-183: live replicator peers for THIS SPECIFIC core (Hypercore's
   * `core.peers` getter — `core.replicator.peers` once opened). Distinct from
   * the raw swarm socket count: a swarm connection can stay open (transport
   * live) while a particular core's replicator session never attached to it
   * (or detached after a crash/reconnect), which is exactly the silent
   * "peer_connected fires but this log's replication never resumes" failure
   * mode reported in WI-183. Optional — absent on fakes/mocks in tests.
   */
  readonly peers?: ReadonlyArray<unknown>;
  readonly length: number;
  readonly key: Buffer;
  readonly writable: boolean;
  /** Release this Corestore session. Present on real cores (WI-1856). */
  close?(): Promise<void>;
}

function getCore(store: Corestore, opts: { name: string } | { key: Buffer }): CoreLike {
  // `valueEncoding: 'json'` makes append/get round-trip plain objects.
  return (store as unknown as {
    get(o: Record<string, unknown>): CoreLike;
  }).get({ ...opts, valueEncoding: 'json' });
}

/**
 * Open the peer's OWN writable single-writer log. The core is created lazily by
 * Corestore on first access under the fixed name `'peer-log'`, so every call on
 * a given store returns the same underlying writable core.
 *
 * `forkGuard` (P-003, own-log-fork-guard.ts) is OPTIONAL and additive: when
 * passed, this wires the real Hypercore `'conflict'` event on the underlying
 * session to `attachOwnLogForkListener` so a genuine equivocation-loop
 * conflict on THIS own log actually escalates (durable EI + health verdict)
 * instead of failing silently. Omitted by every existing caller (perf
 * fixtures, seed-cutter, unit tests) — behavior is byte-identical when
 * absent. boot.ts (the real production merge-loop boot path) is the one
 * caller that passes it.
 */
/**
 * Open a WRITABLE log by corestore NAME.
 *
 * `openOwnLog` is this with the name `'peer-log'`. Factored out for the seed cut
 * (EI-20108164746219771), which mints a SEPARATE synthetic core to hold one filtered
 * snapshot so the shipped seed stops being a slice of the owner's private log — see
 * `produceFilteredSnapshotIntoLog`. A distinct name yields a distinct keypair from the
 * same store, which is exactly what "ship a product, not a slice" needs.
 *
 * The fork guard is OPT-IN and callers other than the own log should leave it off: it
 * watches for a forked OWN log, which is meaningless for a single-use synthetic core.
 */
export async function openNamedLog(
  store: Corestore,
  name: string,
  forkGuard?: { workspaceId: string; harnessSlug: string },
): Promise<OwnLog> {
  const core = getCore(store, { name });
  await core.ready();
  const keyHex = core.key.toString('hex');

  if (forkGuard) {
    // Lazy import: keeps this module's static import graph free of the
    // fork-guard's (eventual, lazy-inside-the-reporter) PG dependency —
    // mirrors replication-liveness.ts's own lazy-import-for-escalation
    // pattern. Best-effort: a wiring failure must never block opening the log.
    void trackDetached(import('./own-log-fork-guard'))
      .then((m) => m.attachOwnLogForkListener(core, forkGuard.workspaceId, forkGuard.harnessSlug, keyHex))
      .catch(() => {
        /* best-effort: the log still opens even if the listener can't attach */
      });
  }

  let rawSessionPromise: Promise<CoreLike> | undefined;
  // withAppendsHeld: the hold every other append waits behind, and the appends already
  // issued, which the holder lets land before it reads the length.
  let appendHold: Promise<void> | null = null;
  const inFlightAppends = new Set<Promise<unknown>>();
  // The hold check and the append's start run in ONE synchronous step, so a hold taken
  // in between cannot miss this append.
  async function appendUnlessHeld(start: () => Promise<unknown>): Promise<void> {
    while (appendHold) await appendHold;
    const pending = start();
    inFlightAppends.add(pending);
    try {
      await pending;
    } finally {
      inFlightAppends.delete(pending);
    }
  }
  const appendRawNow = async (blocks: Uint8Array[]): Promise<void> => {
    if (blocks.length === 0) return;
    await (await rawSession()).append(blocks);
  };

  return {
    async append(op: PeerLogOp): Promise<void> {
      await appendUnlessHeld(() => core.append(op));
    },
    async appendBatch(ops: PeerLogOp[]): Promise<void> {
      if (ops.length === 0) return;
      // Hypercore's append accepts an array of blocks — one batch, one flush.
      await appendUnlessHeld(() => core.append(ops));
    },
    async withAppendsHeld<T>(fn: (log: HeldOwnLogAppender) => Promise<T>): Promise<T> {
      while (appendHold) await appendHold;
      let release!: () => void;
      appendHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await Promise.allSettled([...inFlightAppends]);
        return await fn({
          async appendBatch(ops: PeerLogOp[]): Promise<void> {
            if (ops.length > 0) await core.append(ops);
          },
          appendRawBatch: appendRawNow,
        });
      } finally {
        appendHold = null;
        release();
      }
    },
    async get(i: number): Promise<PeerLogOp | null> {
      // Out-of-range → null. The own core is writable with no peers, so an
      // unguarded `core.get(i)` for `i >= length` would block forever on
      // Hypercore's default `wait: true`, and a negative `i` would throw.
      if (i < 0 || i >= core.length) return null;
      // `wait: false`: a locally-absent block returns null rather than blocking
      // (the own log is the source of truth, so present in-range blocks resolve).
      const v = await core.get(i, { wait: false });
      return (v as PeerLogOp | null) ?? null;
    },
    async getRaw(i: number): Promise<Uint8Array | null> {
      if (i < 0 || i >= core.length) return null;
      const raw = await (await rawSession()).get(i, { wait: false });
      return (raw as Uint8Array | null) ?? null;
    },
    async appendRawBatch(blocks: Uint8Array[]): Promise<void> {
      if (blocks.length === 0) return;
      await appendUnlessHeld(() => appendRawNow(blocks));
    },
    get length(): number {
      return core.length;
    },
    get keyHex(): string {
      return keyHex;
    },
  };

  /**
   * WI-10002855 — a second session on the SAME writable core with `binary` encoding.
   * Hypercore applies the session's valueEncoding on both read and append
   * (hypercore 11: `get` resolves `opts.valueEncoding || this.valueEncoding`, `append`
   * encodes each block with `this.valueEncoding`), so this session moves the exact
   * bytes the json session reads and writes, with no decode on the event loop. Opened
   * lazily, because only the snapshot producer ever needs it.
   */
  function rawSession(): Promise<CoreLike> {
    rawSessionPromise ??= (async () => {
      const raw = (store as unknown as { get(o: Record<string, unknown>): CoreLike }).get({
        name,
        valueEncoding: 'binary',
      });
      await raw.ready();
      return raw;
    })();
    return rawSessionPromise;
  }
}

/**
 * Open THE own log — the single-writer peer log this machine appends to.
 *
 * Thin alias over `openNamedLog` pinning the canonical `'peer-log'` name, so the
 * name lives in exactly one place and a caller cannot reach the own log by spelling
 * the string themselves.
 */
export async function openOwnLog(
  store: Corestore,
  forkGuard?: { workspaceId: string; harnessSlug: string },
): Promise<OwnLog> {
  return openNamedLog(store, 'peer-log', forkGuard);
}

/**
 * Open a READ-ONLY replica handle to another peer's log, addressed by its
 * hypercore key hex. The returned core is non-writable; `update()` /
 * `get(i, { wait: true })` block on the (Stage-4-wired) replication stream.
 */
export async function openRemoteLog(store: Corestore, keyHex: string): Promise<RemoteLog> {
  // WI-5673: open this remote log in exactly ONE Corestore per machine. Sibling
  // harnesses in the same Hive admit the SAME peer-log keys but hold separate
  // per-harness stores, and a Protomux carries at most one hypercore/alpha
  // channel per discovery key (hypercore replicator `_makePeer` bails on
  // `protomux.opened(...)`; `createChannel` is `unique` by default) — so two
  // local replicas of one key over the shared peer socket means one replicates
  // and the other sits at peersCount 0 forever, which then escalates into a
  // forced topic rejoin that tears down the socket for the healthy co-tenants
  // too. Sharing the core keeps ONE channel and feeds every sibling. Each caller
  // still gets its own Corestore SESSION here, so close()/refcount semantics are
  // unchanged; an unregistered store (test fake) resolves to itself. See
  // remote-core-host.ts.
  const host = resolveRemoteCoreHost(store, keyHex);
  const core = getCore(host, { key: Buffer.from(keyHex, 'hex') });
  await core.ready();
  // WI-10003481: a session on a sibling-hosted core must still replicate over
  // THIS store's connections — corestore attaches a core only to its host's streams.
  attachBorrowedCore(store, host, core);

  return {
    async get(i: number): Promise<PeerLogOp | null> {
      // Out-of-(known-)range → null: guard before the awaited get so a negative
      // or past-the-end index returns null instead of throwing/blocking. For an
      // in-range index `get(i, { wait: true })` blocks until the block downloads
      // from the peer, then returns the decoded op.
      if (i < 0 || i >= core.length) return null;
      const v = await core.get(i, { wait: true });
      return (v as PeerLogOp | null) ?? null;
    },
    getCancellable(i: number): CancellableRead {
      if (i < 0 || i >= core.length) return { op: Promise.resolve(null), cancel() {} };
      // Hypercore files the block request in `requests`; `destroyRequests` rejects it,
      // detaches it (the peer is told to stop when no other reader shares the block),
      // and marks the array dead so a request `get` has not filed yet is refused too.
      // Another reader of the same block keeps its own request.
      const requests: unknown[] = [];
      const destroy = (core.constructor as unknown as { destroyRequests?(requests: unknown[], err?: unknown): void })
        .destroyRequests;
      let cancelled = false;
      return {
        op: core.get(i, { wait: true, activeRequests: requests }).then((v) => (v as PeerLogOp | null) ?? null),
        cancel() {
          if (cancelled || typeof destroy !== 'function') return;
          cancelled = true;
          destroy.call(core.constructor, requests);
        },
      };
    },
    async update(): Promise<void> {
      await core.update({ wait: true });
    },
    prefetch(start: number, end: number): PrefetchRange | undefined {
      if (typeof core.download !== 'function') return undefined;
      if (end <= start || start < 0) return undefined;
      try {
        // Fire-and-forget: the range request rides the replication stream in
        // the background; `done()` is observed only to swallow rejection
        // (peer gone mid-range is normal churn, not an error).
        const range = core.download({ start, end });
        void range.done().catch(() => {});
        // P-533: Hypercore's `destroy()` detaches the range from the replicator, so its
        // blocks not yet requested are never fetched. Blocks already in flight still land.
        return {
          cancel() {
            try {
              range.destroy?.();
            } catch {
              // best-effort: the range then simply runs to completion
            }
          },
        };
      } catch {
        // A failed request degrades to per-op sequential fetch — still correct.
        return undefined;
      }
    },
    async has(i: number): Promise<boolean> {
      return typeof core.has === 'function' ? Boolean(await core.has(i)) : false;
    },
    get contiguousLength(): number {
      return core.contiguousLength ?? 0;
    },
    get length(): number {
      return core.length;
    },
    get keyHex(): string {
      return keyHex;
    },
    peersCount(): number | undefined {
      return Array.isArray(core.peers) ? core.peers.length : undefined;
    },
    // WI-1856 (G9): release this session's Hypercore replicator/file-handle
    // state. Best-effort from the caller's side (revoke() swallows a throw
    // here) — `core.close()` itself is idempotent on a real Hypercore.
    async close(): Promise<void> {
      await core.close?.();
    },
  };
}
