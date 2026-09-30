'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

interface Decision {
  ts: number;
  iso: string;
  verb: string;
  args: string;
  iteration: number | null;
  isGhost: boolean;
}

interface Payload {
  decisions: Decision[];
  total: number;
  recognized: number;
  ghosts: number;
  ghostRate: number;
  byVerb: Record<string, number>;
}

interface Props {
  slug: string;
  onClose: () => void;
}

const VERB_COLOR: Record<string, string> = {
  NEXT_WORKER: '#3b82f6',
  NEXT_VALIDATOR: '#a855f7',
  NEXT_ARCHITECT: '#f59e0b',
  ESCALATE: '#ef4444',
  CONVERTED: '#10b981',
  DONE: '#10b981',
};

function fmtTs(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function DecisionsPanel({ slug, onClose }: Props) {
  const [data, setData] = useState<Payload | null>(null);
  const [hideGhosts, setHideGhosts] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/${slug}/decisions`);
      if (!r.ok) throw new Error(`${r.status}`);
      const d: Payload = await r.json();
      setData(d);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, [slug]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const list = hideGhosts ? data.decisions.filter((d) => !d.isGhost) : data.decisions;
    return list.slice().reverse();
  }, [data, hideGhosts]);

  const maxVerb = useMemo(() => {
    if (!data) return 0;
    return Math.max(1, ...Object.values(data.byVerb));
  }, [data]);

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
          <strong>Decisions — {slug}</strong>
          <span style={{ fontFamily: 'monospace', color: '#6b7280', fontSize: '0.75rem' }}>orchestrator verb timeline</span>
          <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', color: '#d1d5db', cursor: 'pointer' }}>
            <input type="checkbox" checked={hideGhosts} onChange={(e) => setHideGhosts(e.target.checked)} />
            hide ghosts
          </label>
          <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>auto-refresh 5s</span>
          {err && <span style={{ color: '#f87171', fontSize: '0.8rem' }}>err: {err}</span>}
          <button
            onClick={onClose}
            style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            close
          </button>
        </div>

        {/* Summary strip */}
        {data && (
          <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', gap: '1.25rem', fontSize: '0.8rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span><span style={{ color: '#9ca3af' }}>total</span> <b style={{ fontFamily: 'monospace' }}>{data.total}</b></span>
            <span><span style={{ color: '#9ca3af' }}>recognized</span> <b style={{ fontFamily: 'monospace', color: '#10b981' }}>{data.recognized}</b></span>
            <span><span style={{ color: '#9ca3af' }}>ghosts</span> <b style={{ fontFamily: 'monospace', color: data.ghosts > 0 ? '#f87171' : '#10b981' }}>{data.ghosts}</b></span>
            <span>
              <span style={{ color: '#9ca3af' }}>ghost rate</span>{' '}
              <b style={{ fontFamily: 'monospace', color: data.ghostRate >= 0.05 ? '#f87171' : '#10b981' }}>
                {(data.ghostRate * 100).toFixed(1)}%
              </b>
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {Object.entries(data.byVerb).sort((a, b) => b[1] - a[1]).map(([v, n]) => (
                <span key={v} title={`${v}: ${n}`} style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                  fontSize: '0.7rem', fontFamily: 'monospace',
                  padding: '0.1rem 0.45rem',
                  border: `1px solid ${VERB_COLOR[v] ?? '#374151'}`,
                  background: `color-mix(in oklab, ${VERB_COLOR[v] ?? '#374151'}, transparent 85%)`,
                  borderRadius: 3,
                  color: VERB_COLOR[v] ?? '#d1d5db',
                }}>
                  {v} <span style={{ opacity: 0.7 }}>{n}</span>
                  <span style={{
                    display: 'inline-block', width: Math.max(2, (n / maxVerb) * 60), height: 4,
                    background: VERB_COLOR[v] ?? '#374151', borderRadius: 2,
                  }} />
                </span>
              ))}
            </span>
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {!data ? (
            <div style={{ padding: '2rem', color: '#6b7280', textAlign: 'center' }}>loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '2rem', color: '#6b7280', textAlign: 'center' }}>
              {data.total === 0 ? 'No orchestrator decisions yet.' : 'No decisions match filter.'}
            </div>
          ) : (
            <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: '#0b0e14', zIndex: 1 }}>
                <tr style={{ textAlign: 'left', color: '#9ca3af', borderBottom: '1px solid #1f2937' }}>
                  <th style={{ padding: '0.4rem 0.6rem', width: 170 }}>When</th>
                  <th style={{ padding: '0.4rem 0.6rem', width: 60 }}>Iter</th>
                  <th style={{ padding: '0.4rem 0.6rem', width: 180 }}>Verb</th>
                  <th style={{ padding: '0.4rem 0.6rem' }}>Args</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #1f2937', opacity: d.isGhost ? 0.6 : 1 }}>
                    <td style={{ padding: '0.35rem 0.6rem', color: '#9ca3af', fontFamily: 'monospace', fontSize: '0.75rem' }}>{fmtTs(d.ts)}</td>
                    <td style={{ padding: '0.35rem 0.6rem', fontFamily: 'monospace', color: '#d1d5db' }}>{d.iteration ?? '—'}</td>
                    <td style={{ padding: '0.35rem 0.6rem' }}>
                      <span style={{
                        fontFamily: 'monospace', fontSize: '0.75rem',
                        padding: '0.1rem 0.4rem',
                        border: `1px solid ${d.isGhost ? '#6b7280' : (VERB_COLOR[d.verb] ?? '#374151')}`,
                        borderRadius: 3,
                        color: d.isGhost ? '#9ca3af' : (VERB_COLOR[d.verb] ?? '#d1d5db'),
                        background: d.isGhost ? 'transparent' : `color-mix(in oklab, ${VERB_COLOR[d.verb] ?? '#374151'}, transparent 88%)`,
                      }}>
                        {d.verb}
                      </span>
                      {d.isGhost && <span style={{ marginLeft: 6, fontSize: '0.7rem', color: '#f87171' }}>ghost</span>}
                    </td>
                    <td style={{ padding: '0.35rem 0.6rem', fontFamily: 'monospace', color: '#d1d5db', fontSize: '0.75rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {d.args || <span style={{ color: '#4b5563' }}>—</span>}
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
