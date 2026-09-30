/**
 * Coarse / debounced cache invalidation for the APPEND-HEAVY log family
 * (cache-expensive-tool-reads-2026-06-22 P-008 / D-006).
 *
 * THE PROBLEM. The cache↔change-stream ECA bumps a table's tag on every
 * `<table>.changed` event. For a normal table that is fine (writes are sparse).
 * But the append-heavy log tables fire `.changed` on EVERY append —
 * `coord_event_log` alone emits one per coordination event (mig 275) — so a
 * `getOrSet` entry tagged with such a table would be invalidated continuously:
 * ~0 hit-rate, no benefit. That is exactly why coord:inbox caching was deferred
 * (D-006).
 *
 * THE FIX. Route invalidation for the append-heavy tables through a LEADING +
 * TRAILING debounce per (workspaceId, tag): the FIRST bump after a quiet period
 * fires immediately (so a consumer sees a fresh value promptly), then further
 * bumps within `windowMs` are COALESCED into a single trailing bump at the window
 * end. Under sustained traffic that collapses an unbounded storm into at most one
 * bump per window, so a cache entry tagged with the table survives the storm and
 * is at most ~`windowMs` stale. Non-append-heavy tags are unaffected (bumped
 * immediately, exactly as before).
 *
 * Only the TABLE-level tag is debounced. The per-row `<table>:<id>` tags for these
 * log tables are useless (every append is a brand-new row id no one caches), so
 * they are dropped — never bumped — to avoid generation-store churn.
 */

import type { Cache } from "@papercusp/cache";
import { pinModuleState } from "@papercusp/module-singleton";

/**
 * The append-heavy log tables whose per-event `.changed` bump must be debounced
 * (cache-expensive-tool-reads P-008). `coord_event_log` is the one with a live
 * `.changed` trigger today (mig 275); the rest are listed so that if/when they
 * gain the generic trigger they are coarsened automatically rather than
 * silently tanking some future consumer's hit-rate.
 */
export const APPEND_HEAVY_TABLES: ReadonlySet<string> = new Set<string>([
  "coord_event_log",
  "audit_log",
  "agent_runs_consolidated",
  "user_actions",
  "harness_hook_logs",
  "toast_log",
  "feature_audit_consolidated",
  // WI-6182: one row per governed model call. The append-heavy detector emits
  // a coalesced table event; cache invalidation must stay on the same path.
  "agent_usage_samples",
]);

/** Default coalescing window — bounds worst-case staleness for a debounced tag. */
export const DEFAULT_DEBOUNCE_WINDOW_MS = 4_000;

/** Is `tag` (a table tag or `<table>:<id>` row tag) for an append-heavy log table? */
export function tableOfTag(tag: string): string {
  const colon = tag.indexOf(":");
  return colon >= 0 ? tag.slice(0, colon) : tag;
}

export function isAppendHeavyTag(tag: string): boolean {
  return APPEND_HEAVY_TABLES.has(tableOfTag(tag));
}

/** Injectable scheduler seam (tests use fake timers / a manual driver). */
export interface DebounceScheduler {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const realScheduler: DebounceScheduler = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const SEP = "\x00";

/**
 * A leading+trailing debouncer that coalesces `invalidateByTags` bumps per
 * (workspaceId, tag). Holds NO cache reference — the caller passes the Cache on
 * each bump, so the singleton can be swapped under tests.
 */
export class TagBumpDebouncer {
  private readonly windowMs: number;
  private readonly sched: DebounceScheduler;
  /** key = ws\0tag → { trailing: a bump arrived during the window, timer } */
  private readonly windows = new Map<
    string,
    { trailing: boolean; timer: unknown }
  >();

  constructor(opts: { windowMs?: number; scheduler?: DebounceScheduler } = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_DEBOUNCE_WINDOW_MS;
    this.sched = opts.scheduler ?? realScheduler;
  }

  /** Debounced bump of ONE (workspaceId, tag). Leading edge fires immediately. */
  bump(cache: Cache, workspaceId: string, tag: string): void {
    const key = workspaceId + SEP + tag;
    const w = this.windows.get(key);
    if (!w) {
      // Leading edge: bump now, open a window.
      cache.invalidateByTags(workspaceId, [tag]);
      const entry: { trailing: boolean; timer: unknown } = {
        trailing: false,
        timer: null,
      };
      entry.timer = this.sched.setTimer(
        () => this.onWindowEnd(cache, workspaceId, tag, key),
        this.windowMs,
      );
      this.windows.set(key, entry);
      return;
    }
    // Within the window: coalesce — remember a bump happened so the trailing edge fires.
    w.trailing = true;
  }

  private onWindowEnd(
    cache: Cache,
    workspaceId: string,
    tag: string,
    key: string,
  ): void {
    const w = this.windows.get(key);
    if (!w) return;
    if (w.trailing) {
      // Activity during the window → trailing bump + keep the window open (still busy).
      cache.invalidateByTags(workspaceId, [tag]);
      w.trailing = false;
      w.timer = this.sched.setTimer(
        () => this.onWindowEnd(cache, workspaceId, tag, key),
        this.windowMs,
      );
    } else {
      // Quiet window → close it; the next bump starts fresh with a leading edge.
      this.windows.delete(key);
    }
  }

  /** Test-only: cancel all pending windows. */
  resetForTests(): void {
    for (const w of this.windows.values()) this.sched.clearTimer(w.timer);
    this.windows.clear();
  }
}

// Process-wide singleton (the cache-ECA bump path uses it), realm-pinned so the
// tsx runtime and a vitest module graph share one debouncer — matching the
// operator-cache singleton's own pinning. Pinned through
// @papercusp/module-singleton rather than a hand-rolled `globalThis[key]` pair:
// hand-rolling shares correctly but is invisible to listModuleDuplications(),
// which then answers a confident `[]` while this module is split
// (EI-19479108855357092).
const __state = pinModuleState<{ debouncer: TagBumpDebouncer | null }>(
  '@papercusp/operator-core.tagBumpDebouncer',
  () => ({ debouncer: null }),
);

export function getTagBumpDebouncer(): TagBumpDebouncer {
  if (!__state.debouncer) __state.debouncer = new TagBumpDebouncer();
  return __state.debouncer;
}

/** Test seam: install a debouncer (e.g. with a fake scheduler / short window). */
export function setTagBumpDebouncerForTests(d: TagBumpDebouncer | null): void {
  __state.debouncer = d;
}

/**
 * Invalidate `tags` on `cache`, COALESCING the append-heavy log tables through the
 * debouncer and bumping everything else immediately. This is the one entry point
 * the cache-ECA built-in action calls instead of `cache.invalidateByTags`.
 *
 * - Append-heavy tags → only the TABLE tag is debounced; `<table>:<id>` row tags
 *   for these are dropped (no one caches per-row for an append-only log).
 * - Normal tags → bumped immediately (unchanged behaviour).
 */
export function coalescedInvalidateByTags(
  cache: Cache,
  workspaceId: string,
  tags: readonly string[],
): void {
  if (tags.length === 0) return;
  const immediate: string[] = [];
  const debouncedTables = new Set<string>();
  for (const tag of tags) {
    if (isAppendHeavyTag(tag)) debouncedTables.add(tableOfTag(tag));
    else immediate.push(tag);
  }
  if (immediate.length > 0) cache.invalidateByTags(workspaceId, immediate);
  if (debouncedTables.size > 0) {
    const deb = getTagBumpDebouncer();
    for (const table of debouncedTables) deb.bump(cache, workspaceId, table);
  }
}
