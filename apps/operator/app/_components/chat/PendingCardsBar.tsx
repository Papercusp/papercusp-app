'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * PendingCardsBar — renders cards from the state-channel SSE stream.
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md
 *
 * Renders one card at a time (L3 from the review: queue indicator
 * surfaces the count, no multi-card cliff). On user response, POSTs
 * to /card-response — the deferred resolves server-side; the next
 * snapshot drops the resolved card from openCards and the bar shows
 * the next one (or hides entirely).
 *
 * Dispatch by presentation kind:
 *   - radio / checkbox → AskChoiceCard
 *   - text / date / slider → InputCard
 *   - unknown / missing → fallbackText
 *
 * Submit payload is shape-specific. The card author's dataSchema
 * tells the framework what the value-key looks like; the runtime
 * here keeps the convention:
 *   - choice → { picks: [option_id, ...] }
 *   - input  → { value: ... }
 *
 * Optimistic-dismiss (audit): on successful POST, the correlationId
 * is added to a local dismissed set so the card hides immediately
 * even if the state-snapshot SSE update doesn't arrive (disconnected
 * mid-flow). The server's PENDING map is already cleared at this
 * point — the dismiss is purely a UI bridge.
 */

import { useState, type ReactNode } from 'react';

import {
  AskChoiceCard,
  type AskChoiceArgs,
  type AskChoiceResponse,
} from './AskChoiceCard';
import { InputCard, type InputCardResponse } from './InputCard';
import { useStateSnapshots, type OpenCardWithRun } from '@/lib/use-state-snapshots';
import { postCardResponse, postRunCancel } from '@papercusp/operator-core/lib/post-card-response';
import { selectFocusedCard } from '@/lib/chat-cards/select-focused-card';

interface Props {
  /** Active conversation id — passed into /card-response URL for audit. */
  conversationId: string;
  /** Active workspace id — POST body needs it for defense-in-depth. */
  workspaceId: string;
}

function toAskChoiceArgs(card: OpenCardWithRun): AskChoiceArgs | null {
  const p = card.presentation;
  if (!p) return null;
  // WI-6552: 'select' is single-choice with the SAME answer shape as 'radio',
  // so it is answerable here rather than dropped. This bar has no compact
  // renderer of its own (it is a bar, not a pane), so it degrades to the
  // rows-style choice card — losing the compactness but never the ability to
  // answer, which is the failure mode that matters on the server-card path.
  if (p.kind !== 'radio' && p.kind !== 'checkbox' && p.kind !== 'select') return null;
  return {
    question: card.prompt,
    options: p.options.map((o) => ({
      id: o.id,
      label: o.label,
      hint: o.hint,
      style: o.style,
    })),
    multi: p.kind === 'checkbox',
    report: card.report,
  };
}

export function PendingCardsBar({ conversationId, workspaceId }: Props): ReactNode {
  const { cards, connected } = useStateSnapshots();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  // WI-5175: correlationIds the server no longer holds (404 'card not found').
  // The card stays RENDERED but goes visibly expired — silently dismissing it
  // would reproduce the original defect from the other side (the click appears
  // to do nothing, the card just vanishes with no explanation). The pending-card
  // map is in-memory server-side, so an operator restart strands every open
  // card this way; the user must be told, not left clicking a dead button.
  const [expired, setExpired] = useState<Set<string>>(() => new Set());

  // Same focused-card rule as the voice router (plan §C.7 / M4) so the
  // two surfaces never disagree on which card is "front of queue".
  // Local-dismiss filter is applied before selection: a card the user
  // dismissed here is hidden from both surfaces' focus.
  const visibleCards = cards.filter((c) => !dismissed.has(c.correlationId));
  const head = selectFocusedCard(visibleCards);
  if (head === null) return null;
  const remaining = visibleCards.length - 1;

  const post = async (
    body:
      | { action: 'submit'; payload: unknown }
      | { action: 'decline'; reason?: string }
      | { action: 'cancel' },
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    const correlationId = head.correlationId;
    try {
      const r = await postCardResponse(conversationId, {
        correlationId,
        workspaceId,
        ...body,
      });
      if (!r.ok) {
        if (r.status === 404) {
          // The server dropped this card (restart / run ended / already
          // resolved elsewhere). Mark it expired so the options go inert and
          // the card says why, instead of staying live and unanswerable.
          setExpired((prev) => new Set(prev).add(correlationId));
          setError('This question expired — it is no longer open.');
        } else {
          setError(r.error ?? `card-response failed (${r.status})`);
        }
      } else {
        setDismissed((prev) => {
          const next = new Set(prev);
          next.add(correlationId);
          return next;
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onChoiceResponse = (response: AskChoiceResponse): void => {
    if (response.action === 'submit') {
      void post({
        action: 'submit',
        payload: { picks: response.picks.map((p) => p.option_id) },
      });
    } else if (response.action === 'decline') {
      void post({ action: 'decline', reason: response.reason });
    } else {
      void post({ action: 'cancel' });
    }
  };

  const onInputResponse = (response: InputCardResponse): void => {
    if (response.action === 'submit') {
      void post({ action: 'submit', payload: { value: response.value } });
    } else {
      void post({ action: 'decline', reason: response.reason });
    }
  };

  /**
   * Chat-level "Cancel" — cancels every pending card under the head's
   * runId. Server cascade resolves each deferred with action:'cancel'.
   * Optimistically dismisses ALL cards from this run in the local
   * dismissed set so the bar hides immediately even if SSE is down.
   */
  const onCancelRun = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const runId = head.runId;
    const correlationIdsForRun = visibleCards
      .filter((c) => c.runId === runId)
      .map((c) => c.correlationId);
    try {
      const r = await postRunCancel(conversationId, { runId, workspaceId });
      if (!r.ok) {
        setError(r.error ?? `run-cancel failed (${r.status})`);
      } else {
        setDismissed((prev) => {
          const next = new Set(prev);
          for (const cid of correlationIdsForRun) next.add(cid);
          return next;
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const choiceArgs = toAskChoiceArgs(head);
  const inputKinds = head.presentation?.kind;
  const isInput =
    inputKinds === 'text' || inputKinds === 'date' || inputKinds === 'slider';
  const headExpired = expired.has(head.correlationId);

  let body: ReactNode;
  if (choiceArgs) {
    body = (
      <AskChoiceCard
        args={choiceArgs}
        onResponse={onChoiceResponse}
        allowDecline={head.allowDecline ?? true}
        expired={headExpired}
      />
    );
  } else if (isInput && head.presentation) {
    body = (
      <InputCard
        prompt={head.prompt}
        presentation={head.presentation as Parameters<typeof InputCard>[0]['presentation']}
        fallbackText={head.fallbackText}
        allowDecline={head.allowDecline ?? true}
        onResponse={onInputResponse}
      />
    );
  } else {
    body = (
      <div className="pending-cards-bar pending-cards-bar--fallback" role="status">
        <p>{head.prompt}</p>
        <p className="pending-cards-bar-hint">
          {head.fallbackText ?? 'No renderer for this card type yet.'}
        </p>
      </div>
    );
  }

  return (
    <div className="pending-cards-bar" data-busy={busy ? 'true' : 'false'}>
      {body}
      <div className="pending-cards-bar-meta">
        {remaining > 0 && (
          <p className="pending-cards-bar-queue" aria-live="polite">
            {remaining} more {remaining === 1 ? 'card' : 'cards'} after this
          </p>
        )}
        <Tooltip label="Cancel — abort all pending prompts under this run"><button
          type="button"
          className="pending-cards-bar-cancel-run"
          onClick={() => void onCancelRun()}
          disabled={busy || headExpired}
          aria-label="Cancel this run"

        >
          Cancel
        </button></Tooltip>
      </div>
      {!connected && (
        <p className="pending-cards-bar-disconnected" role="status">
          Live updates disconnected — submitted answers still apply.
        </p>
      )}
      {error && (
        <p className="pending-cards-bar-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
