'use client';

import { useCallback, useEffect, useState } from 'react';

const VALID_STATUSES = ['todo', 'in_progress', 'validating', 'failing', 'passed', 'blocked'] as const;
type Status = (typeof VALID_STATUSES)[number];

interface Feature {
  id: string;
  title: string;
  claims?: string[];
  status: Status;
  attempts: number;
}

interface Props {
  slug: string;
  feature: Feature | null;  // null = create mode
  onClose: () => void;
  onSaved: () => void;
}

export default function FeatureEditor({ slug, feature, onClose, onSaved }: Props) {
  const isCreate = feature === null;
  const [id, setId] = useState(feature?.id ?? '');
  const [title, setTitle] = useState(feature?.title ?? '');
  const [claimsText, setClaimsText] = useState((feature?.claims ?? []).join('\n'));
  const [status, setStatus] = useState<Status>(feature?.status ?? 'todo');
  const [attempts, setAttempts] = useState<number>(feature?.attempts ?? 0);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (feature) {
      setId(feature.id);
      setTitle(feature.title);
      setClaimsText((feature.claims ?? []).join('\n'));
      setStatus(feature.status);
      setAttempts(feature.attempts);
    }
  }, [feature]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const claims = claimsText.split('\n').map((s) => s.trim()).filter(Boolean);
      if (isCreate) {
        const r = await fetch(`/api/harness/${slug}/features`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, title, claims, status }),
        });
        if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      } else {
        const r = await fetch(`/api/harness/${slug}/features/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, claims, status, attempts }),
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
    if (!confirm(`Delete feature ${feature.id}? This cannot be undone.`)) return;
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
  }, [slug, feature, onClose, onSaved]);

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

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
      onClick={onClose}
    >
      <div
        style={{ background: '#0b0e14', border: '1px solid #374151', borderRadius: 6, width: '70vw', maxWidth: 720, height: '65vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong style={{ color: '#e5e7eb' }}>{isCreate ? 'New feature' : `Edit ${feature!.id}`}</strong>
          <span style={{ color: '#6b7280', fontSize: '0.75rem', fontFamily: 'monospace' }}>harness_features</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {toast && (
              <span style={{ color: /failed/i.test(toast) ? '#f87171' : '#10b981', fontSize: '0.8rem' }}>{toast}</span>
            )}
            {!isCreate && (
              <button
                onClick={remove}
                disabled={saving}
                style={{ background: 'transparent', color: '#f87171', border: '1px solid #7f1d1d', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: saving ? 'wait' : 'pointer', fontSize: '0.8rem' }}
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
              style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer' }}
            >
              cancel
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', color: '#9ca3af', marginBottom: '0.25rem' }}>ID</label>
            <input
              value={id}
              onChange={(e) => setId(e.target.value.toUpperCase())}
              disabled={!isCreate}
              placeholder="F-NEW-001"
              style={{
                width: '100%', boxSizing: 'border-box',
                background: isCreate ? '#111827' : '#1f2937',
                color: '#e5e7eb',
                border: '1px solid #374151',
                borderRadius: 3, padding: '0.45rem 0.6rem',
                fontFamily: 'monospace', fontSize: '0.85rem',
                opacity: isCreate ? 1 : 0.6,
              }}
            />
            {isCreate && (
              <div style={{ fontSize: '0.7rem', color: '#6b7280', marginTop: '0.25rem' }}>
                must match <code>^F-[A-Z0-9-]+$</code>. Convention: <code>F-FIX-001</code> for fix features.
              </div>
            )}
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', color: '#9ca3af', marginBottom: '0.25rem' }}>Title</label>
            <textarea
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              rows={2}
              style={{
                width: '100%', boxSizing: 'border-box',
                background: '#111827', color: '#e5e7eb',
                border: '1px solid #374151', borderRadius: 3,
                padding: '0.45rem 0.6rem',
                fontSize: '0.85rem',
                resize: 'vertical',
                fontFamily: 'system-ui, sans-serif',
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', color: '#9ca3af', marginBottom: '0.25rem' }}>
              Claims — one per line (validation contract IDs)
            </label>
            <textarea
              value={claimsText}
              onChange={(e) => setClaimsText(e.target.value)}
              rows={6}
              placeholder={'VAL-GRID-001\nVAL-GRID-002'}
              style={{
                width: '100%', boxSizing: 'border-box',
                background: '#111827', color: '#e5e7eb',
                border: '1px solid #374151', borderRadius: 3,
                padding: '0.45rem 0.6rem',
                fontSize: '0.8rem',
                fontFamily: 'ui-monospace, monospace',
                resize: 'vertical',
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: '1rem' }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '0.75rem', color: '#9ca3af', marginBottom: '0.25rem' }}>Status</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as Status)}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  background: '#111827', color: '#e5e7eb',
                  border: '1px solid #374151', borderRadius: 3,
                  padding: '0.45rem 0.6rem', fontSize: '0.85rem',
                }}
              >
                {VALID_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {!isCreate && (
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: '0.75rem', color: '#9ca3af', marginBottom: '0.25rem' }}>Attempts</label>
                <input
                  type="number"
                  min={0}
                  value={attempts}
                  onChange={(e) => setAttempts(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: '#111827', color: '#e5e7eb',
                    border: '1px solid #374151', borderRadius: 3,
                    padding: '0.45rem 0.6rem', fontSize: '0.85rem',
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
