'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';

/**
 * /admin/schedules — the central read-only inventory of EVERY scheduled/recurring
 * thing in the operator host, regardless of cadence
 * (plan schedule-inventory-and-ephemeral-tier-2026-06-26, P-003).
 *
 * Self-fetching client (mirrors DbosClient): hits `/api/admin/schedules/inventory`,
 * which shares the SAME collectScheduleInventory() aggregation as the
 * `schedule:inventory` MCP tool. Filters are URL-backed (nuqs) so agents + deep
 * links work. visibility ≠ control: this LISTS everything; it never drives a timer.
 */
type Row = {
  source: string;
  scope: string;
  tier: string;
  category: string;
  name: string;
  installSlug: string | null;
  cadence: string;
  armed: boolean | null;
  lastFire: string | null;
  nextFire: string | null;
  lastError: string | null;
  detail: Record<string, unknown>;
};
type Payload = {
  enabled: boolean;
  summary: { total: number; bySource: Record<string, number>; byTier: Record<string, number> };
  rows: Row[];
};

/** Pure: ISO → locale time, em-dash for null/invalid. Exported for tests. */
export const fmtTime = (iso: string | null): string => {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? new Date(t).toLocaleString() : '—';
};

/** Pure: tier → swatch color. Exported for tests. */
export const tierColor = (tier: string): string =>
  tier === 'durable' ? 'var(--accent)' : tier === 'ephemeral' ? 'var(--warn)' : 'var(--fg)';

const columns: ColumnDef<Row>[] = [
  {
    key: 'source',
    header: 'Source',
    width: 0.9,
    toCopyText: (r) => r.source,
    render: ({ row }) => <span style={monoCell}>{row.source}</span>,
  },
  {
    key: 'tier',
    header: 'Tier',
    width: 0.8,
    toCopyText: (r) => r.tier,
    render: ({ row }) => <span style={{ color: tierColor(row.tier) }}>{row.tier}</span>,
  },
  { key: 'category', header: 'Category', width: 1, toCopyText: (r) => r.category, render: ({ row }) => row.category },
  {
    key: 'name',
    header: 'Name',
    width: 1.8,
    toCopyText: (r) => r.name,
    render: ({ row }) => (
      <span title={row.installSlug ? `${row.installSlug} · ${row.name}` : row.name}>
        {row.installSlug ? <span style={{ opacity: 0.55 }}>{row.installSlug}/</span> : null}
        {row.name}
      </span>
    ),
  },
  {
    key: 'cadence',
    header: 'Cadence',
    width: 1.2,
    toCopyText: (r) => r.cadence,
    render: ({ row }) => <span style={monoCell}>{row.cadence}</span>,
  },
  {
    key: 'armed',
    header: 'Armed',
    width: 0.6,
    toCopyText: (r) => (r.armed == null ? '—' : r.armed ? 'yes' : 'no'),
    render: ({ row }) =>
      row.armed == null ? '—' : <span style={{ color: row.armed ? 'var(--good)' : 'var(--fg-dim)' }}>{row.armed ? '✓' : '○'}</span>,
  },
  { key: 'last', header: 'Last fire', width: 1.3, toCopyText: (r) => fmtTime(r.lastFire), render: ({ row }) => fmtTime(row.lastFire) },
  { key: 'next', header: 'Next fire', width: 1.3, toCopyText: (r) => fmtTime(r.nextFire), render: ({ row }) => fmtTime(row.nextFire) },
  {
    key: 'error',
    header: 'Last error',
    width: 1.2,
    toCopyText: (r) => r.lastError ?? '—',
    render: ({ row }) =>
      row.lastError ? <span style={{ color: 'var(--bad)' }} title={row.lastError}>{row.lastError.slice(0, 40)}</span> : <span style={{ opacity: 0.4 }}>—</span>,
  },
];

export default function SchedulesClient() {
  const [source, setSource] = useQueryState(
    'source',
    parseAsStringEnum<'dbos' | 'routines' | 'in-process' | 'managed'>(['dbos', 'routines', 'in-process', 'managed']),
  );
  const [tier, setTier] = useQueryState('tier', parseAsStringEnum<'durable' | 'ephemeral'>(['durable', 'ephemeral']));
  const [data, setData] = useState<Payload | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const qs = new URLSearchParams();
      if (source) qs.set('source', source);
      if (tier) qs.set('tier', tier);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const r = await fetch(`/api/admin/schedules/inventory${suffix}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as Payload);
      setState('ok');
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setState('error');
    }
  }, [source, tier]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ padding: 16, color: 'var(--fg)', fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ opacity: 0.6 }}>source:</span>
        {(['dbos', 'routines', 'in-process', 'managed'] as const).map((s) => (
          <button key={s} onClick={() => void setSource(source === s ? null : s)} style={pill(source === s)}>
            {s}
            {data?.summary.bySource[s] != null ? <b> {data.summary.bySource[s]}</b> : null}
          </button>
        ))}
        <span style={{ width: 10 }} />
        <span style={{ opacity: 0.6 }}>tier:</span>
        {(['durable', 'ephemeral'] as const).map((t) => (
          <button key={t} onClick={() => void setTier(tier === t ? null : t)} style={pill(tier === t)}>
            {t}
            {data?.summary.byTier[t] != null ? <b> {data.summary.byTier[t]}</b> : null}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button onClick={() => void load()} style={pill(false)}>↻ refresh</button>
      </div>

      {state === 'loading' && <p style={{ opacity: 0.6 }}>Loading…</p>}
      {state === 'error' && <p style={{ color: 'var(--bad)' }}>Error: {err}</p>}
      {state === 'ok' && data && !data.enabled && (
        <p style={{ opacity: 0.75, maxWidth: 560, lineHeight: 1.5 }}>
          The schedule inventory is disabled — enable the <code>papercusp-schedule-inventory</code> flag.
        </p>
      )}
      {state === 'ok' && data?.enabled && (
        <>
          <div style={{ marginBottom: 10, opacity: 0.7 }}>
            {data.summary.total} scheduled thing{data.summary.total === 1 ? '' : 's'} across all sources.
          </div>
          {data.rows.length === 0 ? (
            <div style={emptyGrid}>no schedules for this filter</div>
          ) : (
            <div style={{ height: Math.min(720, 32 + data.rows.length * 28 + 4) }}>
              <RichGrid<Row>
                columns={columns}
                rows={data.rows}
                getRowId={(r) => `${r.source}:${r.installSlug ?? ''}:${r.name}`}
                rowMinHeight={28}
                headerHeight={32}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

const pill = (on: boolean): CSSProperties => ({
  padding: '3px 10px',
  borderRadius: 999,
  border: `1px solid ${on ? 'color-mix(in oklab, var(--accent), transparent 48%)' : 'var(--border)'}`,
  background: on ? 'var(--bg-raised)' : 'transparent',
  color: 'var(--fg)',
  cursor: 'pointer',
  fontSize: 12,
});
const monoCell: CSSProperties = { fontFamily: 'ui-monospace, Menlo, monospace' };
const emptyGrid: CSSProperties = {
  padding: '10px 12px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--fg-dim)',
  fontSize: 12,
};
