'use client';

import { useEffect, useMemo, useState } from 'react';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { loadRuns, type RunSummary, type RouteRollup } from '../_lib/recorder-channel';
import { getEvents, rateINP, type PerfEvent } from '../_lib/vitals-recorder';

export interface MergedRollup extends RouteRollup {
  liveCount: number;
  liveMaxInp: number;
  liveErrors: number;
}

/**
 * Pure: merge per-route chaos-run rollups with live observer events into a
 * single per-route table — chaos metrics accumulate (clicks/errors) or take the
 * max (p50/p95/max INP), live interactions tally liveCount/liveMaxInp, and live
 * errors bump liveErrors. Sorted by the worst of (chaos p95, live max). Exported
 * for tests.
 */
export function mergeRouteRollups(runs: RunSummary[], live: PerfEvent[]): MergedRollup[] {
  const byRoute: Record<string, MergedRollup> = {};

  for (const run of runs) {
    for (const r of Object.values(run.routes)) {
      const existing = byRoute[r.route] ?? {
        route: r.route, clicks: 0, p50inp: 0, p95inp: 0, maxInp: 0, errors: 0,
        liveCount: 0, liveMaxInp: 0, liveErrors: 0,
      };
      existing.clicks += r.clicks;
      existing.maxInp = Math.max(existing.maxInp, r.maxInp);
      existing.p95inp = Math.max(existing.p95inp, r.p95inp);
      existing.p50inp = Math.max(existing.p50inp, r.p50inp);
      existing.errors += r.errors;
      byRoute[r.route] = existing;
    }
  }

  for (const e of live) {
    const existing = byRoute[e.route] ?? {
      route: e.route, clicks: 0, p50inp: 0, p95inp: 0, maxInp: 0, errors: 0,
      liveCount: 0, liveMaxInp: 0, liveErrors: 0,
    };
    if (e.kind === 'interaction') {
      existing.liveCount++;
      existing.liveMaxInp = Math.max(existing.liveMaxInp, e.duration);
    } else if (e.kind === 'console-error' || e.kind === 'unhandled-error') {
      existing.liveErrors++;
    }
    byRoute[e.route] = existing;
  }

  return Object.values(byRoute).sort(
    (a, b) => Math.max(b.p95inp, b.liveMaxInp) - Math.max(a.p95inp, a.liveMaxInp),
  );
}

const routeColumns: ColumnDef<MergedRollup>[] = [
  { key: 'route', header: 'Route', width: 2, toCopyText: (r) => r.route, render: ({ row }) => <code>{row.route}</code> },
  { key: 'clicks', header: 'Chaos clicks', width: 1, toCopyText: (r) => String(r.clicks), render: ({ row }) => row.clicks },
  { key: 'p50', header: 'Chaos p50', width: 1, toCopyText: (r) => r.p50inp ? `${r.p50inp}ms` : '—', render: ({ row }) => row.p50inp ? `${row.p50inp}ms` : '—' },
  {
    key: 'p95',
    header: 'Chaos p95',
    width: 1,
    toCopyText: (r) => r.p95inp ? `${r.p95inp}ms` : '—',
    render: ({ row }) => {
      const rating = rateINP(Math.max(row.p95inp, row.liveMaxInp));
      const cls = rating === 'good' ? 'is-good' : rating === 'needs-improvement' ? 'is-needs' : 'is-poor';
      return row.p95inp ? <span className={`pc-test-badge ${cls}`}>{row.p95inp}ms</span> : '—';
    },
  },
  { key: 'max', header: 'Chaos max', width: 1, toCopyText: (r) => r.maxInp ? `${r.maxInp}ms` : '—', render: ({ row }) => row.maxInp ? `${row.maxInp}ms` : '—' },
  { key: 'liveCount', header: 'Live count', width: 1, toCopyText: (r) => String(r.liveCount || '—'), render: ({ row }) => row.liveCount || '—' },
  { key: 'liveMax', header: 'Live max', width: 1, toCopyText: (r) => r.liveMaxInp ? `${r.liveMaxInp}ms` : '—', render: ({ row }) => row.liveMaxInp ? `${row.liveMaxInp}ms` : '—' },
  {
    key: 'errors',
    header: 'Errors',
    width: 0.85,
    toCopyText: (r) => String(r.errors + r.liveErrors),
    render: ({ row }) => {
      const totalErrors = row.errors + row.liveErrors;
      return <span className={`pc-test-badge ${totalErrors ? 'is-poor' : 'is-good'}`}>{totalErrors}</span>;
    },
  },
];

export default function RoutesTab() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [live, setLive] = useState<PerfEvent[]>([]);

  useEffect(() => {
    setRuns(loadRuns());
    setLive(getEvents());
  }, []);

  const merged: MergedRollup[] = useMemo(() => mergeRouteRollups(runs, live), [runs, live]);

  return (
    <>
      <header className="pc-test-tab-header">
        <div>
          <h1 className="pc-test-tab-title">Routes</h1>
          <p className="pc-test-tab-intro">
            Per-route roll-up across all chaos runs + live observer events. Highest p95 INP at top
            — that's where to spend your perf budget. "Live max" is the worst interaction caught
            during passive ambient usage.
          </p>
        </div>
      </header>

      <div className="pc-test-card">
        {merged.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--fg-mute)' }}>
            No data yet — run a chaos test or use the app to populate.
          </div>
        ) : (
          <div style={{ height: Math.min(620, 32 + merged.length * 32 + 4) }}>
            <RichGrid<MergedRollup>
              columns={routeColumns}
              rows={merged}
              getRowId={(r) => r.route}
              rowMinHeight={32}
              headerHeight={32}
            />
          </div>
        )}
      </div>
    </>
  );
}
