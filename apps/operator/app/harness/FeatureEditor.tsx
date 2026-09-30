'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConfirmDialog } from './useConfirmDialog';
import { useQueryState, parseAsBoolean } from 'nuqs';
import { Modal } from './Modal';
import { Select } from './Select';
import * as Collapsible from '@radix-ui/react-collapsible';
import { useSyncQuery } from '@papercusp/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';

// work-item-status-full-unify P-007: the SETTABLE feature statuses are the unified
// lifecycle tokens (feature `todo`→`open`, `passed`→`done`, `deprecated`→`dropped`,
// `in_progress`/`validating`→`wip`). Legacy spellings are still recognized on read
// (LEGACY_STATUSES) so the editor can open a residual/federated legacy-status row, but
// they are not offered as new choices.
const VALID_STATUSES = ['open', 'wip', 'blocked', 'needs-human', 'done', 'dropped'] as const;
const LEGACY_STATUSES = ['todo', 'in_progress', 'validating', 'failing', 'passed', 'deprecated'] as const;
type Status = (typeof VALID_STATUSES)[number] | (typeof LEGACY_STATUSES)[number];

export function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

export interface FeatureAuditEntry { ts: number; field: string; old: unknown; new: unknown; actor: string }

interface RawAuditRow {
  featureId: string;
  ts: number;
  field: string;
  oldValue?: string | null;
  newValue?: string | null;
  actor?: string | null;
}

/**
 * Project the cross-harness audit subscription down to the edit-history rows
 * for one feature: filter to this feature's id and JSON-parse the old/new
 * column values (falling back to the raw string when they aren't JSON). Returns
 * null in create mode or when the subscription hasn't hydrated. Extracted so
 * the parse + filter is testable without mounting the editor.
 */
export function deriveFeatureHistory(
  auditRows: unknown,
  featureId: string | null | undefined,
  isCreate: boolean,
): FeatureAuditEntry[] | null {
  if (isCreate || !featureId) return null;
  if (!Array.isArray(auditRows)) return null;
  return (auditRows as RawAuditRow[])
    .filter((r) => r.featureId === featureId)
    .map((r) => ({
      ts: r.ts,
      field: r.field,
      old: r.oldValue ? safeParse(r.oldValue) : null,
      new: r.newValue ? safeParse(r.newValue) : null,
      actor: r.actor ?? '',
    }));
}

interface Feature {
  id: string;
  title: string;
  claims?: string[];
  status: Status;
  attempts: number;
  deprecation_reason?: string;
}

interface Props {
  slug: string;
  feature: Feature | null;  // null = create mode
  onClose: () => void;
  onSaved: () => void;
  /**
   * When true, render the editor inline (filling its container) instead of
   * inside a centered <Modal>. Used by the /adv Detail panel so "Edit" opens
   * the editor in the same reader pane that shows features + issues.
   */
  embedded?: boolean;
}

export default function FeatureEditor({ slug, feature, onClose, onSaved, embedded = false }: Props) {
  const workspaceId = useWorkspaceId(); // EI-1763: tenant-scope sync reads
  const isCreate = feature === null;
  const [id, setId] = useState(feature?.id ?? '');
  const [title, setTitle] = useState(feature?.title ?? '');
  const [claimsText, setClaimsText] = useState((feature?.claims ?? []).join('\n'));
  const [status, setStatus] = useState<Status>(feature?.status ?? 'open');
  const [attempts, setAttempts] = useState<number>(feature?.attempts ?? 0);
  const [deprecationReason, setDeprecationReason] = useState<string>(feature?.deprecation_reason ?? '');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  useEffect(() => {
    if (feature) {
      setId(feature.id);
      setTitle(feature.title);
      setClaimsText((feature.claims ?? []).join('\n'));
      setStatus(feature.status);
      setAttempts(feature.attempts);
      setDeprecationReason(feature.deprecation_reason ?? '');
    }
  }, [feature]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const claims = claimsText.split('\n').map((s) => s.trim()).filter(Boolean);
      // work-item-status-full-unify P-007: the drop terminal is the unified `dropped`
      // (feature `deprecated`→`dropped`); the deprecation-reason gate keys on it now.
      if (status === 'dropped' && deprecationReason.trim() === '') {
        setToast('Deprecation reason is required when status is "dropped".');
        setSaving(false);
        return;
      }
      if (isCreate) {
        const r = await fetch(`/api/harness/${slug}/features`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, title, claims, status }),
        });
        if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      } else {
        const body: Record<string, unknown> = { title, claims, status, attempts };
        if (status === 'dropped') body.deprecation_reason = deprecationReason.trim();
        const r = await fetch(`/api/harness/${slug}/features/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      }
      setToast('saved');
      onSaved();
      setTimeout(() => { onClose(); }, 400);
    } catch (e) {
      setToast(`save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  }, [slug, id, title, claimsText, status, attempts, isCreate, onClose, onSaved]);

  const remove = useCallback(async () => {
    if (!feature) return;
    if (!await askConfirm({
      title: `Delete feature ${feature.id}?`,
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    })) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/harness/${slug}/features/${feature.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setToast('deleted');
      onSaved();
      setTimeout(() => { onClose(); }, 400);
    } catch (e) {
      setToast(`delete failed: ${e}`);
    } finally {
      setSaving(false);
    }
  }, [slug, feature, onClose, onSaved, askConfirm]);

  // Audit history — eager via the cross-harness audit subscription.
  // Replaces the lazy /audit fetch when the History section was expanded.
  const [historyOpen, setHistoryOpen] = useQueryState('history', parseAsBoolean.withDefault(false));
  const [historyError, _setHistoryError] = useState<string | null>(null);
  const { data: auditRows } = useSyncQuery<{
    harnessSlug: string;
    featureId: string;
    ts: number;
    field: string;
    oldValue?: string | null;
    newValue?: string | null;
    actor?: string | null;
  }>({
    queryName: 'featureAudit.byHarness',
    args: { harnessSlug: slug, workspaceId },
    enabled: !isCreate && !!slug,
  });
  const historyRows: FeatureAuditEntry[] | null = useMemo(
    () => deriveFeatureHistory(auditRows, feature?.id, isCreate),
    [auditRows, isCreate, feature?.id],
  );

  // Cmd+S save
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [save]);

  const content = (
    <>
        {confirmEl}
        {/* Header */}
        <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong style={{ color: 'var(--fg)' }}>{isCreate ? 'New feature' : `Edit ${feature!.id}`}</strong>
          <span style={{ color: 'var(--fg-mute)', fontSize: '0.75rem', fontFamily: 'monospace' }} title="Features live in Postgres (harness_features); edits dispatch via /api/harness/<slug>/features">harness_features</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {toast && (
              <span style={{ color: /failed/i.test(toast) ? 'var(--bad)' : 'var(--good)', fontSize: '0.8rem' }}>{toast}</span>
            )}
            {!isCreate && (
              <button
                onClick={remove}
                disabled={saving}
                style={{ background: 'transparent', color: 'var(--bad)', border: '1px solid #7f1d1d', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: saving ? 'wait' : 'pointer', fontSize: '0.8rem' }}
              >
                delete
              </button>
            )}
            <button
              onClick={save}
              disabled={saving || !title.trim() || (isCreate && !id.trim())}
              style={{ background: '#2563eb', color: 'white', border: 'none', borderRadius: 3, padding: '0.35rem 0.9rem', cursor: saving ? 'wait' : 'pointer', fontWeight: 600 }}
            >
              {saving ? 'saving…' : 'save'}
            </button>
            <button
              onClick={onClose}
              style={{ background: 'transparent', color: 'var(--fg-mute)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer' }}
            >
              cancel
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--fg-mute)', marginBottom: '0.25rem' }}>ID</label>
            <input
              value={id}
              onChange={(e) => setId(e.target.value.toUpperCase())}
              disabled={!isCreate}
              placeholder="F-NEW-001"
              style={{
                width: '100%', boxSizing: 'border-box',
                background: isCreate ? '#111827' : '#1f2937',
                color: 'var(--fg)',
                border: '1px solid var(--border)',
                borderRadius: 3, padding: '0.45rem 0.6rem',
                fontFamily: 'monospace', fontSize: '0.85rem',
                opacity: isCreate ? 1 : 0.6,
              }}
            />
            {isCreate && (
              <div style={{ fontSize: '0.7rem', color: 'var(--fg-mute)', marginTop: '0.25rem' }}>
                must match <code>^F-[A-Z0-9-]+$</code>. Convention: <code>F-FIX-001</code> for fix features.
              </div>
            )}
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--fg-mute)', marginBottom: '0.25rem' }}>Title</label>
            <textarea
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              rows={2}
              style={{
                width: '100%', boxSizing: 'border-box',
                background: 'var(--bg-2)', color: 'var(--fg)',
                border: '1px solid var(--border)', borderRadius: 3,
                padding: '0.45rem 0.6rem',
                fontSize: '0.85rem',
                resize: 'vertical',
                fontFamily: 'system-ui, sans-serif',
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--fg-mute)', marginBottom: '0.25rem' }}>
              Claims — one per line (validation contract IDs)
            </label>
            <textarea
              value={claimsText}
              onChange={(e) => setClaimsText(e.target.value)}
              rows={6}
              placeholder={'VAL-GRID-001\nVAL-GRID-002'}
              style={{
                width: '100%', boxSizing: 'border-box',
                background: 'var(--bg-2)', color: 'var(--fg)',
                border: '1px solid var(--border)', borderRadius: 3,
                padding: '0.45rem 0.6rem',
                fontSize: '0.8rem',
                fontFamily: 'ui-monospace, monospace',
                resize: 'vertical',
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: '1rem' }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--fg-mute)', marginBottom: '0.25rem' }}>Status</label>
              <Select
                value={status}
                onChange={(v) => setStatus(v as Status)}
                ariaLabel="Status"
                options={[
                  ...VALID_STATUSES.map((s) => ({ value: s, label: s })),
                  // Keep a residual legacy-spelled current status selectable so the editor
                  // isn't blank when opened on a pre-backfill/federated row (P-007).
                  ...(!(VALID_STATUSES as readonly string[]).includes(status)
                    ? [{ value: status, label: `${status} (legacy)` }]
                    : []),
                ]}
                triggerStyle={{
                  width: '100%', boxSizing: 'border-box',
                  background: 'var(--bg-2)', color: 'var(--fg)',
                  border: '1px solid var(--border)', borderRadius: 3,
                  padding: '0.45rem 0.6rem', fontSize: '0.85rem',
                }}
              />
            </div>
            {!isCreate && (
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--fg-mute)', marginBottom: '0.25rem' }}>Attempts</label>
                <input
                  type="number"
                  min={0}
                  value={attempts}
                  onChange={(e) => setAttempts(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: 'var(--bg-2)', color: 'var(--fg)',
                    border: '1px solid var(--border)', borderRadius: 3,
                    padding: '0.45rem 0.6rem', fontSize: '0.85rem',
                  }}
                />
              </div>
            )}
          </div>

          {status === 'dropped' && (
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--fg-mute)', marginBottom: '0.25rem' }}>
                Deprecation reason <span style={{ color: 'var(--bad)' }}>(required)</span>
              </label>
              <textarea
                value={deprecationReason}
                onChange={(e) => setDeprecationReason(e.target.value)}
                placeholder="e.g. The plan no longer asks for JWT cookie rotation; replaced by F-AUTH-012 (session cookies)."
                rows={3}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  background: 'var(--bg-2)', color: 'var(--fg)',
                  border: '1px solid var(--border)', borderRadius: 3,
                  padding: '0.45rem 0.6rem', fontSize: '0.85rem',
                  fontFamily: 'inherit', resize: 'vertical',
                }}
              />
              <p style={{ margin: '0.35rem 0 0', fontSize: '0.7rem', color: 'var(--fg-mute)' }}>
                Code is not auto-removed when a feature is deprecated; the row stays for audit and is hidden from default queue views.
              </p>
            </div>
          )}

          {!isCreate && (
            <Collapsible.Root
              open={historyOpen}
              onOpenChange={setHistoryOpen}
              style={{ marginTop: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}
            >
              <Collapsible.Trigger asChild>
                <button type="button" style={{ cursor: 'pointer', fontSize: '0.8rem', color: 'var(--fg-mute)', userSelect: 'none', background: 'none', border: 'none', padding: 0, textAlign: 'left' }}>
                  History {historyRows ? `(${historyRows.length})` : ''}
                </button>
              </Collapsible.Trigger>
              <Collapsible.Content style={{ marginTop: '0.5rem', fontSize: '0.75rem', maxHeight: 240, overflowY: 'auto' }}>
                {historyError && <div style={{ color: 'var(--bad)' }}>Failed to load: {historyError}</div>}
                {!historyError && historyRows === null && historyOpen && (
                  <div style={{ color: 'var(--fg-mute)' }}>Loading…</div>
                )}
                {!historyError && historyRows !== null && historyRows.length === 0 && (
                  <div style={{ color: 'var(--fg-mute)' }}>No edit history yet.</div>
                )}
                {historyRows && historyRows.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    {historyRows.map((row, i) => {
                      const fmt = (v: unknown) => {
                        if (v === null || v === undefined) return '∅';
                        if (typeof v === 'string') return v.length > 40 ? v.slice(0, 37) + '…' : v;
                        return JSON.stringify(v).slice(0, 40);
                      };
                      return (
                        <div key={i} style={{ display: 'grid', gridTemplateColumns: '11ch 9ch 1fr', gap: '0.5rem', alignItems: 'baseline', color: 'var(--fg)' }}>
                          <span style={{ color: 'var(--fg-mute)', fontVariantNumeric: 'tabular-nums' }}>
                            {new Date(row.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                          <span style={{ color: '#a1a1aa' }}>{row.actor}</span>
                          <span>
                            <code style={{ color: 'var(--warn)' }}>{row.field}</code>
                            <span style={{ color: 'var(--fg-mute)' }}>: </span>
                            <span style={{ color: 'var(--fg-mute)' }}>{fmt(row.old)}</span>
                            <span style={{ color: 'var(--fg-mute)' }}> → </span>
                            <span>{fmt(row.new)}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Collapsible.Content>
            </Collapsible.Root>
          )}
        </div>
    </>
  );

  if (embedded) {
    return (
      <div
        style={{
          height: '100%',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--bg-1, #0b1220)',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        {content}
      </div>
    );
  }

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Edit feature`}
      srOnlyTitle
      contentStyle={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, width: '70vw', maxWidth: 720, height: '65vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif' }}
    >
      {content}
    </Modal>
  );
}
