/**
 * Shared derivation for the Task Manager's live resource header (WI-7371).
 *
 * WHY A SHARED HOOK RATHER THAN A `useMemo` IN EACH VIEW: the header pill's popover
 * (`TasksRosterPanel`) and the admin page (`TasksClient`) render the same numbers, and
 * `TasksRunningPill` already carries a warning about WI-6844 — the bug where the pill and
 * the panel it opens disagreed because each derived its own figure. The totals themselves
 * come from one server-side fold; this keeps the one *client-side* derivation (the CPU
 * rate) single-sourced too.
 *
 * Layering: this lives under `apps/operator/app` on purpose. operator-vite may import from
 * apps/operator (forward dependency), never the reverse — so this is the only placement
 * both surfaces can reach.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
// ⚠ `/inventory-shared`, NEVER `/inventory` (WI-8191). `cpuBusyPercent` is a VALUE import, so
// the specifier below is a RUNTIME edge: pointing it at `./inventory` drags that module's
// server graph (store / reconcile-tick / scan / _repo-paths → node:fs, node:os, node:path,
// node:child_process) into the SPA's browser-eager bundle, where `node:` builtins are stubs
// that throw on property access — the route white-screens at module-init on :3055. The shared
// file is the same definitions with zero runtime imports. A type-only import from `./inventory`
// would be harmless (erased), but this one is not type-only.
import { cpuBusyPercent } from '@papercusp/operator-core/lib/task-manager/inventory-shared';
import type { TaskResourceTotals } from '@papercusp/operator-core/lib/task-manager/inventory-shared';

export type ResourceHeader = {
  /** Σ RSS across tracked tasks. Upper bound — shared pages double-count. */
  rssBytesTotal: number;
  /** Cores-busy percent since the previous sample; `null` until two samples exist. */
  cpuBusyPct: number | null;
  /** True once a rate has been computed at least once (drives "measuring…" vs a value). */
  hasRate: boolean;
  /** How many tracked rows reported each metric, and how many were considered. */
  rssBytesKnown: number;
  cpuUsecKnown: number;
  rowsConsidered: number;
  /** The server's fetch hit its cap — these totals are a lower bound, not the total. */
  truncated: boolean;
};

/**
 * Turn the server's cumulative totals into a renderable header.
 *
 * The CPU figure is a RATE derived from two successive samples — `cpuUsecTotal` is a
 * monotonic cgroup counter, so its raw sum is lifetime CPU-time and would be a lie if
 * labelled "usage". `cpuBusyPct` stays `null` (never 0) until a second sample arrives, and
 * reverts to `null` whenever the counter goes backwards, which happens legitimately every
 * time a task ends and leaves the row set. Rendering that as "0%" on a busy box is exactly
 * the absent-vs-zero conflation this codebase keeps paying for.
 */
export function useResourceTotals(res: TaskResourceTotals | null | undefined): ResourceHeader | null {
  const prevRef = useRef<TaskResourceTotals | null>(null);
  const [cpuBusyPct, setCpuBusyPct] = useState<number | null>(null);
  const [hasRate, setHasRate] = useState(false);

  const sampledAtMs = res?.sampledAtMs ?? 0;

  useEffect(() => {
    if (!res || !sampledAtMs) return;
    const prev = prevRef.current;
    // Idempotent under StrictMode's double-invoke: the same sample is a no-op.
    if (prev && prev.sampledAtMs === sampledAtMs) return;
    if (prev) {
      const pct = cpuBusyPercent(prev, res);
      setCpuBusyPct(pct);
      if (pct !== null) setHasRate(true);
    }
    prevRef.current = res;
  }, [res, sampledAtMs]);

  if (!res) return null;
  return {
    rssBytesTotal: res.rssBytesTotal,
    cpuBusyPct,
    hasRate,
    rssBytesKnown: res.rssBytesKnown,
    cpuUsecKnown: res.cpuUsecKnown,
    rowsConsidered: res.rowsConsidered,
    truncated: res.truncated,
  };
}

/** `1600%` reads better than `1600.00%`; sub-10% keeps one decimal so idle is legible. */
export function fmtCpuPct(pct: number | null): string {
  if (pct === null) return '—';
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

/**
 * The tooltip both surfaces show. Stated explicitly because every number here is easy to
 * over-read: RSS double-counts shared pages, and CPU can legitimately exceed 100%.
 */
export function resourceTitle(h: ResourceHeader): { mem: string; cpu: string } {
  // Both strings name the SET, not just the metric. The filters sitting directly below
  // these numbers make "total" ambiguous by proximity, and a reader who assumes the
  // header follows the filter would read a system total as a filtered one.
  const scope = 'RUNNING tasks only, and unaffected by the filters below';
  const cut = h.truncated
    ? ` ⚠ The server hit its ${h.rowsConsidered}-row cap, so this is a LOWER BOUND.`
    : '';
  return {
    mem:
      `Σ RSS over ${h.rssBytesKnown} of ${h.rowsConsidered} tracked task(s) — ${scope}. ` +
      `Upper bound: pages shared between processes are counted once per process. ` +
      `Ended tasks are excluded — their last reading is memory the kernel has already reclaimed.${cut}`,
    cpu: h.hasRate
      ? `Cores busy across ${h.cpuUsecKnown} of ${h.rowsConsidered} tracked task(s) — ${scope} — ` +
        `since the previous sample. 100% = one core saturated.${cut}`
      : 'Needs two samples to compute a rate — waiting for the next refresh.',
  };
}
