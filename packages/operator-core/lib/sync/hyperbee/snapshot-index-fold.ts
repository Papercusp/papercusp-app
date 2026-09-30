/**
 * WI-10003473 / memory-reduction-2026-09-24 P-006 — the INDEX-ONLY snapshot fold.
 *
 * WHY. `SnapshotRowFolder` keeps `Map<key, SnapshotRow>` with every winning DECODED value
 * for the whole scan. On the tower's papercusp pot that is ~1.9M rows and ~4.3 GB of
 * decoded object graph held for tens of minutes (WI-10002850), and it grows with value
 * size, not only with key count. And the fold's only resume point was the last COMPLETE
 * snapshot, so a bg-host restart mid-fold threw the whole scan away.
 *
 * THE DESIGN, in two passes:
 *  1. SCAN — `add()` records only WHERE each key's winning op lives: a raw op's log index,
 *     or a prior snapshot's (chunk index, row position). No value is retained, so memory
 *     during the scan is (live keys × a key string + one number), independent of value size.
 *  2. MATERIALIZE — the caller reads just the winning blocks (`pendingBlockIndexes`) and
 *     hands them to `materialize`, which turns each winner into its serialized row JSON and
 *     drops the decoded block. `finishBlocks` then chunks those strings into snapshot blocks
 *     byte-identical to `buildSnapshotOpsFromRows(SnapshotRowFolder.finish())`.
 *
 * WHY THE VALUE TRANSFORM CAN WAIT FOR THE WINNER. `SnapshotRowFolder` applies
 * `transformValue` to every op as it is folded, and a `DROP_SNAPSHOT_ROW` result removes the
 * key. That drop depends only on the op being folded, and a later op for the same key always
 * replaces whatever an earlier one left (a row, or an absence). So the key's final state is
 * decided by its LAST op alone: evaluating the transform on the winner at materialize time
 * yields the same rows. Two consequences, both deliberate:
 *  - the scan state is filter-independent, so a checkpoint survives a new governor census;
 *  - the governor filter's `dropped` / `unopened` counters now count WINNERS judged, not every
 *    superseded op the old fold also judged. They are observability, never part of the set.
 *
 * RESUME. `exportCheckpoint` serializes the scan state and the cursor it covers; a later
 * fold that `restoreCheckpoint`s it continues from that cursor instead of index 0. Only scan
 * state is checkpointable — once materialization starts the winners hold row JSON instead of
 * positions, and a checkpoint is refused.
 *
 * Pure (no I/O), so it runs unchanged inline, in the fold worker, and in unit tests.
 */
import {
  buildSnapshotChunkOp,
  cmpStr,
  DROP_SNAPSHOT_ROW,
  isSnapshotOp,
  SNAPSHOT_MAX_CHUNK_BYTES,
  SNAPSHOT_TOMBSTONE_HORIZON_MS,
  type SnapshotPayload,
  type SnapshotRow,
  type SnapshotValueTransform,
} from './log-snapshot';
import type { PeerLogOp } from './peer-log';

/** Bump when the checkpoint encoding changes; an older checkpoint is then ignored, never misread. */
export const SNAPSHOT_FOLD_CHECKPOINT_VERSION = 1;

/**
 * A winner position is packed into one double: `blockIndex * ROW_SLOTS + (rowPos + 1)`, where
 * `rowPos` is -1 for a raw op. 2^22 row slots is far above the rows one snapshot chunk can
 * carry (a block is capped at 15 MiB and a row is at least ~40 bytes, so < 400k rows), and
 * block indexes up to 2^31 keep the product below 2^53, where doubles are exact.
 */
const ROW_SLOTS = 2 ** 22;
const MAX_BLOCK_INDEX = 2 ** 31;

/** A winner: a packed position (number) during the scan, or its row JSON once materialized ('' = omitted). */
type Winner = number | string;

function pack(blockIndex: number, rowPos: number): number {
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= MAX_BLOCK_INDEX) {
    throw new Error(`snapshot index fold: block index ${blockIndex} out of range`);
  }
  if (rowPos + 1 >= ROW_SLOTS) throw new Error(`snapshot index fold: row position ${rowPos} out of range`);
  return blockIndex * ROW_SLOTS + (rowPos + 1);
}

function unpack(ref: number): { blockIndex: number; rowPos: number } {
  return { blockIndex: Math.floor(ref / ROW_SLOTS), rowPos: (ref % ROW_SLOTS) - 1 };
}

/** Placeholder spliced out of a chunk op's JSON; no real field can contain it. */
const ROWS_SENTINEL = '\u0000papercusp-snapshot-rows\u0000';
const ROWS_SENTINEL_JSON = JSON.stringify([ROWS_SENTINEL]);
const utf8 = new TextEncoder();

export interface SnapshotFoldCheckpointMeta {
  /** The own log's hypercore key; a checkpoint for another log is never restored. */
  logKey: string;
  /** Every op below this index is folded into the checkpointed state. */
  cursor: number;
}

export type RestoreCheckpointResult =
  | { ok: true; cursor: number }
  | { ok: false; reason: string };

export class SnapshotIndexFolder {
  /** table → hbKey → winner. Nested (not `${table}::${hbKey}`) so the final sort is exact. */
  private readonly tables = new Map<string, Map<string, Winner>>();
  private entries = 0;
  /** Winners still holding a position (not yet materialized). */
  private pending = 0;
  /** Built by `pendingBlockIndexes`, consumed by `materialize`; any `add` invalidates it. */
  private pendingByBlock: Map<number, Array<{ table: string; hbKey: string; rowPos: number }>> | null = null;
  private readonly excludeTables: ReadonlySet<string>;
  private readonly transformValue?: SnapshotValueTransform;

  constructor(opts?: { excludeTables?: Iterable<string>; transformValue?: SnapshotValueTransform }) {
    this.excludeTables = new Set(opts?.excludeTables ?? []);
    this.transformValue = opts?.transformValue;
  }

  /** Distinct keys with a winner (dropped/GC'd rows still count until `finishBlocks`). */
  get keyCount(): number {
    return this.entries;
  }

  /** Winners whose block has not been materialized yet. */
  get pendingCount(): number {
    return this.pending;
  }

  /**
   * Fold ONE op found at log index `sourceIndex`. Ascending index order, exactly as
   * `SnapshotRowFolder.add` requires; only the position is retained, never the value.
   */
  add(op: PeerLogOp, sourceIndex: number): void {
    if (isSnapshotOp(op)) {
      const payload = op.value as SnapshotPayload | undefined;
      if (!payload || !Array.isArray(payload.rows)) return;
      for (let rowPos = 0; rowPos < payload.rows.length; rowPos++) {
        const r = payload.rows[rowPos]!;
        if (this.excludeTables.has(r.table)) continue;
        this.setWinner(r.table, r.hbKey, pack(sourceIndex, rowPos));
      }
      return;
    }
    if (this.excludeTables.has(op.table)) return;
    if (op.type !== 'put' && op.type !== 'del') return;
    this.setWinner(op.table, op.hbKey, pack(sourceIndex, -1));
  }

  private setWinner(table: string, hbKey: string, ref: number): void {
    let byKey = this.tables.get(table);
    if (!byKey) {
      byKey = new Map();
      this.tables.set(table, byKey);
    }
    const prev = byKey.get(hbKey);
    if (prev === undefined) {
      this.entries += 1;
      this.pending += 1;
    } else if (typeof prev === 'string') {
      this.pending += 1; // a materialized winner was superseded by a newer op
    }
    byKey.set(hbKey, ref);
    this.pendingByBlock = null;
  }

  /** The distinct log indexes whose blocks `materialize` still needs, ascending. */
  pendingBlockIndexes(): number[] {
    const byBlock = new Map<number, Array<{ table: string; hbKey: string; rowPos: number }>>();
    for (const [table, byKey] of this.tables) {
      for (const [hbKey, winner] of byKey) {
        if (typeof winner !== 'number') continue;
        const { blockIndex, rowPos } = unpack(winner);
        let list = byBlock.get(blockIndex);
        if (!list) {
          list = [];
          byBlock.set(blockIndex, list);
        }
        list.push({ table, hbKey, rowPos });
      }
    }
    this.pendingByBlock = byBlock;
    return [...byBlock.keys()].sort((a, b) => a - b);
  }

  /**
   * Materialize the winners stored in `ops[i]` (the DECODED op read at `indexes[i]`, from a
   * preceding `pendingBlockIndexes`). Each winner becomes its row JSON — transform applied,
   * tombstones past the horizon GC'd (`now`, as in `SnapshotRowFolder.finish`) — and the
   * decoded op is not retained. A missing winner block is an error: the set cannot be built
   * without it, and silently omitting the key would publish a thinner snapshot.
   */
  materialize(
    ops: ReadonlyArray<PeerLogOp | null>,
    indexes: readonly number[],
    opts: { now?: number; tombstoneHorizonMs?: number } = {},
  ): void {
    if (ops.length !== indexes.length) throw new Error('snapshot index fold: materialize ops/indexes length mismatch');
    const byBlock = this.pendingByBlock;
    if (!byBlock) throw new Error('snapshot index fold: materialize without a current pendingBlockIndexes()');
    const now = opts.now;
    const horizon = opts.tombstoneHorizonMs ?? SNAPSHOT_TOMBSTONE_HORIZON_MS;
    for (let i = 0; i < indexes.length; i++) {
      const blockIndex = indexes[i]!;
      const wanted = byBlock.get(blockIndex);
      if (!wanted) continue;
      const op = ops[i];
      if (!op) throw new Error(`snapshot index fold: winner block ${blockIndex} is unreadable`);
      for (const { table, hbKey, rowPos } of wanted) {
        const row = this.rowFor(op, blockIndex, rowPos);
        const keep = row !== null && !(row.deleted && now != null && row.ts < now - horizon);
        this.tables.get(table)!.set(hbKey, keep ? JSON.stringify(row) : '');
        this.pending -= 1;
      }
      byBlock.delete(blockIndex);
    }
  }

  /** The row `SnapshotRowFolder` would hold for this winner, or null when the transform dropped it. */
  private rowFor(op: PeerLogOp, sourceIndex: number, rowPos: number): SnapshotRow | null {
    if (rowPos >= 0) {
      const r = (op.value as SnapshotPayload | undefined)?.rows?.[rowPos];
      if (!r || !isSnapshotOp(op)) {
        throw new Error(`snapshot index fold: block ${sourceIndex} has no snapshot row ${rowPos}`);
      }
      const value = this.transformValue
        ? this.transformValue(r.value, {
            table: r.table,
            hbKey: r.hbKey,
            sourceIndex,
            epoch: r.epoch,
            authorPubkey: r.author_pubkey,
          })
        : r.value;
      if (value === DROP_SNAPSHOT_ROW) return null;
      return value === r.value ? r : { ...r, value };
    }
    if (op.type === 'put') {
      const value = this.transformValue
        ? this.transformValue(op.value, {
            table: op.table,
            hbKey: op.hbKey,
            sourceIndex,
            epoch: op.epoch ?? undefined,
            authorPubkey: op.author_pubkey,
          })
        : op.value;
      if (value === DROP_SNAPSHOT_ROW) return null;
      // Field order is part of the bytes: identical to SnapshotRowFolder.add.
      return {
        table: op.table,
        hbKey: op.hbKey,
        value,
        ts: op.ts,
        schema_version: op.schema_version,
        ...(op.hlc ? { hlc: op.hlc } : {}),
        ...(op.epoch != null ? { epoch: op.epoch } : {}),
        ...(op.author_pubkey != null ? { author_pubkey: op.author_pubkey } : {}),
      };
    }
    if (op.type === 'del') {
      return {
        table: op.table,
        hbKey: op.hbKey,
        value: null,
        ts: op.ts,
        schema_version: op.schema_version,
        ...(op.hlc ? { hlc: op.hlc } : {}),
        deleted: true,
      };
    }
    throw new Error(`snapshot index fold: block ${sourceIndex} is not a put/del (type ${String(op.type)})`);
  }

  /**
   * Emit the snapshot set as stored blocks, byte-identical to
   * `buildSnapshotOpsFromRows({ rows: SnapshotRowFolder.finish({ now }), ... }).map(encode)`.
   * Every winner must be materialized. Releases the fold state.
   */
  finishBlocks(args: {
    coversUpTo: number;
    author_pubkey: string;
    ts: number;
    schema_version: number;
    maxChunkBytes?: number;
    excludeTables?: readonly string[];
  }): { blocks: Uint8Array[]; rowCount: number } {
    if (this.pending > 0) {
      throw new Error(`snapshot index fold: finish with ${this.pending} winner(s) not materialized`);
    }
    const budget = args.maxChunkBytes && args.maxChunkBytes > 0 ? args.maxChunkBytes : SNAPSHOT_MAX_CHUNK_BYTES;
    // Greedy pack in (table, hbKey) order — the same rule as chunkSnapshotRows.
    const chunks: string[][] = [];
    let cur: string[] = [];
    let curBytes = 0;
    let rowCount = 0;
    for (const table of [...this.tables.keys()].sort(cmpStr)) {
      const byKey = this.tables.get(table)!;
      for (const hbKey of [...byKey.keys()].sort(cmpStr)) {
        const json = byKey.get(hbKey) as string;
        if (json === '') continue;
        const rowBytes = Buffer.byteLength(json, 'utf8');
        if (cur.length > 0 && curBytes + rowBytes > budget) {
          chunks.push(cur);
          cur = [];
          curBytes = 0;
        }
        cur.push(json);
        curBytes += rowBytes;
        rowCount += 1;
      }
      this.tables.delete(table); // release as we go; finish is terminal
    }
    chunks.push(cur);
    this.entries = 0;
    const chunkCount = chunks.length;
    const blocks = chunks.map((rows, chunkIdx) => {
      const shell = JSON.stringify(
        buildSnapshotChunkOp({
          rows: [ROWS_SENTINEL as unknown as SnapshotRow],
          coversUpTo: args.coversUpTo,
          chunkIdx,
          chunkCount,
          author_pubkey: args.author_pubkey,
          ts: args.ts,
          schema_version: args.schema_version,
          ...(args.excludeTables ? { excludeTables: args.excludeTables } : {}),
        }),
      );
      const at = shell.indexOf(ROWS_SENTINEL_JSON);
      if (at < 0 || shell.indexOf(ROWS_SENTINEL_JSON, at + 1) >= 0) {
        throw new Error('snapshot index fold: chunk shell did not contain exactly one rows placeholder');
      }
      return utf8.encode(`${shell.slice(0, at)}[${rows.join(',')}]${shell.slice(at + ROWS_SENTINEL_JSON.length)}`);
    });
    return { blocks, rowCount };
  }

  /** Serialize the SCAN state for `restoreCheckpoint`. Refused once materialization has begun. */
  exportCheckpoint(meta: SnapshotFoldCheckpointMeta): Uint8Array {
    if (this.pending !== this.entries) {
      throw new Error('snapshot index fold: cannot checkpoint after materialization began');
    }
    const tables: Array<[string, string[], number[]]> = [];
    for (const [table, byKey] of this.tables) {
      tables.push([table, [...byKey.keys()], [...byKey.values()] as number[]]);
    }
    return utf8.encode(
      JSON.stringify({
        v: SNAPSHOT_FOLD_CHECKPOINT_VERSION,
        logKey: meta.logKey,
        cursor: meta.cursor,
        excludeTables: [...this.excludeTables].sort(),
        tables,
      }),
    );
  }

  /**
   * Replace this (empty) folder's state with a checkpoint, when it is for `logKey`, was taken
   * with the same `excludeTables`, and its cursor lies in `[minCursor, maxCursor]`. Anything
   * else is refused with a reason and leaves the folder untouched, so the caller falls back to
   * seeding or folding from 0 — both always correct.
   */
  restoreCheckpoint(
    bytes: Uint8Array,
    expect: { logKey: string; minCursor?: number; maxCursor: number },
  ): RestoreCheckpointResult {
    if (this.entries > 0) return { ok: false, reason: 'folder is not empty' };
    let parsed: {
      v?: unknown;
      logKey?: unknown;
      cursor?: unknown;
      excludeTables?: unknown;
      tables?: unknown;
    };
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return { ok: false, reason: 'unparseable checkpoint' };
    }
    if (parsed.v !== SNAPSHOT_FOLD_CHECKPOINT_VERSION) return { ok: false, reason: `version ${String(parsed.v)}` };
    if (parsed.logKey !== expect.logKey) return { ok: false, reason: 'checkpoint is for another log' };
    const cursor = parsed.cursor;
    if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) {
      return { ok: false, reason: 'invalid cursor' };
    }
    if (cursor > expect.maxCursor) return { ok: false, reason: `cursor ${cursor} is past the log end ${expect.maxCursor}` };
    if (expect.minCursor !== undefined && cursor < expect.minCursor) {
      return { ok: false, reason: `cursor ${cursor} is behind the seed end ${expect.minCursor}` };
    }
    const mine = [...this.excludeTables].sort();
    if (JSON.stringify(parsed.excludeTables) !== JSON.stringify(mine)) {
      return { ok: false, reason: 'excludeTables differ' };
    }
    if (!Array.isArray(parsed.tables)) return { ok: false, reason: 'invalid tables' };
    const restored = new Map<string, Map<string, Winner>>();
    let entries = 0;
    for (const entry of parsed.tables as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 3) return { ok: false, reason: 'invalid table entry' };
      const [table, keys, refs] = entry as [unknown, unknown, unknown];
      if (typeof table !== 'string' || !Array.isArray(keys) || !Array.isArray(refs) || keys.length !== refs.length) {
        return { ok: false, reason: 'invalid table entry' };
      }
      const byKey = new Map<string, Winner>();
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const ref = refs[i];
        if (typeof k !== 'string' || typeof ref !== 'number' || !Number.isFinite(ref) || ref < 0) {
          return { ok: false, reason: 'invalid winner' };
        }
        // A winner can only point at an op the checkpoint says it folded.
        if (unpack(ref).blockIndex >= cursor) return { ok: false, reason: 'winner beyond cursor' };
        byKey.set(k, ref);
      }
      entries += byKey.size;
      restored.set(table, byKey);
    }
    for (const [table, byKey] of restored) this.tables.set(table, byKey);
    this.entries = entries;
    this.pending = entries;
    this.pendingByBlock = null;
    return { ok: true, cursor };
  }
}
