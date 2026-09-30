'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2, ChevronRight, ChevronDown } from 'lucide-react';
import type { ActionBlock } from './HarnessChat';

const TARGET_LABEL: Record<string, string> = {
  'SPEC.md': 'SPEC.md',
  'contract': 'validation-contract.md',
  'supervisor': 'supervisor-notes.md',
};

interface Parsed {
  kind: 'proposal' | 'patch' | 'note';
  target: string;
  summary: string;
  body: string;
  hasSummary: boolean;
}

function parseBlock(tag: string, content: string): Parsed {
  const [rawKind, target] = tag.split(':');
  const kind = (rawKind === 'proposal' ? 'proposal' : rawKind === 'note' ? 'note' : 'patch') as Parsed['kind'];
  const trimmed = content.trim();

  if (kind === 'proposal') {
    // Format:
    //   SUMMARY: <text>     (first N lines)
    //   ---                  (separator line)
    //   <body>               (replacement file contents)
    const lines = trimmed.split('\n');
    const sep = lines.findIndex((l) => /^-{3,}$/.test(l.trim()));
    if (sep > 0) {
      const sumLines = lines.slice(0, sep).join('\n').trim().replace(/^SUMMARY:\s*/i, '').trim();
      const body = lines.slice(sep + 1).join('\n').trimEnd();
      return { kind, target, summary: sumLines || '(no summary)', body, hasSummary: sumLines.length > 0 };
    }
    // Malformed — no separator. Treat everything as body, no summary.
    return { kind, target, summary: '', body: trimmed, hasSummary: false };
  }
  if (kind === 'note') {
    // A note is short; show first ~2 lines as summary, full text as body.
    const summary = trimmed.split('\n').slice(0, 2).join(' ').slice(0, 160);
    return { kind, target: 'supervisor', summary, body: trimmed, hasSummary: true };
  }
  // Legacy patch — no summary provided.
  return { kind, target, summary: '', body: trimmed, hasSummary: false };
}

export function PatchBlock({
  slug,
  block,
  onReviewAccepted,
}: {
  slug: string;
  block: ActionBlock;
  onReviewAccepted?: () => void;
}) {
  const [state, setState] = useState<'idle' | 'applying' | 'applied'>('idle');
  const [expanded, setExpanded] = useState(false);

  const parsed = useMemo(() => parseBlock(block.tag, block.content), [block.tag, block.content]);
  const label = TARGET_LABEL[parsed.target] ?? parsed.target;

  const apply = async () => {
    setState('applying');
    try {
      const res = await fetch(`/api/harness/${slug}/architect/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: parsed.target, content: parsed.body }),
      });
      if (!res.ok) throw new Error(await res.text());
      setState('applied');
      toast.success(`Applied to ${label}`);
    } catch (e: any) {
      toast.error(`Failed to apply: ${e?.message ?? e}`);
      setState('idle');
    }
  };

  const lineCount = parsed.body.split('\n').length;

  return (
    <div className="h-action-block">
      <div className="h-action-head">
        <span className="h-action-head-label">
          {parsed.kind === 'note' ? 'note →' : 'proposed →'}
        </span>
        <span className="h-action-head-target">{label}</span>
        <div className="h-action-head-btns">
          <button
            className={`h-btn ${state === 'applied' ? 'ghost' : 'primary'}`}
            onClick={apply}
            disabled={state !== 'idle'}
            style={{ padding: '2px 8px', fontSize: 10 }}
          >
            {state === 'applied' ? <><Check size={10} /> applied</>
              : state === 'applying' ? <><Loader2 size={10} className="h-spin" /> applying</>
                : 'accept'}
          </button>
          {state === 'applied' && onReviewAccepted && (
            <button className="h-btn ghost" onClick={onReviewAccepted} style={{ padding: '2px 8px', fontSize: 10 }}>
              resolve review
            </button>
          )}
        </div>
      </div>

      {/* Summary block — the thing the user actually reads. */}
      {parsed.hasSummary ? (
        <div style={{
          padding: '10px 12px',
          fontSize: 12,
          lineHeight: 1.55,
          color: 'var(--fg)',
          background: 'color-mix(in oklab, var(--bg-2), white 2%)',
          borderBottom: '1px solid color-mix(in oklab, var(--border), transparent 40%)',
        }}>
          {parsed.summary}
        </div>
      ) : (
        <div style={{
          padding: '8px 12px',
          fontSize: 11,
          color: 'var(--fg-dim)',
          fontStyle: 'italic',
          borderBottom: '1px solid color-mix(in oklab, var(--border), transparent 40%)',
        }}>
          No summary provided — review the change below before accepting.
        </div>
      )}

      {/* Details disclosure — the raw body. */}
      <button
        onClick={() => setExpanded((e) => !e)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          width: '100%',
          padding: '5px 12px',
          background: 'transparent',
          border: 'none',
          borderBottom: '1px solid color-mix(in oklab, var(--border), transparent 40%)',
          color: 'var(--fg-dim)',
          fontSize: 10,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {expanded ? 'hide change' : `show change · ${lineCount} line${lineCount === 1 ? '' : 's'}`}
      </button>
      {expanded && (
        <pre className="h-action-body expanded" style={{ maxHeight: '40vh', overflow: 'auto' }}>
          {parsed.body}
        </pre>
      )}
    </div>
  );
}
