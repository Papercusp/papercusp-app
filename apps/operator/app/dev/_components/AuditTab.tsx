'use client';

import { useEffect, useState } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { Select } from '@/app/harness/Select';

interface Entry {
  id: string;
  ts: number;
  workspace_id: string;
  actor: string | null;
  action: string;
  subject: string | null;
  details: unknown;
}

interface Props {
  workspaceIds: string[] | null;
}

function fmtTs(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** Compact details preview for the audit grid: JSON, capped at 100 chars,
 *  '—' for an empty/missing details payload. */
export function fmtAuditDetails(details: unknown): string {
  return details ? JSON.stringify(details).slice(0, 100) : '—';
}

export default function AuditTab({ workspaceIds }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoursParam, setHoursParam] = useQueryState(
    'auditHours',
    parseAsStringEnum(['1', '6', '24', '168', '720']).withDefault('24'),
  );
  const hours = Number(hoursParam);

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
    fetch(`/api/agent-tools/dev/audit?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceIds, hours, limit: 200 }),
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
  }, [workspaceIds, hours]);

  return (
    <div className="pc-dev-tab-body">
      <header className="pc-dev-tab-header">
        <h2>Audit log</h2>
        <label className="pc-dev-muted">
          window
          <Select
            value={hoursParam}
            onChange={(v) => setHoursParam(v as '1' | '6' | '24' | '168' | '720')}
            ariaLabel="Audit log time window"
            options={[
              { value: '1', label: '1h' },
              { value: '6', label: '6h' },
              { value: '24', label: '24h' },
              { value: '168', label: '7d' },
              { value: '720', label: '30d' },
            ]}
          />
        </label>
      </header>
      {loading && <div className="pc-dev-muted">loading…</div>}
      {error && <div className="pc-dev-api-err">{error}</div>}
      {!loading && !error && (
        <div style={{ height: Math.min(640, 32 + entries.length * 28 + 4) }}>
          <RichGrid<Entry>
            columns={AUDIT_COLUMNS}
            rows={entries}
            getRowId={(r) => r.id}
            rowMinHeight={28}
            headerHeight={32}
          />
        </div>
      )}
    </div>
  );
}

const AUDIT_COLUMNS: ColumnDef<Entry>[] = [
  { key: 'time', header: 'Time', width: 1.5, toCopyText: (r) => new Date(r.ts).toISOString(), render: ({ row }) => <span className="pc-dev-muted">{fmtTs(row.ts)}</span> },
  { key: 'workspace', header: 'Workspace', width: 1.5, toCopyText: (r) => r.workspace_id, render: ({ row }) => <span className="pc-dev-muted">{row.workspace_id}</span> },
  { key: 'actor', header: 'Actor', width: 1, toCopyText: (r) => r.actor ?? '', render: ({ row }) => <>{row.actor ?? '—'}</> },
  { key: 'action', header: 'Action', width: 1.5, toCopyText: (r) => r.action, render: ({ row }) => <span className="pc-dev-slug">{row.action}</span> },
  { key: 'subject', header: 'Subject', width: 1.5, toCopyText: (r) => r.subject ?? '', render: ({ row }) => <>{row.subject ?? '—'}</> },
  {
    key: 'details', header: 'Details', width: 3,
    toCopyText: (r) => r.details ? JSON.stringify(r.details) : '',
    render: ({ row }) => <span className="pc-dev-muted pc-dev-details">{fmtAuditDetails(row.details)}</span>,
  },
];
