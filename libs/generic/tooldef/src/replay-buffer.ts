/**
 * Per-call replay ring buffer for streaming tools. Phase 4 T2.2.
 *
 * When a tool declares `replayBufferSize > 0`, the dispatcher pushes
 * each emitted event into a bounded ring buffer keyed on
 * `(workspaceId, toolName, runId)`. A reconnecting client sending
 * `Last-Event-ID + X-Papercusp-Run-Id` headers retrieves the buffered
 * tail and resumes; the cold sink then stays open if the tool is
 * still streaming, or closes immediately if the original call
 * already terminated.
 *
 * Disconnect semantics: tool ABORTS on disconnect (the dispatcher's
 * existing abort-on-signal behavior). Replay serves only events
 * captured BEFORE the disconnect; the "long-lived disconnected
 * tools" model is deferred to T4.3 of the plan.
 *
 * Lifetime: buffer survives in memory for `BUFFER_TTL_MS` (5 min by
 * default) past stream-end. Cleared on workspace switch via
 * `clearAllBuffers()` (called by the workspace-registry change
 * handler). Cross-process buffers (PG-backed) are out of scope.
 *
 * Plan ref: phase-4-endpoint-system-2026-05-12.md § T2.2.
 */

import { pinModuleState } from '@papercusp/module-singleton';
import { onWorkspaceSwitch } from './workspace-lifecycle';

const BUFFER_TTL_MS = 5 * 60 * 1000;
/**
 * Garbage-collection scan interval. Drops every buffer past its TTL.
 * Doesn't need to be tight — buffers self-skip on read when expired.
 */
const GC_INTERVAL_MS = 60 * 1000;

export interface BufferedEvent {
  /** SSE id allocated by the wire layer. Dispatcher tracks its own
   *  monotonic counter that mirrors the sink's allocator — they're
   *  in lockstep because the dispatcher's wrapped emit is the only
   *  source of `sink.event()` calls during the stream. */
  id: number;
  name: string;
  data: unknown;
}

interface BufferEntry {
  events: BufferedEvent[];
  capacity: number;
  evicted: number;
  /** Wall-clock ms of latest mutation (used by GC; bumped on every
   *  push). Used in lieu of a stream-end timestamp because some
   *  consumers might keep emitting after the dispatcher exits its
   *  emit path. */
  lastActiveMs: number;
}

type BufferKey = string;

function key(workspaceId: string, toolName: string, runId: string): BufferKey {
  return `${workspaceId}:${toolName}:${runId}`;
}

/**
 * Stash buffers on globalThis so HMR / module re-imports don't lose
 * them mid-stream. Same pattern as other in-process state in this
 * codebase (e.g. the schema-ensure flags).
 */
/**
 * The pin key — also the id this module reports under in
 * `listModuleDuplications()`, so a split here shows up in the REALM-WIDE report
 * rather than only through this module's own accessor. Unchanged from the
 * `Symbol.for(...)` description used before the migration (EI-19479108855357092).
 */
const STATE_KEY = 'papercusp.replayBufferRegistry';

interface ReplayBufferState {
  buffers: Map<BufferKey, BufferEntry>;
  gcTimer: ReturnType<typeof setInterval> | null;
  lifecycleSubscribed: boolean;
}

/**
 * Pinned + counted rather than hand-rolled: a hand-rolled
 * `globalThis[Symbol.for(...)]` slot is equally correct and completely invisible
 * to `listModuleDuplications()`. Must stay at module scope. Lifecycle
 * subscription stays lazy in `registry()` — only the data is eager.
 */
const state = pinModuleState<ReplayBufferState>(STATE_KEY, () => ({
  buffers: new Map(),
  gcTimer: null,
  lifecycleSubscribed: false,
}));

function registry() {
  const r = state;
  if (!r.lifecycleSubscribed) {
    onWorkspaceSwitch((wid) => clearRingBuffersForWorkspaceSwitch(wid));
    r.lifecycleSubscribed = true;
  }
  return r;
}

function ensureGc(): void {
  const r = registry();
  if (r.gcTimer) return;
  r.gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of r.buffers) {
      if (now - entry.lastActiveMs > BUFFER_TTL_MS) {
        r.buffers.delete(k);
      }
    }
  }, GC_INTERVAL_MS);
  // Don't keep the process alive just to GC buffers.
  if (typeof r.gcTimer.unref === 'function') r.gcTimer.unref();
}

/**
 * Create (or fetch existing) buffer for a call. Returns a writer
 * the dispatcher uses to push events. Idempotent: calling twice
 * with the same key returns the same entry — useful if a tool
 * call is somehow re-entered (shouldn't happen, but defensive).
 */
export function openBuffer(opts: {
  workspaceId: string;
  toolName: string;
  runId: string;
  capacity: number;
  /** Called when an event is evicted (capacity hit). Caller decides
   *  whether to warn-log; the buffer is silent. */
  onEvict?: (event: BufferedEvent) => void;
}): {
  push: (event: BufferedEvent) => void;
  count: () => number;
} {
  ensureGc();
  const r = registry();
  const k = key(opts.workspaceId, opts.toolName, opts.runId);
  let entry = r.buffers.get(k);
  if (!entry) {
    entry = {
      events: [],
      capacity: Math.max(1, opts.capacity),
      evicted: 0,
      lastActiveMs: Date.now(),
    };
    r.buffers.set(k, entry);
  }
  return {
    push(ev) {
      entry!.events.push(ev);
      entry!.lastActiveMs = Date.now();
      while (entry!.events.length > entry!.capacity) {
        const dropped = entry!.events.shift()!;
        entry!.evicted += 1;
        opts.onEvict?.(dropped);
      }
    },
    count() {
      return entry!.events.length;
    },
  };
}

/** The writer handle `openBuffer` returns — the dispatcher pushes events to it. */
export type ReplayBufferWriter = ReturnType<typeof openBuffer>;

/**
 * Fetch buffered events with id > sinceId for replay. Returns null
 * if no buffer exists for the key (or it's expired). Empty array if
 * the buffer exists but has nothing past sinceId.
 *
 * Touches `lastActiveMs` so a reconnect extends the buffer's life
 * past the next GC sweep — buffers stay warm while consumers are
 * actively reconnecting.
 */
export function readBuffer(opts: {
  workspaceId: string;
  toolName: string;
  runId: string;
  sinceId: number;
}): BufferedEvent[] | null {
  const r = registry();
  const k = key(opts.workspaceId, opts.toolName, opts.runId);
  const entry = r.buffers.get(k);
  if (!entry) return null;
  if (Date.now() - entry.lastActiveMs > BUFFER_TTL_MS) {
    r.buffers.delete(k);
    return null;
  }
  entry.lastActiveMs = Date.now();
  return entry.events.filter((e) => e.id > opts.sinceId);
}

/**
 * Drop the buffer for a specific call. Used by the dispatcher when
 * the call finishes cleanly + the result has been seen (no expected
 * reconnect). Not strictly necessary — GC would clean up — but
 * trims peak memory.
 */
export function closeBuffer(opts: {
  workspaceId: string;
  toolName: string;
  runId: string;
}): void {
  const r = registry();
  r.buffers.delete(key(opts.workspaceId, opts.toolName, opts.runId));
}

/**
 * Clear every buffer scoped to a specific workspace. Subscribed via
 * onWorkspaceSwitch so a workspace switch can't see the prior
 * workspace's tail. Buffer keys are `${workspaceId}:${tool}:${runId}`
 * so we match on the prefix.
 */
export function clearRingBuffersForWorkspaceSwitch(workspaceId: string): void {
  const r = registry();
  const prefix = `${workspaceId}:`;
  for (const k of r.buffers.keys()) {
    if (k.startsWith(prefix)) r.buffers.delete(k);
  }
}

/**
 * Test-only: clear every buffer in every workspace. Use
 * `clearRingBuffersForWorkspaceSwitch(id)` from production code.
 */
export function clearAllBuffersForTests(): void {
  const r = registry();
  r.buffers.clear();
}

/** Public — read-only stats for /dev telemetry. */
export function replayBufferStats(): {
  bufferCount: number;
  totalEvents: number;
  totalEvicted: number;
} {
  const r = registry();
  let totalEvents = 0;
  let totalEvicted = 0;
  for (const entry of r.buffers.values()) {
    totalEvents += entry.events.length;
    totalEvicted += entry.evicted;
  }
  return { bufferCount: r.buffers.size, totalEvents, totalEvicted };
}
