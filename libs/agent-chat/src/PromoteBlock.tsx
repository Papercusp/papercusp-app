'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2, ArrowUpRight } from 'lucide-react';
import type { ActionBlock } from './HarnessChat';

const TARGET_LABEL: Record<string, string> = {
  feature: 'features.json',
  spec: 'SPEC.md',
  issue: 'issues.json',
};

// promote:feature / promote:spec / promote:issue
// Content is either markdown text (spec) or JSON-ish body (feature/issue).
export function PromoteBlock({
  slug,
  block,
}: {
  slug: string;
  block: ActionBlock;
}) {
  const [state, setState] = useState<'idle' | 'applying' | 'applied'>('idle');
  const [expanded, setExpanded] = useState(false);

  const kind = block.tag.split(':')[1] ?? 'feature'; // feature|spec|issue

  const apply = async () => {
    setState('applying');
    try {
      const res = await fetch(`/api/harness/${slug}/brainstorm/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: kind, content: block.content }),
      });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      setState('applied');
      toast.success(`Promoted to ${TARGET_LABEL[kind] ?? kind}${d.id ? ' · ' + d.id : ''}`);
    } catch (e: any) {
      toast.error(`Promote failed: ${e?.message ?? e}`);
      setState('idle');
    }
  };

  const previewLines = block.content.split('\n').slice(0, 6);
  const hasMore = block.content.split('\n').length > 6;

  return (
    <div className="h-action-block">
      <div className="h-action-head">
        <span className="h-action-head-label"><ArrowUpRight size={10} /> promote →</span>
        <span className="h-action-head-target">{TARGET_LABEL[kind] ?? kind}</span>
        <div className="h-action-head-btns">
          <button
            className={`h-btn ${state === 'applied' ? 'ghost' : 'primary'}`}
            onClick={apply}
            disabled={state !== 'idle'}
            style={{ padding: '2px 8px', fontSize: 10 }}
          >
            {state === 'applied' ? <><Check size={10} /> promoted</>
              : state === 'applying' ? <><Loader2 size={10} className="h-spin" /> …</>
                : 'promote'}
          </button>
        </div>
      </div>
      <pre className={`h-action-body${expanded ? ' expanded' : ''}`}>
        {expanded ? block.content : previewLines.join('\n')}
        {!expanded && hasMore && (
          <button className="h-action-more" onClick={() => setExpanded(true)}>
            … show all ({block.content.split('\n').length} lines)
          </button>
        )}
      </pre>
    </div>
  );
}
