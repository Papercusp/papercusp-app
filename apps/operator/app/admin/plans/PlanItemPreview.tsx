'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * PlanItemPreview — the detail pane for the cross-plan item views. Renders
 * the SELECTED item as the shared chat card (its actions) above a read-only
 * preview of the parent plan (Vditor, scrolled to the item).
 *
 * inbox-cards-unification P-021: the needs-human toolkit is now card options
 * driven by `attentionItemToCardSpec` —
 *   - Resolve / Drop  → terminal picks → `resolveAttentionAction`
 *   - Answer          → navigate → reveals an inline `InputCard`; submit runs
 *                       `answerAttentionItem` (decision + done + resume)
 *   - 💬 Chat          → navigate → expands an inline `PlanChat` (D-006)
 * Non-needs-human items just get the Chat affordance. The bespoke
 * `InboxItemActions` toolkit + `PlanChatModal` are retired.
 *
 * Deliberately NOT the full PlanDetail: no editor / revisions / agents tabs.
 */

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import PlanEditor from './PlanEditor';
import PlanChat from './PlanChat';
import { usePlan } from './plans-api';
import type { AttentionItem, PlanItem } from './plans-api';
import { AskChoiceCard, type AskChoiceResponse, type AskChoiceAnswered } from '@/app/_components/chat/AskChoiceCard';
import { InputCard, type InputCardResponse } from '@/app/_components/chat/InputCard';
import { QueueCardActions } from './QueueCardActions';
import { attentionItemToCardSpec, resolveAttentionAction, answerAttentionItem } from './attention-card';
import { scrollPlanTarget, stripFrontmatter } from './plan-renderers';

interface Props {
  /** Selected item's parent plan slug, or null when nothing is selected. */
  planSlug: string | null;
  /** Selected item id (P-NNN / D-NNN), or null when nothing is selected. */
  itemId: string | null;
  /** Harness for the selected plan — lets the needs-human actions resume the loop. */
  harnessSlug?: string | null;
  /** Called after a needs-human action (Answer/Resolve/Drop) so the list refetches. */
  onResolved?: () => void;
  /** Hand off to the full PlanDetail view — PlansClient's navPlanTarget. */
  onViewFullPlan: (slug: string, itemId?: string) => void;
}

export default function PlanItemPreview({
  planSlug,
  itemId,
  harnessSlug,
  onResolved,
  onViewFullPlan,
}: Props) {
  // Read-only preview → LIVE sync query (data-sync-push-completion P-011): a
  // plans:* write pushes a fresh plan row over SSE, so the preview stays current
  // without a manual refresh. (PlanDetail's editor stays guarded/one-shot — a
  // live re-fire there would clobber the user's in-progress draft.)
  const { data, loading, error } = usePlan(planSlug, { live: true });
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [answerOpen, setAnswerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState<AskChoiceAnswered | undefined>(undefined);

  const raw = data?.raw ?? data?.prose ?? '';

  // Reset transient UI when the selection changes.
  useEffect(() => {
    setChatOpen(false);
    setAnswerOpen(false);
    setAnswered(undefined);
  }, [planSlug, itemId]);

  // Scroll to the selected item once the read-only body has rendered.
  // Vditor.preview renders async (and re-renders on value change), so we
  // retry on a short cadence until the anchor exists — same approach as
  // PlanDetail's `?jump=` effect.
  useEffect(() => {
    if (!itemId || !raw) return;
    let cancelled = false;
    const delays = [60, 160, 320, 600, 1000];
    const timers = delays.map((delay) =>
      window.setTimeout(() => {
        if (cancelled) return;
        if (scrollPlanTarget(scopeRef.current, itemId)) cancelled = true;
      }, delay),
    );
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [itemId, raw, planSlug]);

  if (!planSlug || !itemId) {
    return (
      <aside className="pc-items__detail">
        <div className="pc-items__detail-empty">Select an item to preview its plan here.</div>
      </aside>
    );
  }

  const strippedRaw = data?.legacy ? raw : stripFrontmatter(raw);
  const selected = data?.items?.find((i) => i.id === itemId);
  const isNeedsHuman = selected?.storedStatus === 'needs-human';

  // Build an AttentionItem-shaped view of the selected item so it flows
  // through the same mapper + dispatch as the Other surfaces.
  const attentionLike = buildPlanItemAttention({ planSlug, itemId, harnessSlug, selected });
  const spec = attentionItemToCardSpec(attentionLike);

  const onCardResponse = async (resp: AskChoiceResponse) => {
    if (resp.action === 'navigate') {
      if (resp.option_id === 'chat') setChatOpen((v) => !v);
      else if (resp.option_id === 'answer') setAnswerOpen((v) => !v);
      return;
    }
    if (resp.action === 'submit') {
      const pick = resp.picks[0];
      if (!pick || busy) return;
      setBusy(true);
      try {
        const r = await resolveAttentionAction(attentionLike, pick.option_id);
        if (r.resolved) {
          setAnswered({ picks: resp.picks, at: Date.now() });
          toast.success(`${itemId} ${pick.option_id === 'drop' ? 'dropped' : 'resolved'}.`);
          onResolved?.();
        }
      } catch (e) {
        toast.error('Action failed', { description: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(false);
      }
    }
  };

  const onAnswerResponse = async (r: InputCardResponse) => {
    if (r.action !== 'submit') {
      setAnswerOpen(false);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const res = await answerAttentionItem(attentionLike, String(r.value));
      if (res.resolved) {
        setAnswered({ picks: [{ option_id: 'answer', label: 'Answer' }], at: Date.now() });
        toast.success(`Answered ${itemId}`, { description: 'Recorded as a plan decision; loop resumed.' });
        onResolved?.();
      }
    } catch (e) {
      toast.error('Answer failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="pc-items__detail">
      <div className="pc-items__detail-toolbar">
        <span className="pc-items__id">{itemId}</span>
        {/* #4: the item's actions live here in the toolbar, not in the card. */}
        <QueueCardActions
          options={spec.options}
          answered={answered}
          busy={busy}
          onResponse={(r) => void onCardResponse(r)}
        />
        <Tooltip label="Open the full plan, jumped to this item"><button
          type="button"
          className="pc-items__view-full"
          onClick={() => onViewFullPlan(planSlug, itemId)}

        >
          View full plan ↗
        </button></Tooltip>
      </div>
      <div className="pc-items__detail-body" ref={scopeRef}>
        <AskChoiceCard
          args={spec}
          answered={answered}
          allowDecline={false}
          hideOptions
          onResponse={(r) => void onCardResponse(r)}
        />
        {answerOpen ? (
          <InputCard
            prompt="Your decision / answer — recorded as a plan decision (D-NNN) the agent reads next."
            presentation={{ kind: 'text', placeholder: 'Type your answer…', multiline: true }}
            onResponse={(r) => void onAnswerResponse(r)}
          />
        ) : null}
        {chatOpen ? <PlanChat harnessSlug={harnessSlug} label={`${planSlug} · ${itemId}`} /> : null}
        {loading && !data ? (
          <p className="pc-plans__placeholder">Loading plan…</p>
        ) : error ? (
          <p className="pc-plans__placeholder pc-plans__placeholder--error">Failed to load plan: {error}</p>
        ) : strippedRaw ? (
          <PlanEditor value={strippedRaw} readOnly outline={false} items={data?.items} slug={planSlug} />
        ) : (
          <p className="pc-plans__placeholder">This plan has no content.</p>
        )}
      </div>
    </aside>
  );
}

/**
 * Pure: build the AttentionItem-shaped view of a selected plan item so it flows
 * through the same card mapper + dispatch as the inbox surfaces. The action set
 * must match planItemToAttention (adapters.ts) — needs-human items get the full
 * Answer/Resolve/Drop/Chat toolkit, everything else just Chat. Exported for
 * tests.
 */
export function buildPlanItemAttention({
  planSlug,
  itemId,
  harnessSlug,
  selected,
}: {
  planSlug: string;
  itemId: string;
  harnessSlug?: string | null;
  selected: PlanItem | undefined;
}): AttentionItem {
  const isNeedsHuman = selected?.storedStatus === 'needs-human';
  const attentionLike: AttentionItem = {
    id: `plan-item:${planSlug}:${itemId}`,
    kind: 'plan-item',
    source: 'plan',
    // `undefined`, not `null` — the wire type's optional fields are `?: T` so a
    // synthesized item matches what the LIST feed actually ships (WI-7039/D-025).
    harnessSlug: harnessSlug ?? undefined,
    planSlug,
    itemRef: itemId,
    title: selected?.text ?? itemId,
    body: selected?.text ?? '',
    status: selected?.storedStatus ?? '',
    importance: 'normal',
    // Pre-existing TS2739 (missing `tier` + `triageState`), fixed in passing: it
    // was MASKED because tsc reports one error per object literal and the
    // `harnessSlug` mismatch above took the slot. `tier` upholds the documented
    // AttentionItem invariant `needsHuman === (tier === 'decision')`, and an
    // item synthesized on the fly has by definition never been triaged.
    tier: isNeedsHuman ? 'decision' : 'activity',
    triageState: 'untriaged',
    needsHuman: isNeedsHuman,
    actions: isNeedsHuman
      ? [
          { id: 'answer', label: 'Answer' },
          { id: 'mark-done', label: 'Resolve', primary: true },
          { id: 'drop', label: 'Drop' },
          { id: 'chat', label: 'Chat' },
        ]
      : [{ id: 'chat', label: 'Chat' }],
    ref: { kind: 'plan-item', slug: planSlug, itemId },
  };
  return attentionLike;
}
