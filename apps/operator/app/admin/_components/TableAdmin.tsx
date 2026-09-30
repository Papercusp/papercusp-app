'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import '../admin-tables.css';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';

/**
 * Drizzle-driven CRUD admin UI factory.
 *
 * - Sidebar: every table in the admin allowlist (lib/admin-tables.ts).
 * - Main: paginated grid + "+ New row" modal + per-row Edit / Delete.
 * - Form fields are rendered from the column metadata of the chosen
 *   table — text → input, jsonb → textarea, bigint → number, bool →
 *   checkbox. Server-side `schemaOf(t).insert.parse` validates the
 *   body; issues are surfaced inline by-path.
 *
 * Two lines in lib/admin-tables.ts → new admin page. No bespoke UI.
 */

interface AdminTableEntry {
  exportName: string;
  label: string;
  schema: string;
  name: string;
  editableColumns: string[] | null;
  allowDelete: boolean;
}

export interface ColumnSummary {
  name: string;
  dataType: string;
  columnType: string;
  notNull: boolean;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  isUnique: boolean;
  generated: boolean;
}

interface TableDetail {
  exportName: string;
  schema: string;
  name: string;
  qualifiedName: string;
  columns: ColumnSummary[];
  primaryKey: string[];
}

interface RowsPayload {
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
  error?: string;
}

interface ValidationIssue { path: (string | number)[]; message: string; code: string }

const PAGE_SIZE = 50;

export default function TableAdmin() {
  const [tables, setTables] = useState<AdminTableEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TableDetail | null>(null);
  const [rows, setRows] = useState<RowsPayload | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; row: Record<string, unknown> } | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  useEffect(() => {
    void fetch('/api/admin/tables')
      .then((r) => r.json())
      .then((d: { tables: AdminTableEntry[] }) => {
        setTables(d.tables);
        if (d.tables[0] && !selected) setSelected(d.tables[0].exportName);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(async (exportName: string, ofs: number) => {
    setBusy(true);
    try {
      const [d, r] = await Promise.all([
        fetch(`/api/dev/tables/${encodeURIComponent(exportName)}`).then((res) => res.json()),
        fetch(`/api/admin/tables/${encodeURIComponent(exportName)}?limit=${PAGE_SIZE}&offset=${ofs}`).then((res) => res.json()),
      ]);
      setDetail(d);
      setRows(r);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!selected) return;
    setOffset(0);
    void refresh(selected, 0);
  }, [selected, refresh]);

  const entry = tables.find((t) => t.exportName === selected);
  const editableColumns = useMemo(() => {
    if (!detail) return [];
    const allowed = new Set(entry?.editableColumns ?? detail.columns.map((c) => c.name));
    return detail.columns.filter((c) => allowed.has(c.name) && !c.generated);
  }, [detail, entry]);

  const onDelete = useCallback(
    async (row: Record<string, unknown>) => {
      if (!detail || !selected) return;
      const pk: Record<string, unknown> = {};
      for (const k of detail.primaryKey) pk[k] = row[k];
      const ok = await askConfirm({
        title: 'Delete row?',
        body: Object.entries(pk).map(([k, v]) => `${k}=${String(v)}`).join(', '),
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
      setBusy(true);
      try {
        const r = await fetch(
          `/api/admin/tables/${encodeURIComponent(selected)}?pk=${encodeURIComponent(JSON.stringify(pk))}`,
          { method: 'DELETE' },
        );
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          toast.error(`Delete failed: ${d.error ?? r.statusText}`);
        }
        await refresh(selected, offset);
      } finally {
        setBusy(false);
      }
    },
    [detail, selected, offset, refresh, askConfirm],
  );

  return (
    <div className="pc-admin-shell">
      {confirmEl}
      <aside className="pc-admin-sidebar">
        <div className="pc-admin-title">Admin tables ({tables.length})</div>
        <div className="pc-admin-list">
          {tables.map((t) => (
            <button
              key={t.exportName}
              type="button"
              className={`pc-admin-row ${selected === t.exportName ? 'is-active' : ''}`}
              onClick={() => setSelected(t.exportName)}
            >
              {t.label}
              <div className="pc-admin-row-name">{t.schema}.{t.name}</div>
            </button>
          ))}
        </div>
      </aside>

      <main className="pc-admin-main">
        {!entry && <div className="pc-admin-empty">Pick a table.</div>}
        {entry && detail && (
          <>
            <div className="pc-admin-header">
              <div>
                <h1>{entry.label}</h1>
                <div className="pc-admin-header-qualified">
                  {detail.qualifiedName} · PK: {detail.primaryKey.join(', ') || '<none>'}
                </div>
              </div>
              <button className="pc-admin-add-btn" disabled={busy} onClick={() => setModal({ mode: 'create' })}>
                + New row
              </button>
            </div>

            <div className="pc-admin-grid-scroll">
              {rows && rows.rows.length > 0 ? (
                <div style={{ height: Math.min(560, 36 + rows.rows.length * 32 + 4) }}>
                  <RichGrid<Record<string, unknown>>
                    columns={[
                      ...Object.keys(rows.rows[0]).map<ColumnDef<Record<string, unknown>>>((k) => ({
                        key: `col:${k}`,
                        header: k,
                        width: 1,
                        toCopyText: (r) => renderCell(r[k]),
                        render: ({ row }) => <>{renderCell(row[k])}</>,
                      })),
                      {
                        key: 'actions',
                        header: 'Actions',
                        width: 1,
                        render: ({ row }) => (
                          <div className="pc-admin-actions">
                            <button onClick={() => setModal({ mode: 'edit', row })}>Edit</button>
                            {entry.allowDelete && (
                              <button className="is-danger" onClick={() => onDelete(row)}>Del</button>
                            )}
                          </div>
                        ),
                      },
                    ]}
                    rows={rows.rows}
                    getRowId={(r) => JSON.stringify(r['id'] ?? r)}
                    rowMinHeight={32}
                    headerHeight={32}
                  />
                </div>
              ) : (
                <div style={{ padding: 24, color: 'var(--fg-mute, #94a3b8)', fontStyle: 'italic' }}>No rows.</div>
              )}
            </div>

            {rows && (
              <div className="pc-admin-paginate">
                <button
                  disabled={offset === 0 || busy}
                  onClick={() => {
                    const o = Math.max(offset - PAGE_SIZE, 0);
                    setOffset(o);
                    void refresh(selected!, o);
                  }}
                >
                  ‹ Prev
                </button>
                <span>
                  {offset.toLocaleString()}–{(offset + rows.rows.length).toLocaleString()} of {rows.total.toLocaleString()}
                </span>
                <button
                  disabled={busy || offset + rows.rows.length >= rows.total}
                  onClick={() => {
                    const o = offset + PAGE_SIZE;
                    setOffset(o);
                    void refresh(selected!, o);
                  }}
                >
                  Next ›
                </button>
              </div>
            )}
          </>
        )}
      </main>

      {modal && entry && detail && (
        <RowModal
          mode={modal.mode}
          row={modal.mode === 'edit' ? modal.row : undefined}
          entry={entry}
          detail={detail}
          editableColumns={editableColumns}
          onClose={() => setModal(null)}
          onSaved={async () => {
            setModal(null);
            await refresh(selected!, offset);
          }}
        />
      )}
    </div>
  );
}

function RowModal({
  mode,
  row,
  entry,
  detail,
  editableColumns,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  row?: Record<string, unknown>;
  entry: AdminTableEntry;
  detail: TableDetail;
  editableColumns: ColumnSummary[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const c of editableColumns) {
      const v = row?.[c.name];
      if (v === null || v === undefined) out[c.name] = '';
      else if (typeof v === 'object') out[c.name] = JSON.stringify(v);
      else out[c.name] = String(v);
    }
    return out;
  });
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [serverErr, setServerErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setField = (name: string, val: string) => setValues((s) => ({ ...s, [name]: val }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setIssues([]);
    setServerErr(null);
    try {
      const body: Record<string, unknown> = {};
      for (const c of editableColumns) {
        const v = coerceColumnValue(c, values[c.name] ?? '');
        if (v !== undefined) body[c.name] = v;
      }
      if (mode === 'create') {
        const r = await fetch(`/api/admin/tables/${encodeURIComponent(entry.exportName)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (!r.ok) {
          if (d.issues) setIssues(d.issues);
          else setServerErr(d.error ?? r.statusText);
          return;
        }
      } else {
        if (!row) return;
        const pk: Record<string, unknown> = {};
        for (const k of detail.primaryKey) pk[k] = row[k];
        const r = await fetch(`/api/admin/tables/${encodeURIComponent(entry.exportName)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pk, set: body }),
        });
        const d = await r.json();
        if (!r.ok) {
          if (d.issues) setIssues(d.issues);
          else setServerErr(d.error ?? r.statusText);
          return;
        }
      }
      await onSaved();
    } catch (err) {
      setServerErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const issueFor = (col: string) =>
    issues.find((i) => i.path[0] === col)?.message ?? null;

  return (
    <div className="pc-admin-modal-bg" onClick={onClose}>
      <div className="pc-admin-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{mode === 'create' ? `+ New ${detail.name}` : `Edit ${detail.name}`}</h2>
        <form className="pc-admin-form" onSubmit={onSubmit}>
          {editableColumns.map((c) => {
            const err = issueFor(c.name);
            const isJson = c.columnType === 'PgJsonb' || c.columnType === 'PgJson';
            return (
              <div key={c.name} className="pc-admin-field">
                <label>
                  {c.name}
                  <span className="pc-admin-field-type">
                    {c.columnType.replace(/^Pg/, '').toLowerCase()}
                    {c.notNull ? ' · required' : ' · nullable'}
                    {c.primary ? ' · PK' : ''}
                  </span>
                </label>
                {isJson ? (
                  <textarea
                    value={values[c.name] ?? ''}
                    onChange={(e) => setField(c.name, e.target.value)}
                    placeholder={c.hasDefault ? '(leave blank for default)' : '{}'}
                  />
                ) : (
                  <input
                    type="text"
                    value={values[c.name] ?? ''}
                    onChange={(e) => setField(c.name, e.target.value)}
                    placeholder={c.hasDefault ? '(leave blank for default)' : ''}
                    disabled={mode === 'edit' && c.primary}
                  />
                )}
                {err && <span className="pc-admin-issue">{err}</span>}
              </div>
            );
          })}
          {serverErr && <pre className="pc-admin-modal-err">{serverErr}</pre>}
          <div className="pc-admin-modal-actions">
            <button type="button" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" className="is-primary" disabled={submitting}>
              {submitting ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Pure: coerce a raw form-string into the value the column's Drizzle type
 * expects — '' → null (nullable) or undefined (let the DB default fill),
 * numeric types → Number, bool → true/1 check, json → parsed (raw on bad
 * JSON). Exported for tests.
 */
export function coerceColumnValue(c: ColumnSummary, raw: string): unknown {
  if (raw === '' && !c.notNull) return null;
  if (raw === '' && c.hasDefault) return undefined; // let DB fill
  switch (c.columnType) {
    case 'PgInteger':
    case 'PgSmallInt':
    case 'PgSerial':
    case 'PgSmallSerial':
    case 'PgBigInt53':
    case 'PgBigInt64':
    case 'PgBigSerial53':
    case 'PgBigSerial64':
      return raw === '' ? null : Number(raw);
    case 'PgReal':
    case 'PgDoublePrecision':
    case 'PgNumeric':
    case 'PgDecimal':
      return raw;
    case 'PgBoolean':
      return raw === 'true' || raw === '1';
    case 'PgJsonb':
    case 'PgJson':
      try { return JSON.parse(raw); } catch { return raw; }
    default:
      return raw;
  }
}

/** Pure: render a cell value as a short display string. Exported for tests. */
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
