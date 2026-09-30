/**
 * Chunked transfer with resume — the fourth P-021 contract.
 *
 * A large upload/download is split into capability-sized chunks and issued
 * through the TRANSFER plane's scheduler (see `transfer-origin.ts`), never the
 * control scheduler.  Chunking buys three things at once: bounded memory, a
 * resume granularity, and — the one that matters for P-021 — a bounded unit of
 * work, so a single 4GB transfer cannot hold a connection open indefinitely
 * even within its own plane.
 *
 * RESUME IS NOT AUTOMATIC WHEN THE HOST CANNOT DO IT.  If the host declares
 * `resumable: false`, an interrupted transfer fails loudly rather than
 * restarting from byte zero.  A silent restart is the expensive failure here:
 * on a slow link it looks like a transfer that is merely taking a long time,
 * while it is in fact re-sending the same bytes forever.  Making the caller
 * ask for a restart explicitly keeps that decision visible.
 */

import type { OriginScheduler } from '../polling/origin-scheduler';
import type { TransferPlane } from './transfer-origin';

export interface TransferChunk {
  index: number;
  /** Inclusive start byte. */
  start: number;
  /** Exclusive end byte. */
  end: number;
}

export class ChunkedTransferError extends Error {
  readonly code: 'not_resumable' | 'size_invalid' | 'chunk_failed' | 'aborted';
  readonly chunkIndex: number | null;

  constructor(code: ChunkedTransferError['code'], message: string, chunkIndex: number | null = null) {
    super(message);
    this.name = 'ChunkedTransferError';
    this.code = code;
    this.chunkIndex = chunkIndex;
  }
}

/**
 * Split a byte length into chunk descriptors.
 *
 * A zero-length transfer yields ONE empty chunk rather than none: an empty
 * file is a real thing to transfer, and returning an empty plan would make it
 * silently succeed without ever contacting the host.
 */
export function planChunks(totalBytes: number, chunkBytes: number): TransferChunk[] {
  if (!Number.isFinite(totalBytes) || totalBytes < 0) {
    throw new ChunkedTransferError('size_invalid', `totalBytes must be a non-negative number; received ${String(totalBytes)}`);
  }
  if (!Number.isFinite(chunkBytes) || chunkBytes < 1) {
    throw new ChunkedTransferError('size_invalid', `chunkBytes must be a positive number; received ${String(chunkBytes)}`);
  }

  const size = Math.floor(totalBytes);
  const step = Math.floor(chunkBytes);
  if (size === 0) return [{ index: 0, start: 0, end: 0 }];

  const chunks: TransferChunk[] = [];
  for (let start = 0, index = 0; start < size; start += step, index += 1) {
    chunks.push({ index, start, end: Math.min(start + step, size) });
  }
  return chunks;
}

export interface ChunkedTransferProgress {
  completedChunks: number;
  totalChunks: number;
  bytesTransferred: number;
  totalBytes: number;
}

export interface ChunkedTransferOptions {
  plane: TransferPlane;
  totalBytes: number;
  /** Transfer one chunk. Must reject to signal failure. */
  sendChunk: (chunk: TransferChunk, signal: AbortSignal) => Promise<void>;
  /**
   * Chunk indices already durably accepted by the host, from a previous
   * attempt. Supplying any requires `capability.resumable`.
   */
  completed?: Iterable<number>;
  onProgress?: (progress: ChunkedTransferProgress) => void;
  signal?: AbortSignal;
}

export interface ChunkedTransferResult {
  totalChunks: number;
  transferredChunks: number;
  skippedChunks: number;
  bytesTransferred: number;
  /** Every chunk index durably accepted — the resume cursor for a retry. */
  completed: number[];
}

/**
 * Run a chunked transfer over the transfer plane.
 *
 * Concurrency comes from the plane's scheduler, whose limit was sized from the
 * host's `maxConcurrentChunks`. We do not add a second limiter here: two
 * independent limiters over the same work is how an effective cap silently
 * becomes the product of both.
 *
 * On failure the error carries the failing chunk index and the `completed`
 * set is preserved on the thrown error's cause payload, so a caller can resume
 * rather than restart.
 */
export async function runChunkedTransfer(options: ChunkedTransferOptions): Promise<ChunkedTransferResult> {
  const { plane, totalBytes, sendChunk, onProgress, signal } = options;
  const capability = plane.capability;
  const scheduler: OriginScheduler = plane.scheduler;

  const completed = new Set<number>(options.completed ?? []);
  if (completed.size > 0 && !capability.resumable) {
    throw new ChunkedTransferError(
      'not_resumable',
      `host at ${plane.transferOrigin} declared resumable:false, so a prior partial transfer cannot be continued; restart it explicitly from an empty completed set`,
    );
  }

  const chunks = planChunks(totalBytes, capability.chunkBytes);
  const pending = chunks.filter((chunk) => !completed.has(chunk.index));

  let bytesTransferred = 0;
  for (const chunk of chunks) {
    if (completed.has(chunk.index)) bytesTransferred += chunk.end - chunk.start;
  }
  const skippedChunks = completed.size;

  const emit = () => {
    onProgress?.({
      completedChunks: completed.size,
      totalChunks: chunks.length,
      bytesTransferred,
      totalBytes: Math.floor(totalBytes),
    });
  };
  emit();

  await Promise.all(
    pending.map((chunk) =>
      scheduler.run(
        async (chunkSignal) => {
          await sendChunk(chunk, chunkSignal);
          completed.add(chunk.index);
          bytesTransferred += chunk.end - chunk.start;
          emit();
        },
        { class: 'bulk', signal, timeoutMs: 0 },
      ).catch((error: unknown) => {
        if (error instanceof ChunkedTransferError) throw error;
        const failure = new ChunkedTransferError(
          signal?.aborted ? 'aborted' : 'chunk_failed',
          `chunk ${chunk.index} (bytes ${chunk.start}-${chunk.end}) failed against ${plane.transferOrigin}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          chunk.index,
        );
        // Preserve the resume cursor: without it a caller has no way to
        // continue and is forced into the full restart this module exists to
        // avoid.
        (failure as { completed?: number[] }).completed = [...completed].sort((a, b) => a - b);
        throw failure;
      }),
    ),
  );

  return {
    totalChunks: chunks.length,
    transferredChunks: pending.length,
    skippedChunks,
    bytesTransferred,
    completed: [...completed].sort((a, b) => a - b),
  };
}
