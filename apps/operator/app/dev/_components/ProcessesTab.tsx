'use client';


import { Tooltip } from '@/app/harness/Tooltip';
import { useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import { VirtualGrid, type ColumnDef } from '@papercusp/grid-core';
import { useLexicon } from '@/lib/useLexicon';

export interface Process {
  pid: number;
  kind: string;
  executable: string | null;
  role: string | null;
  build: string | null;
  started_at: string | null;
  cwd: string | null;
  started_seconds_ago: number;
  harness_slug: string | null;
  workspace_id: string | null;
}

export const KILLABLE_KINDS = new Set(['run.sh', 'omp', 'claude']);
export const PROTECTED_REASONS: Record<string, string> = {
  paperclip: 'killing paperclip would break the auto-run loop',
  next: 'killing the dev/prod server would break this very page',
  pty: 'pty processes back interactive sessions; kill from the terminal',
  other: 'unknown kind — not killable from /dev',
};

export function fmtAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export const KIND_ORDER: Record<string, number> = {
  'run.sh': 0,
  omp: 1,
  claude: 2,
  paperclip: 3,
  pty: 4,
  next: 5,
};

export const ALL_KINDS = ['run.sh', 'omp', 'claude', 'paperclip', 'pty', 'next'] as const;

/** Why a process of `kind` may not be killed from /dev, or null if killable. */
export function protectedReasonFor(kind: string): string | null {
  if (KILLABLE_KINDS.has(kind)) return null;
  return PROTECTED_REASONS[kind] ?? 'kind not in killable allowlist';
}

/**
 * Parse the comma-separated `processKinds` URL param into a validated Set,
 * dropping any token not in the known ALL_KINDS allowlist. Empty string =
 * empty set (filter everything out).
 */
export function parseKinds(param: string): Set<string> {
  if (param === '') return new Set<string>();
  const allowed = new Set<string>(ALL_KINDS);
  return new Set(param.split(',').filter((k) => allowed.has(k)));
}

/** Stable display order: by kind rank, then youngest-first within a kind. */
export function sortProcesses<T extends { kind: string; started_seconds_ago: number }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99) ||
      a.started_seconds_ago - b.started_seconds_ago,
  );
}

export interface KillModalState {
  process: Process;
  confirmText: string;
  signal: 'SIGTERM' | 'SIGKILL';
  busy: boolean;
  result: string | null;
}

export default function ProcessesTab() {
  const t = useLexicon();
  const [processes, setProcesses] = useState<Process[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kindsParam, setKindsParam] = useQueryState(
    'processKinds',
    parseAsString.withDefault(ALL_KINDS.join(',')),
  );
  const [killModal, setKillModal] = useState<KillModalState | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const params = new URLSearchParams({
        workspace: 'default',
        role: 'architect',
        run: 'dev-page',
        spawn: 'dev-page',
      });
      try {
        const r = await fetch(`/api/agent-tools/dev/processes?${params}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        const parsed = JSON.parse(d.content[0].text);
        if (cancelled) return;
        setProcesses(parsed.processes ?? []);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    }
    refresh();
    // Documented polling exception (audit P-058): the process list is OS
    // state scanned server-side — there is no PG table to drive a sync
    // invalidation. 5s while the dev tab is visible; paused when hidden.
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const kinds = useMemo(() => parseKinds(kindsParam), [kindsParam]);

  const filtered = useMemo(
    () => processes.filter((p) => kinds.has(p.kind)),
    [processes, kinds],
  );

  const byKind = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of processes) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
    return counts;
  }, [processes]);

  function toggleKind(k: string) {
    const next = new Set(kinds);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setKindsParam([...next].join(','));
  }

  return (
    <div className="pc-dev-tab-body">
      <header className="pc-dev-tab-header">
        <h2>Processes</h2>
        <span className="pc-dev-muted">
          {filtered.length} of {processes.length} · refreshes every 5s
        </span>
      </header>

      <div className="pc-dev-toggles" style={{ marginBottom: 12 }}>
        {ALL_KINDS.map((k) => (
          <label key={k} className="pc-dev-toggle">
            <Checkbox checked={kinds.has(k)} onChange={() => toggleKind(k)} />
            <span>
              {k} <span className="pc-dev-muted">{byKind[k] ?? 0}</span>
            </span>
          </label>
        ))}
      </div>

      {loading && <div className="pc-dev-muted">loading…</div>}
      {error && <div className="pc-dev-api-err">{error}</div>}
      {!loading && !error && (() => {
        const sortedRows = sortProcesses(filtered);
        const columns: ColumnDef<Process>[] = [
          { key: 'pid', header: 'PID', width: 0.8, align: 'right', toCopyText: (r) => String(r.pid), render: ({ row }) => <span className="pc-dev-muted">{row.pid}</span> },
          { key: 'kind', header: 'Kind', width: 1, toCopyText: (r) => r.kind, render: ({ row }) => <span className="pc-dev-slug">{row.kind}</span> },
          { key: 'age', header: 'Age', width: 0.7, align: 'right', toCopyText: (r) => fmtAge(r.started_seconds_ago), render: ({ row }) => <span className="pc-dev-muted">{fmtAge(row.started_seconds_ago)}</span> },
          {
            key: 'started', header: 'Started', width: 1.8,
            toCopyText: (r) => r.started_at ?? '',
            render: ({ row }) => <span className="pc-dev-muted" title={row.started_at ?? ''}>{row.started_at ?? '—'}</span>,
          },
          { key: 'executable', header: 'Executable', width: 1.3, toCopyText: (r) => r.executable ?? '', render: ({ row }) => <span className="pc-dev-query">{row.executable ?? '—'}</span> },
          { key: 'role', header: 'Role', width: 1.2, toCopyText: (r) => r.role ?? '', render: ({ row }) => <span className="pc-dev-slug">{row.role ?? '—'}</span> },
          { key: 'build', header: 'Build', width: 1.5, toCopyText: (r) => r.build ?? '', render: ({ row }) => <span className="pc-dev-muted">{row.build ?? '—'}</span> },
          { key: 'harness', header: t('pot'), width: 1.5, toCopyText: (r) => r.harness_slug ?? '', render: ({ row }) => <>{row.harness_slug ?? '—'}</> },
          { key: 'ws', header: 'Workspace', width: 1.2, toCopyText: (r) => r.workspace_id ?? '', render: ({ row }) => <span className="pc-dev-muted">{row.workspace_id ?? '—'}</span> },
          {
            key: 'cwd', header: 'CWD', width: 2,
            toCopyText: (r) => r.cwd ?? '',
            render: ({ row }) => <span className="pc-dev-muted pc-dev-details" title={row.cwd ?? ''}>{row.cwd ?? '—'}</span>,
          },
          {
            key: 'kill', header: '', width: 0.6, align: 'center',
            render: ({ row }) => {
              const protectedReason = protectedReasonFor(row.kind);
              const killable = protectedReason === null;
              return (
                <Tooltip label={killable ? `Send SIGTERM to pid ${row.pid}` : `Protected: ${protectedReason}`}><button
                  type="button"
                  className="pc-dev-btn-mini pc-dev-btn-danger"
                  disabled={!killable}

                  onClick={() =>
                    setKillModal({ process: row, confirmText: '', signal: 'SIGTERM', busy: false, result: null })
                  }
                >kill</button></Tooltip>
              );
            },
          },
        ];
        return (
          <VirtualGrid<Process>
            columns={columns}
            rows={sortedRows}
            getRowId={(r) => String(r.pid)}
            rowMinHeight={28}
            estimateRowHeight={28}
            headerHeight={32}
            scrollStyle={{ maxHeight: 640, overflow: 'auto' }}
          />
        );
      })()}
      {killModal && <KillModal state={killModal} setState={setKillModal} />}
    </div>
  );
}

export function KillModal({
  state,
  setState,
}: {
  state: KillModalState;
  setState: (s: KillModalState | null) => void;
}) {
  const t = useLexicon();
  const { process: p } = state;
  const pidStr = String(p.pid);
  const canKill = state.confirmText === pidStr && !state.busy;

  async function doKill() {
    setState({ ...state, busy: true, result: null });
    try {
      const r = await fetch('/api/dev/processes/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: p.pid, signal: state.signal }),
      });
      const body = await r.json();
      if (body?.ok) {
        setState({
          ...state,
          busy: false,
          result: `✓ ${state.signal} sent to pid ${p.pid}`,
        });
      } else {
        setState({
          ...state,
          busy: false,
          result: `failed: ${body?.error ?? `HTTP ${r.status}`}${body?.detail ? ` (${body.detail})` : ''}`,
        });
      }
    } catch (err) {
      setState({
        ...state,
        busy: false,
        result: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <div className="pc-dev-modal-backdrop" onClick={() => setState(null)}>
      <div className="pc-dev-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Kill process {p.pid}?</h3>
        <div className="pc-dev-kv">
          <span>kind</span>
          <span className="pc-dev-slug">{p.kind}</span>
          <span>cwd</span>
          <span className="pc-dev-muted">{p.cwd ?? '—'}</span>
          <span>started</span>
          <span className="pc-dev-muted">{p.started_at ?? '—'}</span>
          <span>executable</span>
          <span className="pc-dev-query">{p.executable ?? '—'}</span>
          <span>role</span>
          <span className="pc-dev-slug">{p.role ?? '—'}</span>
          <span>build</span>
          <span className="pc-dev-muted">{p.build ?? '—'}</span>
          <span>{t('pot', { lower: true })}</span>
          <span>{p.harness_slug ?? '—'}</span>
        </div>

        <div className="pc-dev-modal-row">
          <label className="pc-dev-muted">signal</label>
          <Select
            value={state.signal}
            onChange={(v) => setState({ ...state, signal: v as 'SIGTERM' | 'SIGKILL' })}
            ariaLabel="signal"
            options={[
              { value: 'SIGTERM', label: 'SIGTERM (graceful)' },
              { value: 'SIGKILL', label: 'SIGKILL (force)' },
            ]}
          />
        </div>

        <div className="pc-dev-modal-row">
          <label className="pc-dev-muted">
            type <strong>{pidStr}</strong> to confirm
          </label>
          <input
            type="text"
            value={state.confirmText}
            onChange={(e) => setState({ ...state, confirmText: e.target.value })}
            className="pc-dev-input"
            placeholder={pidStr}
            autoFocus
          />
        </div>

        {state.result && (
          <div
            className={
              state.result.startsWith('✓') ? 'pc-dev-ok' : 'pc-dev-api-err'
            }
          >
            {state.result}
          </div>
        )}

        <div className="pc-dev-modal-actions">
          <button
            type="button"
            className="pc-dev-btn-mini"
            onClick={() => setState(null)}
          >
            cancel
          </button>
          <button
            type="button"
            className="pc-dev-btn-primary pc-dev-btn-danger"
            disabled={!canKill}
            onClick={doKill}
          >
            {state.busy ? 'sending…' : `send ${state.signal}`}
          </button>
        </div>
      </div>
    </div>
  );
}
