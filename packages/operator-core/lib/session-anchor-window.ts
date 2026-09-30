/**
 * session-anchor-window.ts — pure, memory-bounded "jump to the match" window
 * selection for the session-thinking stream (agents-pill-inactive-search-
 * 2026-07-09 P-005).
 *
 * A transcript-search hit deep-links into /api/adv/session/thinking with
 * `find=<term>` (+ optionally `anchorTs`). Instead of the last-1MiB TAIL
 * backfill, the route streams the WHOLE transcript through this collector,
 * which selects a window of entries AROUND the matched entry:
 *
 *   * with `anchorTs`: the FIRST term-matching entry at/after that timestamp
 *     (the searched turn) — `done` flips once the trailing context is
 *     gathered, so the caller can stop reading a huge transcript early.
 *     Matches BEFORE the anchor are kept as a fallback (last one wins) in
 *     case the anchored turn text was truncated/redacted at ingest.
 *   * without `anchorTs`: the LAST term-matching entry in the file (recency
 *     bias, matching the search's newest-first ordering) — a full scan, but
 *     memory stays bounded (only the current window region is retained).
 *
 * Pure + incremental (`push(entry)` in file order, then `result()`), so it
 * unit-tests without files or SSE.
 */

import type { AgentTimelineEntry } from './endpoint-route/routes/harness/streams';

export interface AnchorWindowOpts {
  /** Case-insensitive substring to anchor on (the search term). */
  find: string;
  /** ISO timestamp of the searched turn — anchor at the first match at/after it. */
  anchorTs?: string | null;
  /** Context entries kept BEFORE the match (default 100). */
  before?: number;
  /** Context entries kept AFTER the match (default 80). */
  after?: number;
}

export interface AnchorWindowResult {
  entries: AgentTimelineEntry[];
  /** Index of the matched entry within `entries`. */
  anchorIndex: number;
}

/** Whether an entry's visible content contains the term (case-insensitive).
 *  Checks the rendered surfaces: text, tool name, and the tool input JSON.
 *  Pure — exported for tests. */
export function entryMatches(e: AgentTimelineEntry, termLc: string): boolean {
  if (!termLc) return false;
  if (typeof e.text === 'string' && e.text.toLowerCase().includes(termLc)) return true;
  if (typeof e.toolName === 'string' && e.toolName.toLowerCase().includes(termLc)) return true;
  if (e.toolInput !== undefined) {
    try {
      const s = JSON.stringify(e.toolInput);
      if (s && s.toLowerCase().includes(termLc)) return true;
    } catch { /* unstringifiable input never matches */ }
  }
  return false;
}

export class AnchorWindowCollector {
  private readonly termLc: string;
  private readonly anchorMs: number | null;
  private readonly before: number;
  private readonly after: number;

  /** Sliding buffer of recent entries; compacted so it never grows unbounded. */
  private ring: AgentTimelineEntry[] = [];
  /** Index (within `ring`) of the current open match; -1 = none open. */
  private pendingIdx = -1;
  /** Entries seen after the open match so far. */
  private afterCount = 0;
  /** The latest fully-captured window (a later match overwrites it). */
  private captured: AnchorWindowResult | null = null;
  /** True once the caller may stop feeding entries (anchorTs mode only). */
  private stopped = false;

  constructor(opts: AnchorWindowOpts) {
    this.termLc = opts.find.toLowerCase();
    const t = opts.anchorTs ? Date.parse(opts.anchorTs) : NaN;
    this.anchorMs = Number.isNaN(t) ? null : t;
    this.before = Math.max(0, opts.before ?? 100);
    this.after = Math.max(0, opts.after ?? 80);
  }

  /** True once the window is complete and the caller may stop reading the file
   *  (only in anchorTs mode — otherwise the LAST match needs a full scan). */
  get done(): boolean {
    return this.stopped;
  }

  private atOrAfterAnchor(e: AgentTimelineEntry): boolean {
    if (this.anchorMs === null) return true;
    if (!e.ts) return false;
    const t = Date.parse(e.ts);
    return !Number.isNaN(t) && t >= this.anchorMs;
  }

  /** Freeze the open match's window into `captured` and close it. Returns
   *  whether that match was at/after the anchor (the early-stop signal). */
  private captureOpen(): boolean {
    const start = Math.max(0, this.pendingIdx - this.before);
    const end = Math.min(this.ring.length, this.pendingIdx + this.after + 1);
    this.captured = {
      entries: this.ring.slice(start, end),
      anchorIndex: this.pendingIdx - start,
    };
    const atOrAfter = this.atOrAfterAnchor(this.ring[this.pendingIdx]);
    this.pendingIdx = -1;
    this.afterCount = 0;
    return atOrAfter;
  }

  push(e: AgentTimelineEntry): void {
    if (this.stopped) return;
    this.ring.push(e);
    if (this.pendingIdx >= 0) this.afterCount += 1;

    if (entryMatches(e, this.termLc)) {
      // Take this match as the open anchor UNLESS one at/after the anchor
      // timestamp is already locked (anchorTs mode wants the FIRST such match;
      // everywhere else, last match wins).
      const lockedAtOrAfter =
        this.pendingIdx >= 0 && this.anchorMs !== null && this.atOrAfterAnchor(this.ring[this.pendingIdx]);
      if (!lockedAtOrAfter) {
        this.pendingIdx = this.ring.length - 1;
        this.afterCount = 0;
      }
    }

    // Trailing context complete → freeze the window. In anchorTs mode an
    // at/after-anchor capture ends the scan; otherwise keep scanning — a later
    // match simply overwrites the capture.
    if (this.pendingIdx >= 0 && this.afterCount >= this.after) {
      const atOrAfter = this.captureOpen();
      if (this.anchorMs !== null && atOrAfter) {
        this.stopped = true;
        return;
      }
    }

    // Compact the leading slack: entries more than `before` behind the open
    // match (or behind the buffer head when none is open) can never appear in
    // a future window. Batched (compact only past `before` of slack) so the
    // slice cost is amortized O(1) per push.
    const keepFrom = this.pendingIdx >= 0
      ? Math.max(0, this.pendingIdx - this.before)
      : Math.max(0, this.ring.length - this.before);
    if (keepFrom > this.before) {
      this.ring = this.ring.slice(keepFrom);
      if (this.pendingIdx >= 0) this.pendingIdx -= keepFrom;
    }
  }

  /** The selected window, or null when no entry matched the term. */
  result(): AnchorWindowResult | null {
    if (this.pendingIdx >= 0) this.captureOpen(); // EOF: partial trailing context is fine
    return this.captured;
  }
}
