'use client';

import { useCallback, useEffect, useState } from 'react';

interface TimelineEvent {
  ts: number;
  iso: string;
  kind: string;
  detail: string;
}

interface Payload {
  featureId: string;
  events: TimelineEvent[];
}

interface Props {
  slug: string;
  featureId: string;
  onClose: () => void;
}

const KIND_META: Record<string, { color: string; icon: string; label: string }> = {
  status_change: { color: '#a855f7', icon: '⇄', label: 'status' },
  agent_run:     { color: '#3b82f6', icon: '▶', label: 'run' },
  debug_note:    { color: '#f59e0b', icon: '🐞', label: 'debug' },
  pr_opened:     { color: '#10b981', icon: '🔗', label: 'PR' },
};

function fmtTs(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function FeatureTimelinePanel({ slug, featureId, onClose }: Props) {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/harness/${slug}/features/${featureId}/timeline`);
      if (!r.ok) throw new Error(`${r.status}`);
      const d: Payload = await r.json();
      setData(d);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, [slug, featureId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const events = data?.events ?? [];

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
      onClick={onClose}
    >
      <div
        style={{ background: '#0b0e14', border: '1px solid #374151', borderRadius: 6, width: '70vw', maxWidth: 820, maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', color: '#e5e7eb' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Timeline</strong>
          <span style={{ fontFamily: 'monospace', color: '#9ca3af', fontSize: '0.8rem' }}>{featureId}</span>
          <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#6b7280' }}>
            {events.length} event{events.length === 1 ? '' : 's'}
          </span>
          {err && <span style={{ color: '#f87171', fontSize: '0.8rem' }}>err: {err}</span>}
          <button
            onClick={onClose}
            style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            close (esc)
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '1rem 1.25rem' }}>
          {!data ? (
            <div style={{ color: '#6b7280', textAlign: 'center', padding: '2rem' }}>loading…</div>
          ) : events.length === 0 ? (
            <div style={{ color: '#6b7280', textAlign: 'center', padding: '2rem' }}>
              No events yet. Events are aggregated from snapshots, agent runs, debug notes, and PR metadata.
            </div>
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, position: 'relative' }}>
              <div style={{ position: 'absolute', left: 18, top: 0, bottom: 0, width: 1, background: '#374151' }} />
              {events.map((ev, i) => {
                const meta = KIND_META[ev.kind] ?? { color: '#6b7280', icon: '•', label: ev.kind };
                const isPrUrl = ev.kind === 'pr_opened' && /^https?:\/\//.test(ev.detail);
                return (
                  <li key={i} style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.75rem', position: 'relative' }}>
                    <div style={{
                      flex: '0 0 36px',
                      height: 36,
                      borderRadius: '50%',
                      background: `color-mix(in oklab, ${meta.color}, transparent 80%)`,
                      border: `1px solid ${meta.color}`,
                      color: meta.color,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '0.9rem',
                      zIndex: 1,
                    }}>
                      {meta.icon}
                    </div>
                    <div style={{ flex: 1, paddingTop: 4 }}>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span style={{
                          fontSize: '0.7rem', padding: '0.1rem 0.45rem',
                          border: `1px solid ${meta.color}`, borderRadius: 3,
                          color: meta.color, fontFamily: 'monospace',
                        }}>
                          {meta.label}
                        </span>
                        <span style={{ fontFamily: 'monospace', color: '#9ca3af', fontSize: '0.75rem' }}>{fmtTs(ev.ts)}</span>
                      </div>
                      <div style={{ marginTop: '0.3rem', fontSize: '0.85rem', color: '#e5e7eb', wordBreak: 'break-word' }}>
                        {isPrUrl ? (
                          <a href={ev.detail} target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6' }}>
                            {ev.detail}
                          </a>
                        ) : ev.detail}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
