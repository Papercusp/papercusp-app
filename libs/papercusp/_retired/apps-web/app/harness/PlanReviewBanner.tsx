'use client';

import { useCallback, useEffect, useState } from 'react';

interface Props {
  slug: string;
}

function extractVerdict(content: string): string | null {
  const match = content.match(/^VERDICT:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

const VERDICT_TONE: Record<string, { bg: string; border: string; fg: string; icon: string }> = {
  accept: { bg: '#064e3b', border: '#10b981', fg: '#a7f3d0', icon: '✓' },
  'accept-with-notes': { bg: '#1e3a8a', border: '#3b82f6', fg: '#93c5fd', icon: '◐' },
  reject: { bg: '#7f1d1d', border: '#ef4444', fg: '#fca5a5', icon: '⚠' },
};

export default function PlanReviewBanner({ slug }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await fetch(`/api/harness/${slug}/plan-review`).then((r) => r.json());
      setContent(d.content ?? null);
    } catch {
      setContent(null);
    }
  }, [slug]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  if (!content || dismissed) return null;
  const verdict = extractVerdict(content) ?? 'unknown';
  const key = verdict.toLowerCase().replace(/\s/g, '-');
  const tone = VERDICT_TONE[key] ?? { bg: '#1f2937', border: '#374151', fg: '#d1d5db', icon: 'ℹ' };

  return (
    <div style={{
      background: tone.bg,
      border: `1px solid ${tone.border}`,
      borderLeft: `4px solid ${tone.border}`,
      borderRadius: 4,
      padding: '0.6rem 0.9rem',
      marginBottom: '0.75rem',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', fontSize: '0.8rem', color: tone.fg }}>
        <span style={{ fontWeight: 700 }}>{tone.icon} Plan review · <code style={{ fontFamily: 'ui-monospace, monospace' }}>{verdict}</code></span>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{ background: 'transparent', border: `1px solid ${tone.border}`, color: tone.fg, borderRadius: 3, padding: '0.2rem 0.55rem', cursor: 'pointer', fontSize: '0.7rem' }}
        >
          {open ? 'hide' : 'show details'}
        </button>
        <span style={{ marginLeft: 'auto', fontFamily: 'ui-monospace, monospace', color: tone.fg, fontSize: '0.7rem', opacity: 0.75 }}>
          .papercusp/plan-review.md
        </span>
        <button
          onClick={() => setDismissed(true)}
          style={{ background: 'transparent', border: 'none', color: tone.fg, cursor: 'pointer', fontSize: '0.9rem', opacity: 0.7 }}
          title="Dismiss for this session"
        >
          ✕
        </button>
      </div>
      {open && (
        <pre style={{ margin: '0.5rem 0 0 0', padding: '0.5rem 0.75rem', background: '#0b0e14', color: '#d1d5db', fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem', borderRadius: 3, maxHeight: '30vh', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
          {content}
        </pre>
      )}
    </div>
  );
}
