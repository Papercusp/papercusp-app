'use client';

import { useCallback, useEffect, useState } from 'react';

interface Archive {
  id: string;
  sizeBytes: number;
  ts: number;
}

interface Props {
  slug: string;
  onClose: () => void;
  onChanged: () => void;
}

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

export default function ArchivesPanel({ slug, onClose, onChanged }: Props) {
  const [items, setItems] = useState<Archive[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [resetOnArchive, setResetOnArchive] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await fetch(`/api/harness/${slug}/archives`).then((r) => r.json());
      setItems(d.archives ?? []);
    } catch (e) {
      setToast(`load: ${e}`);
    }
  }, [slug]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const archive = useCallback(async () => {
    if (resetOnArchive && !confirm('Archive current .papercusp/ AND reset it for a fresh mission? Transient files will be removed (config.json, hooks/, knowledge.md preserved).')) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/harness/${slug}/archive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reset: resetOnArchive }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const d = await r.json();
      setToast(`archived ${d.id} (${fmtSize(d.sizeBytes)})${d.reset ? ` · reset: ${d.resetRemoved?.join(', ')}` : ''}`);
      onChanged();
      await load();
    } catch (e) {
      setToast(`archive failed: ${e}`);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }, [slug, resetOnArchive, load, onChanged]);

  const restore = useCallback(async (id: string) => {
    if (!confirm(`Restore mission state from ${id}? Current .papercusp/ will be overwritten (a pre-restore snapshot will be created).`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/harness/${slug}/archives/${id}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const d = await r.json();
      setToast(`restored from ${d.restored} (undo: ${d.undoSnapshot})`);
      onChanged();
      await load();
    } catch (e) {
      setToast(`restore failed: ${e}`);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }, [slug, load, onChanged]);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
      onClick={onClose}
    >
      <div
        style={{ background: '#0b0e14', border: '1px solid #374151', borderRadius: 6, width: '70vw', maxWidth: 900, height: '70vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', color: '#e5e7eb' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Archives — {slug}</strong>
          <span style={{ fontFamily: 'monospace', color: '#6b7280', fontSize: '0.75rem' }}>.papercusp/archives/</span>
          <span style={{ fontSize: '0.7rem', color: '#6b7280' }}>{items.length} archive(s)</span>
          {toast && (
            <span style={{ color: /failed/i.test(toast) ? '#f87171' : '#10b981', fontSize: '0.75rem' }}>{toast}</span>
          )}
          <button
            onClick={onClose}
            style={{ marginLeft: 'auto', background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            close
          </button>
        </div>

        <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={resetOnArchive} onChange={(e) => setResetOnArchive(e.target.checked)} />
            also reset for fresh mission
          </label>
          <button
            onClick={archive}
            disabled={busy}
            style={{ marginLeft: 'auto', background: '#2563eb', color: 'white', border: 'none', borderRadius: 3, padding: '0.4rem 1rem', fontWeight: 600, cursor: busy ? 'wait' : 'pointer', fontSize: '0.85rem' }}
          >
            {busy ? 'working…' : `archive ${resetOnArchive ? '+ reset' : ''}`}
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {items.length === 0 ? (
            <div style={{ padding: '2rem', color: '#6b7280', textAlign: 'center' }}>
              No archives yet. Click "archive" above to create one.
            </div>
          ) : (
            <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: '#0b0e14' }}>
                <tr style={{ textAlign: 'left', color: '#9ca3af', borderBottom: '1px solid #1f2937' }}>
                  <th style={{ padding: '0.4rem 0.8rem' }}>When</th>
                  <th style={{ padding: '0.4rem 0.8rem' }}>ID</th>
                  <th style={{ padding: '0.4rem 0.8rem', textAlign: 'right' }}>Size</th>
                  <th style={{ padding: '0.4rem 0.8rem', textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id} style={{ borderBottom: '1px solid #1f2937' }}>
                    <td style={{ padding: '0.35rem 0.8rem', color: '#9ca3af' }}>{fmtTs(a.ts)}</td>
                    <td style={{ padding: '0.35rem 0.8rem', fontFamily: 'monospace', color: '#d1d5db' }}>{a.id}</td>
                    <td style={{ padding: '0.35rem 0.8rem', textAlign: 'right', color: '#6b7280' }}>{fmtSize(a.sizeBytes)}</td>
                    <td style={{ padding: '0.35rem 0.8rem', textAlign: 'right' }}>
                      <button
                        onClick={() => restore(a.id)}
                        disabled={busy}
                        style={{ background: 'transparent', color: '#fbbf24', border: '1px solid #78350f', borderRadius: 3, padding: '0.2rem 0.6rem', cursor: busy ? 'wait' : 'pointer', fontSize: '0.75rem' }}
                      >
                        restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
