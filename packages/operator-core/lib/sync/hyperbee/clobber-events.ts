/**
 * clobber-events — Phase 5b P-035.
 *
 * Plan: papercusp-dogfood-phase5b-hyperbee-ui-integration-2026-05-24.
 *
 * v5 D-012 — same-key Hyperbee conflicts resolve LWW by `(ts, writer_pubkey)`.
 * When a remote write *overrides* a local write within a short window
 * (default 60s), we emit a `clobber` event so the UI can toast the
 * user: "Your change to <field> on <row> was overridden by <contributor>."
 *
 * Mechanism (pure, in-process):
 *   1. `recordLocalWrite({ table, hbKey, ts, pubkey })` — caller invokes
 *      when they append a put op via the local Autobase. Stored in a
 *      bounded Map keyed by `<table>/<hbKey>`.
 *   2. `observeMergedOp({ table, hbKey, ts, pubkey })` — caller invokes
 *      from the projection writer (or wherever the substrate's merge
 *      apply path lives) for every op that lands in PG. If a recent
 *      local write exists for the same key AND the incoming op has a
 *      later (ts, pubkey) tuple AND the local write happened within
 *      the window — emit `clobber`.
 *   3. `on('clobber', listener)` — subscribers (the SSE projector that
 *      forwards to the UI, or unit tests) receive the typed event.
 *
 * Window default: 60s per the plan. Map size capped to avoid leaks
 * (FIFO eviction past N recent local writes per process).
 *
 * Pure: no PG, no substrate dependency, no I/O. Tests drive everything
 * via the public API.
 */

import { EventEmitter } from 'node:events';

export interface LocalWrite {
  table: string;
  hbKey: string;
  ts: number;
  pubkey: string;
}

export interface ClobberEvent {
  table: string;
  hbKey: string;
  /** The local write that was overridden. */
  my: LocalWrite;
  /** The incoming remote write that took precedence. */
  theirs: LocalWrite;
  /** Epoch ms when the clobber was emitted (close to `theirs.ts` for tests). */
  observedAt: number;
}

interface ClobberEvents {
  clobber: (ev: ClobberEvent) => void;
}

class TypedEmitter extends EventEmitter {
  on<K extends keyof ClobberEvents>(event: K, listener: ClobberEvents[K]): this {
    return super.on(event, listener as (...a: unknown[]) => void);
  }
  off<K extends keyof ClobberEvents>(event: K, listener: ClobberEvents[K]): this {
    return super.off(event, listener as (...a: unknown[]) => void);
  }
  emit<K extends keyof ClobberEvents>(event: K, ...args: Parameters<ClobberEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
}

export const clobberEvents = new TypedEmitter();

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 2048;

let windowMs = DEFAULT_WINDOW_MS;
let maxEntries = DEFAULT_MAX_ENTRIES;

const recent: Map<string, LocalWrite> = new Map();

let _nowImpl: () => number = () => Date.now();

/** Test seam. */
export function _setNowForTests(impl: () => number): void {
  _nowImpl = impl;
}

/** Test seam. */
export function _resetForTests(opts: { windowMs?: number; maxEntries?: number } = {}): void {
  recent.clear();
  clobberEvents.removeAllListeners();
  windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  _nowImpl = () => Date.now();
}

function key(table: string, hbKey: string): string {
  return `${table}/${hbKey}`;
}

function evictIfFull(): void {
  while (recent.size >= maxEntries) {
    const first = recent.keys().next().value;
    if (first === undefined) break;
    recent.delete(first);
  }
}

/**
 * Tuple comparison: `theirs > mine` iff `theirs.ts > mine.ts` OR
 * (equal ts AND theirs.pubkey > mine.pubkey lexically). Mirrors the LWW
 * predicate D-012 specifies.
 */
export function tupleGreater(a: LocalWrite, b: LocalWrite): boolean {
  if (a.ts !== b.ts) return a.ts > b.ts;
  return a.pubkey > b.pubkey;
}

/**
 * Caller invokes when they emit a local put op via Autobase.append.
 * Prunes any same-key entry older than the window before storing.
 */
export function recordLocalWrite(w: LocalWrite): void {
  evictIfFull();
  recent.set(key(w.table, w.hbKey), w);
}

/**
 * Caller invokes from the merge-apply path for every put op. Emits a
 * clobber when a recent local write exists for this key AND the incoming
 * tuple beats it AND the local write is within the window.
 *
 * Returns true if a clobber was emitted.
 */
export function observeMergedOp(incoming: LocalWrite): boolean {
  const k = key(incoming.table, incoming.hbKey);
  const mine = recent.get(k);
  if (!mine) return false;
  // Skip self-echoes (same pubkey).
  if (mine.pubkey === incoming.pubkey) return false;
  const now = _nowImpl();
  if (now - mine.ts > windowMs) {
    // Outside the window — drop the tracker entry so it doesn't pile up.
    recent.delete(k);
    return false;
  }
  if (!tupleGreater(incoming, mine)) return false;
  // Clobber.
  recent.delete(k); // Don't fire twice for the same local write.
  const ev: ClobberEvent = {
    table: incoming.table,
    hbKey: incoming.hbKey,
    my: mine,
    theirs: incoming,
    observedAt: now,
  };
  clobberEvents.emit('clobber', ev);
  return true;
}

/** Diagnostic: number of recent-local-write tracker entries. */
export function _trackerSizeForTests(): number {
  return recent.size;
}
