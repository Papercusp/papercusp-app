/**
 * In-process per-run chunk bus.
 *
 * Replaces the fs.watch + JSONL upstream for the agent-streaming SSE
 * pattern (HarnessDashboard's AgentThinkingPopover, PiPanel,
 * BranchActionRunner). The orchestrator subprocess POSTs each stdout
 * chunk to /api/internal/run-chunk; that handler calls publish() here;
 * the operator's existing SSE handler at /agents/<runId>/stream
 * subscribes via subscribe(). Pure in-memory fan-out — no DB, no
 * filesystem, sub-ms latency.
 *
 * Internals migrated to @papercusp/sse's getChannel (2026-05-11). Public
 * surface preserved verbatim:
 *   - publish(runId, seq, data) — caller-supplied seq (NOT bus-assigned)
 *   - closeChannel(runId) — fires done() + starts 5min GC
 *   - subscribe(runId, handler) — { recent, unsubscribe, whenDone, isClosed }
 *   - busStats(), _resetRunChunkBus() — diagnostics + tests
 *
 * Why caller-supplied seq: orchestrators that retry chunk delivery
 * across HTTP errors need a stable seq identifier independent of
 * arrival order at the bus. The previous bus passed seq through; this
 * one does the same. The channel's auto-id (id) is discarded.
 */
import { getChannel, _resetChannelsForTest, listChannels, dropChannel } from '@papercusp/sse';

export interface ChunkEnvelope {
  runId: string;
  seq: number;
  data: string;
  ts: number;
}

const CHANNEL_PREFIX = 'run-chunk:';
const CLOSED_CHANNEL_GC_MS = 5 * 60_000;

// Bus-level closed tracking. getChannel revives a GC-pending channel (resets
// isDone to false on re-fetch); that's the right semantic for HMR but the
// wrong one for our "publish after close is silently dropped" contract. We
// hold our own closed set so the bus's API stays sticky across re-fetch.
function closedKey(runId: string): string { return `${CHANNEL_PREFIX}${runId}`; }
function closedSet(): Set<string> {
  const g = globalThis as { __runChunkBusClosed__?: Set<string> };
  if (!g.__runChunkBusClosed__) g.__runChunkBusClosed__ = new Set();
  return g.__runChunkBusClosed__;
}

function getRunChannel(runId: string) {
  return getChannel<ChunkEnvelope>(`${CHANNEL_PREFIX}${runId}`, {
    ringSize: 64,
    gcDelayMs: CLOSED_CHANNEL_GC_MS,
  });
}

function isClosed(runId: string): boolean {
  return closedSet().has(closedKey(runId));
}

/** Publish one chunk to the run's channel. Caller's seq is preserved. */
export function publish(runId: string, seq: number, data: string): void {
  if (isClosed(runId)) {
    // Late publish after close — silently drop, matches prior behavior.
    return;
  }
  const ch = getRunChannel(runId);
  const env: ChunkEnvelope = { runId, seq, data, ts: Date.now() };
  ch.publish(env);
}

/** Mark the run as complete. Subscribers' whenDone resolves; 5min GC clock starts. */
export function closeChannel(runId: string): void {
  if (isClosed(runId)) return;
  const k = closedKey(runId);
  closedSet().add(k);
  const ch = getRunChannel(runId);
  ch.done();
  // Prune the bus-level closed marker once the underlying channel has been GC'd
  // (CLOSED_CHANNEL_GC_MS after done()). Without this the closed set grows one
  // entry per run for the life of the process — a slow but strictly-unbounded
  // leak under fleet load (EI-127, cluster #5). After GC the channel is gone, so
  // nothing is left for the marker to keep "sticky"; a (very rare) publish that
  // late just creates a fresh channel the idle reaper collects.
  const prune = setTimeout(() => closedSet().delete(k), CLOSED_CHANNEL_GC_MS + 1_000);
  if (typeof (prune as { unref?: () => void }).unref === 'function') {
    (prune as { unref: () => void }).unref();
  }
}

/** Subscribe to a run's chunk stream. */
export function subscribe(
  runId: string,
  handler: (env: ChunkEnvelope) => void,
): {
  recent: ChunkEnvelope[];
  unsubscribe: () => void;
  whenDone: Promise<void>;
  isClosed: () => boolean;
} {
  const ch = getRunChannel(runId);
  const recent = ch.recent.map((e) => e.event);
  let resolveDone!: () => void;
  const whenDone = new Promise<void>((r) => { resolveDone = r; });
  if (isClosed(runId)) {
    resolveDone();
  }
  const offPublish = ch.onPublish((item) => handler(item.event));
  const offDone = ch.onDone(() => resolveDone());

  return {
    recent,
    unsubscribe: () => {
      offPublish();
      offDone();
    },
    whenDone,
    isClosed: () => isClosed(runId),
  };
}

/** Test-only: drop all channels and reset bus-level closed state. */
export function _resetRunChunkBus(): void {
  closedSet().clear();
  _resetChannelsForTest();
}

/** Diagnostic: how many active channels + total subscribers. */
export function busStats(): { activeChannels: number; closedChannels: number; totalSubscribers: number } {
  let active = 0;
  let closed = 0;
  let subs = 0;
  for (const c of listChannels()) {
    if (!c.key.startsWith(CHANNEL_PREFIX)) continue;
    if (isClosed(c.key.slice(CHANNEL_PREFIX.length))) closed++;
    else active++;
    subs += c.syncHandlers;
  }
  return { activeChannels: active, closedChannels: closed, totalSubscribers: subs };
}
