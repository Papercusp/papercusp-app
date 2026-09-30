'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { Button } from '../../../harness/Button';
import { Select } from '../../../harness/Select';
import { subscribe, clearEvents, rateINP, type PerfEvent, type PerfEventKind } from '../_lib/vitals-recorder';

type SortKey = 'ts' | 'duration' | 'route';

/**
 * Pure: apply the kind + route-substring filters, sort by the chosen key
 * (ts/duration desc, route asc), and cap at 50 rows. Exported for tests.
 */
export function filterAndSortEvents(
  events: PerfEvent[],
  kindFilter: PerfEventKind | 'all',
  routeFilter: string,
  sort: SortKey,
): PerfEvent[] {
  let list = events;
  if (kindFilter !== 'all') list = list.filter((e) => e.kind === kindFilter);
  if (routeFilter) list = list.filter((e) => e.route.includes(routeFilter));
  const sorted = [...list];
  if (sort === 'ts') sorted.sort((a, b) => b.ts - a.ts);
  else if (sort === 'duration') sorted.sort((a, b) => b.duration - a.duration);
  else sorted.sort((a, b) => a.route.localeCompare(b.route));
  return sorted.slice(0, 50);
}

/** Pure: tally events by kind (all five kinds present, zero-defaulted). Exported for tests. */
export function countEventsByKind(events: PerfEvent[]): Record<string, number> {
  const c: Record<string, number> = { interaction: 0, longtask: 0, 'layout-shift': 0, measure: 0, 'console-error': 0, 'unhandled-error': 0 };
  for (const e of events) c[e.kind] = (c[e.kind] ?? 0) + 1;
  return c;
}

const eventColumns: ColumnDef<PerfEvent>[] = [
  {
    key: 'kind',
    header: 'Kind',
    width: '120px',
    toCopyText: (e) => e.kind,
    render: ({ row }) => {
      const rating = row.kind === 'interaction' ? rateINP(row.duration) : null;
      const badgeCls = rating === 'good' ? 'is-good' : rating === 'needs-improvement' ? 'is-needs' : rating === 'poor' ? 'is-poor' : 'is-muted';
      return <span className={`pc-test-badge ${badgeCls}`}>{row.kind}</span>;
    },
  },
  {
    key: 'duration',
    header: 'Duration',
    width: '100px',
    toCopyText: (e) => e.kind === 'layout-shift' ? (e.duration / 1000).toFixed(3) : `${e.duration}ms`,
    render: ({ row }) => row.kind === 'layout-shift' ? (row.duration / 1000).toFixed(3) : `${row.duration}ms`,
  },
  { key: 'route', header: 'Route', width: 1.6, toCopyText: (e) => e.route, render: ({ row }) => <code>{row.route}</code> },
  {
    key: 'target',
    header: 'Target',
    width: 1.8,
    toCopyText: (e) => `${e.target}${e.detail ? ` ${e.detail}` : ''}`,
    render: ({ row }) => (
      <>
        {row.target}
        {row.detail ? <div style={{ fontSize: 11, color: 'var(--fg-mute)' }}>{row.detail}</div> : null}
      </>
    ),
  },
  {
    key: 'when',
    header: 'When',
    width: '100px',
    toCopyText: (e) => `${Math.round((Date.now() - e.ts) / 1000)}s ago`,
    render: ({ row }) => <span style={{ color: 'var(--fg-mute)' }}>{Math.round((Date.now() - row.ts) / 1000)}s ago</span>,
  },
];

export default function LiveMetricsTab() {
  const [events, setEvents] = useState<PerfEvent[]>([]);
  const [kindFilter, setKindFilter] = useQueryState(
    'kind',
    parseAsStringEnum<PerfEventKind | 'all'>(['all', 'interaction', 'longtask', 'layout-shift', 'measure', 'console-error', 'unhandled-error']).withDefault('all'),
  );
  const [routeFilter, setRouteFilter] = useQueryState('route', parseAsString.withDefault(''));
  const [sort, setSort] = useQueryState(
    'sort',
    parseAsStringEnum<SortKey>(['ts', 'duration', 'route']).withDefault('duration'),
  );

  useEffect(() => subscribe(setEvents), []);

  const filtered = useMemo(
    () => filterAndSortEvents(events, kindFilter, routeFilter, sort),
    [events, kindFilter, routeFilter, sort],
  );

  const counts = useMemo(() => countEventsByKind(events), [events]);

  return (
    <>
      <header className="pc-test-tab-header">
        <div>
          <h1 className="pc-test-tab-title">Live metrics</h1>
          <p className="pc-test-tab-intro">
            Passive observer. Every slow interaction (&gt;40ms), long task (&gt;50ms), layout shift,
            and console error gets logged here as you use the app. The buffer survives navigation
            and persists to localStorage. Sort by duration to see your biggest wins.
          </p>
        </div>
        <Button variant="ghost" onClick={() => clearEvents()}>Clear</Button>
      </header>

      <div className="pc-test-card">
        <div className="pc-test-card-row">
          <span className="pc-test-badge is-muted">interactions {counts.interaction}</span>
          <span className="pc-test-badge is-muted">long tasks {counts.longtask}</span>
          <span className="pc-test-badge is-muted">layout shifts {counts['layout-shift']}</span>
          <span className="pc-test-badge is-muted">measures {counts.measure}</span>
          <span className="pc-test-badge is-poor">console errors {counts['console-error']}</span>
          <span className="pc-test-badge is-poor">unhandled {counts['unhandled-error']}</span>
        </div>
        <div className="pc-test-card-row">
          <label>
            Kind{' '}
            <Select
              value={kindFilter}
              onChange={(v) => setKindFilter(v as PerfEventKind | 'all')}
              ariaLabel="Filter by event kind"
              options={[
                { value: 'all', label: 'all' },
                { value: 'interaction', label: 'interaction' },
                { value: 'longtask', label: 'longtask' },
                { value: 'layout-shift', label: 'layout-shift' },
                { value: 'measure', label: 'measure' },
                { value: 'console-error', label: 'console-error' },
                { value: 'unhandled-error', label: 'unhandled-error' },
              ]}
            />
          </label>
          <label>
            Route contains{' '}
            <input
              type="text"
              value={routeFilter}
              onChange={(e) => setRouteFilter(e.target.value || null)}
              placeholder="/harness"
              style={{ width: 160 }}
            />
          </label>
          <label>
            Sort{' '}
            <Select
              value={sort}
              onChange={(v) => setSort(v as SortKey)}
              ariaLabel="Sort events"
              options={[
                { value: 'duration', label: 'duration ↓' },
                { value: 'ts', label: 'time ↓' },
                { value: 'route', label: 'route ↑' },
              ]}
            />
          </label>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-mute)' }}>
            {filtered.length} of {events.length} events
          </span>
        </div>
      </div>

      <div className="pc-test-card">
        {filtered.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--fg-mute)' }}>
            No events yet — use the app and slow interactions will appear here.
          </div>
        ) : (
          <div style={{ height: Math.min(620, 32 + filtered.length * 36 + 4) }}>
            <RichGrid<PerfEvent>
              columns={eventColumns}
              rows={filtered}
              getRowId={(e) => e.id}
              rowMinHeight={36}
              headerHeight={32}
            />
          </div>
        )}
      </div>
    </>
  );
}
