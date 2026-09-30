/**
 * Desktop-performance instrumentation — page-relative interaction timings via
 * the User Timing API (performance.mark / performance.measure).
 *
 * WHY (EI-18128922194224210): measuring a real UI interaction by driving a
 * long-lived dev shell with `tauri-agent-tools eval` is unreliable —
 * performance.now() never resets across client navigations, so a wall-clock
 * delta captured from OUTSIDE the page is confounded (it reads 62s, 88s, … at
 * the "start" of the next eval, never a page-relative small number). A
 * `performance.measure` is PAGE-RELATIVE: its startTime + duration come from
 * the one monotonic timeline regardless of how long the page has been alive,
 * and it is readable BOTH from inside the app (the vitals recorder, via a
 * PerformanceObserver on 'measure') AND from a driver (via
 * performance.getEntriesByName). This module is the ONE place that names and
 * emits those measures, so the in-app desktop-performance suite and the
 * packaged-binary wdio runner read a single canonical timing source.
 *
 * Part of desktop-performance-suite-2026-07-20 (P-001). Dependency-free +
 * SSR-safe + never-throws: a begin/end on the real UI path must never break
 * the interaction it is timing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHERE TO PUT THE BEGIN — the one rule that makes or breaks a measure
 * ─────────────────────────────────────────────────────────────────────────
 * When begin and end live in DIFFERENT components (the usual shape: a parent
 * starts the interaction, the panel/child that loads ends it), the begin must
 * NOT go in a passive `useEffect`.
 *
 * React runs effects in phases, and within a phase CHILD BEFORE PARENT. A
 * child that settles on mount — the normal case when its data is already
 * cached — therefore runs its `endInteraction` BEFORE a passive parent begin.
 * Two failure modes follow, and both look like a working instrument:
 *
 *   1. GARBAGE MEASURE. The child consumes a start mark left dangling by an
 *      EARLIER interaction, so the measure spans however long the user sat on
 *      the previous view. Measured for real: a 15,289ms learning-view-switch
 *      against a 1500ms budget, where the true settle was ~1.3s
 *      (EI-19375505819043214). STALE_START_MS does not catch this — any dwell
 *      under 30s produces a plausible-looking breach.
 *   2. SILENT ZERO. With no start yet written, the child's end no-ops, then
 *      the begin writes a start nothing will ever consume — the interaction
 *      emits nothing at all, which reads as "never regressed".
 *
 * In preference order, begin from:
 *   - the EVENT HANDLER that triggers the interaction (a click). Best: it runs
 *     before any render, and it measures what the user actually waited for.
 *     See PlanDashboard's planPopupOpen.
 *   - `useLayoutEffect`, when the trigger is a state/URL change with no single
 *     handler. ALL layout effects run before ANY passive effect, so this is
 *     ordered against every child settle. See LearningTab's learningViewSwitch.
 *   - a passive `useEffect` ONLY when begin and end are in the SAME component,
 *     where declaration order governs and the trap cannot arise. See
 *     ChatPanel's conversationThreadLoad.
 *
 * The corollary binds settle points too: keep them PASSIVE. A panel that ends
 * an interaction in a layout effect re-opens the race against a layout begin.
 * LearningTab.perf-begin-order.test.tsx pins the ordering contract.
 */

/** The curated set of named interactions we budget + measure. Keep this small
 *  and intentional — one entry per user-perceived interaction worth a budget. */
export const PERF_INTERACTIONS = {
  /** Plans dashboard: "Open full plan" click → plan body rendered in Vditor.
   *  The "several seconds to load a plan" path (WI-5547); the measure spans
   *  click → the first Vditor.preview parse of the popup's plan body. */
  planPopupOpen: "plan-popup-open",
  /** Inbox command strip: Review decisions click → the grouped bulk report's
   *  first committed render. Guards the high-cardinality report-open path that
   *  previously hydrated the full attention feed before it could paint. */
  inboxBulkReportOpen: "inbox-bulk-report-open",
  /** Global command palette (⌘K/Ctrl+P): open toggle → the lazy cmdk+Radix
   *  chunk loads and the palette content first renders. First-open pays the
   *  dynamic-import cost, so this guards a regression in that chunk. */
  commandPaletteOpen: "command-palette-open",
  /** A conversation is opened (chatId set) → the agent_chats detail resolves
   *  and the thread transcript first renders. The "open a conversation and wait
   *  for it to load" path. */
  conversationThreadLoad: "conversation-thread-load",
  /** Harness dock (/adv, /workbench): mount → the dockview API binds after the
   *  PG layout hydrates and panels are created. Guards the dock-hydration cost. */
  harnessDockOpen: "harness-dock-open",
  /** Learning tab: a VIEW SWITCH (`?lview=` changes) → the newly-selected
   *  panel's primary read resolves and its content first renders.
   *
   *  WHY THIS EXISTS (EI-19375505819043214): the owner reported "the learning
   *  analyze took several seconds expanding the sections and just displayed
   *  loading artifacts". Every learning.* resolver measures <500ms on the live
   *  operator (the two behind this view, learning.analyze / learning.analyzeCycle,
   *  are ~25ms each), so the multi-second cost is CLIENT-side — and nothing
   *  measured it: this tab had no instrumented interaction at all, which is why
   *  the regression reached a human instead of reddening a check.
   *
   *  Deliberately ONE name for all learning views rather than one per view:
   *  endInteraction is measure-once and no-ops without a matching begin, so each
   *  panel can end the shared interaction on its own settle point and a view
   *  whose panel is not yet wired simply emits nothing (its stale start is
   *  discarded past STALE_START_MS) — never a garbage measure. */
  learningViewSwitch: "learning-view-switch",
} as const;

export type PerfInteractionName =
  (typeof PERF_INTERACTIONS)[keyof typeof PERF_INTERACTIONS];

/** A start mark older than this (ms) is STALE — a begin whose end never fired
 *  (e.g. the popup was closed before it rendered). endInteraction discards such
 *  a start instead of emitting a garbage multi-second measure against a much
 *  later, unrelated render on a shared code path. */
export const STALE_START_MS = 30_000;

const START_SUFFIX = ":start";

/** The User Timing surface, or null when unavailable (SSR / stripped env). */
function perf(): Performance | null {
  if (typeof performance === "undefined") return null;
  return typeof performance.mark === "function" &&
    typeof performance.measure === "function"
    ? performance
    : null;
}

function latestMeasureDuration(p: Performance, name: string): number | null {
  try {
    const entries = p.getEntriesByName(name, "measure");
    const last = entries[entries.length - 1];
    return last ? last.duration : null;
  } catch {
    return null;
  }
}

/**
 * Begin timing a named interaction. Records a `<name>:start` mark, replacing
 * any prior (unconsumed) start for the same name. Never throws.
 */
export function beginInteraction(name: PerfInteractionName | string): void {
  const p = perf();
  if (!p) return;
  try {
    p.clearMarks?.(name + START_SUFFIX);
    for (const entry of p.getEntriesByType('measure')) {
      if (entry.name.startsWith(`${name}:phase:`)) p.clearMeasures?.(entry.name);
    }
    p.mark(name + START_SUFFIX);
  } catch {
    /* never break the interaction we are trying to measure */
  }
}

/** Cumulative click-to-phase time; leaves the total interaction start intact.
 * First observation wins so background rerenders cannot overwrite first paint.
 * A new begin clears these diagnostics, keeping them bounded to one interaction.
 */
export function markInteractionPhase(name: string, phase: string): number | null {
  const p = perf();
  if (!p) return null;
  try {
    const starts = p.getEntriesByName(name + START_SUFFIX, 'mark');
    const start = starts[starts.length - 1];
    if (!start || p.now() - start.startTime > STALE_START_MS) return null;
    const phaseName = `${name}:phase:${phase}`;
    const previous = latestMeasureDuration(p, phaseName);
    if (previous !== null) return Math.round(previous);
    p.measure(phaseName, name + START_SUFFIX);
    const duration = latestMeasureDuration(p, phaseName);
    return duration === null ? null : Math.round(duration);
  } catch {
    return null;
  }
}

/**
 * End timing a named interaction: emit a `performance.measure` named `name`
 * from its start mark to now, then CONSUME the start mark (measure-once).
 * Returns the rounded duration in ms, or null when there was no fresh start.
 *
 * No-op + null when no matching start mark exists — so it is SAFE to call
 * unconditionally from a SHARED render path (only a matching beginInteraction
 * produces a measure; the other mount contexts of a shared component emit
 * nothing).
 */
export function endInteraction(
  name: PerfInteractionName | string,
): number | null {
  const p = perf();
  if (!p) return null;
  const startName = name + START_SUFFIX;
  try {
    const starts = p.getEntriesByName(startName, "mark");
    const start = starts[starts.length - 1];
    if (!start) return null;
    // Discard a stale start (a begin whose timely end never came).
    if (p.now() - start.startTime > STALE_START_MS) {
      p.clearMarks?.(startName);
      return null;
    }
    const measure = p.measure(name, startName);
    p.clearMarks?.(startName);
    const duration =
      measure && typeof (measure as PerformanceMeasure).duration === "number"
        ? (measure as PerformanceMeasure).duration
        : latestMeasureDuration(p, name);
    return typeof duration === "number" ? Math.round(duration) : null;
  } catch {
    return null;
  }
}

/**
 * Latest measured duration (ms) for a named interaction, or null. Lets the
 * packaged-binary wdio runner + unit tests read the timing synchronously
 * (via performance.getEntriesByName under the hood).
 */
export function getLatestMeasure(
  name: PerfInteractionName | string,
): number | null {
  const p = perf();
  if (!p) return null;
  const d = latestMeasureDuration(p, name);
  // Round at the public boundary so this matches endInteraction()'s return and
  // the recorder's stored duration (both Math.round the same measure).
  return d === null ? null : Math.round(d);
}

/** Drop any pending start mark for a name (the interaction was aborted). */
export function clearInteraction(name: PerfInteractionName | string): void {
  const p = perf();
  if (!p) return;
  try {
    p.clearMarks?.(name + START_SUFFIX);
  } catch {
    /* noop */
  }
}
