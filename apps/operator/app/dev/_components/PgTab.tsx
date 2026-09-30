'use client';

import { useEffect, useState } from 'react';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';

interface Health {
  version: string;
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
}

interface Query {
  pid: number;
  state: string | null;
  query: string;
  duration_seconds: number;
  application_name: string | null;
  client_addr: string | null;
}

interface Table {
  schema: string;
  table: string;
  total_bytes: number;
  index_bytes: number;
  rows_estimate: number | null;
}

const CTX_PARAMS = new URLSearchParams({
  workspace: 'default',
  role: 'architect',
  run: 'dev-page',
  spawn: 'dev-page',
});

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

export function fmtDuration(s: number): string {
  if (s < 1) return `${(s * 1000).toFixed(0)}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(s / 3600)}h`;
}

async function postTool<T>(name: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/agent-tools/dev/${name}?${CTX_PARAMS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return JSON.parse(d.content[0].text);
}

export default function PgTab() {
  const [health, setHealth] = useState<Health | null>(null);
  const [queries, setQueries] = useState<Query[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const [h, q, t] = await Promise.all([
          postTool<Health>('pg_health', {}),
          postTool<{ queries: Query[] }>('pg_active_queries', { limit: 50 }),
          postTool<{ tables: Table[] }>('pg_table_sizes', { limit: 25 }),
        ]);
        if (cancelled) return;
        setHealth(h);
        setQueries(q.queries);
        setTables(t.tables);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    }
    refresh();
    // Documented polling exception (audit P-058): pg_stat_activity /
    // connection counts / table sizes are live DB introspection — no table
    // write fires a sync invalidation for them (the dev.pg* resolver entries
    // have no producer). Poll while the dev tab is visible; pause hidden.
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="pc-dev-tab-body">
      <header className="pc-dev-tab-header">
        <h2>PostgreSQL</h2>
        <span className="pc-dev-muted">{health?.version.split(' on ')[0] ?? '…'}</span>
      </header>

      {loading && <div className="pc-dev-muted">loading…</div>}
      {error && <div className="pc-dev-api-err">{error}</div>}

      {!loading && !error && health && (
        <section className="pc-dev-pg-section">
          <h3 className="pc-dev-rail-h">Connections</h3>
          <div className="pc-dev-rail-stats">
            <div>
              <span className="pc-dev-muted">total</span>
              <strong>{health.totalConnections}</strong>
            </div>
            <div>
              <span className="pc-dev-muted">active</span>
              <strong>{health.activeConnections}</strong>
            </div>
            <div>
              <span className="pc-dev-muted">idle</span>
              <strong className="pc-dev-muted">{health.idleConnections}</strong>
            </div>
          </div>
        </section>
      )}

      {!loading && !error && (
        <section className="pc-dev-pg-section">
          <h3 className="pc-dev-rail-h">Active queries ({queries.length})</h3>
          <div style={{ height: Math.min(360, 32 + queries.length * 28 + 4) }}>
            <RichGrid<Query>
              columns={QUERY_COLUMNS}
              rows={queries}
              getRowId={(r) => String(r.pid)}
              rowMinHeight={28}
              headerHeight={32}
            />
          </div>
        </section>
      )}

      {!loading && !error && (
        <section className="pc-dev-pg-section">
          <h3 className="pc-dev-rail-h">Largest tables (harness_shared)</h3>
          <div style={{ height: Math.min(480, 32 + tables.length * 28 + 4) }}>
            <RichGrid<Table>
              columns={TABLE_COLUMNS}
              rows={tables}
              getRowId={(r) => `${r.schema}.${r.table}`}
              rowMinHeight={28}
              headerHeight={32}
            />
          </div>
        </section>
      )}
    </div>
  );
}

const QUERY_COLUMNS: ColumnDef<Query>[] = [
  { key: 'pid', header: 'PID', width: 0.8, align: 'right', toCopyText: (r) => String(r.pid), render: ({ row }) => <span className="pc-dev-muted">{row.pid}</span> },
  {
    key: 'state', header: 'State', width: 1,
    toCopyText: (r) => r.state ?? '',
    render: ({ row }) => <span className={row.state === 'active' ? 'pc-dev-ok' : 'pc-dev-muted'}>{row.state}</span>,
  },
  { key: 'dur', header: 'Duration', width: 1, align: 'right', toCopyText: (r) => fmtDuration(r.duration_seconds), render: ({ row }) => <span className="pc-dev-muted">{fmtDuration(row.duration_seconds)}</span> },
  { key: 'app', header: 'App', width: 1.5, toCopyText: (r) => r.application_name ?? '', render: ({ row }) => <span className="pc-dev-muted">{row.application_name || '—'}</span> },
  {
    key: 'query', header: 'Query', width: 4,
    toCopyText: (r) => r.query.replace(/\s+/g, ' '),
    render: ({ row }) => <span className="pc-dev-query" title={row.query}>{row.query.replace(/\s+/g, ' ').slice(0, 120)}</span>,
  },
];

const TABLE_COLUMNS: ColumnDef<Table>[] = [
  { key: 'name', header: 'Table', width: 2, toCopyText: (r) => `${r.schema}.${r.table}`, render: ({ row }) => <span className="pc-dev-slug">{row.table}</span> },
  { key: 'total', header: 'Total', width: 1, align: 'right', toCopyText: (r) => fmtBytes(r.total_bytes), render: ({ row }) => <>{fmtBytes(row.total_bytes)}</> },
  { key: 'idx', header: 'Indexes', width: 1, align: 'right', toCopyText: (r) => fmtBytes(r.index_bytes), render: ({ row }) => <span className="pc-dev-muted">{fmtBytes(row.index_bytes)}</span> },
  {
    key: 'rows', header: 'Rows (est.)', width: 1.2, align: 'right',
    toCopyText: (r) => r.rows_estimate?.toLocaleString() ?? '',
    render: ({ row }) => <span className="pc-dev-muted">{row.rows_estimate?.toLocaleString() ?? '—'}</span>,
  },
];
