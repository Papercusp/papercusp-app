'use client';

import { useCallback, useEffect, useState } from 'react';

interface Snapshot {
  id: string;
  ts: number;
  iterNum: number;
  files: string[];
  featureCounts: Record<string, number>;
}

interface Props {
  slug: string;
  onClose: () => void;
  onRestored: () => void;
}

const STATUS_COLOR: Record<string, string> = {
  todo: '#6b7280',
  in_progress: '#3b82f6',
  validating: '#a855f7',
  failing: '#ef4444',
  blocked: '#f59e0b',
  passed: '#10b981',
};

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function SnapshotsPanel({ slug, onClose, onRestored }: Props) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [selected, setSelected] = useState<Snapshot | null>(null);
  const [includeNotes, setIncludeNotes] = useState(true);
  const [includeConfig, setIncludeConfig] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetch(`/api/harness/${slug}/snapshots`).then((r) => r.json());
      setSnapshots(d.snapshots ?? []);
    } catch (e) {
      setToast(`load failed: ${e}`);
    }
  }, [slug]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const restore = useCallback(async () => {
    if (!selected) return;
    if (!confirm(`Restore mission state from ${selected.id}? Current features (harness_features in Postgres), validation-contract.md${includeNotes ? ', supervisor-notes.md' : ''}${includeConfig ? ', config.json' : ''} will be overwritten.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/harness/${slug}/snapshots/${selected.id}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ includeSupervisorNotes: includeNotes, includeConfig }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const d = await r.json();
      setToast(`restored: ${d.restored.join(', ')}`);
      onRestored();
      setTimeout(() => { setToast(null); onClose(); }, 900);
    } catch (e) {
      setToast(`restore failed: ${e}`);
      setTimeout(() => setToast(null), 3000);
    } finally {
      setBusy(false);
    }
  }, [selected, includeNotes, includeConfig, slug, onRestored, onClose]);

  const remove = useCallback(async (id: string) => {
    if (!confirm(`Delete snapshot ${id}? Cannot be undone.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/harness/${slug}/snapshots/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      if (selected?.id === id) setSelected(null);
      await load();
    } catch (e) {
      setToast(`delete failed: ${e}`);
      setTimeout(() => setToast(null), 2500);
    } finally {
      setBusy(false);
    }
  }, [slug, selected, load]);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
      onClick={onClose}
    >
      <div
        style={{ background: '#0b0e14', border: '1px solid #374151', borderRadius: 6, width: '80vw', maxWidth: 1100, height: '75vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', color: '#e5e7eb' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Snapshots — {slug}</strong>
          <span style={{ fontFamily: 'monospace', color: '#6b7280', fontSize: '0.75rem' }}>.papercusp/snapshots/</span>
          <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#6b7280' }}>auto-refresh 5s</span>
          {toast && (
            <span style={{ color: /failed/i.test(toast) ? '#f87171' : '#10b981', fontSize: '0.8rem' }}>{toast}</span>
          )}
          <button
            onClick={onClose}
            style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            close
          </button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* List */}
          <div style={{ flex: '0 0 55%', borderRight: '1px solid #1f2937', overflow: 'auto' }}>
            {snapshots.length === 0 ? (
              <div style={{ padding: '2rem', color: '#6b7280', textAlign: 'center' }}>
                No snapshots yet. Each iteration of the main loop creates one.
              </div>
            ) : (
              <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
                <thead style={{ position: 'sticky', top: 0, background: '#0b0e14' }}>
                  <tr style={{ textAlign: 'left', color: '#9ca3af', borderBottom: '1px solid #1f2937' }}>
                    <th style={{ padding: '0.4rem 0.6rem' }}>When</th>
                    <th style={{ padding: '0.4rem 0.6rem' }}>Iter</th>
                    <th style={{ padding: '0.4rem 0.6rem' }}>Feature counts</th>
                    <th style={{ padding: '0.4rem 0.6rem' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((s) => {
                    const isActive = selected?.id === s.id;
                    return (
                      <tr
                        key={s.id}
                        onClick={() => setSelected(s)}
                        style={{
                          cursor: 'pointer',
                          background: isActive ? '#1f2937' : 'transparent',
                          borderBottom: '1px solid #1f2937',
                        }}
                      >
                        <td style={{ padding: '0.35rem 0.6rem', color: '#9ca3af' }}>{fmtTs(s.ts)}</td>
                        <td style={{ padding: '0.35rem 0.6rem', fontFamily: 'monospace' }}>{s.iterNum}</td>
                        <td style={{ padding: '0.35rem 0.6rem' }}>
                          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                            {Object.entries(s.featureCounts).map(([status, n]) => (
                              <span
                                key={status}
                                style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem', borderRadius: 3, background: STATUS_COLOR[status] ?? '#374151', color: 'white', fontWeight: 600 }}
                                title={`${status}: ${n}`}
                              >
                                {status.slice(0,4)} {n}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td style={{ padding: '0.35rem 0.6rem', textAlign: 'right' }}>
                          <button
                            onClick={(e) => { e.stopPropagation(); remove(s.id); }}
                            disabled={busy}
                            style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.1rem 0.45rem', cursor: 'pointer', fontSize: '0.7rem' }}
                            title="Delete this snapshot"
                          >
                            delete
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Detail */}
          <div style={{ flex: 1, padding: '1rem', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {selected ? (
              <>
                <div>
                  <div style={{ fontSize: '0.7rem', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Snapshot</div>
                  <div style={{ fontFamily: 'monospace', fontSize: '0.85rem', marginTop: '0.25rem' }}>{selected.id}</div>
                  <div style={{ color: '#6b7280', fontSize: '0.75rem', marginTop: '0.2rem' }}>
                    iteration <b style={{ color: '#e5e7eb' }}>{selected.iterNum}</b> · {fmtTs(selected.ts)}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: '0.7rem', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.3rem' }}>Files captured</div>
                  {selected.files.map((f) => (
                    <div key={f} style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#d1d5db' }}>· {f}</div>
                  ))}
                </div>

                <div>
                  <div style={{ fontSize: '0.7rem', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.3rem' }}>Restore options</div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: '#d1d5db', cursor: selected.files.includes('supervisor-notes.md') ? 'pointer' : 'not-allowed', opacity: selected.files.includes('supervisor-notes.md') ? 1 : 0.5 }}>
                    <input
                      type="checkbox"
                      checked={includeNotes && selected.files.includes('supervisor-notes.md')}
                      disabled={!selected.files.includes('supervisor-notes.md')}
                      onChange={(e) => setIncludeNotes(e.target.checked)}
                    />
                    also restore supervisor-notes.md
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: '#d1d5db', cursor: selected.files.includes('config.json') ? 'pointer' : 'not-allowed', opacity: selected.files.includes('config.json') ? 1 : 0.5 }}>
                    <input
                      type="checkbox"
                      checked={includeConfig && selected.files.includes('config.json')}
                      disabled={!selected.files.includes('config.json')}
                      onChange={(e) => setIncludeConfig(e.target.checked)}
                    />
                    also restore config.json (per-role models)
                  </label>
                  <div style={{ marginTop: '0.25rem', color: '#6b7280', fontSize: '0.7rem' }}>
                    features (harness_features rows) and validation-contract.md are always restored when present.
                  </div>
                </div>

                <button
                  onClick={restore}
                  disabled={busy}
                  style={{
                    background: '#b45309', color: 'white', border: '1px solid #d97706',
                    borderRadius: 3, padding: '0.5rem 1rem',
                    cursor: busy ? 'wait' : 'pointer', fontWeight: 600, fontSize: '0.85rem',
                    marginTop: '0.5rem',
                  }}
                >
                  {busy ? '…' : '↻ restore mission state'}
                </button>

                <div style={{ fontSize: '0.7rem', color: '#6b7280', marginTop: '0.25rem' }}>
                  This overwrites current state with the snapshot. If the harness is running, the next iteration will read the restored files.
                </div>
              </>
            ) : (
              <div style={{ color: '#6b7280', textAlign: 'center', marginTop: '20%' }}>
                Select a snapshot to see restore options.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
