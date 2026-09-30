'use client';


import { Tooltip } from '@/app/harness/Tooltip';
import { useCallback, useState } from 'react';
import dynamic from '@/lib/router-compat/dynamic';
// Points the Monaco AMD loader at our local mirror. Without it Monaco fetches
// ~4MB from jsdelivr on first mount (cdn-egress-fixes-2026-08-02 P-001).
import '@/app/_components/monaco-runtime';
import { useQueryState, parseAsStringEnum } from 'nuqs';
import { Select } from '@/app/harness/Select';
import { VirtualGrid, type ColumnDef } from '@papercusp/grid-core';

/**
 * /dev SQL tab — Monaco-backed read-only SQL playground.
 *
 * Posts the editor buffer to /api/dev/sql which gates on a SELECT/WITH/
 * EXPLAIN/SHOW/TABLE/VALUES allowlist, runs the query inside a
 * transaction with statement_timeout, and rolls back on completion so
 * even read-side-effects (FOR UPDATE etc.) don't escape.
 *
 * Role toggle (admin/app) mirrors the Tables tab — admin bypasses RLS,
 * app honors the active workspace's policies.
 */

const Monaco = dynamic(() => import('@monaco-editor/react'), { ssr: false });

interface QueryResult {
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
  truncated?: boolean;
  durationMs?: number;
  role?: string;
  statements?: number;
  error?: string;
  sqlState?: string;
}

const DEFAULT_SQL = `-- Read-only SQL playground.
-- Only SELECT / WITH / EXPLAIN / SHOW / TABLE / VALUES accepted.
-- Statements run inside a transaction that always rolls back.

SELECT slug, status, updated_ts
  FROM harness_shared.projects
 ORDER BY updated_ts DESC
 LIMIT 10;
`;

export default function SqlTab() {
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [role, setRole] = useQueryState(
    'sqlRole',
    parseAsStringEnum<'admin' | 'app'>(['admin', 'app']).withDefault('admin'),
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch('/api/dev/sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, role }),
      });
      const d = (await r.json()) as QueryResult;
      setResult(d);
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [sql, role]);

  return (
    <div className="pc-sql-shell">
      <div className="pc-sql-toolbar">
        <div className="pc-sql-title">
          <strong>SQL</strong>
          <span>read-only · rollback transaction</span>
        </div>
        <Tooltip label="Cmd/Ctrl+Enter"><button
          type="button"
          className="pc-sql-run pc-dev-btn-primary"
          onClick={run}
          disabled={busy}

        >
          {busy ? 'Running…' : '▶ Run'}
        </button></Tooltip>
        <label className="pc-sql-role">
          Role:
          <Select
            value={role}
            onChange={(v) => setRole(v as 'admin' | 'app')}
            ariaLabel="SQL role"
            options={[
              { value: 'admin', label: 'admin (RLS bypass)' },
              { value: 'app', label: 'app (workspace-scoped)' },
            ]}
          />
        </label>
        {result && !result.error && (
          <span className="pc-sql-stats">
            {result.rowCount?.toLocaleString()} rows · {result.durationMs}ms
            {result.truncated && ' · truncated to 1000'}
          </span>
        )}
        {result?.error && (
          <span className="pc-sql-err-summary">
            {result.sqlState ? `[${result.sqlState}] ` : ''}error
          </span>
        )}
        <span className="pc-sql-hint">⌘+Enter / Ctrl+Enter to run</span>
      </div>

      <div className="pc-sql-editor">
        <Monaco
          height="100%"
          defaultLanguage="sql"
          theme="vs-dark"
          value={sql}
          onChange={(v) => setSql(v ?? '')}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            lineNumbers: 'on',
            renderWhitespace: 'selection',
          }}
          onMount={(editor, monaco) => {
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
              void run();
            });
          }}
        />
      </div>

      <div className="pc-sql-results">
        {!result && <div className="pc-sql-empty">Run a query to see results.</div>}
        {result?.error && (
          <pre className="pc-sql-err">{result.error}</pre>
        )}
        {result && !result.error && result.rows && (
          <>
            {result.rows.length === 0 ? (
              <div className="pc-sql-empty">No rows returned.</div>
            ) : (() => {
              const cols: ColumnDef<Record<string, unknown>>[] = (result.columns ?? []).map((c) => ({
                key: `col:${c}`,
                header: c,
                width: 1,
                toCopyText: (r) => renderCell(r[c]),
                render: ({ row }) => <>{renderCell(row[c])}</>,
              }));
              return (
                <VirtualGrid<Record<string, unknown>>
                  columns={cols}
                  rows={result.rows}
                  getRowId={(r) => JSON.stringify(r)}
                  rowMinHeight={28}
                  estimateRowHeight={28}
                  headerHeight={32}
                  scrollStyle={{ maxHeight: 560, overflow: 'auto' }}
                />
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}

export function renderCell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 197) + '…' : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? s.slice(0, 197) + '…' : s;
  } catch {
    return String(v);
  }
}
