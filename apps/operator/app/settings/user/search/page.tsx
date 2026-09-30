'use client';

import { useState, useCallback, FormEvent } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import { Select } from '@/app/harness/Select';
import { Tooltip } from '@/app/harness/Tooltip';
import { hitDisplayHtml } from '@/lib/search-highlight';

// Neutral memory entry from /api/user/search (generalize-memory-backend-
// swappable D-003) — backend-agnostic shape, `text` not a mem0 row.
interface MemoryHit {
  id: string;
  text: string;
  kind?: string;
  score?: number;
  scope: 'user' | 'workspace';
  metadata?: Record<string, unknown>;
}
interface ProseHit {
  source: 'escalations' | 'brainstorm' | 'turns';
  source_id: string;
  harness_slug?: string;
  excerpt: string;
  highlight: string;
  rank: number;
}

const SOURCE_COLOR: Record<ProseHit['source'], string> = {
  escalations: 'var(--warn)',
  brainstorm:  'var(--accent)',
  turns:       'var(--good)',
};

export default function SearchPage() {
  // URL-backed (nuqs) so agents can read + drive the search and it
  // survives reloads/deep-links.
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [mode, setMode] = useQueryState('mode', parseAsStringEnum<'bm25' | 'hybrid'>(['bm25', 'hybrid']).withDefault('bm25'));
  const [memories, setMemories] = useState<MemoryHit[]>([]);
  const [prose, setProse] = useState<ProseHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const onSubmit = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const r = await fetch(`/api/user/search?q=${encodeURIComponent(q)}&limit=10&mode=${mode}`);
      const j = await r.json();
      setMemories(j.memories ?? []);
      setProse(j.prose ?? []);
    } finally {
      setLoading(false);
    }
  }, [q, mode]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header>
        <h1>Search workspace</h1>
        <p className="pc-settings-intro">
          Searches your personal memories and the workspace prose
          (operator turns, escalations, brainstorm notes) in one place.
          Memories use semantic similarity; prose uses keyword match (BM25).
        </p>
      </header>

      <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          type="search"
          value={q}
          onChange={(e) => void setQ(e.target.value || null)}
          placeholder="What do you remember about…"
          autoFocus
          style={{ flex: 1, minWidth: 240 }}
        />
        <Tooltip label="bm25: keyword-only (fast, deterministic). hybrid: combines keyword + semantic via RRF (needs embedder).">
          <span>
            <Select
              value={mode}
              onChange={(v) => void setMode(v as 'bm25' | 'hybrid')}
              options={[
                { value: 'bm25', label: 'bm25' },
                { value: 'hybrid', label: 'hybrid' },
              ]}
              ariaLabel="Search mode"
            />
          </span>
        </Tooltip>
        <button type="submit" disabled={loading || !q.trim()} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-3)', cursor: 'pointer', fontSize: 14, opacity: loading ? 0.6 : 1 }}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {searched && !loading && memories.length === 0 && prose.length === 0 && (
        <p style={{ color: 'var(--fg-mute)' }}>No results.</p>
      )}

      {memories.length > 0 && (
        <section className="pc-settings-section">
          <h4 className="pc-settings-eyebrow">
            Memories ({memories.length})
          </h4>
          <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {memories.map((m) => (
              <li key={m.id} style={{ padding: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-2)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
                  {m.scope === 'workspace' && (
                    <span style={{ padding: '2px 8px', borderRadius: 4, background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 11 }}>shared</span>
                  )}
                  {typeof m.score === 'number' && (
                    <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>score {m.score.toFixed(2)}</span>
                  )}
                </div>
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {prose.length > 0 && (
        <section className="pc-settings-section">
          <h4 className="pc-settings-eyebrow">
            Prose ({prose.length})
          </h4>
          <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {prose.map((h) => (
              <li key={`${h.source}:${h.source_id}`} style={{ padding: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-2)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
                  <span style={{ padding: '2px 8px', borderRadius: 4, background: SOURCE_COLOR[h.source], color: 'var(--accent-ink)', fontSize: 11, fontWeight: 600 }}>{h.source}</span>
                  {h.harness_slug && (
                    <span style={{ padding: '2px 8px', borderRadius: 4, background: 'var(--bg-3)', fontSize: 11 }}>{h.harness_slug}</span>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>rank {h.rank.toFixed(3)}</span>
                </div>
                <div
                  style={{ wordBreak: 'break-word' }}
                  data-testid="prose-hit-body"
                  // Prose hits are drawn from escalations / brainstorm notes / operator turns —
                  // corpora that quote markup as a matter of course — so the headline is escaped
                  // down to its own <mark> tags before it touches innerHTML (P-003).
                  //
                  // `|| excerpt` is not cosmetic: in `hybrid` mode a purely SEMANTIC hit has no
                  // matched term to mark, and any hit whose source deferred highlight hydration
                  // (WI-4734) can arrive with `highlight: ''`. Without the fallback those rows
                  // render as blank cards. Both arms go through the same escaper.
                  dangerouslySetInnerHTML={{ __html: hitDisplayHtml(h) }}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
