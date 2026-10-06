/**
 * WI-10002855 — the main-thread client for the snapshot-fold worker.
 *
 * One worker per compaction: the fold holds the whole live-key set, so it is stateful
 * and long-lived for exactly one run, and must never share a thread with anything a
 * request path waits on (cpu-task-worker.ts serves request serialization — a 30-minute
 * fold there would stall every large response).
 *
 * There is deliberately NO inline fallback. The inline fold is the defect: it froze
 * bg-host for 30+ minutes. If the worker cannot start or dies, the compaction FAILS —
 * `runOwnCompaction` records a `log compaction failed` boot row and the next merge pass
 * retries — which costs one snapshot, not the host.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { pinModuleState } from '@papercusp/module-singleton';
import {
  SnapshotAbortedError,
  type SnapshotFoldCheckpointStore,
  type SnapshotFoldWindowResult,
  type SnapshotFoldWorkerLike,
} from './log-snapshot';
import { resolveMemoryWatchdogLimitMb } from '../../memory-watchdog';
import type { PeerLogOp } from './peer-log';
import type { GovernorReceiptSnapshotFilter } from './governor-receipt-snapshot-filter';
import {
  packBlocks,
  unpackBlocks,
  type SnapshotFoldRequest,
  type SnapshotFoldResponse,
} from './snapshot-fold-protocol';

type RequestBody = SnapshotFoldRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

/**
 * P-006 — the resume checkpoint of an own-log fold, as a FILE.
 *
 * Why a file and not Postgres (the storage-policy default): it is a disposable, derived cache
 * of the own log, which is itself files (the corestore); it can be ~100+ MB on a large pot and
 * is rewritten every few minutes during a fold; and losing it only costs a longer fold, never
 * correctness (`restoreCheckpoint` validates the log key, exclusions and cursor, and anything
 * that does not fit falls back to the seed or a fold from 0). Writes are atomic (tmp + rename)
 * so a crash mid-save leaves the previous checkpoint, never a torn one.
 */
export function fileSnapshotFoldCheckpointStore(path: string): SnapshotFoldCheckpointStore {
  return {
    async load() {
      try {
        return new Uint8Array(await readFile(path));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    async save(bytes) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, path);
    },
    async clear() {
      await rm(path, { force: true });
    },
  };
}

/**
 * The bundled `.mjs` beside the executing module (dist-host / the desktop sidecar),
 * else the source-tree bootstrap that loads the `.ts` worker through tsx (tsx and
 * vitest runtimes — see snapshot-fold.worker.dev.mjs for why a plain `.ts` path fails).
 * Same bundled-first resolution as the event-loop sentinel worker, for the same
 * reason: esbuild emits no sibling assets on its own.
 */
export function snapshotFoldWorkerPath(): string {
  const here = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const dir = dirname(here);
  const bundled = resolve(dir, 'snapshot-fold.worker.mjs');
  return existsSync(bundled) ? bundled : resolve(dir, 'snapshot-fold.worker.dev.mjs');
}

/** Fraction of the host's committed-memory recycle limit the fold's old space may use. */
export const SNAPSHOT_FOLD_WORKER_HEAP_FRACTION = 0.45;
/** Floor, so a small-limit host can still fold a small pot. */
export const SNAPSHOT_FOLD_WORKER_MIN_HEAP_MB = 2048;

/**
 * WI-10002836 — the fold worker's explicit old-space cap, derived from the host's recycle
 * limit (`resolveMemoryWatchdogLimitMb`, 24576 MiB for bg-host on the tower).
 *
 * WHY EXPLICIT. Unset, the worker inherits the host's `--max-old-space-size` (12288 on
 * bg-host), and V8 does not count ArrayBuffers against it. MEASURED 2026-09-24: the fold
 * sat near that cap, GC-thrashing, while the process's committed memory climbed to
 * 25.1 GB and the memory watchdog recycled the WHOLE host, not the fold. Capping the
 * worker below the recycle limit makes a runaway fold end as a worker OOM, which
 * `SnapshotFoldWorker` reports as a failed compaction while the host keeps serving.
 * The remaining ~55% is for the host's own heap, its in-flight read windows and native memory.
 *
 * ⚠ `resourceLimits` ALONE DOES NOT ENFORCE THIS. V8 flags are process-global, and a
 * process-wide `--max-old-space-size` (argv or NODE_OPTIONS) OVERRIDES a Worker's
 * `maxOldGenerationSizeMb`. bg-host runs with NODE_OPTIONS=--max-old-space-size=12288, so
 * there the worker's real limit stayed 12 GB. MEASURED 2026-09-24 on node 22.21:
 * `resourceLimits.maxOldGenerationSizeMb: 96` gives heap_size_limit 12336 MB under
 * `--max-old-space-size=12288`, and 4144 MB under `NODE_OPTIONS=--max-old-space-size=4096`.
 * So the cap is enforced as a SOFT cap: the worker reports its used heap after every window
 * (GC-confirmed once over the cap), and `SnapshotFoldWorker.fold` fails the fold when it is
 * exceeded. `resourceLimits` remains a hard backstop at `SNAPSHOT_FOLD_WORKER_HARD_LIMIT_FACTOR`
 * above it, effective only on a host with no global flag.
 */
export function snapshotFoldWorkerHeapMb(limitMb: number = resolveMemoryWatchdogLimitMb()): number {
  return Math.max(SNAPSHOT_FOLD_WORKER_MIN_HEAP_MB, Math.floor(limitMb * SNAPSHOT_FOLD_WORKER_HEAP_FRACTION));
}

/**
 * The hard `resourceLimits` backstop sits this far ABOVE the soft cap. Far enough that the
 * per-window soft check fires first (one window adds a few MB), so a runaway fold fails with a
 * named error instead of a V8 abort, wherever the backstop is honoured at all.
 */
export const SNAPSHOT_FOLD_WORKER_HARD_LIMIT_FACTOR = 1.25;

/** The error a fold fails with when the worker's live set outgrows its soft heap cap. */
export class SnapshotFoldHeapCapError extends Error {
  constructor(
    readonly usedBytes: number,
    readonly capBytes: number,
  ) {
    super(
      `snapshot fold worker exceeded its heap cap: ${Math.round(usedBytes / 1048576)} MB used after GC > ` +
        `${Math.round(capBytes / 1048576)} MB cap (WI-10002836) — the fold is abandoned so the host keeps serving`,
    );
    this.name = 'SnapshotFoldHeapCapError';
  }
}

/**
 * WI-10002836 — how many fold workers may run at once in this PROCESS, across every pot.
 *
 * The heap cap above is per worker, so it bounds the host only if folds do not stack.
 * One bg-host boots ~100 pots, each with its own engine and its own compaction; many are
 * due at the same boot. Without this limit, a papercusp-sized fold plus a few mid-sized
 * ones could together exceed the recycle limit that each alone respects. Waiting is cheap
 * (small pots queue behind a big one for minutes); a host recycle costs every agent.
 */
export const SNAPSHOT_FOLD_MAX_CONCURRENT = 1;

const foldSlots = pinModuleState('@papercusp/operator-core.snapshot-fold-slots', () => ({
  active: 0,
  waiters: [] as Array<() => void>,
}));

/**
 * Take a fold slot; resolves with its release function. Rejects (and leaves the queue) if
 * `signal` aborts first, so a stopping engine is never held hostage by another pot's fold.
 */
export function acquireSnapshotFoldSlot(
  signal?: AbortSignal,
  max: number = SNAPSHOT_FOLD_MAX_CONCURRENT,
): Promise<() => void> {
  const release = (): void => {
    foldSlots.active -= 1;
    foldSlots.waiters.shift()?.();
  };
  const once = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  };
  if (signal?.aborted) return Promise.reject(new SnapshotAbortedError('[snapshot] fold slot wait aborted'));
  if (foldSlots.active < max) {
    foldSlots.active += 1;
    return Promise.resolve(once());
  }
  return new Promise((resolveSlot, reject) => {
    const grant = (): void => {
      signal?.removeEventListener('abort', onAbort);
      foldSlots.active += 1;
      resolveSlot(once());
    };
    const onAbort = (): void => {
      const i = foldSlots.waiters.indexOf(grant);
      if (i >= 0) foldSlots.waiters.splice(i, 1);
      reject(new SnapshotAbortedError('[snapshot] fold slot wait aborted'));
    };
    foldSlots.waiters.push(grant);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Test/diagnostic view of the process-wide fold slots. */
export function snapshotFoldSlotState(): { active: number; waiting: number } {
  return { active: foldSlots.active, waiting: foldSlots.waiters.length };
}

export class SnapshotFoldWorker implements SnapshotFoldWorkerLike {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: SnapshotFoldResponse) => void; reject: (e: Error) => void }
  >();
  private failure: Error | null = null;
  private closed = false;

  /**
   * @param releaseSlot the process-wide fold slot this worker holds (idempotent). Released
   *   when the thread is gone — on `close()`, or on an unexpected exit (a heap-cap OOM), so
   *   a crashed worker can never strand the slot and freeze every other pot's compaction.
   */
  private constructor(
    private readonly worker: Worker,
    private readonly releaseSlot: () => void = () => {},
    /** The SOFT heap cap `fold()` enforces from the worker's own reports (see snapshotFoldWorkerHeapMb). */
    private readonly heapCapBytes: number = Number.POSITIVE_INFINITY,
  ) {
    worker.on('message', (res: SnapshotFoldResponse) => {
      const waiter = this.pending.get(res.id);
      if (!waiter) return;
      this.pending.delete(res.id);
      if (res.kind === 'error') waiter.reject(new Error(`snapshot fold worker: ${res.message}`));
      else waiter.resolve(res);
    });
    // Named, so the compaction's failure row says WHICH worker died and why — a heap-cap
    // OOM (`resourceLimits`, WI-10002836) arrives here as Node's ERR_WORKER_OUT_OF_MEMORY.
    worker.on('error', (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      const code = (e as { code?: unknown }).code;
      this.failAll(
        new Error(`snapshot fold worker failed${typeof code === 'string' ? ` (${code})` : ''}: ${e.message}`),
      );
    });
    worker.on('exit', (code) => {
      if (!this.closed) this.failAll(new Error(`snapshot fold worker exited unexpectedly (code ${code})`));
      this.releaseSlot();
    });
  }

  /**
   * Spawn a worker and initialize its fold. Waits for a process-wide fold slot first
   * (`SNAPSHOT_FOLD_MAX_CONCURRENT`); the slot is held until `close()`. Rejects if the
   * worker cannot start, or with `SnapshotAbortedError` if `signal` aborts while queued.
   */
  static async open(
    init: { excludeTables: readonly string[]; governorReceiptFilter?: GovernorReceiptSnapshotFilter },
    opts: { workerPath?: string; maxOldGenerationSizeMb?: number; signal?: AbortSignal } = {},
  ): Promise<SnapshotFoldWorker> {
    const releaseSlot = await acquireSnapshotFoldSlot(opts.signal);
    const capMb = opts.maxOldGenerationSizeMb ?? snapshotFoldWorkerHeapMb();
    const heapCapBytes = capMb * 1024 * 1024;
    let client: SnapshotFoldWorker;
    try {
      client = new SnapshotFoldWorker(
        new Worker(opts.workerPath ?? snapshotFoldWorkerPath(), {
          workerData: { heapCapBytes },
          resourceLimits: { maxOldGenerationSizeMb: Math.ceil(capMb * SNAPSHOT_FOLD_WORKER_HARD_LIMIT_FACTOR) },
        }),
        releaseSlot,
        heapCapBytes,
      );
    } catch (e) {
      releaseSlot();
      throw e;
    }
    try {
      await client.request({
        kind: 'init',
        excludeTables: [...init.excludeTables],
        ...(init.governorReceiptFilter ? { governorReceiptFilter: init.governorReceiptFilter } : {}),
      });
    } catch (e) {
      await client.close();
      throw e;
    }
    return client;
  }

  async fold(
    blocks: ReadonlyArray<Uint8Array | null>,
    opts: { skipSnapshotOps?: boolean; sourceStart?: number } = {},
  ): Promise<SnapshotFoldWindowResult> {
    const { buf, lengths } = packBlocks(blocks);
    const res = await this.request(
      {
        kind: 'fold',
        buf,
        lengths,
        ...(opts.skipSnapshotOps ? { skipSnapshotOps: true } : {}),
        ...(opts.sourceStart !== undefined ? { sourceStart: opts.sourceStart } : {}),
      },
      [buf],
    );
    if (res.kind !== 'folded') throw new Error(`snapshot fold worker: unexpected reply ${res.kind} to fold`);
    if (res.heapUsedBytes !== undefined && res.heapUsedBytes > this.heapCapBytes) {
      const e = new SnapshotFoldHeapCapError(res.heapUsedBytes, this.heapCapBytes);
      this.failAll(e); // every later request fails fast; the producer's finally closes the worker
      throw e;
    }
    return {
      decodedOps: res.decodedOps,
      decodedBytes: res.decodedBytes,
      skippedSnapshotOps: res.skippedSnapshotOps,
      keyCount: res.keyCount,
      ...(res.heapUsedBytes !== undefined ? { heapUsedBytes: res.heapUsedBytes } : {}),
    };
  }

  async inspect(blocks: ReadonlyArray<Uint8Array | null>): Promise<Array<PeerLogOp | null>> {
    const { buf, lengths } = packBlocks(blocks);
    const res = await this.request({ kind: 'inspect', buf, lengths }, [buf]);
    if (res.kind !== 'inspected') throw new Error(`snapshot fold worker: unexpected reply ${res.kind} to inspect`);
    return res.ops;
  }

  async pendingIndexes(): Promise<number[]> {
    const res = await this.request({ kind: 'pending' });
    if (res.kind !== 'pending') throw new Error(`snapshot fold worker: unexpected reply ${res.kind} to pending`);
    return res.indexes;
  }

  async materialize(blocks: ReadonlyArray<Uint8Array | null>, indexes: readonly number[], now: number): Promise<void> {
    const { buf, lengths } = packBlocks(blocks);
    const res = await this.request({ kind: 'materialize', buf, lengths, indexes: [...indexes], now }, [buf]);
    if (res.kind !== 'materialized') throw new Error(`snapshot fold worker: unexpected reply ${res.kind} to materialize`);
    // The materialized rows are the set's own bytes, so the soft cap guards this phase too.
    if (res.heapUsedBytes !== undefined && res.heapUsedBytes > this.heapCapBytes) {
      const e = new SnapshotFoldHeapCapError(res.heapUsedBytes, this.heapCapBytes);
      this.failAll(e);
      throw e;
    }
  }

  async checkpoint(args: { logKey: string; cursor: number }): Promise<Uint8Array> {
    const res = await this.request({ kind: 'checkpoint', ...args });
    if (res.kind !== 'checkpointed') throw new Error(`snapshot fold worker: unexpected reply ${res.kind} to checkpoint`);
    return new Uint8Array(res.buf);
  }

  async restore(
    bytes: Uint8Array,
    args: { logKey: string; minCursor?: number; maxCursor: number },
  ): Promise<{ cursor: number | null; reason?: string }> {
    const buf = bytes.slice().buffer;
    const res = await this.request({ kind: 'restore', buf, ...args }, [buf]);
    if (res.kind !== 'restored') throw new Error(`snapshot fold worker: unexpected reply ${res.kind} to restore`);
    return { cursor: res.cursor, ...(res.reason ? { reason: res.reason } : {}) };
  }

  async finish(args: {
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
  }> {
    const res = await this.request({ kind: 'finish', ...args, excludeTables: [...args.excludeTables] });
    if (res.kind !== 'finished') throw new Error(`snapshot fold worker: unexpected reply ${res.kind} to finish`);
    const blocks = unpackBlocks(res.buf, res.lengths).map((b, i) => {
      if (!b) throw new Error(`snapshot fold worker: finish returned an empty chunk at ${i}`);
      return b;
    });
    return {
      blocks,
      rowCount: res.rowCount,
      ...(res.droppedGovernorReceipts !== undefined ? { droppedGovernorReceipts: res.droppedGovernorReceipts } : {}),
      ...(res.unopenedGovernorEnvelopes !== undefined
        ? { unopenedGovernorEnvelopes: res.unopenedGovernorEnvelopes }
        : {}),
    };
  }

  /** Terminate the thread (releasing its heap). Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('snapshot fold worker closed'));
    try {
      await this.worker.terminate();
    } finally {
      this.releaseSlot();
    }
  }

  private request(body: RequestBody, transfer: ArrayBuffer[] = []): Promise<SnapshotFoldResponse> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<SnapshotFoldResponse>((resolveReply, reject) => {
      this.pending.set(id, { resolve: resolveReply, reject });
      try {
        this.worker.postMessage({ ...body, id } as SnapshotFoldRequest, transfer);
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private failAll(err: Error): void {
    this.failure ??= err;
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }
}
