'use client';

/**
 * Global content search (Discord-parity Mod+Shift+F — discord-shortcuts
 * 2026-06-06, deferred-items pass).
 *
 * A thin overlay on the operator's prose search: POSTs the public
 * `/api/agent-tools/search/fulltext` endpoint (BM25 over plans / docs /
 * turns / decisions / escalations, cross-encoder reranked server-side)
 * and lists the hits. v1 is read-only — hits show source · harness ·
 * highlighted excerpt; per-source deep-link navigation is a follow-up
 * once the source→route mapping is settled.
 *
 * State lives in nuqs (`?gsearch=1&gq=…`) per the repo rule — the overlay
 * is deep-linkable, survives reload, and agent-driveable. Only the fetch
 * is debounced.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
// This dialog reuses the cheat-sheet's overlay class; the rules ride with the
// components (see ShortcutsCheatSheet), so a host mounting this without the
// operator's globals.css still gets them (portal-global-shortcuts-2026-09-06 P-001).
import './shortcuts-cheat-sheet.css';
import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { useShortcutAction } from '../../lib/hotkeys';
import { useRouter } from '../../lib/router-compat/navigation';

export interface FulltextHit {
  source: string;
  source_id: string;
  harness_slug?: string;
  excerpt: string;
  highlight?: string;
  rank?: number;
}

/**
 * Map a fulltext hit to the GUI route that shows it. The four prose
 * sources today (see agent-tools/search/sources.ts): `brainstorm` /
 * `escalations` / `decisions` are per-harness (hit.harness_slug carries
 * the slug; decisions/escalations land on the harness overview — the
 * finest stable surface for them today); `turns` are the global operator
 * conversation. Unknown sources → null (hit renders unlinked).
 */
export function hitHref(hit: Pick<FulltextHit, 'source' | 'harness_slug'>): string | null {
  const slug = hit.harness_slug ? `slug=${encodeURIComponent(hit.harness_slug)}&` : '';
  switch (hit.source) {
    case 'brainstorm':
      return `/adv?${slug}tab=brainstorm`;
    case 'escalations':
    case 'decisions':
      return hit.harness_slug ? `/adv?${slug}tab=overview` : '/adv';
    case 'turns':
      return '/adv?tab=conversations';
    default:
      return null;
  }
}

/**
 * Render ONLY the engine's own match marker as a <mark> ELEMENT; everything
 * else is emitted as text nodes. This is XSS-safe by construction — it never
 * touches `dangerouslySetInnerHTML` — which is why this surface deliberately
 * does NOT use `@/lib/search-highlight` (that helper escapes a string for
 * innerHTML; this builds React nodes, a strictly stronger position).
 *
 * ⚠ THE MARKER IS `<mark>`, NOT ts_headline's `<b>` DEFAULT. `HEADLINE_OPTS` in
 * `packages/operator-core/lib/agent-tools/search/sources.ts` sets
 * `StartSel=<mark>`, and `search:fulltext` — the tool behind the
 * `/api/agent-tools/search/fulltext` endpoint this dialog POSTs — passes that
 * headline through untouched. This split read `<b>` until 2026-09-04, which
 * matched nothing: the dialog showed every headline as plain text with literal
 * `<mark>` tags visible, and highlighting was silently dead. Both the code AND
 * its test had copied the ASSUMED default, so they agreed with each other and
 * neither measured the engine — which is why the fix is not just this literal
 * but the divergence check beside it: `GlobalSearchDialog.component.test.tsx`
 * asserts this marker against the real `HEADLINE_OPTS`, so changing the engine's
 * `StartSel` without changing this split now fails a test instead of quietly
 * turning highlighting off again.
 */
export function renderHighlight(s: string): ReactNode[] {
  const parts = s.split(/<mark>(.*?)<\/mark>/g);
  return parts
    .map((part, i) =>
      part ? (
        i % 2 === 1 ? (
          <mark key={i} className="pc-gsearch__mark">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      ) : null,
    )
    .filter(Boolean) as ReactNode[];
}

export default function GlobalSearchDialog() {
  const [open, setOpen] = useQueryState('gsearch', parseAsBoolean.withDefault(false));
  const [query, setQuery] = useQueryState('gq', parseAsString.withDefault(''));
  const [hits, setHits] = useState<FulltextHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const router = useRouter();

  const openHit = (h: FulltextHit) => {
    const href = hitHref(h);
    if (!href) return;
    void setOpen(false);
    router.push(href);
  };

  useShortcutAction('search.global', () => {
    void setOpen(!open);
  }, { enableOnFormTags: ['INPUT', 'TEXTAREA'] });

  // Debounced fetch while the overlay is open. <2 chars clears results
  // rather than spamming the endpoint with single letters.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setHits(null);
      setError(null);
      return;
    }
    const t = setTimeout(() => {
      setBusy(true);
      setError(null);
      fetch('/api/agent-tools/search/fulltext', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, limit: 10 }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((body) => {
          const parsed = JSON.parse(body?.content?.[0]?.text ?? '{}');
          setHits(Array.isArray(parsed.results) ? (parsed.results as FulltextHit[]) : []);
        })
        .catch((e) => setError(String((e as Error)?.message ?? e)))
        .finally(() => setBusy(false));
    }, 300);
    return () => clearTimeout(t);
  }, [open, query]);

  // Focus the input when the overlay opens.
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) void setOpen(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="kbd-cheat-overlay" />
        <Dialog.Content
          aria-label="Search everywhere"
          style={{
            position: 'fixed',
            top: '12vh',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 'min(640px, 92vw)',
            maxHeight: '70vh',
            overflow: 'hidden auto',
            background: 'var(--pc-surface, #16181d)',
            color: 'var(--pc-text, #e5e7eb)',
            border: '1px solid var(--pc-border, #2a2e37)',
            borderRadius: 10,
            padding: 16,
            zIndex: 1000,
            boxShadow: '0 18px 50px rgba(0,0,0,.5)',
          }}
        >
          <Dialog.Title style={{ fontSize: 13, opacity: 0.7, margin: '0 0 8px' }}>
            Search everywhere
          </Dialog.Title>
          <Dialog.Description style={{ fontSize: 11, opacity: 0.5, margin: '0 0 8px' }}>
            Full-text search across plans, docs, conversation turns, and decisions.
          </Dialog.Description>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => void setQuery(e.target.value)}
            placeholder="Search plans, docs, turns, decisions…"
            aria-label="Search query"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid var(--pc-border, #2a2e37)',
              background: 'var(--pc-surface-2, #0f1115)',
              color: 'inherit',
              fontSize: 14,
            }}
          />
          <div style={{ marginTop: 10 }}>
            {busy && <div style={{ fontSize: 12, opacity: 0.6 }}>Searching…</div>}
            {error && (
              <div role="alert" style={{ fontSize: 12, color: '#f87171' }}>
                Search failed: {error}
              </div>
            )}
            {hits && hits.length === 0 && !busy && (
              <div style={{ fontSize: 12, opacity: 0.6 }}>No results.</div>
            )}
            {hits && hits.length > 0 && (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {hits.map((h, i) => {
                  const linked = hitHref(h) != null;
                  return (
                    <li
                      key={`${h.source}:${h.source_id}:${i}`}
                      data-testid="gsearch-hit"
                      {...(linked
                        ? {
                            role: 'button' as const,
                            tabIndex: 0,
                            onClick: () => openHit(h),
                            onKeyDown: (e: React.KeyboardEvent) => {
                              if (e.key === 'Enter') openHit(h);
                            },
                          }
                        : {})}
                      style={{
                        padding: '8px 6px',
                        borderBottom: '1px solid var(--pc-border, #232730)',
                        cursor: linked ? 'pointer' : 'default',
                      }}
                    >
                      <div style={{ fontSize: 11, opacity: 0.65, display: 'flex', gap: 8 }}>
                        <span>{h.source}</span>
                        {h.harness_slug && <span>· {h.harness_slug}</span>}
                        {linked && <span style={{ marginLeft: 'auto', opacity: 0.5 }}>↵ open</span>}
                      </div>
                      <div style={{ fontSize: 13, marginTop: 2 }}>
                        {renderHighlight(h.highlight || h.excerpt || '')}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
