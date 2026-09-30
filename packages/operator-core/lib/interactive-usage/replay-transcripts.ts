/** Read-only, bounded replay for historical reconciliation. No ledger writes or watermarks. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { costFromTokens } from '@papercusp/model-pricing';
import type { TranscriptAdapter } from './ingest-adapters';
import {
  mergeTranscriptUsage,
  type TranscriptParserState,
  type TranscriptUsageEvent,
} from './ingest-claude-transcripts';

export interface ReplayOptions {
  filePath: string;
  /** The existing committed byte frontier, NOT the file's current EOF. */
  byteOffset: number;
  adapter: Pick<TranscriptAdapter, 'name' | 'parse'>;
  chunkBytes?: number;
  maxRequests?: number;
}

export interface ReplayRequest extends TranscriptUsageEvent {
  /** Same identity as incremental ingestion, resolved to an absolute byte position. */
  byteOffset: number;
}

export interface ReplayInventory {
  requests: number;
  eventTimeKnown: number;
  writeCountKnown: number;
  uncachedInputKnown: number;
  pricedRequests: number;
  inputTotalKnown: number;
  inputTotalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokensLowerBound: number;
  uncachedInputTokensLowerBound: number;
  outputTokens: number;
  cacheWrite1hTokensLowerBound: number;
  cacheWrite5mTokensLowerBound: number;
  estimatedUsd: number | null;
}

export type TranscriptReplay = {
  status: 'available';
  sourceLocation: 'filesystem' | 'archive';
  filePath: string;
  byteOffset: number;
  sourceSha256: string;
  parserState: TranscriptParserState;
  repeatedObservations: number;
  events: ReplayRequest[];
  models: Record<string, ReplayInventory>;
} | {
  status: 'unavailable';
  filePath: string;
  byteOffset: number;
  reason: 'missing' | 'truncated' | 'changed' | 'incomplete-frontier' | 'line-too-large' | 'request-limit' | 'unsupported-adapter';
};

const emptyInventory = (): ReplayInventory => ({
  requests: 0, eventTimeKnown: 0, writeCountKnown: 0, uncachedInputKnown: 0,
  pricedRequests: 0, inputTotalKnown: 0, inputTotalTokens: 0, cacheReadTokens: 0,
  cacheWriteTokensLowerBound: 0, uncachedInputTokensLowerBound: 0, outputTokens: 0,
  cacheWrite1hTokensLowerBound: 0, cacheWrite5mTokensLowerBound: 0, estimatedUsd: 0,
});

/** Merge streaming observations across chunk boundaries, as the live ledger does. */
function mergeEvent(previous: ReplayRequest, event: ReplayRequest): ReplayRequest {
  const inputKnown = previous.uncachedInputKnown !== false || event.uncachedInputKnown !== false;
  const usage = mergeTranscriptUsage(previous.usage, event.usage);
  if (event.uncachedInputKnown === false && previous.uncachedInputKnown !== false) {
    usage.inputTokens = previous.usage.inputTokens;
  } else if (previous.uncachedInputKnown === false && event.uncachedInputKnown !== false) {
    usage.inputTokens = event.usage.inputTokens;
  }
  return { ...previous, ...event, usage, uncachedInputKnown: inputKnown,
    byteOffset: previous.byteOffset, eventTime: previous.eventTime ?? event.eventTime,
    inputTotalTokens: event.inputTotalTokens ?? previous.inputTotalTokens };
}

/** Read the existing archive without restoring files into a native client's home.
 * An archive that exists but cannot be verified is an error, never proof of absence. */
export async function readArchivedTranscriptSource(filePath: string, sourceKind?: string): Promise<Buffer | null> {
  if (!filePath.endsWith('.jsonl')) return null;
  const { codexSessionIdForFile } = await import('./ingest-adapters');
  const { pgSessionArchiveStore, decompressArchiveBlobBounded, isUnsafeArchiveRelpath, sha256Hex } =
    await import('../session-archive');
  const sessionId = codexSessionIdForFile(filePath);
  const store = pgSessionArchiveStore();
  const kinds = sourceKind ? [sourceKind] : ['codex', 'claude', 'omp'];
  const maxBytes = 64 * 1024 * 1024;
  for (const kind of kinds) {
    const stamp = await store.readStamp(kind, sessionId);
    if (!stamp) continue;
    if (![stamp.bytes_raw, stamp.bytes_stored].every(n => Number.isSafeInteger(n) && n >= 0 && n <= maxBytes)) {
      throw new Error('Archive exceeds the bounded historical replay limit');
    }
    const entries = stamp.manifest.filter(entry => !isUnsafeArchiveRelpath(entry.relpath) &&
      path.resolve(stamp.session_root, entry.relpath) === path.resolve(filePath));
    if (entries.length !== 1) throw new Error('Archive does not identify one exact historical source path');
    const entry = entries[0];
    const rows = (await store.readFiles(kind, sessionId)).filter(row => row.relpath === entry.relpath);
    if (rows.length !== 1 || rows[0].sha256 !== entry.sha256 || rows[0].bytes_raw !== entry.bytes_raw) {
      throw new Error('Archive file and manifest disagree for historical source');
    }
    const raw = await decompressArchiveBlobBounded(rows[0], maxBytes);
    if (raw.length !== entry.bytes_raw || sha256Hex(raw) !== entry.sha256) {
      throw new Error('Archive historical source length or digest verification failed');
    }
    return raw;
  }
  return null;
}

/**
 * Reuse the production parsers from byte zero, preserving their state between chunks.
 * A missing/unreplayable source produces no invented observations. The digest covers
 * exactly the selected prefix; an eventual apply MUST revalidate it and the ledger
 * frontier under its transaction fence. Append-only growth beyond it is excluded.
 */
export async function replayTranscriptPrefix(options: ReplayOptions): Promise<TranscriptReplay> {
  const { filePath, byteOffset, adapter } = options;
  const chunkBytes = options.chunkBytes ?? 32 * 1024 * 1024;
  const maxRequests = options.maxRequests ?? 100_000;
  for (const [name, value, minimum] of [['byteOffset', byteOffset, 0], ['chunkBytes', chunkBytes, 1],
    ['maxRequests', maxRequests, 1]] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
  }
  const unavailable = (reason: Extract<TranscriptReplay, { status: 'unavailable' }>['reason']): TranscriptReplay =>
    ({ status: 'unavailable', filePath, byteOffset, reason });
  let handle;
  let archived: Buffer | null = null;
  try { handle = await fs.open(filePath, 'r'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    archived = await readArchivedTranscriptSource(filePath, adapter.name);
    if (!archived) return unavailable('missing');
  }
  try {
    const initial = handle ? await handle.stat() : null;
    if ((initial?.size ?? archived!.length) < byteOffset) return unavailable('truncated');
    const digest = createHash('sha256');
    const requests = new Map<string, ReplayRequest>();
    let parserState: TranscriptParserState = {};
    let offset = 0;
    let repeatedObservations = 0;
    while (offset < byteOffset) {
      const buffer = Buffer.alloc(Math.min(chunkBytes, byteOffset - offset));
      const bytesRead = handle ? (await handle.read(buffer, 0, buffer.length, offset)).bytesRead
        : archived!.copy(buffer, 0, offset, offset + buffer.length);
      if (!bytesRead) return unavailable('truncated');
      // Cut on a byte-level newline BEFORE decoding; never split a UTF-8 code point.
      const end = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1;
      if (!end) return unavailable(offset + bytesRead === byteOffset ? 'incomplete-frontier' : 'line-too-large');
      const chunk = buffer.subarray(0, end);
      const parsed = adapter.parse(chunk.toString('utf8'), parserState);
      if (!parsed.events || parsed.consumedBytes !== end) return unavailable('unsupported-adapter');
      digest.update(chunk);
      for (const event of parsed.events) {
        const sourceId = event.sourceId.startsWith('line:') ? `line:${offset + event.relativeOffset}` : event.sourceId;
        const identity = JSON.stringify([event.model, sourceId]);
        const resolved = { ...event, sourceId, byteOffset: offset + event.relativeOffset };
        const previous = requests.get(identity);
        if (previous) repeatedObservations++;
        requests.set(identity, previous ? mergeEvent(previous, resolved) : resolved);
        if (requests.size > maxRequests) return unavailable('request-limit');
      }
      parserState = parsed.parserState ?? parserState;
      offset += end;
    }
    if (initial) {
      const final = await fs.stat(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!final || initial.ino !== final.ino || initial.dev !== final.dev || final.size < byteOffset ||
        (initial.size === final.size && initial.mtimeMs !== final.mtimeMs)) return unavailable('changed');
    }
    // Model ids are source data, not object properties (e.g. "constructor").
    const models: Record<string, ReplayInventory> = Object.create(null);
    for (const event of requests.values()) {
      const { model, usage } = event;
      const row = models[model] ??= emptyInventory();
      const inputKnown = event.uncachedInputKnown !== false;
      const total = event.inputTotalTokens ?? (inputKnown && !usage.cacheCreationUnreported
        ? usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens : null);
      const cost = costFromTokens(model, { ...usage, requestInputTokens: total ?? undefined });
      row.requests++;
      row.eventTimeKnown += Number(event.eventTime !== null);
      row.writeCountKnown += Number(!usage.cacheCreationUnreported);
      row.uncachedInputKnown += Number(inputKnown);
      row.pricedRequests += Number(cost.priced);
      row.inputTotalKnown += Number(total !== null);
      row.inputTotalTokens += total ?? 0;
      row.cacheReadTokens += usage.cacheReadTokens;
      row.cacheWriteTokensLowerBound += usage.cacheCreationTokens;
      row.uncachedInputTokensLowerBound += inputKnown ? usage.inputTokens : 0;
      row.outputTokens += usage.outputTokens;
      row.cacheWrite1hTokensLowerBound += usage.cacheCreation1hTokens ?? 0;
      row.cacheWrite5mTokensLowerBound += usage.cacheCreation5mTokens ?? 0;
      row.estimatedUsd = row.estimatedUsd !== null && cost.priced ? row.estimatedUsd + cost.usd : null;
    }
    return { status: 'available', sourceLocation: archived ? 'archive' : 'filesystem', filePath, byteOffset, sourceSha256: digest.digest('hex'),
      parserState, repeatedObservations, events: [...requests.values()], models };
  } finally { await handle?.close(); }
}
