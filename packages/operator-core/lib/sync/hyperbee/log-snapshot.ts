/**
 * log-snapshot — design A (snapshot-op-in-log) compaction primitives.
 *
 * Plan: substrate-peer-log-compaction-2026-06-13 P-004/P-005/P-007 (D-005 — owner
 * chose design A). Closes the P-009 gap: the append-only peer-log grows unbounded
 * and a new joiner re-folds full history from index 0.
 *
 * THE SHAPE (D-005). A snapshot is a regular `PeerLogOp` with a RESERVED table tag
 * `__snapshot__` — NOT a new `PeerLogOp.type` (which would ripple through every
 * put/del narrowing in toEnvelope / applyOpVia / read-merge). Its `value` is a
 * `SnapshotPayload` { coversUpTo, rows }: the minimal current-state put-set for
 * this peer's authored keys, plus the own-log length it summarizes. Consequence:
 *   - EXISTING readers treat it as a put to an unregistered table → `applyOpVia`
 *     finds no projection → drops it harmlessly. Producing a snapshot is safe even
 *     with old readers present.
 *   - ONLY the new flag-gated reader path (P-007) recognizes `__snapshot__`,
 *     expands `rows` into the fold, and lets a fresh joiner start its cursor at the
 *     snapshot index (skipping the summarized prefix).
 *
 * This module is PURE (no Corestore, no PG, no I/O): the builder folds an op array;
 * the producer wraps the result into one op. The append + reader integration live
 * in P-005 / P-007.
 */

import type { HeldOwnLogAppender, OwnLog, PeerLogOp } from './peer-log';
// Dependency-free constants module, so this file stays safe to bundle into the fold worker.
import { SELF_REGENERATING_TABLES } from './seed-excluded-tables';
import {
  governorReceiptEnvelopeOpener,
  shouldDropGovernorReceiptSnapshotRow,
  type GovernorReceiptSnapshotFilter,
} from './governor-receipt-snapshot-filter';
import type { OpAAD } from './hive-epoch-crypto';
// Lazy native load only (no keychain), so still safe in the fold worker bundle.
import { loadSodium, openOpCiphertext } from './hive-epoch-aead';

/** Reserved table tag identifying a snapshot op. No projection is registered for
 *  it, so non-snapshot-aware readers drop it (harmless). */
export const SNAPSHOT_TABLE_TAG = '__snapshot__';

/** One row in a snapshot — reconstitutes a single key's current state. Usually a
 *  live `put`; a `deleted: true` row is a TOMBSTONE (EI-1688) reconstituting a key
 *  whose current state is DELETED, carrying the del's ts/hlc. Preserves the winning
 *  op's ORIGINAL ts/hlc so cross-peer LWW at the reader compares by the real write
 *  time, not snapshot-creation time. */
export interface SnapshotRow {
  table: string;
  hbKey: string;
  value: unknown;
  /**
   * WI-808: the hive-rekey epoch the row's encrypted `value` was sealed under,
   * preserved verbatim so a snapshot-seeded joiner can still decrypt it. Without
   * it, an encrypted content op compacted into a snapshot would reconstitute with
   * `epoch == null` → the decrypt-gate treats the ciphertext as plaintext → silent
   * drop (the same class as the live-merge bug). Absent on plaintext rows.
   */
  epoch?: number;
  ts: number;
  schema_version: number;
  /** The winning op's HLC (P-010), preserved verbatim. */
  hlc?: string;
  /**
   * The winning op's ORIGINAL `author_pubkey`, preserved verbatim. This is part of the
   * epoch-decrypt AEAD associated data (`opId = sha256([table, hbKey, author_pubkey])`,
   * hive-epoch-serving.deriveOpId), so it MUST survive compaction for an encrypted row to
   * decrypt after snapshotting. Without it the reader fell back to the SNAPSHOT op's
   * author (its source-log key, NOT the content op's author) → the AAD opId diverged from
   * what sealed the ciphertext → every encrypted row silently decrypt-dropped on a
   * snapshot-seeded read (the seed "β" bug: on the owner's single-writer log content ops
   * carry author='' while the snapshot op carries the core-log key). Absent on legacy
   * pre-fix snapshots (the reader then falls back to the snapshot op's author).
   */
  author_pubkey?: string;
  /**
   * EI-1688 — a TOMBSTONE row: the key's latest op is a `del`, so it reconstitutes
   * as DELETED (the reader's `snapshotRowToEnvelope` emits a `del` env, seeding the
   * merge winner with the del's HLC so a later-arriving stale lower-clock PUT loses
   * the per-op winner-gate and is never re-applied — the put-after-del resurrection
   * fix). `value` is null on a tombstone (an old, pre-fix reader treats it as a
   * put(null) → decodeValue → null → dropped harmlessly; no resurrection-with-garbage).
   */
  deleted?: boolean;
}

/** The `value` of a snapshot op. */
export interface SnapshotPayload {
  /**
   * The own-log length this snapshot summarizes: every op at index `< coversUpTo`
   * is reconstituted by `rows`, so a snapshot-aware reader can fold from
   * `coversUpTo` forward instead of from 0.
   */
  coversUpTo: number;
  /**
   * The minimal current-state put-set (latest live put per key) carried by THIS
   * chunk. For a multi-chunk snapshot (WI-2313) each chunk holds a disjoint subset
   * of the folded rows; the reader must fold ALL chunks of the set to reconstitute
   * the full state.
   */
  rows: SnapshotRow[];
  /**
   * WI-2313 — 0-based index of this chunk within its snapshot SET. Every chunk of
   * one set shares the same `coversUpTo`. ABSENT ⇒ a legacy single-op snapshot,
   * read as chunk 0. The snapshot rows for a large own log (papercup: thousands of
   * keys) serialized to a single op that exceeded hypercore's 15 MiB block ceiling
   * (`Hypercore.MAX_SUGGESTED_BLOCK_SIZE`) → `BAD_ARGUMENT` on append → the snapshot
   * never landed → seeding had nothing to fold from → every sidecar restart replayed
   * admitted member logs from index 0 (the WI-2105 REV-leg restart loop). Splitting
   * the rows across size-bounded chunk ops keeps each block under the ceiling.
   */
  chunkIdx?: number;
  /**
   * WI-2313 — total number of chunks in this snapshot set. ABSENT ⇒ a legacy
   * single-op snapshot (count 1). CRASH-CONSISTENCY (the correctness constraint):
   * the reader may only seed a fresh merge cursor past the summarized prefix once
   * ALL `chunkCount` chunks are durably present + contiguous; a partial/torn set
   * must fall back to a full replay from 0, NEVER a forward seed that would silently
   * skip the ops the missing chunks summarize.
   */
  chunkCount?: number;
  /**
   * Tables this snapshot's own fold DROPPED (`SnapshotRowFolder.excludeTables`),
   * sorted. ABSENT ⇒ either nothing was excluded, or the set predates this field.
   *
   * Recorded because the rows alone cannot express it: an excluded table is simply
   * missing, indistinguishable from a table that never had rows. Without this,
   * anyone seeding a fold FROM this snapshot cannot tell whether it summarizes the
   * prefix completely or only the part some other producer cared about — and there
   * are two producers on the live own log with different sets (`boot.ts` filters
   * `SEED_EXCLUDED_TABLES` on the release-cut head-snapshot route, while routine
   * compaction excludes nothing). `conflictingSnapshotExclusion` is the consumer.
   */
  excludeTables?: string[];
  /**
   * WI-10005425 — `true` ⇒ this set summarizes the prefix `[0, coversUpTo)` of the
   * log that CARRIES it. ABSENT ⇒ unknown (and on a filtered set, assumed not).
   *
   * Stamped by `produceLogSnapshot` (the own-log producer) and only on a FILTERED
   * set, so an unfiltered set stays byte-identical. Needed because `excludeTables`
   * alone cannot say where a set lives: the seed producer
   * (`produceFilteredSnapshotIntoLog`) writes a filtered set summarizing ANOTHER log,
   * while the release cut (`boot.ts`) writes a filtered set summarizing the live own
   * log it is appended to. `author_pubkey` cannot tell them apart either; both stamp
   * the carrier's key. Read-merge's skip eligibility (`isSkipEligibleSnapshot`) is the
   * consumer: without the marker every reader re-applied each release-cut set in full.
   */
  ownPrefix?: true;
}

/**
 * Seed-only transform result that removes the row entirely from the public snapshot.
 *
 * A key cannot be safely redacted in place: it is part of the row's address (and, for
 * encrypted rows, its AAD). Rewriting one can orphan the row or collide with another key.
 * The public seed therefore drops an identity-bearing key and lets normal post-install
 * replication recover the private row from the original author log.
 */
export const DROP_SNAPSHOT_ROW = Symbol('DROP_SNAPSHOT_ROW');

/**
 * Seed-only value projection applied while folding a private log into a public snapshot.
 * Return {@link DROP_SNAPSHOT_ROW} to omit the addressed row without mutating the source.
 */
export type SnapshotValueTransform = (
  value: unknown,
  context: {
    table: string;
    hbKey: string;
    /** Physical source-log index; absent outside a streaming producer fold. */
    sourceIndex?: number;
    /** The row's rekey epoch — with `authorPubkey`, what an envelope's AAD needs (D-024). */
    epoch?: number;
    /** The row's ORIGINAL `author_pubkey`. */
    authorPubkey?: string;
  },
) => unknown;

export interface GovernorReceiptSnapshotFilterStats {
  dropped: number;
  /**
   * D-024 — candidate rows whose `{__rekey}` envelope could not be opened (no key for
   * its epoch, or an auth failure). They are kept; a non-zero count on a run that
   * dropped nothing is the signal that the filter could not see the receipts.
   */
  unopened: number;
}

/**
 * Reconstitute P-530's serializable filter as the existing value-transform seam. `open`
 * is a synchronous AEAD open (`openOpCiphertext` bound to a loaded sodium); without it,
 * or without `filter.envelopeKeys`, encrypted rows are kept.
 */
export function governorReceiptSnapshotValueTransform(
  filter: GovernorReceiptSnapshotFilter,
  opts: { open?: (ciphertext: Uint8Array, key: Uint8Array, ad: OpAAD) => Uint8Array } = {},
): {
  transform: SnapshotValueTransform;
  stats: GovernorReceiptSnapshotFilterStats;
} {
  const stats: GovernorReceiptSnapshotFilterStats = { dropped: 0, unopened: 0 };
  const liveKeys = new Set(filter.liveQualifiedKeys);
  const openEnvelope = governorReceiptEnvelopeOpener(filter.envelopeKeys, opts.open, () => {
    stats.unopened += 1;
  });
  return {
    stats,
    transform: (value, context) => {
      if (shouldDropGovernorReceiptSnapshotRow(value, context, filter, liveKeys, openEnvelope)) {
        stats.dropped += 1;
        return DROP_SNAPSHOT_ROW;
      }
      return value;
    },
  };
}

/** Sentinel so a decoded `null`/`undefined` value is still treated as read-once. */
const NO_DECODED_VALUE = Symbol('no-decoded-value');

/** True iff `op` is a snapshot op (reserved table tag). */
export function isSnapshotOp(op: { table?: string } | null | undefined): boolean {
  return !!op && op.table === SNAPSHOT_TABLE_TAG;
}

/**
 * The leading bytes of a STORED snapshot block. Both builders construct the op as
 * `{ type: 'put', table: SNAPSHOT_TABLE_TAG, ... }` and hypercore's `json` encoding is
 * `JSON.stringify`, so every snapshot block this tree writes starts with exactly this.
 */
const SNAPSHOT_BLOCK_PREFIX = new TextEncoder().encode(`{"type":"put","table":"${SNAPSHOT_TABLE_TAG}"`);

/**
 * WI-10002836 — true when a stored block is a snapshot op, judged from its first bytes
 * WITHOUT decoding it. A chunk is up to `SNAPSHOT_MAX_CHUNK_BYTES` (4 MiB) of JSON, so a
 * 256-block window of them is ~1 GiB to parse; this is what lets a contiguous fold skip
 * them for the cost of a 36-byte compare. A false negative (a legacy block with another
 * key order) is harmless: the caller decodes it and checks `isSnapshotOp`. A false
 * positive is impossible, because a block that starts this way IS a snapshot op.
 */
export function isSnapshotBlock(block: Uint8Array): boolean {
  if (block.byteLength < SNAPSHOT_BLOCK_PREFIX.byteLength) return false;
  for (let i = 0; i < SNAPSHOT_BLOCK_PREFIX.byteLength; i++) {
    if (block[i] !== SNAPSHOT_BLOCK_PREFIX[i]) return false;
  }
  return true;
}

/**
 * EI-1688 — how long a snapshot keeps a TOMBSTONE row for a deleted key. A snapshot
 * must reconstitute a delete (not omit it) so a later-arriving stale lower-clock PUT
 * that federates past the snapshot horizon loses the merge winner-gate instead of
 * resurrecting the key. Past this horizon the tombstone is GC'd (the key reverts to
 * omitted) — a delayed put that old is beyond any realistic partition-heal window, so
 * it is unrecoverable anyway. Conservative default: 14 days. Tunable, not a constant
 * of correctness (any value ≥ the max partition-heal delay is correct; larger only
 * keeps a few more tombstone rows in the snapshot).
 */
export const SNAPSHOT_TOMBSTONE_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * P-004 — the pure builder. Fold a peer's OWN-LOG ops to the minimal current-state
 * set:
 *   - latest op per (table, hbKey) wins — the own log is single-writer, so the
 *     highest-index op for a key IS its current state (no LWW needed within one log);
 *   - a key whose latest op is a `del` is reconstituted as a TOMBSTONE row
 *     (`deleted: true`, value null, the del's ts/hlc) rather than OMITTED — EI-1688:
 *     a snapshot-seeded reader must learn the key was deleted (with the del's HLC) so
 *     a stale lower-clock PUT arriving past the horizon loses the merge winner-gate.
 *     A tombstone older than `opts.tombstoneHorizonMs` (relative to `opts.now`) is
 *     GC'd back to OMITTED (the pre-EI-1688 behavior — acceptable past the horizon);
 *   - a PRIOR snapshot op is EXPANDED (its rows — live AND tombstone — fold in first),
 *     so re-snapshotting a log that already carries a snapshot is correct + idempotent;
 *   - each emitted row preserves its winning op's value/ts/hlc verbatim.
 * Output is sorted (table, then hbKey) for deterministic, testable bytes. Pure.
 */
export function buildSnapshotRows(
  ops: readonly PeerLogOp[],
  opts?: { now?: number; tombstoneHorizonMs?: number },
): SnapshotRow[] {
  const folder = new SnapshotRowFolder();
  folder.addAll(ops);
  return folder.finish(opts);
}

/**
 * P-014 — the INCREMENTAL form of `buildSnapshotRows`. Same fold, same output, but
 * it consumes ops one window at a time so the caller never has to hold the whole
 * history in memory.
 *
 * WHY THIS EXISTS. `produceLogSnapshot` used to materialize every decoded op of the
 * own log into one `ops: PeerLogOp[]` and hand that array to the builder. The fold's
 * OUTPUT is bounded by the LIVE KEY COUNT (latest live op per key), but its INPUT was
 * bounded by the OP COUNT — and on this box's real corpus that is 461,475 ops of
 * accumulated history. Measured 2026-08-09: the holder reached `20.1G memory peak` and
 * died of heap exhaustion (SIGABRT status=134, V8 stack in `String::NewFromOneByte`)
 * ~110s into the read. Folding as each window arrives makes peak retention
 * (live keys + ONE read window) instead of (whole history).
 *
 * ⚠ That memory wall was ALWAYS there — it was MASKED by the serial-read latency bug
 * (see `SNAPSHOT_READ_CONCURRENCY`): the read was so slow the holder got recycled on
 * its ~8.5-min watchdog cadence before the heap could fill. Fixing the latency let
 * execution actually reach the ceiling. Two bugs, one symptom.
 *
 * ORDER IS THE CONTRACT. The own log is single-writer, so the LATEST op per key wins
 * BY POSITION — callers MUST `add` ops in ascending log-index order, exactly as the
 * array form iterates. `buildSnapshotRows` is implemented on top of this class, so
 * the property suite (`log-snapshot.property.test.ts`, PREFIX-REPLACEMENT FAITHFULNESS)
 * exercises this fold rather than a parallel copy of it — the two cannot drift.
 */
export class SnapshotRowFolder {
  /** key → its current-state row (live put OR a `deleted` tombstone). */
  private readonly latest = new Map<string, SnapshotRow>();

  /**
   * Tables to drop entirely from the fold (EI-20108164746219771). Empty by default,
   * so every existing caller is byte-for-byte unchanged.
   *
   * WHY THIS IS A FOLD-TIME FILTER AND NOT A finish() FILTER: it must apply to BOTH
   * branches of `add` — a PRIOR snapshot op expands its rows back in, so filtering
   * only raw put/del ops would silently re-admit an excluded table the moment the
   * source log already contained a snapshot. The shipped seed is exactly that case
   * (measured: its 45 blocks are entirely a snapshot set, rawOps=0), so the
   * expansion branch is the one that actually matters here, not the put/del branch.
   *
   * Dropping at fold time rather than at finish() also means excluded rows are never
   * retained at all, which is the point when the reason for excluding them is that
   * they carry identity.
   */
  private readonly excludeTables: ReadonlySet<string>;
  /** Optional seed-only projection; omitted callers remain byte-for-byte unchanged. */
  private readonly transformValue?: SnapshotValueTransform;

  constructor(opts?: { excludeTables?: Iterable<string>; transformValue?: SnapshotValueTransform }) {
    this.excludeTables = new Set(opts?.excludeTables ?? []);
    this.transformValue = opts?.transformValue;
  }

  /** Number of distinct keys folded so far — the real bound on peak retention. */
  get keyCount(): number {
    return this.latest.size;
  }

  /** Fold ONE op. Must be called in ascending log-index order (see the class note).
   * `decodedValue` is an internal read-once seam used by the producer diagnostics;
   * callers that do not already have the decoded value keep the original behavior. */
  add(op: PeerLogOp, decodedValue: unknown = NO_DECODED_VALUE, sourceIndex?: number): void {
    const decoded = decodedValue === NO_DECODED_VALUE ? op.value : decodedValue;
    if (isSnapshotOp(op)) {
      // A PRIOR snapshot expands: its rows (live AND tombstone) fold in as if they
      // were the ops they summarize, so re-snapshotting is correct + idempotent.
      const payload = decoded as SnapshotPayload | undefined;
      if (payload && Array.isArray(payload.rows)) {
        for (const r of payload.rows) {
          if (this.excludeTables.has(r.table)) continue;
          const key = `${r.table}::${r.hbKey}`;
          const value = this.transformValue
            ? this.transformValue(r.value, {
                table: r.table,
                hbKey: r.hbKey,
                sourceIndex,
                epoch: r.epoch,
                authorPubkey: r.author_pubkey,
              })
            : r.value;
          if (value === DROP_SNAPSHOT_ROW) {
            // A prior raw op for the same key may already be in the fold. The newest
            // snapshot row is authoritative, so a filtered winner must remove it too.
            this.latest.delete(key);
            continue;
          }
          this.latest.set(key, value === r.value ? r : { ...r, value });
        }
      }
      return;
    }
    if (this.excludeTables.has(op.table)) return;
    const key = `${op.table}::${op.hbKey}`;
    if (op.type === 'put') {
      const rowValue = this.transformValue
        ? this.transformValue(decoded, {
            table: op.table,
            hbKey: op.hbKey,
            sourceIndex,
            epoch: op.epoch ?? undefined,
            authorPubkey: op.author_pubkey,
          })
        : decoded;
      if (rowValue === DROP_SNAPSHOT_ROW) {
        // The key may have an earlier accepted winner. Dropping the latest PUT must
        // remove that stale winner rather than silently resurrecting it in the seed.
        this.latest.delete(key);
        return;
      }
      this.latest.set(key, {
        table: op.table,
        hbKey: op.hbKey,
        value: rowValue,
        ts: op.ts,
        schema_version: op.schema_version,
        ...(op.hlc ? { hlc: op.hlc } : {}),
        // WI-808: preserve the rekey epoch so a snapshot-seeded joiner can decrypt
        // an encrypted content row (a `del` tombstone is never encrypted → omitted).
        ...(op.epoch != null ? { epoch: op.epoch } : {}),
        // β (seed 57-drop sibling): preserve the ORIGINAL author_pubkey — it is bound
        // into the epoch-decrypt AAD (opId), so a snapshot-seeded reader must reconstruct
        // it EXACTLY, not substitute the snapshot op's author. Kept even when '' (the
        // owner single-writer log) so the reader distinguishes "author was ''" from a
        // legacy author-less row. Undefined ⇒ omitted (a peer on a pre-author build).
        ...(op.author_pubkey != null ? { author_pubkey: op.author_pubkey } : {}),
      });
    } else if (op.type === 'del') {
      // EI-1688: reconstitute the delete as a tombstone (carry the del's ts/hlc),
      // NOT omitted — so the reader's winner-fold knows the key was deleted.
      this.latest.set(key, {
        table: op.table,
        hbKey: op.hbKey,
        value: null,
        ts: op.ts,
        schema_version: op.schema_version,
        ...(op.hlc ? { hlc: op.hlc } : {}),
        deleted: true,
      });
    }
  }

  /** Fold a batch, in order. */
  addAll(ops: Iterable<PeerLogOp>): void {
    for (const op of ops) this.add(op);
  }

  /**
   * Emit the minimal current-state set: GC tombstones past the horizon, then sort
   * (table, then hbKey) for deterministic, testable bytes. Does not reset the folder.
   */
  finish(opts?: { now?: number; tombstoneHorizonMs?: number }): SnapshotRow[] {
    // GC tombstones older than the horizon (revert them to omitted). `now` undefined
    // ⇒ no GC (carry all tombstones — safe; only a snapshot producer supplies `now`).
    const now = opts?.now;
    const horizon = opts?.tombstoneHorizonMs ?? SNAPSHOT_TOMBSTONE_HORIZON_MS;
    const rows: SnapshotRow[] = [];
    for (const r of this.latest.values()) {
      if (r.deleted && now != null && r.ts < now - horizon) continue; // GC'd tombstone
      rows.push(r);
    }
    rows.sort((a, b) => (a.table === b.table ? cmpStr(a.hbKey, b.hbKey) : cmpStr(a.table, b.table)));
    return rows;
  }
}

export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Wrap a peer's minimal current-state set into ONE snapshot `PeerLogOp` (type
 * 'put', reserved table tag). `coversUpTo` is the own-log length at snapshot time
 * (so the reader knows the index this snapshot summarizes). The op carries no
 * `hlc` of its own — it is a meta op, not a per-key write; its embedded `rows`
 * carry the per-key HLCs that matter for LWW.
 */
export function buildSnapshotOp(opts: {
  ops: readonly PeerLogOp[];
  coversUpTo: number;
  author_pubkey: string;
  ts: number;
  schema_version: number;
}): PeerLogOp {
  // EI-1688: pass `now` (= the snapshot ts) so old tombstones GC out at production.
  const rows = buildSnapshotRows(opts.ops, { now: opts.ts });
  const payload: SnapshotPayload = { coversUpTo: opts.coversUpTo, rows };
  return {
    type: 'put',
    table: SNAPSHOT_TABLE_TAG,
    hbKey: `snapshot/${opts.coversUpTo}`,
    value: payload,
    ts: opts.ts,
    schema_version: opts.schema_version,
    author_pubkey: opts.author_pubkey,
  };
}

/**
 * WI-2313 — max SERIALIZED bytes of the `rows` payload packed into ONE snapshot
 * chunk op. Hypercore rejects an appended block over `MAX_SUGGESTED_BLOCK_SIZE`
 * (15 MiB) with `BAD_ARGUMENT: Appended block exceeds the maximum suggested block
 * size`; the whole-state snapshot for a large own log (papercup: thousands of
 * plan/plan-part/coord keys) exceeded that as a single append, so the snapshot
 * never landed and every sidecar restart replayed admitted member logs from 0
 * (the WI-2105 REV-leg restart loop). We chunk the rows across N ops each under
 * this budget — well below the 15 MiB block ceiling so the JSON envelope + array
 * overhead fit in the headroom. A tunable, not a constant of correctness: any
 * value in (0, ~14 MiB) is correct; smaller ⇒ more, smaller blocks (faster
 * individual WAN fetch, more replication round-trips).
 */
export const SNAPSHOT_MAX_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * WI-2313 — split a snapshot's folded rows into chunks each within `maxBytes` of
 * serialized payload, so no single snapshot op exceeds hypercore's block ceiling.
 * Greedy pack in the builder's deterministic (table, hbKey) order. A single row
 * larger than `maxBytes` gets its OWN chunk (it was individually appendable as a
 * normal op, so it is under the 15 MiB hard ceiling). Empty input ⇒ ONE empty
 * chunk, so a snapshot of an all-deleted log still anchors its `coversUpTo` in the
 * log (the seed can still skip the summarized-and-dead prefix). Pure.
 */
export function chunkSnapshotRows(
  rows: readonly SnapshotRow[],
  maxBytes: number = SNAPSHOT_MAX_CHUNK_BYTES,
): SnapshotRow[][] {
  if (rows.length === 0) return [[]];
  const budget = maxBytes > 0 ? maxBytes : SNAPSHOT_MAX_CHUNK_BYTES;
  const chunks: SnapshotRow[][] = [];
  let cur: SnapshotRow[] = [];
  let curBytes = 0;
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
    // Close the current chunk before adding a row that would overflow the budget —
    // but never emit an EMPTY chunk (a single over-budget row rides alone).
    if (cur.length > 0 && curBytes + rowBytes > budget) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(row);
    curBytes += rowBytes;
  }
  chunks.push(cur);
  return chunks;
}

/** WI-2313 — wrap ONE chunk of a snapshot set into a reserved-tag op. All chunks
 *  of a set share `coversUpTo`; `chunkIdx` / `chunkCount` let the reader recognize
 *  the set and require every chunk before seeding a cursor. The hbKey is unique
 *  per (coversUpTo, chunkIdx). */
export function buildSnapshotChunkOp(opts: {
  rows: SnapshotRow[];
  coversUpTo: number;
  chunkIdx: number;
  chunkCount: number;
  author_pubkey: string;
  ts: number;
  schema_version: number;
  excludeTables?: readonly string[];
  /** The set summarizes the carrying log's own prefix; see `SnapshotPayload.ownPrefix`. */
  ownPrefix?: boolean;
}): PeerLogOp {
  const payload: SnapshotPayload = {
    coversUpTo: opts.coversUpTo,
    rows: opts.rows,
    chunkIdx: opts.chunkIdx,
    chunkCount: opts.chunkCount,
  };
  // Omitted when nothing was excluded, so an unfiltered snapshot stays byte-for-byte
  // what it was before this field existed. Sorted for a stable serialization.
  if (opts.excludeTables && opts.excludeTables.length > 0) {
    payload.excludeTables = [...opts.excludeTables].sort();
    // Only a filtered set needs the marker: an unfiltered one is already skip-eligible,
    // and leaving it unmarked keeps its bytes unchanged.
    if (opts.ownPrefix) payload.ownPrefix = true;
  }
  return {
    type: 'put',
    table: SNAPSHOT_TABLE_TAG,
    hbKey: `snapshot/${opts.coversUpTo}/${opts.chunkIdx}-of-${opts.chunkCount}`,
    value: payload,
    ts: opts.ts,
    schema_version: opts.schema_version,
    author_pubkey: opts.author_pubkey,
  };
}

/**
 * WI-2313 — the CHUNKED producer builder (the fix for the oversized-block bug).
 * Fold `ops` to the minimal current-state set (`buildSnapshotRows`), split it into
 * size-bounded chunks (`chunkSnapshotRows`), and wrap each into a snapshot op. All
 * returned ops share `coversUpTo` and are meant to be appended CONTIGUOUSLY (one
 * `appendBatch`) so the reader recognizes the set as the span
 * `[coversUpTo, coversUpTo + N)`. Always returns ≥1 op. Pure.
 */
export function buildSnapshotOps(opts: {
  ops: readonly PeerLogOp[];
  coversUpTo: number;
  author_pubkey: string;
  ts: number;
  schema_version: number;
  maxChunkBytes?: number;
  /** Recorded on every chunk; see `SnapshotPayload.excludeTables`. */
  excludeTables?: readonly string[];
  /** Recorded on every chunk of a filtered set; see `SnapshotPayload.ownPrefix`. */
  ownPrefix?: boolean;
}): PeerLogOp[] {
  // EI-1688: pass `now` (= the snapshot ts) so old tombstones GC out at production.
  const rows = buildSnapshotRows(opts.ops, { now: opts.ts });
  return buildSnapshotOpsFromRows({ ...opts, rows });
}

/**
 * P-014 — the second half of `buildSnapshotOps`, taking rows that are ALREADY folded.
 * Chunk + wrap only; the tombstone GC has already happened inside the fold, so callers
 * MUST have passed `now` to `SnapshotRowFolder.finish` (as `produceLogSnapshot` does).
 *
 * Exists so the streaming producer can hand over a `SnapshotRowFolder`'s output without
 * round-tripping through an `ops` array it deliberately never built. Pure.
 */
export function buildSnapshotOpsFromRows(opts: {
  rows: readonly SnapshotRow[];
  coversUpTo: number;
  author_pubkey: string;
  ts: number;
  schema_version: number;
  maxChunkBytes?: number;
  /** Recorded on every chunk; see `SnapshotPayload.excludeTables`. */
  excludeTables?: readonly string[];
  /** Recorded on every chunk of a filtered set; see `SnapshotPayload.ownPrefix`. */
  ownPrefix?: boolean;
}): PeerLogOp[] {
  const chunks = chunkSnapshotRows(opts.rows, opts.maxChunkBytes ?? SNAPSHOT_MAX_CHUNK_BYTES);
  const chunkCount = chunks.length;
  return chunks.map((chunkRows, chunkIdx) =>
    buildSnapshotChunkOp({
      rows: chunkRows,
      coversUpTo: opts.coversUpTo,
      chunkIdx,
      chunkCount,
      author_pubkey: opts.author_pubkey,
      ts: opts.ts,
      schema_version: opts.schema_version,
      excludeTables: opts.excludeTables,
      ...(opts.ownPrefix ? { ownPrefix: true } : {}),
    }),
  );
}

/**
 * Default compaction cadence: compact the own log once it has grown this many
 * ops PAST the last snapshot's `coversUpTo`. Compaction reads the whole own log
 * (O(history)) once per fire, so it must be infrequent — this threshold trades a
 * larger replay tail for fewer O(history) writer scans. A tunable, not a constant
 * of correctness (any positive value is correct; this only sets the cadence).
 */
export const SNAPSHOT_COMPACT_EVERY_OPS = 1000;

/**
 * How many own-log blocks `produceLogSnapshot` reads concurrently.
 *
 * A tunable, not a constant of correctness: any positive value produces the SAME
 * `ops` array (see the ordering note at the read site), it only sets how much of the
 * O(history) read is in flight at once. It exists because the serial form made the
 * snapshot uncompletable on a real corpus — 461,475 blocks unfinished after 29 min
 * (P-014, 2026-08-09).
 *
 * Sized to be well clear of latency-bound without holding an unreasonable number of
 * decoded blocks in flight.
 *
 * ⚠ This window IS now a term in peak memory. It was not when this constant landed —
 * the producer accumulated the whole decoded history, which dwarfed any window — but
 * that accumulation is exactly what the incremental fold removed (`SnapshotRowFolder`),
 * so peak retention is now (live keys + ONE window of this many decoded blocks). Raising
 * it trades heap for fewer round-trips; it is still not a constant of correctness.
 */
export const SNAPSHOT_READ_CONCURRENCY = 256;

/**
 * A bounded progress marker for the filtered seed scan. `processed` is the
 * source-log cursor, not a percentage or an estimate: a reader is making real
 * progress only after a whole bounded window has been read and folded.
 */
export interface SnapshotFoldProgress {
  /** Named phase so a future multi-phase seed cut cannot conflate counters. */
  phase: string;
  /** Stable author/core identity when the source exposes one. */
  coreKey?: string;
  /** Absolute source-log span represented by this fold invocation. */
  sourceStart: number;
  sourceEnd: number;
  /** Number of source-log blocks folded so far. Monotonic within one scan. */
  processed: number;
  /** Source-log length captured for this scan. */
  total: number;
  /** Decoded source operations consumed by the folder so far. */
  decodedOps: number;
  /** Approximate UTF-8 bytes represented by those decoded operations. */
  decodedBytes: number;
  /**
   * WI-10002836 — prior snapshot ops passed over WITHOUT decoding because the fold had
   * already folded every op they summarize (`skipSnapshotOps`). Absent on folds that
   * expand every snapshot op.
   */
  skippedSnapshotOps?: number;
  /** WI-10002836 — live keys in the fold after this window (the real retention bound). */
  keyCount?: number;
  /** WI-10002836 — the FOLD's own heap, in MiB, when it runs in a worker thread. */
  workerHeapUsedMb?: number;
}

/** Diagnostic emitted when the source cursor has not advanced for `stallMs`. */
export interface SnapshotFoldStall extends SnapshotFoldProgress {
  /** Wall-clock time for which the cursor remained unchanged. */
  stalledForMs: number;
}

export type SnapshotFoldProgressCallback = (progress: SnapshotFoldProgress) => void;
export type SnapshotFoldStallCallback = (stall: SnapshotFoldStall) => void;

export function formatSnapshotFoldStall(stall: SnapshotFoldStall): string {
  const phase = stall.phase.slice(0, 64).replace(/[^a-zA-Z0-9_.:-]/g, '_');
  const core = stall.coreKey?.slice(0, 64).replace(/[^a-zA-Z0-9_.:-]/g, '_') || 'unknown';
  return (
    `phase=${phase} core=${core} sourceStart=${stall.sourceStart} sourceEnd=${stall.sourceEnd} ` +
    `cursor=${stall.processed}/${stall.total} decodedOps=${stall.decodedOps} ` +
    `decodedBytes=${stall.decodedBytes} stalledForMs=${stall.stalledForMs}`
  );
}

/**
 * WI-10002836 — rate-limit a fold-progress stream to at most one emission per
 * `minIntervalMs`, measured from when the throttle is created.
 *
 * The first own compaction on a pot folds its WHOLE history: 7.76M ops, taking tens
 * of minutes, on the tower's papercusp pot. The stall diagnostic only says the cursor
 * is not stuck, and the outcome row arrives only at the end, so a slow fold and a
 * hung one used to look identical from outside. A fold that finishes inside one
 * interval (every small hive) emits nothing, so this adds no rows where there was
 * nothing to watch. Out-of-order or repeated positions are dropped, which keeps the
 * reported cursor monotonic across the anchor-convergence re-fold.
 */
export function throttleSnapshotFoldProgress(
  emit: SnapshotFoldProgressCallback,
  opts: { minIntervalMs: number; now?: () => number },
): SnapshotFoldProgressCallback {
  const now = opts.now ?? Date.now;
  let lastEmittedAt = now();
  let lastProcessed = -1;
  return (progress) => {
    if (progress.processed <= lastProcessed) return;
    lastProcessed = progress.processed;
    const at = now();
    if (at - lastEmittedAt < opts.minIntervalMs) return;
    lastEmittedAt = at;
    emit(progress);
  };
}

/** One-line, bounded rendering of a fold position (the progress twin of `formatSnapshotFoldStall`). */
export function formatSnapshotFoldProgress(progress: SnapshotFoldProgress): string {
  const pct = progress.total <= 0 ? 100 : Math.min(100, Math.floor((progress.processed / progress.total) * 100));
  return (
    `cursor=${progress.processed}/${progress.total} (${pct}%) sourceStart=${progress.sourceStart} ` +
    `decodedOps=${progress.decodedOps} decodedBytes=${progress.decodedBytes}` +
    (progress.skippedSnapshotOps !== undefined ? ` skippedSnapshotOps=${progress.skippedSnapshotOps}` : '') +
    (progress.keyCount !== undefined ? ` keyCount=${progress.keyCount}` : '') +
    (progress.workerHeapUsedMb !== undefined ? ` workerHeapUsedMb=${progress.workerHeapUsedMb}` : '')
  );
}

/**
 * A single read window may legitimately be slow, so this is only an
 * observability threshold. It is never a total scan timeout and the watchdog
 * never rejects or cancels the underlying read.
 */
export const FILTERED_SNAPSHOT_SCAN_STALL_MS = 30_000;

const FILTERED_SNAPSHOT_SCAN_PHASE = 'filtered-source-scan';

interface FoldLogRangeOptions {
  onSourceBlock?: (index: number, op: PeerLogOp) => void;
  requireComplete?: boolean;
  phase?: string;
  coreKey?: string;
  onProgress?: SnapshotFoldProgressCallback;
  onStall?: SnapshotFoldStallCallback;
  stallMs?: number;
  /**
   * WI-10002836 — pass over prior snapshot ops instead of expanding them. ONLY valid when
   * the folder already holds every op below `from` (a fold from 0, or one seeded from the
   * set that ends at `from`). Then a snapshot at index i summarizes ops below its
   * `coversUpTo`, which is at most i, all of which this fold has already folded, so
   * expanding it re-sets every live key to the row it already has.
   *
   * MEASURED 2026-09-24 on the tower's papercusp pot: that re-expansion was ~120 GB of
   * decoding in the last 3.5% of the log (each prior set ~1.9M rows, ~4 GB), and the
   * 1 GiB windows of 4 MiB chunks drove bg-host to 25 GB and an OOM recycle at 99.5%.
   *
   * A null block is a HOLE: an op this fold did not see. After one, snapshot ops are
   * expanded again, because they re-deliver the rows the hole may have hidden (the
   * producer twin of the reader's P-008 hole rule in read-merge.ts).
   */
  skipSnapshotOps?: boolean;
}

/**
 * The producer-side view of a COMPLETE prior snapshot set. The reader exposes
 * the same seed discovery through `read-merge.ts`, but importing that module
 * here would create a runtime cycle (`read-merge` already imports this module).
 * Keep this small local mirror so the writer can reuse the verified chunk reads
 * when it seeds its folder.
 */
interface ProducerSnapshotSeed {
  coversUpTo: number;
  chunkCount: number;
  chunks: PeerLogOp[];
}

/**
 * Keep the hint-less seed discovery bounded when a log has never been snapshotted.
 * Since P-003 the cadence is proportional to the live row count, so the newest set
 * can sit far outside this window: every producer caller must pass the set it already
 * knows (`priorSnapshotHint` / `hint`, located with the reader's unbounded
 * `findLatestCompleteSnapshot`). This window only catches a set the caller did not
 * know about near the tail; a miss safely falls back to the full fold below.
 */
const PRODUCER_SNAPSHOT_SCAN_LOOKBACK = SNAPSHOT_COMPACT_EVERY_OPS * 4;

/** A seek read exceeded its budget; the seek is abandoned for this invocation. */
const SEEK_ABANDONED = Symbol('producer-snapshot-seek-abandoned');

/**
 * How long ONE seek read may hang before the seek gives up on seeding.
 *
 * Deliberately an order of magnitude above `FILTERED_SNAPSHOT_SCAN_STALL_MS` rather
 * than equal to it. 30s is the threshold at which a read becomes worth REPORTING,
 * and the fold keeps waiting past it precisely because a slow read is usually still
 * a healthy one — a loaded box mid-release-cut produces plenty. Abandoning must
 * clear a far higher bar than reporting, because its fallback is the O(history)
 * fold this seek exists to avoid: giving up on a merely-slow read would trade a
 * hang for a multi-hour scan, which is the same bug wearing a different hat.
 */
const PRODUCER_SNAPSHOT_SEEK_READ_BUDGET_MS = FILTERED_SNAPSHOT_SCAN_STALL_MS * 10;

/**
 * Find and read the newest complete snapshot set near the own-log tail.
 *
 * A complete set is the contiguous span `[coversUpTo, coversUpTo + chunkCount)`
 * whose every block is a snapshot op carrying the same set metadata. A torn or
 * malformed candidate is skipped, and a read failure simply disables seeding
 * for this invocation: folding from zero remains correct and is preferable to
 * guessing that a partial set summarizes history.
 */
/**
 * Decide whether a discovered prior snapshot may SEED a fold that excludes
 * `callerExcluded` — returning the offending table name, or null when safe.
 *
 * Direction is the whole point, and it is asymmetric. A table the snapshot dropped
 * but THIS fold wants to KEEP is unrecoverable from the snapshot's rows, so seeding
 * would silently yield a THINNER result than the full fold it replaces — on the seed
 * path, shipped to a customer as if the source had no such rows. The converse is
 * harmless: a table the snapshot KEPT but this fold drops is filtered again by
 * `SnapshotRowFolder.add`, which applies `excludeTables` to expanded chunk rows too.
 *
 * ⚠ An ABSENT record is deliberately TRUSTED rather than treated as a conflict, and
 * that is a bounded, self-closing exposure rather than an oversight:
 *  - every snapshot already on a live log predates this field, and refusing the seek
 *    for them would force exactly the from-zero fold `produceLogSnapshot` documents
 *    as UNCOMPLETABLE on the live log (five successive release cuts died there), so
 *    fail-closed here would regress a fixed critical bug to guard a narrower one;
 *  - legacy sets age out within one compaction cadence (`SNAPSHOT_COMPACT_EVERY_OPS`),
 *    after which every snapshot on the log carries its own provenance;
 *  - the only table any producer in this tree has ever dropped is `presence`
 *    (`SEED_EXCLUDED_TABLES`), which self-heals within one 30s keep-alive.
 */
function conflictingSnapshotExclusion(seed: ProducerSnapshotSeed, callerExcluded: ReadonlySet<string>): string | null {
  for (const chunk of seed.chunks) {
    const recorded = (chunk.value as SnapshotPayload | undefined)?.excludeTables;
    if (!recorded) continue;
    for (const table of recorded) {
      // WI-10002836: a table whose rows regenerate on their own (`presence`) is not
      // lost by seeding from a set that dropped it; the fold's tail re-supplies it.
      if (!callerExcluded.has(table) && !SELF_REGENERATING_TABLES.has(table)) return table;
    }
  }
  return null;
}

async function findLatestProducerSnapshot(
  log: Pick<OwnLog, 'length' | 'get'>,
  opts: {
    readBudgetMs?: number;
    describe?: string;
    /**
     * A set the caller already knows it wrote (P-003). Verified FIRST at exactly
     * this span; a torn, missing or out-of-range hint falls through to the bounded
     * tail scan. Needed because the proportional cadence (`snapshotCompactThreshold`)
     * puts the previous set far outside `PRODUCER_SNAPSHOT_SCAN_LOOKBACK`.
     */
    hint?: { coversUpTo: number; chunkCount: number };
  } = {},
): Promise<ProducerSnapshotSeed | null> {
  const length = log.length;
  const floor = Math.max(0, length - PRODUCER_SNAPSHOT_SCAN_LOOKBACK);
  const readBudgetMs = opts.readBudgetMs ?? FILTERED_SNAPSHOT_SCAN_STALL_MS;
  const cache = new Map<number, PeerLogOp | null>();
  let abandonedAt: number | null = null;

  const readAt = async (index: number): Promise<PeerLogOp | null> => {
    // Once abandoned, never issue another read: each one would race a FRESH budget,
    // so a log whose reads have stopped settling would otherwise pay the budget again
    // for every remaining block instead of falling back immediately.
    if (abandonedAt !== null) return null;
    const cached = cache.get(index);
    if (cached !== undefined || cache.has(index)) return cached ?? null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const read = Promise.resolve(log.get(index));
      // Losing the race abandons this read without cancelling it, so it must
      // already carry a handler or it surfaces later as an unhandled rejection.
      read.catch(() => {});
      const op =
        readBudgetMs > 0
          ? await Promise.race([
              read,
              new Promise<typeof SEEK_ABANDONED>((resolve) => {
                timer = setTimeout(() => resolve(SEEK_ABANDONED), readBudgetMs);
                timer.unref?.();
              }),
            ])
          : await read;
      if (op === SEEK_ABANDONED) {
        abandonedAt = index;
        return null;
      }
      cache.set(index, op);
      return op;
    } catch {
      // The producer is local, but a transient read failure must not turn a
      // safe full fold into a false forward seed. The fold itself will surface
      // a persistent failure if the block cannot actually be read.
      cache.set(index, null);
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /**
   * Report an abandoned seek and disable seeding for this invocation.
   *
   * ⚠ THE FOLD DELIBERATELY NEVER ABORTS — `FILTERED_SNAPSHOT_SCAN_STALL_MS` is an
   * observability threshold there because the fold has NO safe fallback: it must
   * read every block or the snapshot is wrong. The seek is the exact opposite. It
   * is a pure optimization whose fallback (`foldedUpTo = 0`) is the behavior that
   * shipped before it existed, so a read that never settles must abandon it rather
   * than wedge the caller. `log.get` can HANG rather than reject, and a bare
   * try/catch cannot observe a hang — so without this bound one stuck block near
   * the tail blocks the whole snapshot with no progress line, no stall diagnostic
   * and no timeout, which is strictly worse than the slow fold it replaces.
   *
   * The budget is PER READ, not per seek, on purpose: this window spans up to
   * `PRODUCER_SNAPSHOT_SCAN_LOOKBACK` sequential reads, so a whole-seek deadline
   * would make a merely slow — but perfectly healthy — log fall back to the
   * O(history) fold, reintroducing the cost this seek exists to remove.
   */
  const abandon = (): null => {
    console.error(
      `[snapshot] ${opts.describe ?? 'producer snapshot'}: prior-snapshot seek abandoned — ` +
        `read of block ${abandonedAt} did not settle within ${readBudgetMs}ms; folding from 0 ` +
        `instead of seeding (correct, but O(history); the abandoned read is not cancelled)`,
    );
    return null;
  };

  const validSpan = (coversUpTo: unknown, chunkCount: unknown): coversUpTo is number =>
    typeof coversUpTo === 'number' &&
    Number.isInteger(coversUpTo) &&
    coversUpTo >= 0 &&
    typeof chunkCount === 'number' &&
    Number.isInteger(chunkCount) &&
    chunkCount >= 1 &&
    coversUpTo + chunkCount <= length;

  /** Every chunk of `[coversUpTo, coversUpTo + chunkCount)`, or null when the set is torn. */
  const readCompleteSet = async (coversUpTo: number, chunkCount: number): Promise<PeerLogOp[] | null> => {
    const chunks: PeerLogOp[] = [];
    for (let chunkIdx = 0; chunkIdx < chunkCount; chunkIdx++) {
      const chunk = await readAt(coversUpTo + chunkIdx);
      if (abandonedAt !== null) return null;
      const chunkPayload = chunk?.value as SnapshotPayload | undefined;
      if (
        !chunk ||
        !isSnapshotOp(chunk) ||
        !chunkPayload ||
        chunkPayload.coversUpTo !== coversUpTo ||
        (chunkPayload.chunkCount ?? 1) !== chunkCount ||
        (chunkPayload.chunkIdx ?? 0) !== chunkIdx
      ) {
        return null;
      }
      chunks.push(chunk);
    }
    return chunks;
  };

  const hint = opts.hint;
  if (hint && validSpan(hint.coversUpTo, hint.chunkCount)) {
    const chunks = await readCompleteSet(hint.coversUpTo, hint.chunkCount);
    if (abandonedAt !== null) return abandon();
    if (chunks) return { coversUpTo: hint.coversUpTo, chunkCount: hint.chunkCount, chunks };
  }

  for (let index = length - 1; index >= floor; index--) {
    const candidate = await readAt(index);
    if (abandonedAt !== null) return abandon();
    if (!candidate || !isSnapshotOp(candidate)) continue;

    const payload = candidate.value as SnapshotPayload | undefined;
    const coversUpTo = payload?.coversUpTo;
    const chunkCount = payload?.chunkCount ?? 1;
    if (!validSpan(coversUpTo, chunkCount)) continue;

    const chunks = await readCompleteSet(coversUpTo, chunkCount);
    if (abandonedAt !== null) return abandon();
    if (chunks) return { coversUpTo, chunkCount, chunks };

    // Skip the rest of a known candidate span when it is torn. Keep the loop
    // strictly moving backward even for malformed metadata that points ahead.
    index = Math.min(index - 1, coversUpTo - 1);
  }
  return null;
}

/**
 * Watch one monotonically advancing source cursor. The alarm is edge-triggered
 * for each cursor value: a scan that keeps advancing can run for hours without
 * a wall-clock false positive, while a read that never completes produces one
 * useful diagnostic and does not create a repeating timer storm.
 */
function watchFoldCursor(
  from: number,
  to: number,
  opts: Required<Pick<FoldLogRangeOptions, 'phase' | 'onStall'>> & {
    coreKey?: string;
    stallMs: number;
  },
): {
  advance: (processed: number, decodedOps: number, decodedBytes: number) => void;
  stop: () => void;
} {
  let processed = from;
  let decodedOps = 0;
  let decodedBytes = 0;
  let lastProgressAt = Date.now();
  let alarmedAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (): void => {
    if (timer !== undefined || processed >= to || alarmedAt === processed) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (processed >= to || alarmedAt === processed) return;
      const stalledForMs = Date.now() - lastProgressAt;
      if (stalledForMs < opts.stallMs) {
        arm();
        return;
      }
      alarmedAt = processed;
      opts.onStall({
        phase: opts.phase,
        ...(opts.coreKey ? { coreKey: opts.coreKey } : {}),
        sourceStart: from,
        sourceEnd: to,
        processed,
        total: to,
        decodedOps,
        decodedBytes,
        stalledForMs,
      });
    }, opts.stallMs);
    timer.unref?.();
  };

  arm();
  return {
    advance(next: number, nextDecodedOps: number, nextDecodedBytes: number): void {
      // The fold loop is sequential by construction. Keep the guard defensive
      // so a future caller cannot make an alarm appear to recover backwards.
      if (next < processed) return;
      processed = next;
      decodedOps = nextDecodedOps;
      decodedBytes = nextDecodedBytes;
      lastProgressAt = Date.now();
      alarmedAt = undefined;
      arm();
    },
    stop(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Should the own log be compacted now? True when it has grown at least
 * `threshold` ops since the last snapshot it produced (`lastCoversUpTo`, 0 if it
 * never snapshotted). Pure — the caller supplies the lengths so this is trivially
 * testable and free of clock/IO.
 */
export function shouldCompactOwnLog(
  currentLength: number,
  lastCoversUpTo: number,
  threshold: number = SNAPSHOT_COMPACT_EVERY_OPS,
): boolean {
  if (threshold <= 0) return false;
  return currentLength - lastCoversUpTo >= threshold;
}

/**
 * Ops-per-row ratio of the proportional compaction cadence (p2p-join-catchup-speed
 * P-003, bar R-6). A tunable, not a constant of correctness.
 *
 * Each snapshot re-writes the whole live state (≈ its row count, one row per live
 * key), so spacing snapshots at least `ratio × rowCount` ops apart bounds snapshot
 * volume to `1 / ratio` of the log growth between them, counted in rows vs ops (a
 * snapshot row is one op's payload). At 1 the snapshot stream at most doubles the
 * log's growth, and a joiner seeded from the newest snapshot replays at most about
 * one live-state's worth of tail: its join cost tracks LIVE STATE, not history.
 *
 * Why this replaced the fixed 1,000-op cadence (endgame D-058): the tower's
 * papercusp pot holds 214,821 live work_items, so a fixed cadence would re-write
 * ~234 MB of state every 1,000 ops.
 */
export const SNAPSHOT_COMPACT_ROWS_RATIO = 1;

/**
 * How many ops the own log must grow past its last snapshot before the next one
 * (R-6): `max(SNAPSHOT_COMPACT_EVERY_OPS, ceil(ratio × priorRowCount))`. A missing
 * or unknown prior row count (0, negative, NaN) keeps the historical floor, so a
 * never-snapshotted log still compacts after `SNAPSHOT_COMPACT_EVERY_OPS` ops.
 */
export function snapshotCompactThreshold(
  priorRowCount: number,
  opts: { minOps?: number; ratio?: number } = {},
): number {
  const minOps = opts.minOps ?? SNAPSHOT_COMPACT_EVERY_OPS;
  const ratio = opts.ratio ?? SNAPSHOT_COMPACT_ROWS_RATIO;
  const rows = Number.isFinite(priorRowCount) && priorRowCount > 0 ? priorRowCount : 0;
  const scaled = Number.isFinite(ratio) && ratio > 0 ? Math.ceil(ratio * rows) : 0;
  return Math.max(minOps, scaled);
}

/**
 * Size and provenance of one complete snapshot set, read from its FIRST chunk only.
 *
 * `rowEstimate` is chunk 0's row count × `chunkCount`. Chunks are cut on a byte
 * budget, so every chunk but the last is about the same size and the estimate runs
 * slightly high. It only feeds the cadence (`snapshotCompactThreshold`), where an
 * overestimate just spaces snapshots a little wider. `excludesTables` is true when
 * the set was produced with an exclusion list (the release-cut head snapshot), which
 * the unfiltered own compaction must not seed from (`conflictingSnapshotExclusion`).
 *
 * Returns null when chunk 0 is unreadable within `readBudgetMs` or is not chunk 0 of
 * that set. Never throws.
 */
export async function describeSnapshotSet(
  log: Pick<OwnLog, 'get'>,
  set: { coversUpTo: number; chunkCount: number },
  readBudgetMs: number = FILTERED_SNAPSHOT_SCAN_STALL_MS,
): Promise<{ rowEstimate: number; excludesTables: boolean; excludeTables: string[] } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = Promise.resolve(log.get(set.coversUpTo));
    read.catch(() => {});
    const first = await Promise.race([
      read,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, readBudgetMs));
        timer.unref?.();
      }),
    ]);
    if (!first || !isSnapshotOp(first)) return null;
    const payload = first.value as SnapshotPayload | undefined;
    if (!payload || payload.coversUpTo !== set.coversUpTo || (payload.chunkIdx ?? 0) !== 0) return null;
    if (!Array.isArray(payload.rows)) return null;
    const excludeTables = Array.isArray(payload.excludeTables) ? payload.excludeTables.map(String) : [];
    return {
      rowEstimate: payload.rows.length * Math.max(1, set.chunkCount),
      excludesTables: excludeTables.length > 0,
      excludeTables,
    };
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Thrown by `produceLogSnapshot` when `shouldAbort()` reports true just before the
 * append: the fold is discarded and nothing is written to the log.
 */
/** WI-10002836 — first retry delay for a cadence-anchor discovery that came back `unreadable`. */
export const OWN_COMPACTION_ANCHOR_RETRY_BASE_MS = 60_000;
/** WI-10002836 — first retry delay after a FAILED own compaction (a full fold is costly). */
export const OWN_COMPACTION_FAILURE_BACKOFF_BASE_MS = 15 * 60_000;
/** WI-10002836 — ceiling for both backoffs. */
export const OWN_COMPACTION_BACKOFF_MAX_MS = 6 * 60 * 60_000;

/** Exponential backoff: `baseMs` after the 1st failure, doubling, capped at `maxMs`. */
export function ownCompactionBackoffMs(
  failures: number,
  baseMs: number,
  maxMs: number = OWN_COMPACTION_BACKOFF_MAX_MS,
): number {
  if (failures <= 0) return 0;
  return Math.min(maxMs, baseMs * 2 ** Math.min(failures - 1, 30));
}

/**
 * WI-10002836 — true when a set that left out `excludeTables` is a complete seed for an
 * UNFILTERED fold: every table it dropped regenerates on its own (`SELF_REGENERATING_TABLES`).
 * The same rule `conflictingSnapshotExclusion` applies inside the producer, so a caller
 * choosing a `priorSnapshotHint` and the producer checking it can never disagree.
 */
export function isSeedableForUnfilteredFold(excludeTables: readonly string[]): boolean {
  return excludeTables.every((t) => SELF_REGENERATING_TABLES.has(t));
}

export class SnapshotAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotAbortedError';
  }
}

export interface ProduceSnapshotResult {
  /** False when there was nothing to snapshot (empty log) — no op appended. */
  appended: boolean;
  /** Own-log length the appended snapshot summarizes (its `coversUpTo`). */
  coversUpTo: number;
  /** Number of live keys in the snapshot (summed across all chunks). */
  rowCount: number;
  /** WI-2313 — number of chunk ops appended for this snapshot (≥1 when appended,
   *  0 when nothing was appended). The set occupies `[coversUpTo, coversUpTo + N)`. */
  chunkCount: number;
  /** P-530 — absent-from-PG legacy governor receipt rows omitted from this set. */
  droppedGovernorReceipts?: number;
  /** D-024 — candidate `{__rekey}` rows the filter could not open (kept). */
  unopenedGovernorEnvelopes?: number;
  /**
   * D-025 — how long every other append on the own log waited for this set (the final
   * re-anchor, the build and the append). Absent when the log has no append hold.
   */
  appendsHeldMs?: number;
}

/**
 * D-025 — run the producer's final re-anchor, build and append under the own log's
 * append hold, so no live op can land between the anchor and the set (WI-37526). The
 * convergence passes before it keep the delta folded under the hold small. A log with
 * no hold (test fakes) runs `fn` directly with the old, racy window.
 */
async function withOwnLogAppendsHeld<T extends ProduceSnapshotResult>(
  ownLog: OwnLog,
  fn: (log: HeldOwnLogAppender) => Promise<T>,
): Promise<T> {
  if (!ownLog.withAppendsHeld) return fn(ownLog);
  return ownLog.withAppendsHeld(async (held) => {
    const heldAt = Date.now();
    const result = await fn(held);
    return { ...result, appendsHeldMs: Date.now() - heldAt };
  });
}

/**
 * P-005 — the producer. Read the peer's OWN log, fold it to the minimal
 * current-state set, and APPEND the snapshot (design A — additive; the prior ops
 * are NOT removed, so there is no Hypercore fork). A snapshot-aware reader (P-007)
 * can then fold from the snapshot's index forward instead of from 0.
 *
 * WI-2313 — the snapshot is CHUNKED: the folded rows are split across N ops each
 * under `SNAPSHOT_MAX_CHUNK_BYTES` (well below hypercore's 15 MiB block ceiling)
 * and appended in ONE `appendBatch` so the chunks land CONTIGUOUSLY at
 * `[coversUpTo, coversUpTo + N)`. Before this, the whole state went in a SINGLE
 * append that, for a large own log, blew the block ceiling (`BAD_ARGUMENT`) → the
 * snapshot never landed → the cursor never seeded → every restart replayed from 0.
 *
 * Seeds from the newest complete prior snapshot when one is available, then
 * reads only the post-snapshot tail. On the first compaction (or when no recent
 * complete set can be verified) it safely falls back to `[0, length)`. Chunk 0
 * lands at index `length` and every chunk carries `coversUpTo = length`.
 *
 * GATED: callers MUST flag-gate this (`papercusp-substrate-log-snapshot`) until
 * the P-008 cross-machine sparse-fetch proof passes. This function itself does not
 * read the flag — it is the pure mechanism; the gate lives at the call site so the
 * producer stays unit-testable.
 */
/**
 * Fold `log[from, to)` into `folder`, with the two properties P-014 paid for.
 *
 * Extracted so the SEED path (`produceFilteredSnapshotIntoLog`) reuses this exact
 * discipline instead of growing a second, subtly-different read loop — the read is
 * the dangerous part, not the fold.
 *
 * 1. BOUNDED PIPELINE, NOT SERIAL AWAITS. The serial form pays a full async
 *    round-trip per block, so it runs at ~1/latency ops/sec regardless of store
 *    speed. Measured 2026-08-09: 461,475 blocks had not finished after 29 MINUTES,
 *    and since the producer restarts from index 0 every time, that is not a slow
 *    operation but an UNCOMPLETABLE one.
 * 2. FOLD THEN DROP, AND YIELD TO THE MACROTASK QUEUE. Each window is folded and
 *    released (peak retention = live keys + one window, not the whole op count —
 *    materializing all decoded ops is what produced a `20.1G memory peak` and a
 *    SIGABRT). And `await` alone yields only to the MICROTASK queue: a warm local
 *    log resolves in-tick, so a loop of awaits starves every `setInterval` in the
 *    process. Measured: a head snapshot ran 455s with ZERO `harness_shared.routines`
 *    fires for the whole window — a 9-minute hole — and `bghost-watchdog` correctly
 *    read the frozen ticker and restarted the unit, killing the snapshot. The
 *    operation was killing its own host, which no timeout budget can fix.
 *    `setImmediate` runs in the check phase, reached only after timers get their
 *    turn, so one per window keeps the ticker alive and changes neither what is
 *    folded nor in what order.
 */
async function foldLogRangeInto(
  log: Pick<OwnLog, 'get'>,
  folder: SnapshotRowFolder,
  from: number,
  to: number,
  opts: FoldLogRangeOptions = {},
): Promise<void> {
  const watchdog =
    opts.onStall && opts.stallMs !== undefined && opts.stallMs > 0
      ? watchFoldCursor(from, to, {
          phase: opts.phase ?? 'source-scan',
          ...(opts.coreKey ? { coreKey: opts.coreKey } : {}),
          onStall: opts.onStall,
          stallMs: opts.stallMs,
        })
      : undefined;
  let decodedOps = 0;
  let decodedBytes = 0;
  let skippedSnapshotOps = 0;
  let sawHole = false;
  try {
    for (let start = from; start < to; start += SNAPSHOT_READ_CONCURRENCY) {
      const end = Math.min(start + SNAPSHOT_READ_CONCURRENCY, to);
      const window = await Promise.all(Array.from({ length: end - start }, (_, k) => log.get(start + k)));
      for (let offset = 0; offset < window.length; offset++) {
        const op = window[offset];
        if (!op) {
          if (opts.requireComplete) throw new Error('[snapshot] bound source span has a missing block');
          sawHole = true;
          continue;
        }
        opts.onSourceBlock?.(start + offset, op);
        if (opts.skipSnapshotOps && !sawHole && isSnapshotOp(op)) {
          skippedSnapshotOps += 1;
          continue;
        }
        // Read the decoded value once, both to fold it and to measure the bounded
        // source volume. This avoids a second getter read on instrumented logs.
        const decodedValue = op.value;
        decodedOps += 1;
        const encoded = JSON.stringify({
          type: op.type,
          table: op.table,
          hbKey: op.hbKey,
          value: decodedValue,
          ts: op.ts,
          schema_version: op.schema_version,
          ...(op.author_pubkey != null ? { author_pubkey: op.author_pubkey } : {}),
          ...(op.hlc ? { hlc: op.hlc } : {}),
          ...(op.epoch != null ? { epoch: op.epoch } : {}),
        });
        decodedBytes += encoded === undefined ? 0 : Buffer.byteLength(encoded, 'utf8');
        folder.add(op, decodedValue, start + offset);
      }
      watchdog?.advance(end, decodedOps, decodedBytes);
      opts.onProgress?.({
        phase: opts.phase ?? 'source-scan',
        ...(opts.coreKey ? { coreKey: opts.coreKey } : {}),
        sourceStart: from,
        sourceEnd: to,
        processed: end,
        total: to,
        decodedOps,
        decodedBytes,
        ...(opts.skipSnapshotOps ? { skippedSnapshotOps } : {}),
        keyCount: folder.keyCount,
      });
      // `window` falls out of scope here — the decoded blocks it held are collectable.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    watchdog?.stop();
  }
}

export async function produceLogSnapshot(
  ownLog: OwnLog,
  opts: {
    now: number;
    schemaVersion: number;
    maxChunkBytes?: number;
    /** Optional bounded progress sink for the own-compaction fold. */
    onProgress?: SnapshotFoldProgressCallback;
    /** Optional cursor-stall diagnostic for the own-compaction fold. */
    onStall?: SnapshotFoldStallCallback;
    /** Override the own-compaction cursor-stall threshold. */
    stallMs?: number;
    /** Override how long one prior-snapshot seek read may hang before it is abandoned. */
    seekReadBudgetMs?: number;
    /**
     * Tables dropped from the fold (EI-20108164746219771). Omitted by every live
     * caller, so the behavior of the running system is unchanged; supplied only by
     * the seed cut, which must not ship runtime/identity-bearing rows.
     */
    excludeTables?: Iterable<string>;
    /**
     * The set this caller last appended (P-003). The seek verifies it first, so a
     * proportional-cadence gap wider than the tail-scan window still seeds instead
     * of folding the whole history. Correctness does not depend on it: seeding from
     * ANY complete set and folding forward yields the same rows.
     */
    priorSnapshotHint?: { coversUpTo: number; chunkCount: number };
    /**
     * Checked once, after the fold and immediately before the append. True ⇒ throw
     * `SnapshotAbortedError` and append nothing. The off-gate own compaction passes
     * `() => stopped` so a closing engine never appends into a store it is tearing down.
     */
    shouldAbort?: () => boolean;
    /**
     * WI-10002855 — run the decode + fold in a worker thread instead of on the caller's
     * event loop (see `produceLogSnapshotOffloaded`). The own compaction passes the real
     * worker; every other caller omits it and keeps the inline fold, unchanged.
     */
    foldWorker?: SnapshotFoldWorkerFactory;
    /** P-530 — current PG receipt census + the pre-census own-log boundary. */
    governorReceiptFilter?: GovernorReceiptSnapshotFilter;
    /**
     * P-006 — where the offloaded fold persists its mid-scan state, so a fold interrupted by
     * a restart or an abort resumes from its cursor instead of index 0. Worker path only.
     */
    foldCheckpoint?: SnapshotFoldCheckpointStore;
    /** P-006 — minimum spacing between checkpoint saves. Default `SNAPSHOT_FOLD_CHECKPOINT_INTERVAL_MS`. */
    checkpointIntervalMs?: number;
  },
): Promise<ProduceSnapshotResult> {
  if (opts.foldWorker) return produceLogSnapshotOffloaded(ownLog, opts, opts.foldWorker);
  // Re-anchored after the read by the ANCHOR CONVERGENCE below (WI-37526), so `let`.
  let coversUpTo = ownLog.length;
  if (coversUpTo === 0) return { appended: false, coversUpTo: 0, rowCount: 0, chunkCount: 0 };

  // Read the history with a bounded PIPELINE, not one awaited `get` at a time.
  //
  // The serial form (`for i… await ownLog.get(i)`) pays a full async round-trip per
  // block, so it runs at ~1/latency ops/sec no matter how cheap the store is. Measured
  // on this box 2026-08-09 (P-014): 461,475 blocks had not finished after 29 MINUTES of
  // one saturated core — and the holder is recycled on a ~8.5-min watchdog cadence, so
  // the snapshot could never finish before its own process was restarted. Because
  // `produceLogSnapshot` restarts from index 0 every time, that is not a slow operation
  // but an UNCOMPLETABLE one: five successive release cuts failed here, and no retry
  // budget can fix a non-resumable job that outlives its host.
  //
  // This is the same defect `RemoteLog.prefetch` already exists to solve on the replica
  // path ("without it, WAN merge ingest is RTT-bound at ~1/RTT ops/sec per log" — EI-92);
  // the own-log read never got the equivalent treatment.
  //
  // Order is preserved: `Promise.all` resolves positionally and the windows advance
  // sequentially, so ops are folded in exactly the index order the serial loop produced —
  // which the fold depends on (last-writer-wins per key).
  //
  // And each window is FOLDED THEN DROPPED rather than accumulated (P-014, half 2). The
  // fold's output is bounded by the LIVE KEY COUNT; only its input was ever bounded by the
  // OP COUNT, and materializing all 461,475 decoded ops first is what put the holder at a
  // `20.1G memory peak` and killed it with SIGABRT ~110s in. Peak retention is now
  // (live keys + one window of SNAPSHOT_READ_CONCURRENCY blocks). See `SnapshotRowFolder`.
  // Materialized BEFORE the folder consumes it — see the same note in
  // `produceFilteredSnapshotIntoLog`; `excludeTables` is an `Iterable` and there are now
  // three consumers here too.
  const ownExcluded = new Set(opts.excludeTables ?? []);
  // D-024: with envelope keys, the filter opens `{__rekey}` rows; a sodium load failure
  // leaves it keyless, which keeps every encrypted row and counts it as unopened.
  const envelopeSodium = opts.governorReceiptFilter?.envelopeKeys ? await loadSodium().catch(() => null) : null;
  const governorProjection = opts.governorReceiptFilter
    ? governorReceiptSnapshotValueTransform(
        opts.governorReceiptFilter,
        envelopeSodium ? { open: (ct, key, ad) => openOpCiphertext(envelopeSodium, ct, key, ad) } : {},
      )
    : null;
  const folder = new SnapshotRowFolder({
    excludeTables: ownExcluded,
    ...(governorProjection ? { transformValue: governorProjection.transform } : {}),
  });

  // A prior complete snapshot already represents every op before its anchor.
  // Seed those rows directly and start the streaming fold after the entire
  // chunk span, so the producer's second invocation is O(new tail), not
  // O(history). If no complete set is discoverable in the bounded scan window,
  // foldedUpTo remains zero and the existing full-fold behavior is preserved.
  const priorSnapshot = await findLatestProducerSnapshot(ownLog, {
    readBudgetMs: opts.seekReadBudgetMs ?? PRODUCER_SNAPSHOT_SEEK_READ_BUDGET_MS,
    describe: 'own compaction',
    ...(opts.priorSnapshotHint ? { hint: opts.priorSnapshotHint } : {}),
  });
  let foldedUpTo = 0;
  if (priorSnapshot) {
    // TWO PRODUCERS SHARE THIS LOG WITH DIFFERENT SETS (boot.ts): the release-cut
    // head-snapshot route filters `SEED_EXCLUDED_TABLES`, routine compaction excludes
    // nothing. `findLatestProducerSnapshot` returns whichever is NEWEST, so without
    // this check an unfiltered compaction could seed from the filtered set and then
    // republish it as if nothing had been excluded — dropping those rows from the
    // log's snapshot lineage permanently.
    const conflict = conflictingSnapshotExclusion(priorSnapshot, ownExcluded);
    if (conflict) {
      console.error(
        `[snapshot] own compaction: prior snapshot at ${priorSnapshot.coversUpTo} excluded ` +
          `table '${conflict}' which this fold keeps; folding from 0 instead of seeding ` +
          `(correct, but O(history) — see conflictingSnapshotExclusion)`,
      );
    } else {
      for (let i = 0; i < priorSnapshot.chunks.length; i++) {
        const chunk = priorSnapshot.chunks[i]!;
        folder.add(chunk, chunk.value, priorSnapshot.coversUpTo + i);
      }
      foldedUpTo = priorSnapshot.coversUpTo + priorSnapshot.chunkCount;
    }
  }

  /**
   * Fold `[from, to)` into the folder. Factored out of the main loop so the ANCHOR
   * CONVERGENCE below can reuse it for the (tiny) delta that arrives mid-read.
   */
  const foldRange = (from: number, to: number): Promise<void> =>
    foldLogRangeInto(ownLog, folder, from, to, {
      phase: 'own-compaction',
      coreKey: ownLog.keyHex,
      onProgress: opts.onProgress,
      onStall:
        opts.onStall ??
        ((stall) => {
          console.error(
            `[snapshot] own compaction stalled in ${formatSnapshotFoldStall(stall)}; ` +
              `the scan remains live and will not be aborted by this diagnostic`,
          );
        }),
      stallMs: opts.stallMs ?? FILTERED_SNAPSHOT_SCAN_STALL_MS,
      // Every range folded here is contiguous with what the folder holds: from 0, or
      // from the end of the seed set already added above. See `skipSnapshotOps`.
      skipSnapshotOps: true,
    });

  await foldRange(foldedUpTo, coversUpTo);
  // The initial target was captured before seed discovery. A concurrent append
  // can therefore make the verified seed span newer than that target; never
  // move the cursor backward in that case.
  foldedUpTo = Math.max(foldedUpTo, coversUpTo);

  // ── ANCHOR CONVERGENCE (WI-37526) ────────────────────────────────────────────
  //
  // The set's anchor MUST equal the index the chunks actually land at, because the
  // reader locates a set STRICTLY by span: `verifySnapshotSet` reads chunk j at
  // `coversUpTo + j` (read-merge.ts:437) and, on a miss, seeks BACKWARD past
  // `coversUpTo` (read-merge.ts:558) — so a set that lands even ONE block late is
  // not merely hard to find, it is unfindable forever.
  //
  // Capturing `coversUpTo = ownLog.length` before an O(history) read and appending
  // after it breaks that invariant whenever ANY op is appended meanwhile. MEASURED
  // 2026-08-10 on the live 1.23M-block log: the read took 43.7s, 55 ops arrived in
  // that window, and all 45 chunks landed at [1232912, 1232957) while carrying
  // `coversUpTo=1232857`. Every chunk was present, readable and correctly tagged —
  // and `findLatestCompleteSnapshot` still reported `none-in-window`, so
  // `computeSparseFrom` returned 0 and the seed guard refused a full-history seed.
  // That is the whole of P-014's "sparse cut degrades to full history", and it is
  // why the failure looked intermittent: a FAST snapshot (28s, run h) races fewer
  // appends and sometimes lands at offset 0 by luck, which reads as success.
  //
  // So: fold the delta that arrived during the read and re-anchor to the new tail.
  // Cost is the delta, not the history (55 ops against 1.23M). Folding a prior
  // snapshot op is explicitly idempotent (`SnapshotRowFolder.add`), so re-folding a
  // previous attempt's orphaned chunks is safe.
  const MAX_CONVERGE_PASSES = 8;
  for (let pass = 0; pass < MAX_CONVERGE_PASSES && ownLog.length > foldedUpTo; pass++) {
    const target = ownLog.length;
    await foldRange(foldedUpTo, target);
    foldedUpTo = target;
  }

  // D-025 — convergence alone shrinks the race window to the gap between the last
  // length read and the append, and the build sits in that gap: on the tower's own log
  // (~0.8 ops/s) a 478-chunk set lost the race at 03:41Z. Under the hold the length
  // cannot move, so the last delta folded here makes the anchor exact.
  return withOwnLogAppendsHeld(ownLog, async (held) => {
    if (ownLog.length > foldedUpTo) {
      const target = ownLog.length;
      await foldRange(foldedUpTo, target);
      foldedUpTo = target;
    }
    coversUpTo = foldedUpTo;

    // EI-1688: `now` (= the snapshot ts) GCs tombstones past the horizon at production —
    // the same argument `buildSnapshotOps` passes for the non-streaming path.
    const rows = folder.finish({ now: opts.now });
    const snapshotOps = buildSnapshotOpsFromRows({
      rows,
      coversUpTo,
      author_pubkey: ownLog.keyHex,
      ts: opts.now,
      schema_version: opts.schemaVersion,
      maxChunkBytes: opts.maxChunkBytes,
      excludeTables: [...ownExcluded],
      // WI-10005425: this set is appended to `ownLog` and summarizes its prefix.
      ownPrefix: true,
    });
    if (opts.shouldAbort?.()) {
      throw new SnapshotAbortedError(
        `[snapshot] own compaction aborted before append (coversUpTo=${coversUpTo}, ` +
          `${snapshotOps.length} chunk(s) discarded): the caller is stopping`,
      );
    }
    // Append the whole set in ONE batch so the chunks land CONTIGUOUSLY at
    // [coversUpTo, coversUpTo + N) — the reader recognizes the set by that span and
    // only seeds a cursor once every chunk is present (crash-consistency guard).
    await held.appendBatch(snapshotOps);

    // ── VERIFY THE ANCHOR HELD ─────────────────────────────────────────────────
    //
    // A log with no append hold still has the gap between the last length read and
    // the append, where a writer can interleave. Reporting `appended: true` for a set
    // the reader can never find is the failure mode that cost ~6 cut attempts across
    // several sessions — the producer claimed success and the consequence surfaced
    // 40+ minutes later as a misleading "no complete snapshot within the reader scan
    // window". A snapshot that cannot be located is not a snapshot, so this FAILS
    // LOUDLY instead.
    assertSnapshotAnchorHeld(await ownLog.get(coversUpTo), coversUpTo, snapshotOps.length);

    const rowCount = snapshotOps.reduce((sum, op) => sum + (op.value as SnapshotPayload).rows.length, 0);
    return {
      appended: true,
      coversUpTo,
      rowCount,
      chunkCount: snapshotOps.length,
      ...(governorProjection
        ? {
            droppedGovernorReceipts: governorProjection.stats.dropped,
            unopenedGovernorEnvelopes: governorProjection.stats.unopened,
          }
        : {}),
    };
  });
}

/** Throw unless `anchorOp` (read back at `coversUpTo`) is chunk 0 of the set just appended. */
function assertSnapshotAnchorHeld(anchorOp: PeerLogOp | null, coversUpTo: number, chunkCount: number): void {
  const anchorIsSnapshot = anchorOp != null && isSnapshotOp(anchorOp);
  const anchorCovers = anchorIsSnapshot ? (anchorOp.value as SnapshotPayload | undefined)?.coversUpTo : undefined;
  if (anchorCovers !== coversUpTo) {
    throw new Error(
      `[snapshot] anchor race: appended a ${chunkCount}-chunk set for coversUpTo=${coversUpTo}, ` +
        `but index ${coversUpTo} does not hold chunk 0 of that set (found ` +
        `${anchorIsSnapshot ? `a snapshot for coversUpTo=${String(anchorCovers)}` : anchorOp == null ? `no readable op` : `a non-snapshot op`}). ` +
        `A concurrent append displaced the set, and the reader locates a set only at ` +
        `[coversUpTo, coversUpTo+chunkCount) — so it would be unfindable. Refusing to report ` +
        `success; retry the snapshot when the own log is quieter (WI-37526).`,
    );
  }
}

/**
 * P-006 — durable storage for one own-log fold's resume checkpoint (the bytes are opaque to
 * the producer; `SnapshotIndexFolder` validates them). `fileSnapshotFoldCheckpointStore`
 * (snapshot-fold-offload.ts) is the production implementation.
 */
export interface SnapshotFoldCheckpointStore {
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

/**
 * P-006 — how often the offloaded fold persists its resume checkpoint. A save serializes the
 * whole scan state (keys + positions, never values), so it is paced rather than per window;
 * the worst case lost to a crash is this much fold time. An abort saves immediately.
 */
export const SNAPSHOT_FOLD_CHECKPOINT_INTERVAL_MS = 2 * 60 * 1000;

/**
 * P-006 — target bytes per materialize batch. Winner blocks include prior-snapshot chunks of
 * up to `SNAPSHOT_MAX_CHUNK_BYTES` each, so a fixed 256-block window could pull ~1 GiB onto
 * the main thread at once (the WI-10002836 failure shape). The batch size adapts to this.
 */
const SNAPSHOT_MATERIALIZE_BATCH_BYTES = 64 * 1024 * 1024;

/**
 * WI-10002855 — the fold, run somewhere other than the caller's event loop. Implemented
 * by `SnapshotFoldWorker` (snapshot-fold-offload.ts, a worker thread). Declared here, not
 * imported, so this module stays pure: the worker bundle imports THIS file.
 */
export interface SnapshotFoldWorkerLike {
  /**
   * Decode + fold stored blocks, in ascending log order. Counts are for THIS call.
   * `skipSnapshotOps` (WI-10002836) passes over snapshot ops instead of expanding them;
   * see `FoldLogRangeOptions.skipSnapshotOps` for when that is valid.
   */
  fold(
    blocks: ReadonlyArray<Uint8Array | null>,
    opts?: { skipSnapshotOps?: boolean; sourceStart?: number },
  ): Promise<SnapshotFoldWindowResult>;
  /** Decode stored blocks WITHOUT their bulk (a snapshot op keeps its metadata, not its rows). */
  inspect(blocks: ReadonlyArray<Uint8Array | null>): Promise<Array<PeerLogOp | null>>;
  /**
   * P-006 — the fold is INDEX-ONLY (snapshot-index-fold.ts): during the scan it keeps each
   * key's winning position, never its value. Before `finish`, every winner's block is read
   * back once: `pendingIndexes` names them, `materialize` turns them into row JSON.
   */
  pendingIndexes(): Promise<number[]>;
  materialize(blocks: ReadonlyArray<Uint8Array | null>, indexes: readonly number[], now: number): Promise<void>;
  /** P-006 — the scan state covering every op below `cursor`, for a later `restore`. */
  checkpoint(args: { logKey: string; cursor: number }): Promise<Uint8Array>;
  /** P-006 — load a checkpoint into the fresh fold; `cursor: null` (with a reason) when it does not fit. */
  restore(
    bytes: Uint8Array,
    args: { logKey: string; minCursor?: number; maxCursor: number },
  ): Promise<{ cursor: number | null; reason?: string }>;
  /** Emit the set as stored blocks, byte-identical to what `appendBatch(buildSnapshotOpsFromRows(...))` writes. */
  finish(args: {
    now: number;
    coversUpTo: number;
    author_pubkey: string;
    ts: number;
    schema_version: number;
    maxChunkBytes?: number;
    excludeTables: readonly string[];
    /** See `SnapshotPayload.ownPrefix`. */
    ownPrefix?: boolean;
  }): Promise<{
    blocks: Uint8Array[];
    rowCount: number;
    droppedGovernorReceipts?: number;
    unopenedGovernorEnvelopes?: number;
  }>;
  close(): Promise<void>;
}

/** What one worker `fold` call reports. The optional fields are observability only. */
export interface SnapshotFoldWindowResult {
  decodedOps: number;
  decodedBytes: number;
  /** Snapshot ops the worker decoded and then passed over (legacy key order; see `isSnapshotBlock`). */
  skippedSnapshotOps?: number;
  /** Live keys in the fold after this call. */
  keyCount?: number;
  /** The worker isolate's used heap after this call, in bytes (WI-10002836). */
  heapUsedBytes?: number;
}

export type SnapshotFoldWorkerFactory = (init: {
  excludeTables: readonly string[];
  governorReceiptFilter?: GovernorReceiptSnapshotFilter;
}) => Promise<SnapshotFoldWorkerLike>;

type ProduceLogSnapshotOptions = Parameters<typeof produceLogSnapshot>[1];

/**
 * WI-10002855 — `produceLogSnapshot` with the fold OFF the event loop.
 *
 * MEASURED 2026-09-24 on the tower: the inline fold of the papercusp pot's first
 * compaction (7.76M ops from index 0) held bg-host's main thread for 30+ minutes —
 * event-loop lag p50 2.8s, every PG connect timed out, DBOS queues stalled, git-sync and
 * the green-checkpoint fire stalled. Here the main thread does only I/O: raw block reads
 * (no JSON.parse), a buffer copy, and one raw batch append. Decode, fold, chunking and
 * encoding happen in the worker, so the live-key Map is on the WORKER's heap.
 *
 * Same contract as the inline path, step for step — seek, seed, fold, anchor
 * convergence, abort check, contiguous append, anchor verification — and the appended
 * bytes are identical (pinned by snapshot-fold-offload.test.ts). Two deliberate
 * differences, both about not touching bulk data on the main thread:
 *  - the seek and the anchor check read SUMMARIES (`inspect`): snapshot metadata
 *    without rows. The seed is then folded from the prior set's own chunk range inside
 *    the worker, which expands exactly the rows the inline path adds from the decoded
 *    chunks it holds;
 *  - `shouldAbort` is also honored between windows, so a closing engine stops a long
 *    fold promptly instead of reading on to the end.
 */
async function produceLogSnapshotOffloaded(
  ownLog: OwnLog,
  opts: ProduceLogSnapshotOptions,
  openWorker: SnapshotFoldWorkerFactory,
): Promise<ProduceSnapshotResult> {
  const getRaw = ownLog.getRaw?.bind(ownLog);
  const appendRawBatch = ownLog.appendRawBatch?.bind(ownLog);
  if (!getRaw || !appendRawBatch) {
    throw new Error('[snapshot] offloaded own compaction needs OwnLog.getRaw and appendRawBatch (WI-10002855)');
  }
  let coversUpTo = ownLog.length;
  if (coversUpTo === 0) return { appended: false, coversUpTo: 0, rowCount: 0, chunkCount: 0 };

  const excludeTables = [...new Set(opts.excludeTables ?? [])];
  const worker = await openWorker({
    excludeTables,
    ...(opts.governorReceiptFilter ? { governorReceiptFilter: opts.governorReceiptFilter } : {}),
  });
  try {
    const inspectAt = async (index: number): Promise<PeerLogOp | null> => {
      const raw = await getRaw(index);
      if (!raw) return null;
      const [op] = await worker.inspect([raw]);
      return op ?? null;
    };
    const summaries = {
      get length(): number {
        return ownLog.length;
      },
      get: inspectAt,
    };

    // P-006 — the resume checkpoint. Saved only from contiguous ranges (skipSnapshotOps),
    // never mid-seed: a cursor inside the seed set would make a resumed fold SKIP the
    // chunks it had not yet expanded. A hole disables saving too (the hole rule needs the
    // skip state to restart at the hole, which a cursor alone cannot carry).
    const store = opts.foldCheckpoint;
    const checkpointIntervalMs = opts.checkpointIntervalMs ?? SNAPSHOT_FOLD_CHECKPOINT_INTERVAL_MS;
    let lastCheckpointAt = Date.now();
    let materializing = false;
    const saveCheckpoint = async (cursor: number, force: boolean): Promise<void> => {
      if (!store || materializing) return;
      if (!force && Date.now() - lastCheckpointAt < checkpointIntervalMs) return;
      lastCheckpointAt = Date.now();
      try {
        await store.save(await worker.checkpoint({ logKey: ownLog.keyHex, cursor }));
      } catch (e) {
        // Resume is an optimization; a failed save must never fail the compaction.
        console.error(
          `[snapshot] own compaction: checkpoint save at ${cursor} failed (the fold continues; ` +
            `a restart would resume from the previous checkpoint): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    };

    // `skipSnapshotOps` is false ONLY for the seed range: that range IS the prior set,
    // whose rows are the whole point. Every other range continues contiguously from
    // what the worker already holds (see `FoldLogRangeOptions.skipSnapshotOps`).
    const foldRange = (from: number, to: number, skipSnapshotOps = true): Promise<void> =>
      foldLogRangeViaWorker(getRaw, worker, from, to, {
        ...(skipSnapshotOps ? { checkpoint: saveCheckpoint } : {}),
        phase: 'own-compaction',
        coreKey: ownLog.keyHex,
        onProgress: opts.onProgress,
        onStall:
          opts.onStall ??
          ((stall) => {
            console.error(
              `[snapshot] own compaction stalled in ${formatSnapshotFoldStall(stall)}; ` +
                `the scan remains live and will not be aborted by this diagnostic`,
            );
          }),
        stallMs: opts.stallMs ?? FILTERED_SNAPSHOT_SCAN_STALL_MS,
        shouldAbort: opts.shouldAbort,
        skipSnapshotOps,
      });

    const priorSnapshot = await findLatestProducerSnapshot(summaries, {
      readBudgetMs: opts.seekReadBudgetMs ?? PRODUCER_SNAPSHOT_SEEK_READ_BUDGET_MS,
      describe: 'own compaction',
      ...(opts.priorSnapshotHint ? { hint: opts.priorSnapshotHint } : {}),
    });
    let foldedUpTo = 0;
    let seed: ProducerSnapshotSeed | null = null;
    if (priorSnapshot) {
      const conflict = conflictingSnapshotExclusion(priorSnapshot, new Set(excludeTables));
      if (conflict) {
        console.error(
          `[snapshot] own compaction: prior snapshot at ${priorSnapshot.coversUpTo} excluded ` +
            `table '${conflict}' which this fold keeps; folding from 0 instead of seeding ` +
            `(correct, but O(history) — see conflictingSnapshotExclusion)`,
        );
      } else {
        seed = priorSnapshot;
      }
    }
    const seedEnd = seed ? seed.coversUpTo + seed.chunkCount : 0;

    // P-006 — resume an interrupted fold when its checkpoint gets further than the seed.
    // The log is append-only, so a state that folded every op below `cursor` is still
    // exactly that state; the restore refuses anything for another log, other exclusions,
    // a cursor past the end, or one behind the seed (then seeding is less work).
    let resumedFrom: number | null = null;
    if (store) {
      const bytes = await store.load().catch((e: unknown) => {
        console.error(
          `[snapshot] own compaction: checkpoint unreadable, not resuming: ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      });
      if (bytes) {
        const restored = await worker.restore(bytes, {
          logKey: ownLog.keyHex,
          minCursor: seedEnd,
          maxCursor: ownLog.length,
        });
        if (restored.cursor !== null) {
          resumedFrom = restored.cursor;
          console.error(
            `[snapshot] own compaction: resuming the fold from checkpoint cursor ${restored.cursor} ` +
              `(log length ${ownLog.length}) instead of ${seed ? `seed end ${seedEnd}` : 'index 0'}`,
          );
        } else {
          console.error(`[snapshot] own compaction: checkpoint not used: ${restored.reason ?? 'unknown'}`);
        }
      }
    }
    if (resumedFrom !== null) {
      foldedUpTo = resumedFrom;
    } else if (seed) {
      await foldRange(seed.coversUpTo, seedEnd, false);
      foldedUpTo = seedEnd;
    }

    await foldRange(foldedUpTo, coversUpTo);
    foldedUpTo = Math.max(foldedUpTo, coversUpTo);
    // ANCHOR CONVERGENCE (WI-37526) — see produceLogSnapshot.
    const MAX_CONVERGE_PASSES = 8;
    for (let pass = 0; pass < MAX_CONVERGE_PASSES && ownLog.length > foldedUpTo; pass++) {
      const target = ownLog.length;
      await foldRange(foldedUpTo, target);
      foldedUpTo = target;
    }
    // A last save at the end of the scan: a restart during materialization resumes here.
    await saveCheckpoint(foldedUpTo, true);

    // P-006 — read each winner's block back once and turn it into row JSON, OUTSIDE the
    // append hold (it is O(live keys) of I/O). Only the delta folded under the hold needs
    // materializing again below.
    const materializePending = async (): Promise<void> => {
      materializing = true;
      await materializeWinnersViaWorker(getRaw, worker, opts.now, opts.shouldAbort);
    };
    await materializePending();

    // D-025 — the final re-anchor, the worker's build and the append run under the
    // own log's append hold; see produceLogSnapshot.
    const result = await withOwnLogAppendsHeld(ownLog, async (held) => {
      if (ownLog.length > foldedUpTo) {
        const target = ownLog.length;
        await foldRange(foldedUpTo, target);
        foldedUpTo = target;
      }
      await materializePending();
      coversUpTo = foldedUpTo;

      const { blocks, rowCount, droppedGovernorReceipts, unopenedGovernorEnvelopes } = await worker.finish({
        now: opts.now,
        coversUpTo,
        author_pubkey: ownLog.keyHex,
        ts: opts.now,
        schema_version: opts.schemaVersion,
        maxChunkBytes: opts.maxChunkBytes,
        excludeTables,
        // WI-10005425: byte-identical to the inline path, which marks its own-log set too.
        ownPrefix: true,
      });
      if (opts.shouldAbort?.()) {
        throw new SnapshotAbortedError(
          `[snapshot] own compaction aborted before append (coversUpTo=${coversUpTo}, ` +
            `${blocks.length} chunk(s) discarded): the caller is stopping`,
        );
      }
      // The held appender, never the log's own appendRawBatch: that one waits on the hold.
      await (held.appendRawBatch?.bind(held) ?? appendRawBatch)(blocks);
      assertSnapshotAnchorHeld(await inspectAt(coversUpTo), coversUpTo, blocks.length);
      return {
        appended: true,
        coversUpTo,
        rowCount,
        chunkCount: blocks.length,
        ...(droppedGovernorReceipts !== undefined ? { droppedGovernorReceipts } : {}),
        ...(unopenedGovernorEnvelopes !== undefined ? { unopenedGovernorEnvelopes } : {}),
      };
    });
    // The set just appended now seeds the next fold, so the checkpoint is superseded. Only
    // after the anchor verified: a failed append must keep the resume point.
    await store?.clear().catch(() => {});
    return result;
  } finally {
    await worker.close().catch(() => {});
  }
}

/**
 * P-006 — read every unmaterialized winner's block and hand it to the worker, in ascending
 * index order and in byte-bounded batches (`SNAPSHOT_MATERIALIZE_BATCH_BYTES`): a batch of
 * prior-snapshot chunks is ~4 MiB per block, so the count adapts to what the last batch
 * actually weighed.
 */
async function materializeWinnersViaWorker(
  getRaw: (index: number) => Promise<Uint8Array | null>,
  worker: SnapshotFoldWorkerLike,
  now: number,
  shouldAbort?: () => boolean,
): Promise<void> {
  const indexes = await worker.pendingIndexes();
  let batch = SNAPSHOT_READ_CONCURRENCY;
  for (let at = 0; at < indexes.length; ) {
    if (shouldAbort?.()) {
      throw new SnapshotAbortedError(
        `[snapshot] own compaction aborted while materializing (${at}/${indexes.length} winner blocks): the caller is stopping`,
      );
    }
    const slice = indexes.slice(at, at + batch);
    const blocks = await Promise.all(slice.map((i) => getRaw(i)));
    let bytes = 0;
    for (const b of blocks) if (b) bytes += b.byteLength;
    await worker.materialize(blocks, slice, now);
    at += slice.length;
    batch = Math.max(
      1,
      Math.min(SNAPSHOT_READ_CONCURRENCY, Math.floor((slice.length * SNAPSHOT_MATERIALIZE_BATCH_BYTES) / Math.max(1, bytes))),
    );
    // Same macrotask yield as the scan: keep the host's timers alive (see foldLogRangeInto).
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * `foldLogRangeInto` with the decode + fold in the worker. The next window's reads are
 * issued before the current window's fold is awaited, so I/O and folding overlap.
 */
async function foldLogRangeViaWorker(
  getRaw: (index: number) => Promise<Uint8Array | null>,
  worker: SnapshotFoldWorkerLike,
  from: number,
  to: number,
  opts: FoldLogRangeOptions & {
    shouldAbort?: () => boolean;
    /**
     * P-006 — offered the cursor after every folded window (`force: false`, the callee paces
     * itself) and at an abort (`force: true`). Never called once a hole has been seen.
     */
    checkpoint?: (cursor: number, force: boolean) => Promise<void>;
  },
): Promise<void> {
  const watchdog =
    opts.onStall && opts.stallMs !== undefined && opts.stallMs > 0
      ? watchFoldCursor(from, to, {
          phase: opts.phase ?? 'source-scan',
          ...(opts.coreKey ? { coreKey: opts.coreKey } : {}),
          onStall: opts.onStall,
          stallMs: opts.stallMs,
        })
      : undefined;
  const readWindow = (start: number): Promise<Array<Uint8Array | null>> => {
    const end = Math.min(start + SNAPSHOT_READ_CONCURRENCY, to);
    const read = Promise.all(Array.from({ length: end - start }, (_, k) => getRaw(start + k)));
    read.catch(() => {}); // awaited below; never an unhandled rejection if we throw first
    return read;
  };
  let decodedOps = 0;
  let decodedBytes = 0;
  let skippedSnapshotOps = 0;
  let sawHole = false;
  try {
    let next: Promise<Array<Uint8Array | null>> | null = from < to ? readWindow(from) : null;
    for (let start = from; start < to; start += SNAPSHOT_READ_CONCURRENCY) {
      const end = Math.min(start + SNAPSHOT_READ_CONCURRENCY, to);
      const raw = await next!;
      next = end < to ? readWindow(end) : null;
      if (opts.shouldAbort?.()) {
        // Everything below `start` is folded: persist it so the next run resumes here.
        if (!sawHole) await opts.checkpoint?.(start, true);
        throw new SnapshotAbortedError(
          `[snapshot] own compaction aborted mid-fold at ${start}/${to}: the caller is stopping`,
        );
      }
      // WI-10002836: drop redundant snapshot chunks HERE, by prefix, so they are never
      // copied into the transfer buffer nor parsed. In index order, so a hole earlier
      // in the window turns the skip off for every later block.
      let blocks: Array<Uint8Array | null> = raw;
      if (opts.skipSnapshotOps) {
        blocks = raw.map((b) => {
          if (!b) {
            sawHole = true;
            return null;
          }
          if (!sawHole && isSnapshotBlock(b)) {
            skippedSnapshotOps += 1;
            return null;
          }
          return b;
        });
      }
      const counts = await worker.fold(blocks, {
        skipSnapshotOps: opts.skipSnapshotOps === true && !sawHole,
        sourceStart: start,
      });
      decodedOps += counts.decodedOps;
      decodedBytes += counts.decodedBytes;
      skippedSnapshotOps += counts.skippedSnapshotOps ?? 0;
      watchdog?.advance(end, decodedOps, decodedBytes);
      opts.onProgress?.({
        phase: opts.phase ?? 'source-scan',
        ...(opts.coreKey ? { coreKey: opts.coreKey } : {}),
        sourceStart: from,
        sourceEnd: to,
        processed: end,
        total: to,
        decodedOps,
        decodedBytes,
        ...(opts.skipSnapshotOps ? { skippedSnapshotOps } : {}),
        ...(counts.keyCount !== undefined ? { keyCount: counts.keyCount } : {}),
        ...(counts.heapUsedBytes !== undefined
          ? { workerHeapUsedMb: Math.round(counts.heapUsedBytes / 1_048_576) }
          : {}),
      });
      if (!sawHole) await opts.checkpoint?.(end, false);
    }
  } finally {
    watchdog?.stop();
  }
}

/**
 * Fold `sourceLog` and write the resulting snapshot set into a DIFFERENT log
 * (EI-20108164746219771 — the seed must not ship the owner's identity).
 *
 * ── WHY THIS EXISTS INSTEAD OF `produceLogSnapshot(ownLog, { excludeTables })` ──
 * The seed cut cannot filter in place. `cut-seed-cli` appends its head snapshot to
 * the LIVE own log (P-004 requires it inside the reader's tail-scan window), and
 * readers fold FORWARD from the newest complete snapshot, skipping everything below
 * its `coversUpTo`. So a table-incomplete snapshot in the live log does not merely
 * omit rows from the seed — it makes those rows UNREACHABLE for every live reader
 * that seeds from it. Trading a live read-model regression for a privacy fix is not
 * a fix. (Stripping rows from already-written blocks is not available either: blocks
 * are Merkle-signed and append-only.)
 *
 * So the seed becomes a PRODUCT rather than a slice of the owner's private log: mint
 * a separate core, put exactly one filtered snapshot set in it, ship that. The live
 * log is never written.
 *
 * ── THE PART THAT IS EASY TO GET WRONG: `coversUpTo` IS DUAL-PURPOSE ──
 * It means both "this set summarizes source ops below N" AND "this set physically
 * begins at index N". `produceLogSnapshot` can conflate them safely because source
 * and target are the same log. HERE THEY DIVERGE: the reader uses it purely as a
 * LOCATION (`verifySnapshotSet` reads chunk j at `coversUpTo + j`, read-merge.ts:437,
 * and on a miss seeks BACKWARD past it, :558), so it MUST be the TARGET's append
 * position — not the source's length. Anchoring to the source length would place a
 * perfectly valid, fully readable set at coordinates nothing ever looks at, which is
 * precisely the unfindable-set failure WI-37526 cost ~6 release cuts to diagnose.
 *
 * The target is expected to be fresh (length 0), but the target's own length is used
 * rather than a hardcoded 0 so appending to a non-empty synthetic core stays correct.
 */
export interface FilteredSnapshotFoldOptions {
  now?: number;
  excludeTables?: Iterable<string>;
  transformValue?: SnapshotValueTransform;
  onProgress?: SnapshotFoldProgressCallback;
  onStall?: SnapshotFoldStallCallback;
  stallMs?: number;
  seekReadBudgetMs?: number;
  /** null explicitly binds a from-zero fold; omission retains ordinary discovery. */
  priorSnapshotHint?: { coversUpTo: number; chunkCount: number } | null;
  onSourceBlock?: (index: number, op: PeerLogOp) => void;
  requireComplete?: boolean;
}

/** D-174: census and seed production share selection validation and this exact fold.
 * The caller locates the original set with findLatestCompleteSnapshotDetailed.
 * A conflicting exclusion still binds a from-zero fold, never a thinner seed. */
export async function foldFilteredSnapshotRows(
  sourceLog: Pick<OwnLog, 'get' | 'length'>,
  opts: FilteredSnapshotFoldOptions,
): Promise<{ rows: SnapshotRow[]; excluded: Set<string>; seedIndex: number; coversUpTo: number; chunkCount: number }> {
  const excluded = new Set(opts.excludeTables ?? []);
  const folder = new SnapshotRowFolder({ excludeTables: excluded, transformValue: opts.transformValue });
  const prior = opts.priorSnapshotHint === null ? null : await findLatestProducerSnapshot(sourceLog, {
    readBudgetMs: opts.seekReadBudgetMs ?? PRODUCER_SNAPSHOT_SEEK_READ_BUDGET_MS,
    describe: 'filtered source scan',
    ...(opts.priorSnapshotHint ? { hint: opts.priorSnapshotHint } : {}),
  });
  let seedIndex = 0;
  let chunkCount = 0;
  let from = 0;
  if (prior && !conflictingSnapshotExclusion(prior, excluded)) {
    seedIndex = prior.coversUpTo;
    chunkCount = prior.chunkCount;
    for (const [offset, chunk] of prior.chunks.entries()) {
      opts.onSourceBlock?.(seedIndex + offset, chunk);
      folder.add(chunk, chunk.value, seedIndex + offset);
    }
    from = seedIndex + chunkCount;
  }
  await foldLogRangeInto(sourceLog, folder, from, sourceLog.length, {
    phase: FILTERED_SNAPSHOT_SCAN_PHASE,
    coreKey: (sourceLog as Partial<Pick<OwnLog, 'keyHex'>>).keyHex,
    onProgress: opts.onProgress,
    onStall: opts.onStall ?? (stall => console.error(`[snapshot] ${formatSnapshotFoldStall(stall)}`)),
    stallMs: opts.stallMs ?? FILTERED_SNAPSHOT_SCAN_STALL_MS,
    onSourceBlock: opts.onSourceBlock,
    requireComplete: opts.requireComplete,
  });
  return { rows: folder.finish({ now: opts.now }), excluded, seedIndex, coversUpTo: seedIndex, chunkCount };
}

export async function produceFilteredSnapshotIntoLog(
  sourceLog: Pick<OwnLog, 'get' | 'length'>,
  targetLog: OwnLog,
  opts: {
    now: number;
    schemaVersion: number;
    excludeTables?: Iterable<string>;
    /** Optional seed-only value projection; never used by the live-log producer. */
    transformValue?: SnapshotValueTransform;
    maxChunkBytes?: number;
    /** Bounded progress after each source-log read/fold window. */
    onProgress?: SnapshotFoldProgressCallback;
    /** Cursor-stall diagnostic; the scan itself is never timed out. */
    onStall?: SnapshotFoldStallCallback;
    /** Override the diagnostic threshold in tests or a release runner. */
    stallMs?: number;
    /** Override how long one prior-snapshot seek read may hang before it is abandoned. */
    seekReadBudgetMs?: number;
    /**
     * A complete set the caller already located in `sourceLog` (P-003), e.g. with the
     * reader's unbounded `findLatestCompleteSnapshot`. Verified first, then checked by
     * `conflictingSnapshotExclusion` like any discovered set. Without it the seek only
     * scans `PRODUCER_SNAPSHOT_SCAN_LOOKBACK` blocks of the tail, and the proportional
     * cadence leaves the last set far outside that window, so the cut would fold from 0.
     */
    priorSnapshotHint?: { coversUpTo: number; chunkCount: number } | null;
    onSourceBlock?: FilteredSnapshotFoldOptions['onSourceBlock'];
    requireComplete?: boolean;
    onFoldedRows?: (fold: Awaited<ReturnType<typeof foldFilteredSnapshotRows>>) => void;
  },
): Promise<ProduceSnapshotResult> {
  // An EMPTY SOURCE means there is nothing to seed — mirror `produceLogSnapshot`'s
  // `coversUpTo === 0` early return rather than minting a core whose only content is
  // a vacuous snapshot. (`chunkSnapshotRows([])` yields ONE empty chunk, not zero, so
  // without this the function would report `appended: true` for a set summarizing
  // nothing.)
  //
  // Deliberately NOT the same as "folded to zero rows": a NON-empty source whose rows
  // are all excluded or all tombstoned still gets a real, empty snapshot, because
  // "this hive has no shippable content" is a meaningful statement to seed with,
  // whereas "there was no source" is not.
  if (sourceLog.length === 0) {
    return { appended: false, coversUpTo: targetLog.length, rowCount: 0, chunkCount: 0 };
  }

  // MATERIALIZED ONCE, and that matters: `excludeTables` is an `Iterable`, and this
  // function now has three consumers (the folder, the seek guard, the recorded
  // provenance). A one-shot iterator would be drained by the first, leaving the other
  // two silently empty — a seek that looks safe and a snapshot that under-reports what
  // it dropped, while the folder itself filtered correctly.
  // ── SEED FROM THE PRIOR SNAPSHOT, LIKE `produceLogSnapshot` ALREADY DOES ─────────
  //
  // This fold used to start at a HARDCODED 0 while its sibling (:940) sought the latest
  // producer snapshot and folded only the new tail, documented "O(new tail), not
  // O(history)". The seed path never got that treatment, and the cost is not a constant
  // factor — it is re-expanding every SUPERSEDED snapshot generation still sitting in the
  // log's tail. A snapshot chunk block carries ~1,356 rows where a raw put carries ~1, so
  // a tiny minority of blocks dominates the scan.
  //
  // MEASURED on the failed 0.0.21 cut (2026-09-18, /tmp/papercup-release-cut.log, 199
  // time-throttled progress lines at CUT_SEED_FILTERED_PROGRESS_INTERVAL_MS=60_000, so
  // each delta IS a blocks-per-minute rate): deciles 0-8 are FLAT at 44k-91k blocks/min,
  // then the tail collapses to exactly 256 (= SNAPSHOT_READ_CONCURRENCY, one read window
  // per >=60s). 96 of 198 intervals — about half the ~7h wall clock — advanced 1.1% of the
  // blocks. 39,340,332 row-projections to yield 1,415,542 rows: 27.7x redundant.
  //
  // The same-run control is what sizes this, rather than an estimate: that cut also built
  // a COMPLETE head snapshot over the same data via the seeking path in 435,920ms (7.3
  // min, 1045 chunks, 1,416,626 rows) — and then folded from 0 anyway, ignoring it. Same
  // box, same data, same fold primitive: 7.3 minutes with the seek, ~7 hours without.
  const fold = await foldFilteredSnapshotRows(sourceLog, opts);
  opts.onFoldedRows?.(fold);
  const { rows, excluded } = fold;
  // The TARGET's append position — see the dual-purpose note above.
  const coversUpTo = targetLog.length;
  const snapshotOps = buildSnapshotOpsFromRows({
    rows,
    coversUpTo,
    // The set is authored by the core that CARRIES it. Individual rows keep their
    // original `author_pubkey` (SnapshotRowFolder preserves it, because it is bound
    // into the epoch-decrypt AAD), so provenance of the CONTENT is unchanged — only
    // the envelope is re-authored.
    author_pubkey: targetLog.keyHex,
    ts: opts.now,
    schema_version: opts.schemaVersion,
    maxChunkBytes: opts.maxChunkBytes,
    // What THIS fold dropped, so anyone folding the shipped seed forward inherits the
    // same protection rather than having to know the cutter's policy.
    excludeTables: [...excluded],
  });

  if (snapshotOps.length === 0) {
    return { appended: false, coversUpTo, rowCount: 0, chunkCount: 0 };
  }

  await targetLog.appendBatch(snapshotOps);

  // Same anchor verification produceLogSnapshot performs. A fresh single-writer core
  // has no concurrent appender, so this should be unreachable — which is exactly why
  // it is worth asserting: if it ever fires, the target was not the private core this
  // function assumes, and shipping an unfindable seed would otherwise look like success.
  const anchorOp = await targetLog.get(coversUpTo);
  const anchorIsSnapshot = anchorOp != null && isSnapshotOp(anchorOp);
  const anchorCovers = anchorIsSnapshot ? (anchorOp.value as SnapshotPayload | undefined)?.coversUpTo : undefined;
  if (anchorCovers !== coversUpTo) {
    throw new Error(
      `[snapshot] synthetic-core anchor race: appended a ${snapshotOps.length}-chunk set for ` +
        `coversUpTo=${coversUpTo}, but that index does not hold chunk 0 of it. The target log ` +
        `is not exclusively held by this cut, so the set would be unfindable (WI-37526).`,
    );
  }

  const rowCount = snapshotOps.reduce((sum, op) => sum + (op.value as SnapshotPayload).rows.length, 0);
  return { appended: true, coversUpTo, rowCount, chunkCount: snapshotOps.length };
}
