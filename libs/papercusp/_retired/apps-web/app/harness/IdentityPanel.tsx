'use client';

import { useCallback, useEffect, useState } from 'react';

interface Identity {
  role: string;
  content: string;
  bytes: number;
  mtimeMs: number;
}

interface Props {
  onClose: () => void;
}

function fmtTs(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function contentLines(s: string): number {
  return s.split('\n').filter((l) => l.trim() && !l.trim().startsWith('<!--')).length;
}

export default function IdentityPanel({ onClose }: Props) {
  const [list, setList] = useState<Identity[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/identity`);
      if (!r.ok) throw new Error(`${r.status}`);
      const d = await r.json();
      setList(d.identities ?? []);
      setErr(null);
      if (!selected && (d.identities ?? []).length > 0) {
        setSelected(d.identities[0].role);
      }
    } catch (e) {
      setErr(String(e));
    }
  }, [selected]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const cur = list.find((i) => i.role === selected);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
      onClick={onClose}
    >
      <div
        style={{ background: '#0b0e14', border: '1px solid #374151', borderRadius: 6, width: '85vw', maxWidth: 1200, height: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', color: '#e5e7eb' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Cross-mission identity</strong>
          <span style={{ fontFamily: 'monospace', color: '#6b7280', fontSize: '0.75rem' }}>~/autonomous-harness/identity/</span>
          <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>Agent-Swarm-inspired · curator-maintained · read on every role invocation</span>
          <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#6b7280' }}>auto-refresh 10s</span>
          {err && <span style={{ color: '#f87171', fontSize: '0.75rem' }}>err: {err}</span>}
          <button onClick={onClose} style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}>close</button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: '0 0 200px', borderRight: '1px solid #1f2937', overflow: 'auto' }}>
            {list.length === 0 ? (
              <div style={{ padding: '1rem', color: '#6b7280', fontSize: '0.85rem', textAlign: 'center' }}>no identity files</div>
            ) : (
              list.map((i) => {
                const active = i.role === selected;
                const lines = contentLines(i.content);
                return (
                  <button
                    key={i.role}
                    onClick={() => setSelected(i.role)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '0.6rem 0.85rem',
                      background: active ? '#1f2937' : 'transparent',
                      color: '#e5e7eb', border: 'none', borderBottom: '1px solid #1f2937',
                      cursor: 'pointer', fontSize: '0.85rem',
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{i.role}</div>
                    <div style={{ fontSize: '0.7rem', color: '#6b7280', marginTop: 2 }}>
                      {lines} lessons · {i.bytes}b · {fmtTs(i.mtimeMs)}
                    </div>
                  </button>
                );
              })
            )}
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '1rem 1.25rem' }}>
            {cur ? (
              <pre style={{
                margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                color: '#e5e7eb',
              }}>{cur.content || '(empty — curator will populate as missions run)'}</pre>
            ) : (
              <div style={{ color: '#6b7280', fontStyle: 'italic', marginTop: '20%', textAlign: 'center' }}>
                Select a role on the left.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
