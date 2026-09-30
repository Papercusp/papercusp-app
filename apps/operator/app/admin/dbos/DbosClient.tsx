'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useQueryState, parseAsStringEnum, parseAsString } from 'nuqs';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { statusToneColor } from '@/app/harness/theme';

type Workflow = {
  workflow_uuid: string;
  name: string;
  status: string;
  queue_name: string | null;
  application_version: string | null;
  recovery_attempts: string | number;
  deduplication_id: string | null;
  created_at: string;
  updated_at: string;
  error: string;
};
type QueueRow = { queue_name: string; depth: number; active: number };
type CountRow = { status: string; n: number };
type Payload = { enabled: boolean; counts: CountRow[]; workflows: Workflow[]; queues: QueueRow[] };

/** Pure: format an epoch-ms string to a locale time, or em-dash for non-positive/NaN. Exported for tests. */
export const fmt = (epochMs: string): string => {
  const n = Number(epochMs);
  return Number.isFinite(n) && n > 0 ? new Date(n).toLocaleString() : '—';
};

/** Pure: workflow-status → swatch color (central TONE table). Exported for tests. */
export const statusColor = (s: string): string => statusToneColor(s, 'fg');

const workflowColumns: ColumnDef<Workflow>[] = [
  {
    key: 'workflow',
    header: 'Workflow',
    width: 1.1,
    toCopyText: (w) => w.workflow_uuid,
    render: ({ row }) => <span title={row.workflow_uuid} style={monoCell}>{row.workflow_uuid.slice(0, 8)}</span>,
  },
  { key: 'name', header: 'Name', width: 1.4, toCopyText: (w) => w.name, render: ({ row }) => row.name },
  {
    key: 'status',
    header: 'Status',
    width: 2,
    toCopyText: (w) => `${w.status}${w.error ? ` — ${w.error}` : ''}`,
    render: ({ row }) => <span style={{ color: statusColor(row.status) }}>{row.status}{row.error ? ` — ${row.error}` : ''}</span>,
  },
  { key: 'queue', header: 'Queue', width: 1, toCopyText: (w) => w.queue_name ?? '—', render: ({ row }) => row.queue_name ?? '—' },
  {
    key: 'version',
    header: 'Ver',
    width: 1,
    toCopyText: (w) => w.application_version ?? '—',
    render: ({ row }) => <span title={row.application_version ?? ''} style={monoCell}>{row.application_version?.slice(0, 10) ?? '—'}</span>,
  },
  {
    key: 'recovery',
    header: 'Recov',
    width: 0.7,
    toCopyText: (w) => String(w.recovery_attempts),
    render: ({ row }) => String(row.recovery_attempts),
  },
  {
    key: 'dedup',
    header: 'Dedup',
    width: 0.7,
    toCopyText: (w) => w.deduplication_id ?? '—',
    render: ({ row }) => <span title={row.deduplication_id ?? ''} style={monoCell}>{row.deduplication_id ? '✓' : '—'}</span>,
  },
  { key: 'created', header: 'Created', width: 1.4, toCopyText: (w) => fmt(w.created_at), render: ({ row }) => fmt(row.created_at) },
];

const queueColumns: ColumnDef<QueueRow>[] = [
  { key: 'queue', header: 'Queue', width: 2, toCopyText: (q) => q.queue_name, render: ({ row }) => <span style={monoCell}>{row.queue_name}</span> },
  { key: 'depth', header: 'Depth', width: 1, toCopyText: (q) => String(q.depth), render: ({ row }) => row.depth },
  { key: 'active', header: 'Active', width: 1, toCopyText: (q) => String(q.active), render: ({ row }) => row.active },
];

export default function DbosClient() {
  // URL-backed state per repo convention (nuqs), so agents + deep links work.
  const [view, setView] = useQueryState(
    'view',
    parseAsStringEnum<'workflows' | 'queues'>(['workflows', 'queues']).withDefault('workflows'),
  );
  const [status, setStatus] = useQueryState('status', parseAsString);
  const [data, setData] = useState<Payload | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const qs = status ? `?status=${encodeURIComponent(status)}` : '';
      const r = await fetch(`/api/admin/dbos/status${qs}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as Payload);
      setState('ok');
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setState('error');
    }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div style={{ padding: 16, color: 'var(--fg)', fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        {(['workflows', 'queues'] as const).map((v) => (
          <button key={v} onClick={() => void setView(v)} style={tabBtn(view === v)}>{v}</button>
        ))}
        <span style={{ flex: 1 }} />
        <button onClick={() => void load()} style={tabBtn(false)}>↻ refresh</button>
      </div>

      {state === 'loading' && <p style={{ opacity: 0.6 }}>Loading…</p>}
      {state === 'error' && <p style={{ color: 'var(--bad)' }}>Error: {err}</p>}
      {state === 'ok' && data && !data.enabled && (
        <p style={{ opacity: 0.75, maxWidth: 560, lineHeight: 1.5 }}>
          DBOS is not running — the <code>dbos</code> schema doesn’t exist yet. Enable it with{' '}
          <code>PAPERCUSP_DBOS_ENABLE=1</code> (and <code>PAPERCUSP_DBOS_AUTOLOOP=1</code> for the
          AutoLoop migration), then restart the operator.
        </p>
      )}
      {state === 'ok' && data?.enabled && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {data.counts.map((c) => (
              <button key={c.status} onClick={() => void setStatus(status === c.status ? null : c.status)} style={pill(status === c.status)}>
                {c.status}: <b>{c.n}</b>
              </button>
            ))}
            {data.counts.length === 0 && <span style={{ opacity: 0.6 }}>no workflows yet</span>}
          </div>

          {view === 'workflows' ? (
            data.workflows.length === 0 ? (
              <div style={emptyGrid}>no workflows for this filter</div>
            ) : (
              <div style={{ height: Math.min(640, 32 + data.workflows.length * 28 + 4) }}>
                <RichGrid<Workflow>
                  columns={workflowColumns}
                  rows={data.workflows}
                  getRowId={(w) => w.workflow_uuid}
                  rowMinHeight={28}
                  headerHeight={32}
                />
              </div>
            )
          ) : (
            data.queues.length === 0 ? (
              <div style={emptyGrid}>no queued work</div>
            ) : (
              <div style={{ height: Math.min(420, 32 + data.queues.length * 28 + 4) }}>
                <RichGrid<QueueRow>
                  columns={queueColumns}
                  rows={data.queues}
                  getRowId={(q) => q.queue_name}
                  rowMinHeight={28}
                  headerHeight={32}
                />
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}

const tabBtn = (on: boolean): CSSProperties => ({
  padding: '5px 12px', borderRadius: 8,
  border: '1px solid color-mix(in oklab, var(--accent), transparent 72%)',
  background: on ? 'var(--bg-raised)' : 'var(--bg-2)',
  color: on ? 'var(--fg)' : 'var(--fg-dim)', cursor: 'pointer', fontSize: 12,
});
const pill = (on: boolean): CSSProperties => ({
  padding: '3px 10px', borderRadius: 999,
  border: `1px solid ${on ? 'color-mix(in oklab, var(--accent), transparent 48%)' : 'var(--border)'}`,
  background: on ? 'var(--bg-raised)' : 'transparent', color: 'var(--fg)', cursor: 'pointer', fontSize: 12,
});
const monoCell: CSSProperties = { fontFamily: 'ui-monospace, Menlo, monospace' };
const emptyGrid: CSSProperties = {
  padding: '10px 12px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--fg-dim)',
  fontSize: 12,
};
