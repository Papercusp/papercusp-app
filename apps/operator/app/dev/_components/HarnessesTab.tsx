'use client';

import { useEffect, useState } from 'react';
import { VirtualGrid, type ColumnDef } from '@papercusp/grid-core';
import { useLexicon } from '@/lib/useLexicon';

interface HarnessRow {
  slug: string;
  path: string;
  workspaceId: string;
  workspaceName: string;
  harness_kind?: string;
  health?: {
    ok: boolean;
    alive: boolean;
    escalated: boolean;
    features: { total: number; passed: number; failing: number; inProgress: number; blocked: number };
    lastRunAgeSeconds: number | null;
    ghostRate: number;
  } | null;
  healthError?: string;
}

interface Props {
  workspaceIds: string[] | null;
}

export function fmtAge(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export default function HarnessesTab({ workspaceIds }: Props) {
  const t = useLexicon();
  const [rows, setRows] = useState<HarnessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    fetch(`/api/agent-tools/dev/harnesses?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceIds }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        const text = d?.content?.[0]?.text;
        const parsed = JSON.parse(text);
        if (cancelled) return;
        setRows(parsed.harnesses ?? []);
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
  }, [workspaceIds]);

  return (
    <div className="pc-dev-tab-body">
      <header className="pc-dev-tab-header">
        <h2>{t('pot', { plural: true })}</h2>
        <span className="pc-dev-muted">{rows.length} across selected workspaces</span>
      </header>
      {loading && <div className="pc-dev-muted">loading…</div>}
      {error && <div className="pc-dev-api-err">{error}</div>}
      {!loading && !error && (
        <VirtualGrid<HarnessRow>
          columns={HARNESS_COLUMNS}
          rows={rows}
          getRowId={(r) => `${r.workspaceId}::${r.slug}`}
          rowMinHeight={28}
          estimateRowHeight={28}
          headerHeight={32}
          scrollStyle={{ maxHeight: 640, overflow: 'auto' }}
        />
      )}
    </div>
  );
}

const HARNESS_COLUMNS: ColumnDef<HarnessRow>[] = [
  {
    key: 'slug', header: 'Slug', width: 2,
    toCopyText: (r) => r.slug,
    render: ({ row }) => <a href={`/harness/${row.slug}`} className="pc-dev-slug">{row.slug}</a>,
  },
  { key: 'workspace', header: 'Workspace', width: 1.5, toCopyText: (r) => r.workspaceName, render: ({ row }) => <span className="pc-dev-muted">{row.workspaceName}</span> },
  { key: 'kind', header: 'Kind', width: 1, toCopyText: (r) => r.harness_kind ?? '', render: ({ row }) => <span className="pc-dev-muted">{row.harness_kind ?? '—'}</span> },
  {
    key: 'alive', header: 'Alive', width: 0.7, align: 'center',
    toCopyText: (r) => r.health ? (r.health.alive ? 'alive' : 'dead') : '',
    render: ({ row }) => row.health ? (row.health.alive ? <span className="pc-dev-ok">●</span> : <span className="pc-dev-muted">○</span>) : <>—</>,
  },
  {
    key: 'esc', header: 'Esc', width: 0.5, align: 'center',
    toCopyText: (r) => r.health?.escalated ? '!' : '',
    render: ({ row }) => row.health?.escalated ? <span className="pc-dev-api-err">!</span> : <></>,
  },
  { key: 'total', header: 'Total', width: 0.7, align: 'right', toCopyText: (r) => String(r.health?.features.total ?? ''), render: ({ row }) => <>{row.health?.features.total ?? '—'}</> },
  { key: 'passed', header: 'Passed', width: 0.7, align: 'right', toCopyText: (r) => String(r.health?.features.passed ?? ''), render: ({ row }) => <>{row.health?.features.passed ?? '—'}</> },
  {
    key: 'failing', header: 'Failing', width: 0.8, align: 'right',
    toCopyText: (r) => String(r.health?.features.failing ?? ''),
    render: ({ row }) => <span className={row.health?.features.failing ? 'pc-dev-api-err' : ''}>{row.health?.features.failing ?? '—'}</span>,
  },
  { key: 'progress', header: 'In progress', width: 0.9, align: 'right', toCopyText: (r) => String(r.health?.features.inProgress ?? ''), render: ({ row }) => <>{row.health?.features.inProgress ?? '—'}</> },
  { key: 'blocked', header: 'Blocked', width: 0.8, align: 'right', toCopyText: (r) => String(r.health?.features.blocked ?? ''), render: ({ row }) => <>{row.health?.features.blocked ?? '—'}</> },
  { key: 'lastrun', header: 'Last run', width: 0.9, align: 'right', toCopyText: (r) => fmtAge(r.health?.lastRunAgeSeconds), render: ({ row }) => <span className="pc-dev-muted">{fmtAge(row.health?.lastRunAgeSeconds)}</span> },
  {
    key: 'ghost', header: 'Ghost', width: 0.7, align: 'right',
    toCopyText: (r) => r.health?.ghostRate == null ? '' : `${(r.health.ghostRate * 100).toFixed(0)}%`,
    render: ({ row }) => <span className="pc-dev-muted">{row.health?.ghostRate == null ? '—' : `${(row.health.ghostRate * 100).toFixed(0)}%`}</span>,
  },
  {
    key: 'verdict', header: 'Verdict', width: 1, align: 'center',
    toCopyText: (r) => !r.health ? (r.healthError ?? '') : r.health.ok ? 'OK' : 'FAIL',
    render: ({ row }) => !row.health
      ? <span className="pc-dev-muted">{row.healthError ?? '—'}</span>
      : row.health.ok ? <span className="pc-dev-ok">OK</span> : <span className="pc-dev-api-err">FAIL</span>,
  },
];
