'use client';


import { Tooltip } from '@/app/harness/Tooltip';
import { useEffect, useState, useCallback } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { useLexicon } from '@/lib/useLexicon';

interface Entry {
  spawn_id: string;
  parent_spawn_id: string | null;
  workspace_id: string;
  harness_slug: string | null;
  role: string | null;
  run_id: string | null;
  started_at: string;
  ended_at: string;
  tool_count: number;
  error_count: number;
  total_duration_ms: number;
}

interface Detail {
  spawn_id: string;
  agent: {
    parent_role: string | null;
    child_role: string | null;
    feature_id: string | null;
    chunk_id: string | null;
    status: string | null;
    duration_ms: number | null;
    exit_code: number | null;
    output_tail: string | null;
    error_message: string | null;
  } | null;
  invocations: Array<{
    id: string;
    tool_name: string;
    invoked_at: string;
    duration_ms: number | null;
    status: string;
    error_message: string | null;
    args_json: unknown;
  }>;
  children: Array<{
    spawn_id: string;
    child_role: string | null;
    status: string | null;
    tool_count: number;
    error_count: number;
  }>;
  related_chats: Array<{ id: string; role: string; title: string | null; updated_at: string }>;
}

import type { RerunContext } from '../page';

interface Props {
  workspaceIds: string[] | null;
  onRerun: (ctx: RerunContext) => void;
}

export function fmtRelTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

const CTX = new URLSearchParams({
  workspace: 'default',
  role: 'architect',
  run: 'dev-page',
  spawn: 'dev-page',
});

export default function SessionsTab({ workspaceIds, onRerun }: Props) {
  const t = useLexicon();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoursParam, setHoursParam] = useQueryState(
    'sessionHours',
    parseAsStringEnum(['1', '6', '24', '168', '720']).withDefault('24'),
  );
  const hours = Number(hoursParam);
  // Transport filter: URL-backed, comma-separated, empty = no filter.
  // Same shape as TelemetryTab. ui:get_state surfaces the selection
  // to agents and ui:dispatch set_url can drive it from outside.
  const [transportParam, setTransportParam] = useQueryState(
    'sessionTransport',
    parseAsString.withDefault(''),
  );
  const transports = transportParam ? transportParam.split(',') : null;
  // Selected spawn for drilldown. nuqs-backed so:
  //   (a) the URL deep-links to a specific spawn
  //   (b) `ui:get_state` surfaces the selection to agents
  //   (c) `ui:dispatch set_url` can drive selection from outside
  const [expanded, setExpanded] = useQueryState('spawn', parseAsString);
  const [details, setDetails] = useState<Record<string, Detail | null>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/agent-tools/dev/sessions?${CTX}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceIds, transports, hours, limit: 200 }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        const parsed = JSON.parse(d.content[0].text);
        if (cancelled) return;
        setEntries(parsed.entries ?? []);
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
    const next = new Set(transportSet);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    void setTransportParam(next.size === 0 ? '' : Array.from(next).join(','));
  };

  async function toggleExpand(spawnId: string) {
    if (expanded === spawnId) {
      setExpanded(null);
      return;
    }
    setExpanded(spawnId);
    if (!(spawnId in details)) {
      setDetailLoading((d) => ({ ...d, [spawnId]: true }));
      try {
        const r = await fetch(`/api/agent-tools/dev/session_detail?${CTX}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ spawnId }),
        });
        const d = await r.json();
        const parsed = JSON.parse(d.content[0].text);
        setDetails((m) => ({ ...m, [spawnId]: parsed.error ? null : parsed }));
      } catch {
        setDetails((m) => ({ ...m, [spawnId]: null }));
      } finally {
        setDetailLoading((d) => ({ ...d, [spawnId]: false }));
      }
    }
  }

  return (
    <div className="pc-dev-tab-body">
      <header className="pc-dev-tab-header">
        <h2>Sessions</h2>
        <span className="pc-dev-muted">{entries.length} spawns</span>
        <label className="pc-dev-muted">
          window
          <Select
            value={hoursParam}
            onChange={(v) => setHoursParam(v as '1' | '6' | '24' | '168' | '720')}
            ariaLabel="window"
            options={[
              { value: '1', label: '1h' },
              { value: '6', label: '6h' },
              { value: '24', label: '24h' },
              { value: '168', label: '7d' },
              { value: '720', label: '30d' },
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
      {!loading && !error && (
        <div style={{ height: Math.min(720, 32 + entries.length * 28 + 4) }}>
          <RichGrid<Entry>
            columns={[
              {
                key: 'expand', header: '', width: 0.4, align: 'center',
                render: ({ row }) => <span className="pc-dev-muted">{expanded === row.spawn_id ? '▾' : '▸'}</span>,
              },
              { key: 'spawn', header: 'Spawn', width: 1.2, toCopyText: (r) => r.spawn_id, render: ({ row }) => <span className="pc-dev-slug" title={row.spawn_id}>{row.spawn_id.slice(0, 12)}…</span> },
              { key: 'started', header: 'Started', width: 1, toCopyText: (r) => r.started_at, render: ({ row }) => <span className="pc-dev-muted" title={row.started_at}>{fmtRelTime(row.started_at)}</span> },
              { key: 'ws', header: 'Workspace', width: 1, toCopyText: (r) => r.workspace_id, render: ({ row }) => <span className="pc-dev-muted">{row.workspace_id}</span> },
              { key: 'harness', header: t('pot'), width: 1.2, toCopyText: (r) => r.harness_slug ?? '', render: ({ row }) => <>{row.harness_slug ?? '—'}</> },
              { key: 'role', header: 'Role', width: 1, toCopyText: (r) => r.role ?? '', render: ({ row }) => <span className="pc-dev-muted">{row.role ?? '—'}</span> },
              { key: 'tools', header: 'Tools', width: 0.6, align: 'right', toCopyText: (r) => String(r.tool_count), render: ({ row }) => <>{row.tool_count}</> },
              {
                key: 'err', header: 'Errors', width: 0.7, align: 'right',
                toCopyText: (r) => r.error_count > 0 ? String(r.error_count) : '',
                render: ({ row }) => <span className={row.error_count ? 'pc-dev-api-err' : ''}>{row.error_count > 0 ? row.error_count : ''}</span>,
              },
              { key: 'dur', header: 'Duration', width: 0.9, align: 'right', toCopyText: (r) => fmtDuration(r.total_duration_ms), render: ({ row }) => <span className="pc-dev-muted">{fmtDuration(row.total_duration_ms)}</span> },
              {
                key: 'parent', header: 'Parent', width: 1,
                toCopyText: (r) => r.parent_spawn_id ?? '',
                render: ({ row }) => <span className="pc-dev-muted" title={row.parent_spawn_id ?? ''}>{row.parent_spawn_id ? `${row.parent_spawn_id.slice(0, 8)}…` : '—'}</span>,
              },
            ]}
            rows={entries}
            getRowId={(r) => r.spawn_id}
            rowMinHeight={28}
            headerHeight={32}
            expandedRowKey={expanded}
            onRowClick={(row) => toggleExpand(row.spawn_id)}
            renderExpandedRow={(row) => {
              const detail = details[row.spawn_id];
              return (
                <div className="pc-dev-detail-row" style={{ padding: 12 }}>
                  {detailLoading[row.spawn_id] && <div className="pc-dev-muted">loading detail…</div>}
                  {!detailLoading[row.spawn_id] && !detail && <div className="pc-dev-muted">no detail available</div>}
                  {detail && <DetailPanel detail={detail} entry={row} onRerun={onRerun} />}
                </div>
              );
            }}
          />
        </div>
      )}
    </div>
  );
}

interface OmpSession {
  id: string;
  filePath: string;
  cwd: string;
  timestamp: string;
  title: string;
  matchKind: 'exact-cwd' | 'cwd-prefix' | 'time-only';
  timeDriftMs: number;
}

function DetailPanel({
  detail,
  entry,
  onRerun,
}: {
  detail: Detail;
  entry: Entry;
  onRerun: (ctx: RerunContext) => void;
}) {
  const [omp, setOmp] = useState<OmpSession | null | 'loading' | 'none'>('loading');

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      workspace: 'default',
      role: 'architect',
      run: 'dev-page',
      spawn: 'dev-page',
    });
    fetch(`/api/agent-tools/dev/omp_session?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spawnId: entry.spawn_id, mode: 'find' }),
    })
      .then(async (r) => {
        if (!r.ok) {
          if (!cancelled) setOmp('none');
          return;
        }
        const d = await r.json();
        const parsed = JSON.parse(d.content[0].text);
        if (cancelled) return;
        if (parsed && parsed.id && parsed.filePath) setOmp(parsed as OmpSession);
        else setOmp('none');
      })
      .catch(() => {
        if (!cancelled) setOmp('none');
      });
    return () => {
      cancelled = true;
    };
  }, [entry.spawn_id]);
  return (
    <div className="pc-dev-session-detail">
      {detail.agent && (
        <section>
          <h4 className="pc-dev-rail-h">Agent</h4>
          <div className="pc-dev-kv">
            <span>parent_role</span>
            <span>{detail.agent.parent_role ?? '—'}</span>
            <span>child_role</span>
            <span>{detail.agent.child_role ?? '—'}</span>
            <span>feature</span>
            <span>{detail.agent.feature_id ?? '—'}</span>
            <span>chunk</span>
            <span>{detail.agent.chunk_id ?? '—'}</span>
            <span>status</span>
            <span
              className={
                detail.agent.status === 'failed' ? 'pc-dev-api-err' : 'pc-dev-ok'
              }
            >
              {detail.agent.status ?? '—'}
            </span>
            <span>exit_code</span>
            <span
              className={
                detail.agent.exit_code !== null && detail.agent.exit_code !== 0
                  ? 'pc-dev-api-err'
                  : ''
              }
            >
              {detail.agent.exit_code ?? '—'}
            </span>
          </div>
          {detail.agent.error_message && (
            <pre className="pc-dev-pre pc-dev-api-err">
              {detail.agent.error_message}
            </pre>
          )}
          {detail.agent.output_tail && (
            <pre className="pc-dev-pre">{detail.agent.output_tail.slice(-2000)}</pre>
          )}
        </section>
      )}

      <section>
        <h4 className="pc-dev-rail-h">
          Tool invocations <span className="pc-dev-muted">{detail.invocations.length}</span>
        </h4>
        {detail.invocations.length === 0 && <div className="pc-dev-muted">none</div>}
        {detail.invocations.length > 0 && (
          <div style={{ height: Math.min(360, 32 + detail.invocations.length * 28 + 4) }}>
            <RichGrid<Detail['invocations'][number]>
              columns={[
                { key: 'at', header: 'At', width: 1.2, toCopyText: (r) => r.invoked_at, render: ({ row }) => <span className="pc-dev-muted">{fmtRelTime(row.invoked_at)}</span> },
                { key: 'tool', header: 'Tool', width: 2, toCopyText: (r) => r.tool_name, render: ({ row }) => <span className="pc-dev-slug">{row.tool_name}</span> },
                {
                  key: 'status', header: 'Status', width: 0.8,
                  toCopyText: (r) => r.status,
                  render: ({ row }) => <span className={row.status !== 'ok' ? 'pc-dev-api-err' : 'pc-dev-ok'}>{row.status}</span>,
                },
                { key: 'dur', header: 'Duration', width: 0.8, align: 'right', toCopyText: (r) => r.duration_ms != null ? fmtDuration(r.duration_ms) : '', render: ({ row }) => <span className="pc-dev-muted">{row.duration_ms != null ? fmtDuration(row.duration_ms) : '—'}</span> },
                {
                  key: 'err', header: 'Error', width: 2,
                  toCopyText: (r) => r.error_message ?? '',
                  render: ({ row }) => <span className="pc-dev-muted pc-dev-details" title={row.error_message ?? ''}>{row.error_message ?? '—'}</span>,
                },
                {
                  key: 'open', header: '', width: 0.5, align: 'center',
                  render: ({ row }) => (
                    <Tooltip label="Open in API tab with this tool + spawn context"><button
                      type="button"
                      className="pc-dev-btn-mini"

                      onClick={() =>
                        onRerun({
                          toolName: row.tool_name,
                          workspace: entry.workspace_id,
                          harness: entry.harness_slug ?? '',
                          role: entry.role ?? 'architect',
                          run: entry.run_id ?? 'dev-page',
                          spawn: entry.spawn_id,
                          args:
                            row.args_json && typeof row.args_json === 'object' && !('_truncated' in (row.args_json as Record<string, unknown>))
                              ? (row.args_json as Record<string, unknown>)
                              : undefined,
                        })
                      }
                    >↗</button></Tooltip>
                  ),
                },
              ]}
              rows={detail.invocations}
              getRowId={(r) => r.id}
              rowMinHeight={28}
              headerHeight={32}
            />
          </div>
        )}
      </section>

      {detail.children.length > 0 && (
        <section>
          <h4 className="pc-dev-rail-h">
            Child spawns <span className="pc-dev-muted">{detail.children.length}</span>
          </h4>
          <div style={{ height: Math.min(240, 32 + detail.children.length * 28 + 4) }}>
            <RichGrid<Detail['children'][number]>
              columns={[
                { key: 'spawn', header: 'Spawn', width: 1.5, toCopyText: (r) => r.spawn_id, render: ({ row }) => <span className="pc-dev-slug" title={row.spawn_id}>{row.spawn_id.slice(0, 12)}…</span> },
                { key: 'role', header: 'Role', width: 1, toCopyText: (r) => r.child_role ?? '', render: ({ row }) => <span className="pc-dev-muted">{row.child_role ?? '—'}</span> },
                {
                  key: 'status', header: 'Status', width: 1,
                  toCopyText: (r) => r.status ?? '',
                  render: ({ row }) => <span className={row.status === 'failed' ? 'pc-dev-api-err' : 'pc-dev-ok'}>{row.status ?? '—'}</span>,
                },
                { key: 'tools', header: 'Tools', width: 0.7, align: 'right', toCopyText: (r) => String(r.tool_count), render: ({ row }) => <>{row.tool_count}</> },
                {
                  key: 'err', header: 'Errors', width: 0.7, align: 'right',
                  toCopyText: (r) => r.error_count > 0 ? String(r.error_count) : '',
                  render: ({ row }) => <span className={row.error_count ? 'pc-dev-api-err' : ''}>{row.error_count > 0 ? row.error_count : ''}</span>,
                },
              ]}
              rows={detail.children}
              getRowId={(r) => r.spawn_id}
              rowMinHeight={28}
              headerHeight={32}
            />
          </div>
        </section>
      )}

      {detail.related_chats.length > 0 && (
        <section>
          <h4 className="pc-dev-rail-h">
            Related chats <span className="pc-dev-muted">{detail.related_chats.length}</span>
          </h4>
          <ul className="pc-dev-chats">
            {detail.related_chats.map((c) => (
              <li key={c.id}>
                <span className="pc-dev-slug">{c.role}</span>{' '}
                <span>{c.title ?? '(untitled)'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <OmpSection ompState={omp} spawnId={entry.spawn_id} />
    </div>
  );
}

function OmpSection({
  ompState,
  spawnId,
}: {
  ompState: OmpSession | null | 'loading' | 'none';
  spawnId: string;
}) {
  const [transcript, setTranscript] = useState<{
    turns: Array<Record<string, unknown>>;
    totalLines: number;
    truncated: boolean;
  } | null>(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);

  const loadTranscript = useCallback(async () => {
    if (ompState === 'loading' || ompState === 'none' || ompState === null) return;
    setLoadingTranscript(true);
    setTranscriptError(null);
    try {
      const params = new URLSearchParams({
        workspace: 'default',
        role: 'architect',
        run: 'dev-page',
        spawn: 'dev-page',
      });
      const r = await fetch(`/api/agent-tools/dev/omp_session?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spawnId, mode: 'read', limit: 200 }),
      });
      const d = await r.json();
      const parsed = JSON.parse(d.content[0].text);
      if (parsed?.error) {
        setTranscriptError(parsed.error);
      } else {
        setTranscript({
          turns: parsed.turns ?? [],
          totalLines: parsed.totalLines ?? 0,
          truncated: !!parsed.truncated,
        });
      }
    } catch (err) {
      setTranscriptError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingTranscript(false);
    }
  }, [ompState, spawnId]);

  if (ompState === 'loading') {
    return (
      <section>
        <h4 className="pc-dev-rail-h">omp transcript</h4>
        <div className="pc-dev-muted">searching session files…</div>
      </section>
    );
  }
  if (ompState === 'none' || !ompState || typeof ompState === 'string') {
    return (
      <section>
        <h4 className="pc-dev-rail-h">omp transcript</h4>
        <div className="pc-dev-muted">no matching session file</div>
      </section>
    );
  }

  return (
    <section>
      <h4 className="pc-dev-rail-h">
        omp transcript{' '}
        <span className="pc-dev-muted">
          ({ompState.matchKind} match, drift {Math.round(ompState.timeDriftMs / 1000)}s)
        </span>
      </h4>
      <div className="pc-dev-kv">
        <span>id</span>
        <span className="pc-dev-slug">{ompState.id.slice(0, 24)}…</span>
        <span>cwd</span>
        <span className="pc-dev-muted">{ompState.cwd}</span>
        <span>file</span>
        <span className="pc-dev-muted pc-dev-details" title={ompState.filePath}>
          {ompState.filePath}
        </span>
        <span>title</span>
        <span>{ompState.title.slice(0, 100) || '—'}</span>
      </div>
      {!transcript && !loadingTranscript && (
        <button type="button" className="pc-dev-btn-mini" onClick={loadTranscript}>
          load transcript
        </button>
      )}
      {loadingTranscript && <div className="pc-dev-muted">loading…</div>}
      {transcriptError && <div className="pc-dev-api-err">{transcriptError}</div>}
      {transcript && (
        <Collapsible.Root className="pc-dev-transcript">
          <Collapsible.Trigger>
            {transcript.turns.length} turns
            {transcript.truncated ? ` of ${transcript.totalLines} (truncated)` : ''}
          </Collapsible.Trigger>
          <Collapsible.Content>
            <pre className="pc-dev-pre">
              {transcript.turns
                .map((t) => `[${t.type}] ${JSON.stringify(t).slice(0, 200)}`)
                .join('\n')}
            </pre>
          </Collapsible.Content>
        </Collapsible.Root>
      )}
    </section>
  );
}
