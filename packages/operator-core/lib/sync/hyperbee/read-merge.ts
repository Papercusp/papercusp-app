/**
 * read-merge.ts — LWW read-merge over admitted per-peer logs (Model B, Stage 2).
 *
 * Stage 1 (`peer-log.ts`) gives each peer a single-writer append-only log of
 * `PeerLogOp`s. This stage reads ALL admitted logs, resolves same-key conflicts
 * last-writer-wins ACROSS authors, and materializes the winners through the
 * EXISTING projection layer (`applyHyperbeeOpToPg`). It reuses, and does not
 * reinvent:
 *
 *   - `lwwPick(a, b)` from `./projection` — picks the op to keep (later `ts`
 *     wins; `del` beats `put` on a `ts` tie).
 *   - `applyHyperbeeOpToPg(op)` from `./projection` — dispatches a put/del op to
 *     the registered per-table writer; returns true iff applied. Its clobber-
 *     event hook (`observeMergedOp`) fires only when the op carries a
 *     `writerPubkey`, so we thread `author_pubkey` through as `writerPubkey`.
 *
 * Single responsibility: read → map → LWW-fold → apply → count. It does NOT
 * refresh remote logs — the caller (Stage 4's boot driver) calls `update()`
 * before passing logs in; we read `[0, min(length, cap))` as presented.
 *
 * Stage 6 adds a per-LOG op-count cap (`maxOpsPerAuthor`) so one noisy author
 * can't make a merge pass ingest unbounded ops (the DoS Phase-4 reshape: a
 * peer that bloats its own log only delays its own tail, not the whole merge).
 */

import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';
import type postgres from 'postgres';
import {
  applyHyperbeeOpToPg,
  lwwPick,
  runInProjectionBatch,
  runOutsideProjectionBatch,
  type ProjectionBatchSession,
  type ProjectionGroupWriter,
  type StoredOrderPrefetch,
} from './projection';
import { encodeHlc } from '@papercusp/locks-core';
import { createConcurrencyGate, type ConcurrencyGate } from '@papercusp/sync';
import { pinModuleState } from '@papercusp/module-singleton';
import { logIfStageStalls } from './stage-stall-log';
import { runWithDeferralSource, type DeferralSource } from './deferral-source';
import {
  isSnapshotOp,
  SNAPSHOT_COMPACT_EVERY_OPS,
  SNAPSHOT_TOMBSTONE_HORIZON_MS,
  type SnapshotPayload,
  type SnapshotRow,
} from './log-snapshot';

/**
 * Structural view of a log the merge can read. Stage 1's `RemoteLog` / `OwnLog`
 * both satisfy this (they expose `keyHex`, `length`, and a decoding `get(i)`).
 * The merge needs no `update()` here — see the module doc-comment.
 */
export interface AdmittedLog {
  readonly keyHex: string;
  readonly length: number;
  get(i: number): Promise<PeerLogOp | null>;
  /**
   * WI-1856 (G9): release the underlying Hypercore session (present on a
   * `RemoteLog` from `openRemoteLog`; the own writable log is never revoked so
   * it need not implement this). Optional + feature-detected by callers (e.g.
   * `boot.ts`'s `revoke()`) so hand-rolled `AdmittedLog`/`RemoteLog` test
   * fixtures elsewhere in the codebase don't need a stub.
   */
  close?(): Promise<void>;
}

/** Default per-op read timeout. A connected-but-withholding peer's
 *  `get(i, {wait:true})` can block forever; bounding it keeps the merge lock
 *  from being held hostage (the op is skipped + retried on the next pass). */
export const DEFAULT_GET_TIMEOUT_MS = 5000;

/** Default per-LOG op-count cap. A single admitted log contributes at most this
 *  many ops to a merge pass; the rest are skipped this pass (and `onCapped`
 *  fires). Bounds the DoS where a noisy peer bloats its own log to force the
 *  merge to ingest unbounded ops. Override (or disable with `<= 0`) via
 *  `MergeOpts.maxOpsPerAuthor`. */
export const DEFAULT_MAX_OPS_PER_AUTHOR = 50_000;

/** Yield a macrotask to the event loop every this-many merge-loop iterations.
 *  Local-corestore `get`s resolve via MICROTASK, so without an explicit yield
 *  the incremental merge's inner loop runs its whole pass budget (up to 50k
 *  awaits per log) as one event-loop turn — at the 1Hz merge poll that
 *  monopolized the loop and burned ~1.5 cores continuously (EI-81). */
export const MERGE_YIELD_EVERY_OPS = 1000;

/** WI-2344: a SECOND, TIME-based bound alongside `MERGE_YIELD_EVERY_OPS`. The
 *  op-count bound alone assumes ops are cheap-and-uniform; on a from-0 replay
 *  against a loaded/slow PG (or many wide snapshot-expansion rows per op —
 *  see `isSnapshotOp` below), a single 1000-op chunk between yields can itself
 *  run long enough to trip the bg-host watchdog's 240s "genuinely frozen"
 *  threshold (observed 2026-07-04, load 34/128 — not box-saturation, just a
 *  long uninterrupted chunk). Checked every iteration alongside the op
 *  counter so whichever bound fires first wins; comfortably under the 240s
 *  watchdog so a slow chunk still yields well before that budget. */
export const MERGE_YIELD_MAX_MS = 250;

/** WI-2105 — persist the merge cursor to PG at most every this-many decoded ops
 *  DURING a pass (plus once per log at completion). Coarser than the event-loop
 *  yield cadence so a big fold does ~O(ops/5000) small upserts, not one per
 *  yield; fine-grained enough that a watchdog restart loses at most this many
 *  ops of re-fold (all idempotent). Intra-pass because a single large-backlog
 *  pass can outlast the 240s bg-host watchdog and never return — persisting only
 *  after the pass returned would capture nothing (the WI-2105 REV restart loop). */
export const MERGE_PERSIST_EVERY_OPS = 5000;

/** WI-10002474: minimum spacing between cursor-persist-failure warnings. The
 *  persist stays best-effort (never aborts a pass), but a store that rejects
 *  EVERY save must be visible: the in-memory position keeps advancing while
 *  the durable one is frozen, and a restart silently re-folds the gap. */
export const CURSOR_PERSIST_WARN_INTERVAL_MS = 60_000;
let lastCursorPersistWarnAt = Number.NEGATIVE_INFINITY;
function warnCursorPersistFailed(err: unknown): void {
  const now = Date.now();
  if (now - lastCursorPersistWarnAt < CURSOR_PERSIST_WARN_INTERVAL_MS) return;
  lastCursorPersistWarnAt = now;
  console.warn(
    '[read-merge] merge cursor persist FAILED — durable position is NOT advancing (a restart re-folds from the last saved one):',
    err instanceof Error ? err.message : String(err),
  );
}
/** Test seam: reset the persist-failure warning throttle. */
export function resetCursorPersistWarnThrottleForTests(): void {
  lastCursorPersistWarnAt = Number.NEGATIVE_INFINITY;
}

/** WI-4020: default cap on `MergeCursor.winners`' entry count. `winners` is
 *  durable-for-the-process (unlike the transient per-call map in
 *  `mergeAdmittedLogs`) and grows by one entry per distinct (table, hbKey)
 *  ever merged, with no eviction — a long-lived host merging a
 *  perpetually-growing federation accumulates one entry per live row FOREVER.
 *  Bounding it is safe because `winners` is a FAST-PATH cache layered on an
 *  independently-authoritative floor, not the sole correctness mechanism: see
 *  `mergeAdmittedLogsIncremental`'s "POST-CURSOR-RESET DOUBLE-APPLY SAFETY"
 *  doc comment — every PG projection writer re-guards with its own
 *  `fed_ts`/`fed_hlc` `ON CONFLICT` check, so a `winners` MISS (evicted OR
 *  never-seen) only ever costs a harmless redundant `apply()` attempt (PG
 *  accepts it if legitimately newer, no-ops if stale) — never an incorrect
 *  write. `<= 0` disables the bound (today's unbounded behavior). Override
 *  via `IncrementalMergeOpts.maxWinnersEntries`. */
export const DEFAULT_MAX_WINNERS_ENTRIES = 500_000;

/**
 * P-007 run #7: one live eviction iterator per `winners` map (see `recordWinner`). A
 * fresh `keys().next()` walks every deleted slot at the front of V8's ordered hash
 * table, and at the 500k cap that table holds up to about half a million of them
 * between rehashes. Measured on node 25: 50 us per eviction, against about 1 us when
 * one iterator is reused (.papercusp/scratch/p007/lru-evict-bench.mjs). A snapshot set
 * past the cap evicts once per row. A live Map iterator visits entries in insertion
 * order, skips deleted ones and sees later appends, and every entry it has passed was
 * deleted, so its next key is always the map's oldest. Keyed by the Map, so a cursor
 * whose map is replaced starts a fresh iterator.
 */
const winnersEvictors = new WeakMap<Map<string, WinnerMeta>, Iterator<string>>();

/** `await` point that defers to the macrotask queue (setImmediate), letting
 *  timers/IO/HTTP run between merge chunks. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export interface MergeOpts {
  /** Override the apply sink (defaults to `applyHyperbeeOpToPg`). For tests. */
  applyImpl?: (op: OpEnvelope) => Promise<boolean>;
  /**
   * Per-op `log.get(i)` timeout (ms). A `get` that doesn't resolve within this
   * window is treated as "block not available yet" → the op is skipped (NOT an
   * error). Bounds a withholding remote peer so it can't hold the merge lock.
   * Defaults to `DEFAULT_GET_TIMEOUT_MS`. Pass `0` / a non-positive value to
   * disable the timeout (e.g. tests over instant fakes).
   */
  getTimeoutMs?: number;
  /**
   * Per-LOG op-count cap (Stage 6). Each admitted log contributes at most this
   * many ops to a single merge pass; if `log.length` exceeds the cap, only the
   * first `cap` ops are read/applied this pass and `onCapped` fires ONCE for
   * that log. Bounds the DoS where one noisy author bloats its own log to make
   * the merge ingest unbounded ops. Defaults to `DEFAULT_MAX_OPS_PER_AUTHOR`.
   * Pass `0` / a non-positive value to disable the cap (read all ops).
   */
  maxOpsPerAuthor?: number;
  /**
   * Called once per log whose `length` exceeded `maxOpsPerAuthor` (so the merge
   * read only the first `cap` of `totalLength` ops). Best-effort observability
   * hook (e.g. record a `peer_capped` boot-history event); must not throw —
   * a failing callback is swallowed so it can't abort the merge pass.
   */
  onCapped?: (keyHex: string, totalLength: number, cap: number) => void;
}

/**
 * Race a `log.get(i)` against a timeout. Resolves to the op on success, or
 * `null` when the read rejects OR doesn't resolve in time (both are "skip this
 * op"). Never rejects — a misbehaving peer's read can't abort the merge pass.
 */
async function readOpBounded(
  log: AdmittedLog,
  i: number,
  timeoutMs: number,
): Promise<PeerLogOp | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const get = Promise.resolve(log.get(i));
    if (timeoutMs <= 0) {
      // Timeout disabled — still guard the rejection (caller wants per-op
      // isolation regardless of the timeout).
      return await get;
    }
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      // Don't keep the event loop alive on the timeout alone.
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
    });
    return await Promise.race([get, timeout]);
  } catch {
    // A rejected read (peer stream closed / decode error) skips just this op.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Map a single-writer `PeerLogOp` to a projection-layer `OpEnvelope`. The
 * writer's `author_pubkey` becomes `writerPubkey` so the clobber-event hook in
 * `applyHyperbeeOpToPg` fires with the right author.
 *
 * G1 Provenance (P-002): `sourceLogKeyHex` is set to the source log's `keyHex`
 * so the apply path can determine `origin` by comparing against the own log's
 * `keyHex` — the log-source approach is authoritative + unforgeable.
 */
/**
 * P-007 (design A): the rows carried by a snapshot op (`__snapshot__`), or `[]`
 * for a malformed payload. Each row reconstitutes one key's current state.
 */
function snapshotRows(op: PeerLogOp): SnapshotRow[] {
  const payload = op.value as SnapshotPayload | undefined;
  return payload && Array.isArray(payload.rows) ? payload.rows : [];
}

/**
 * P-007 (design A): map one snapshot row to an `OpEnvelope` (a put), preserving
 * its original ts/hlc so it folds + LWW-compares exactly as the original write
 * did. `sourceLogKeyHex` comes from the snapshot op's source log, so origin
 * resolution is identical to a normal op from that peer.
 *
 * `writerPubkey` is the ROW's own preserved `author_pubkey` (the original content op's
 * author), NOT the snapshot op's author — it is bound into the epoch-decrypt AAD (opId),
 * so substituting the snapshot op's author makes every encrypted row decrypt-drop (the
 * seed "β" / 57-drop bug). A LEGACY author-less row (a pre-β snapshot) falls back to `''`,
 * the owner single-writer-log author convention every pre-β snapshot was compacted under —
 * NOT the snapshot op's source-log KEY, which is a hypercore key, never a content author.
 * Proven against the shipped seed: the log-key fallback decrypts 0 of its 11308 encrypted
 * snapshot rows (the 57-drop), while '' decrypts all 9937 owner-authored ones. A
 * member-authored legacy row (author ≠ '', e.g. a relayed coord-message) can't be
 * reconstructed from an author-less row — it relies on a β re-cut or the live join delta.
 */
function snapshotRowToEnvelope(
  row: SnapshotRow,
  sourceLogKeyHex: string,
): OpEnvelope {
  return {
    // EI-1688: a tombstone row reconstitutes a DELETE. Emitting a `del` env seeds the
    // merge winner with the del's ts/hlc, so a later-arriving stale lower-clock PUT
    // loses the per-op winner-gate (`!beatsStored(env, prev) → continue`) and is never
    // re-applied — the put-after-del resurrection fix, fold-level (no PG tombstone).
    type: row.deleted ? 'del' : 'put',
    table: row.table,
    hbKey: row.hbKey,
    value: row.value,
    ts: row.ts,
    schema_version: row.schema_version,
    ...(row.hlc ? { hlc: row.hlc } : {}),
    // WI-808: carry the rekey epoch from a snapshot row so the decrypt-gate can
    // resolve the key (mirrors toEnvelope; absent on plaintext / tombstone rows).
    ...(row.epoch != null ? { epoch: row.epoch } : {}),
    // β / 57-drop: the ROW's preserved original author is the AAD author the ciphertext was
    // sealed under — use it. A legacy author-less row (pre-β snapshot) falls back to `''`,
    // the owner single-writer-log convention it was compacted under — NOT the snapshot op's
    // source-log key (a hypercore key, never a content author → AAD diverges → decrypt-drop
    // = the 57-drop). `??` (not `||`) so a genuine '' row author is preserved.
    writerPubkey: row.author_pubkey ?? '',
    sourceLogKeyHex,
  };
}

function toEnvelope(op: PeerLogOp, sourceLogKeyHex: string): OpEnvelope {
  return {
    type: op.type,
    table: op.table,
    hbKey: op.hbKey,
    value: op.value,
    ts: op.ts,
    schema_version: op.schema_version,
    // P-010: carry the HLC through so `lwwPick`/`beatsStored` can order by it.
    // Before this, the envelope dropped `hlc`, so even an op that DID carry one
    // (e.g. a peer on a newer build) fell back to wall-clock `ts` at merge time.
    ...(op.hlc ? { hlc: op.hlc } : {}),
    // WI-808: carry the epoch stamp onto the OpEnvelope the apply-side decrypt-gate
    // reads. Before this, the merge dropped `epoch` (exactly as it once dropped
    // `hlc`), so an encrypted content op arrived at the gate with `epoch == null` →
    // treated as plaintext → ciphertext passed to scopedApply → silent drop on the
    // joiner (zero decrypt-gate trace). Absent on plaintext ops (today's path).
    ...(op.epoch != null ? { epoch: op.epoch } : {}),
    writerPubkey: op.author_pubkey,
    sourceLogKeyHex,
  };
}

/**
 * Read every admitted log, LWW-resolve same-key conflicts across authors, and
 * apply each winner via the projection layer.
 *
 * @returns the count of ops that actually applied (the apply sink returned true).
 */
export async function mergeAdmittedLogs(logs: AdmittedLog[], opts?: MergeOpts): Promise<number> {
  const apply = opts?.applyImpl ?? applyHyperbeeOpToPg;
  const getTimeoutMs = opts?.getTimeoutMs ?? DEFAULT_GET_TIMEOUT_MS;
  const maxOpsPerAuthor = opts?.maxOpsPerAuthor ?? DEFAULT_MAX_OPS_PER_AUTHOR;
  const onCapped = opts?.onCapped;

  // 1+2. Read each log's ops (skip nulls) and map to OpEnvelope.
  // 3. Fold into per-(table, hbKey) LWW winners as we go.
  //
  // Each `get(i)` is BOUNDED + per-op isolated (readOpBounded): a read that
  // rejects OR doesn't resolve within `getTimeoutMs` is skipped (treated as
  // "block not available yet"), NOT allowed to bubble and abort the whole
  // pass. This keeps one connected-but-withholding peer from starving the own
  // log + other peers while the caller holds the merge lock — the skipped op
  // is retried on the next pass once the block downloads.
  //
  // Per-LOG cap (Stage 6): a log contributes at most `maxOpsPerAuthor` ops to
  // this pass — we iterate `i` over `[0, min(length, cap))`. If `length`
  // exceeds the cap, `onCapped` fires once for that log. Reading the FIRST
  // `cap` ops is the simple, deterministic policy: a more sophisticated policy
  // could prefer recent ops (read the tail), but first-N suffices for the
  // cap's purpose — bounding per-pass ingest from any single author so a noisy
  // peer can't make the merge unbounded. A `<= 0` cap disables the bound.
  const winners = new Map<string, OpEnvelope>();
  let opsSinceYield = 0;
  // WI-2344: wall-clock companion to the op counter, same rationale as the
  // incremental merge below (MERGE_YIELD_MAX_MS).
  let lastYieldAt = Date.now();
  for (const log of logs) {
    const cap = maxOpsPerAuthor;
    const capped = cap > 0 && log.length > cap;
    if (capped) {
      try {
        onCapped?.(log.keyHex, log.length, cap);
      } catch {
        // Observability hook must never abort the merge pass.
      }
    }
    const upper = capped ? cap : log.length;
    for (let i = 0; i < upper; i++) {
      // EI-81: local-corestore gets resolve via microtask — yield a macrotask
      // every ~1k iterations so a full re-fold can't monopolize the event loop.
      // WI-2344: OR every MERGE_YIELD_MAX_MS of wall-clock, whichever first.
      if (++opsSinceYield >= MERGE_YIELD_EVERY_OPS || Date.now() - lastYieldAt >= MERGE_YIELD_MAX_MS) {
        opsSinceYield = 0;
        lastYieldAt = Date.now();
        await yieldToEventLoop();
      }
      const op = await readOpBounded(log, i, getTimeoutMs);
      if (!op) continue;
      // P-007 (design A): a snapshot op reconstitutes many keys at once — expand
      // its rows and fold each (so folding from a snapshot index lands the same
      // winners a full fold from 0 would). Non-snapshot-aware callers never reach
      // here because snapshot ops only exist once the flag-gated producer ran.
      if (isSnapshotOp(op)) {
        for (const row of snapshotRows(op)) {
          const env = snapshotRowToEnvelope(row, log.keyHex);
          const groupKey = `${env.table}::${env.hbKey}`;
          const prev = winners.get(groupKey);
          winners.set(groupKey, prev ? lwwPick(prev, env) : env);
        }
        continue;
      }
      const env = toEnvelope(op, log.keyHex);
      const groupKey = `${env.table}::${env.hbKey}`;
      const prev = winners.get(groupKey);
      winners.set(groupKey, prev ? lwwPick(prev, env) : env);
    }
  }

  // 4+5. Apply each winning op; count those that applied.
  let applied = 0;
  for (const env of winners.values()) {
    if (await apply(env)) applied++;
  }
  return applied;
}

/* ------------------------------------------------------------------ *
 * Incremental merge (the EI-79 residual — p2p-performance-suite P-013)
 * ------------------------------------------------------------------ */

/**
 * Compact per-key winner record. Holds ONLY what the LWW comparison needs —
 * not the op value — so the standing fold state costs ~tens of bytes per live
 * key instead of retaining every winning payload.
 */
interface WinnerMeta {
  ts: number;
  hlc?: string;
  type: 'put' | 'del';
  src: string; // sourceLogKeyHex ('' when absent) — lwwPick's total-order tiebreak
  /**
   * p2p-join-catchup-speed-2026-09-23 P-002: this entry was SEEDED from the PG row's
   * stored order (`fed_hlc`/`fed_ts`), not recorded from an applied op. It carries no
   * real type/source, so it only ever skips an op whose order key is STRICTLY lower
   * (see `isStaleAgainst`); every tie still goes to the projection's own PG guard.
   */
  seeded?: true;
}

/**
 * The ONE place the incremental fold decides an op can be skipped without an apply.
 *
 * For a winner recorded from an applied op this is the long-standing
 * `!beatsStored` rule. For a SEEDED winner (the stored PG order, P-002) it is
 * deliberately narrower: skip only when the op's order key is strictly lower than
 * the stored one, which is exactly when `fed_apply_wins` (put) and the delete's
 * `fed_order_key >=` guard both reject it. Two exceptions always apply:
 *  - equal keys go to PG (the SQL tie-break uses writer and content digest, which a
 *    seed does not carry);
 *  - a delete carrying neither `hlc` nor `ts` is UNGUARDED in SQL (it deletes
 *    regardless of order), so it is never skipped against a seed.
 * The order key mirrors `fed_order_key`: the hlc when present (an empty string
 * included), else the 15-digit ts with a zero counter.
 */
function isStaleAgainst(env: OpEnvelope, prev: WinnerMeta): boolean {
  if (!prev.seeded) return !beatsStored(env, prev);
  if (env.type === 'del' && env.hlc == null && env.ts == null) return false;
  const ke = env.hlc ?? encodeHlc({ ms: env.ts ?? 0, count: 0 });
  const kp = prev.hlc ?? encodeHlc({ ms: prev.ts, count: 0 });
  return ke < kp;
}

/**
 * Default size of the look-ahead window read for the stored-order prefetch (P-002) and the
 * superseded-put skip (P-528). P-528 sees only its own window, so a larger one skips more:
 * on the P-007 run #7 tail (61,240 ops) it skips 26.7% of ops at 512, 31.9% at 2048 and
 * 33.9% at 4096 (.papercusp/scratch/p007/p528-skip-census.mts, tower read-only).
 */
export const STORED_ORDER_PREFETCH_WINDOW = 2048;
/** Per-window budget for the look-ahead reads; an op not read in time is read normally. */
export const STORED_ORDER_PEEK_TIMEOUT_MS = 1000;
/**
 * WI-10005291: the most look-ahead reads in flight at once. The window is 2048 ops, and a
 * window can hold a whole snapshot set (~1,040 chunks of ~4 MiB). Reading all of it at once
 * read ~4 GB per skipped set on the tower's own log and spiked bg-host RSS by GBs (bpftrace
 * pread census, 2026-10-02). Bounded, a skipped set costs at most this many chunk reads.
 */
export const STORED_ORDER_PEEK_CONCURRENCY = 32;

/** F4: processing an entry is distinct from materializing it. Boolean sinks
 * retain their existing handled/changed contract; typed sinks can defer or reject. */
export type MergeApplyOutcome =
  | { kind: 'applied'; changed: boolean }
  | { kind: 'rejected' | 'dependency-waiting' | 'retryable'; reason: string; errorCode?: string };

interface PendingMergeApply {
  /** Resolves after FIFO admission, immediately before the physical write starts. */
  started: Promise<void>;
  /** True once {@link started} has resolved (the write holds, or held, an admission slot). */
  admitted: boolean;
  /**
   * The physical write's outcome. Its admission slot is held until it settles or, when it
   * outlives the apply timeout, until the slot lease expires (WI-10003427: see
   * {@link holdMergeApplySlot}).
   */
  result: Promise<boolean | MergeApplyOutcome>;
}

/** The FIRST unresolved entry in a log. Its bytes and all later entries remain
 * in Hypercore behind the held durable cursor; no payload is copied into PG. */
export interface MergeApplyFailure {
  position: number;
  groupKey: string;
  kind: 'rejected' | 'dependency-waiting' | 'retryable';
  reason: string;
  errorCode?: string;
  attempts: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** Result of one physical `log.get(position)` attempt. */
type ReadAttemptResult =
  | { kind: 'op'; op: PeerLogOp | null }
  | { kind: 'read-error'; err: unknown };

/**
 * Durable-for-the-process fold state of an incremental merge: per-log read
 * cursors + the materialized per-key winner metadata. Created once per booted
 * harness (`createMergeCursor`) and threaded through every
 * `mergeAdmittedLogsIncremental` pass. NOT persisted — a process restart
 * rebuilds it with one full pass (the same cost as today's boot backfill).
 */
export interface MergeCursor {
  /** keyHex → next log index to read. */
  positions: Map<string, number>;
  /** `${table}::${hbKey}` → current winner meta. */
  winners: Map<string, WinnerMeta>;
  /**
   * WI-255: per-op CONSECUTIVE apply-throw counter (op-identity → count). The
   * winner is now recorded only AFTER a non-throwing apply, so a TRANSIENT apply
   * throw (a PG blip/deadlock/timeout mid-merge) leaves the op un-deduped and it
   * is retried next pass instead of being skipped forever (the data-loss bug).
   * This counter rate-limits backlog diagnostics; it NEVER makes a failure a
   * successful winner. Optional for back-compat with cursors
   * built as a bare `{ positions, winners }` (lazily initialized at the apply site).
   */
  applyThrows?: Map<string, number>;
  /**
   * WI-10003506: per-op backoff for a STRUCTURAL deferral (op-identity → the last real
   * outcome and when to re-attempt it). A held `dependency-waiting` op is re-read on every
   * merge pass; without this, each pass re-ran its write against PG. Measured on the P-203
   * VM: 36 held ops about 0.7 passes/s = 26 FK failures/s, each logged by PG with the full
   * statement (about 4.4 MB/min of log, disk 98% full). While the window is open the apply
   * site returns the stored outcome without touching PG, so the cursor hold, the
   * applyFailures record and the self-heal all behave exactly as for a real failure.
   * Dropped on apply and on rewind. In memory only.
   */
  applyDeferrals?: Map<string, { retryAt: number; outcome: MergeApplyOutcome }>;
  /** First unresolved materialization per log, persisted beside its position. */
  applyFailures?: Map<string, MergeApplyFailure>;
  /** Reuse a timed-out write while it is still in flight, rather than starting
   * another unbounded PG operation on every merge tick. */
  pendingApplies?: Map<string, PendingMergeApply>;
  /**
   * P-002 step 2 (batched fold commits): per log, the end (exclusive) of the
   * window a LOST batch transaction covered. Ops before it replay outside the
   * batch (autocommit, the serial path). An op that loses every batch it joins (a
   * projection that swallows a statement error, an apply that always times out)
   * then costs one serial window instead of rewinding the fold forever. In memory
   * only; dropped once the log's cursor reaches it.
   */
  batchSerialUntil?: Map<string, number>;
  /**
   * P-527: per log, the end (exclusive) of a snapshot chunk whose parallel lanes ended
   * on a retryable outcome. Its retry applies the chunk on the serial path, so a
   * failure the lanes caused (a lock wait that timed out, a deadlock) cannot repeat on
   * every pass. In memory only; dropped once the log's cursor reaches it.
   */
  laneSerialUntil?: Map<string, number>;
  /**
   * WI-2003: per-position CONSECUTIVE read-throw counter (`${log.keyHex}:${pos}`
   * → count), the READ-side mirror of `applyThrows`. `readOpBoundedDetailed`
   * distinguishes a genuinely TRANSIENT timeout (peer withholding/offline — kept
   * as unbounded retry-via-break, unchanged) from a REJECTED read (e.g. a
   * hypercore/signature verify failure during identity divergence) — the latter
   * bounds via this counter and dead-letters (advances past the position) after
   * `MAX_READ_THROWS`, instead of `break`ing forever and wedging every
   * SUBSEQUENT op in that peer's strictly-sequential single-writer log (the
   * "silent REV fed_event outage class", WI-2003). Optional for back-compat.
   */
  readThrows?: Map<string, number>;
  /**
   * WI-2141796: per-position CONSECUTIVE read-STALL counter (`${log.keyHex}:${pos}`
   * → count) for the `unavailable` (transient-timeout) branch. That branch is
   * deliberately an UNBOUNDED retry-via-break and this counter does NOT change
   * that — it exists purely so the retry is VISIBLE.
   *
   * The measured failure it makes observable (2026-09-02, tower): the papercusp
   * cursor on log `cb54460d98d8` sat at position 12048 for hours while the writer
   * ran on to 25k+, so every inbound coordination row behind it was unreachable.
   * NOTHING reported it. The `unavailable` break logs nothing, no apply is
   * attempted (so no timeout/quarantine/constraint error fires), the peer stays
   * connected so replication-liveness reads `live`/`healthy`, and the cursor ROW's
   * `updated_at` keeps moving because positions are persisted as ONE map — a
   * sibling log advancing re-stamps the frozen one. A moving `updated_at` beside a
   * frozen `position` reads exactly like a healthy merge, which is what made this
   * cost hours to find: every available signal was a per-op or per-connection
   * bound, and the failure lives in whether a SPECIFIC POSITION ever advances.
   */
  readStalls?: Map<string, number>;
  /**
   * P-203 / D-018: `${log.keyHex}:${position}` → one late result from timed-out
   * reads. Attempts for the same immutable log position are interchangeable;
   * retain a served block in preference to an error, rather than accumulating
   * duplicate results. A never-settling attempt still permits the existing retry
   * semantics on the next pass.
   */
  lateReadResults?: Map<string, ReadAttemptResult>;
  /**
   * p2p-join-catchup-speed P-004: per-log memo of the snapshot scan (keyHex →
   * what `[?, scannedTo)` held). A far-behind cursor looks for a set ahead of it on
   * every pass while it catches up. Without the memo each pass would re-read the
   * whole remaining backlog. With it, a pass reads only the ops appended since the
   * last scan. Lives on the cursor, so every reset (log removal, truncation, a
   * rekey re-fold) drops it together with the positions it was measured against.
   * The P-522 eviction re-fold rewinds in place (`rewindMergeCursor`) and keeps it.
   */
  snapshotScans?: Map<string, SnapshotScanMemo>;
  /**
   * p2p-join-catchup-speed P-522 (WI-10002899): FRESH logs held out of the fold
   * because their snapshot-seed scan has not concluded yet (keyHex → when the
   * first inconclusive scan held it, and when the hold last logged its progress).
   * The fold skips a held log that has no position, and `seedCursorFromSnapshots`
   * releases it once the scan concludes or `SNAPSHOT_SEED_DEFER_MAX_MS` has passed.
   * See `holdFreshSeed`.
   */
  snapshotSeedPending?: Map<string, { sinceMs: number; progressLoggedAtMs: number }>;
  /**
   * P-004: logs whose DURABLE apply-failure state is unknown. The PG cursor load
   * failed and the log was pinned at 0 (the F4 rule: an unreadable durable cursor
   * may hold an unapplied entry). Such a log is never snapshot-skipped, fresh or
   * far-behind, for the life of this cursor.
   */
  snapshotSkipUnsafe?: Set<string>;
  /**
   * p2p-join-catchup-speed P-008 (endgame D-060): keyHex → the highest
   * `coversUpTo` whose snapshot set this cursor OWES. A snapshot chunk is applied
   * row by row only when its `coversUpTo` is at or below this watermark: the set
   * this cursor was seeded from (fresh seed or the P-004 far-behind jump), or a set
   * applied to cover a hole (below). Absent means -1. Any other skip-eligible set
   * is redundant for this cursor, because it has already folded every op the set
   * summarizes, so it is skipped without an apply (see `snapshotSetDisposition`).
   *
   * Monotone: raised, never cleared. Later sets sit at later positions with larger
   * `coversUpTo`, so a stale watermark can never make one of them apply.
   */
  snapshotApplyThrough?: Map<string, number>;
  /**
   * P-008: keyHex → the highest log position this cursor moved PAST WITHOUT
   * applying the op there: a null read (the D-024 version gate dropping an
   * unknown-newer op, an undecodable op, or a WI-2003 dead-letter). Such a cursor
   * has NOT folded the whole prefix, so the next snapshot set is not redundant for
   * it. That set re-delivers the rows, which is the rolling-upgrade recovery
   * `schema-skew-snapshot-recovery.test.ts` pins. While a hole is recorded, the next
   * skip-eligible set is applied, and applying a set at `coversUpTo` c resolves
   * every hole below c. Absent means no hole.
   */
  snapshotHole?: Map<string, number>;
  /**
   * P-524 (p2p-join-catchup-speed-2026-09-23 D-009 (b)): what the key seeks on this cursor
   * have already read, per `keySeekMemoKey(log, miss)`. See {@link KeySeekMemo}. In memory
   * only, so a new cursor seeks again.
   */
  keySeeks?: Map<string, KeySeekMemo>;
  /**
   * P-528 (p2p-join-catchup-speed-2026-09-23 D-018 #3): per log, groups whose superseded
   * puts must replay serially (keyHex → `${table}::${hbKey}` → exclusive position). A put
   * the fold skipped because a later put superseded it is recorded here when that
   * superseder did not apply and commit (a deferral, a rejection, a lost batch, a pass
   * that ended first). Until the cursor passes the recorded position, every op of the
   * group applies in log order, exactly as without the skip. In memory only: a restart
   * re-reads from the persisted position, which never passes an unresolved skip.
   */
  supersededNoSkip?: Map<string, Map<string, number>>;
}

/**
 * P-524: `[bottom, top)` of one log was read in full by earlier key seeks without finding
 * this device's key row for one (pot, epoch); a later seek reads only what lies outside it.
 * `found` means a seek applied the row (or found a newer version already folded), so no
 * further seek runs for that key on this cursor.
 */
export interface KeySeekMemo {
  found: boolean;
  bottom: number;
  top: number;
}

/**
 * P-008: the durable snapshot bookkeeping of one log, persisted beside its
 * position (`substrate_merge_cursor.snapshot_apply_through` / `snapshot_hole`).
 * `applyThrough` -1 means no seeded set is owed; `hole` null means none recorded.
 */
export interface SnapshotApplyMark {
  applyThrough: number;
  hole: number | null;
}

/** P-008: no seeded set owed. */
export const NO_SNAPSHOT_APPLY = -1;

/** P-008: how often an in-progress snapshot-set APPLY logs its progress. */
export const SNAPSHOT_SET_PROGRESS_LOG_MS = 60_000;

/**
 * P-008: record that this cursor owes the snapshot set at `coversUpTo` (it was
 * seeded or jumped there, or applies it to cover a hole). Raises the watermark and
 * resolves every hole below `coversUpTo`, because the set re-delivers this log's
 * winning op for every key below it.
 */
export function markSnapshotSeeded(cursor: MergeCursor, keyHex: string, coversUpTo: number): void {
  const through = (cursor.snapshotApplyThrough ??= new Map());
  through.set(keyHex, Math.max(through.get(keyHex) ?? NO_SNAPSHOT_APPLY, coversUpTo));
  const hole = cursor.snapshotHole?.get(keyHex);
  if (hole !== undefined && hole < coversUpTo) cursor.snapshotHole?.delete(keyHex);
}

/** P-008: the cursor moved past `position` without applying the op there. */
export function recordSnapshotHole(cursor: MergeCursor, keyHex: string, position: number): void {
  const holes = (cursor.snapshotHole ??= new Map());
  holes.set(keyHex, Math.max(holes.get(keyHex) ?? position, position));
}

/** P-008: this cursor's durable snapshot bookkeeping for one log. */
export function snapshotApplyMarkOf(cursor: MergeCursor, keyHex: string): SnapshotApplyMark {
  return {
    applyThrough: cursor.snapshotApplyThrough?.get(keyHex) ?? NO_SNAPSHOT_APPLY,
    hole: cursor.snapshotHole?.get(keyHex) ?? null,
  };
}

/** P-008: one mark per POSITIONED log, the shape `MergeCursorStore.save` persists. */
export function snapshotApplyMarks(cursor: MergeCursor): Map<string, SnapshotApplyMark> {
  const out = new Map<string, SnapshotApplyMark>();
  for (const keyHex of cursor.positions.keys()) out.set(keyHex, snapshotApplyMarkOf(cursor, keyHex));
  return out;
}

/**
 * P-008: the mark to persist when two cursors fold the same log and the durable
 * position is the LOWER of theirs (the WI-3985 memory replay). Both halves take the
 * max, which can only cause extra applies, never a missed one. The resumed reader
 * re-reads from the lower position, so it must still apply the set the other
 * cursor jumped to (watermark). It must also still cover any hole either cursor
 * recorded below its own position.
 */
export function combineSnapshotApplyMarks(a: SnapshotApplyMark, b: SnapshotApplyMark): SnapshotApplyMark {
  return {
    applyThrough: Math.max(a.applyThrough, b.applyThrough),
    hole: a.hole === null ? b.hole : b.hole === null ? a.hole : Math.max(a.hole, b.hole),
  };
}

/**
 * P-008: load the durable bookkeeping of one log onto a cursor seeded at
 * `position`. `mark` undefined means the row carries no valid stamp. The row was
 * written by an older build, by a rolled-back build, or by a manual position edit
 * that did not restamp it. An older build may have moved past gate-dropped ops,
 * so an unstamped cursor above 0 owes the next set it crosses (a hole at 0). That
 * is today's behaviour for exactly one set, then the skip takes over.
 */
function loadSnapshotApplyMark(
  cursor: MergeCursor,
  keyHex: string,
  position: number,
  mark: SnapshotApplyMark | undefined,
): void {
  if (!mark) {
    if (position > 0) recordSnapshotHole(cursor, keyHex, 0);
    return;
  }
  if (mark.applyThrough > NO_SNAPSHOT_APPLY) {
    (cursor.snapshotApplyThrough ??= new Map()).set(keyHex, mark.applyThrough);
  }
  if (mark.hole !== null) recordSnapshotHole(cursor, keyHex, mark.hole);
}

/**
 * P-008: whether a snapshot chunk at `pos` may ever be skipped. A skip is sound
 * only for a set that summarizes THIS log's own prefix `[0, coversUpTo)`, which the
 * cursor has read. Three shapes never qualify, and are always applied:
 *  - `coversUpTo` missing, non-finite, or above the chunk's own position: malformed,
 *    so the old apply path is kept.
 *  - `coversUpTo` 0: there is no prefix to be redundant with. The seed core
 *    (`produceFilteredSnapshotIntoLog`) is exactly this. It is a fresh core whose
 *    only content is a set summarizing ANOTHER log, anchored at 0.
 *  - `excludeTables` WITHOUT `ownPrefix`: a filtered set written into a separate
 *    core summarizes that other log, never this one's prefix. Unmarked legacy
 *    filtered sets land here too, since nothing says which kind they are.
 *
 * WI-10005425: a filtered set marked `ownPrefix` IS eligible. The release cut writes
 * one into the live own log (`produceLogSnapshot` with `SEED_EXCLUDED_TABLES`), and
 * it summarizes exactly the prefix a crossing cursor already folded op by op, so the
 * excluded tables are already in that cursor's state. Applying it anyway re-applied
 * every row of the set (~968k on the tower) for each cut.
 */
function isSkipEligibleSnapshot(payload: SnapshotPayload | undefined, pos: number): boolean {
  if (!payload) return false;
  const c = payload.coversUpTo;
  if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0 || c > pos) return false;
  return !payload.excludeTables?.length || payload.ownPrefix === true;
}

/**
 * P-008: apply or skip one snapshot chunk. `apply` covers the seeded set (at or
 * below the watermark), a set that is not skip-eligible, and a skip-eligible set
 * crossed while a hole is recorded. Covering a hole promotes the set to the
 * watermark, so its remaining chunks apply too. `skip` covers a set this cursor
 * already folded op by op.
 */
function snapshotSetDisposition(
  cursor: MergeCursor,
  keyHex: string,
  payload: SnapshotPayload | undefined,
  pos: number,
): 'apply-seeded' | 'apply-hole' | 'apply-ineligible' | 'skip' {
  if (!payload || !isSkipEligibleSnapshot(payload, pos)) return 'apply-ineligible';
  const c = payload.coversUpTo;
  if (c <= (cursor.snapshotApplyThrough?.get(keyHex) ?? NO_SNAPSHOT_APPLY)) return 'apply-seeded';
  if (cursor.snapshotHole?.has(keyHex)) {
    markSnapshotSeeded(cursor, keyHex, c);
    return 'apply-hole';
  }
  return 'skip';
}

/**
 * P-533: the positions `[start, end)` of the set holding the chunk at `pos`, when this
 * cursor would SKIP that set (`snapshotSetDisposition` answers 'skip'). Null for any
 * other set, and for a chunk that does not say where it sits in a multi-chunk set.
 * Pure: it records nothing on the cursor, so the look-ahead may ask before the fold
 * reaches the set.
 */
function skippedSetSpan(
  cursor: MergeCursor,
  keyHex: string,
  payload: SnapshotPayload | undefined,
  pos: number,
): { start: number; end: number } | null {
  if (!payload || !isSkipEligibleSnapshot(payload, pos)) return null;
  if (payload.coversUpTo <= (cursor.snapshotApplyThrough?.get(keyHex) ?? NO_SNAPSHOT_APPLY)) return null;
  if (cursor.snapshotHole?.has(keyHex)) return null;
  const { chunkIdx: idx, chunkCount: count } = payload;
  if (!Number.isInteger(idx) || !Number.isInteger(count)) return null;
  if (count! < 2 || idx! < 0 || idx! >= count!) return null;
  return { start: pos - idx!, end: pos - idx! + count! };
}

/** P-533: whether `op` is the LAST chunk of the set `chunk` belongs to. */
function isLastChunkOf(op: PeerLogOp | null, chunk: PeerLogOp): boolean {
  if (!op || !isSnapshotOp(op) || op.ts !== chunk.ts) return false;
  const p = op.value as SnapshotPayload | undefined;
  const c = chunk.value as SnapshotPayload | undefined;
  if (!p || !c || typeof c.chunkCount !== 'number') return false;
  return p.coversUpTo === c.coversUpTo && p.chunkCount === c.chunkCount && p.chunkIdx === c.chunkCount - 1;
}

/** P-008: one in-progress snapshot-set crossing, for progress logging. */
interface SnapshotSetCrossing {
  coversUpTo: number;
  mode: 'apply' | 'skip';
  reason: string;
  startedAt: number;
  lastLogAt: number;
  chunks: number;
  rows: number;
  /** P-533: chunks crossed in one step, without a fold read. */
  jumped: number;
}

/** P-008: a chunk's position within its set, for log lines. */
function snapshotChunkLabel(payload: SnapshotPayload | undefined, pos: number): { idx: number; count: number } {
  const count = typeof payload?.chunkCount === 'number' && payload.chunkCount > 0 ? payload.chunkCount : 1;
  const idx =
    typeof payload?.chunkIdx === 'number'
      ? payload.chunkIdx
      : typeof payload?.coversUpTo === 'number'
        ? pos - payload.coversUpTo
        : 0;
  return { idx, count };
}

/** P-004: a verified complete set plus what it says about itself. */
export interface KnownSnapshotSet {
  seed: SnapshotSeed;
  meta: SnapshotSetMeta;
}

/** P-004: what a previous snapshot scan established for one log. */
export interface SnapshotScanMemo {
  /** `log.length` when the scan ran. Every index below it has been scanned. */
  scannedTo: number;
  /** The newest complete set found below `scannedTo`, or null for none. While
   *  `resumeBelow` is set it may be an OLDER complete set kept as a fallback. */
  set: KnownSnapshotSet | null;
  /** A scan that ran out of its time budget. Indices `[resumeBelow, scannedTo)` hold no
   *  complete set; the next call continues downward from `resumeBelow - 1`. */
  resumeBelow?: number;
  /** Set when the last attempt hit an unreadable block. The scan is not retried
   *  until `SNAPSHOT_UNREADABLE_RETRY_MS` has passed, so a stuck block cannot cost a
   *  read timeout on every merge pass. Growth alone does not trigger a retry, because
   *  a log still being written grows on every pass. */
  unreadableAtLength?: number;
  unreadableAtMs?: number;
  /** P-522: that unreadable block READ as null (gate-dropped), which is permanent for
   *  this build. A fresh log is not held for it. */
  unreadableGateDropped?: true;
  /** P-522 (D-011): the block the scan stopped on, and since when the scan has stopped on
   *  that SAME block in unbroken attempts. A retry that reads past it drops both, so a
   *  store that is slow but serving never looks stuck. */
  unreadableAtIndex?: number;
  unreadableSinceMs?: number;
}

/** P-004: how long an unreadable snapshot scan is remembered before a retry. */
export const SNAPSHOT_UNREADABLE_RETRY_MS = 30_000;

export function createMergeCursor(): MergeCursor {
  return {
    positions: new Map(),
    winners: new Map(),
    applyThrows: new Map(),
    readThrows: new Map(),
    readStalls: new Map(),
    lateReadResults: new Map(),
  };
}

/**
 * Default backward-scan bound for `findLatestCompleteSnapshot` and its wrappers.
 * `0` means NO floor: the scan walks back until it finds the newest complete set,
 * however far behind the tail it is.
 *
 * p2p-join-catchup-speed-2026-09-23 P-004 (R-4). This used to be
 * `SNAPSHOT_COMPACT_EVERY_OPS * 4` (4,000 ops). The bound assumed a snapshot at
 * least every 1,000 ops. P-003 makes the cadence grow with live state, and a
 * producer that was off for a while leaves its last set arbitrarily far back.
 * Either way the 4,000-op window made a real snapshot invisible, so the joiner
 * replayed full history and the sparse cutter shipped it.
 *
 * Dropping the bound does not add download. When a complete set exists, the
 * scan reads only `[seedIndex, length)`, which is exactly what the seeded fold
 * reads next. When none exists, the reader folds from 0 and reads every block
 * anyway. The scan streams ranged-prefetch windows ahead of its reads
 * (`scanBackwardWindowed`), so its wall-clock cost tracks the fold's read side.
 * It does not replace the fold's own cost. An explicit positive `maxLookback`
 * still bounds the scan for callers that want a cheap tail probe.
 */
export const SNAPSHOT_SCAN_LOOKBACK = 0;

/** P-004: first and largest prefetch window of the backward snapshot scan. The
 *  window doubles from MIN to MAX, so a set near the tail (steady state) hints at
 *  most a few blocks below the answer, and a far one streams in large ranges.
 *  MAX stays modest because the seed cutter scans a live, WAL-churning corestore. */
export const SNAPSHOT_SCAN_WINDOW_MIN = 32;
export const SNAPSHOT_SCAN_WINDOW_MAX = 256;

/**
 * P-004: a cursor this many ops (or more) behind its log's tail looks for a
 * complete snapshot set ahead of it, and jumps there when that is safe
 * (`seedCursorFromSnapshots`). Below this backlog the fold simply reads on. Four
 * cadence windows, so a live peer lagging through an ordinary write burst keeps
 * folding. The jump is for a peer that is genuinely far behind: a joiner whose
 * durable row sits at 0, or a device returning after a long absence.
 */
export const SNAPSHOT_JUMP_MIN_BACKLOG_OPS = SNAPSHOT_COMPACT_EVERY_OPS * 4;

type BoundedReadResult = Awaited<ReturnType<typeof readOpBoundedDetailed>>;

/** Fire the log's ranged prefetch (EI-92) when it has one. Degrades to per-op reads. */
function tryPrefetch(log: AdmittedLog, start: number, end: number): void {
  const pf = (log as PrefetchableLog).prefetch;
  if (typeof pf !== 'function' || end <= start) return;
  try {
    pf.call(log, start, end);
  } catch {
    /* degraded to per-op fetch, still correct */
  }
}

/** EI-92: open a ranged prefetch the caller may withdraw later (P-533). */
function prefetchRange(log: AdmittedLog, start: number, end: number): PassRange {
  const pf = (log as PrefetchableLog).prefetch;
  if (typeof pf !== 'function' || end <= start) return { start, range: null };
  try {
    return { start, range: pf.call(log, start, end) ?? null };
  } catch {
    return { start, range: null }; // degraded to per-op fetch, still correct
  }
}

/**
 * P-533: open a fold pass's EI-92 range once its first op `first` (at `pos`) is read. When
 * that op is a chunk of a set this cursor skips, the range starts at the set's end. For a
 * converged peer the whole window IS the new set, and streaming it fetched about 2 GB on
 * the rig for a crossing that reads two chunks (set@7787948, 2026-09-25 08:07Z).
 */
function openPassRange(
  log: AdmittedLog,
  cursor: MergeCursor,
  first: PeerLogOp | null,
  pos: number,
  upper: number,
): PassRange {
  const span =
    first && isSnapshotOp(first)
      ? skippedSetSpan(cursor, log.keyHex, first.value as SnapshotPayload | undefined, pos)
      : null;
  return prefetchRange(log, span ? span.end : pos, upper);
}

/**
 * P-004: the reader for a BACKWARD scan. `read(i)` returns exactly what
 * `readOpBoundedDetailed(log, i)` returns, and the scan still calls it one index at
 * a time, in the same order as before. So the scan GETs only the blocks it
 * decides on, never a block below the set it finds.
 *
 * That property is load-bearing. On a sparse joiner, every block below the seeded
 * set is absent, so a speculative get there would stall on a network fetch or a
 * read timeout (owner-roster-rebind-refold-snapshot.test.ts pins it).
 *
 * Speed comes from a ranged PREFETCH instead. When the scan enters a new window,
 * it asks a remote log to stream that window (EI-92, the same hint the fold uses).
 * The sequential gets then resolve as blocks arrive, rather than paying one round
 * trip each. The window doubles from MIN to MAX, so the hint runs ahead in large
 * ranges on a long scan. It can overshoot below the answer by at most one window,
 * and that costs download only, never a wait. The scan also yields a macrotask
 * every MIN reads, because local corestore gets resolve on microtasks and a long
 * scan with no yield would hold the event loop (the EI-81 class).
 */
function scanBackwardWindowed(
  log: AdmittedLog,
  floor: number,
  getTimeoutMs: number,
): (i: number) => Promise<BoundedReadResult> {
  let size = SNAPSHOT_SCAN_WINDOW_MIN;
  let hintedDownTo = Number.POSITIVE_INFINITY;
  let sinceYield = 0;
  return async (i: number) => {
    if (i < hintedDownTo) {
      const start = Math.max(floor, i - size + 1);
      tryPrefetch(log, start, i + 1);
      hintedDownTo = start;
      size = Math.min(size * 2, SNAPSHOT_SCAN_WINDOW_MAX);
    }
    if (++sinceYield >= SNAPSHOT_SCAN_WINDOW_MIN) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
    return readOpBoundedDetailed(log, i, getTimeoutMs);
  };
}

/**
 * WI-2313 — verify a snapshot SET fully occupies `[coversUpTo, coversUpTo + chunkCount)`:
 * every chunk present (readable), a snapshot op, tagged with the SAME `coversUpTo`,
 * the SAME `chunkCount`, and its correct `chunkIdx`. THE crash-consistency guard for
 * seeding: a fresh cursor may skip the summarized prefix ONLY when the whole set is
 * durably present; a partial/torn set (a chunk still downloading on a sparse
 * replica, or a torn append) must fall back to a full replay from 0 — NEVER a
 * forward seed that would silently skip the ops the missing chunks summarize
 * (silent REV row loss, worse than slow). A legacy single-op snapshot (no chunk
 * fields) reads as a complete 1-chunk set. Per-op reads are bounded (a withholding
 * peer can't hang it — an unreadable chunk just fails verification).
 */
async function verifySnapshotSet(
  log: AdmittedLog,
  coversUpTo: number,
  chunkCount: number,
  getTimeoutMs: number,
): Promise<VerifySetResult> {
  if (coversUpTo < 0 || chunkCount < 1) return { ok: false, reason: 'torn' };
  if (coversUpTo + chunkCount > log.length) return { ok: false, reason: 'torn' }; // extends past the tail → incomplete
  // P-004: the backward scan enters a set at its LAST chunk, so most of the span sits
  // below the scan window. Ask a remote log for the whole span at once instead of
  // paying one round trip per chunk (a measured set had 44 chunks).
  tryPrefetch(log, coversUpTo, coversUpTo + chunkCount);
  for (let j = 0; j < chunkCount; j++) {
    const idx = coversUpTo + j;
    const r = await readOpBoundedDetailed(log, idx, getTimeoutMs);
    // WI-37553 — UNREADABLE IS NOT TORN. A bounded get that timed out (or threw) says
    // NOTHING about whether the chunk is present; reporting it as `torn` made a COMPLETE
    // set look broken. Readers tolerate that (they just fold from 0), but the seed CUTTER
    // reads it as "no snapshot" and silently degrades a sparse cut into shipping FULL
    // history — measured: a 44-chunk set sitting 48 blocks from the tail, read off a live
    // WAL-churning corestore, yielded a 5.62 GB seed that the degradation guard refused,
    // failing a release cut 52 minutes in. Surface the distinction; let the caller decide.
    if (r.kind !== 'op') {
      return {
        ok: false,
        reason: 'unreadable',
        atIndex: idx,
        cause: r.kind === 'unavailable' ? 'timeout' : 'read-error',
      };
    }
    const op = r.op;
    if (!op || !isSnapshotOp(op)) return { ok: false, reason: 'torn' };
    const p = op.value as SnapshotPayload | undefined;
    if (!p || p.coversUpTo !== coversUpTo) return { ok: false, reason: 'torn' };
    if ((p.chunkCount ?? 1) !== chunkCount) return { ok: false, reason: 'torn' };
    if ((p.chunkIdx ?? 0) !== j) return { ok: false, reason: 'torn' };
  }
  return { ok: true };
}

/** WI-2313 — seed descriptor for the latest COMPLETE snapshot set in a log. */
export interface SnapshotSeed {
  /** Index of chunk 0 — where a fresh cursor starts so the forward fold reads
   *  EVERY chunk of the set (then the post-snapshot tail). Equals `coversUpTo` for
   *  a log whose chunks were appended contiguously at its tail (the producer's
   *  `appendBatch`). */
  seedIndex: number;
  /** Own-log length the set summarizes (the chunks' shared `coversUpTo`). */
  coversUpTo: number;
  /** Number of chunks in the set. */
  chunkCount: number;
}

/** WI-37553 — why a snapshot-set verification failed. `unreadable` (a bounded get timed
 *  out or threw) is NOT evidence the set is broken; `torn` is. */
export type VerifySetResult =
  | { ok: true }
  | { ok: false; reason: 'torn' }
  | { ok: false; reason: 'unreadable'; atIndex: number; cause: 'timeout' | 'read-error' };

/** WI-37553 — the outcome of a backward snapshot scan. Only `none-in-window` means
 *  "there is genuinely no snapshot to seed from"; `unreadable` means "ask again". */
export type SnapshotScanOutcome =
  | { kind: 'found'; seed: SnapshotSeed }
  | { kind: 'unreadable'; atIndex: number; cause: 'timeout' | 'read-error' }
  | { kind: 'none-in-window'; scannedFrom: number; floor: number };

/**
 * WI-2313 (supersedes the single-op P-007 scan): find the latest COMPLETE snapshot
 * set. Scans BACKWARD from the tail, within `maxLookback` when that is positive and
 * with no floor by default (p2p-join-catchup-speed P-004); on hitting any chunk of a
 * set it derives the set span `[coversUpTo, coversUpTo + chunkCount)` from that
 * chunk's payload and verifies the whole span (`verifySnapshotSet`). A verified set
 * ⇒ its chunk-0 index; a TORN set ⇒ skip its whole span and keep scanning older
 * history for an earlier complete set; none in the window ⇒ `null` (caller folds
 * from 0). Touches only `[seedIndex, length)` + the set's chunks — exactly the tail
 * a snapshot-seeded fold reads anyway, so it adds no download a fresh joiner
 * wouldn't already pay.
 */
export async function findLatestCompleteSnapshot(
  log: AdmittedLog,
  maxLookback: number = SNAPSHOT_SCAN_LOOKBACK,
  getTimeoutMs: number = DEFAULT_GET_TIMEOUT_MS,
): Promise<SnapshotSeed | null> {
  const r = await findLatestCompleteSnapshotDetailed(log, maxLookback, getTimeoutMs);
  return r.kind === 'found' ? r.seed : null;
}

/**
 * WI-37553 — the same scan as {@link findLatestCompleteSnapshot}, but it says WHY it
 * came back empty instead of collapsing every cause into `null`.
 *
 * `null` is the right answer for a READER (fold from 0 — correct, just slower), which is
 * why the boolean-ish wrapper above is unchanged. It is the WRONG answer for the seed
 * CUTTER: there, "I could not read the tail" and "there is genuinely no snapshot here"
 * have opposite remedies — retry vs. ship full history — and conflating them silently
 * turned a transient 5s read timeout into a 5.62 GB full-history seed.
 *
 * Outcomes:
 *  - `found`          — a verified complete set; `seed.seedIndex` is chunk 0.
 *  - `unreadable`     — a bounded get timed out / threw. Says NOTHING about whether a
 *                       snapshot exists. Retry (ideally with a longer timeout) before
 *                       concluding anything.
 *  - `none-in-window` — the scan genuinely reached `floor` having read every block. This
 *                       is the only outcome that justifies falling back to full history.
 */
export async function findLatestCompleteSnapshotDetailed(
  log: AdmittedLog,
  maxLookback: number = SNAPSHOT_SCAN_LOOKBACK,
  getTimeoutMs: number = DEFAULT_GET_TIMEOUT_MS,
  opts?: {
    /** P-004: never scan below this index. A cursor already at `floor` gains
     *  nothing from a set below it, so the far-behind jump passes its position.
     *  Combined with `maxLookback` by taking the higher of the two floors. */
    floor?: number;
  },
): Promise<SnapshotScanOutcome> {
  const len = log.length;
  const lookbackFloor = maxLookback > 0 ? Math.max(0, len - maxLookback) : 0;
  const floor = Math.max(lookbackFloor, Math.max(0, Math.floor(opts?.floor ?? 0)));
  const r = await scanForCompleteSnapshot(log, { from: len - 1, floor, getTimeoutMs });
  if (r.kind === 'found') return { kind: 'found', seed: r.seed };
  // The internal P-522 `gateDropped` mark stays internal.
  if (r.kind === 'unreadable') return { kind: 'unreadable', atIndex: r.atIndex, cause: r.cause };
  // No deadline was given, so the budget outcome cannot occur.
  return r.kind === 'budget' ? { kind: 'none-in-window', scannedFrom: len - 1, floor } : r;
}

/** P-004: a scan that stopped at its deadline. Indices `[resumeBelow, from]` were read
 *  and hold no complete set; continue from `resumeBelow - 1`. */
type SnapshotScanBudgetOutcome = { kind: 'budget'; resumeBelow: number };

/**
 * P-004: what a set says about ITSELF, beyond where it sits. The far-behind jump
 * needs both fields; fresh seeding needs neither. They are kept off the public
 * `SnapshotSeed` so its shape is unchanged.
 */
export interface SnapshotSetMeta {
  /** The producing op's `ts`. This is also the `now` its tombstone GC was measured against. */
  ts: number;
  /** Tables the producer left out (the release-cut head snapshot). Absent = none. */
  excludeTables?: string[];
}

type InternalSnapshotScanOutcome =
  | { kind: 'found'; seed: SnapshotSeed; meta: SnapshotSetMeta }
  | Exclude<SnapshotScanOutcome, { kind: 'found' | 'unreadable' }>
  // P-522: `gateDropped` marks an op that READ as null (the D-024 version gate dropped an
  // unknown-newer op, or it would not decode). That is permanent for this build, so
  // unlike a timeout it is no reason to hold a fresh log's fold. The public outcome keeps
  // reporting it as a timeout, unchanged for the seed cutter.
  | (Extract<SnapshotScanOutcome, { kind: 'unreadable' }> & { gateDropped?: true })
  | SnapshotScanBudgetOutcome;

/**
 * The backward scan behind {@link findLatestCompleteSnapshotDetailed}, from index
 * `from` down to `floor`. `deadlineAt` (epoch ms) is optional. When the scan reaches
 * it having found nothing, it stops with `budget`, and a caller can resume below.
 * `seedCursorFromSnapshots` runs before the fold on every merge pass, so an
 * unbounded scan of a huge snapshot-less log over a slow link could outlast the
 * process. The fold would then never start. The deadline plus the resumable memo
 * make that impossible.
 */
async function scanForCompleteSnapshot(
  log: AdmittedLog,
  args: { from: number; floor: number; getTimeoutMs: number; deadlineAt?: number },
): Promise<InternalSnapshotScanOutcome> {
  const { from, floor, getTimeoutMs, deadlineAt } = args;
  const read = scanBackwardWindowed(log, floor, getTimeoutMs);
  let i = Math.min(from, log.length - 1);
  while (i >= floor) {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) return { kind: 'budget', resumeBelow: i + 1 };
    const r = await read(i);
    if (r.kind !== 'op') {
      // Unavailable/withholding tail. The READER wrapper turns this back into `null`
      // (fold from 0 — safe); the cutter gets the truth so it can retry.
      return { kind: 'unreadable', atIndex: i, cause: r.kind === 'unavailable' ? 'timeout' : 'read-error' };
    }
    const op = r.op;
    if (!op) return { kind: 'unreadable', atIndex: i, cause: 'timeout', gateDropped: true };
    if (isSnapshotOp(op)) {
      const p = op.value as SnapshotPayload | undefined;
      const coversUpTo = p?.coversUpTo ?? 0;
      const chunkCount = p?.chunkCount ?? 1;
      const v = await verifySnapshotSet(log, coversUpTo, chunkCount, getTimeoutMs);
      if (v.ok) {
        return {
          kind: 'found',
          seed: { seedIndex: coversUpTo, coversUpTo, chunkCount },
          meta: { ts: op.ts, ...(p?.excludeTables?.length ? { excludeTables: [...p.excludeTables] } : {}) },
        };
      }
      // A set we could not READ is not a set we know to be torn — propagate, don't skip
      // past it. Skipping was how a complete-but-slow-to-read set vanished from the scan.
      if (v.reason === 'unreadable') return { kind: 'unreadable', atIndex: v.atIndex, cause: v.cause };
      // Genuinely torn/corrupt — skip its whole span and look for an earlier complete one.
      // `Math.min` keeps the scan strictly backward even if a corrupt payload reports a
      // coversUpTo ahead of the current index.
      i = Math.min(coversUpTo - 1, i - 1);
      continue;
    }
    i--;
  }
  return { kind: 'none-in-window', scannedFrom: from, floor };
}

/**
 * P-007 (design A): the index a FRESH cursor should seed at — the chunk-0 index of
 * the latest COMPLETE snapshot set, or `null` if none within `maxLookback` of the
 * tail. WI-2313: the seed fires ONLY for a whole present set, so a partial
 * multi-chunk set never seeds a cursor ahead of un-folded ops. Thin wrapper over
 * `findLatestCompleteSnapshot` (kept for the boot compaction-cadence anchor +
 * `seedCursorFromSnapshots`).
 */
export async function findLatestSnapshotIndex(
  log: AdmittedLog,
  maxLookback: number = SNAPSHOT_SCAN_LOOKBACK,
  getTimeoutMs: number = DEFAULT_GET_TIMEOUT_MS,
): Promise<number | null> {
  const seed = await findLatestCompleteSnapshot(log, maxLookback, getTimeoutMs);
  return seed ? seed.seedIndex : null;
}

/**
 * P-007 (design A): seed a FRESH merge cursor at each log's latest COMPLETE
 * snapshot set so a new joiner (or a post-reset re-fold) folds from the snapshot
 * forward instead of from 0 — the new-joiner replay-skip. Only seeds a log with NO
 * cursor position yet (fresh); an already-advanced cursor is left untouched
 * (idempotent, never rewinds a live fold). A log with no snapshot is left at 0
 * (folds from scratch, today's behavior). FLAG-GATED by the caller (boot.ts) —
 * off ⇒ never called ⇒ cursor seeds at 0, byte-identical to today.
 *
 * WI-2313 crash-consistency: the seed comes from `findLatestSnapshotIndex`, which
 * returns a set's chunk-0 index ONLY when every chunk is present + contiguous. A
 * partial/torn multi-chunk set yields `null` ⇒ this leaves the log at 0 (full
 * replay), never seeding the cursor PAST ops that unread chunks summarize.
 */
export async function seedCursorFromSnapshots(
  logs: AdmittedLog[],
  cursor: MergeCursor,
  opts?: SeedCursorFromSnapshotsOpts,
): Promise<void> {
  const maxLookback = opts?.maxLookback ?? SNAPSHOT_SCAN_LOOKBACK;
  const getTimeoutMs = opts?.getTimeoutMs ?? DEFAULT_GET_TIMEOUT_MS;
  const jump = opts?.jumpFarBehind ?? true;
  const minBacklog = Math.max(1, opts?.jumpMinBacklogOps ?? SNAPSHOT_JUMP_MIN_BACKLOG_OPS);
  const budgetMs = opts?.scanBudgetMs ?? SNAPSHOT_SEED_SCAN_BUDGET_MS;
  const deferMaxMs = opts?.seedDeferMaxMs ?? SNAPSHOT_SEED_DEFER_MAX_MS;
  for (const log of logs) {
    const key = log.keyHex;
    if (cursor.snapshotSkipUnsafe?.has(key)) continue; // F4: durable failure state unknown
    const pos = cursor.positions.get(key);
    if (pos === undefined) {
      // Fresh log (P-007): seed at the newest complete set anywhere in the log.
      const scan = await latestCompleteSnapshotMemoized(log, cursor, 0, maxLookback, getTimeoutMs, budgetMs);
      // P-522: an inconclusive scan with nothing known yet holds the fold rather than
      // starting it at 0, which would forfeit the seed for good. `holdFreshSeed` bounds
      // the hold, and bounds a scan stuck on one unreadable block more tightly.
      if (!scan.set && !scan.conclusive && holdFreshSeed(cursor, key, deferMaxMs, scan)) continue;
      cursor.snapshotSeedPending?.delete(key);
      if (scan.set && scan.set.seed.seedIndex > 0) {
        cursor.positions.set(key, scan.set.seed.seedIndex);
        // P-008: the seeded set is the ONE set this cursor must apply row by row.
        markSnapshotSeeded(cursor, key, scan.set.seed.coversUpTo);
      }
      continue;
    }
    cursor.snapshotSeedPending?.delete(key); // positioned by another seed (PG): no longer held
    // P-004 (R-4): a far-behind cursor jumps forward to a complete set AHEAD of it.
    if (!jump || log.length - pos < minBacklog || !snapshotJumpIsSafe(cursor, key)) continue;
    const { set } = await latestCompleteSnapshotMemoized(log, cursor, pos, maxLookback, getTimeoutMs, budgetMs);
    if (!set || set.seed.seedIndex <= pos) continue; // never rewinds
    if (!(await snapshotSetCoversSkip(log, pos, set.meta, getTimeoutMs))) continue;
    jumpCursorToSnapshot(cursor, key, pos, set.seed.seedIndex);
    // P-008: the jumped-to set stands in for the skipped ops, so it must apply.
    markSnapshotSeeded(cursor, key, set.seed.coversUpTo);
  }
}

/**
 * P-004 — does this set stand in for EVERY op in `[pos, seedIndex)` for a cursor
 * that has already applied `[0, pos)`? Fresh seeding never asks, because it has no
 * applied prefix. A jump does, and two producer behaviours make the answer no:
 *
 *  - EXCLUDED TABLES. The release-cut head snapshot is appended to the LIVE log
 *    without `SEED_EXCLUDED_TABLES`. Jumping over it would silently drop those
 *    tables' ops in the skipped range.
 *  - TOMBSTONE GC. A set drops tombstones older than `SNAPSHOT_TOMBSTONE_HORIZON_MS`
 *    before its own `ts` (EI-1688). A fresh fold never held those keys. This cursor
 *    may already have applied the PUT that a skipped, GC'd DEL removes, so jumping
 *    would keep a row a full replay deletes. The jump is allowed only when the
 *    skipped range starts well inside the horizon: the last op this cursor applied
 *    (index `pos - 1`, already local) must be younger than HALF the horizon at the
 *    set's `ts`. A single writer's clock is monotonic, so every skipped op is at
 *    least that young too, and the half-horizon margin absorbs clock skew.
 *
 * `pos === 0` has no applied prefix from this log, so it is the fresh case and
 * passes the GC rule. It still fails on excluded tables, which cost a jumper
 * rows that the old full replay would have delivered.
 */
async function snapshotSetCoversSkip(
  log: AdmittedLog,
  pos: number,
  meta: SnapshotSetMeta,
  getTimeoutMs: number,
): Promise<boolean> {
  if (meta.excludeTables?.length) return false;
  if (pos === 0) return true;
  const last = await readOpBoundedDetailed(log, pos - 1, getTimeoutMs);
  if (last.kind !== 'op' || !last.op) return false; // cannot prove the skipped range is young
  return last.op.ts >= meta.ts - SNAPSHOT_TOMBSTONE_HORIZON_MS / 2;
}

export interface SeedCursorFromSnapshotsOpts {
  maxLookback?: number;
  getTimeoutMs?: number;
  /**
   * P-004 (R-4): let an ALREADY-POSITIONED cursor that is far behind its log jump
   * forward to a complete snapshot set ahead of it, instead of replaying every op
   * that set summarizes. Default true. False restores the old contract, where
   * only a fresh log (no position) is seeded.
   */
  jumpFarBehind?: boolean;
  /** Backlog (ops) below which a positioned cursor does not look for a set ahead
   *  of it. Default `SNAPSHOT_JUMP_MIN_BACKLOG_OPS`. */
  jumpMinBacklogOps?: number;
  /** Wall-clock budget (ms) for one log's scan in one call. The scan resumes on the
   *  next call from where it stopped. Default `SNAPSHOT_SEED_SCAN_BUDGET_MS`;
   *  `<= 0` means unbounded. */
  scanBudgetMs?: number;
  /** P-522: how long a FRESH log is held out of the fold while its seed scan is
   *  inconclusive. Default `SNAPSHOT_SEED_DEFER_MAX_MS`; `<= 0` never holds, so an
   *  inconclusive scan folds from 0 at once (the pre-P-522 behaviour). */
  seedDeferMaxMs?: number;
}

/** P-004: per-log, per-pass wall-clock budget for the seed/jump scan. It runs
 *  before the fold, so one pass's scan never delays the fold of the other logs. */
export const SNAPSHOT_SEED_SCAN_BUDGET_MS = 20_000;

/**
 * P-522: the give-up bound on holding a fresh log out of the fold while its seed scan
 * is inconclusive. The scan resumes across passes, so it normally concludes well
 * inside this. The bound exists for a huge log with no complete set at all, which
 * would otherwise wait for a scan down to index 0 before its first fold. Folding from
 * 0 is still the right fallback there. For scale: the P-007 joiner folded about 385
 * ops/s, so 30 min of waiting is worth it whenever the set spares more than ~700k ops.
 */
export const SNAPSHOT_SEED_DEFER_MAX_MS = 30 * 60_000;

/**
 * P-522: the give-up bound for a scan STUCK on one unreadable block: the same block has
 * not read (timed out or failed) on every attempt for this long. The scan retries every
 * `SNAPSHOT_UNREADABLE_RETRY_MS`, so this allows about six retries. The P-007 tower census
 * found 13 peer logs whose locator reports `unreadable` (sparse on the tower). Holding those
 * for 30 min would only delay a fold that has to start from 0 anyway.
 *
 * D-011: it is measured on the block, not on the hold. P-007 run #2 measured it on the
 * hold: the scan was held on the budget bound for 239 s, one read on a joiner replicating
 * at ~24 MB/s missed its 5 s bound, and the hold gave up at once, so 7.76M ops folded
 * from 0. A block that reads on a retry was slow, not missing.
 */
export const SNAPSHOT_SEED_UNREADABLE_DEFER_MAX_MS = 3 * 60_000;

/**
 * P-522 (WI-10002899): hold a FRESH log out of the fold while its seed scan is
 * inconclusive (the budget ran out, or a block was unreadable) and nothing is known
 * yet. Folding it from 0 instead forfeits the seed for good. Once the log has a
 * position, only the P-004 jump can still reach a set, and the jump refuses a skipped
 * range older than half the tombstone horizon, which every range starting at an old
 * prefix is. Measured in P-007 run #1: the 20s budget ran out on a 7.76M-op remote log
 * whose complete set sat about 50k ops below the tail, and the joiner replayed from 0.
 *
 * Returns true to keep holding. Returns false when `maxMs <= 0`, once `maxMs` has passed
 * since the first hold, or once the scan has been stuck on one unreadable block for
 * `SNAPSHOT_SEED_UNREADABLE_DEFER_MAX_MS`; the caller then lets the log fold from 0.
 */
function holdFreshSeed(cursor: MergeCursor, keyHex: string, maxMs: number, scan: SnapshotScanAnswer): boolean {
  if (maxMs <= 0) return false;
  // Per-log hold metadata, not queued work; repeated scans update this same entry.
  const seedHolds = (cursor.snapshotSeedPending ??= new Map());
  const now = Date.now();
  const held = seedHolds.get(keyHex);
  const stuckMaxMs = Math.min(maxMs, SNAPSHOT_SEED_UNREADABLE_DEFER_MAX_MS);
  if (held === undefined) {
    seedHolds.set(keyHex, { sinceMs: now, progressLoggedAtMs: now });
    // console.info, not warn: a fresh joiner's scan routinely needs more than one pass.
    // Only the give-up below is an anomaly.
    console.info(
      `[read-merge] P-522 snapshot seed pending: log ${keyHex.slice(0, 12)} is held out of the fold ` +
        `until its seed scan concludes (give-up after ${Math.round(maxMs / 1000)}s, or after ` +
        `${Math.round(stuckMaxMs / 1000)}s stuck on one unreadable block).`,
    );
    return true;
  }
  const heldSec = Math.round((now - held.sinceMs) / 1000);
  if (scan.unreadable) {
    // An unmemoized scan (maxLookback > 0) keeps no per-block record; the hold's age stands in.
    const stuckForMs = scan.stuckForMs ?? now - held.sinceMs;
    if (stuckForMs >= stuckMaxMs) {
      console.warn(
        `[read-merge] P-522 snapshot seed GAVE UP: log ${keyHex.slice(0, 12)} scan stuck on unreadable block ` +
          `#${scan.stuckAtIndex ?? '?'} for ${Math.round(stuckForMs / 1000)}s (held ${heldSec}s); folding it from 0.`,
      );
      return false;
    }
  }
  if (now - held.sinceMs < maxMs) {
    // P-007 run #2 gave up with no record of how far the scan had got. Say so while holding.
    if (now - held.progressLoggedAtMs >= SNAPSHOT_SEED_PROGRESS_LOG_MS) {
      held.progressLoggedAtMs = now;
      const memo = cursor.snapshotScans?.get(keyHex);
      const reach =
        memo?.resumeBelow !== undefined
          ? `scanned down to #${memo.resumeBelow} of ${memo.scannedTo}`
          : `nothing below #${memo?.scannedTo ?? 0} scanned yet`;
      const stuck =
        scan.unreadable && scan.stuckAtIndex !== undefined
          ? `; stopped on unreadable #${scan.stuckAtIndex} for ${Math.round((scan.stuckForMs ?? 0) / 1000)}s`
          : '';
      console.info(`[read-merge] P-522 snapshot seed scan: log ${keyHex.slice(0, 12)} held ${heldSec}s, ${reach}${stuck}.`);
    }
    return true;
  }
  console.warn(
    `[read-merge] P-522 snapshot seed GAVE UP: log ${keyHex.slice(0, 12)} scan still inconclusive after ` +
      `${heldSec}s; folding it from 0.`,
  );
  return false;
}

/** P-522: how often a held fresh log reports its seed scan's progress (info). */
const SNAPSHOT_SEED_PROGRESS_LOG_MS = 60_000;

/**
 * P-004 — when may a positioned cursor skip `[pos, seedIndex)`?
 *
 * The skip itself is equivalent to replaying those ops. A complete set at
 * `seedIndex` carries, for every key this log wrote below `coversUpTo`, the row and
 * the clock of the log's winning op for that key. Deleted keys are carried as
 * tombstones (EI-1688). Folding those rows through the same LWW gate gives the same
 * winners and the same PG rows as folding the ops, whatever prefix the cursor had
 * already folded. That is the argument that already makes fresh seeding correct
 * (snapshot-fold.test.ts); a folded prefix only adds winners the gate respects.
 *
 * What the skip must NOT do is drop state that is held AT the cursor rather than
 * in the ops. Two holds exist:
 *  - `applyFailures`: an unresolved materialization pins this log's cursor at the
 *    failed op, retryable applies and timed-out in-flight writes included (they
 *    all go through `holdCursorHere`). It must resolve on the normal path first.
 *  - `snapshotSkipUnsafe`: the durable failure state could not be loaded (F4).
 * With neither present, everything below `pos` is applied and nothing at or above
 * it is owed except the ops the set summarizes.
 */
function snapshotJumpIsSafe(cursor: MergeCursor, keyHex: string): boolean {
  if (cursor.applyFailures?.has(keyHex)) return false;
  if (cursor.snapshotSkipUnsafe?.has(keyHex)) return false;
  return true;
}

/**
 * P-522 (WI-10002899): move each positioned log back to its floor, never forward, so
 * the fold re-reads the ops a content-deferral buffer evicted. The in-memory winners
 * are dropped too. An evicted op may already stand as its key's winner, and a re-read
 * op that does not beat the standing winner never reaches apply. This is the same
 * state a fresh cursor starts from; PG-level LWW keeps the re-applies idempotent
 * (see mergeAdmittedLogsIncremental).
 *
 * Unlike `createMergeCursor()`, a rewind keeps everything that describes the LOG rather
 * than the fold: the P-008 snapshot marks (a floor inside the seeded set still
 * re-applies it), apply-failure holds, and the snapshot scan memo. A log with no floor
 * goes back to 0. Returns the keys that moved.
 */
export function rewindMergeCursor(cursor: MergeCursor, floors: ReadonlyMap<string, number>): string[] {
  const moved: string[] = [];
  for (const [keyHex, pos] of cursor.positions) {
    const floor = Math.max(0, floors.get(keyHex) ?? 0);
    if (floor >= pos) continue;
    cursor.positions.set(keyHex, floor);
    moved.push(keyHex);
  }
  if (moved.length > 0) {
    cursor.winners.clear();
    cursor.applyThrows?.clear();
    cursor.applyDeferrals?.clear();
  }
  return moved;
}

/** Move `keyHex` from `from` to `to` and drop per-position read bookkeeping below
 *  `to`. Those positions will never be read again, so their stall/throw counters
 *  and any late read results are stale. */
function jumpCursorToSnapshot(cursor: MergeCursor, keyHex: string, from: number, to: number): void {
  cursor.positions.set(keyHex, to);
  const prefix = `${keyHex}:`;
  for (const m of [cursor.readThrows, cursor.readStalls, cursor.lateReadResults] as const) {
    if (!m) continue;
    for (const ident of [...m.keys()]) {
      if (!ident.startsWith(prefix)) continue;
      const at = Number(ident.slice(prefix.length));
      if (Number.isFinite(at) && at < to) m.delete(ident);
    }
  }
  console.warn(
    `[read-merge] P-004 snapshot jump: log ${keyHex.slice(0, 12)} cursor ${from} → ${to} ` +
      `(skipped ${to - from} op(s) summarized by the complete snapshot set at ${to}).`,
  );
}

/**
 * P-004 — `findLatestCompleteSnapshotDetailed`, memoized per log on the cursor.
 *
 * Only the unbounded scan is memoized. An explicit `maxLookback` window slides
 * with the tail, so an older answer can fall outside it; those callers
 * (tail probes, tests) get a plain scan every time.
 *
 * With the memo, a repeat scan reads only `[max(floor, scannedTo), length)` and
 * keeps the remembered set when nothing newer is there. The remembered set
 * was verified complete when it was found, and any complete set is a
 * correct seed (R-5), so the memo can make a seed older than the newest. It
 * cannot make one unsafe.
 *
 * P-522: `conclusive` is false when the answer is only what is known SO FAR: the
 * budget ran out, or a block was unreadable. A null `set` then means "not found
 * yet", not "none".
 */
async function latestCompleteSnapshotMemoized(
  log: AdmittedLog,
  cursor: MergeCursor,
  floor: number,
  maxLookback: number,
  getTimeoutMs: number,
  budgetMs: number,
): Promise<SnapshotScanAnswer> {
  if (maxLookback > 0) {
    const r = await scanForCompleteSnapshot(log, {
      from: log.length - 1,
      floor: Math.max(floor, log.length - maxLookback, 0),
      getTimeoutMs,
    });
    const unreadable = r.kind === 'unreadable' && r.gateDropped !== true;
    return {
      set: r.kind === 'found' ? { seed: r.seed, meta: r.meta } : null,
      conclusive: !unreadable,
      unreadable,
      ...(unreadable ? { stuckAtIndex: r.atIndex } : {}),
    };
  }
  const memos = (cursor.snapshotScans ??= new Map<string, SnapshotScanMemo>());
  const len = log.length;
  let memo = memos.get(log.keyHex);
  if (memo && len < memo.scannedTo) {
    memos.delete(log.keyHex); // the log shrank under the memo: it describes other blocks
    memo = undefined;
  }
  if (
    memo &&
    memo.unreadableAtLength !== undefined &&
    Date.now() - (memo.unreadableAtMs ?? 0) < SNAPSHOT_UNREADABLE_RETRY_MS
  ) {
    const gateDropped = memo.unreadableGateDropped === true;
    return {
      set: memo.set,
      conclusive: gateDropped,
      unreadable: !gateDropped,
      ...(memo.unreadableSinceMs !== undefined
        ? { stuckAtIndex: memo.unreadableAtIndex, stuckForMs: Date.now() - memo.unreadableSinceMs }
        : {}),
    };
  }
  if (
    memo &&
    memo.unreadableAtLength === undefined &&
    memo.resumeBelow === undefined &&
    len === memo.scannedTo
  ) {
    return { set: memo.set, conclusive: true };
  }
  const key = log.keyHex;
  const known = memo?.set ?? null;
  const deadlineAt = budgetMs > 0 ? Date.now() + budgetMs : undefined;
  const unreadable = (atIndex: number, gateDropped: boolean): SnapshotScanAnswer => {
    // Not evidence about any set. Keep what is known and retry later. The stuck clock
    // runs only while the scan keeps stopping on the SAME block.
    const now = Date.now();
    const sinceMs =
      memo?.unreadableAtIndex === atIndex && memo.unreadableSinceMs !== undefined ? memo.unreadableSinceMs : now;
    memos.set(key, {
      scannedTo: memo?.scannedTo ?? 0,
      set: known,
      ...(memo?.resumeBelow !== undefined ? { resumeBelow: memo.resumeBelow } : {}),
      unreadableAtLength: len,
      unreadableAtMs: now,
      unreadableAtIndex: atIndex,
      unreadableSinceMs: sinceMs,
      ...(gateDropped ? { unreadableGateDropped: true as const } : {}),
    });
    return {
      set: known,
      conclusive: gateDropped,
      unreadable: !gateDropped,
      stuckAtIndex: atIndex,
      stuckForMs: now - sinceMs,
    };
  };

  // 1. The newest region first: the ops appended since the last scan (all of the log on
  //    the first scan). A set found here is the newest there is.
  let resumeBelow = memo?.resumeBelow;
  if (!memo || len > memo.scannedTo) {
    const top = await scanForCompleteSnapshot(log, {
      from: len - 1,
      floor: Math.max(floor, memo?.scannedTo ?? 0),
      getTimeoutMs,
      deadlineAt,
    });
    if (top.kind === 'found') {
      const set = { seed: top.seed, meta: top.meta };
      memos.set(key, { scannedTo: len, set });
      return { set, conclusive: true };
    }
    if (top.kind === 'unreadable') return unreadable(top.atIndex, top.gateDropped === true);
    if (top.kind === 'budget') {
      // Out of time inside the new region. Resume below it next pass. Keep a known
      // older set as the answer meanwhile: any complete set is a correct seed.
      memos.set(key, { scannedTo: len, set: known, resumeBelow: top.resumeBelow });
      return { set: known, conclusive: false };
    }
  }

  // 2. An earlier scan ran out of time: continue it downward from where it stopped.
  if (resumeBelow !== undefined) {
    const rest = await scanForCompleteSnapshot(log, { from: resumeBelow - 1, floor, getTimeoutMs, deadlineAt });
    if (rest.kind === 'unreadable') return unreadable(rest.atIndex, rest.gateDropped === true);
    if (rest.kind === 'budget') {
      memos.set(key, { scannedTo: len, set: known, resumeBelow: rest.resumeBelow });
      return { set: known, conclusive: false };
    }
    // Nothing above `resumeBelow` held a set, so a set found here is the newest.
    const set = rest.kind === 'found' ? { seed: rest.seed, meta: rest.meta } : known;
    memos.set(key, { scannedTo: len, set });
    return { set, conclusive: true };
  }
  memos.set(key, { scannedTo: len, set: known });
  return { set: known, conclusive: true };
}

/** P-522: a memoized scan's answer, and whether the scan behind it has concluded. */
interface SnapshotScanAnswer {
  set: KnownSnapshotSet | null;
  conclusive: boolean;
  /** Inconclusive because a block would not read (not because the budget ran out). */
  unreadable?: boolean;
  /** P-522 (D-011): with `unreadable`, the block the scan stopped on, and how long it has
   *  stopped on that same block. `stuckForMs` is absent for an unmemoized scan. */
  stuckAtIndex?: number;
  stuckForMs?: number;
}

/* ------------------------------------------------------------------ *
 * WI-2105 REV fix — durable merge-cursor persistence (PG-cursor)
 * ------------------------------------------------------------------ */

/**
 * WI-2105 — injected persistence seam for merge-cursor positions. Keeps this
 * module free of a live PG dependency: boot.ts wires a Postgres-backed store
 * (harness_shared.substrate_merge_cursor, resolved via getHarnessAdminUrl —
 * never a hardcoded localhost), tests inject an in-memory fake. `load`/`save`
 * are keyed by (workspaceId, harnessSlug) that the store closes over, so this
 * interface speaks only the per-log keyHex→position map.
 */
/**
 * Durable lifecycle attached to one peer log. `unknown` is deliberately a real
 * state: cursor rows predate durable identity metadata, and silence alone is
 * never evidence that an operator intentionally retired a peer.
 */
export type MergeCursorPeerLifecycleState = 'unknown' | 'active' | 'retired';

export interface MergeCursorPeerLifecycle {
  logKeyHex: string;
  devicePubkey: string | null;
  state: MergeCursorPeerLifecycleState;
  updatedAt: Date | null;
}

/** Only explicit identity-bearing events may move a row out of `unknown`. */
export interface MergeCursorPeerLifecycleUpdate {
  logKeyHex: string;
  devicePubkey: string;
  state: Exclude<MergeCursorPeerLifecycleState, 'unknown'>;
}

export interface MergeCursorPeerLifecycleStore {
  /** Load lifecycle independently of apply binding; identity is not projection-scoped. */
  load(): Promise<Map<string, MergeCursorPeerLifecycle>>;
  /**
   * Persist explicit active/retired evidence. A missing cursor row is created at
   * position 0 under the current binding; an existing row keeps its position and
   * binding so a lifecycle transition can never rewind or re-scope a fold.
   */
  upsert(updates: readonly MergeCursorPeerLifecycleUpdate[], applyBinding: string | null): Promise<void>;
}

export interface MergeCursorStore {
  /**
   * Persisted positions for this (workspace, harness) that are VALID under
   * `applyBinding`: keyHex → next index. EI-18773697830188393 — a position means
   * "every op below this index has been applied", and whether an op applies is
   * decided by the pot-home projection scope it was folded through (the federation
   * demux key). Progress recorded under a DIFFERENT scope is therefore not resumable
   * (its ops were dropped, not applied), so the store must not return it.
   */
  load(applyBinding: string | null): Promise<Map<string, number>>;
  /**
   * Upsert the given positions, STAMPED with the apply binding they were folded
   * under. Best-effort; may throw — the caller isolates it.
   */
  save(
    positions: ReadonlyMap<string, number>,
    applyBinding: string | null,
    applyFailures?: ReadonlyMap<string, MergeApplyFailure>,
    /** P-008: each log's snapshot bookkeeping, stamped with the position it was
     *  recorded at. Omitted leaves the stored marks untouched. Once the position
     *  moves on, the old stamp no longer matches it, so the row reads as unstamped
     *  (owe the next set) rather than as a skip. */
    snapshotMarks?: ReadonlyMap<string, SnapshotApplyMark>,
  ): Promise<void>;
  /** Optional for position-only fakes. A failure at position ZERO must also be
   * seeded, so a later snapshot cannot skip the unapplied entry on restart. */
  loadApplyFailures?(applyBinding: string | null): Promise<Map<string, MergeApplyFailure>>;
  /**
   * P-008: the snapshot marks whose stamp matches the row's CURRENT position.
   * Those are the only trustworthy ones. A log absent from the result is unstamped.
   * Optional: a position-only store makes every seeded log unstamped, which is
   * the conservative reading.
   */
  loadSnapshotMarks?(applyBinding: string | null): Promise<Map<string, SnapshotApplyMark>>;
  /**
   * Optional while non-PG/in-memory fakes retain the position-only contract.
   * The canonical PG implementation always provides this nested store.
   */
  peerLifecycle?: MergeCursorPeerLifecycleStore;
}

/**
 * EI-20317490590418053 — boot-lifetime cache of PG cursor seeds.
 *
 * A substrate boot can admit remote logs AFTER its first merge pass. Loading PG
 * once and copying every persisted key into the live cursor is unsafe: entries
 * for not-yet-admitted logs look exactly like REMOVED logs to boot's log-set
 * invariant, which resets the whole fold. The old one-shot latch then prevents
 * those late logs from ever receiving their persisted positions, so they replay
 * from zero and can starve the actual tail indefinitely.
 *
 * This cache separates the durable seed SET from the live admitted-log cursor:
 * it loads once, copies positions only for keys admitted in the current pass,
 * and remains reusable when another log is admitted later. The durable set is
 * binding-scoped, so resolving a different apply binding reloads it instead of
 * treating the first (often empty) load as authoritative for the whole boot. A
 * structural fold invalidation (removal, truncation, or lost deferred state)
 * still disables it for the remainder of the boot; reusing progress after one
 * of those events would be the same unsafe skip the original latch avoided.
 */
export interface PgMergeCursorSeedCache {
  /**
   * Seed `cursor` from progress persisted under `applyBinding`. When
   * `fallbackApplyBinding` is given, an admitted key the primary binding left
   * unpositioned is then seeded from progress persisted under that binding, and
   * the keys seeded that way are returned so the caller can owe whatever the
   * fallback binding did not apply (WI-10005575: a boot that resolves the memory
   * flag differently from the stamp otherwise re-folds every log from 0).
   */
  seed(
    cursor: MergeCursor,
    store: MergeCursorStore,
    applyBinding: string | null,
    admittedKeyHexes: Iterable<string>,
    fallbackApplyBinding?: string | null,
  ): Promise<ReadonlySet<string>>;
  invalidate(): void;
}

const NO_FALLBACK_SEEDS: ReadonlySet<string> = new Set();

/** Copy safe persisted positions into a cursor, optionally filtering to keys
 * admitted RIGHT NOW. Exported for the direct one-shot helper and focused tests. */
export function seedCursorFromPgCache(
  cursor: MergeCursor,
  saved: ReadonlyMap<string, number>,
  admittedKeyHexes?: Iterable<string>,
  failures?: ReadonlyMap<string, MergeApplyFailure>,
  /** P-008: stamped marks (see `MergeCursorStore.loadSnapshotMarks`). A copied
   *  position with no entry here is loaded as unstamped. */
  snapshotMarks?: ReadonlyMap<string, SnapshotApplyMark>,
): void {
  const entries: Iterable<readonly [string, number]> = admittedKeyHexes
    ? (function* () {
        for (const keyHex of admittedKeyHexes) {
          const position = saved.get(keyHex);
          if (position !== undefined) yield [keyHex, position] as const;
        }
      })()
    : saved;
  for (const [keyHex, position] of entries) {
    const failure = failures?.get(keyHex);
    if ((position > 0 || failure || (failures !== undefined && position === 0)) && !cursor.positions.has(keyHex)) {
      cursor.positions.set(keyHex, failure ? Math.min(position, failure.position) : position);
      if (failure) (cursor.applyFailures ??= new Map()).set(keyHex, failure);
      loadSnapshotApplyMark(cursor, keyHex, position, snapshotMarks?.get(keyHex));
    }
  }
}

/**
 * F4: the durable cursor could not be read, so an admitted log may still owe an
 * unapplied entry at position 0. Pin every log that has no position yet at 0,
 * which keeps fresh snapshot seeding off it. Also mark it `snapshotSkipUnsafe`,
 * which keeps the P-004 far-behind jump off it: that jump acts on positioned
 * cursors, so the pin at 0 alone would no longer protect the entry. Exported so
 * the boot F4 path can use the same helper instead of its own copy of the loop.
 */
export function pinUnknownDurableState(cursor: MergeCursor, keyHexes: Iterable<string>): void {
  for (const key of keyHexes) {
    if (cursor.positions.has(key)) continue;
    cursor.positions.set(key, 0);
    (cursor.snapshotSkipUnsafe ??= new Set()).add(key);
  }
}

/** Create one seed cache per booted harness. A failed load is one-shot and
 * fail-open (the caller logs it; folds start at zero), matching the old latch. */
export function createPgMergeCursorSeedCache(): PgMergeCursorSeedCache {
  let saved: ReadonlyMap<string, number> | undefined;
  let failures: ReadonlyMap<string, MergeApplyFailure> | undefined;
  let marks: ReadonlyMap<string, SnapshotApplyMark> | undefined;
  let savedApplyBinding: string | null | undefined;
  // WI-10005575: the fallback binding's load, cached separately so a primary
  // reload never discards it and vice versa.
  let fallbackSaved: ReadonlyMap<string, number> | undefined;
  let fallbackFailures: ReadonlyMap<string, MergeApplyFailure> | undefined;
  let fallbackMarks: ReadonlyMap<string, SnapshotApplyMark> | undefined;
  let savedFallbackBinding: string | null | undefined;
  let invalidated = false;
  let loadFailed = false;
  return {
    async seed(cursor, store, applyBinding, admittedKeyHexes, fallbackApplyBinding) {
      const admitted = [...admittedKeyHexes];
      if (invalidated) {
        if (loadFailed) pinUnknownDurableState(cursor, admitted);
        return NO_FALLBACK_SEEDS;
      }
      if (!saved || savedApplyBinding !== applyBinding) {
        try {
          [saved, failures, marks] = await Promise.all([
            store.load(applyBinding),
            store.loadApplyFailures?.(applyBinding),
            store.loadSnapshotMarks?.(applyBinding),
          ]);
          savedApplyBinding = applyBinding;
        } catch (error) {
          invalidated = true;
          loadFailed = true;
          pinUnknownDurableState(cursor, admitted);
          throw error;
        }
      }
      seedCursorFromPgCache(cursor, saved, admitted, failures, marks);
      if (fallbackApplyBinding === undefined || fallbackApplyBinding === applyBinding) {
        return NO_FALLBACK_SEEDS;
      }
      const unpositioned = admitted.filter((keyHex) => !cursor.positions.has(keyHex));
      if (unpositioned.length === 0) return NO_FALLBACK_SEEDS;
      if (!fallbackSaved || savedFallbackBinding !== fallbackApplyBinding) {
        try {
          [fallbackSaved, fallbackFailures, fallbackMarks] = await Promise.all([
            store.load(fallbackApplyBinding),
            store.loadApplyFailures?.(fallbackApplyBinding),
            store.loadSnapshotMarks?.(fallbackApplyBinding),
          ]);
          savedFallbackBinding = fallbackApplyBinding;
        } catch {
          // The primary binding's state is known, so a failed fallback read only
          // forfeits the shortcut: those keys fold from 0 as before.
          return NO_FALLBACK_SEEDS;
        }
      }
      seedCursorFromPgCache(cursor, fallbackSaved, unpositioned, fallbackFailures, fallbackMarks);
      const seeded = unpositioned.filter((keyHex) => cursor.positions.has(keyHex));
      return seeded.length === 0 ? NO_FALLBACK_SEEDS : new Set(seeded);
    },
    invalidate() {
      invalidated = true;
      saved = undefined;
      failures = undefined;
      marks = undefined;
      fallbackSaved = undefined;
      fallbackFailures = undefined;
      fallbackMarks = undefined;
      savedApplyBinding = undefined;
    },
  };
}

/**
 * WI-2105 REV fix — seed a merge cursor's per-log positions from PG BEFORE the
 * first fold, so a bg-host restart RESUMES each log's fold where it left off
 * instead of re-folding from 0. Only seeds a log with NO in-memory position yet
 * (idempotent; never rewinds a live fold) and only to a position > 0. Unlike
 * `seedCursorFromSnapshots` (own-log-only, requires the log be snapshottable by
 * this peer), this resumes ANY admitted log — including an orphaned peer log the
 * tower can no longer snapshot (the e06b8704 case that WI-2313 could not fix).
 *
 * CRASH-CONSISTENCY: the persisted position is written persist-AFTER-apply (see
 * `persistCursor` and the boot `onCursorAdvance` hook), so it never points past a
 * durably-applied op. Seeding at it therefore skips ONLY ops whose projection
 * writes already committed; re-folding from it would re-apply idempotently
 * (LWW put/del), so seeding is strictly safe and strictly cheaper. A load
 * failure is the caller's to isolate → leaves positions at 0 (full re-fold,
 * slower but correct).
 *
 * SCOPE-CONDITIONAL (EI-18773697830188393): `applyBinding` is the pot-home projection
 * scope the fold is about to run under. Only progress recorded under the SAME scope is
 * resumable — an op folded through a different (e.g. mis-resolved) hive-home binding was
 * DEMUX-DROPPED rather than applied, even though the cursor marked it done. Passing the
 * live binding here is what makes a corrected binding self-heal: the store returns
 * nothing, the fold restarts from 0 through the new scope, and the re-apply is
 * idempotent (LWW put/del). This is the COLD-BOOT counterpart of the mid-session
 * `forceReFold` the rekey rebind sets.
 */
export async function seedCursorFromPg(
  cursor: MergeCursor,
  store: MergeCursorStore,
  applyBinding: string | null,
): Promise<void> {
  const [saved, failures, marks] = await Promise.all([
    store.load(applyBinding),
    store.loadApplyFailures?.(applyBinding),
    store.loadSnapshotMarks?.(applyBinding),
  ]);
  seedCursorFromPgCache(cursor, saved, undefined, failures, marks);
}

/**
 * WI-2105 REV fix — persist a merge cursor's positions to PG. Call STRICTLY
 * AFTER the ops up to those positions have been applied (persist-after-apply):
 * a crash between apply and persist then RE-folds the last batch (idempotent
 * LWW) rather than SKIPPING it — that ordering is the whole correctness argument
 * for PG-cursor (17c98, mr5ymwgw). Thin pass-through over the injected store so
 * the boot `onCursorAdvance` hook and any future caller share one code path.
 *
 * `applyBinding` (EI-18773697830188393) is the pot-home projection scope these ops were
 * folded through; it is stamped alongside the positions so a LATER boot can tell whether
 * this progress is resumable under ITS binding (see `seedCursorFromPg`). Read it LIVE at
 * each call — a mid-session rekey rebind changes the scope, and the re-fold it triggers
 * must persist under the NEW stamp, not the one that was current at boot.
 */
export async function persistCursor(
  positions: ReadonlyMap<string, number>,
  store: MergeCursorStore,
  applyBinding: string | null,
  applyFailures?: ReadonlyMap<string, MergeApplyFailure>,
  /** P-008: stamped beside the positions (see `MergeCursorStore.save`). */
  snapshotMarks?: ReadonlyMap<string, SnapshotApplyMark>,
): Promise<void> {
  if (snapshotMarks) await store.save(positions, applyBinding, applyFailures, snapshotMarks);
  else if (applyFailures) await store.save(positions, applyBinding, applyFailures);
  else await store.save(positions, applyBinding);
}

/**
 * Does `env` beat the stored winner? EXACTLY mirrors `lwwPick(prev, env)` (prev wins ties
 * through the final source-key tiebreak's `>=`), so an incremental fold across any
 * pass/chunk boundaries lands on the identical winner set a from-scratch `mergeAdmittedLogs`
 * fold would.
 *
 * EI-1698: step 1 is a SINGLE total order via a DERIVED HLC for every op (its `hlc`, else
 * `encodeHlc({ms: ts, count: 0})`) — comparing the SAME key for every pair is transitive.
 * The previous rule ("HLC when BOTH carry one, ELSE ts") switched basis per pair and was
 * NON-TRANSITIVE under mixed-HLC presence: a no-HLC op whose ts sat BETWEEN two HLC ops
 * formed a winner cycle (X>Z, Z>Y, Y>X), so two peers folding the same ops in different
 * delivery orders diverged on a contended key. This is a HAND-MIRROR of `lwwPick`
 * (projection.ts) and MUST stay byte-for-byte in sync with it — the durable fix is to
 * extract one shared comparator both call (tracked EI-1698 follow-up; SQL ON CONFLICT guards
 * are the third copy, owned separately).
 */
function beatsStored(env: OpEnvelope, prev: WinnerMeta): boolean {
  // Step 1 — causal clock as a single total order: derive an HLC for EVERY op (mirror lwwPick).
  const ke = env.hlc ?? encodeHlc({ ms: env.ts ?? 0, count: 0 });
  const kp = prev.hlc ?? encodeHlc({ ms: prev.ts, count: 0 });
  if (ke > kp) return true;
  if (kp > ke) return false;
  // ── clock tie ── del beats put.
  if (env.type === 'del' && prev.type !== 'del') return true;
  if (prev.type === 'del' && env.type !== 'del') return false;
  // Same type on a tie → higher sourceLogKeyHex wins; prev wins on equality (lwwPick's `sa >= sb`).
  const se = env.sourceLogKeyHex ?? '';
  return se > prev.src;
}

function toMeta(env: OpEnvelope): WinnerMeta {
  return {
    ts: env.ts ?? 0,
    ...(env.hlc ? { hlc: env.hlc } : {}),
    type: env.type as 'put' | 'del',
    src: env.sourceLogKeyHex ?? '',
  };
}

/**
 * WI-4020: record a winner in `cursor.winners` under an approximate-LRU bound
 * (see `DEFAULT_MAX_WINNERS_ENTRIES`). Approximate via `Map`'s insertion-order
 * iteration: a key whose winner actually CHANGES is deleted+re-set so it moves
 * to the MRU (end) position; eviction removes from the LRU (front) end. A key
 * that is merely READ (confirmed stale, winner unchanged — the `continue` at
 * the `beatsStored` gate) does NOT bump recency — only a real winner CHANGE
 * does. This is deliberate, not an approximation shortcut: a row that keeps
 * winning without changing is a settled/quiescent key, exactly the kind
 * safest to evict first, so tracking recency-of-CHANGE (not recency-of-touch)
 * better matches the goal of keeping actively-churning keys hot.
 *
 * `cap <= 0` disables bounding (today's behavior: the winner is set, nothing
 * is ever evicted). `onEvicted` is a best-effort observability hook (same
 * shape as `onCapped`/`onBacklog` elsewhere in this file) — it must never
 * throw out of this function or abort the merge pass over it.
 */
function recordWinner(
  cursor: MergeCursor,
  groupKey: string,
  meta: WinnerMeta,
  cap: number,
  onEvicted?: (evictedCount: number, size: number) => void,
): void {
  if (cursor.winners.has(groupKey)) cursor.winners.delete(groupKey); // move to MRU end
  cursor.winners.set(groupKey, meta);
  if (cap <= 0) return;
  let evicted = 0;
  let evictor = winnersEvictors.get(cursor.winners);
  while (cursor.winners.size > cap) {
    let next = evictor?.next();
    if (!next || next.done) {
      evictor = cursor.winners.keys();
      winnersEvictors.set(cursor.winners, evictor);
      next = evictor.next();
    }
    const oldest = next.value;
    if (oldest === undefined) break; // defensive: size>cap but iterator empty can't happen, but never loop forever
    cursor.winners.delete(oldest);
    evicted++;
  }
  if (evicted > 0) {
    try {
      onEvicted?.(evicted, cursor.winners.size);
    } catch {
      // Observability hook must never abort the merge pass.
    }
  }
}

/**
 * F4: repeated failures raise a loud backlog diagnostic. This is an ALERT
 * threshold, never a retry budget or evidence of permanent rejection.
 */
const APPLY_FAILURE_ALERT_AFTER = 3;

/** Op identity for the per-op throw counter — a new op (or a different winner for
 *  the key) gets a fresh retry budget; the same poison op accumulates throws. */
function opIdent(groupKey: string, env: OpEnvelope): string {
  return JSON.stringify([groupKey, env.ts ?? 0, env.hlc ?? '', env.sourceLogKeyHex ?? '', env.type]);
}

/**
 * WI-3896 (tower outbox/merge wedge — the "papercusp substrate_merge_cursor never
 * establishes" incident): `apply(env)` is an unbounded PG write with NO existing
 * bound — the P-012 doc-comment on `applyRecordingWinner` below already flagged
 * this as a known gap ("the merge pass has no per-op timeout on it the way
 * `readOpBoundedDetailed` does on the read side"). A genuinely wedged write (the
 * live incident: an old iMac device's stale plan-parts, keyed ~ef7a8160, hung
 * forever) freezes `mergeAdmittedLogsIncremental`'s `await applyRecordingWinner(...)`
 * PERMANENTLY — unlike `outbox-drain.ts`'s send-side pass, which already races the
 * whole pass against `DRAIN_PASS_TIMEOUT_MS`, NOTHING bounds this await, so the
 * whole harness's incremental merge (and therefore its PG-persisted merge cursor)
 * simply stops advancing forever, silently.
 *
 * Generous relative to a normal PG write — even under host CPU saturation — so a
 * merely-SLOW write is never mistaken for poison: on timeout the (possibly still
 * in-flight) write is DETACHED, not cancelled, and its eventual completion is
 * harmless (the projection writer is idempotent/LWW-guarded, same at-least-once
 * argument `outbox-drain.ts` already relies on for its own detached zombie passes).
 */
export const MERGE_APPLY_TIMEOUT_MS = 45_000;

/**
 * Maximum physical projection writes across every booted harness in this process.
 *
 * Each harness serializes its own merge pass, but a bg-host can keep 100+ harnesses
 * resident. Without a process-wide boundary, one merge tick per harness can enter
 * `applyHyperbeeOpToPg` together and exhaust the shared org pool even though every
 * individual harness is behaving correctly. Four mirrors the send-side outbox gate:
 * on the 16-core bg-host it leaves the 28-slot org pool enough room for the 16 DBOS
 * workers and routine/control traffic instead of making them queue behind merges.
 */
export const DEFAULT_MERGE_APPLY_CONCURRENCY = 4;

/**
 * WI-10003427: at most this many physical writes may run DETACHED from an admission slot
 * (see {@link holdMergeApplySlot}). Past it a write that outlives its lease keeps its slot,
 * so a systemic hang cannot pile up unbounded concurrent PG work behind the gate's back.
 */
export const MAX_MERGE_APPLY_ZOMBIES = 32;

interface MergeApplyAdmissionState {
  /** Optional so a process retaining a pre-fix pinned object upgrades in place. */
  gate?: ConcurrencyGate;
  /** Physical writes whose slot lease expired while they kept running. */
  zombies?: number;
  /** Lease expiries since boot (each one is a write that outlived the apply timeout). */
  zombiesTotal?: number;
}

const mergeApplyAdmissionState = pinModuleState<MergeApplyAdmissionState>(
  '@papercusp/operator-core.hyperbeeMergeApplyAdmission',
  () => ({ gate: createConcurrencyGate(DEFAULT_MERGE_APPLY_CONCURRENCY), zombies: 0, zombiesTotal: 0 }),
);
mergeApplyAdmissionState.gate ??= createConcurrencyGate(DEFAULT_MERGE_APPLY_CONCURRENCY);
mergeApplyAdmissionState.gate.setLimit(DEFAULT_MERGE_APPLY_CONCURRENCY);
mergeApplyAdmissionState.zombies ??= 0;
mergeApplyAdmissionState.zombiesTotal ??= 0;
const mergeApplyAdmission = mergeApplyAdmissionState.gate;

/** WI-10003427: the process-wide merge-apply gate, for stall reports and health reads. */
export interface MergeApplyAdmissionSnapshot {
  limit: number;
  inFlight: number;
  queued: number;
  /** Writes running detached from a slot right now. */
  zombies: number;
  zombiesTotal: number;
}

export function mergeApplyAdmissionSnapshot(): MergeApplyAdmissionSnapshot {
  return {
    limit: mergeApplyAdmission.limit,
    inFlight: mergeApplyAdmission.inFlight,
    queued: mergeApplyAdmission.queued,
    zombies: mergeApplyAdmissionState.zombies ?? 0,
    zombiesTotal: mergeApplyAdmissionState.zombiesTotal ?? 0,
  };
}

/**
 * WI-10003427 — hold a physical write's admission slot until the write settles or its lease
 * (`leaseMs`, the apply timeout) expires, whichever comes first.
 *
 * The gate is PROCESS-WIDE (every booted harness shares {@link DEFAULT_MERGE_APPLY_CONCURRENCY}
 * slots). Before this, a slot was held until its write settled, so a write that never settled
 * kept its slot forever. Measured on the tower bg-host: postgres.js stranded statements on
 * batch connections Postgres had killed for idle-in-transaction; four such writes held all four
 * slots and every harness's federation stopped, with every per-harness health read healthy.
 *
 * On expiry the write keeps running (it is not cancellable) and is counted as a zombie until it
 * settles; its caller already saw {@link MergeApplyTimeoutError} and holds the cursor. Past
 * {@link MAX_MERGE_APPLY_ZOMBIES} the slot is kept, bounding detached concurrency. Both
 * transitions log loudly. `leaseMs <= 0` holds until the write settles (the pre-fix behavior).
 */
async function holdMergeApplySlot(groupKey: string, write: Promise<unknown>, leaseMs: number): Promise<void> {
  const settled = write.then(
    () => undefined,
    () => undefined,
  );
  if (leaseMs <= 0) return settled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = await Promise.race([
    settled.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), leaseMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!expired) return;
  const state = mergeApplyAdmissionState;
  if ((state.zombies ?? 0) >= MAX_MERGE_APPLY_ZOMBIES) {
    console.error(
      `[read-merge] MERGE-APPLY ZOMBIE CAP: ${groupKey} still running after ${leaseMs}ms and ` +
        `${state.zombies} writes already run detached; keeping its admission slot (WI-10003427)`,
    );
    return settled;
  }
  state.zombies = (state.zombies ?? 0) + 1;
  state.zombiesTotal = (state.zombiesTotal ?? 0) + 1;
  console.error(
    `[read-merge] MERGE-APPLY ZOMBIE: ${groupKey} still running after ${leaseMs}ms; admission slot ` +
      `released, write detached (${state.zombies} detached now, ${state.zombiesTotal} since boot) (WI-10003427)`,
  );
  void settled.then(() => {
    state.zombies = Math.max(0, (state.zombies ?? 1) - 1);
  });
}

/**
 * Thrown when a single apply exceeds its bound. A timeout is retryable, never
 * proof of poison: keep the cursor held and reuse the pending write next pass.
 */
export class MergeApplyTimeoutError extends Error {
  constructor(readonly groupKey: string, readonly timeoutMs: number) {
    super(
      `[read-merge] merge-apply TIMEOUT for ${groupKey}: exceeded ${timeoutMs}ms — a hung ` +
        `projection write remains unapplied; cursor held for replay (never dropped by retry exhaustion).`,
    );
    this.name = 'MergeApplyTimeoutError';
  }
}

/**
 * Race `p` against `timeoutMs`; on expiry throw `MergeApplyTimeoutError(groupKey)`.
 * The (possibly still-pending) `p` is DETACHED on either path — its late
 * resolution/rejection is swallowed so it can never surface as an unhandled
 * rejection or double-count once we've moved on. `timeoutMs <= 0` disables the
 * bound entirely (today's unbounded-await behavior; the STAGE_STALL_LOG_MS
 * observability line from the caller's `logIfStageStalls` wrap still fires).
 */
async function raceApplyTimeout<T>(groupKey: string, p: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MergeApplyTimeoutError(groupKey, timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    p.catch(() => {}); // detach the (possibly zombie) write — never an unhandled rejection
  }
}

/**
 * WI-255 — apply an op that has already passed the `beatsStored` LWW gate, then
 * record it as the winner ONLY if apply returned WITHOUT throwing.
 *
 * The pre-WI-255 code recorded the winner BEFORE apply; an apply that threw
 * (a transient PG blip/deadlock/timeout mid-merge) propagated out, the caller
 * retried, and on the retry `beatsStored(env, env)` is false (strict `>`), so the
 * op was SKIPPED forever — silent DATA LOSS until a rare full re-fold.
 *
 * F4: failures return typed dispositions without recording a winner. The caller
 * holds and persists the first unresolved position, so outage/restart recovery
 * replays original bytes. A boolean false still means the existing sink handled
 * the op without changing a row (e.g. a scope or LWW drop), not an exception.
 *
 * P-012 (fleet-reliability-verification-2026-07-10, named-hop pipeline
 * observability): `apply(env)` is an unbounded PG write (the projection
 * writer) with the SAME hang shape `outbox-drain.ts`'s send-side `append()`
 * had (a wedged connection/lock never resolves). Wrapped with the shared
 * `logIfStageStalls` (formalized out of WI-3619) so a hung merge-apply NAMES
 * ITSELF (scope = source log key, stage = table+key) in the journal at
 * `STAGE_STALL_LOG_MS`, THEN (WI-3896) `raceApplyTimeout` bounds it at
 * `MERGE_APPLY_TIMEOUT_MS` — the per-op timeout `readOpBoundedDetailed` already
 * has on the read side, closing the gap this doc-comment used to flag as
 * missing. Repeated timeouts remain unresolved and alert; they never advance
 * the materialization cursor — see `MergeApplyTimeoutError`.
 */
/**
 * WI-559 / EI-18775450536624845 — is this a STRUCTURAL apply failure: one caused by
 * a row the receiver does not have YET, which resolves itself the moment that row
 * arrives or a repair lands?
 *
 * Today only `23503 foreign_key_violation`. The motivating incident: a joiner whose
 * local Pot handle differed from the owner's announced slug had no FK parent for the
 * federated `pot_members` scope, so EVERY inbound roster op raised 23503. Both of
 * this function's non-existence consequences then fired at once —
 *   1. the throw propagated and ABORTED the whole merge pass, every ~60s, so the log
 *      never advanced (writer at 7944, merged to 0); and
 *   2. after MAX_APPLY_THROWS the op was QUARANTINED — winner recorded, op dropped —
 *      converting a self-healing structural mismatch into PERMANENT data loss
 *      (~20 roster ops lost in 3 minutes on the live rig).
 * The roster stayed empty and the joiner admitted nobody.
 *
 * A structural failure is the OPPOSITE of poison: poison is a value PG can NEVER
 * store, whereas this op is perfectly storable and merely EARLY. Dropping it is the
 * one thing that must not happen, because nothing re-reads it afterwards.
 *
 * Keep this narrow: dependency failures allow later rows in the same log to
 * apply, while infrastructure failures stop that log's pass to bound outage work.
 * Neither disposition drops the original operation.
 */
function isStructuralApplyFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === '23503';
}

/** WI-10003506: first re-attempt delay for a held structural deferral. */
export const MERGE_DEPENDENCY_RETRY_BASE_MS = 1_000;
/**
 * WI-10003506: cap on that delay. It is also the worst-case self-heal latency once the
 * missing parent row lands, so keep it well under the git-sync / reconcile cadence.
 */
export const MERGE_DEPENDENCY_RETRY_MAX_MS = 30_000;

/** Delay before re-attempting an op after its `failures`-th consecutive structural deferral. */
export function dependencyRetryDelayMs(failures: number): number {
  const exp = Math.min(Math.max(0, failures - 1), 30);
  return Math.min(MERGE_DEPENDENCY_RETRY_BASE_MS * 2 ** exp, MERGE_DEPENDENCY_RETRY_MAX_MS);
}

async function applyRecordingWinner(
  cursor: MergeCursor,
  groupKey: string,
  env: OpEnvelope,
  apply: (op: OpEnvelope) => Promise<boolean | MergeApplyOutcome>,
  scope = 'read-merge',
  applyTimeoutMs: number = MERGE_APPLY_TIMEOUT_MS,
  maxWinnersEntries: number = DEFAULT_MAX_WINNERS_ENTRIES,
  onWinnersEvicted?: (evictedCount: number, size: number) => void,
  batch?: { fold: FoldBatch; pos: number },
  /** D-016: the log position being applied, stamped on any deferral the apply makes. */
  source?: DeferralSource,
): Promise<MergeApplyOutcome> {
  const ident = opIdent(groupKey, env);
  // WI-10003506: a held structural deferral inside its backoff window is not re-run against
  // PG. The stored outcome is returned as-is, so the caller holds the cursor and records the
  // failure exactly as a real attempt would; applyThrows counts real attempts only. An apply
  // still in flight for this op is always awaited instead (its outcome is newer).
  const deferral = cursor.applyDeferrals?.get(ident);
  if (deferral && !cursor.pendingApplies?.has(ident) && Date.now() < deferral.retryAt) {
    return deferral.outcome;
  }
  let outcome: MergeApplyOutcome;
  let batchOpId = 0;
  let timedOut = false;
  try {
    // Single-flight identities for physical writes; admission controls their start
    // and their actual result removes the entry, including after a caller timeout.
    const inFlightApplies = (cursor.pendingApplies ??= new Map<string, PendingMergeApply>());
    let physical = inFlightApplies.get(ident);
    if (!physical) {
      // WI-10003427: never wait for admission while holding an open batch transaction. The
      // gate is process-wide, so the wait can outlast Postgres's idle-in-transaction timeout;
      // the server then kills the batch connection and postgres.js strands every statement
      // queued on it, which hung the next op inside its slot forever. Take a free slot now,
      // or commit the batch before queueing (a lost commit fails the batch; the fold replays).
      let slot = mergeApplyAdmission.tryAcquire();
      if (!slot && batch?.fold.holdsTransaction) await batch.fold.commit();
      // A reused in-flight apply (above) started outside this batch and autocommits,
      // so only a fresh apply is bound to the batch.
      const bound = batch ? batch.fold.beginOp(batch.pos, apply) : null;
      if (bound) batchOpId = bound.opId;
      const run = bound ? bound.apply : apply;
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let settleResult: (write: Promise<boolean | MergeApplyOutcome>) => void = () => {};
      const result = new Promise<boolean | MergeApplyOutcome>((resolve) => {
        settleResult = resolve;
      });
      const entry: PendingMergeApply = { started, admitted: false, result };
      const admitted = async (): Promise<void> => {
        // Queue time is safe backpressure, not a slow PG write. Start both the
        // named-stage clock and the hard apply timeout only after admission.
        entry.admitted = true;
        markStarted();
        // D-016: entered here, after admission, so the source is this op's and never that
        // of whichever apply released the admission slot.
        const write = logIfStageStalls(
          scope,
          `merge-apply (${groupKey})`,
          Promise.resolve().then(() => runWithDeferralSource(source, () => run(env))),
        );
        settleResult(write);
        await holdMergeApplySlot(groupKey, write, applyTimeoutMs);
      };
      let admission: Promise<void>;
      if (slot) {
        const release = slot;
        slot = null;
        admission = admitted().finally(release);
      } else {
        admission = mergeApplyAdmission.run(admitted);
      }
      void admission.catch((err: unknown) => settleResult(Promise.reject(err)));
      physical = entry;
      inFlightApplies.set(ident, physical);
      const current = physical;
      void result.finally(() => {
        if (inFlightApplies.get(ident) === current) inFlightApplies.delete(ident);
      }).catch(() => {});
    } else if (!physical.admitted && batch?.fold.holdsTransaction) {
      // The same rule for a queued write reused from an earlier pass.
      await batch.fold.commit();
    }
    await physical.started;
    const result = await raceApplyTimeout(groupKey, physical.result, applyTimeoutMs);
    outcome = typeof result === 'boolean' ? { kind: 'applied', changed: result } : result;
  } catch (err) {
    timedOut = err instanceof MergeApplyTimeoutError;
    const code = (err as { code?: unknown } | null)?.code;
    outcome = {
      kind: isStructuralApplyFailure(err) ? 'dependency-waiting' : 'retryable',
      reason: (err instanceof Error ? err.message : String(err)).replaceAll('\0', '').slice(0, 512),
      ...(typeof code === 'string' ? { errorCode: code } : {}),
    };
  }
  // P-002 step 2: an op that wrote into the batch transaction keeps its winner
  // provisional until COMMIT (FoldBatch.commit records it then).
  const provisional =
    batch && batchOpId !== 0
      ? await batch.fold.endOp(batchOpId, outcome.kind === 'applied', timedOut, groupKey, env, ident)
      : false;
  if (outcome.kind === 'applied') {
    cursor.applyDeferrals?.delete(ident);
    if (!provisional) {
      cursor.applyThrows?.delete(ident);
      recordWinner(cursor, groupKey, toMeta(env), maxWinnersEntries, onWinnersEvicted);
    }
  } else {
    const counts = (cursor.applyThrows ??= new Map());
    const n = (counts.get(ident) ?? 0) + 1;
    counts.set(ident, n);
    // WI-10003506: only a STRUCTURAL deferral backs off. It resolves when a missing row
    // arrives, which no immediate retry can hasten. A retryable failure keeps its own
    // bounded handling, and a rejection is a dead letter that never touches PG again.
    if (outcome.kind === 'dependency-waiting') {
      (cursor.applyDeferrals ??= new Map()).set(ident, {
        retryAt: Date.now() + dependencyRetryDelayMs(n),
        outcome,
      });
    } else {
      cursor.applyDeferrals?.delete(ident);
    }
    if (n === 1 || n % 100 === 0) {
      console.warn(`[read-merge] ${outcome.kind === 'dependency-waiting' ? 'structural apply deferral' : 'unapplied entry'} (${n}×): ${scope} ${groupKey}; cursor HELD for replay`, outcome.reason);
    }
    if (n === APPLY_FAILURE_ALERT_AFTER || n % 100 === 0) {
      console.error(`[read-merge] UNAPPLIED BACKLOG: ${scope} ${groupKey} (${outcome.kind}, ${n}×); materialization incomplete, original log entry retained`, outcome.reason);
    }
  }
  return outcome;
}

/**
 * P-002 step 2 (p2p-join-catchup-speed D-002) — batched fold commits.
 *
 * Measured on the P-203 VM (WI-10002779): every folded op was its own autocommit
 * transaction, costing an xid, a WAL record and a synchronous commit flush. That
 * held true even for the common no-op, because `ON CONFLICT ... WHERE` locks the
 * row when its WHERE is false. A serial await-per-op loop peaked at about 47 ops/s.
 *
 * A {@link FoldBatch} folds a window of ops into ONE transaction on a reserved
 * connection, with one SAVEPOINT per op, so every per-op outcome stays exactly
 * what the serial path produces: a failed op rolls back to its savepoint (its
 * deferral / apply_failure is recorded as before) and later ops keep applying.
 * The winners of ops that wrote into the transaction are PROVISIONAL (an overlay)
 * until COMMIT is confirmed. The one unsafe direction is recording a winner whose
 * write rolled back: the op would then be skipped forever (WI-255). It cannot
 * happen here, because a lost batch discards the overlay and rewinds the cursor to
 * the batch's first op. The replay is idempotent under LWW.
 *
 * Only projections that declare `batchable` join the transaction (via
 * `projectionSql`). Any other projection's write first commits the open batch.
 */
export const MERGE_BATCH_MAX_OPS = 50;
/** Bounds how long a batch's row locks can hold up a local writer (ms). */
export const MERGE_BATCH_MAX_MS = 500;
/** Bound on the COMMIT round trip (ms); past it the batch counts as lost and is replayed. */
export const MERGE_BATCH_COMMIT_TIMEOUT_MS = 30_000;
/**
 * Bound on waiting for a batch's reserved connection (ms). postgres.js queues
 * `reserve()` with no deadline, and a batch's COMMIT awaits the same open, so a grant
 * that never comes stalls the op, its lane and the whole snapshot chunk for good.
 * Measured (P-007 run #6): a lane op waited from 16:40Z on, with every pool
 * connection idle and no lane transaction open, and the set crossing never resumed.
 * Past the bound the op writes on the plain handle (autocommit), as the serial path
 * does, and a connection granted later goes straight back to the pool.
 */
export const MERGE_BATCH_RESERVE_TIMEOUT_MS = 5_000;
/** After a reserve times out, that batch's ops autocommit for this long before it reserves again (ms). */
export const MERGE_BATCH_RESERVE_BACKOFF_MS = 30_000;

/**
 * P-525 (p2p-join-catchup-speed D-013): a batch opened while its log is at least
 * this many ops behind, or while it applies snapshot rows, sets
 * {@link SYNC_NOTIFY_COALESCE_GUC}. emit_change_notify (mig 1213) then sends one
 * table-scoped sync_invalidate per table per transaction instead of one per row.
 * Measured on the P-007 VM: handling the per-row echoes of a snapshot-set crossing
 * was 22.8% of the main thread. Below the bound (live catch-up), per-row scoped
 * invalidation is kept because it is more precise.
 */
export const MERGE_COALESCE_NOTIFY_MIN_BACKLOG = 256;
export const SYNC_NOTIFY_COALESCE_GUC = 'papercusp.sync_notify_coalesce';

/**
 * P-527 (p2p-join-catchup-speed D-014): a snapshot-set chunk is applied on this many
 * parallel lanes, each with its own batch transaction. Measured on the P-007 VM (run
 * #4): a set crossing ran at ~259 rows/s while using about 1.4 of 8 cores, and turning
 * synchronous_commit off changed nothing (223 vs 215 rows/s). So each row waits on a
 * serial chain of round trips, not on a saturated resource. The rows of one chunk are
 * distinct keys of one set, so they can be applied in any order. Capped at the merge
 * apply admission limit, which bounds how many applies run at once anyway.
 */
export const MERGE_SNAPSHOT_LANES = 4;
/** A chunk with fewer applicable rows than this is applied serially. */
export const MERGE_SNAPSHOT_LANE_MIN_ROWS = 32;

/** P-527: one applicable snapshot row, routed to a lane. */
interface LaneRow {
  env: OpEnvelope;
  groupKey: string;
}

/**
 * P-527: split one chunk's applicable rows over `k` lanes. Every row joins the shortest
 * lane. A key seen twice stays on one lane, so two lanes never write the same row.
 *
 * WI-N work items spread like any other row. A WI-N INSERT takes the id-sequence floor
 * lock only when it raises the floor (migration 1218); below the floor, which is almost
 * every row of a set, it takes no lock. A lane that does take it holds it to its next
 * COMMIT, so a sibling waits at most one batch, and a lane commits as soon as its queue
 * drains (applyChunkOnLanes) rather than holding the lock while it waits for the others.
 */
function partitionSnapshotRows(rows: readonly LaneRow[], k: number): LaneRow[][] {
  const lanes: LaneRow[][] = Array.from({ length: k }, () => []);
  const laneOf = new Map<string, number>();
  for (const row of rows) {
    let lane = laneOf.get(row.groupKey);
    if (lane === undefined) {
      lane = 0;
      for (let i = 1; i < k; i++) if (lanes[i].length < lanes[lane].length) lane = i;
      laneOf.set(row.groupKey, lane);
    }
    lanes[lane].push(row);
  }
  return lanes;
}

export interface MergeBatchOpts {
  /**
   * Commit after this many ops wrote into the batch. Keep it under 64, PG's
   * per-backend cache of subtransaction ids: past it every concurrent snapshot
   * pays subtrans lookups for as long as the transaction stays open.
   */
  maxOps?: number;
  /** Commit once the batch has been open this long (ms). */
  maxMs?: number;
  /** Bound on the COMMIT round trip (ms). */
  commitTimeoutMs?: number;
  /** Bound on waiting for the batch connection (ms). Default {@link MERGE_BATCH_RESERVE_TIMEOUT_MS}; 0 waits forever. */
  reserveTimeoutMs?: number;
  /** P-527: parallel lanes for one snapshot chunk. Default {@link MERGE_SNAPSHOT_LANES}; 1 applies chunks serially. */
  snapshotLanes?: number;
}

/** Batch counters for one incremental pass. */
export interface MergeBatchStats {
  /** Batch transactions committed. */
  commits: number;
  /** Ops that applied inside a committed batch. */
  ops: number;
  /** Batches lost (commit or savepoint failure, or an apply timeout inside one) and replayed from their first op. */
  rewinds: number;
  /** P-536: records written by a group write ({@link ProjectionGroupWriter.writeMany}). */
  grouped: number;
  /** P-536: groups whose write failed and were replayed record by record. */
  groupReplays: number;
}

type MergeApplyFn = (op: OpEnvelope) => Promise<boolean | MergeApplyOutcome>;

/** A batch the fold must replay: its transaction could not commit. */
export class MergeBatchLostError extends Error {
  constructor(reason: string) {
    super(`read-merge batch transaction lost: ${reason}`);
    this.name = 'MergeBatchLostError';
  }
}

const BATCH_SAVEPOINT = 'read_merge_op';
/** P-536: one group write, and one record of a group being replayed record by record. */
const GROUP_SAVEPOINT = 'read_merge_group';
const GROUP_ROW_SAVEPOINT = 'read_merge_group_row';

/** P-536: the records one writer's group holds, in the order their ops handed them over. */
interface PendingGroup {
  records: { opId: number; record: unknown }[];
  rows: Set<string>;
}

class FoldBatch {
  private reserved: postgres.ReservedSql | null = null;
  private target: postgres.Sql | null = null;
  private opening: Promise<void> | null = null;
  private txGen = 0;
  private pipelined: Promise<unknown>[] = [];
  /** Provisional winners in apply order (re-inserted per apply, like recordWinner's MRU order). */
  private readonly overlay = new Map<string, { meta: WinnerMeta; ident: string }>();
  /** Timed-out ops whose statements may still be running inside a lost transaction. */
  private readonly poisoned = new Set<string>();
  /** P-536: records waiting for their writer's group write, per writer in first-use order. */
  private readonly groups = new Map<ProjectionGroupWriter<unknown>, PendingGroup>();
  /** P-537: effects ops queued until the open transaction commits, in op order. */
  private afterCommitHooks: { opId: number; fn: () => Promise<void> }[] = [];
  private currentOp = 0;
  private nextOpId = 1;
  private opPos = -1;
  /** The current op wrote into transaction {@link opTxGen}: a savepoint's statements, or a record handed to a group. */
  private opTouched = false;
  private opTxGen = -1;
  /** The transaction the current op's savepoint lives in; -1 when it has none. */
  private opSavepointGen = -1;
  /** P-536: a group write included one of the current op's records before the op ended. */
  private opGroupWritten = false;
  private opsInTx = 0;
  private openedAt = 0;
  private failureReason: string | null = null;
  /** Until this time (ms) ops autocommit instead of reserving: a reserve timed out. */
  private reserveBackoffUntil = 0;
  /** Log position of the first op whose writes sit in the open transaction; -1 when none do. */
  startPos = -1;
  /**
   * P-525: set by the fold before each op. Read when a transaction opens, so it
   * holds for that whole transaction ({@link MERGE_COALESCE_NOTIFY_MIN_BACKLOG}).
   */
  coalesceNotify = false;
  /**
   * P-536 (D-034 #1): ops may hand their records to a group write ({@link ProjectionGroupWriter}).
   * Set on snapshot lane batches only. A group reports a refused record as applied, which
   * the tail's P-528 superseded-put skip cannot allow; a snapshot chunk skips no puts.
   */
  groupWrites = false;
  readonly stats: MergeBatchStats;
  /** P-527: sibling batches for the lanes of a snapshot chunk, created on first use. */
  private readonly lanes: FoldBatch[] = [];

  constructor(
    private readonly cursor: MergeCursor,
    private readonly maxOps: number,
    private readonly maxMs: number,
    private readonly commitTimeoutMs: number,
    private readonly reserveTimeoutMs: number,
    private readonly maxWinnersEntries: number,
    private readonly onWinnersEvicted?: (evictedCount: number, size: number) => void,
    stats?: MergeBatchStats,
  ) {
    this.stats = stats ?? { commits: 0, ops: 0, rewinds: 0, grouped: 0, groupReplays: 0 };
  }

  /**
   * P-527: `k` batches with this batch's bounds, one per lane, that count into this
   * batch's stats. Each has its own connection, savepoints and provisional winners.
   * Reused across chunks; the lanes commit before a chunk ends, so none is open between chunks.
   */
  laneBatches(k: number): FoldBatch[] {
    while (this.lanes.length < k) {
      const lane = new FoldBatch(
        this.cursor,
        this.maxOps,
        this.maxMs,
        this.commitTimeoutMs,
        this.reserveTimeoutMs,
        this.maxWinnersEntries,
        this.onWinnersEvicted,
        this.stats,
      );
      lane.groupWrites = true;
      this.lanes.push(lane);
    }
    return this.lanes.slice(0, k);
  }

  /** The open transaction can no longer commit; the fold must replay from {@link startPos}. */
  get failed(): boolean {
    return this.failureReason !== null;
  }

  get reason(): string {
    return this.failureReason ?? 'unknown';
  }

  /** A transaction is open, or opening, on a reserved connection (WI-10003427). */
  get holdsTransaction(): boolean {
    return this.reserved !== null || this.opening !== null;
  }

  /**
   * WI-10003427: run one statement on the reserved connection and wait at most the batch
   * deadline for it. postgres.js 3.4.9 queues a statement issued while the connection is busy
   * in a private queue that nothing drains or rejects once the server closes the connection
   * (measured: an idle-in-transaction kill), so an unbounded await here never settles.
   */
  private async stmt(reserved: postgres.ReservedSql, text: string): Promise<void> {
    await raceMergeDeadline(reserved.unsafe(text), this.commitTimeoutMs, `batch ${text}`);
  }

  /** The open transaction reached its op or age bound. */
  get due(): boolean {
    return this.reserved !== null && (this.opsInTx >= this.maxOps || Date.now() - this.openedAt >= this.maxMs);
  }

  /** The provisional winner for `groupKey`, which outranks `cursor.winners` while the batch is open. */
  provisional(groupKey: string): WinnerMeta | undefined {
    return this.overlay.get(groupKey)?.meta;
  }

  /** Bind `apply` to a fresh op at log position `pos`. */
  beginOp(pos: number, apply: MergeApplyFn): { opId: number; apply: MergeApplyFn } {
    const opId = this.nextOpId++;
    this.currentOp = opId;
    this.opPos = pos;
    this.opTouched = false;
    this.opTxGen = -1;
    this.opSavepointGen = -1;
    this.opGroupWritten = false;
    const session: ProjectionBatchSession = {
      sqlFor: (target) => this.sqlFor(opId, target),
      flush: () => this.flushFor(opId),
      recover: () => this.recoverFor(opId),
      defer: (target, writer, record) => this.deferFor(opId, target, writer, record),
      afterCommit: (fn) => this.afterCommitFor(opId, fn),
    };
    return { opId, apply: (env) => runInProjectionBatch(session, () => apply(env)) };
  }

  /**
   * Close op `opId`. Returns true when its writes sit in the batch transaction, so
   * its winner must stay provisional until COMMIT. False means it wrote nothing
   * there (autocommitted like the serial path) and may be recorded now.
   */
  async endOp(
    opId: number,
    applied: boolean,
    timedOut: boolean,
    groupKey: string,
    env: OpEnvelope,
    ident: string,
  ): Promise<boolean> {
    if (opId !== this.currentOp) return false;
    this.currentOp = 0;
    if (!this.opTouched) return false;
    const reserved = this.reserved;
    if (!reserved || this.opTxGen !== this.txGen) {
      // The transaction this op wrote into is gone. It was committed mid-op
      // (durable, so record now) unless the batch failed (keep provisional; the
      // rewind discards it).
      return this.failureReason !== null;
    }
    // An op that only handed records to a group has no savepoint of its own.
    const savepoint = this.opSavepointGen === this.txGen;
    if (applied) {
      if (savepoint) this.pipe(reserved.unsafe(`RELEASE SAVEPOINT ${BATCH_SAVEPOINT}`));
      this.overlay.delete(groupKey);
      this.overlay.set(groupKey, { meta: toMeta(env), ident });
      this.opsInTx++;
      return true;
    }
    if (timedOut) {
      // Its statement is still running on the batch connection, so nothing sent
      // behind it could be awaited. Lose the batch; the fold replays it.
      this.fail(`apply timed out inside the batch transaction (${groupKey})`);
      this.poisoned.add(ident);
      return true;
    }
    // Take back what the op wrote. A record a group already wrote cannot be taken back
    // on its own, so the batch is lost and the fold replays it outside any batch.
    if (this.opGroupWritten) {
      this.fail(`an op that did not apply already had its record written by a group (${groupKey})`);
      return true;
    }
    this.dropGroupRecords(opId);
    this.afterCommitHooks = this.afterCommitHooks.filter((h) => h.opId !== opId);
    if (!savepoint) return true;
    try {
      await this.stmt(reserved, `ROLLBACK TO SAVEPOINT ${BATCH_SAVEPOINT}`);
      await this.stmt(reserved, `RELEASE SAVEPOINT ${BATCH_SAVEPOINT}`);
    } catch (err) {
      this.fail(err);
    }
    return true;
  }

  /**
   * Commit the open transaction and promote its provisional winners. Returns false
   * when the batch is lost; the caller must then {@link discard} and replay.
   */
  async commit(): Promise<boolean> {
    if (this.opening) await this.opening;
    const reserved = this.reserved;
    if (!reserved) return this.failureReason === null;
    // P-536: the records the groups hold belong to this transaction.
    if (this.failureReason === null && this.groups.size > 0) await this.writeGroups();
    this.groups.clear();
    this.reserved = null;
    this.target = null;
    const pipelined = this.pipelined;
    this.pipelined = [];
    // P-537: a lost transaction drops its hooks; the replayed ops queue them again.
    const hooks = this.afterCommitHooks;
    this.afterCommitHooks = [];
    if (this.failureReason === null) {
      try {
        await raceMergeDeadline(Promise.all(pipelined), this.commitTimeoutMs, 'batch statements');
        if (this.failureReason !== null) throw new Error(this.failureReason);
        const res = await raceMergeDeadline(reserved.unsafe('COMMIT'), this.commitTimeoutMs, 'batch COMMIT');
        // PG answers COMMIT on an aborted transaction with the ROLLBACK tag, not an error.
        if (res.command !== 'COMMIT') {
          throw new Error(`the batch transaction ended as ${res.command ?? 'unknown'}; one of its statements failed`);
        }
      } catch (err) {
        this.fail(err);
      }
    }
    if (this.failureReason !== null) {
      abandonReserved(reserved);
      return false;
    }
    reserved.release();
    for (const [groupKey, { meta, ident }] of this.overlay) {
      this.cursor.applyThrows?.delete(ident);
      this.cursor.applyDeferrals?.delete(ident);
      recordWinner(this.cursor, groupKey, meta, this.maxWinnersEntries, this.onWinnersEvicted);
    }
    this.overlay.clear();
    this.stats.commits++;
    this.stats.ops += this.opsInTx;
    this.opsInTx = 0;
    this.startPos = -1;
    await this.runAfterCommitHooks(hooks);
    return true;
  }

  /**
   * P-537: queue `fn` when op `opId`'s writes sit in the open transaction; false when they
   * do not (nothing written yet, autocommitted, or the batch is lost), so the op runs it now.
   */
  private afterCommitFor(opId: number, fn: () => Promise<void>): boolean {
    if (opId !== this.currentOp || this.failureReason !== null || this.reserved === null) return false;
    if (!this.opTouched || this.opTxGen !== this.txGen) return false;
    this.afterCommitHooks.push({ opId, fn });
    return true;
  }

  /**
   * P-537: run a committed transaction's hooks in op order. Each is a best-effort effect
   * the serial path ran inside its apply: one failing never stops the rest, and one
   * outliving the commit deadline keeps running without holding up the fold.
   */
  private async runAfterCommitHooks(hooks: readonly { fn: () => Promise<void> }[]): Promise<void> {
    for (const { fn } of hooks) {
      try {
        await raceMergeDeadline(runOutsideProjectionBatch(fn), this.commitTimeoutMs, 'after-commit effect');
      } catch (err) {
        console.warn(`[read-merge] after-commit effect failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Drop a lost batch: roll back what is open, forget its provisional winners and its poisoned in-flight applies. */
  discard(): void {
    for (const lane of this.lanes) lane.discard();
    const hadWork = this.reserved !== null || this.overlay.size > 0 || this.failureReason !== null;
    if (this.reserved) abandonReserved(this.reserved);
    this.reserved = null;
    this.target = null;
    this.pipelined = [];
    this.groups.clear();
    this.afterCommitHooks = [];
    for (const ident of this.poisoned) this.cursor.pendingApplies?.delete(ident);
    this.poisoned.clear();
    this.overlay.clear();
    this.opsInTx = 0;
    this.startPos = -1;
    this.failureReason = null;
    if (hadWork) this.stats.rewinds++;
  }

  private fail(err: unknown): void {
    this.failureReason ??= (err instanceof Error ? err.message : String(err)).replaceAll('\0', '').slice(0, 400);
  }

  private pipe(q: postgres.PendingQuery<postgres.Row[]>): void {
    // Sent now, awaited at COMMIT: SAVEPOINT / RELEASE cost no extra wait per op.
    this.pipelined.push(q.execute().catch((err: unknown) => this.fail(err)));
  }

  private async open(target: postgres.Sql): Promise<void> {
    try {
      const pending = target.reserve();
      let reserved: postgres.ReservedSql;
      try {
        reserved = await raceMergeDeadline(pending, this.reserveTimeoutMs, 'batch connection reserve');
      } catch (err) {
        // A connection granted after the deadline goes straight back to the pool.
        void pending.then((late) => late.release(), () => {});
        this.reserveBackoffUntil = Date.now() + MERGE_BATCH_RESERVE_BACKOFF_MS;
        console.warn(
          `[read-merge] batch connection not granted (${err instanceof Error ? err.message : String(err)}); ops autocommit for ${MERGE_BATCH_RESERVE_BACKOFF_MS}ms`,
        );
        throw err;
      }
      this.reserved = reserved;
      this.target = target;
      this.txGen++;
      this.openedAt = Date.now();
      this.startPos = this.opPos;
      this.pipe(reserved.unsafe('BEGIN'));
      // Before any SAVEPOINT, so a per-op rollback cannot undo it; COMMIT clears it.
      if (this.coalesceNotify) this.pipe(reserved.unsafe(`SELECT set_config('${SYNC_NOTIFY_COALESCE_GUC}', 'on', true)`));
    } catch {
      // No connection, no transaction: this op simply autocommits.
    } finally {
      this.opening = null;
    }
  }

  private async sqlFor(opId: number, target: postgres.Sql): Promise<postgres.Sql> {
    // A timed-out op still running, or a batch that can no longer commit, writes
    // on the plain handle (autocommit), exactly as the serial path does.
    if (opId !== this.currentOp || this.failureReason !== null) return target;
    if (this.reserved && this.target !== target && !(await this.commit())) return target;
    if (!this.reserved) {
      if (Date.now() < this.reserveBackoffUntil) return target;
      this.opening ??= this.open(target);
      await this.opening;
    }
    // P-536: records handed over before this statement are written first, so the
    // connection sees every write in the order its op made it.
    if (this.groups.size > 0 && !(await this.writeGroups())) return target;
    const reserved = this.reserved;
    if (!reserved || opId !== this.currentOp || this.failureReason !== null) return target;
    if (this.opSavepointGen !== this.txGen) {
      this.opTouched = true;
      this.opTxGen = this.txGen;
      this.opSavepointGen = this.txGen;
      this.pipe(reserved.unsafe(`SAVEPOINT ${BATCH_SAVEPOINT}`));
    }
    const gen = this.txGen;
    return this.guard(
      reserved,
      () => opId === this.currentOp && gen === this.txGen && this.reserved === reserved && this.failureReason === null,
    );
  }

  /**
   * P-536: take `record` into the pending group for `writer`, to be written with the
   * group's other records before this transaction commits. False when this batch runs
   * no groups or could not take it; the op then writes the record itself.
   */
  private async deferFor(
    opId: number,
    target: postgres.Sql,
    writer: ProjectionGroupWriter<unknown>,
    record: unknown,
  ): Promise<boolean> {
    if (!this.groupWrites || opId !== this.currentOp || this.failureReason !== null) return false;
    if (this.reserved && this.target !== target && !(await this.commit())) return false;
    if (!this.reserved) {
      if (Date.now() < this.reserveBackoffUntil) return false;
      this.opening ??= this.open(target);
      await this.opening;
    }
    const row = writer.rowOf(record);
    // A group never holds two records for one row: the later record's reads must see
    // the earlier one's write, so the group is written first.
    if (this.groups.get(writer)?.rows.has(row) && !(await this.writeGroups())) return false;
    if (!this.reserved || opId !== this.currentOp || this.failureReason !== null) return false;
    let group = this.groups.get(writer);
    if (!group) {
      group = { records: [], rows: new Set() };
      this.groups.set(writer, group);
    }
    group.records.push({ opId, record });
    group.rows.add(row);
    this.opTouched = true;
    this.opTxGen = this.txGen;
    return true;
  }

  /** P-536: forget the records op `opId` handed over (the op did not apply). */
  private dropGroupRecords(opId: number): void {
    for (const [writer, group] of this.groups) {
      const kept = group.records.filter((r) => r.opId !== opId);
      if (kept.length === group.records.length) continue;
      if (kept.length === 0) {
        this.groups.delete(writer);
        continue;
      }
      group.records = kept;
      group.rows = new Set(kept.map((r) => writer.rowOf(r.record)));
    }
  }

  /**
   * P-536: write every pending group on the open transaction, each under its own
   * savepoint. A group whose write fails rolls back to that savepoint and is written
   * again record by record through {@link ProjectionGroupWriter.writeOne}, exactly as
   * each op would have written it alone. A record that fails there too loses the batch,
   * and the fold replays the window outside any batch. False when the batch is lost.
   */
  private async writeGroups(): Promise<boolean> {
    const reserved = this.reserved;
    const groups = [...this.groups];
    this.groups.clear();
    if (!reserved) {
      // Records are only taken while a transaction is open, and both ways it closes clear them.
      if (groups.length > 0) this.fail('group records outlived their transaction');
      return this.failureReason === null;
    }
    const gen = this.txGen;
    const sql = this.guard(
      reserved,
      () => gen === this.txGen && this.reserved === reserved && this.failureReason === null,
    );
    for (const [writer, group] of groups) {
      if (this.failureReason !== null) return false;
      if (this.currentOp !== 0 && group.records.some((r) => r.opId === this.currentOp)) this.opGroupWritten = true;
      const records = group.records.map((r) => r.record);
      this.pipe(reserved.unsafe(`SAVEPOINT ${GROUP_SAVEPOINT}`));
      let failure: string;
      try {
        await raceMergeDeadline(writer.writeMany(sql, records), this.commitTimeoutMs, `${writer.name} group write`);
        this.pipe(reserved.unsafe(`RELEASE SAVEPOINT ${GROUP_SAVEPOINT}`));
        this.stats.grouped += records.length;
        continue;
      } catch (err) {
        failure = (err instanceof Error ? err.message : String(err)).replaceAll('\0', '').slice(0, 400);
      }
      if (this.failureReason !== null) return false;
      this.stats.groupReplays++;
      console.warn(
        `[read-merge] P-536 ${writer.name}: a group write of ${records.length} record(s) failed (${failure}); ` +
          `writing them one at a time`,
      );
      try {
        await this.stmt(reserved, `ROLLBACK TO SAVEPOINT ${GROUP_SAVEPOINT}`);
      } catch (err) {
        this.fail(err);
        return false;
      }
      for (const record of records) {
        this.pipe(reserved.unsafe(`SAVEPOINT ${GROUP_ROW_SAVEPOINT}`));
        const session: ProjectionBatchSession = {
          sqlFor: async () => sql,
          flush: async () => {
            throw new MergeBatchLostError('a group record cannot commit its batch');
          },
          recover: async () => {
            await this.stmt(reserved, `ROLLBACK TO SAVEPOINT ${GROUP_ROW_SAVEPOINT}`);
          },
        };
        try {
          await raceMergeDeadline(
            runInProjectionBatch(session, () => writer.writeOne(record)),
            this.commitTimeoutMs,
            `${writer.name} record write`,
          );
        } catch (err) {
          this.fail(err);
          return false;
        }
        this.pipe(reserved.unsafe(`RELEASE SAVEPOINT ${GROUP_ROW_SAVEPOINT}`));
      }
      this.pipe(reserved.unsafe(`RELEASE SAVEPOINT ${GROUP_SAVEPOINT}`));
    }
    return this.failureReason === null;
  }

  /**
   * A handle that refuses once `live` is false: its op is over or its transaction is
   * gone. An op that timed out keeps running and keeps this handle. Unguarded, its next
   * statement would run on a connection already handed back to the pool, possibly
   * inside another caller's transaction.
   */
  private guard(reserved: postgres.ReservedSql, live: () => boolean): postgres.Sql {
    const check = (): void => {
      if (!live()) throw new MergeBatchLostError('statement issued after its op or batch ended');
    };
    return new Proxy(reserved, {
      apply: (t, thisArg, args) => {
        check();
        return Reflect.apply(t, thisArg, args);
      },
      get: (t, prop, recv) => {
        const v: unknown = Reflect.get(t, prop, recv);
        if (typeof v !== 'function') return v;
        if (prop === 'unsafe' || prop === 'file') {
          return (...a: unknown[]) => {
            check();
            return (v as (...x: unknown[]) => unknown).apply(t, a);
          };
        }
        return (v as (...x: unknown[]) => unknown).bind(t);
      },
    }) as unknown as postgres.Sql;
  }

  private async flushFor(opId: number): Promise<void> {
    if (opId !== this.currentOp) return;
    if (!(await this.commit())) throw new MergeBatchLostError(this.reason);
  }

  /**
   * The projection caught a statement error and will keep going. Roll the op back
   * to its savepoint (which stays in place), so the aborted transaction accepts
   * statements again. When the op wrote nothing into the batch there is nothing to
   * recover; when the batch is gone its next statement refuses on its own.
   */
  private async recoverFor(opId: number): Promise<void> {
    const reserved = this.reserved;
    if (opId !== this.currentOp || !reserved || this.opSavepointGen !== this.txGen) return;
    if (this.failureReason !== null) return;
    // P-536: rolling back could not take back a record a group already wrote for this op.
    if (this.opGroupWritten) {
      this.fail('an op rolled back to its savepoint after a group wrote one of its records');
      return;
    }
    try {
      await this.stmt(reserved, `ROLLBACK TO SAVEPOINT ${BATCH_SAVEPOINT}`);
    } catch (err) {
      this.fail(err);
    }
  }
}

/** Roll back whatever a lost batch left open and hand the connection back once that settles. */
function abandonReserved(reserved: postgres.ReservedSql): void {
  // Queued behind any statement still running on this connection, so the release
  // waits for it; ROLLBACK after a completed COMMIT is a harmless warning.
  const rollback = Promise.resolve(reserved.unsafe('ROLLBACK'));
  void rollback.catch(() => {}).finally(() => reserved.release());
  // WI-10003427: nothing awaits this, but a ROLLBACK stranded in postgres.js's reserve queue
  // (the server closed the connection) never settles, so the connection is never handed
  // back. Keeping it out of the pool is deliberate (its transaction state is unknown); say so.
  const timer = setTimeout(() => {
    console.error(
      `[read-merge] abandoned batch connection: ROLLBACK unanswered after ${MERGE_BATCH_COMMIT_TIMEOUT_MS}ms; ` +
        `the connection stays out of the pool until it settles (WI-10003427)`,
    );
  }, MERGE_BATCH_COMMIT_TIMEOUT_MS);
  timer.unref?.();
  void rollback.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  );
}

async function raceMergeDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  if (ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    p.catch(() => {});
  }
}

/** A log the incremental merge can OPTIONALLY range-prefetch (RemoteLog does;
 *  the own log + in-memory test logs don't). Feature-detected per log. */
interface PrefetchableLog extends AdmittedLog {
  prefetch?(start: number, end: number): PrefetchRange | undefined;
}

/** P-533: a ranged prefetch the caller can withdraw. `cancel()` detaches the range, so
 *  the blocks it has not requested yet are never fetched (RemoteLog returns one). */
export interface PrefetchRange {
  cancel(): void;
}

/** P-533: one fold pass's EI-92 range, kept so a jump can withdraw it. */
interface PassRange {
  start: number;
  range: PrefetchRange | null;
}

/** P-533: one read the caller can withdraw. `cancel()` settles `op` (it rejects) and
 *  withdraws the block request from the network, so an unwanted block is not fetched. */
export interface CancellableRead {
  op: Promise<PeerLogOp | null>;
  cancel(): void;
}

/** P-533: a log whose reads can be cancelled one by one (RemoteLog can). Feature-detected
 *  per log, like `prefetch`; the look-ahead falls back to plain `get` without it. */
export interface CancellableReadLog extends AdmittedLog {
  getCancellable?(i: number): CancellableRead;
}

/**
 * WI-10003427: where an incremental pass is RIGHT NOW. Mutated in place by the
 * pass; `keyHex` is null before the first log is entered. `phaseSince` is the
 * epoch-ms the current phase began.
 */
export interface MergeProgressProbe {
  keyHex: string | null;
  pos: number;
  phase: string;
  phaseSince: number;
}

export function createMergeProgressProbe(): MergeProgressProbe {
  return { keyHex: null, pos: 0, phase: 'idle', phaseSince: Date.now() };
}

/** One-line rendering for a stall report: `log 5b00878b@7813646 phase 'settle-batch' for 42s`. */
export function describeMergeProgress(probe: MergeProgressProbe, now: number = Date.now()): string {
  if (probe.keyHex === null) return `no log entered yet (phase '${probe.phase}')`;
  return (
    `log ${probe.keyHex.slice(0, 8)}@${probe.pos} phase '${probe.phase}' ` +
    `for ${Math.max(0, Math.round((now - probe.phaseSince) / 1000))}s`
  );
}

export interface IncrementalMergeOpts {
  /** Override the apply sink (defaults to `applyHyperbeeOpToPg`). */
  applyImpl?: (op: OpEnvelope) => Promise<boolean | MergeApplyOutcome>;
  /** Per-op read timeout (ms) — same semantics as MergeOpts.getTimeoutMs. */
  getTimeoutMs?: number;
  /** WI-3896: per-op APPLY timeout (ms) — bounds a single `apply(env)` write so a
   *  hung one can't wedge the whole merge loop forever. Default `MERGE_APPLY_
   *  TIMEOUT_MS`; `<= 0` disables the bound (today's unbounded-await behavior). */
  applyTimeoutMs?: number;
  /**
   * P-002 step 2 (p2p-join-catchup-speed D-002): fold a window of ops into one
   * transaction with a savepoint per op (see {@link FoldBatch}). ON by default;
   * `false` restores one autocommit transaction per op. Only projections that
   * declare `batchable` join the transaction, so an `applyImpl` that never calls
   * `projectionSql` behaves exactly as with `false`.
   */
  batchApply?: false | MergeBatchOpts;
  /**
   * Per-LOG per-PASS read budget (the old `maxOpsPerAuthor` reshaped). A pass
   * advances each log's cursor by at most this many ops; the remainder is
   * picked up by the NEXT pass — so unlike the legacy cap, history beyond the
   * budget is delayed, never lost (EI-91). `<= 0` disables the bound.
   */
  maxOpsPerPass?: number;
  /** Fires once per pass per log that still has backlog beyond this pass. */
  onBacklog?: (keyHex: string, position: number, length: number) => void;
  /**
   * WI-2105 REV fix — fired DURING a pass (at `MERGE_PERSIST_EVERY_OPS` cadence)
   * and after each log that advanced, with the cursor's CURRENT positions, so
   * the caller can persist fold progress to PG. Fired only after the ops up to
   * those positions have been applied (persist-after-apply — each apply above
   * awaited its projection commit), so a crash re-folds the last batch
   * idempotently rather than skipping it. Intra-pass on purpose: a single pass
   * over a large backlog can outlast the 240s bg-host watchdog and never return,
   * so persisting only after the pass returned would capture nothing (the
   * WI-2105 restart loop). Awaited but best-effort — a throw is swallowed by the
   * merge so a failing persist can never abort a pass (the next persist re-writes
   * the latest positions).
   */
  onCursorAdvance?: (positions: ReadonlyMap<string, number>) => Promise<void> | void;
  /**
   * WI-4020: cap on `cursor.winners`' entry count (approximate LRU, evicting
   * quiescent keys first — see `recordWinner`/`DEFAULT_MAX_WINNERS_ENTRIES`).
   * `<= 0` disables the bound (unbounded growth, today's behavior).
   */
  maxWinnersEntries?: number;
  /** Fires (best-effort) whenever a pass evicts `winners` entries under the cap. */
  onWinnersEvicted?: (evictedCount: number, size: number) => void;
  /**
   * WI-2141796: who OWNS this cursor — `"<workspaceId>/<harnessSlug>"`. Used only
   * to disambiguate the read-stall / quarantine log lines.
   *
   * Why it is needed: one log is admitted by MANY harnesses, each folding it
   * through its OWN cursor at its OWN position. Measured 2026-09-02: log
   * `cb54460d98d8` had 39 cursor rows spanning positions 6467..15595. A log line
   * naming only `<keyHex>#<pos>` is therefore ambiguous across all of them, and
   * the failure mode is concrete — the first stall line emitted in production
   * read `cb54460d98d8#7585` while the papercusp cursor was at 14796, and that
   * near-miss invites correlating a number with the wrong harness entirely.
   */
  cursorLabel?: string;
  /**
   * WI-10003427: a caller-owned probe the pass stamps IN PLACE (no call, no
   * allocation) before every await that has no bound of its own — so a pass
   * that parks forever can be named down to `<log>@<pos>` and the phase it is
   * waiting in. The boot-level merge watchdog reads it into its stall line; a
   * stage name alone ('incremental-merge') left a 13h wedge undiagnosable.
   */
  progress?: MergeProgressProbe;
  /**
   * p2p-join-catchup-speed-2026-09-23 P-002 (WI-10002479): resolve the STORED PG
   * order for a window of upcoming ops in one query per opted-in table, and seed the
   * winners with it so an op strictly older than its stored row is skipped without
   * an apply round trip (see `isStaleAgainst`). Absent ⇒ today's behavior exactly.
   * Best-effort: a failed look-ahead read or lookup just seeds nothing.
   */
  prefetchStoredOrder?: StoredOrderPrefetch;
  /** Look-ahead window for {@link prefetchStoredOrder}. Default `STORED_ORDER_PREFETCH_WINDOW`. */
  storedOrderPrefetchWindow?: number;
  /** Budget for one window's look-ahead reads. Default `STORED_ORDER_PEEK_TIMEOUT_MS`. */
  storedOrderPeekTimeoutMs?: number;
  /**
   * P-528 (p2p-join-catchup-speed-2026-09-23 D-018 #3): skip a put that a later put on the
   * same key, in the same look-ahead window, beats under LWW. The predicate names the
   * `(table, hbKey)` pairs whose projection allows it (`TableProjection.supersedableKey`).
   * A skip stays pending, and every position this pass persists stays at or below it, until
   * the superseder has applied and its batch has committed. If the superseder does not
   * apply, the group replays serially from the skipped op (`MergeCursor.supersededNoSkip`).
   * Deletes are never skipped and never supersede. Absent ⇒ today's behavior exactly.
   * Reads its window through the same look-ahead as {@link prefetchStoredOrder}.
   */
  skipSuperseded?: (table: string, hbKey: string) => boolean;
  /**
   * P-524: seek this device's epoch key ahead on a log when an apply could not decrypt
   * for want of it (see {@link EpochKeySeek}). Absent ⇒ today's behavior exactly.
   */
  keySeek?: EpochKeySeek;
}

/**
 * P-524 (p2p-join-catchup-speed-2026-09-23 D-009 (b)): one (pot, epoch) the apply sink's
 * decrypt gate deferred an op for, because this device holds no key for it yet.
 */
export interface EpochKeyMiss {
  potId: string;
  epoch: number;
}

/**
 * P-524: key before content for a fresh joiner.
 *
 * A device's wrapped epoch-key rows are appended when it is admitted, so for a fresh
 * joiner they sit after the newest snapshot set and after nearly all content. Folding in
 * log order, the joiner reaches content first, and every encrypted row defers into the
 * bounded PendingEpochContent buffer, overflows it and is re-folded later (P-007 run #1
 * applied nothing across 438 of 1,053 set chunks).
 *
 * With this option, a key miss makes the fold look ahead on THAT log for this device's
 * key row and apply it (and nothing else) before it reads on. The content cursor does not
 * move: later content decrypts because the key is now in PG, and the op that missed
 * drains through the existing key-applied hook after the pass.
 */
export interface EpochKeySeek {
  /** Misses the apply sink recorded since the last call; the call consumes them. */
  takeMisses(): readonly EpochKeyMiss[];
  /** True when `env` (a plain op or an expanded set row) is this device's key row for `miss`. */
  suppliesKey(env: OpEnvelope, miss: EpochKeyMiss): boolean;
  /** Op reads one seek may spend. Default {@link KEY_SEEK_MAX_OPS}. */
  maxOps?: number;
  /** Wall-clock one seek may spend. Default {@link KEY_SEEK_MAX_MS}. */
  maxMs?: number;
}

/** P-524: op reads one key seek may spend before it gives up. */
export const KEY_SEEK_MAX_OPS = 500_000;
/**
 * P-524: wall-clock one key seek may spend. A seek does not touch the replication-liveness
 * sample (boot touches it from `onCursorAdvance`), so this stays under its 60s staleness.
 */
export const KEY_SEEK_MAX_MS = 45_000;

function keySeekMemoKey(keyHex: string, miss: EpochKeyMiss): string {
  return `${keyHex}|${miss.potId}|${miss.epoch}`;
}

export interface IncrementalMergeResult {
  /** Ops that applied (winner changed + apply sink returned true). */
  applied: number;
  /** Ops decoded this pass (the EI-79 cost driver — O(delta), not O(history)). */
  decoded: number;
  /** True when every log's cursor reached its length (no backlog left). */
  caughtUp: boolean;
  /**
   * EI-79 step 3 (correctness escape hatch): a log whose `length` dropped BELOW
   * its cursor position — a truncated / reset / forked log. Its prior ops (incl.
   * any that won their key) may no longer exist, so the standing fold is invalid.
   * When true, NO ops were folded this pass; the caller MUST reset the cursor
   * (`createMergeCursor()`) and re-run for a clean full re-fold. `false` on every
   * normal pass.
   */
  truncated: boolean;
  /**
   * P-002: ops skipped because the stored PG row was strictly newer (seeded by
   * `prefetchStoredOrder`). Present only when that option is set.
   */
  storedOrderSkips?: number;
  /**
   * P-528: puts skipped because a later put in the look-ahead window superseded them.
   * Present only when `skipSuperseded` is set. Counted when skipped; a skip whose
   * superseder then failed replays next pass and is counted again if skipped again.
   */
  supersededSkips?: number;
  /** P-533: positions of skipped snapshot sets crossed in one step, without a fold read. */
  snapshotChunksJumped: number;
  /** P-002 step 2: batch-transaction counters. Present unless `batchApply: false`. */
  batch?: MergeBatchStats;
}

/**
 * One INCREMENTAL merge pass: for each log, read only [cursor, bounded-upper),
 * fold each new op against the standing winner state, and apply ONLY the ops
 * that change their key's winner. Replaces the O(total-history) re-decode +
 * re-fold + re-apply that `mergeAdmittedLogs` pays on every changed tick.
 *
 *   - O(delta): a tick after k new ops decodes exactly k ops.
 *   - ts-guarded apply: an op that does not beat the standing winner is never
 *     handed to the projection writers, so PG rows only ever move forward.
 *   - No lost tail (EI-91): the per-pass budget defers, never drops.
 *   - WAN-friendly (EI-92): logs exposing `prefetch` get a fire-and-forget
 *     ranged download for the pass window before the sequential decode.
 *
 * CALLER CONTRACT (boot.ts): the cursor assumes the LOG SET is stable. When
 * the admitted set changes (admit/revoke/channel-2 drop), reset the cursor
 * (`createMergeCursor()`) and re-run — removing a log's contributions
 * requires a fresh fold without it. Cursor entries for logs absent from
 * `logs` are left untouched (the caller resets; this function never guesses).
 *
 * POST-CURSOR-RESET DOUBLE-APPLY SAFETY (audit P-068 — LOAD-BEARING): a reset
 * re-folds every log from index 0 against PG rows that already hold the final
 * state, so every op re-applies. Correctness rests on TWO independent floors:
 *   1. the in-memory winners fold below (an op that doesn't beat the standing
 *      winner is never handed to apply) — empty right after a reset, so
 *   2. EVERY projection writer is PG-level LWW: puts upsert under
 *      `WHERE stored.fed_ts IS NULL OR EXCLUDED.fed_ts >= stored.fed_ts`
 *      (NULL allowed on the STORED side only — the EXCLUDED-side NULL
 *      disjunct was the EI-117 revert hole) and dels are ts-guarded
 *      (`fed_ts <= del.ts`) so a stale del re-applied over a newer put
 *      matches nothing. Own-log ops on CDC-captured tables are skipped
 *      entirely (`TableProjection.skipOwnOps`, EI-117).
 * KNOWN BOUNDED TRANSIENT: deletes leave no PG tombstone, so a reset replay
 * that folds an old put before its winning del re-INSERTs the row until the
 * del re-applies (same pass, or within the backlog's passes when beyond the
 * per-pass budget). The fixpoint always converges. Regression coverage:
 * projections/__tests__/fed-ts-lww-guard.integration.test.ts ("post-cursor-
 * reset double-apply safety") + ei117-replay-revert-guard.integration.test.ts.
 * A NEW projection MUST copy this guard shape or reset replays will clobber.
 *
 * A read that times out / rejects STOPS this pass for that log WITHOUT
 * advancing its cursor (retried next pass) — an op can be delayed, never
 * skipped. A read that resolves `null` (the version gate dropping an
 * unknown-newer op, D-024) advances past it deliberately.
 */
/**
 * p2p-join-catchup-speed-2026-09-23 P-002 (WI-10002479): read `[start, end)` ahead
 * of the sequential fold, look up the STORED PG order of every key those ops touch
 * (one query per opted-in table), and seed `cursor.winners` with it.
 *
 * Why: a peer replaying history onto a database that already holds newer rows pays a
 * full apply (~3 PG round trips on work_items) per op only for the projection's LWW
 * guard to reject it. Measured on the P-203 VM fold: 6065 index scans for 46 row
 * updates in 60s. A seeded winner lets `isStaleAgainst` skip those ops in memory.
 *
 * Safety: best-effort and read-only. Every read that resolves inside
 * `peekTimeoutMs` is kept in `peeked` and consumed by the main loop INSTEAD of a
 * second read, so the op the fold applies is the one the lookup saw; anything not
 * read in time is simply read by the main loop as before. A snapshot chunk is never
 * kept (P-532): the main loop reads it, so a window over a set holds no chunk decoded.
 * A seed only replaces a winner whose order key is lower, and only strictly-older ops
 * are ever skipped.
 * Without `prefetch` it only reads the window (P-528's look-ahead).
 */
async function peekAndSeedStoredOrder(args: {
  cursor: MergeCursor;
  log: AdmittedLog;
  start: number;
  end: number;
  peeked: Map<number, PeerLogOp | null>;
  prefetch: StoredOrderPrefetch | undefined;
  peekTimeoutMs: number;
  maxWinnersEntries: number;
  onWinnersEvicted?: (evictedCount: number, size: number) => void;
}): Promise<void> {
  const { cursor, log, start, end, peeked, prefetch, peekTimeoutMs } = args;
  if (end <= start) return;
  const TIMEOUT = Symbol('peek-timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), Math.max(0, peekTimeoutMs));
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
  });
  // P-533: a window that reaches a set this cursor will SKIP must not fetch the set. The
  // first chunk to arrive says where the set sits, so every other read in its span is
  // cancelled then, even after the deadline (a read outlives the peek). The fold's own
  // next position and the set's last block stay: the fold's jump reads exactly those.
  // WI-10005291: cancelling withdraws only a NETWORK request. On a local log (the own log)
  // every block is already in storage, so an issued read is a storage read that cannot be
  // withdrawn: issuing the whole window at once read a whole skipped set (~4 GB) per
  // crossing. So reads go out in position order, at most STORED_ORDER_PEEK_CONCURRENCY at
  // a time, and none is issued inside a span already known to be skipped.
  const cancellable = (log as CancellableReadLog).getCancellable;
  const inFlight = typeof cancellable === 'function' ? new Map<number, CancellableRead>() : null;
  const skippedSpans: { from: number; to: number }[] = [];
  const inSkippedSpan = (i: number): boolean => skippedSpans.some((s) => i >= s.from && i < s.to);
  const noteSkippedSpan = (op: PeerLogOp | null, i: number): void => {
    if (!op || !isSnapshotOp(op)) return;
    const span = skippedSetSpan(cursor, log.keyHex, op.value as SnapshotPayload | undefined, i);
    if (!span) return;
    const from = Math.max(span.start, start) + 1;
    const to = Math.min(span.end - 1, end);
    if (to <= from) return;
    skippedSpans.push({ from, to });
    if (!inFlight) return;
    for (let j = from; j < to; j++) {
      inFlight.get(j)?.cancel();
      inFlight.delete(j);
    }
  };
  const readAt = (i: number): Promise<{ ok: true; op: PeerLogOp | null } | { ok: false }> => {
    if (inFlight) {
      const handle = cancellable!.call(log, i);
      inFlight.set(i, handle);
      return handle.op.then(
        (op) => {
          inFlight.delete(i);
          noteSkippedSpan(op, i);
          return { ok: true as const, op };
        },
        () => {
          inFlight.delete(i);
          return { ok: false as const };
        },
      );
    }
    return Promise.resolve()
      .then(() => log.get(i))
      .then(
        (op) => {
          noteSkippedSpan(op, i);
          return { ok: true as const, op };
        },
        () => ({ ok: false as const }),
      );
  };
  let expired = false;
  void deadline.then(() => {
    expired = true;
  });
  let next = start;
  const worker = async (): Promise<void> => {
    while (!expired && next < end) {
      const i = next++;
      if (inSkippedSpan(i)) continue;
      const r = await Promise.race([readAt(i), deadline]);
      // Out of budget: stop issuing. A read still in flight outlives the peek, as before.
      if (r === TIMEOUT) return;
      // P-532 (D-027): a snapshot chunk is never kept. Neither consumer reads one, and
      // a window can span a whole set: a VM peer held 477 chunks of ~4 MiB here, 3.6 GB
      // decoded, until the heap limit killed it. The main loop reads each chunk itself.
      if (r.ok && !isSnapshotOp(r.op)) peeked.set(i, r.op);
    }
  };
  try {
    const workers: Promise<void>[] = [];
    for (let w = 0; w < Math.min(STORED_ORDER_PEEK_CONCURRENCY, end - start); w++) workers.push(worker());
    await Promise.all(workers);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!prefetch) return;

  const entries: { table: string; key: string }[] = [];
  const seen = new Set<string>();
  for (let i = start; i < end; i++) {
    const op = peeked.get(i);
    if (!op || isSnapshotOp(op)) continue;
    const env = toEnvelope(op, log.keyHex);
    if (!env.table || !env.hbKey) continue;
    const groupKey = `${env.table}::${env.hbKey}`;
    if (seen.has(groupKey)) continue;
    seen.add(groupKey);
    entries.push({ table: env.table, key: env.hbKey });
  }
  if (entries.length === 0) return;

  let stored: Map<string, { hlc: string | null; ts: number | null }>;
  try {
    stored = await prefetch(entries);
  } catch {
    return; // best-effort: an unseeded window folds exactly as before
  }
  for (const [groupKey, order] of stored) {
    // A row with neither an hlc nor a ts has the lowest possible order key; seeding it
    // could only produce equal-key comparisons, which always go to PG anyway.
    if (order.hlc == null && order.ts == null) continue;
    const seed: WinnerMeta = {
      ts: order.ts ?? 0,
      ...(order.hlc != null ? { hlc: order.hlc } : {}),
      type: 'put',
      src: '',
      seeded: true,
    };
    const prev = cursor.winners.get(groupKey);
    if (prev) {
      const kPrev = prev.hlc ?? encodeHlc({ ms: prev.ts, count: 0 });
      const kSeed = seed.hlc ?? encodeHlc({ ms: seed.ts, count: 0 });
      if (kSeed <= kPrev) continue; // the recorded winner is at least as new: keep it
    }
    recordWinner(cursor, groupKey, seed, args.maxWinnersEntries, args.onWinnersEvicted);
  }
}

/**
 * P-528 (p2p-join-catchup-speed-2026-09-23 D-018 #3): record in `into` (position →
 * superseder position) every put in `[start, end)` that a later put in the window
 * supersedes: same `(table, hbKey)`, the projection allows it (`supersedable`), and the
 * later put beats it under LWW. Measured on P-007 run #7: 62% of a fresh joiner's
 * post-snapshot tail is such puts, each paying a decode, a decrypt and a PG write for a
 * row a later op overwrites.
 *
 * The superseder named is the put that will actually win: scanning backward, a put the
 * best later put does not beat becomes the new best, because it applies and every later
 * put in its group is then stale. The scan never looks past what it cannot see. A
 * position the look-ahead did not read in time, or a snapshot chunk, clears every group,
 * since either may write any key. A delete clears its own group, so a put is never
 * skipped across a delete of its key.
 */
function indexSupersededPuts(args: {
  keyHex: string;
  start: number;
  end: number;
  peeked: ReadonlyMap<number, PeerLogOp | null>;
  supersedable: (table: string, hbKey: string) => boolean;
  into: Map<number, number>;
}): void {
  const { keyHex, start, end, peeked, supersedable, into } = args;
  const best = new Map<string, { pos: number; env: OpEnvelope }>();
  for (let i = end - 1; i >= start; i--) {
    if (!peeked.has(i)) {
      best.clear();
      continue;
    }
    const op = peeked.get(i);
    if (!op) continue; // resolved null: the fold applies nothing here
    if (isSnapshotOp(op)) {
      best.clear();
      continue;
    }
    const env = toEnvelope(op, keyHex);
    if (!env.table || !env.hbKey) continue;
    const groupKey = `${env.table}::${env.hbKey}`;
    if (env.type !== 'put' || !supersedable(env.table, env.hbKey)) {
      best.delete(groupKey);
      continue;
    }
    const later = best.get(groupKey);
    if (later && beatsStored(later.env, toMeta(env))) into.set(i, later.pos);
    else best.set(groupKey, { pos: i, env });
  }
}

type KeySeekResult =
  | { kind: 'found'; at: number; reads: number }
  | { kind: 'absent'; reads: number }
  | { kind: 'gave-up'; at: number; reads: number; why: string };

/** P-524: this device's key row for `miss` in `op` (a plain op, or a set chunk's rows), if any. */
function keyRowIn(op: PeerLogOp, keyHex: string, seek: EpochKeySeek, miss: EpochKeyMiss): OpEnvelope | null {
  if (isSnapshotOp(op)) {
    for (const row of snapshotRows(op)) {
      const env = snapshotRowToEnvelope(row, keyHex);
      if (seek.suppliesKey(env, miss)) return env;
    }
    return null;
  }
  const env = toEnvelope(op, keyHex);
  return seek.suppliesKey(env, miss) ? env : null;
}

/**
 * P-524 (p2p-join-catchup-speed-2026-09-23 D-009 (b)): look for this device's key row for
 * `miss` on `log` over `[floor, log.length)` and apply it through the fold's own apply
 * path, outside any batch, so it has committed before the next content op resolves its key.
 *
 * Reads top down. A device's key row is written at its admission, shortly before it joins,
 * so it sits near the tail; and a peer log has one writer, so the first match is the newest
 * version. Set chunks are searched row by row, because rows are sorted by table and content
 * tables that sort before `hive-epoch-keys` come first inside a set too. Skips what an
 * earlier seek on this cursor already read (`cursor.keySeeks`). Gives up at the op or time
 * budget, or at a read that does not resolve. Never moves `cursor.positions`.
 */
async function seekEpochKey(args: {
  cursor: MergeCursor;
  log: AdmittedLog;
  floor: number;
  miss: EpochKeyMiss;
  seek: EpochKeySeek;
  apply: (op: OpEnvelope) => Promise<boolean | MergeApplyOutcome>;
  scope: string;
  getTimeoutMs: number;
  applyTimeoutMs: number;
  maxWinnersEntries: number;
  onWinnersEvicted?: (evictedCount: number, size: number) => void;
}): Promise<KeySeekResult> {
  const { cursor, log, floor, miss, seek } = args;
  const memoKey = keySeekMemoKey(log.keyHex, miss);
  const memos = (cursor.keySeeks ??= new Map());
  const length = log.length;
  const prior = memos.get(memoKey);
  // A range read before a truncation, or wholly below the floor, says nothing about this seek.
  const memo = prior && prior.top <= length && prior.top > floor ? prior : undefined;
  const segments: Array<[number, number]> = memo
    ? [
        [memo.top, length],
        [floor, memo.bottom],
      ]
    : [[floor, length]];
  const maxOps = seek.maxOps ?? KEY_SEEK_MAX_OPS;
  const maxMs = seek.maxMs ?? KEY_SEEK_MAX_MS;
  const read = scanBackwardWindowed(log, floor, args.getTimeoutMs);
  const startedAt = Date.now();
  let reads = 0;
  // `[covered, length)` has been read in full. Reads run top down and the top segment ends
  // where the memo's range begins, so this stays one range.
  let covered = length;
  const remember = (found: boolean): void => {
    memos.set(memoKey, { found, bottom: covered, top: length });
  };
  for (let s = 0; s < segments.length; s++) {
    const [lo, hi] = segments[s];
    for (let i = hi - 1; i >= lo; i--) {
      if (reads >= maxOps || Date.now() - startedAt >= maxMs) {
        remember(false);
        const why = reads >= maxOps ? `the ${maxOps}-read budget is spent` : `the ${maxMs}ms budget is spent`;
        return { kind: 'gave-up', at: i, reads, why };
      }
      reads++;
      const got = await read(i);
      if (got.kind !== 'op') {
        remember(false);
        const why = got.kind === 'unavailable' ? 'a read did not resolve in time' : 'a read failed';
        return { kind: 'gave-up', at: i, reads, why };
      }
      const env = got.op ? keyRowIn(got.op, log.keyHex, seek, miss) : null;
      if (env) {
        const groupKey = `${env.table}::${env.hbKey}`;
        const prev = cursor.winners.get(groupKey);
        // A newer version already folded leaves nothing for this seek to add.
        if (!(prev && isStaleAgainst(env, prev))) {
          const outcome = await applyRecordingWinner(
            cursor,
            groupKey,
            env,
            args.apply,
            args.scope,
            args.applyTimeoutMs,
            args.maxWinnersEntries,
            args.onWinnersEvicted,
            undefined,
            { keyHex: log.keyHex, position: i },
          );
          if (outcome.kind !== 'applied') {
            remember(false); // `covered` is above this row, so the next seek retries it
            return { kind: 'gave-up', at: i, reads, why: `the key row did not apply (${outcome.kind}: ${outcome.reason})` };
          }
        }
        covered = i;
        remember(true);
        return { kind: 'found', at: i, reads };
      }
      covered = i;
    }
    if (s === 0 && memo) covered = memo.bottom;
  }
  remember(false);
  return { kind: 'absent', reads };
}

export async function mergeAdmittedLogsIncremental(
  logs: AdmittedLog[],
  cursor: MergeCursor,
  opts?: IncrementalMergeOpts,
): Promise<IncrementalMergeResult> {
  // P-002 step 2: batched fold commits (D-002), ON unless batchApply === false.
  const batchOpts = opts?.batchApply;
  const batch =
    batchOpts === false
      ? null
      : new FoldBatch(
          cursor,
          Math.max(1, batchOpts?.maxOps ?? MERGE_BATCH_MAX_OPS),
          batchOpts?.maxMs ?? MERGE_BATCH_MAX_MS,
          batchOpts?.commitTimeoutMs ?? MERGE_BATCH_COMMIT_TIMEOUT_MS,
          batchOpts?.reserveTimeoutMs ?? MERGE_BATCH_RESERVE_TIMEOUT_MS,
          opts?.maxWinnersEntries ?? DEFAULT_MAX_WINNERS_ENTRIES,
          opts?.onWinnersEvicted,
        );
  try {
    return await mergeIncrementalPass(logs, cursor, opts, batch);
  } finally {
    // Every normal exit has already committed or discarded; this catches a throw
    // mid-pass, which must never leave a reserved connection holding row locks.
    batch?.discard();
  }
}

async function mergeIncrementalPass(
  logs: AdmittedLog[],
  cursor: MergeCursor,
  opts: IncrementalMergeOpts | undefined,
  batch: FoldBatch | null,
): Promise<IncrementalMergeResult> {
  const apply = opts?.applyImpl ?? applyHyperbeeOpToPg;
  const getTimeoutMs = opts?.getTimeoutMs ?? DEFAULT_GET_TIMEOUT_MS;
  const applyTimeoutMs = opts?.applyTimeoutMs ?? MERGE_APPLY_TIMEOUT_MS;
  const budget = opts?.maxOpsPerPass ?? DEFAULT_MAX_OPS_PER_AUTHOR;
  const onCursorAdvance = opts?.onCursorAdvance;
  const maxWinnersEntries = opts?.maxWinnersEntries ?? DEFAULT_MAX_WINNERS_ENTRIES;
  const onWinnersEvicted = opts?.onWinnersEvicted;
  // WI-2141796: prefix for the read-stall / quarantine lines. Without it those
  // lines name a LOG, which many harnesses fold independently — see cursorLabel.
  const cursorTag = opts?.cursorLabel ? `[${opts.cursorLabel}] ` : '';
  // WI-10003427: stamp the caller's probe before each await that carries no bound
  // of its own (see IncrementalMergeOpts.progress). A no-op without a probe.
  const probe = opts?.progress;
  const mark = (phase: string, keyHex: string, pos: number): void => {
    if (!probe) return;
    probe.keyHex = keyHex;
    probe.pos = pos;
    probe.phase = phase;
    probe.phaseSince = Date.now();
  };
  // p2p-join-catchup-speed-2026-09-23 P-002: optional stored-order look-ahead.
  const prefetchStoredOrder = opts?.prefetchStoredOrder;
  const prefetchWindow = Math.max(1, opts?.storedOrderPrefetchWindow ?? STORED_ORDER_PREFETCH_WINDOW);
  const peekTimeoutMs = opts?.storedOrderPeekTimeoutMs ?? STORED_ORDER_PEEK_TIMEOUT_MS;
  let storedOrderSkips = 0;
  // P-528: skip puts a later put in the same look-ahead window supersedes.
  const skipSuperseded = opts?.skipSuperseded;
  const lookAhead = prefetchStoredOrder !== undefined || skipSuperseded !== undefined;
  let supersededSkips = 0;
  let snapshotChunksJumped = 0;
  // P-524: optional key-before-content seek; at most one seek per (log, pot, epoch) per pass.
  const keySeek = opts?.keySeek;
  const keySeeksThisPass = new Set<string>();
  // P-527 (D-014): parallel lanes for a snapshot chunk. They need the batch, and are capped
  // at the process-wide apply admission limit.
  const batchApply = opts?.batchApply || undefined;
  const snapshotLanes = batch
    ? Math.max(
        1,
        Math.min(DEFAULT_MERGE_APPLY_CONCURRENCY, Math.floor(batchApply?.snapshotLanes ?? MERGE_SNAPSHOT_LANES)),
      )
    : 1;

  let applied = 0;
  let decoded = 0;
  let caughtUp = true;
  let opsSinceYield = 0;
  let opsSincePersist = 0;
  // WI-2344: wall-clock companion to the op counter (see MERGE_YIELD_MAX_MS).
  let lastYieldAt = Date.now();

  // EI-79 step 3: detect a TRUNCATED log (length < its cursor) BEFORE folding.
  // A shrunk log means ops we already counted as winners may be gone, so a
  // forward-only incremental pass can't repair the fold — bail and let the
  // caller reset + re-fold from scratch. Detected up front so we never apply a
  // partial pass on top of a known-invalid fold.
  for (const log of logs) {
    if (log.length < (cursor.positions.get(log.keyHex) ?? 0)) {
      // The caller will normally replace the cursor after this signal. Drop
      // retained late reads so a re-fold cannot consume a stale position.
      cursor.lateReadResults?.clear();
      return { applied: 0, decoded: 0, caughtUp: false, truncated: true, snapshotChunksJumped: 0 };
    }
  }

  for (const log of logs) {
    // P-522: a fresh log whose snapshot-seed scan has not concluded is not folded yet.
    if (cursor.snapshotSeedPending?.has(log.keyHex) && !cursor.positions.has(log.keyHex)) {
      if (log.length > 0) caughtUp = false;
      continue;
    }
    const from = cursor.positions.get(log.keyHex) ?? 0;
    const upper = budget > 0 ? Math.min(log.length, from + budget) : log.length;
    if (upper <= from) {
      if (log.length > from) caughtUp = false;
      continue;
    }

    // EI-92: ask the peer to stream the window instead of paying a round trip per op
    // below. Feature-detected. P-533: it opens once the pass's first op is read, past a
    // set this cursor skips (openPassRange), and a jump withdraws what it overlaps.
    let passRange: PassRange | null = null;

    // WI-559 — structural-deferral cursor hold. Cursor positions are MONOTONIC, so
    // not recording a winner is necessary but NOT sufficient to make a deferred op
    // re-appliable: it must also be re-READ, and it never will be if this pass
    // advances past it. Track the FIRST deferred index and clamp every position
    // write for this log to it. Later ops in the pass still apply and record
    // winners, so re-reading them next pass is cheap — `beatsStored` dedupes each
    // one — and the deferred op finally lands by itself once its referent arrives.
    let pos = from;
    // P-002 look-ahead: ops already read for the stored-order prefetch, consumed below
    // in place of a second read of the same position.
    const peeked = new Map<number, PeerLogOp | null>();
    let peekedUpTo = from;
    // P-528: position → the later put in this window that supersedes the put there; the
    // skips this pass took (in position order) whose superseder has not yet applied and
    // committed; and the superseders that applied since the last commit.
    const supersededBy = new Map<number, number>();
    const pendingSkips: { pos: number; sup: number; groupKey: string; env: OpEnvelope }[] = [];
    const awaitedSups = new Set<number>();
    const supersedersDone = new Set<number>();
    const noSkip = cursor.supersededNoSkip?.get(log.keyHex);
    let firstDeferredPos = -1;
    const previousFailure = cursor.applyFailures?.get(log.keyHex);
    const holdCursorHere = (outcome: Exclude<MergeApplyOutcome, { kind: 'applied' }>, groupKey: string): void => {
      if (firstDeferredPos >= 0) return;
      firstDeferredPos = pos;
      const same = previousFailure?.position === pos && previousFailure.groupKey === groupKey;
      const now = Date.now();
      (cursor.applyFailures ??= new Map()).set(log.keyHex, {
        position: pos,
        groupKey: groupKey.replaceAll('\0', '').slice(0, 512),
        kind: outcome.kind,
        reason: outcome.reason.replaceAll('\0', '').slice(0, 512),
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        attempts: same ? previousFailure.attempts + 1 : 1,
        firstSeenAt: same ? previousFailure.firstSeenAt : now,
        lastSeenAt: now,
      });
    };
    const effectivePos = (p: number): number => {
      const held = firstDeferredPos >= 0 ? Math.min(p, firstDeferredPos) : p;
      // P-528: never past a skipped put whose superseder has not applied and committed.
      return pendingSkips.length > 0 ? Math.min(held, pendingSkips[0].pos) : held;
    };
    /** P-528: called once a commit has made every write so far durable. */
    const resolveSkips = (): void => {
      if (supersedersDone.size === 0) return;
      let kept = 0;
      for (const skip of pendingSkips) if (!supersedersDone.has(skip.sup)) pendingSkips[kept++] = skip;
      pendingSkips.length = kept;
      for (const sup of supersedersDone) awaitedSups.delete(sup);
      supersedersDone.clear();
    };
    // P-002 step 2: commit the open batch. When it is lost, rewind to its first op
    // and hold the cursor there, so no position past a rolled-back write is ever
    // persisted; the next pass replays the window (idempotent under LWW).
    // Ops before `serialUntil` replay outside the batch (MergeCursor.batchSerialUntil).
    let serialUntil = cursor.batchSerialUntil?.get(log.keyHex) ?? 0;
    if (serialUntil > 0 && from >= serialUntil) {
      cursor.batchSerialUntil?.delete(log.keyHex);
      serialUntil = 0;
    }
    const batchAt = (p: number): { fold: FoldBatch; pos: number } | undefined =>
      batch && p >= serialUntil ? { fold: batch, pos: p } : undefined;
    // P-527: chunks before `laneSerialUntil` apply serially (MergeCursor.laneSerialUntil).
    let laneSerialUntil = cursor.laneSerialUntil?.get(log.keyHex) ?? 0;
    if (laneSerialUntil > 0 && from >= laneSerialUntil) {
      cursor.laneSerialUntil?.delete(log.keyHex);
      laneSerialUntil = 0;
    }
    // `through` is the exclusive end of what the batch may hold: `pos` where the op
    // at `pos` has not started, `pos + 1` where it has.
    const settleBatch = async (through: number): Promise<boolean> => {
      if (batch) mark('batch-commit', log.keyHex, pos);
      if (!batch || (await batch.commit())) {
        resolveSkips();
        return true;
      }
      const start = batch.startPos >= 0 ? batch.startPos : pos;
      const reason = batch.reason;
      batch.discard();
      // P-528: superseders that wrote since the last commit rolled back with the batch.
      supersedersDone.clear();
      // The replay of [start, through) runs serially, so the op that lost this batch
      // cannot lose the next one the same way.
      const serial = (cursor.batchSerialUntil ??= new Map());
      serial.set(log.keyHex, Math.max(serial.get(log.keyHex) ?? 0, through));
      if (start < pos) pos = start;
      if (firstDeferredPos >= pos) firstDeferredPos = -1;
      holdCursorHere({ kind: 'retryable', reason: `batch transaction lost: ${reason}` }, 'read-merge batch');
      return false;
    };
    /**
     * P-528: the superseder at `sup` did not write its row (declined, deferred, rejected).
     * Apply the puts skipped for it now, in log order, as the plain fold applied them
     * before it; a row that changes under neither the superseder nor these ops lands where
     * the plain fold lands. Then the group's winner is left where the plain fold leaves it:
     * the newer of what it held after the superseder and the last put replayed here. The
     * open batch commits first, so the replay autocommits and its winners are exact.
     * A replayed put that does not apply stays pending, so the position holds at it and
     * its group replays in order next pass. False ends the pass (a lost batch, or a
     * retryable replay).
     */
    const replaySkipped = async (sup: number): Promise<boolean> => {
      if (!(await settleBatch(pos + 1))) return false;
      awaitedSups.delete(sup);
      const skipped = pendingSkips.filter((skip) => skip.sup === sup);
      if (skipped.length === 0) return true;
      const groupKey = skipped[0].groupKey;
      const held = cursor.winners.get(groupKey);
      const unresolved = new Set<(typeof pendingSkips)[number]>();
      let last: OpEnvelope | undefined;
      let retryable = false;
      for (const skip of skipped) {
        if (retryable) {
          unresolved.add(skip);
          continue;
        }
        if (last && !beatsStored(skip.env, toMeta(last))) continue; // stale in the plain fold too
        const outcome = await applyRecordingWinner(
          cursor,
          groupKey,
          skip.env,
          apply,
          `${cursorTag}${log.keyHex}`,
          applyTimeoutMs,
          maxWinnersEntries,
          onWinnersEvicted,
          undefined,
          { keyHex: log.keyHex, position: skip.pos },
        );
        if (outcome.kind === 'applied') {
          if (outcome.changed) applied++;
          last = skip.env;
        } else {
          unresolved.add(skip);
          retryable = outcome.kind === 'retryable';
        }
      }
      if (held && (!last || !beatsStored(last, held))) {
        recordWinner(cursor, groupKey, held, maxWinnersEntries, onWinnersEvicted);
      }
      let kept = 0;
      for (const skip of pendingSkips) if (skip.sup !== sup || unresolved.has(skip)) pendingSkips[kept++] = skip;
      pendingSkips.length = kept;
      return !retryable;
    };
    // P-524: a miss recorded before this log's fold (another log's, or the post-pass
    // drain's) is not this log's to seek.
    keySeek?.takeMisses();
    /**
     * P-524: after an apply, seek this device's key for each (pot, epoch) that apply could
     * not decrypt. Commits the open batch first, so its row locks are not held across the
     * seek. False when that commit lost the batch; the caller then ends the pass, as for any
     * lost batch. `taken` is misses a caller already took (P-527's lanes).
     */
    const keySeekSettled = (miss: EpochKeyMiss): boolean => {
      const memoKey = keySeekMemoKey(log.keyHex, miss);
      return keySeeksThisPass.has(memoKey) || cursor.keySeeks?.get(memoKey)?.found === true;
    };
    const seekMissedKeys = async (taken?: readonly EpochKeyMiss[]): Promise<boolean> => {
      if (!keySeek) return true;
      const misses = taken ?? keySeek.takeMisses();
      if (misses.length === 0) return true;
      let settled = false;
      for (const miss of misses) {
        const memoKey = keySeekMemoKey(log.keyHex, miss);
        if (keySeekSettled(miss)) continue;
        keySeeksThisPass.add(memoKey);
        if (!settled) {
          if (!(await settleBatch(pos + 1))) return false;
          settled = true;
        }
        const startedAt = Date.now();
        mark('key-seek', log.keyHex, pos);
        const r = await seekEpochKey({
          cursor,
          log,
          floor: pos,
          miss,
          seek: keySeek,
          apply,
          scope: `${cursorTag}${log.keyHex}`,
          getTimeoutMs,
          applyTimeoutMs,
          maxWinnersEntries,
          onWinnersEvicted,
        });
        const took = `${r.reads} read(s) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
        const what = `${cursorTag}P-524 key seek: log ${log.keyHex.slice(0, 12)} pot ${miss.potId} epoch ${miss.epoch}`;
        if (r.kind === 'found') {
          console.info(`[read-merge] ${what}: applied this device's key row from #${r.at} (${took}); folding on from #${pos}.`);
        } else if (r.kind === 'gave-up') {
          console.warn(
            `[read-merge] ${what}: GAVE UP at #${r.at} after ${took}: ${r.why}. Content for this epoch ` +
              `defers as before; the next pass resumes the seek below what it has read.`,
          );
        } else if (r.reads > 0) {
          console.info(
            `[read-merge] ${what}: no key row for this device in [#${pos}, #${log.length}) (${took}); ` +
              `content for this epoch defers until one arrives.`,
          );
        }
      }
      return true;
    };
    /**
     * P-527 (D-014): apply one snapshot chunk's rows on parallel lanes, each with its own
     * batch transaction ({@link FoldBatch.laneBatches}). Per row it does what the serial
     * loop does: skip a stale row, apply, count, and hold the cursor at this chunk on the
     * first deferral. The chunk ends only when every lane has committed. Returns false
     * when the pass must end at this chunk (the serial loop's `retryable` break):
     *  - a lost lane batch replays the chunk outside any batch (batchSerialUntil), as a
     *    lost serial batch does;
     *  - a retryable outcome replays the chunk on the serial path (laneSerialUntil), so a
     *    failure the lanes caused cannot repeat every pass.
     * A key miss (P-524) stops the lanes, commits them, seeks the key, then resumes where
     * each lane stopped.
     */
    const applyChunkOnLanes = async (rows: readonly SnapshotRow[], lanes: FoldBatch[]): Promise<boolean> => {
      // The open batch holds ops before this chunk; commit it so its row locks are gone.
      if (!(await settleBatch(pos))) return false;
      const applicable: LaneRow[] = [];
      for (const row of rows) {
        const env = snapshotRowToEnvelope(row, log.keyHex);
        const groupKey = `${env.table}::${env.hbKey}`;
        const prev = cursor.winners.get(groupKey);
        // stale row, never applied (P-002: a seeded winner skips only a strictly-older op)
        if (prev && isStaleAgainst(env, prev)) {
          if (prev.seeded) storedOrderSkips++;
          continue;
        }
        applicable.push({ env, groupKey });
      }
      const queues = partitionSnapshotRows(applicable, lanes.length);
      const next = queues.map(() => 0);
      const halt: { reason: 'lost' | 'retryable' | 'key-miss' | null; misses: EpochKeyMiss[] } = {
        reason: null,
        misses: [],
      };
      const runLane = async (i: number): Promise<void> => {
        const lane = lanes[i];
        const queue = queues[i];
        lane.coalesceNotify = true;
        while (next[i] < queue.length && halt.reason === null) {
          if (lane.due && !(await lane.commit())) {
            halt.reason ??= 'lost';
            return;
          }
          const { env, groupKey } = queue[next[i]];
          next[i]++;
          const outcome = await applyRecordingWinner(
            cursor,
            groupKey,
            env,
            apply,
            `${cursorTag}${log.keyHex}`,
            applyTimeoutMs,
            maxWinnersEntries,
            onWinnersEvicted,
            { fold: lane, pos },
            { keyHex: log.keyHex, position: pos },
          );
          if (lane.failed) {
            halt.reason ??= 'lost';
            return;
          }
          if (outcome.kind === 'applied') {
            if (outcome.changed) applied++;
          } else {
            holdCursorHere(outcome, groupKey);
            if (outcome.kind === 'retryable') {
              halt.reason ??= 'retryable';
              return;
            }
          }
          if (keySeek) {
            const fresh = keySeek.takeMisses().filter((miss) => !keySeekSettled(miss));
            if (fresh.length > 0) {
              halt.misses.push(...fresh);
              halt.reason ??= 'key-miss';
              return;
            }
          }
        }
        // A drained lane commits now: its open transaction may hold the id-sequence floor
        // lock (migration 1218) that a sibling still inserting is waiting on.
        if (next[i] >= queue.length && !(await lane.commit())) halt.reason ??= 'lost';
      };
      for (;;) {
        mark('snapshot-lanes', log.keyHex, pos);
        await Promise.all(queues.map((_, i) => runLane(i)));
        let lost = halt.reason === 'lost';
        mark('lane-commit', log.keyHex, pos);
        for (const lane of lanes) if (!(await lane.commit())) lost = true;
        if (lost) {
          const reason = lanes.find((lane) => lane.failed)?.reason ?? 'unknown';
          for (const lane of lanes) lane.discard();
          const serial = (cursor.batchSerialUntil ??= new Map());
          serial.set(log.keyHex, Math.max(serial.get(log.keyHex) ?? 0, pos + 1));
          holdCursorHere({ kind: 'retryable', reason: `snapshot lane batch lost: ${reason}` }, 'read-merge snapshot lane');
          return false;
        }
        if (halt.reason === 'retryable') {
          const serial = (cursor.laneSerialUntil ??= new Map());
          serial.set(log.keyHex, Math.max(serial.get(log.keyHex) ?? 0, pos + 1));
          return false;
        }
        if (halt.reason === 'key-miss') {
          const misses = halt.misses;
          halt.reason = null;
          halt.misses = [];
          if (!(await seekMissedKeys(misses))) return false;
          continue;
        }
        return true;
      }
    };
    // P-008: the snapshot set this pass is crossing on this log, so a long APPLY is
    // visible while it runs (start, every SNAPSHOT_SET_PROGRESS_LOG_MS, done) and a
    // SKIP leaves one line. console.info, not warn: this is expected progress.
    let crossing: SnapshotSetCrossing | null = null;
    const setLabel = (c: number): string => `${cursorTag}P-008 snapshot set: log ${log.keyHex.slice(0, 12)} set@${c}`;
    const noteSnapshotCrossing = (
      payload: SnapshotPayload | undefined,
      disposition: ReturnType<typeof snapshotSetDisposition>,
      rowCount: number,
    ): void => {
      const mode = disposition === 'skip' ? 'skip' : 'apply';
      const c = typeof payload?.coversUpTo === 'number' ? payload.coversUpTo : -1;
      const { idx, count } = snapshotChunkLabel(payload, pos);
      const now = Date.now();
      if (!crossing || crossing.coversUpTo !== c || crossing.mode !== mode) {
        const reason =
          disposition === 'apply-seeded'
            ? 'this cursor was seeded at it'
            : disposition === 'apply-hole'
              ? 'it covers an op this cursor moved past unapplied'
              : disposition === 'apply-ineligible'
                ? 'not skip-eligible'
                : 'redundant';
        crossing = { coversUpTo: c, mode, reason, startedAt: now, lastLogAt: now, chunks: 0, rows: 0, jumped: 0 };
        if (mode === 'apply' && idx < count - 1) {
          console.info(
            `[read-merge] ${setLabel(c)}: APPLYING (${reason}) from chunk ${idx + 1}/${count}; ` +
              `progress every ${SNAPSHOT_SET_PROGRESS_LOG_MS / 1000}s.`,
          );
        }
      }
      crossing.chunks++;
      crossing.rows += rowCount;
      if (mode === 'apply' && idx < count - 1 && now - crossing.lastLogAt >= SNAPSHOT_SET_PROGRESS_LOG_MS) {
        crossing.lastLogAt = now;
        console.info(
          `[read-merge] ${setLabel(c)}: chunk ${idx + 1}/${count}, ${crossing.rows} row(s) in ` +
            `${((now - crossing.startedAt) / 1000).toFixed(1)}s so far.`,
        );
      }
    };
    /** P-008: close the crossing when its LAST chunk has been processed. */
    const endSnapshotChunk = (payload: SnapshotPayload | undefined): void => {
      if (!crossing) return;
      const { idx, count } = snapshotChunkLabel(payload, pos);
      if (idx < count - 1) return;
      const c = crossing.coversUpTo;
      const seconds = ((Date.now() - crossing.startedAt) / 1000).toFixed(1);
      console.info(
        crossing.mode === 'apply'
          ? `[read-merge] ${setLabel(c)}: APPLIED ${crossing.chunks} chunk(s), ${crossing.rows} row(s) ` +
              `in ${seconds}s (${crossing.reason}).`
          : `[read-merge] ${setLabel(c)}: SKIPPED ${crossing.chunks} chunk(s)` +
              (crossing.jumped > 0 ? ` (${crossing.jumped} crossed in one step, P-533)` : '') +
              `, ${crossing.rows} row(s) read and not re-applied; this cursor already folded [0, ${c}) op by op.`,
      );
      crossing = null;
    };

    // P-533: a set this cursor skips is crossed in one step. The chunk at `pos` says
    // where its set ends, and ONE read of the set's last block proves that nothing but
    // this set's chunks sits in between: a set is appended as one atomic batch in chunk
    // order, so chunk `idx` at `pos` and chunk `count - 1` at `pos + count - 1 - idx`
    // leave exactly enough positions for the chunks between them. Any other answer keeps
    // the chunk-by-chunk skip. `stalled` = that read did not finish in time.
    let jumpRefusedFor: number | null = null;
    const jumpSkippedSet = async (
      chunk: PeerLogOp,
      payload: SnapshotPayload | undefined,
    ): Promise<{ kind: 'jumped'; last: SnapshotPayload | null } | { kind: 'read' } | { kind: 'stalled' }> => {
      const span = skippedSetSpan(cursor, log.keyHex, payload, pos);
      if (!span || span.end - 1 <= pos || span.end > log.length) return { kind: 'read' };
      if (jumpRefusedFor === payload!.coversUpTo) return { kind: 'read' };
      const got = await readOpBoundedDetailed(log, span.end - 1, getTimeoutMs);
      if (got.kind === 'unavailable') {
        console.info(
          `[read-merge] ${setLabel(payload!.coversUpTo)}: its last chunk #${span.end - 1} was not read in ` +
            `${getTimeoutMs}ms; the skip resumes next pass (P-533).`,
        );
        return { kind: 'stalled' };
      }
      if (got.kind !== 'op' || !isLastChunkOf(got.op, chunk)) {
        jumpRefusedFor = payload!.coversUpTo;
        console.warn(
          `[read-merge] ${setLabel(payload!.coversUpTo)}: block #${span.end - 1} is not this set's last chunk; ` +
            `skipping it chunk by chunk (P-533 jump refused).`,
        );
        return { kind: 'read' };
      }
      const to = Math.min(span.end, upper);
      const jumped = to - pos - 1;
      snapshotChunksJumped += jumped;
      if (crossing) {
        crossing.chunks += jumped;
        crossing.jumped += jumped;
      }
      pos = to - 1;
      // The pass's range must not keep streaming the span this jump crosses.
      if (passRange?.range && passRange.start < span.end) {
        passRange.range.cancel();
        passRange = prefetchRange(log, to, upper);
      }
      return { kind: 'jumped', last: to === span.end ? (got.op!.value as SnapshotPayload) : null };
    };

    for (; pos < upper; pos++) {
      // P-525 (D-013): a far-behind fold asks for table-scoped change notifications.
      if (batch) batch.coalesceNotify = log.length - pos >= MERGE_COALESCE_NOTIFY_MIN_BACKLOG;
      // EI-81: yield a macrotask every ~1k iterations — counted per pass
      // (the counter carries across logs) so N small logs can't dodge it.
      // WI-2344: OR every MERGE_YIELD_MAX_MS of wall-clock, whichever comes
      // first — bounds a chunk of slow/wide ops (loaded PG, snapshot-op
      // expansion) that would otherwise run long past the op-count trigger
      // and still monopolize the loop long enough to trip the bg-host
      // watchdog's freeze detector.
      if (++opsSinceYield >= MERGE_YIELD_EVERY_OPS || Date.now() - lastYieldAt >= MERGE_YIELD_MAX_MS) {
        opsSinceYield = 0;
        lastYieldAt = Date.now();
        await yieldToEventLoop();
      }
      // P-002 step 2: bound the batch's size (subtransactions) and age (row locks).
      if (batch?.due && !(await settleBatch(pos))) break;
      // WI-2105 REV fix (persist-after-apply): checkpoint the cursor at the
      // persist cadence. ops [from, pos) have all applied (each apply awaited a
      // projection commit), so next-to-read = pos — persisting `pos` never
      // points past a durably-applied op; a crash re-folds [persisted, pos)
      // idempotently (LWW). Intra-pass because a large-backlog pass can outlast
      // the 240s bg-host watchdog and never return.
      if (onCursorAdvance && ++opsSincePersist >= MERGE_PERSIST_EVERY_OPS) {
        opsSincePersist = 0;
        // P-002 step 2: [from, pos) is only durable once the open batch commits.
        if (!(await settleBatch(pos))) break;
        cursor.positions.set(log.keyHex, effectivePos(pos));
        // WI-10002474: a failure carried in from a PREVIOUS pass is resolved once
        // this pass has applied past its position without deferring anything.
        // Clear it HERE, not only at pass end. Otherwise every intra-pass persist
        // writes an advanced position beside a failure BEHIND it, which violates
        // the 1122 check `apply_failure.position >= position`. That fails the
        // multi-row save for EVERY log, so a long catch-up pass persists nothing.
        if (firstDeferredPos < 0 && previousFailure && pos > previousFailure.position) {
          cursor.applyFailures?.delete(log.keyHex);
        }
        try {
          mark('cursor-persist', log.keyHex, pos);
          await onCursorAdvance(cursor.positions);
        } catch (err) {
          // best-effort: a failed persist must never abort the merge pass —
          // but it must never be SILENT either (WI-10002474 hid for hours).
          warnCursorPersistFailed(err);
        }
      }
      // Distinguish "op resolved (possibly version-dropped)" from "unavailable"
      // (a transient timeout — peer withholding/offline; unbounded retry-via-
      // break, unchanged) from "read-error" (a REJECTED read — e.g. a permanent
      // hypercore/signature verify failure during identity divergence, WI-2003):
      // bounded retry, then dead-letter past it so a single unreadable position
      // can't wedge every subsequent op in this peer's strictly-sequential log
      // forever (the pre-fix behavior — "silent REV fed_event outage class").
      if (lookAhead && pos >= peekedUpTo) {
        // P-002 step 2: the look-ahead reads committed rows; commit first.
        if (!(await settleBatch(pos))) break;
        peekedUpTo = Math.min(upper, pos + prefetchWindow);
        mark('stored-order-peek', log.keyHex, pos);
        await peekAndSeedStoredOrder({
          cursor,
          log,
          start: pos,
          end: peekedUpTo,
          peeked,
          prefetch: prefetchStoredOrder,
          peekTimeoutMs,
          maxWinnersEntries,
          onWinnersEvicted,
        });
        if (skipSuperseded) {
          indexSupersededPuts({
            keyHex: log.keyHex,
            start: pos,
            end: peekedUpTo,
            peeked,
            supersedable: skipSuperseded,
            into: supersededBy,
          });
        }
      }
      const supersededAt = supersededBy.get(pos);
      supersededBy.delete(pos);
      let op: PeerLogOp | null;
      try {
        const readIdent = `${log.keyHex}:${pos}`;
        const cached = cursor.lateReadResults?.get(readIdent);
        cursor.lateReadResults?.delete(readIdent);
        const peekedOp =
          cached || !peeked.has(pos) ? undefined : { kind: 'op' as const, op: peeked.get(pos) ?? null };
        peeked.delete(pos);
        mark('read', log.keyHex, pos);
        const got =
          cached ??
          peekedOp ??
          (await readOpBoundedDetailed(log, pos, getTimeoutMs, (result) => {
            // A late result is useful only while this cursor is still held at
            // the same position. If another attempt already advanced it, drop
            // the stale result rather than applying it at a later position.
            if ((cursor.positions.get(log.keyHex) ?? 0) !== pos) return;
            const retained = cursor.lateReadResults?.get(readIdent);
            if (!retained || (retained.kind === 'read-error' && result.kind === 'op')) {
              (cursor.lateReadResults ??= new Map()).set(readIdent, result);
            }
          }));
        // A cached result (or an immediate fresh result) owns this position;
        // any additional late results for it are stale once the cursor moves.
        if (cached || got.kind !== 'unavailable') cursor.lateReadResults?.delete(readIdent);
        passRange ??= openPassRange(log, cursor, got.kind === 'op' ? got.op : null, pos, upper);
        if (got.kind === 'unavailable') {
          // WI-2141796 / P-203: retry from here next pass (UNBOUNDED, because a
          // peer withholding one block is usually transient and dead-lettering
          // it would lose it). D-018 additionally consumes any late result
          // before issuing another read, so a slow-but-served block cannot pin
          // the cursor forever while never-settling reads retain their existing
          // retry behavior.
          const stalls = (cursor.readStalls ??= new Map());
          const n = (stalls.get(readIdent) ?? 0) + 1;
          stalls.set(readIdent, n);
          // Announce on 1, then on each POWER OF TWO, then every 100th. A flat
          // `n === 1 || n % 100 === 0` leaves passes 2..99 silent — and that is
          // precisely the window where a one-pass blip turns into a wedged
          // position. Measured 2026-09-02: papercusp stalled at #15595, emitted
          // its single `1×` line, then went quiet for 7+ minutes while the cursor
          // did not move. Silence there is indistinguishable from recovery, which
          // is the exact failure this warning exists to end. Doubling keeps a
          // persisting stall announcing itself (2×, 4×, 8×…) at a log-bounded
          // rate, so the count a reader sees is evidence of DURATION.
          if (n === 1 || (n & (n - 1)) === 0 || n % 100 === 0) {
            console.warn(
              `[read-merge] ${cursorTag}read stall (${n}×): log ${log.keyHex.slice(0, 12)}#${pos} did not resolve within ` +
                `${getTimeoutMs}ms — cursor HELD at ${pos}, ${Math.max(0, log.length - pos)} op(s) behind it are ` +
                `UNREACHABLE until this position reads. Retrying every pass (not quarantined, not lost). A count ` +
                `that keeps climbing on the SAME position is a wedged log, not a blip: the peer is serving the ` +
                `swarm but not this block. NOTE the cursor ROW is not a witness here — positions persist as one ` +
                `map, so a sibling log advancing re-stamps this row's updated_at while its position stays frozen.`,
            );
            // WI-2141796 — the line above reports only that the read did not
            // FINISH. It cannot say whether the block is UNREADABLE or merely
            // SLOW, and every hypothesis about this outage class has foundered on
            // exactly that gap: a peer-withholding story and a host-saturation
            // story fit the same evidence and imply opposite fixes. So watch the
            // read we just abandoned and report which it turned out to be.
            //
            // Attached only at an announce point, so the number of outstanding
            // observers stays logarithmic in the stall count even for a read that
            // never settles.
            const observedPos = pos;
            const observedAtMs = got.startedAtMs;
            void got.pending.then((resolved) => {
              console.warn(
                `[read-merge] ${cursorTag}late read: log ${log.keyHex.slice(0, 12)}#${observedPos} ` +
                  `${resolved ? 'DID eventually resolve' : 'eventually REJECTED'} ` +
                  `${Date.now() - observedAtMs}ms after the ${getTimeoutMs}ms bound gave up. A resolve means the ` +
                  `block was SLOW, NOT unreadable — it WAS served, just not inside the bound, so the fix belongs ` +
                  `on whatever made the read slow (or on the bound), NOT on the peer. NO late-read line for a ` +
                  `position that keeps stalling means the read never settled at all — the genuinely-unavailable case.`,
              );
            });
          }
          break;
        }
        if (got.kind === 'read-error') {
          const throws = (cursor.readThrows ??= new Map());
          const ident = `${log.keyHex}:${pos}`;
          const n = (throws.get(ident) ?? 0) + 1;
          if (n < MAX_READ_THROWS) {
            throws.set(ident, n); // may still be transient — retry from here next pass
            break;
          }
          // Persistently unreadable/unverifiable at this position — DEAD-LETTER:
          // advance past it instead of wedging the rest of this peer's log forever.
          throws.delete(ident);
          console.error(
            `[read-merge] ${cursorTag}WI-2003 quarantine: unreadable op at ${log.keyHex.slice(0, 12)}#${pos} ` +
              `after ${n} consecutive read failures — advancing past it so the rest of this peer's ` +
              `log can keep folding (this position itself never folds; if this is an identity-` +
              `divergence signature-verify rejection, re-grant/re-emit the underlying wraps so the ` +
              `sender re-publishes under a verifiable identity):`,
            got.err instanceof Error ? got.err.message : String(got.err),
          );
          op = null; // treated like a version-gated drop below — cursor advances past it
        } else {
          cursor.readThrows?.delete(`${log.keyHex}:${pos}`); // success clears any throw streak
          cursor.readStalls?.delete(`${log.keyHex}:${pos}`); // …and any read-stall streak (WI-2141796)
          op = got.op;
        }
      } catch {
        break;
      }
      if (!op) {
        // P-008: the cursor moves past this position without applying anything
        // (version-gated drop, undecodable op, WI-2003 dead-letter). Its prefix is
        // no longer fully folded, so the next snapshot set is owed, not redundant.
        recordSnapshotHole(cursor, log.keyHex, pos);
        continue; // version-gated drop — advance past it
      }
      decoded++;
      // P-007 (design A): expand a snapshot op into its per-key rows and fold each
      // through the SAME ts-guarded apply path. One decode reconstitutes N keys —
      // exactly the cost win (the joiner's cursor can start AT this op's index and
      // skip the summarized prefix). `continue` advances the cursor past it.
      if (isSnapshotOp(op)) {
        // P-008 (endgame D-060): a set is applied row by row only when this cursor
        // OWES it: the set it was seeded or jumped at, one covering a hole, or one
        // that is not skip-eligible. A cursor that folded this log's prefix op by op
        // skips the set. Replaying it costs one PG apply per live row, and after a
        // restart the in-memory winners are empty, so none of them are deduped
        // (measured: 1.24M rows at ~25 rows/s on the P-203 VM).
        const payload = op.value as SnapshotPayload | undefined;
        const disposition = snapshotSetDisposition(cursor, log.keyHex, payload, pos);
        const rows = snapshotRows(op);
        noteSnapshotCrossing(payload, disposition, rows.length);
        if (disposition === 'skip') {
          mark('snapshot-jump', log.keyHex, pos);
          const jump = await jumpSkippedSet(op, payload);
          if (jump.kind === 'stalled') {
            pos++; // this chunk is crossed; the pass stops before the next one
            break;
          }
          if (jump.kind === 'read') endSnapshotChunk(payload);
          else if (jump.last) endSnapshotChunk(jump.last);
          continue;
        }
        // Rows, not ops, drive the persist cadence here: one chunk can hold thousands
        // of rows, so a seeded set checkpoints about every MERGE_PERSIST_EVERY_OPS rows
        // and a restart resumes mid-set. The watermark is persisted too, so it applies.
        if (rows.length > 1) opsSincePersist += rows.length - 1;
        // P-525: one chunk expands to thousands of rows, so a set is bulk wherever it sits.
        if (batch) batch.coalesceNotify = true;
        // P-527: a chunk large enough to pay for its lanes applies them in parallel.
        if (
          batch &&
          snapshotLanes > 1 &&
          rows.length >= MERGE_SNAPSHOT_LANE_MIN_ROWS &&
          pos >= serialUntil &&
          pos >= laneSerialUntil
        ) {
          if (!(await applyChunkOnLanes(rows, batch.laneBatches(snapshotLanes)))) break;
          endSnapshotChunk(payload);
          continue;
        }
        let retryable = false;
        for (const row of rows) {
          // P-002 step 2: one chunk can hold thousands of rows; bound the batch inside it too.
          if (batch?.due && !(await settleBatch(pos + 1))) {
            retryable = true;
            break;
          }
          const env = snapshotRowToEnvelope(row, log.keyHex);
          const groupKey = `${env.table}::${env.hbKey}`;
          const prev = batch?.provisional(groupKey) ?? cursor.winners.get(groupKey);
          // stale row, never applied (P-002: a seeded winner skips only a strictly-older op)
          if (prev && isStaleAgainst(env, prev)) {
            if (prev.seeded) storedOrderSkips++;
            continue;
          }
          mark('apply-snapshot-row', log.keyHex, pos);
          const outcome = await applyRecordingWinner(
            cursor,
            groupKey,
            env,
            apply,
            `${cursorTag}${log.keyHex}`,
            applyTimeoutMs,
            maxWinnersEntries,
            onWinnersEvicted,
            batchAt(pos),
            { keyHex: log.keyHex, position: pos },
          );
          // P-002 step 2: a lost batch rewinds the cursor to its first op; end this pass.
          if (batch?.failed) {
            await settleBatch(pos + 1);
            retryable = true;
            break;
          }
          // P-524: a row this device cannot decrypt yet makes the fold fetch its key first.
          if (!(await seekMissedKeys())) {
            retryable = true;
            break;
          }
          if (outcome.kind === 'applied') {
            if (outcome.changed) applied++;
          } else {
            holdCursorHere(outcome, groupKey);
            if (outcome.kind === 'retryable') {
              retryable = true;
              break;
            }
          }
        }
        if (retryable) break;
        endSnapshotChunk(payload);
        continue;
      }
      const env = toEnvelope(op, log.keyHex);
      const groupKey = `${env.table}::${env.hbKey}`;
      const prev = batch?.provisional(groupKey) ?? cursor.winners.get(groupKey);
      // ts-guard: stale op, never applied (P-002: a seeded winner skips only a strictly-older op)
      if (prev && isStaleAgainst(env, prev)) {
        if (prev.seeded) storedOrderSkips++;
        continue;
      }
      // P-528: a later put in this window supersedes this one, so skip it. The skip holds
      // every persisted position at or below it until the superseder has applied and
      // committed; a group that lost a superseder applies in order (supersededNoSkip).
      if (supersededAt !== undefined && pos >= (noSkip?.get(groupKey) ?? 0)) {
        pendingSkips.push({ pos, sup: supersededAt, groupKey, env });
        awaitedSups.add(supersededAt);
        supersededSkips++;
        continue;
      }
      mark('apply', log.keyHex, pos);
      const outcome = await applyRecordingWinner(
        cursor,
        groupKey,
        env,
        apply,
        `${cursorTag}${log.keyHex}`,
        applyTimeoutMs,
        maxWinnersEntries,
        onWinnersEvicted,
        batchAt(pos),
        { keyHex: log.keyHex, position: pos },
      );
      // P-002 step 2: a lost batch rewinds the cursor to its first op; end this pass.
      if (batch?.failed) {
        await settleBatch(pos + 1);
        break;
      }
      // P-528: a superseder that wrote its row resolves its skips at the next commit. One
      // that did not (declined, deferred, rejected) has them applied now, in log order.
      if (awaitedSups.has(pos)) {
        if (outcome.kind === 'applied' && outcome.changed) supersedersDone.add(pos);
        else if (outcome.kind !== 'retryable' && !(await replaySkipped(pos))) break;
      }
      // P-524: an op this device cannot decrypt yet makes the fold fetch its key first.
      if (!(await seekMissedKeys())) break;
      if (outcome.kind === 'applied') {
        if (outcome.changed) applied++;
      } else {
        holdCursorHere(outcome, groupKey);
        // An infrastructure outage should cost at most one bounded apply per
        // log per pass. Dependency/rejection cases still allow later rows to land.
        if (outcome.kind === 'retryable') break;
      }
    }
    // P-002 step 2: every exit from the loop above (end of log, a read stall, a
    // retryable apply) lands here, so this commit covers them all. A lost batch
    // rewinds `pos` before the position below is taken. The op at `pos` may have
    // started (a retryable break), so the serial replay also covers it.
    await settleBatch(Math.min(pos + 1, upper));
    // P-528: a skip still pending here never saw its superseder write: its batch rolled
    // back, the pass ended before it (a read stall, a retryable apply), or its own replay
    // did not apply. Its group applies in log order from the skipped op, which the
    // position below does not pass, through the superseder.
    if (pendingSkips.length > 0) {
      const groups = cursor.supersededNoSkip?.get(log.keyHex) ?? new Map<string, number>();
      for (const skip of pendingSkips) {
        groups.set(skip.groupKey, Math.max(groups.get(skip.groupKey) ?? 0, skip.sup + 1));
      }
      (cursor.supersededNoSkip ??= new Map()).set(log.keyHex, groups);
    }
    // WI-559: never advance PAST a structurally-deferred op — positions are
    // monotonic, so doing so loses it exactly as permanently as quarantining it.
    cursor.positions.set(log.keyHex, effectivePos(pos));
    // P-528: a group's serial replay is over once the cursor has passed its superseder.
    const replaying = cursor.supersededNoSkip?.get(log.keyHex);
    if (replaying) {
      const at = effectivePos(pos);
      for (const [groupKey, until] of replaying) if (until <= at) replaying.delete(groupKey);
      if (replaying.size === 0) cursor.supersededNoSkip?.delete(log.keyHex);
    }
    // P-002 step 2: the serial replay is over once the cursor reaches its end. Read
    // the map, not `serialUntil`: a batch lost this pass has just raised it.
    const serialEnd = cursor.batchSerialUntil?.get(log.keyHex);
    if (serialEnd !== undefined && effectivePos(pos) >= serialEnd) cursor.batchSerialUntil?.delete(log.keyHex);
    if (firstDeferredPos < 0) cursor.applyFailures?.delete(log.keyHex);
    // WI-2105 REV fix: persist this log's advanced cursor (persist-after-apply —
    // the pass's applies committed above). Guarded on `pos > from` so an
    // unchanged log doesn't churn PG each 1Hz tick.
    if (onCursorAdvance && (pos > from || firstDeferredPos >= 0 || previousFailure)) {
      try {
        mark('cursor-persist (log end)', log.keyHex, pos);
        await onCursorAdvance(cursor.positions);
      } catch (err) {
        // best-effort: a failed persist must never abort the merge pass
        warnCursorPersistFailed(err);
      }
    }
    if (effectivePos(pos) < log.length) {
      caughtUp = false;
      try {
        opts?.onBacklog?.(log.keyHex, effectivePos(pos), log.length);
      } catch {
        // observability must never abort the pass
      }
    }
  }

  if (probe) {
    probe.phase = 'folded';
    probe.phaseSince = Date.now();
  }
  // P-002 step 2: batch counters only when a batch transaction actually ran, so a
  // pass whose sink never joined one reports exactly what it did before.
  const batchStats =
    batch && (batch.stats.commits > 0 || batch.stats.rewinds > 0) ? { batch: { ...batch.stats } } : {};
  return {
    applied,
    decoded,
    caughtUp,
    truncated: false,
    ...(prefetchStoredOrder ? { storedOrderSkips } : {}),
    ...(skipSuperseded ? { supersededSkips } : {}),
    snapshotChunksJumped,
    ...batchStats,
  };
}

/**
 * WI-2003: how many CONSECUTIVE read failures (rejected `log.get(i)` — e.g. a
 * hypercore/signature verify failure during identity divergence) at the SAME
 * position before we stop retrying and dead-letter (advance past) it. Mirrors
 * `MAX_APPLY_THROWS` — a couple of free retries in case it's transient (e.g. a
 * race with identity repair landing), bounded so a genuinely-permanent failure
 * can't wedge the rest of this peer's log forever.
 */
const MAX_READ_THROWS = 3;

/** Like readOpBounded, but distinguishes a RESOLVED null (gate drop / out of
 *  range → cursor may advance) from an UNAVAILABLE op (timeout — a transient
 *  peer-offline/not-yet-downloaded condition; cursor must NOT advance, retried
 *  unbounded) from a "read-error" (WI-2003: `log.get(i)` itself REJECTED — e.g.
 *  a permanent signature/verify failure; bounded retry + dead-letter at the
 *  call site, see `MAX_READ_THROWS`). Only the timeout RACE collapses to
 *  `unavailable` — a thrown/rejected `log.get(i)` is surfaced distinctly so the
 *  caller can tell "peer hasn't sent it yet" apart from "this will never read". */
async function readOpBoundedDetailed(
  log: AdmittedLog,
  i: number,
  timeoutMs: number,
  onLateResult?: (result: ReadAttemptResult) => void,
): Promise<
  | { kind: 'op'; op: PeerLogOp | null }
  | {
      kind: 'unavailable';
      pending: Promise<boolean>;
      startedAtMs: number;
    }
  | { kind: 'read-error'; err: unknown }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const UNAVAILABLE = Symbol('unavailable');
  const startedAtMs = Date.now();
  // Start the physical read exactly once. The promise resolves to a tagged
  // result instead of rejecting so a late failure is safely consumable by the
  // next pass and cannot become an unhandled rejection.
  const result = Promise.resolve()
    .then(() => log.get(i))
    .then(
      (op) => ({ kind: 'op' as const, op }),
      (err) => ({ kind: 'read-error' as const, err }),
    );
  try {
    if (timeoutMs <= 0) {
      return await result;
    }
    const timeout = new Promise<typeof UNAVAILABLE>((resolve) => {
      timer = setTimeout(() => resolve(UNAVAILABLE), timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
    });
    const r = await Promise.race([result, timeout]);
    if (r !== UNAVAILABLE) return r;
    // WI-2141796 / P-203 — hand the caller the STILL-PENDING read and when it
    // started. D-018 retains its eventual tagged result by position so a later
    // pass can consume a slow-but-served block before issuing another read.
    // The bound proves only that the read did not FINISH in time; it says nothing
    // about whether the block is UNREADABLE or merely SLOW, and that distinction
    // is the one this outage class has never been able to make. Whether this
    // promise ever settles decides it.
    //
    // Settled to a boolean rather than handed over raw on purpose: the caller
    // abandons this read, so a raw promise that later REJECTS would be an
    // unhandled rejection. `true` = the read did eventually arrive (slow, not
    // unreadable); `false` = it eventually rejected.
    const pending = result.then((r) => {
      try {
        onLateResult?.(r);
      } catch {
        // A diagnostic cache must never turn a late read into a merge failure.
      }
      return r.kind === 'op';
    });
    return { kind: 'unavailable', pending, startedAtMs };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
