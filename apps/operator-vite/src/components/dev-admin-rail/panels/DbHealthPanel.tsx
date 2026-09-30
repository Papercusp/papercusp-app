/**
 * DB health peek (P-007) — pool usage + the currently-running queries, to catch
 * the leaked-lock / idle-in-transaction wedge class before it bites. Reads two
 * sync queries: `dev.pgHealth` (snapshot → data[0]) and `dev.pgActiveQueries`
 * (flat rows, oldest first). Manual refresh re-reads both.
 */
import { useSyncQuery } from '@papercusp/sync';
import { PanelBar, PanelState } from '../panel-kit';

interface PgHealth {
  version: string;
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
}
interface PgActiveQuery {
  pid: number;
  state: string | null;
  query: string;
  duration_seconds: number;
  application_name: string | null;
  client_addr: string | null;
}

function fmtDur(s: number): string {
  if (s < 1) return `${Math.round(s * 1000)}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.round(s / 60)}m`;
}

export default function DbHealthPanel({ active }: { active: boolean }) {
  const health = useSyncQuery<PgHealth>({
    queryName: 'dev.pgHealth',
    enabled: active,
    staleTime: 10_000,
  });
  const queries = useSyncQuery<PgActiveQuery>({
    queryName: 'dev.pgActiveQueries',
    args: { limit: 50 },
    enabled: active,
    staleTime: 10_000,
  });
  const h = health.data?.[0];
  const rows = queries.data ?? [];

  const refresh = () => {
    health.invalidate();
    queries.invalidate();
  };

  return (
    <div className="pcdar-panel">
      <PanelBar
        label="DB health"
        fetching={health.fetching || queries.fetching}
        onRefresh={refresh}
      />
      <PanelState loading={health.loading && !h} error={health.error ?? queries.error} />
      {h && (
        <div className="pcdar-kv">
          <span className="pcdar-kv__k">connections</span>
          <span className="pcdar-kv__v">
            {h.totalConnections} total · {h.activeConnections} active · {h.idleConnections} idle
          </span>
          <span className="pcdar-kv__k">version</span>
          <span className="pcdar-kv__v" title={h.version}>
            {h.version.replace(/^PostgreSQL ([\d.]+).*$/, '$1') || h.version}
          </span>
        </div>
      )}
      <div className="pcdar-panel__bar" style={{ marginTop: 4 }}>
        <span className="pcdar-panel__bar-label">Connections ({rows.length})</span>
      </div>
      {rows.length === 0 ? (
        <div className="pcdar-panel__empty">No active queries.</div>
      ) : (
        rows.map((q) => {
          const idleInTx = q.state === 'idle in transaction';
          // EI-1536: `duration_seconds` is time-since-query_start for EVERY row, not
          // just running ones — for a non-active conn (idle, incl. long-lived LISTEN
          // listeners) query_start is when its LAST (already-finished) query started,
          // so it's "time since it last ran anything", not a running-query duration.
          // Only an `active` row has a query genuinely in flight that can be slow.
          const slow = q.state === 'active' && q.duration_seconds > 5;
          return (
            <div key={q.pid} className="pcdar-row">
              <span
                className={`pcdar-dot ${idleInTx ? 'is-down' : slow ? '' : 'is-up'}`}
                aria-hidden="true"
              />
              <div className="pcdar-row__main">
                <div className="pcdar-row__sub" title={q.query}>
                  {q.query.replace(/\s+/g, ' ').slice(0, 80)}
                </div>
                <div className="pcdar-row__sub" style={{ fontFamily: 'inherit' }}>
                  pid {q.pid} · {q.state ?? '?'} · {fmtDur(q.duration_seconds)}
                  {q.application_name ? ` · ${q.application_name}` : ''}
                </div>
              </div>
              {idleInTx ? (
                <span className="pcdar-pill is-bad">idle-in-tx</span>
              ) : slow ? (
                <span className="pcdar-pill is-warn">slow</span>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}
