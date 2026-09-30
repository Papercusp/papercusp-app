/**
 * InboxBulkRecommendation — one item's pre-picked resolution, rendered inside
 * the item's own row (inbox-bulk-resolve-2026-08-23, P-006 / D-003).
 *
 * WHY IT LIVES IN THE ROW rather than in a separate review screen: the owner is
 * judging a RECOMMENDATION AGAINST AN ITEM, and a review list that shows the
 * recommendation without the item it belongs to asks them to hold both in their
 * head. Keeping it in the row means the title, kind, owner and date they already
 * scanned are still on screen while they decide.
 *
 * THE OPTIONS ARE THE ITEM'S REAL OPTIONS. They come from
 * `attentionItemToCardSpec` — the same projection the hand-resolve card renders
 * — never from the resolver's report. So a recommendation naming an id the item
 * does not offer renders as an explicit "no longer offered" warning instead of a
 * button that would fail on click, and the pills the owner sees are exactly the
 * ones a hand resolve would show. That check is also live rather than
 * point-in-time: the feed is SSE-updated, so an item whose options changed since
 * the resolver looked is caught at render.
 *
 * ACCEPT dispatches through the shared client helpers (see use-inbox-bulk-run) —
 * this component never resolves anything itself.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, Check, MessageCircle, Pencil, Sparkles } from 'lucide-react';
import type { AttentionItem } from '@/app/admin/plans/plans-api';
import { attentionItemToCardSpec, isNavigateAction } from '@/app/admin/plans/attention-card';
import type { BulkRunItem } from './use-inbox-bulk-run';
// Imported here as well as in InboxBulkStrip: the bundler dedupes, and this
// component must never depend on the strip having been mounted first for its
// own styles to exist.
import './inbox-bulk.css';

export interface InboxBulkRecommendationProps {
  item: AttentionItem;
  rec: BulkRunItem;
  /** Accept it — resolve + record. Resolves to an error string on failure. */
  onAccept: (draftOverride: string | null) => Promise<{ ok: boolean; error?: string }>;
  /** Open the item's discussion thread with the originating agent. */
  onDiscuss?: () => void;
  busy?: boolean;
}

/**
 * Is the recommended action still one this item actually offers, and does it
 * actually resolve anything? Exported for the test that pins this to
 * `attentionItemToCardSpec` rather than to a hand-written fixture.
 */
export function recommendationValidity(
  item: AttentionItem,
  actionId: string | null,
  draftAnswer?: string | null,
): { valid: boolean; reason?: string } {
  if (!actionId) return { valid: false, reason: 'no action recommended' };
  const hasDraftedAnswer = actionId === 'answer' && Boolean(draftAnswer?.trim());
  if (isNavigateAction(actionId) && !hasDraftedAnswer) {
    return { valid: false, reason: `"${actionId}" only opens a view — it resolves nothing` };
  }
  const options = attentionItemToCardSpec(item).options ?? [];
  // No options at all is the pre-detail-fetch state, not a stale recommendation:
  // the LIST feed drops `actions`, so they arrive only once the per-item detail
  // lands. Calling that "no longer offered" would flash a false warning on every
  // first paint, so it is reported as not-yet-known instead.
  if (options.length === 0) return { valid: false, reason: 'loading this item’s options…' };
  if (!options.some((o) => o.id === actionId)) {
    return { valid: false, reason: 'that option is no longer offered on this item' };
  }
  return { valid: true };
}

export default function InboxBulkRecommendation({
  item,
  rec,
  onAccept,
  onDiscuss,
  busy,
}: InboxBulkRecommendationProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(rec.draftAnswer ?? '');
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  const spec = useMemo(() => attentionItemToCardSpec(item), [item]);
  const validity = useMemo(
    () => recommendationValidity(item, rec.actionId, draft),
    [item, rec.actionId, draft],
  );
  const options = spec.options ?? [];
  const hasDraft = Boolean(draft.trim()) || editing;

  const accept = async () => {
    if (accepting || busy) return;
    setAccepting(true);
    setError(null);
    try {
      const res = await onAccept(hasDraft ? draft.trim() || null : null);
      if (!res.ok) setError(res.error ?? 'could not resolve this item');
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div className="op-inbox__rec" data-testid={`inbox-bulk-rec-${rec.itemId}`}>
      <div className="op-inbox__rec-head">
        <Sparkles size={12} aria-hidden="true" />
        <span>Papercup recommends</span>
        {/* Confidence is the owner's cue for how much to re-check. `low` is what
            a lapsed consult produces — an inference, not evidence (D-002) — so
            it is labelled rather than rendered identically to a confirmed one. */}
        {rec.confidence === 'low' ? (
          <span className="op-inbox__rec-flag op-inbox__rec-flag--low">low confidence</span>
        ) : null}
        {rec.consulted ? (
          <span className="op-inbox__rec-flag op-inbox__rec-flag--consulted">
            {rec.consultReply ? 'asker replied' : 'asker did not reply'}
          </span>
        ) : null}
      </div>

      <div className="op-inbox__rec-options">
        {options.map((o) => {
          const selected = o.id === rec.actionId;
          return (
            <span
              key={o.id}
              className={`op-inbox__rec-pill${selected ? ' is-selected' : ''}${
                o.style === 'danger' ? ' is-danger' : ''
              }`}
              data-testid={`inbox-bulk-pill-${rec.itemId}-${o.id}`}
            >
              {selected ? <Check size={12} aria-hidden="true" /> : null}
              {o.label}
            </span>
          );
        })}
      </div>

      {rec.rationale ? <p className="op-inbox__rec-why">{rec.rationale}</p> : null}

      {hasDraft ? (
        <div className="op-inbox__rec-draft">
          <span className="op-inbox__rec-draft-label">Draft reply</span>
          {editing ? (
            <textarea
              className="op-inbox__rec-draft-input"
              data-testid={`inbox-bulk-draft-${rec.itemId}`}
              value={draft}
              rows={3}
              aria-label="Edit the drafted reply"
              disabled={busy || accepting}
              onChange={(e) => setDraft(e.target.value)}
            />
          ) : (
            <span className="op-inbox__rec-draft-text">{rec.draftAnswer}</span>
          )}
        </div>
      ) : null}

      {!validity.valid ? (
        <div className="op-inbox__rec-warn" role="alert">
          <AlertTriangle size={12} aria-hidden="true" />
          <span>{validity.reason}</span>
        </div>
      ) : null}

      {error ? (
        <div className="op-inbox__rec-warn" role="alert" data-testid={`inbox-bulk-rec-error-${rec.itemId}`}>
          <AlertTriangle size={12} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="op-inbox__rec-actions">
        <button
          type="button"
          className="op-inbox__rec-accept"
          data-testid={`inbox-bulk-accept-${rec.itemId}`}
          disabled={!validity.valid || accepting || busy}
          onClick={() => void accept()}
        >
          <Check size={13} aria-hidden="true" />
          {accepting ? 'Accepting…' : 'Accept'}
        </button>
        {rec.draftAnswer ? (
          <button
            type="button"
            className="op-inbox__rec-ghost"
            data-testid={`inbox-bulk-edit-${rec.itemId}`}
            disabled={busy || accepting}
            onClick={() => setEditing((v) => !v)}
          >
            <Pencil size={12} aria-hidden="true" />
            {editing ? 'Done' : 'Edit'}
          </button>
        ) : null}
        <span className="op-inbox__rec-spacer" />
        {onDiscuss ? (
          <button
            type="button"
            className="op-inbox__rec-ghost"
            data-testid={`inbox-bulk-discuss-${rec.itemId}`}
            disabled={busy || accepting}
            onClick={onDiscuss}
          >
            <MessageCircle size={11} aria-hidden="true" />
            Discuss
          </button>
        ) : null}
      </div>
    </div>
  );
}
