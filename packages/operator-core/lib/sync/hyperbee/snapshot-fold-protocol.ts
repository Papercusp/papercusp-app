/**
 * WI-10002855 — the message protocol and request handler for the snapshot-fold worker.
 *
 * WHY A WORKER. The first own-log compaction of an existing pot folds its WHOLE history.
 * On the tower's papercusp pot that is 7.76M ops (~37 GB of decoded JSON), and it ran on
 * bg-host's main thread: each 256-op window decoded and folded synchronously, and the
 * fold's live-key Map grew the main isolate's heap past 7 GB. Measured 2026-09-24:
 * event-loop lag p50 2.8s, every PG connect timed out, DBOS queues stalled, the
 * green-checkpoint fire was missed and git-sync stalled — for 30+ minutes.
 *
 * The fold is pure CPU over bytes, so it belongs off the event loop. The main thread
 * keeps only block I/O: it reads RAW blocks (`OwnLog.getRaw`, no JSON.parse), packs them
 * into one transferable buffer per window, and the worker decodes and folds them. The
 * row Map therefore lives in the WORKER's heap, whose GC never pauses the host. The
 * result comes back pre-encoded (`OwnLog.appendRawBatch`), so the main thread never
 * decodes or re-encodes the multi-GB snapshot either.
 *
 * This module is imported by BOTH sides and by the bundled worker, so it must stay
 * free of host-only imports: `log-snapshot.ts` is pure (type-only imports), and this
 * file adds nothing but that.
 */
import {
  governorReceiptSnapshotValueTransform,
  isSnapshotBlock,
  isSnapshotOp,
  type GovernorReceiptSnapshotFilterStats,
  type SnapshotPayload,
} from './log-snapshot';
import { SnapshotIndexFolder } from './snapshot-index-fold';
import type { GovernorReceiptSnapshotFilter } from './governor-receipt-snapshot-filter';
import type { OpAAD } from './hive-epoch-crypto';
import type { PeerLogOp } from './peer-log';

export type SnapshotFoldRequest =
  | { kind: 'init'; id: number; excludeTables: string[]; governorReceiptFilter?: GovernorReceiptSnapshotFilter }
  | {
      kind: 'fold';
      id: number;
      buf: ArrayBuffer;
      lengths: number[];
      skipSnapshotOps?: boolean;
      sourceStart?: number;
    }
  | { kind: 'inspect'; id: number; buf: ArrayBuffer; lengths: number[] }
  /** P-006: the log indexes whose blocks still hold an unmaterialized winner. */
  | { kind: 'pending'; id: number }
  /** P-006: the raw blocks at `indexes` (from `pending`), turned into row JSON. */
  | { kind: 'materialize'; id: number; buf: ArrayBuffer; lengths: number[]; indexes: number[]; now: number }
  /** P-006: serialize the scan state covering every op below `cursor`. */
  | { kind: 'checkpoint'; id: number; logKey: string; cursor: number }
  /** P-006: load a checkpoint into the (fresh) fold, if it fits `[minCursor, maxCursor]`. */
  | { kind: 'restore'; id: number; buf: ArrayBuffer; logKey: string; minCursor?: number; maxCursor: number }
  | {
      kind: 'finish';
      id: number;
      now: number;
      coversUpTo: number;
      author_pubkey: string;
      ts: number;
      schema_version: number;
      maxChunkBytes?: number;
      excludeTables: string[];
      /** WI-10005425 — see `SnapshotPayload.ownPrefix`. */
      ownPrefix?: boolean;
    };

export type SnapshotFoldResponse =
  | { kind: 'ok'; id: number }
  | {
      kind: 'folded';
      id: number;
      decodedOps: number;
      decodedBytes: number;
      keyCount: number;
      /** Snapshot ops decoded and then passed over (`skipSnapshotOps`). */
      skippedSnapshotOps: number;
      /** The worker isolate's used heap after this fold, when the shell supplies a probe. */
      heapUsedBytes?: number;
    }
  | { kind: 'inspected'; id: number; ops: Array<PeerLogOp | null> }
  | { kind: 'pending'; id: number; indexes: number[] }
  | { kind: 'materialized'; id: number; remaining: number; heapUsedBytes?: number }
  | { kind: 'checkpointed'; id: number; buf: ArrayBuffer }
  | { kind: 'restored'; id: number; cursor: number | null; reason?: string }
  | {
      kind: 'finished';
      id: number;
      buf: ArrayBuffer;
      lengths: number[];
      rowCount: number;
      droppedGovernorReceipts?: number;
      unopenedGovernorEnvelopes?: number;
    }
  | { kind: 'error'; id: number; message: string };

/**
 * Pack blocks into ONE buffer (transferable, so crossing the thread boundary is a
 * pointer move, not a copy) plus their lengths. A null block is length -1.
 *
 * The copy into a fresh buffer is deliberate: hypercore can hand back views into a
 * larger shared allocation, and transferring THAT would detach memory still in use.
 */
export function packBlocks(blocks: ReadonlyArray<Uint8Array | null>): { buf: ArrayBuffer; lengths: number[] } {
  let total = 0;
  for (const b of blocks) if (b) total += b.byteLength;
  const out = new Uint8Array(total);
  const lengths: number[] = [];
  let off = 0;
  for (const b of blocks) {
    if (!b) {
      lengths.push(-1);
      continue;
    }
    out.set(b, off);
    off += b.byteLength;
    lengths.push(b.byteLength);
  }
  return { buf: out.buffer, lengths };
}

export function unpackBlocks(buf: ArrayBuffer, lengths: readonly number[]): Array<Uint8Array | null> {
  const view = new Uint8Array(buf);
  const out: Array<Uint8Array | null> = [];
  let off = 0;
  for (const len of lengths) {
    if (len < 0) {
      out.push(null);
      continue;
    }
    out.push(view.subarray(off, off + len));
    off += len;
  }
  return out;
}

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

/** Decode one stored block. Hypercore's `json` encoding is exactly UTF-8 `JSON.stringify`. */
export function decodeStoredBlock(block: Uint8Array): PeerLogOp {
  return JSON.parse(utf8Decoder.decode(block)) as PeerLogOp;
}

/** Encode one op exactly as hypercore's `json` encoding would store it. */
export function encodeStoredBlock(op: PeerLogOp): Uint8Array {
  return utf8Encoder.encode(JSON.stringify(op));
}

/**
 * The op WITHOUT its bulk: a snapshot op keeps every payload field except `rows` (the
 * seek and the anchor check read only the set metadata and `excludeTables`), and any
 * other op keeps only what `isSnapshotOp` and span checks look at. This is what lets
 * the prior-snapshot seek run on the main thread without holding GBs of decoded rows.
 */
export function summarizeOp(op: PeerLogOp): PeerLogOp {
  if (isSnapshotOp(op)) {
    const payload = (op.value ?? {}) as SnapshotPayload;
    return { ...op, value: { ...payload, rows: [] } };
  }
  return { type: op.type, table: op.table, hbKey: op.hbKey, ts: op.ts, schema_version: op.schema_version } as PeerLogOp;
}

/** One transfer-ready reply. */
export interface SnapshotFoldReply {
  res: SnapshotFoldResponse;
  transfer: ArrayBuffer[];
}

/**
 * The worker's whole state machine, factored out of the thread shell so it is directly
 * testable. `init` → any number of `fold`/`inspect` → `finish` (which releases the fold).
 * Folds must arrive in ascending log-index order — the SnapshotRowFolder contract.
 */
export function createSnapshotFoldHandler(
  opts: {
    /**
     * WI-10002836 — this isolate's used heap, reported on every `folded` reply. The worker
     * shell passes `v8.getHeapStatistics().used_heap_size`; it is injected rather than
     * read here because `process.memoryUsage()` in a direct (main-thread) test would
     * report the TEST's heap and read as the fold's.
     */
    heapUsedBytes?: () => number;
    /**
     * D-024 — a synchronous AEAD open (`openOpCiphertext` bound to the worker's loaded
     * sodium), so the P-530 filter can judge an encrypted row's plaintext. Absent ⇒
     * encrypted rows are kept and counted as unopened.
     */
    openEnvelope?: (ciphertext: Uint8Array, key: Uint8Array, ad: OpAAD) => Uint8Array;
  } = {},
): (req: SnapshotFoldRequest) => SnapshotFoldReply {
  // P-006: the index-only fold — winners are positions during the scan, row JSON after
  // `materialize`; no decoded value is retained between requests (snapshot-index-fold.ts).
  let folder: SnapshotIndexFolder | null = null;
  let governorStats: GovernorReceiptSnapshotFilterStats | null = null;

  const requireFolder = (): SnapshotIndexFolder => {
    if (!folder) throw new Error('snapshot fold worker: fold/finish before init (or after finish)');
    return folder;
  };

  return (req) => {
    try {
      switch (req.kind) {
        case 'init': {
          const projection = req.governorReceiptFilter
            ? governorReceiptSnapshotValueTransform(
                req.governorReceiptFilter,
                opts.openEnvelope ? { open: opts.openEnvelope } : {},
              )
            : null;
          governorStats = projection?.stats ?? null;
          folder = new SnapshotIndexFolder({
            excludeTables: req.excludeTables,
            ...(projection ? { transformValue: projection.transform } : {}),
          });
          return { res: { kind: 'ok', id: req.id }, transfer: [] };
        }
        case 'fold': {
          // Counts are PER REQUEST; the caller totals them per scanned range.
          const f = requireFolder();
          let decodedOps = 0;
          let decodedBytes = 0;
          let skippedSnapshotOps = 0;
          const blocks = unpackBlocks(req.buf, req.lengths);
          for (let offset = 0; offset < blocks.length; offset++) {
            const block = blocks[offset];
            if (!block) continue;
            // WI-10002836: the caller normally drops redundant snapshot chunks before
            // sending; this catches any it sent anyway, still without a parse.
            if (req.skipSnapshotOps && isSnapshotBlock(block)) {
              skippedSnapshotOps += 1;
              continue;
            }
            const op = decodeStoredBlock(block);
            // A snapshot op in another key order than `isSnapshotBlock` recognizes.
            if (req.skipSnapshotOps && isSnapshotOp(op)) {
              skippedSnapshotOps += 1;
              continue;
            }
            decodedOps += 1;
            // The stored block IS the op's UTF-8 JSON, so its length is the measure the
            // inline fold used to get by re-stringifying every op (a second full pass).
            decodedBytes += block.byteLength;
            // The index IS the retained state now, so an absent sourceStart means "from 0".
            f.add(op, (req.sourceStart ?? 0) + offset);
          }
          const heapUsedBytes = opts.heapUsedBytes?.();
          return {
            res: {
              kind: 'folded',
              id: req.id,
              decodedOps,
              decodedBytes,
              keyCount: f.keyCount,
              skippedSnapshotOps,
              ...(heapUsedBytes !== undefined ? { heapUsedBytes } : {}),
            },
            transfer: [],
          };
        }
        case 'inspect':
          return {
            res: {
              kind: 'inspected',
              id: req.id,
              ops: unpackBlocks(req.buf, req.lengths).map((b) => (b ? summarizeOp(decodeStoredBlock(b)) : null)),
            },
            transfer: [],
          };
        case 'pending':
          return { res: { kind: 'pending', id: req.id, indexes: requireFolder().pendingBlockIndexes() }, transfer: [] };
        case 'materialize': {
          const f = requireFolder();
          const ops = unpackBlocks(req.buf, req.lengths).map((b) => (b ? decodeStoredBlock(b) : null));
          f.materialize(ops, req.indexes, { now: req.now });
          const heapUsedBytes = opts.heapUsedBytes?.();
          return {
            res: {
              kind: 'materialized',
              id: req.id,
              remaining: f.pendingCount,
              ...(heapUsedBytes !== undefined ? { heapUsedBytes } : {}),
            },
            transfer: [],
          };
        }
        case 'checkpoint': {
          const bytes = requireFolder().exportCheckpoint({ logKey: req.logKey, cursor: req.cursor });
          // A fresh copy owns its whole buffer, so transferring it detaches nothing else.
          const buf = bytes.slice().buffer;
          return { res: { kind: 'checkpointed', id: req.id, buf }, transfer: [buf] };
        }
        case 'restore': {
          const r = requireFolder().restoreCheckpoint(new Uint8Array(req.buf), {
            logKey: req.logKey,
            maxCursor: req.maxCursor,
            ...(req.minCursor !== undefined ? { minCursor: req.minCursor } : {}),
          });
          return {
            res: r.ok
              ? { kind: 'restored', id: req.id, cursor: r.cursor }
              : { kind: 'restored', id: req.id, cursor: null, reason: r.reason },
            transfer: [],
          };
        }
        case 'finish': {
          const { blocks, rowCount } = requireFolder().finishBlocks({
            coversUpTo: req.coversUpTo,
            author_pubkey: req.author_pubkey,
            ts: req.ts,
            schema_version: req.schema_version,
            maxChunkBytes: req.maxChunkBytes,
            excludeTables: req.excludeTables,
            ...(req.ownPrefix ? { ownPrefix: true } : {}),
          });
          const packed = packBlocks(blocks);
          folder = null; // release the live-key Map before the reply crosses back
          const stats = governorStats;
          governorStats = null;
          return {
            res: {
              kind: 'finished',
              id: req.id,
              buf: packed.buf,
              lengths: packed.lengths,
              rowCount,
              ...(stats
                ? { droppedGovernorReceipts: stats.dropped, unopenedGovernorEnvelopes: stats.unopened }
                : {}),
            },
            transfer: [packed.buf],
          };
        }
      }
    } catch (e) {
      return {
        res: { kind: 'error', id: req.id, message: e instanceof Error ? e.message : String(e) },
        transfer: [],
      };
    }
  };
}
