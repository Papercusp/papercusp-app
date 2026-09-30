/**
 * inventory-shared — the CLIENT-SAFE slice of the task inventory read model.
 *
 * WHY THIS FILE EXISTS (WI-8191): `use-resource-totals.ts` is a `'use client'` hook that
 * needs exactly two things from the inventory model — the `TaskResourceTotals` shape and
 * the pure `cpuBusyPercent()` derivation. Importing the FUNCTION (a value, not a type) from
 * `./inventory` dragged that module's whole top-level graph — `./store`, `./reconcile-tick`,
 * `./scan`, `../agent-tools/docs/_repo-paths` — into the SPA's browser-eager import graph.
 * On the :3055 Vite dev graph there is no tree-shaking and `node:` builtins resolve to stubs
 * that THROW on property access, so the module evaluates and throws at module-init and the
 * route white-screens. That is a recurring class here, not a one-off (WI-5454 hit it via
 * knowledge-packs/candidates.ts), and `no-server-leak-in-client-graph.test.ts` is its detector.
 *
 * ⚠ THE INVARIANT THIS FILE KEEPS: **ZERO runtime imports.** Types and pure values only.
 * An `import type` from a server module would be fine (the bundler erases it), but a single
 * VALUE import — even of something harmless-looking — re-opens the exact leak this file was
 * split out to close, and it will not fail until the SPA route white-screens. Everything
 * here is dependency-free arithmetic on purpose; keep it that way.
 *
 * `./inventory` re-exports every symbol below, so server callers are unchanged and there is
 * still ONE definition of each.
 */

/** A row of the task inventory wire model. Pure shape — no behavior, no dependencies. */
export type TaskInventoryRow = {
  taskId: string;
  parentTaskId: string | null;
  rootTaskId: string;
  class: string;
  title: string;
  state: string;
  launchedBy: string;
  workItemId: string | null;
  planSlug: string | null;
  startedAt: string;
  endedAt: string | null;
  confined: boolean;
  scopeUnit: string | null;
  rssBytes: number | null;
  peakRssBytes: number | null;
  cpuUsec: number | null;
  pids: number | null;
  memoryMaxBytes: number | null;
  deadlineAt: string | null;
  exitCode: number | null;
  exitReason: string | null;
  termination: {
    capturedAt: string;
    reason: string | null;
    serviceResult: string | null;
    scopeUnit: string;
    cgroupPath: string | null;
    invocationId: string | null;
    memoryMaxBytes: number | null;
    peakMemoryBytes: number | null;
    peakMemorySource: 'systemd' | 'cgroup-sample' | 'unknown';
  } | null;
  logPath: string | null;
};

/**
 * A RECURRING task — the second KIND the pane inventories (P-019).
 *
 * The pane's other rows answer "what is running right now"; these answer "what is
 * scheduled to run at all", which is what makes it a task manager rather than a
 * process manager. Projected from `ScheduleInventoryRow` (schedule-inventory.ts)
 * rather than re-derived, so /admin/tasks and /admin/schedules can never disagree
 * about what exists — they render ONE collection through two lenses.
 *
 * Deliberately a NARROWER shape than `ScheduleInventoryRow`: `detail` is an open
 * `Record<string, unknown>` bag whose contents vary per source, and shipping it to a
 * client would put an unbounded, untyped payload on a pane refresh. The two fields
 * the reader actually needs out of it are lifted to real columns below.
 */
export type ScheduleTaskRow = {
  /** Stable render key. `source:scope:name` — unique because a name repeats across sources. */
  key: string;
  name: string;
  /** dbos | routines | in-process | managed | external-process. */
  source: string;
  /** durable (DBOS-backed) | ephemeral (in-process interval). */
  tier: string;
  category: string;
  /** operator | harness. */
  scope: string;
  installSlug: string | null;
  cadence: string;
  /**
   * armed/active where known — `null` means NOT APPLICABLE OR UNKNOWN, never "off".
   * Collapsing it to a boolean is a filed defect (WI-6447): `armed !== false` reads a
   * row whose fire-state could not be reached as armed.
   */
  armed: boolean | null;
  lastFire: string | null;
  nextFire: string | null;
  lastError: string | null;
  /**
   * `detail.federated` — true when the row's fire-state was fetched LIVE from the
   * sibling process that owns it. A false row is either the static manifest or a
   * sibling that did not answer, so its armed/lastFire are not measurements. The
   * repo convention is explicit that this must be read before trusting a row's
   * fire-state, which is why it is a first-class field here and not left in `detail`.
   */
  federated: boolean;
  /** `detail.process` — which process owns the timer (e.g. `bg-host:3080`), when known. */
  process: string | null;
};

/** Counts over the recurring set, mirroring `summarizeInventory` (schedule-inventory.ts). */
export type ScheduleTaskSummary = {
  total: number;
  bySource: Record<string, number>;
  byTier: Record<string, number>;
};

/**
 * Fleet-wide resource totals over the LIVE tracked set — deliberately NOT the row set
 * `total`/`byState` describe.
 *
 * WHY THIS IS COMPUTED SERVER-SIDE AND NOT IN THE VIEW (WI-7371): the panes filter by
 * state/class, so their `rows` is a PROJECTION. A `rows.reduce()` in a component
 * would total only what is currently visible while presenting itself as a system
 * total — a number that answers a narrower question than its label claims. Folding
 * it next to `byState` also means the header pill and the panel it opens read one
 * field and cannot disagree, which is the WI-6844 bug this model already carries a
 * warning about.
 *
 * ⚠ MOVING THE FOLD SERVER-SIDE IS NOT BY ITSELF THE FIX, and the first cut of this
 * change got it wrong. `getTaskInventory` applies the pane's `state`/`cls`/`includeEnded`
 * to `listTasks`, so a fold over its `rows` reproduces the exact same narrower-than-its-
 * label number one layer down, where it is harder to see. The totals therefore run over
 * their OWN fetch (`computeResourceTotals`), which takes no caller filter at all — the
 * independence is structural rather than a property someone has to remember to preserve.
 *
 * ⚠ THE SET IS THE LIVE ONE (`ended_at IS NULL`), never `includeEnded`. An ended task's
 * `rssBytes` is the last reading before it exited — memory the kernel has since reclaimed.
 * Measured 2026-08-03: the 13 live rows summed to ~5 GB while all 971 ledger rows summed
 * to 131 GB on a 257 GB machine. Only the RATIO is stable — the live figure moved 15 GB →
 * 5 GB across the same 13 rows within twenty minutes, which is the reconciler doing its
 * job. The 131 GB is not a bigger truth; it is an arithmetic artifact of summing the dead,
 * and it exceeds the machine's physical memory, which is how you can tell at a glance.
 *
 * ⚠ `rssBytes` is a GAUGE (sum is meaningful) but double-counts pages SHARED between
 * processes — a naive RSS sum over postgres backends on this box reads ~403 GB on a
 * 257 GB machine. Present it as an upper bound, never as "memory in use".
 *
 * ⚠ `cpuUsec` is a MONOTONIC CUMULATIVE counter (cgroup `cpu.stat usage_usec`), so
 * its sum is lifetime CPU-time, NOT "cpu usage". A usage RATE needs two samples;
 * `sampledAtMs` is emitted for exactly that, and `cpuBusyPercent()` derives it.
 * Labelling the raw sum "usage" would be wrong.
 */
export type TaskResourceTotals = {
  /** Σ rssBytes over rows that reported one. Upper bound — shared pages double-count. */
  rssBytesTotal: number;
  /** Σ cpuUsec — CUMULATIVE cpu-microseconds, not a rate. */
  cpuUsecTotal: number;
  /** When this fold was taken; the other half of a rate calculation. */
  sampledAtMs: number;
  /** How many rows actually reported each metric — the rest are `null`. */
  rssBytesKnown: number;
  cpuUsecKnown: number;
  /** Row count the fold ran over, so a view can say "M of N reported". */
  rowsConsidered: number;
  /**
   * The fetch feeding this fold hit its row cap, so the totals are a LOWER BOUND.
   * A silently-capped total is the same defect as a filtered one — authoritative-looking
   * and answering a narrower question — so the cap is reported rather than assumed
   * unreachable. The pure fold cannot know this; the FETCHER sets it.
   */
  truncated: boolean;
};

/** Zeroed totals for the disabled/empty payload. `sampledAtMs: 0` marks "never sampled". */
export function emptyResourceTotals(): TaskResourceTotals {
  return {
    rssBytesTotal: 0,
    cpuUsecTotal: 0,
    sampledAtMs: 0,
    rssBytesKnown: 0,
    cpuUsecKnown: 0,
    rowsConsidered: 0,
    truncated: false,
  };
}

/**
 * The row filter the resource totals are folded over.
 *
 * Exported so the guard test can assert what it does NOT contain: no `states`, no
 * `classes`, and `includeEnded: false`. That is the whole filter-independence claim
 * expressed as a value, which is checkable, rather than as a convention someone has to
 * keep in mind while editing `getTaskInventory`.
 */
export const RESOURCE_TOTALS_LIMIT = 2000;
export const RESOURCE_TOTALS_FILTER = Object.freeze({
  includeEnded: false,
  limit: RESOURCE_TOTALS_LIMIT,
});

/**
 * Fold resource totals over rows. PURE — no clock, no I/O — so the aggregation is
 * unit-testable and `nowMs` is injected rather than read.
 *
 * Nulls are SKIPPED, not coerced to 0, and counted separately: `rssBytes`/`cpuUsec`
 * are `number | null`, and treating "did not report" as zero would silently understate
 * the total while looking like a complete answer.
 *
 * Always reports `truncated: false` — a fold covers exactly the rows handed to it, and
 * whether that set was cut short is knowledge only the fetcher has.
 */
export function foldResourceTotals(
  rows: ReadonlyArray<Pick<TaskInventoryRow, 'rssBytes' | 'cpuUsec'>>,
  nowMs: number,
): TaskResourceTotals {
  const out = { ...emptyResourceTotals(), sampledAtMs: nowMs, rowsConsidered: rows.length };
  for (const r of rows) {
    if (typeof r.rssBytes === 'number' && Number.isFinite(r.rssBytes)) {
      out.rssBytesTotal += r.rssBytes;
      out.rssBytesKnown += 1;
    }
    if (typeof r.cpuUsec === 'number' && Number.isFinite(r.cpuUsec)) {
      out.cpuUsecTotal += r.cpuUsec;
      out.cpuUsecKnown += 1;
    }
  }
  return out;
}

/**
 * Derive CPU BUSY PERCENT from two cumulative samples — the only honest way to turn
 * `cpuUsecTotal` into a "usage" figure. 100% = one core saturated; a 16-core box can
 * legitimately read 1600%.
 *
 * Returns `null` (never 0) when it cannot be computed: no previous sample, a
 * non-advancing or backwards clock, or a counter that went BACKWARDS — which happens
 * legitimately whenever a task ends and leaves the row set, so it must not render as
 * "0% busy". Zero and unknown are different answers and this codebase has been burned
 * repeatedly by conflating them.
 */
export function cpuBusyPercent(
  prev: Pick<TaskResourceTotals, 'cpuUsecTotal' | 'sampledAtMs'> | null | undefined,
  next: Pick<TaskResourceTotals, 'cpuUsecTotal' | 'sampledAtMs'>,
): number | null {
  if (!prev || !prev.sampledAtMs || !next.sampledAtMs) return null;
  const wallUsec = (next.sampledAtMs - prev.sampledAtMs) * 1000;
  if (wallUsec <= 0) return null;
  const deltaCpu = next.cpuUsecTotal - prev.cpuUsecTotal;
  if (deltaCpu < 0) return null;
  return (deltaCpu / wallUsec) * 100;
}
