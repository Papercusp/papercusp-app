'use client';

/**
 * Per-revision conversation drill-down — plan-agent-launch P-019.
 *
 * The "open conversation" affordance — shown only on revisions whose
 * write recorded a session (`session_id !== null`). For revisions
 * with no session (direct edits, git backfill), `RevisionsPanel`
 * renders a tag instead and never opens this modal.
 *
 * Reads `plans:revision-transcript`: paginated by `cursor` (next-page
 * appends to the in-modal list), narrowable by `query` (substring
 * filter, server-side). Bounded by D-002 — the verb itself never
 * returns the whole transcript; the modal can only ever show one
 * page-worth at a time.
 */

import { useCallback, useEffect, useState } from 'react';
import { Modal } from '@/app/harness/Modal';
import {
  fetchPlanRevisionTranscript,
  type PlanRevisionTranscriptResult,
  type PlanRevisionTranscriptTurn,
} from './plans-api';

interface Props {
  /** The revision id to drill into; null hides the modal. */
  revisionId: number | null;
  onClose: () => void;
}

const PAGE_SIZE = 20;

export default function RevisionConversationModal({ revisionId, onClose }: Props) {
  const [meta, setMeta] = useState<PlanRevisionTranscriptResult | null>(null);
  const [turns, setTurns] = useState<PlanRevisionTranscriptTurn[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [query, setQuery] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when the revision changes (or modal closes).
  useEffect(() => {
    setMeta(null);
    setTurns([]);
    setNextCursor(null);
    setQuery('');
    setError(null);
  }, [revisionId]);

  // Initial page — re-run whenever the revision or query changes.
  useEffect(() => {
    if (revisionId === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPlanRevisionTranscript({
      revisionId,
      query: query.trim() || undefined,
      limit: PAGE_SIZE,
    })
      .then((r) => {
        if (cancelled) return;
        setMeta(r);
        if (r.available) {
          setTurns(r.turns);
          setNextCursor(r.nextCursor);
        } else {
          setTurns([]);
          setNextCursor(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [revisionId, query]);

  const loadMore = useCallback(async () => {
    if (revisionId === null || nextCursor === null) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetchPlanRevisionTranscript({
        revisionId,
        query: query.trim() || undefined,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      if (!r.available) return; // shouldn't happen mid-pagination
      setTurns((prev) => [...prev, ...r.turns]);
      setNextCursor(r.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [revisionId, nextCursor, query]);

  const title =
    meta && 'seq' in meta
      ? `Conversation behind revision #${meta.seq}`
      : 'Conversation';

  return (
    <Modal
      open={revisionId !== null}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={title}
      srOnlyTitle
      contentClassName="pc-rev-convo"
    >
      <header className="pc-rev-convo__head">
        <h3>{title}</h3>
        <button
          type="button"
          className="pc-rev-convo__close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </header>
      <div className="pc-rev-convo__controls">
        <input
          type="search"
          className="pc-rev-convo__query"
          placeholder="Filter (substring)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter turns by substring"
        />
      </div>
      {error ? <div className="pc-rev-convo__error">{error}</div> : null}
      {meta && !meta.available ? (
        <div className="pc-rev-convo__empty">
          {unavailableReason(meta.reason)}
        </div>
      ) : null}
      {meta && meta.available && turns.length === 0 && !loading ? (
        <div className="pc-rev-convo__empty">
          {query.trim() ? 'No turns match this filter.' : 'No turns in this conversation.'}
        </div>
      ) : null}
      {turns.length > 0 ? (
        <ol className="pc-rev-convo__turns">
          {turns.map((t) => (
            <TurnRow key={t.seq} turn={t} />
          ))}
        </ol>
      ) : null}
      {loading ? <div className="pc-rev-convo__loading">Loading…</div> : null}
      {nextCursor !== null && !loading ? (
        <button
          type="button"
          className="pc-rev-convo__more"
          onClick={loadMore}
        >
          Load more
        </button>
      ) : null}
    </Modal>
  );
}

function TurnRow({ turn }: { turn: PlanRevisionTranscriptTurn }) {
  return (
    <li className="pc-rev-convo-turn" data-role={turn.role}>
      <header className="pc-rev-convo-turn__head">
        <span className="pc-rev-convo-turn__role">{turn.role}</span>
        <span className="pc-rev-convo-turn__seq" title={`Turn #${turn.seq}`}>
          #{turn.seq}
        </span>
        <span className="pc-rev-convo-turn__when">
          {new Date(turn.createdAt).toLocaleString()}
        </span>
      </header>
      <pre className="pc-rev-convo-turn__content">{turn.content}</pre>
    </li>
  );
}

/** Pure: explain why a revision has no drill-downable conversation.
 *  Exported for unit coverage and reuse by the row-tag renderer. */
export function unavailableReason(
  reason: 'no_session' | 'git_backfill' | 'session_kind_unsupported',
): string {
  switch (reason) {
    case 'no_session':
      return 'This revision was a direct edit — no conversation to show.';
    case 'git_backfill':
      return 'This revision was reconstructed from git history — no conversation was recorded.';
    case 'session_kind_unsupported':
      return 'This session kind is not yet readable from the admin UI.';
  }
}

/** Pure: short tag label for a revision row, given its sessionKind +
 *  whether a sessionId is recorded. Returns null when the revision IS
 *  drill-downable (the "Open conversation" button shows instead).
 *  Exported for the RevisionsPanel renderer and its tests. */
export function rowSessionTag(
  sessionId: string | null,
  sessionKind: string | null,
): string | null {
  if (sessionId && sessionKind === 'plan_run') return null;
  if (sessionKind === 'git_backfill') return 'from git history';
  if (sessionKind === 'plan_run') return 'plan-run session missing';
  // operator_chat / agent_chat reserved (D-020) — not readable in v1
  if (sessionKind === 'operator_chat' || sessionKind === 'agent_chat') {
    return `${sessionKind.replace('_', ' ')} (not shown)`;
  }
  return 'direct edit';
}
