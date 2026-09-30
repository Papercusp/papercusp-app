'use client';

import { useEffect, useState } from 'react';
import { useQueryState, parseAsBoolean } from 'nuqs';

interface Hit {
  harness: string;
  filename: string;
  line: number;
  snippet: string;
}

/**
 * Lists all markdown files in the workspace that contain [[target]] references
 * to the current file. Greps at view-time via /api/wiki-backlinks. Renders
 * compactly so it can dock alongside an editor surface.
 *
 * @param target  Filename WITHOUT `.md` (e.g. "knowledge", "supervisor-notes")
 * @param harness Optional harness slug to disambiguate same-named files
 */
export function BacklinksPanel({
  target,
  harness,
}: {
  target: string;
  harness?: string;
}) {
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useQueryState('backlinks', parseAsBoolean.withDefault(true));

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ target });
    if (harness) params.set('harness', harness);
    fetch(`/api/wiki-backlinks?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setHits(d.hits ?? []); })
      .catch(() => { if (!cancelled) setHits([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [target, harness]);

  if (!target) return null;
  const count = hits?.length ?? 0;

  return (
    <div style={{
      borderTop: '1px solid var(--border, #2a2a2a)',
      background: 'var(--bg-2, #15181c)',
      fontSize: 12,
    }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%', textAlign: 'left',
          padding: '8px 12px',
          background: 'transparent',
          border: 0,
          color: 'var(--fg-dim)',
          textTransform: 'uppercase',
          fontSize: 11,
          cursor: 'pointer',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}
      >
        <span>↩ Backlinks ({loading ? '…' : count})</span>
        <span style={{ fontSize: 10 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && hits !== null && (
        <div style={{ padding: '0 12px 8px', maxHeight: 200, overflowY: 'auto' }}>
          {hits.length === 0 ? (
            <div style={{ color: 'var(--fg-mute)', fontStyle: 'italic', padding: '4px 0' }}>
              No files reference <code style={{ background: 'var(--bg, #0b0d10)', padding: '1px 4px', borderRadius: 3 }}>[[{target}]]</code>.
            </div>
          ) : (
            hits.map((h, i) => (
              <a
                key={`${h.harness}/${h.filename}/${h.line}/${i}`}
                href={`/wiki?target=${encodeURIComponent(h.filename.replace(/\.md$/, '').split('/').pop() ?? '')}&harness=${encodeURIComponent(h.harness)}`}
                style={{
                  display: 'block',
                  padding: '6px 8px',
                  margin: '4px 0',
                  background: 'var(--bg, #0b0d10)',
                  border: '1px solid var(--border, #2a2a2a)',
                  borderRadius: 3,
                  textDecoration: 'none',
                  color: 'var(--fg)',
                }}
              >
                <div style={{ color: '#6ab0ff', fontSize: 11 }}>
                  {h.harness}/{h.filename}<span style={{ color: 'var(--fg-mute)' }}> · L{h.line}</span>
                </div>
                <div style={{ color: 'var(--fg-dim)', fontSize: 11, marginTop: 2, fontFamily: 'ui-monospace, monospace' }}>
                  {h.snippet}
                </div>
              </a>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default BacklinksPanel;
