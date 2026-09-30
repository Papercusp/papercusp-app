'use client';

/**
 * /dev → Routes tab — recent `route_invocations` rows for the active
 * workspace. The R2-deferred follow-up to the endpoint-route migration:
 * the data path (migration 077 + `recordRouteInvocation` +
 * `GET /api/dev/route-invocations`) shipped with R2; this is the
 * deferred React panel that renders it, distinct from the Sessions tab
 * which shows tool-invocations per spawn.
 */
import { useEffect, useState } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';
import { VirtualGrid, type ColumnDef } from '@papercusp/grid-core';
import { Select } from '@/app/harness/Select';

interface Row {
  method: string;
  path: string;
  status: string;
  duration_ms: number | null;
  principal_kind: string | null;
  principal_trust: string | null;
  invoked_at: string;
}

export function fmtRelTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

export default function RoutesTab() {
  const [rows, setRows] = useState<Row[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limitParam, setLimitParam] = useQueryState(
    'routesLimit',
    parseAsStringEnum(['50', '100', '200', '500']).withDefault('100'),
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/dev/route-invocations?limit=${limitParam}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as { rows?: Row[]; degraded?: boolean };
        if (cancelled) return;
        setRows(d.rows ?? []);
        setDegraded(!!d.degraded);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [limitParam]);

  return (
    <div className="pc-dev-tab-body">
      <header className="pc-dev-tab-header">
        <h2>Route traffic</h2>
        <label className="pc-dev-muted">
          limit
          <Select
            value={limitParam}
            onChange={(v) => setLimitParam(v as '50' | '100' | '200' | '500')}
            ariaLabel="Route invocations row limit"
            options={[
              { value: '50', label: '50' },
              { value: '100', label: '100' },
              { value: '200', label: '200' },
              { value: '500', label: '500' },
            ]}
          />
        </label>
      </header>
      {loading && <div className="pc-dev-muted">loading…</div>}
      {error && <div className="pc-dev-api-err">{error}</div>}
      {!loading && !error && degraded && (
        <div className="pc-dev-muted">
          route_invocations table not present — apply migration 077.
        </div>
      )}
      {!loading && !error && !degraded && rows.length === 0 && (
        <div className="pc-dev-muted">no route invocations recorded yet.</div>
      )}
      {!loading && !error && rows.length > 0 && (
        <VirtualGrid<Row>
          columns={ROUTES_COLUMNS}
          rows={rows}
          getRowId={(r) => `${r.invoked_at}:${r.method}:${r.path}:${r.status}:${r.duration_ms ?? ''}`}
          rowMinHeight={28}
          estimateRowHeight={28}
          headerHeight={32}
          scrollStyle={{ maxHeight: 640, overflow: 'auto' }}
        />
      )}
    </div>
  );
}

const ROUTES_COLUMNS: ColumnDef<Row>[] = [
  {
    key: 'time', header: 'Time', width: 1.2,
    toCopyText: (r) => r.invoked_at,
    render: ({ row }) => <span className="pc-dev-muted">{fmtRelTime(row.invoked_at)}</span>,
  },
  {
    key: 'method', header: 'Method', width: 0.8,
    toCopyText: (r) => r.method,
    render: ({ row }) => <span className="pc-dev-slug">{row.method}</span>,
  },
  {
    key: 'path', header: 'Path', width: 3,
    toCopyText: (r) => r.path,
    render: ({ row }) => <span className="pc-dev-slug">{row.path}</span>,
  },
  {
    key: 'status', header: 'Status', width: 1,
    toCopyText: (r) => r.status,
    render: ({ row }) => <span className={row.status === 'ok' ? 'pc-dev-muted' : 'pc-dev-api-err'}>{row.status}</span>,
  },
  {
    key: 'duration', header: 'Duration', width: 1,
    toCopyText: (r) => String(r.duration_ms ?? ''),
    render: ({ row }) => <span className="pc-dev-muted">{fmtDuration(row.duration_ms)}</span>,
  },
  {
    key: 'kind', header: 'Principal', width: 1.2,
    toCopyText: (r) => r.principal_kind ?? '',
    render: ({ row }) => (
      <span className="pc-dev-muted">
        {row.principal_kind ?? '—'}
        {row.principal_trust ? ` · ${row.principal_trust}` : ''}
      </span>
    ),
  },
];
