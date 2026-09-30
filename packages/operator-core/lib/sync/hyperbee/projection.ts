/**
 * Bidirectional PG ↔ Hyperbee projection registry.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031.
 *
 * Per-table read/write hooks are registered here; the substrate
 * applies them on Hyperbee ops it receives + invokes them on PG
 * writes that need to fan out to Hyperbee.
 *
 * NOT WIRED YET to the actual operator boot path or PG triggers —
 * this commit ships the interface + registry + LWW helper. Per-table
 * hooks land in follow-up commits (one per HYPERBEE-bucket table)
 * because each table has its own row contract.
 *
 * v5 D-012 — same-key Hyperbee conflicts resolve LWW by `ts` (op
 * timestamp). LWW helper here is pure + testable.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type postgres from 'postgres';
import { pinModuleState } from '@papercusp/module-singleton';
import type { OpEnvelope } from './op-envelope-types';
import { observeMergedOp } from './clobber-events';
import { observeRemoteHlc } from './hlc-stamp';
import { encodeHlc, type HlcClock } from '@papercusp/locks-core';

/**
 * G1 Provenance context (P-002). Passed to `writeToPg` so each per-table writer
 * can stamp `author_pubkey` + `origin` on the upserted row.
 *
 * `origin` is determined by the apply path (not the writer) because it requires
 * comparing `sourceLogKeyHex` against the own log's `keyHex` — information
 * the writer doesn't hold. The writer just stamps the values it receives.
 */
export interface ProvenanceContext {
  /**
   * The UNFORGEABLE writer identity for this op (maps to `author_pubkey`
   * column). P-002/D-004: for a `local` op it's the own device pubkey (the
   * trustworthy self-declared `writerPubkey`); for a `remote` op it's the
   * receiver-stamped, immutable `sourceLogKeyHex` (the source log core key) —
   * NOT the self-declared field, which a remote peer controls. `''` when a
   * remote op carries no source key. Resolve a remote value to its
   * device/GitHub identity at read time via the admission map.
   */
  authorPubkey: string;
  /** 'local' | 'remote' — derived from log-source (own vs admitted-remote). */
  origin: 'local' | 'remote';
  /**
   * EI-79 residual step 2: the op's WIRE ts (epoch ms) — the LWW ordering field
   * `lwwPick` orders on. Writers persist it as the table's `fed_ts` column and
   * guard their `ON CONFLICT ... DO UPDATE` with `WHERE EXCLUDED.fed_ts >=
   * <table>.fed_ts`, so a strictly-older (out-of-order / backfilled) op can
   * never clobber a newer projected row — making each writer PG-level
   * last-write-wins INDEPENDENT of the incremental merge cursor's in-process
   * fold. `undefined` for a synthetic/local op built without a ts (the writers
   * treat a NULL stored fed_ts as "older than anything", so such a write lands).
   */
  ts?: number;
  /**
   * D-001 (shared-pot-release-testing Brief J): the op's HLC ordering key — the
   * SAME causal clock `lwwPick` orders the merge fold by. Writers persist it as
   * the table's `fed_hlc` column and guard their `ON CONFLICT …` with
   * `harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >=
   * harness_shared.fed_order_key(<table>.fed_hlc, <table>.fed_ts)` — a SQL mirror
   * of `lwwPick`'s single derived-order-space fix (EI-1698: `hlc ?? encodeHlc({ms:
   * ts ?? 0, count: 0})` on both sides), so the guard compares in the exact same
   * total order the fold does and never rejects a fold-winner under clock skew or
   * mixed HLC presence (the D-001 split-brain). `undefined` for an op without an
   * `hlc` (the append-only claim path; legacy ops) — the writer stores NULL and
   * the guard derives an order key from `fed_ts` instead.
   */
  fedHlc?: string;
  /**
   * WI-3734: the op's RECEIVER-STAMPED source-log core key (`op.sourceLogKeyHex`),
   * threaded verbatim so a per-projection apply guard can key on the unforgeable
   * log source — register-all's owned-home exclusion skips hive-home-grained ops
   * sourced from a locally-booted home's own log (the home fold owns them).
   * `undefined` for a synthetic/local op built without a source log.
   */
  sourceLogKeyHex?: string;
}

export interface TableProjection<Row> {
  /** Table tag, matching `hyperbee-key-types.HYPERBEE_TABLE_TAGS`. */
  tableTag: string;
  /**
   * EI-117 echo breaker. Set `true` on projections whose PG table is
   * CDC-CAPTURED (a capture trigger enqueues local PG writes into
   * `substrate_outbox`, the drain appends them to the own log): for those
   * tables an own-log op is by construction a REPLAY of a row PG already
   * authored, so applying it back is at best redundant and at worst a silent
   * revert (an old op landing over newer local content) whose write re-enters
   * the capture trigger as `origin='local'` — the self-sustaining echo storm
   * behind EI-117 (plan-doc reverts) and a contributor to EI-125 (outbox
   * bloat). Log-first tables (claims / queue / working-set / contributors /
   * presence / prs / usage) must NOT set this — their PG state arrives via the
   * merge, own ops included. Skipping is gated on log-source verification in
   * `applyOpVia` (`op.sourceLogKeyHex === ownLogKeyHex`); paths without an
   * `ownLogKeyHex` (legacy global-registry) skip nothing.
   */
  skipOwnOps?: boolean;
  /**
   * Build the Hyperbee key for a given row. Single source of truth
   * for the per-table key shape — composer + parser stay aligned.
   */
  composeKey: (row: Row) => string;
  /** Parse the row out of a Hyperbee value. */
  decodeValue: (raw: unknown) => Row | null;
  /**
   * F1-4 / P-012 (federated-scout-gym): optional per-source refused-op
   * observability. When `decodeValue` returns null — the op was DECLINED (a
   * malformed wire row, or a non-federatable elite a buggy/hostile sender's log
   * carried) — `applyOpVia` invokes this with the raw op value and the SAME
   * resolved `ProvenanceContext` the put path would see, so a projection can bump
   * a per-source refused-op counter (`federation_refused_op_counters`, mig 474).
   * Only content projections that want the observability implement it; the rest
   * silently drop as before. FAIL-SOFT: `applyOpVia` swallows a throw so refusal
   * accounting can never break the apply loop. Called only for a `put` whose
   * decode failed (a `del` carries no value to validate).
   */
  onRefusedOp?: (rawValue: unknown, provenance: ProvenanceContext) => void | Promise<void>;
  /**
   * Write the row into PG (idempotent — must handle re-application).
   *
   * G1 Provenance (P-002 / WI-41277): the second arg carries explicit
   * `{ authorPubkey, origin }` so the writer can stamp `author_pubkey` +
   * `origin` on the upserted row. It is REQUIRED: treating an omitted context
   * as local masks remote rows and can make them eligible for re-emission.
   *
   * P-528: resolve `false` when the writer REFUSED the op (it dropped it for a reason
   * other than LWW order, e.g. an identity or collision guard), so `applyOpVia` reports
   * it as not applied. Resolving nothing means the op was handled.
   */
  writeToPg: (row: Row, provenance: ProvenanceContext) => Promise<void | false>;
  /**
   * Delete the row from PG (idempotent).
   *
   * EI-79 residual step 2: `delTs` is the del op's WIRE ts (epoch ms). The
   * deleter guards its DELETE with `WHERE fed_ts IS NULL OR fed_ts <= <delTs>`,
   * the symmetric partner of the upsert's `fed_ts`-`>=` guard, so a stale (out
   * of order / backfilled) del can never erase a row a newer put recreated —
   * making the deleter PG-level LWW independent of the merge cursor's fold.
   * `undefined` for a del op built without a ts (unguarded → deletes, the
   * pre-step-2 behavior).
   *
   * D-001 (Brief J): `delHlc` is the del op's HLC ordering key. The deleter
   * guards its DELETE with the SAME HLC-then-fed_ts order as the put guard (a
   * stale del — lower HLC — must not erase a row a newer put recreated), falling
   * back to the `delTs` ts-guard when either side lacks an hlc. `undefined` for a
   * del op without an `hlc` (legacy / claim path) → the ts-guard alone applies.
   *
   * P-018 / D-012: the optional 4th arg carries the SAME `ProvenanceContext` the put
   * path resolves (the UNFORGEABLE author identity + origin), so an author-scoped
   * deleter can authorize a tombstone by row OWNERSHIP — i.e. reject a stranger-member
   * deleting another member's plan in a public/open hive. Optional + back-compatible:
   * deleters that don't author-scope ignore it (today's behavior).
   */
  deleteFromPg: (
    key: string,
    delTs?: number,
    delHlc?: string,
    provenance?: ProvenanceContext,
  ) => Promise<void>;
  /**
   * p2p-join-catchup-speed-2026-09-23 P-002 (WI-10002479): OPTIONAL read-only
   * lookup of the federation order (`fed_hlc`, `fed_ts`) STORED on the physical
   * rows these Hyperbee keys address — exactly the pair this projection's own PG
   * LWW guard compares an incoming op against.
   *
   * The incremental merge seeds its in-memory winners with the result, so an op
   * whose clock is STRICTLY older than the stored row is skipped without a PG
   * round trip (the guard would reject it anyway). Measured on the P-203 VM fold:
   * ~99% of replayed work_items ops were such no-ops, each costing ~3 round trips.
   *
   * Contract for implementers:
   *  - Return an entry ONLY for a key that maps to exactly one physical row, and
   *    only when that row's `fed_hlc`/`fed_ts` are the values the put AND del
   *    guards compare (both must reject any op whose order key is strictly lower).
   *  - Omit keys you cannot resolve unambiguously (e.g. a bare legacy key whose
   *    physical row depends on the op value). An omitted key is simply applied.
   *  - Read-only and side-effect free; a throw is swallowed by the caller.
   */
  storedOrderForKeys?: (keys: readonly string[]) => Promise<Map<string, StoredFedOrder>>;
  /**
   * p2p-join-catchup-speed-2026-09-23 P-528 (D-018 #3): OPTIONAL. True when the incremental
   * merge may skip a put under `key` that a later put under the same key, from the same
   * source log, beats under LWW. The merge still applies the later put and never passes the
   * skipped one until that put has applied and committed; if it does not apply, the key's
   * puts replay in log order.
   *
   * Contract for implementers (answer from the KEY alone; the merge sees sealed values):
   *  - Every put under this key writes the SAME physical row, whatever its value holds.
   *  - A put carries the author's whole row, so applying the later put alone leaves the row
   *    the pair would have left: no field is merged from the stored row in a way an earlier
   *    put by the same author could change.
   *  - Whether the writer refuses a put depends only on the source log and the key, not on
   *    the value; a value-dependent refusal must resolve `false` from the apply instead.
   * Omit it (or return false) for a key that cannot promise all three.
   */
  supersedableKey?: (key: string) => boolean;
  /**
   * P-002 step 2 (p2p-join-catchup-speed D-002): this projection may apply inside
   * the incremental merge's batch transaction.
   *
   * Contract: EVERY PG statement the projection's `writeToPg` / `deleteFromPg`
   * issues (helper reads included) goes through
   * `await projectionSql(<the handle it would otherwise use>)`, and the projection
   * sets no transaction-local state (no `SET LOCAL` / `set_config(..., true)`).
   * A projection that CATCHES a PG error from one of those statements and then
   * keeps issuing statements calls `await projectionStatementFailed()` first
   * (inside the batch the error aborted the whole transaction).
   * A projection that cannot promise all of this leaves the flag unset: the merge
   * then commits any open batch BEFORE it writes, so it never waits on a row lock
   * the batch holds and never reads around the batch's uncommitted rows.
   */
  batchable?: true;
}

/**
 * P-002 step 2 — the incremental merge's per-op view of its open batch
 * transaction. Bound to ONE op via {@link runInProjectionBatch}; a call made
 * after that op finished (a timed-out apply still running) gets the plain
 * target back, so a zombie write can never land inside a later op's savepoint.
 */
export interface ProjectionBatchSession {
  /** The batch transaction on `target` (opened on first use), or `target` itself when this op is no longer current. */
  sqlFor(target: postgres.Sql): Promise<postgres.Sql>;
  /** Commit the open batch now (called before a NON-batchable projection writes). Throws when the commit failed. */
  flush(): Promise<void>;
  /** Roll this op back to its savepoint after a statement error the projection caught (see {@link projectionStatementFailed}). */
  recover(): Promise<void>;
  /**
   * P-536: hand `record` to the batch's pending group for `writer` instead of writing it
   * now. True when the batch took it (see {@link projectionDefer}); absent or false means
   * the op writes the record itself.
   */
  defer?(target: postgres.Sql, writer: ProjectionGroupWriter<unknown>, record: unknown): Promise<boolean>;
  /**
   * P-537: queue `fn` to run once the batch transaction holding this op's writes commits.
   * A lost batch drops it (the fold replays the op, which queues it again), and so does an
   * op that did not apply. False means this op's writes are not in the open transaction
   * (it wrote nothing yet, or autocommitted); the caller runs `fn` now.
   */
  afterCommit?(fn: () => Promise<void>): boolean;
}

/**
 * p2p-join-catchup-speed-2026-09-23 P-536 (D-034 #1): a projection's multi-row write.
 *
 * Measured on the Mac VM (w1-bench-vm.log): writing engineer-issues rows one statement
 * pair at a time runs 855-1,320 rows/s on 4 lanes and costs node 0.5-1.0 ms of CPU per
 * row; one collision SELECT and one multi-row INSERT per 50 rows run 3,240-3,780 rows/s at
 * 0.05-0.2 ms. So a batch that runs groups ({@link projectionDefer}) collects an op's record
 * instead of writing it, and writes every record it holds for one writer in one go before
 * its transaction commits.
 *
 * Contract for implementers:
 *  - `writeOne(record)` is exactly what the op would have written without the group: its
 *    statements go through {@link projectionSql}, and a caught statement error calls
 *    {@link projectionStatementFailed} first. It resolves `false` when it refused the record.
 *  - `writeMany(sql, records)` leaves the rows `writeOne` would leave, applied in order,
 *    using only `sql` (the batch transaction). The batch never passes two records for the
 *    same {@link rowOf}, so each record's reads see the rows as they stood before the group.
 *    It may throw on any failure: the batch rolls the group back and replays every record
 *    through `writeOne`, one savepoint each.
 *  - The record carries everything the write needs; the op has already returned when the
 *    group is written, so nothing may be read from the op's context then.
 */
export interface ProjectionGroupWriter<R> {
  /** Names the writer in logs. */
  readonly name: string;
  /** The physical row `record` writes. */
  rowOf(record: R): string;
  writeMany(sql: postgres.Sql, records: readonly R[]): Promise<void>;
  writeOne(record: R): Promise<void | false>;
}

// Pinned: read-merge enters the store and every projection reads it, so a split
// module record would silently run every batchable write outside the batch.
const projectionBatchStore = pinModuleState(
  '@papercusp/operator-core.sync.projection-batch-store',
  () => new AsyncLocalStorage<ProjectionBatchSession>(),
);

/** Run `fn` with `session` as the ambient batch for every projection write it awaits. */
export function runInProjectionBatch<T>(session: ProjectionBatchSession, fn: () => Promise<T>): Promise<T> {
  return projectionBatchStore.run(session, fn);
}

/**
 * The handle a batchable projection must use for its apply statements: the
 * ambient batch transaction when the merge runs one, otherwise `target`.
 */
export async function projectionSql(target: postgres.Sql): Promise<postgres.Sql> {
  const session = projectionBatchStore.getStore();
  return session ? session.sqlFor(target) : target;
}

/**
 * Call after CATCHING a PG error from a statement issued on the
 * {@link projectionSql} handle, before issuing another statement on it.
 *
 * Outside a batch this does nothing: the failed autocommit statement rolled back
 * alone. Inside the batch the error aborted the whole transaction, so every later
 * statement would fail with 25P02, and a caught one would silently turn what the
 * serial path treats as a handled error into a failed op. This rolls the op back
 * to its savepoint, which undoes EVERY statement the op issued so far. Call it
 * only when those were reads, or when the op re-issues its writes afterwards.
 */
export async function projectionStatementFailed(): Promise<void> {
  await projectionBatchStore.getStore()?.recover();
}

/**
 * P-537: run `fn` once the rows this op wrote are committed. Inside the merge's batch
 * they stay invisible to every other connection until COMMIT, so an effect that other
 * readers act on (a wake, an event re-fire, a write on another connection) must wait for
 * it. Outside a batch, or when the op's writes autocommitted, `fn` runs now. `fn` runs
 * with no ambient batch and must use a plain handle, never the {@link projectionSql} one.
 */
export async function projectionAfterCommit(fn: () => Promise<void>): Promise<void> {
  if (projectionBatchStore.getStore()?.afterCommit?.(fn)) return;
  await fn();
}

/**
 * P-537: commit the merge's open batch now. For a batchable projection's rare path that
 * writes on another connection: without it that write could wait on a row lock the batch
 * holds while the batch waits on the op. Throws when the commit failed (the fold replays).
 */
export async function projectionFlush(): Promise<void> {
  await projectionBatchStore.getStore()?.flush();
}

/** P-537: run `fn` with no ambient batch (after-commit effects of an op that has ended). */
export function runOutsideProjectionBatch<T>(fn: () => T): T {
  return projectionBatchStore.exit(fn);
}

/**
 * P-536: offer `record` to the ambient batch's group for `writer`. True means the batch
 * owns the write now: it lands with the batch's other records for `writer` before the
 * batch commits, and the op must issue nothing more for it. False (no batch, a batch that
 * runs no groups, or one that could not open) means the op writes it itself.
 */
export async function projectionDefer<R>(
  target: postgres.Sql,
  writer: ProjectionGroupWriter<R>,
  record: R,
): Promise<boolean> {
  const session = projectionBatchStore.getStore();
  if (!session?.defer) return false;
  return session.defer(target, writer as ProjectionGroupWriter<unknown>, record);
}

/** The federation order stored on a PG row (`fed_hlc`, `fed_ts`), as the LWW guard reads it. */
export interface StoredFedOrder {
  hlc: string | null;
  ts: number | null;
}

/** One `(table, key)` pair the incremental merge is about to fold. */
export interface StoredOrderLookupEntry {
  table: string;
  key: string;
}

/**
 * Resolve the stored federation order for a window of upcoming ops, keyed by the
 * merge's group key `${table}::${key}`. Tables whose projection does not
 * implement `storedOrderForKeys` contribute nothing (their ops are applied as today).
 */
export type StoredOrderPrefetch = (
  entries: readonly StoredOrderLookupEntry[],
) => Promise<Map<string, StoredFedOrder>>;

/** Build a {@link StoredOrderPrefetch} over a projection lookup (one query per opted-in table). */
export function buildStoredOrderPrefetch(lookup: ProjectionLookup): StoredOrderPrefetch {
  return async (entries) => {
    const byTable = new Map<string, string[]>();
    for (const { table, key } of entries) {
      if (!table || !key) continue;
      const list = byTable.get(table);
      if (list) list.push(key);
      else byTable.set(table, [key]);
    }
    const out = new Map<string, StoredFedOrder>();
    for (const [table, keys] of byTable) {
      const lookupFn = lookup(table)?.storedOrderForKeys;
      if (!lookupFn) continue;
      const found = await lookupFn(keys);
      for (const [key, order] of found) out.set(`${table}::${key}`, order);
    }
    return out;
  };
}

/**
 * P-528: which `(table, key)` puts the incremental merge may skip when superseded (see
 * `TableProjection.supersedableKey`). A table whose projection does not implement it
 * answers false.
 */
export type SupersedablePut = (table: string, key: string) => boolean;

/** Build a {@link SupersedablePut} over a projection lookup. */
export function buildSupersedablePut(lookup: ProjectionLookup): SupersedablePut {
  return (table, key) => lookup(table)?.supersedableKey?.(key) === true;
}

const registry = new Map<string, TableProjection<unknown>>();

export function registerProjection<Row>(p: TableProjection<Row>): void {
  registry.set(p.tableTag, p as TableProjection<unknown>);
}

export function getProjection(tableTag: string): TableProjection<unknown> | null {
  return registry.get(tableTag) ?? null;
}

export function _clearRegistryForTests(): void {
  registry.clear();
}

/**
 * A projection-set lookup: `tableTag → projection | null`. The single seam
 * `applyOpVia` dispatches through, so the GLOBAL registry and a PER-HARNESS
 * scoped projection set share one apply implementation (no duplicated
 * put/del/decode/clobber logic). The global path passes the module registry's
 * `getProjection`; a per-harness path passes a lookup bound to that harness's
 * own projection set (see `buildHarnessProjectionApply` in `projections/
 * register-all.ts`).
 */
export type ProjectionLookup = (tableTag: string) => TableProjection<unknown> | null;

/**
 * G1 Provenance (P-002): options for `applyOpVia`. The `ownLogKeyHex` is the
 * hex key of this harness's own writable log (from `ownLog.keyHex` in
 * `boot.ts`). When provided, `applyOpVia` determines `origin` by comparing
 * `op.sourceLogKeyHex === ownLogKeyHex` (log-source approach, D-006). When
 * absent (global registry path / callers that haven't threaded it yet), origin
 * falls back to `writerPubkey`-comparison against `ownWriterPubkey`; if neither
 * is available, origin defaults to `'local'` (safe default — the global-registry
 * path is single-harness legacy; no remote peers write through it).
 */
export interface ApplyOpOpts {
  /**
   * The own log's hex keyHex. When set, `op.sourceLogKeyHex === ownLogKeyHex`
   * → `origin='local'`; any other source → `origin='remote'`.
   */
  ownLogKeyHex?: string;
  /**
   * Override the process-global HLC the RECV seam advances on a remote op.
   * Defaults to `processHlc()`. A test harness simulating MULTIPLE peers in ONE
   * process passes a PER-PEER clock so each simulated peer advances its OWN clock
   * on receive (real peers are separate processes); paired with the same per-peer
   * clock on `stampOpHlc` (boot's send seam).
   */
  hlcClock?: HlcClock;
}

/**
 * Resolve the {@link ProvenanceContext} for an op — origin (local vs admitted-remote, via
 * log-source) + the UNFORGEABLE author identity + ts/hlc. Shared by the put AND del branches
 * of {@link applyOpVia} (P-018/D-012: deletes need the same provenance the puts do, so an
 * author-scoped deleter can authorize a tombstone by row ownership). Pure of the projection.
 */
function resolveOpProvenance(op: OpEnvelope, applyOpts?: ApplyOpOpts): ProvenanceContext {
  // G1 Provenance (P-002): determine origin via log-source when possible. Log-source is the
  // authoritative signal (D-006): an op whose sourceLogKeyHex matches the own log's keyHex was
  // written locally and cannot be forged by a remote peer. Without ownLogKeyHex (legacy /
  // global-registry path) we default to 'local' (safe for single-peer use).
  const origin: 'local' | 'remote' =
    applyOpts?.ownLogKeyHex !== undefined
      ? op.sourceLogKeyHex !== undefined && op.sourceLogKeyHex === applyOpts.ownLogKeyHex
        ? 'local'
        : 'remote'
      : 'local';

  // P-002/D-004 — attribution must be UNFORGEABLE. `writerPubkey` is self-declared (a field in
  // the op value), so a remote peer can set it to anything. For a REMOTE op attribute by the
  // receiver-stamped, immutable `sourceLogKeyHex` (the source log core key); `''` when absent
  // rather than trust the forgeable field. For a LOCAL op `writerPubkey` is the operator's OWN
  // write — trustworthy. WI-41277: even legacy/synthetic applies now receive this explicit
  // context; per-table writers never infer local from a missing argument.
  const authorPubkey =
    origin === 'remote' ? (op.sourceLogKeyHex ?? '') : (op.writerPubkey ?? '');
  return { authorPubkey, origin, ts: op.ts, fedHlc: op.hlc, sourceLogKeyHex: op.sourceLogKeyHex };
}

/**
 * WI-6210 detector state. Capped so a legitimately peerless single-harness /
 * global-registry context cannot spam the log — the first occurrences carry the
 * call-site stack (which is what names the offending caller); after the cap a
 * single suppression line is emitted and the counter keeps counting.
 */
const UNTHREADED_APPLY_WARN_CAP = 20;
let unthreadedApplyWarnCount = 0;

type UnthreadedApplyWarnSink = (message: string) => void;

/**
 * Default sink. SILENT under vitest on purpose: several integration suites
 * legitimately build a scoped apply without an own-log key (single-peer
 * fixtures), and this repo runs `vitest-fail-on-console` — a production warn on
 * a test-reachable path would turn every one of those suites red for a
 * diagnostic. The COUNTER below is always live, so a test asserts the detector
 * by count (or by installing its own sink) rather than by console output.
 */
const DEFAULT_UNTHREADED_APPLY_SINK: UnthreadedApplyWarnSink = (message) => {
  if (process.env.VITEST) return;
  console.warn(message);
};
let unthreadedApplyWarnSink: UnthreadedApplyWarnSink = DEFAULT_UNTHREADED_APPLY_SINK;

/** Test seam: capture the detector's message instead of logging it. */
export function setUnthreadedApplyWarnSinkForTest(sink?: UnthreadedApplyWarnSink): void {
  unthreadedApplyWarnSink = sink ?? DEFAULT_UNTHREADED_APPLY_SINK;
}

/** Test seam: reset the WI-6210 detector's warn budget + sink between cases. */
export function resetUnthreadedApplyDetectorForTest(): void {
  unthreadedApplyWarnCount = 0;
  unthreadedApplyWarnSink = DEFAULT_UNTHREADED_APPLY_SINK;
}

/** Observed count of un-threaded skipOwnOps applies this process (WI-6210). */
export function unthreadedSkipOwnOpsApplyCount(): number {
  return unthreadedApplyWarnCount;
}

function noteUnthreadedSkipOwnOpsApply(op: OpEnvelope): void {
  unthreadedApplyWarnCount += 1;
  if (unthreadedApplyWarnCount > UNTHREADED_APPLY_WARN_CAP) return;
  const suffix =
    unthreadedApplyWarnCount === UNTHREADED_APPLY_WARN_CAP
      ? ' [further occurrences suppressed]'
      : '';
  unthreadedApplyWarnSink(
    `[projection] WI-6210 UN-THREADED apply (no ownLogKeyHex) on a skipOwnOps table — the echo ` +
      `breaker cannot fire and provenance will be stamped origin='local' from the FORGEABLE ` +
      `writerPubkey: table=${op.table ?? '?'} key=${op.hbKey ?? '?'} ` +
      `sourceLog=${op.sourceLogKeyHex?.slice(0, 8) ?? 'none'} ` +
      `writer=${op.writerPubkey?.slice(0, 8) ?? 'none'} ts=${op.ts ?? '?'} hlc=${op.hlc ?? 'none'} ` +
      `(#${unthreadedApplyWarnCount})${suffix}. Caller must pass ownLogKeyHex / use ` +
      `buildHarnessProjectionApply.\n${new Error('un-threaded apply call site').stack ?? ''}`,
  );
}

/**
 * Core op-dispatch: resolve `op.table` via `lookup`, then write/delete the row
 * to PG and fire the clobber-event hook. Returns true iff the op was applied
 * (false on unknown table / non-put-del / decode failure / missing key).
 *
 * This is the single source of truth for "apply one op through a projection
 * set" — both `applyHyperbeeOpToPg` (global registry) and a per-harness scoped
 * apply call it with different lookups, so the put/del/decode/clobber logic is
 * NOT duplicated (Model B per-harness projection-apply, D-021 collision fix).
 *
 * G1 Provenance (P-002): when `applyOpts.ownLogKeyHex` is provided, computes
 * `origin` via log-source comparison (`op.sourceLogKeyHex === ownLogKeyHex`
 * → 'local', else 'remote') and passes `ProvenanceContext` to `writeToPg`.
 * Every writer receives the explicit context and stamps or evaluates it according
 * to its table contract; no writer may infer local from argument absence.
 */
export async function applyOpVia(
  lookup: ProjectionLookup,
  op: OpEnvelope,
  applyOpts?: ApplyOpOpts,
): Promise<boolean> {
  if (op.type !== 'put' && op.type !== 'del') return false;
  if (!op.table) return false;
  const p = lookup(op.table);
  if (!p) return false;
  // EI-117 echo breaker: skip log-source-VERIFIED own ops on CDC-captured
  // tables (see `TableProjection.skipOwnOps`). WI-1684: narrowed to PUTS ONLY.
  // An own PUT re-apply is an UPSERT that re-fires the capture trigger as
  // origin='local' → the echo storm the skip exists to break. An own DEL must
  // NOT be skipped: during the drain window (before the author's own del reaches
  // its own log) a concurrent lower-hlc foreign put can hit the no-row INSERT
  // path and RESURRECT the row on the author peer only; the winning own del is
  // then the ONLY thing that can clean it up, and skipping its apply makes the
  // resurrection permanent (silent split-brain on row PRESENCE — the deleting
  // peer keeps a row every other peer deleted). Re-applying the del is echo-safe:
  // a 0-row delete never fires the FOR EACH ROW capture trigger, and a resurrected
  // row is origin='remote' so capture's echo-guard skips it — neither re-enters the
  // outbox. deleteFromPg stays fed_hlc-guarded, so it cannot erase a row a
  // genuinely-newer put recreated.
  if (
    p.skipOwnOps === true &&
    op.type === 'put' &&
    applyOpts?.ownLogKeyHex !== undefined &&
    op.sourceLogKeyHex !== undefined &&
    op.sourceLogKeyHex === applyOpts.ownLogKeyHex
  ) {
    return false;
  }
  // ── WI-6210 DETECTOR: un-threaded apply on a skipOwnOps table ───────────────
  // Fires for EITHER apply path (global registry OR a scoped apply that was
  // built without an own-log key) — that is the point: the class is defined by
  // the MISSING `ownLogKeyHex`, not by which caller omitted it, and a detector
  // installed on only one of the two paths can miss the real one.
  //
  // Why this is corruption and not a legacy nicety: with no own-log key the
  // echo breaker above cannot fire (it needs the key to recognise this host's
  // own op), AND `resolveOpProvenance` falls through to origin='local' attributed
  // by the FORGEABLE `writerPubkey`. So this host re-applies its own captured
  // echo of a REMOTE publisher's row and re-stamps it origin='local' with a
  // locally-generated clock NEWER than the wire — after which every redelivery
  // of the publisher's genuine op loses the LWW compare and the federated record
  // stays permanently shadowed, with no repair path. Observed live on the p2p
  // first-green rig (2026-07-27, frame a re-stamping b's seat offer ~120ms after
  // applying it correctly); invisible in both the logs and the database, which is
  // the only reason it survived four gate runs and three wrong diagnoses.
  //
  // The FIX belongs at the caller (thread `ownLogKeyHex` / use the per-harness
  // scoped apply), so this changes no behaviour — it makes the class AUDIBLE and
  // the stack names the caller. Capped so a single-harness/global context that
  // legitimately has no peers cannot spam the log.
  // P-002 step 2: a projection outside the batch contract writes on its own
  // connection. Commit the merge's open batch first, so it neither waits on a row
  // lock the batch holds (a self-deadlock until the apply timeout) nor reads
  // around rows the batch has not committed yet.
  const batchSession = p.batchable === true ? undefined : projectionBatchStore.getStore();
  if (batchSession) await batchSession.flush();
  if (p.skipOwnOps === true && op.type === 'put' && applyOpts?.ownLogKeyHex === undefined) {
    noteUnthreadedSkipOwnOpsApply(op);
  }
  // P-010 RECV seam: observing a REMOTE op's HLC advances this process's logical
  // clock past the remote causal frontier, so a subsequent LOCAL write is
  // stamped strictly-greater — the cross-machine happens-before that makes
  // `lwwPick` causal rather than wall-clock-skew-dependent. Fires for every
  // applied remote op (put or del) that carries an `hlc`; own ops never advance
  // (we authored them). Gated on log-source: only with `ownLogKeyHex` known can
  // we tell remote from own — the single-harness/global-registry path has no
  // remote peers, so skipping the advance there is correct.
  if (
    op.hlc &&
    applyOpts?.ownLogKeyHex !== undefined &&
    op.sourceLogKeyHex !== undefined &&
    op.sourceLogKeyHex !== applyOpts.ownLogKeyHex
  ) {
    observeRemoteHlc(op.hlc, applyOpts.hlcClock);
  }
  if (op.type === 'del') {
    if (!op.hbKey) return false;
    // EI-79 step 2 + D-001: thread the del op's wire ts AND its HLC so the
    // deleter can guard the DELETE by the same HLC-then-fed_ts order as the put
    // guard (a stale del must not erase a row a newer put recreated).
    // P-018/D-012: thread the SAME provenance the put path resolves, so an author-
    // scoped deleter can authorize a tombstone by row OWNERSHIP (the unforgeable
    // source-log identity) — rejecting a stranger-member's delete in an open hive.
    await p.deleteFromPg(op.hbKey, op.ts, op.hlc, resolveOpProvenance(op, applyOpts));
    return true;
  }
  const row = p.decodeValue(op.value);
  if (!row) {
    // F1-4 / P-012: the op was DECLINED (malformed / not-federatable). Give the
    // projection a chance to record a per-source refused-op counter. Fail-soft —
    // refusal accounting must never break the apply loop.
    if (p.onRefusedOp) {
      try {
        await p.onRefusedOp(op.value, resolveOpProvenance(op, applyOpts));
      } catch {
        /* observability is not load-bearing */
      }
    }
    return false;
  }

  const provenance = resolveOpProvenance(op, applyOpts);

  if ((await p.writeToPg(row, provenance)) === false) return false;
  // P-035: clobber-event hook. Fires only when the incoming op has
  // a writerPubkey + the tracker has a recent local write for the
  // same key from a *different* pubkey within the 60s window.
  // No-op when writerPubkey is absent (legacy / un-threaded write).
  if (op.writerPubkey && op.hbKey && typeof op.ts === 'number') {
    observeMergedOp({
      table: op.table,
      hbKey: op.hbKey,
      ts: op.ts,
      pubkey: op.writerPubkey,
    });
  }
  return true;
}

/**
 * Apply one Hyperbee op against the GLOBAL registry. Called by the
 * Hyperbee read loop. Returns true if the op was applied to PG,
 * false if it was dropped (unknown table / decode failed / LWW
 * stale).
 *
 * NOTE (Model B): with 2+ booted harnesses, the global registry is a
 * last-writer-wins collision point — `registerAllHarnessProjections` overwrites
 * by `tableTag`, so this global apply dispatches to whichever harness registered
 * last. Model B's boot path therefore uses a PER-HARNESS scoped apply
 * (`buildHarnessProjectionApply`) instead of this global function. This is kept
 * for any caller that still has a single-harness global view.
 */
export async function applyHyperbeeOpToPg(op: OpEnvelope): Promise<boolean> {
  // WI-6210: this global apply carries NO `ApplyOpOpts`, so every op it applies
  // is un-threaded by construction. The DETECTOR for that class lives inside
  // `applyOpVia` (see the block above the P-010 RECV seam) so it covers BOTH
  // this path and a scoped apply that was built without an own-log key —
  // installing it only here would miss the other half of the class.
  return applyOpVia((tableTag) => registry.get(tableTag) ?? null, op);
}

/**
 * LWW conflict resolution helper (D-003 HLC; tiebreak hardened in D-004/P-001).
 * Given two ops on the same key, return the one to keep:
 *
 *   1. the causally-later clock wins — by HLC (`encodeHlc` string compare) when
 *      BOTH ops carry one, else by the bare wall-clock `ts` (back-compat);
 *   2. on an exact tie, `del` beats `put` (safety — a delete that raced a write
 *      at the same instant takes precedence);
 *   3. on a clock tie with the SAME type (del/put doesn't decide), the op with
 *      the lexicographically-GREATER `sourceLogKeyHex` wins.
 *
 * The HLC (D-003) makes step 1 monotone across NTP corrections and causally
 * correct across machines — a backward clock step can no longer resurrect a
 * stale write, and a value that causally followed another never loses to it on
 * a wall-clock coincidence. It is additive: an op without `hlc` falls back to
 * `ts`, so the field rolls out per surface with no flag day. The encoded HLC is
 * a fixed-width sortable string, so `>` on it equals compareHlc.
 *
 * Step 3 is what makes the fold fully order-independent: the previous
 * "return the first arg" rule was arrival-order-dependent, so two peers folding
 * the same two ops in opposite orders could pick different winners and diverge.
 * The tiebreak keys off `sourceLogKeyHex` — the receiver-stamped source-log key
 * (`read-merge.toEnvelope`), which is BOTH peer-stable (every peer sees the same
 * source log keys) AND unforgeable (a writer controls the self-declared
 * `writerPubkey`, but NOT which admitted log a received op was replicated from).
 * A missing `sourceLogKeyHex` (synthetic / local legacy ops built outside the
 * merge path) is treated as `''` so the comparison stays total and stable.
 */
export function lwwPick(a: OpEnvelope, b: OpEnvelope): OpEnvelope {
  // Step 1 — causal clock, as a SINGLE TOTAL order (EI-1698). Give EVERY op one
  // comparable key: its HLC when present, else a DERIVED HLC `{ms: ts, count: 0}`
  // (a no-HLC op behaves like an HLC op at wall-time `ts`, logical 0). Comparing
  // the SAME key for every pair is transitive. The previous rule — "HLC when BOTH
  // carry one, ELSE ts" — switched basis per pair and was NON-TRANSITIVE under
  // mixed HLC presence: a no-HLC op whose ts sat BETWEEN two HLC ops on a key
  // formed a winner cycle (X>Z, Z>Y, Y>X), so two peers folding the same ops in
  // different delivery orders diverged on a contended key (rolling-upgrade skew).
  // Backward-compatible: HLC-only pairs still compare by HLC, ts-only pairs still
  // compare by ts (both via encodeHlc's fixed-width sortable `ms:count` string),
  // and a no-HLC op (pre-P-010 = oldest ts) sorts below the newer HLC ops as before.
  const ka = a.hlc ?? encodeHlc({ ms: a.ts ?? 0, count: 0 });
  const kb = b.hlc ?? encodeHlc({ ms: b.ts ?? 0, count: 0 });
  if (ka > kb) return a;
  if (kb > ka) return b;
  // ── clock tie ──
  // del beats put.
  if (a.type === 'del' && b.type !== 'del') return a;
  if (b.type === 'del' && a.type !== 'del') return b;
  // Same type on a clock tie → deterministic, unforgeable tiebreak: the higher
  // (lexicographically-greater) sourceLogKeyHex wins, identical on every peer
  // regardless of fold order. Undefined source ⇒ '' so the order is total.
  const sa = a.sourceLogKeyHex ?? '';
  const sb = b.sourceLogKeyHex ?? '';
  if (sa >= sb) return a;
  return b;
}
