'use client';


import { Tooltip } from '@/app/harness/Tooltip';
import { useEffect, useState } from 'react';
import { useQueryState, parseAsStringEnum, parseAsString } from 'nuqs';
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';

interface Entry {
  tool_name: string;
  call_count: number;
  error_count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  workspaces: string[];
}

interface PollSuspect {
  tool_name: string;
  call_count: number;
  calls_per_hour: number;
  callers: number;
  calls_per_caller_per_hour: number;
  total_bytes: number;
  reason: string;
}

import type { RerunContext } from '../page';

interface Props {
  workspaceIds: string[] | null;
  onRerun: (ctx: RerunContext) => void;
}

/**
 * Error rate as a whole-number percentage of calls. 0 calls → 0% (no divide
 * by zero). Shared by the Err% column's value + its red-threshold class.
 */
export function errPct(callCount: number, errorCount: number): number {
  return callCount > 0 ? (errorCount / callCount) * 100 : 0;
}

/**
 * Toggle one transport in/out of the comma-separated `transport` URL param.
 * Empty result encodes as '' (no filter). Extracted from `toggleTransport`
 * so the set arithmetic can be pinned without the component.
 */
export function nextTransportParam(current: string | null, t: string): string {
  const set = new Set(current ? current.split(',') : []);
  if (set.has(t)) set.delete(t);
  else set.add(t);
  return set.size === 0 ? '' : Array.from(set).join(',');
}

export default function TelemetryTab({ workspaceIds, onRerun }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [pollSuspects, setPollSuspects] = useState<PollSuspect[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoursParam, setHoursParam] = useQueryState(
    'telemetryHours',
    parseAsStringEnum(['1', '6', '24', '72', '168']).withDefault('24'),
  );
  const hours = Number(hoursParam);
  // Transport filter: comma-separated, empty = no filter. URL-backed
  // so deep links + agent invocations can pre-filter via ui:get_state.
  const [transportParam, setTransportParam] = useQueryState(
    'transport',
    parseAsString.withDefault(''),
  );
  const transports = transportParam ? transportParam.split(',') : null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      workspace: 'default',
      role: 'architect',
      run: 'dev-page',
      spawn: 'dev-page',
    });
    fetch(`/api/agent-tools/dev/telemetry?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceIds, transports, hours, limit: 100 }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        const parsed = JSON.parse(d.content[0].text);
        if (cancelled) return;
        setEntries(parsed.entries ?? []);
        setPollSuspects(parsed.poll_suspects ?? []);
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
  }, [workspaceIds, transportParam, hours]);

  const transportSet = new Set(transports ?? []);
  const toggleTransport = (t: string): void => {
    void setTransportParam(nextTransportParam(transportParam, t));
  };

  return (
    <div className="pc-dev-tab-body">
      <header className="pc-dev-tab-header">
        <h2>Telemetry</h2>
        <label className="pc-dev-muted">
          window
          <Select
            value={hoursParam}
            onChange={(v) => setHoursParam(v as '1' | '6' | '24' | '72' | '168')}
            ariaLabel="window"
            options={[
              { value: '1', label: '1h' },
              { value: '6', label: '6h' },
              { value: '24', label: '24h' },
              { value: '72', label: '3d' },
              { value: '168', label: '7d' },
            ]}
          />
        </label>
        <fieldset className="pc-dev-muted" style={{ display: 'inline-flex', gap: 8, marginLeft: 12, alignItems: 'center', border: 0, padding: 0 }}>
          <span>transport:</span>
          {(['http', 'mcp', 'ipc', 'in_process', 'unknown'] as const).map((t) => (
            <label key={t} style={{ display: 'inline-flex', gap: 3, fontSize: 12 }}>
              <Checkbox checked={transportSet.has(t)} onChange={() => toggleTransport(t)} />
              {t}
            </label>
          ))}
          {transportSet.size > 0 && (
            <button
              type="button"
              onClick={() => void setTransportParam('')}
              className="pc-dev-input pc-dev-input-inline"
              style={{ padding: '2px 6px', fontSize: 11 }}
            >
              clear
            </button>
          )}
        </fieldset>
      </header>
      {loading && <div className="pc-dev-muted">loading…</div>}
      {error && <div className="pc-dev-api-err">{error}</div>}
      {!loading && !error && pollSuspects.length > 0 && (
        <div
          data-testid="poll-suspects-banner"
          className="pc-dev-api-err"
          style={{ padding: '8px 10px', marginBottom: 8, border: '1px solid currentColor', borderRadius: 4 }}
        >
          <strong>{pollSuspects.length} poll-suspect tool{pollSuspects.length === 1 ? '' : 's'}</strong> — polling-shaped
          call rate (EI-7029: expect an SSE/event subscription or a cached read instead)
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {pollSuspects.map((s) => (
              <li key={s.tool_name}>
                <span className="pc-dev-slug">{s.tool_name}</span> — {s.calls_per_hour}/hr, {s.callers} caller
                {s.callers === 1 ? '' : 's'} (~{s.calls_per_caller_per_hour}/hr each)
              </li>
            ))}
          </ul>
        </div>
      )}
      {!loading && !error && (
        <div style={{ height: Math.min(640, 32 + entries.length * 28 + 4) }}>
          <RichGrid<Entry>
            columns={[
              { key: 'tool', header: 'Tool', width: 2, toCopyText: (r) => r.tool_name, render: ({ row }) => <span className="pc-dev-slug">{row.tool_name}</span> },
              { key: 'calls', header: 'Calls', width: 0.8, align: 'right', toCopyText: (r) => String(r.call_count), render: ({ row }) => <>{row.call_count}</> },
              {
                key: 'errors', header: 'Errors', width: 0.8, align: 'right',
                toCopyText: (r) => String(r.error_count),
                render: ({ row }) => <span className={row.error_count ? 'pc-dev-api-err' : ''}>{row.error_count}</span>,
              },
              {
                key: 'errpct', header: 'Err %', width: 0.8, align: 'right',
                toCopyText: (r) => `${errPct(r.call_count, r.error_count).toFixed(0)}%`,
                render: ({ row }) => {
                  const p = errPct(row.call_count, row.error_count);
                  return <span className={p > 10 ? 'pc-dev-api-err' : 'pc-dev-muted'}>{p.toFixed(0)}%</span>;
                },
              },
              { key: 'p50', header: 'p50', width: 0.8, align: 'right', toCopyText: (r) => r.p50_ms != null ? `${r.p50_ms}ms` : '', render: ({ row }) => <span className="pc-dev-muted">{row.p50_ms ?? '—'}ms</span> },
              { key: 'p95', header: 'p95', width: 0.8, align: 'right', toCopyText: (r) => r.p95_ms != null ? `${r.p95_ms}ms` : '', render: ({ row }) => <span className="pc-dev-muted">{row.p95_ms ?? '—'}ms</span> },
              { key: 'ws', header: 'Workspaces', width: 2, toCopyText: (r) => r.workspaces.join(', '), render: ({ row }) => <span className="pc-dev-muted">{row.workspaces.join(', ')}</span> },
              {
                key: 'open', header: '', width: 0.5, align: 'center',
                render: ({ row }) => (
                  <Tooltip label="Open in API tab with this tool selected"><button
                    type="button"
                    className="pc-dev-btn-mini"

                    aria-label="Open in API tab with this tool selected"
                    onClick={() => onRerun({ toolName: row.tool_name, workspace: row.workspaces[0] })}
                  >↗</button></Tooltip>
                ),
              },
            ]}
            rows={entries}
            getRowId={(r) => r.tool_name}
            rowMinHeight={28}
            headerHeight={32}
          />
        </div>
      )}
    </div>
  );
}
