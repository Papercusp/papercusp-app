'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ArchitectChat from './ArchitectChat';
import PromotionCard from './PromotionCard';

export interface PendingReview {
  id: string;
  featureId: string;
  kind: string;
  summary?: string;
  question: string;
  recommendedAnswer?: string;
  tradeoff?: string;
  context?: string;
  ts: number;
  claim?: string;
  resolved?: boolean;
  userResponse?: string;
}

interface Thread {
  id: string;
  title: string;
  createdAt: number;
  pinned?: boolean;
}

interface Props {
  slug: string;
  onFeatureFocus?: (featureId: string) => void;
}

type InboxFilter = 'all' | 'reviews' | 'threads' | 'pinned';
type KindFilter = 'all' | string;

const KIND_META: Record<string, { label: string; tone: string }> = {
  'spec-ambiguity': { label: 'ambiguity', tone: 'warn' },
  preference: { label: 'preference', tone: 'info' },
  'env-blocker': { label: 'env', tone: 'bad' },
  'perf-goal': { label: 'perf', tone: 'purple' },
  'cost-cap': { label: 'cost', tone: 'rose' },
  'scope-change': { label: 'scope', tone: 'violet' },
  promotion: { label: 'promotion', tone: 'good' },
};

function asMillis(ts: number): number {
  return ts > 10_000_000_000 ? ts : ts * 1000;
}

function fmtAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - asMillis(ts));
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function reviewText(review: PendingReview): string {
  return review.summary || review.question || review.claim || review.kind;
}

function reviewSubtext(review: PendingReview): string {
  return review.recommendedAnswer || review.tradeoff || review.context || 'Needs an answer before the harness can continue confidently.';
}

function matchesReview(review: PendingReview, needle: string): boolean {
  if (!needle) return true;
  const haystack = [
    review.id,
    review.featureId,
    review.kind,
    review.summary,
    review.question,
    review.recommendedAnswer,
    review.tradeoff,
    review.context,
    review.claim,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(needle);
}

function matchesThread(thread: Thread, needle: string): boolean {
  if (!needle) return true;
  return `${thread.title} ${thread.id}`.toLowerCase().includes(needle);
}

const THREADS_KEY = (slug: string) => `harness.threads.${slug}`;

const IDEA_TEMPLATES = [
  'Clarify the current blocker and propose the smallest unblock path',
  'Propose the next user-facing improvement for this harness',
  'Ask for a validation plan before the next worker starts',
];

export default function ArchitectInbox({ slug, onFeatureFocus }: Props) {
  const [reviews, setReviews] = useState<PendingReview[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [active, setActive] = useState<
    | { kind: 'review'; review: PendingReview }
    | { kind: 'thread'; thread: Thread }
    | { kind: 'new' }
    | null
  >(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [composing, setComposing] = useState(false);
  const [ideaDraft, setIdeaDraft] = useState('');
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadReviews = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetch(`/api/harness/${slug}/reviews`).then((r) => r.json());
      setReviews(d.reviews ?? []);
    } catch {
    } finally {
      setLastSync(Date.now());
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    loadReviews();
    pollRef.current = setInterval(loadReviews, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadReviews]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(THREADS_KEY(slug));
      setThreads(raw ? JSON.parse(raw) : []);
    } catch {
      setThreads([]);
    }
  }, [slug]);

  const saveThreads = useCallback((next: Thread[]) => {
    setThreads(next);
    try { localStorage.setItem(THREADS_KEY(slug), JSON.stringify(next)); } catch {}
  }, [slug]);

  const createThread = useCallback((title?: string) => {
    const trimmed = title?.trim();
    const t: Thread = {
      id: `thread-${Date.now()}`,
      title: trimmed || 'New idea',
      createdAt: Date.now(),
      pinned: false,
    };
    saveThreads([t, ...threads]);
    setActive({ kind: 'thread', thread: t });
  }, [saveThreads, threads]);

  const openComposer = useCallback((template?: string) => {
    setComposing(true);
    setIdeaDraft(template ?? '');
  }, []);

  const submitIdea = useCallback(() => {
    createThread(ideaDraft);
    setComposing(false);
    setIdeaDraft('');
  }, [createThread, ideaDraft]);

  const renameThread = useCallback((id: string, title: string) => {
    saveThreads(threads.map((t) => (t.id === id ? { ...t, title } : t)));
  }, [saveThreads, threads]);

  const deleteThread = useCallback((id: string) => {
    saveThreads(threads.filter((t) => t.id !== id));
    if (active?.kind === 'thread' && active.thread.id === id) setActive(null);
  }, [active, saveThreads, threads]);

  const toggleThreadPin = useCallback((id: string) => {
    saveThreads(threads.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)));
  }, [saveThreads, threads]);

  const counts = useMemo(() => {
    const promotions = reviews.filter((r) => r.kind === 'promotion').length;
    const blockers = reviews.filter((r) => /blocker|ambiguity|cost|scope/.test(r.kind)).length;
    const pinned = threads.filter((t) => t.pinned).length;
    const latest = Math.max(
      0,
      ...reviews.map((r) => asMillis(r.ts)),
      ...threads.map((t) => t.createdAt),
    );
    return {
      total: reviews.length + threads.length,
      reviews: reviews.length,
      threads: threads.length,
      pinned,
      promotions,
      blockers,
      latest,
    };
  }, [reviews, threads]);

  const kindOptions = useMemo(() => {
    const countsByKind = new Map<string, number>();
    for (const review of reviews) countsByKind.set(review.kind, (countsByKind.get(review.kind) ?? 0) + 1);
    return [...countsByKind.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([kind, count]) => ({
        kind,
        count,
        label: KIND_META[kind]?.label ?? kind,
        tone: KIND_META[kind]?.tone ?? 'default',
      }));
  }, [reviews]);

  useEffect(() => {
    if (kindFilter !== 'all' && !reviews.some((review) => review.kind === kindFilter)) setKindFilter('all');
  }, [kindFilter, reviews]);

  const needle = query.trim().toLowerCase();
  const visibleReviews = useMemo(() => {
    if (filter === 'threads' || filter === 'pinned') return [];
    return reviews
      .filter((review) => kindFilter === 'all' || review.kind === kindFilter)
      .filter((review) => matchesReview(review, needle))
      .sort((a, b) => asMillis(b.ts) - asMillis(a.ts));
  }, [filter, kindFilter, needle, reviews]);

  const visibleThreads = useMemo(() => {
    if (filter === 'reviews') return [];
    return threads
      .filter((thread) => filter !== 'pinned' || thread.pinned)
      .filter((thread) => matchesThread(thread, needle))
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.createdAt - a.createdAt);
  }, [filter, needle, threads]);

  const latestTarget = useMemo(() => {
    const targets: Array<
      | { kind: 'review'; time: number; review: PendingReview }
      | { kind: 'thread'; time: number; thread: Thread }
    > = [
      ...visibleReviews.filter((review) => review.kind !== 'promotion').map((review) => ({ kind: 'review' as const, time: asMillis(review.ts), review })),
      ...visibleThreads.map((thread) => ({ kind: 'thread' as const, time: thread.createdAt, thread })),
    ];
    return targets.sort((a, b) => b.time - a.time)[0] ?? null;
  }, [visibleReviews, visibleThreads]);

  const openLatest = useCallback(() => {
    if (!latestTarget) return;
    setActive(latestTarget.kind === 'review'
      ? { kind: 'review', review: latestTarget.review }
      : { kind: 'thread', thread: latestTarget.thread });
  }, [latestTarget]);

  if (active) {
    return (
      <ChatPane
        slug={slug}
        target={active}
        onClose={() => setActive(null)}
        onReviewResolved={() => { setActive(null); loadReviews(); }}
        onRenameThread={renameThread}
        onDeleteThread={deleteThread}
        onFeatureFocus={onFeatureFocus}
      />
    );
  }

  const quiet = reviews.length === 0;
  const visibleCount = visibleReviews.length + visibleThreads.length;

  return (
    <div className="h-inbox-shell" data-harness-inbox>
      <div className="h-inbox-command">
        <div className="h-inbox-command-top">
          <div className="h-inbox-title-stack">
            <span className="h-inbox-eyebrow">Architect inbox</span>
            <strong>{quiet ? 'Decision radar clear' : `${reviews.length} decision${reviews.length === 1 ? '' : 's'} pending`}</strong>
          </div>
          <div className="h-inbox-top-actions">
            <button type="button" className="h-inbox-action ghost" onClick={loadReviews} disabled={loading}>
              {loading ? 'syncing' : 'sync'}
            </button>
            <button type="button" className="h-inbox-action primary" onClick={() => openComposer()}>+ idea</button>
            <button type="button" className="h-inbox-action ghost" onClick={openLatest} disabled={!latestTarget}>latest</button>
          </div>
        </div>

        <div className="h-inbox-stats" aria-label="Inbox totals">
          <Metric label="decisions" value={counts.reviews} tone={counts.reviews > 0 ? 'warn' : 'good'} />
          <Metric label="threads" value={counts.threads} />
          <Metric label="signals" value={counts.promotions + counts.blockers} tone={counts.blockers > 0 ? 'bad' : undefined} />
        </div>

        <div className="h-inbox-search-row">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-inbox-search"
            placeholder="Search feature, question, thread…"
            aria-label="Search inbox"
          />
        </div>

        <div className="h-inbox-filter-row" role="tablist" aria-label="Inbox filter">
          <FilterButton id="all" label="All" count={counts.total} filter={filter} setFilter={setFilter} />
          <FilterButton id="reviews" label="Decisions" count={counts.reviews} filter={filter} setFilter={setFilter} />
          <FilterButton id="threads" label="Threads" count={counts.threads} filter={filter} setFilter={setFilter} />
          <FilterButton id="pinned" label="Pinned" count={counts.pinned} filter={filter} setFilter={setFilter} />
        </div>


        {kindOptions.length > 0 && (
          <div className="h-inbox-kind-rail" role="listbox" aria-label="Review kind filter">
            <button
              type="button"
              className={`h-inbox-kind-chip ${kindFilter === 'all' ? 'on' : ''}`}
              onClick={() => setKindFilter('all')}
            >
              <span>all kinds</span>
              <b>{reviews.length}</b>
            </button>
            {kindOptions.map((option) => (
              <button
                key={option.kind}
                type="button"
                className={`h-inbox-kind-chip tone-${option.tone} ${kindFilter === option.kind ? 'on' : ''}`}
                onClick={() => setKindFilter(option.kind)}
              >
                <span>{option.label}</span>
                <b>{option.count}</b>
              </button>
            ))}
          </div>
        )}


        <div className="h-inbox-ops-row">
          <span>{lastSync ? `synced ${fmtAgo(lastSync)} ago` : 'syncing…'}</span>
          <span>{counts.latest ? `latest ${fmtAgo(counts.latest)} ago` : 'no activity'}</span>
          <span>{counts.pinned ? `${counts.pinned} pinned` : `${visibleCount} visible`}</span>
        </div>

        {composing && (
          <form className="h-inbox-compose" onSubmit={(e) => { e.preventDefault(); submitIdea(); }}>
            <label>
              <span>New Architect thread</span>
              <textarea
                value={ideaDraft}
                onChange={(e) => setIdeaDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitIdea();
                }}
                placeholder="What should the Architect think through?"
                rows={3}
                autoFocus
              />
            </label>
            <div className="h-inbox-template-row" aria-label="Thread templates">
              {IDEA_TEMPLATES.map((template) => (
                <button key={template} type="button" onClick={() => setIdeaDraft(template)}>
                  {template.replace(/^(Clarify|Propose|Ask)\s+/, '$1: ')}
                </button>
              ))}
            </div>
            <div className="h-inbox-compose-actions">
              <button type="submit" className="h-inbox-action primary">start thread</button>
              <button type="button" className="h-inbox-action ghost" onClick={() => { setComposing(false); setIdeaDraft(''); }}>cancel</button>
            </div>
          </form>
        )}
      </div>

      <div className="h-inbox-feed" role="list">
        {visibleCount === 0 && (
          <InboxEmpty
            title={needle ? 'No inbox matches' : quiet ? 'No escalations' : 'Nothing visible'}
            actionLabel={needle ? 'Clear search' : '+ draft idea'}
            onAction={needle ? () => setQuery('') : () => openComposer()}
          >
            {needle
              ? 'Try another feature id, review kind, or thread title.'
              : quiet
                ? 'Architect is resolving autonomously. Start an idea when you want to shape the next spec change.'
                : 'Change filters to see hidden decisions or threads.'}
          </InboxEmpty>
        )}

        {visibleReviews.length > 0 && (
          <InboxSection title="Pending decisions" count={visibleReviews.length} tone="warn">
            {visibleReviews.map((review) => (
              review.kind === 'promotion' ? (
                <div key={review.id} className="h-inbox-promotion">
                  <PromotionCard slug={slug} item={review as any} onResolved={() => loadReviews()} />
                </div>
              ) : (
                <ReviewRow key={review.id} review={review} onClick={() => setActive({ kind: 'review', review })} />
              )
            ))}
          </InboxSection>
        )}

        {visibleThreads.length > 0 && (
          <InboxSection title="Your threads" count={visibleThreads.length}>
            {visibleThreads.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} onClick={() => setActive({ kind: 'thread', thread })} onPin={() => toggleThreadPin(thread.id)} onDelete={() => deleteThread(thread.id)} />
            ))}
          </InboxSection>
        )}

        {!composing && (
          <TemplateDock
            onUse={(template) => openComposer(template)}
            compact={visibleCount > 0}
          />
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className={`h-inbox-metric ${tone ? `tone-${tone}` : ''}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function FilterButton({
  id, label, count, filter, setFilter,
}: {
  id: InboxFilter;
  label: string;
  count: number;
  filter: InboxFilter;
  setFilter: (filter: InboxFilter) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={filter === id}
      className={`h-inbox-filter ${filter === id ? 'on' : ''}`}
      onClick={() => setFilter(id)}
    >
      <span>{label}</span>
      <b>{count}</b>
    </button>
  );
}

function InboxSection({ title, count, tone, children }: { title: string; count: number; tone?: string; children: ReactNode }) {
  return (
    <section className="h-inbox-section">
      <div className={`h-inbox-section-title ${tone ? `tone-${tone}` : ''}`}>
        <span>{title}</span>
        <b>{count}</b>
      </div>
      <div className="h-inbox-section-body">{children}</div>
    </section>
  );
}

function InboxEmpty({ title, children, actionLabel, onAction }: { title: string; children: ReactNode; actionLabel: string; onAction: () => void }) {
  return (
    <div className="h-inbox-empty">
      <span className="h-inbox-empty-orb" aria-hidden="true" />
      <b>{title}</b>
      <p>{children}</p>
      <button type="button" className="h-inbox-action" onClick={onAction}>{actionLabel}</button>
    </div>
  );
}

function TemplateDock({ onUse, compact }: { onUse: (template: string) => void; compact?: boolean }) {
  return (
    <div className={`h-inbox-template-dock ${compact ? 'compact' : ''}`}>
      <div className="h-inbox-template-dock-head">
        <span>Architect playbook</span>
        <b>{IDEA_TEMPLATES.length}</b>
      </div>
      <div className="h-inbox-template-grid">
        {IDEA_TEMPLATES.map((template) => (
          <button key={template} type="button" onClick={() => onUse(template)}>
            {template.replace(/^(Clarify|Propose|Ask)\s+/, '$1: ')}
          </button>
        ))}
      </div>
    </div>
  );
}

function ReviewRow({ review, onClick }: { review: PendingReview; onClick: () => void }) {
  const meta = KIND_META[review.kind] ?? { label: review.kind, tone: 'default' };
  return (
    <button type="button" onClick={onClick} className={`h-inbox-row h-inbox-review tone-${meta.tone}`} role="listitem">
      <span className="h-inbox-feature">{review.featureId || review.kind}</span>
      <span className={`h-inbox-kind tone-${meta.tone}`}>{meta.label}</span>
      <span className="h-inbox-row-title">{reviewText(review)}</span>
      <span className="h-inbox-row-sub">{reviewSubtext(review)}</span>
      <span className="h-inbox-row-foot">
        <span>{fmtAgo(review.ts)} ago</span>
        <span>open chat →</span>
      </span>
    </button>
  );
}

function ThreadRow({ thread, onClick, onPin, onDelete }: { thread: Thread; onClick: () => void; onPin: () => void; onDelete: () => void }) {
  return (
    <div
      className={`h-inbox-row h-inbox-thread ${thread.pinned ? 'is-pinned' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
    >
      <span className="h-inbox-thread-dot" aria-hidden="true" />
      <span className="h-inbox-row-title">{thread.title}</span>
      <span className="h-inbox-row-sub">Open an Architect conversation about this idea.</span>
      <span className="h-inbox-row-foot">
        <span>{fmtAgo(thread.createdAt)} ago</span>
        <span>resume →</span>
      </span>
      <button
        type="button"
        className={`h-inbox-row-pin ${thread.pinned ? 'on' : ''}`}
        aria-label={`${thread.pinned ? 'Unpin' : 'Pin'} thread ${thread.title}`}
        onClick={(e) => {
          e.stopPropagation();
          onPin();
        }}
      >
        ★
      </button>
      <button
        type="button"
        className="h-inbox-row-delete"
        aria-label={`Delete thread ${thread.title}`}
        onClick={(e) => {
          e.stopPropagation();
          if (confirm('Delete this thread?')) onDelete();
        }}
      >
        ×
      </button>
    </div>
  );
}

function ChatPane({
  slug, target, onClose, onReviewResolved, onRenameThread, onDeleteThread, onFeatureFocus,
}: {
  slug: string;
  target:
    | { kind: 'review'; review: PendingReview }
    | { kind: 'thread'; thread: Thread }
    | { kind: 'new' };
  onClose: () => void;
  onReviewResolved: () => void;
  onRenameThread: (id: string, title: string) => void;
  onDeleteThread: (id: string) => void;
  onFeatureFocus?: (featureId: string) => void;
}) {
  const reviewId = target.kind === 'review' ? target.review.id : undefined;
  const threadId = target.kind === 'thread' ? target.thread.id : undefined;

  const title = useMemo(() => {
    if (target.kind === 'review') return `${target.review.featureId || KIND_META[target.review.kind]?.label || 'review'} · ${target.review.kind}`;
    if (target.kind === 'thread') return target.thread.title;
    return 'New thread';
  }, [target]);

  const initialContext = useMemo(() => {
    if (target.kind === 'review') {
      const r = target.review;
      return {
        header: r.question,
        sub: r.context || '',
        recommendation: r.recommendedAnswer,
        tradeoff: r.tradeoff,
        featureId: r.featureId || KIND_META[r.kind]?.label || 'review',
        kind: r.kind,
      };
    }
    return null;
  }, [target]);

  return (
    <div className="h-inbox-chat">
      <div className="h-inbox-chat-head">
        <button type="button" onClick={onClose} className="h-inbox-action ghost">← back</button>
        <div className="h-inbox-chat-title">
          <span>{target.kind === 'review' ? 'Decision thread' : 'Idea thread'}</span>
          <strong>{title}</strong>
        </div>
        {target.kind === 'review' && onFeatureFocus && (
          <button
            type="button"
            onClick={() => target.review.featureId && onFeatureFocus(target.review.featureId)}
            className="h-inbox-action ghost"
            title="Show this feature in the queue"
          >
            feature
          </button>
        )}
        {target.kind === 'thread' && (
          <button
            type="button"
            onClick={() => { if (confirm('Delete this thread?')) onDeleteThread(target.thread.id); }}
            className="h-inbox-action danger"
            title="Delete thread"
          >
            delete
          </button>
        )}
      </div>

      {initialContext && (
        <div className="h-inbox-context-card">
          <div className="h-inbox-context-top">
            <span className="h-inbox-feature">{initialContext.featureId}</span>
            <span className={`h-inbox-kind tone-${KIND_META[initialContext.kind]?.tone ?? 'default'}`}>
              {KIND_META[initialContext.kind]?.label ?? initialContext.kind}
            </span>
          </div>
          <b>{initialContext.header}</b>
          {initialContext.sub && <p>{initialContext.sub}</p>}
          {initialContext.recommendation && <p><strong>Architect's lean:</strong> {initialContext.recommendation}</p>}
          {initialContext.tradeoff && <p><strong>Tradeoff:</strong> {initialContext.tradeoff}</p>}
        </div>
      )}

      <div className="h-inbox-chat-body">
        <ArchitectChat
          slug={slug}
          reviewId={reviewId}
          threadId={threadId}
          onThreadTitleInferred={(t) => {
            if (target.kind === 'thread' && target.thread.title === 'New idea') {
              onRenameThread(target.thread.id, t);
            }
          }}
          onReviewAccepted={async (userResponse) => {
            if (target.kind !== 'review') return;
            await fetch(`/api/harness/${slug}/reviews/${target.review.id}/resolve`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ response: userResponse }),
            });
            onReviewResolved();
          }}
        />
      </div>
    </div>
  );
}