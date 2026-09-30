/**
 * attention-card — bridges an inbox `AttentionItem` onto the shared chat
 * card renderer (inbox-cards-unification P-010/P-011/P-012).
 *
 * Two pure-ish pieces:
 *   - `attentionItemToCardSpec(item)` maps an item → `AskChoiceArgs` (the
 *     question + styled options). `actions[]` is the single source of truth
 *     (P-009 made it complete); escalations expand their generic `resolve`
 *     action into the named `ref.options` so each becomes a pickable option.
 *   - `resolveAttentionAction(item, optionId)` dispatches a TERMINAL pick to
 *     the item's existing backend helper (D-007: no new route), preserving
 *     the resume-on-resolve / no-resume-on-drop distinction. Navigate ids
 *     (`chat`/`answer`/`view-log`/`open`) are NOT handled here — the
 *     component owns them (inline chat / inline InputCard / harness view).
 *   - `answerAttentionItem(item, text)` is the Answer InputCard submit: for a
 *     plan-item, record a decision + mark done + resume (mirrors the retired
 *     `InboxItemActions.handleAnswer`); for a conversation (D-027 follow-on (1)),
 *     resolve the question with the owner's text as the accepted answer.
 *   - `resolveAttentionAction` also dispatches the standing-approval terminal
 *     grant/dismiss and the improvement Dismiss (reject) (D-027 follow-on (1)).
 *   - `replyToAttentionItem(item, text)` (owner-inbox-single-pane-2026-07-17
 *     P-006) wraps `answerAttentionItem` with REPLY ROUTING (D-007): when the
 *     item's asker (`ownerAgentId`) is LIVE (coord:presence), the reply is
 *     ALSO delivered straight to their coord inbox and they are woken —
 *     stamped with owner-authoritative turn-provenance (D-006) — instead of
 *     relying solely on the resolve path's own (best-effort, awaiting-only)
 *     notification. A dead/unknown asker is untouched here; the existing
 *     Discuss (Papercup) button remains the fallback (D-007).
 *
 * These deliberately reproduce today's `OtherDetail` / `InboxItemActions`
 * behavior — see attention-card.test.ts for the parity assertions (P-013).
 */

import type {
  AttentionItem,
  AttentionAction,
} from './plans-api';
import {
  resolveEscalation,
  ackCoordMessage,
  setItemStatus,
  addPlanDecision,
  triageAttentionItem,
  decideStandingApproval,
  resolveConversationAnswer,
  dismissImprovement,
  deliverInboxReply,
  clearWorkItemOwnerGate,
  retractStandingFact,
  closeWorkItem,
  clearSessionGate,
} from './plans-api';
import type { AskChoiceArgs, AskChoiceOption } from '@/app/_components/chat/AskChoiceCard';

/** Action ids that open a sub-surface rather than answering the item. The
 *  component handles these; `resolveAttentionAction` ignores them. An id
 *  missing from this set is dispatched as a TERMINAL submit, so every
 *  navigate-style action the adapters emit MUST be listed — omitting
 *  `discuss` made the Discuss button resolve real escalations (EI-13037).
 *
 *  Re-exported from the CANONICAL declaration in operator-core, which the
 *  agent-side bulk-resolve tool re-exports too. Do NOT redeclare the set here:
 *  it decides "is this action terminal" for BOTH the owner's click and the
 *  agent's action, and a second copy is exactly how those two drift. */
import {
  NAVIGATE_ACTION_IDS,
  isNavigateAction,
} from '@papercusp/operator-core/lib/attention/types';
import {
  dispatchAttentionTerminalAction,
  type TerminalActionResult,
  type TerminalAttentionItem,
} from '@papercusp/operator-core/lib/attention/terminal-action-dispatch';

export { NAVIGATE_ACTION_IDS, isNavigateAction };

function optionStyle(a: AttentionAction): AskChoiceOption['style'] {
  if (a.id === 'drop') return 'danger';
  if (a.primary) return 'primary';
  return 'default';
}

/* ── What each button ACTUALLY does ──────────────────────────────────────────
 * [owner 2026-08-09] "What do those buttons actually do its unclear."
 *
 * `AskChoiceOption.hint` has always existed and QueueCardActions has always
 * rendered it as the button's Tooltip (`opt.hint ?? opt.label`) — but nothing
 * ever SET it, so every tooltip in the Queue, the HUD and the chat popup just
 * repeated the word already printed on the button. A designed seam sitting
 * unused. These fill it.
 *
 * The text is derived from `resolveAttentionAction` below and from
 * `OtherDetail.onResponse`, and lives HERE — beside the dispatch it describes —
 * precisely so it cannot drift from the behavior. If you change what a branch
 * of `resolveAttentionAction` does, change its sentence in the same edit.
 *
 * Two distinctions these exist to make legible, both of which cost real
 * incidents when they were invisible:
 *   - a TERMINAL pick closes the record for everyone and (for escalations)
 *     wakes the agent that asked. It is not undoable from this UI.
 *   - a NAVIGATE pick (`discuss`, `answer`) changes NOTHING server-side; it
 *     only opens a sub-surface. `discuss` missing from NAVIGATE_ACTION_IDS is
 *     what once made the Discuss button silently resolve real owner gates
 *     (EI-13037) — a button whose label admits neither outcome is how that
 *     stayed unnoticed.
 */
function hintFor(item: AttentionItem, optionId: string, namedEscalationOption: boolean): string | undefined {
  const kind = (item.ref as { kind: string }).kind;

  if (namedEscalationOption) {
    // Expanded from the generic `resolve`: the pick's LABEL is delivered to the
    // asking agent as the reply text, then the escalation is closed.
    return 'Answers the agent with this choice, wakes it, and closes this decision. Not undoable here.';
  }

  switch (optionId) {
    case 'discuss':
      return 'Opens a message thread with the agent below. Does not answer or close this.';
    case 'answer':
      if (kind === 'work-item-needs-human' || kind === 'owner-wall') {
        return 'Sends your answer to the live agent, wakes it, then clears this owner block after delivery.';
      }
      return 'Opens a text box below. Your reply is recorded as the accepted answer and closes this.';
    case 'chat':
    case 'message-owner':
      return 'Opens a chat below. Nothing is answered or closed.';
    case 'view-log':
    case 'open':
      return 'Opens this item where it lives. Nothing is answered or closed.';
    case 'ack':
      return 'Acknowledges the message and clears it from your queue.';
    case 'drop':
      return 'Marks the item dropped (won’t-do). Deliberately does NOT resume the agent’s loop.';
    case 'dismiss':
      return kind === 'standing-approval'
        ? 'Declines the standing approval and drops the candidate.'
        : 'Rejects the idea and closes it.';
    case 'grant':
      return 'Grants this capability standing approval — the agent stops asking each time.';
    case 'resolve':
    case 'mark-done':
      if (kind === 'coord-escalation') {
        // No named options to pick, so the reply text is the bare word "Resolved".
        return 'Closes this decision and replies “Resolved” to the agent — no detail. Not undoable here.';
      }
      if (kind === 'plan-item') return 'Marks the item done and wakes the agent’s loop to carry on.';
      if (kind === 'operator-report') return 'Files this report as handled (recorded, with who did it).';
      return 'Closes this item.';
    default:
      return undefined;
  }
}

type EscalationOption = { id: string; label: string };
function escalationOptions(item: AttentionItem): EscalationOption[] {
  const ref = item.ref as { kind: string; options?: unknown };
  if (ref.kind !== 'coord-escalation' || !Array.isArray(ref.options)) return [];
  return (ref.options as EscalationOption[]).filter((o) => o && typeof o.id === 'string');
}

/** True for a `coord-escalation` item carrying named pickable options — the
 *  set SessionChatModal (owner-inbox-single-pane-2026-07-17 P-008) surfaces
 *  inline as an AskChoiceCard. Exported so callers don't re-derive the
 *  `ref.kind === 'coord-escalation' && ref.options` shape check. */
export function isEscalationWithOptions(item: AttentionItem): boolean {
  return escalationOptions(item).length > 0;
}

/**
 * Map an inbox item to a card spec. Render with `allowDecline={false}` —
 * durable records have no "Skip" (D-008).
 */
export function attentionItemToCardSpec(item: AttentionItem): AskChoiceArgs {
  const escOpts = escalationOptions(item);
  const options: AskChoiceOption[] = [];

  // `?? []` is NOT defensive noise. The current LIST feed retains `actions` so
  // the selected pane can paint them immediately (item-open P-003 / D-002), but
  // older snapshots and partial producers can still omit the optional field.
  // An unguarded for-of over undefined THROWS, which React turns
  // into a crashed HUD tab ("undefined is not an object (evaluating
  // 'item.actions')" — owner-visible 2026-07-28, whole tab replaced by an error
  // panel). The toolbar was already held back for exactly this reason; this call
  // path simply was not. An item with no actions yet correctly yields no options.
  //
  // The declared type USED to say `actions: AttentionAction[]` (non-optional) —
  // a TYPE LIE the list feed violated at runtime, and the reason tsc never
  // flagged this. `AttentionItem.actions` stays optional, so tsc forces this
  // guard at every consumer instead of leaving the next one to rediscover the
  // crash. `attention-list-feed-shape.test.ts` holds both the retention and
  // omission paths by driving the REAL projection rather than a hand-written
  // list-row fixture.
  for (const a of item.actions ?? []) {
    // Escalation with named options: expand the generic `resolve` action into
    // one terminal option per named choice (each carries the option id the
    // dispatch passes as `choice`).
    if ((a.id === 'resolve' || a.id === 'mark-done') && escOpts.length) {
      for (const o of escOpts) {
        options.push({ id: o.id, label: o.label, style: 'primary', hint: hintFor(item, o.id, true) });
      }
      continue;
    }
    options.push({
      id: a.id,
      label: a.label,
      style: optionStyle(a),
      hint: hintFor(item, a.id, false),
      // Navigate options stay live (open a sub-surface); terminal options
      // commit + disable. `undefined` ⇒ terminal (the renderer default).
      terminal: NAVIGATE_ACTION_IDS.has(a.id) ? false : undefined,
    });
  }

  // An operator-report item renders its ReportBlock natively (the card body
  // via ReportBlockCard) — the question stays the short title so the plain-
  // text body dump isn't duplicated above the structured block.
  if (item.report) {
    return { question: item.title, options, report: item.report };
  }

  return {
    question: item.body?.trim() || item.title,
    options,
  };
}

/** Fire-and-forget brain nudge — the human just unblocked something, so wake
 *  the Queen now (`pot:wake`, floor-debounced) instead of waiting for her
 *  next armed wake. Replaces the retired `/harness/:slug/launch` legacy
 *  run-loop kick (the orchestrator bin was archived 2026-06-06). No `harness`
 *  arg: the hive home slug is resolved server-side (PAPERCUSP_POT_HOME_SLUG)
 *  — the attention item's harness may be a managed harness, not the hive
 *  home. Unresolvable → harmless no-op; the always-armed-wake invariant
 *  (start-hive-wake-orchestration D-002) still guarantees pickup. */
function resumeLoop(_harnessSlug: string | null | undefined): void {
  void fetch('/api/agent-mcp/run-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'pot:wake',
      args: { source: 'user', reason: 'Attention item resolved — pick up the unblocked work' },
      confirmed: true,
    }),
  }).catch(() => {});
}

function refField(item: AttentionItem, key: string): string {
  return String((item.ref as Record<string, unknown>)[key] ?? '');
}

export type ResolveResult = TerminalActionResult;

/**
 * Dispatch a TERMINAL option pick to the right backend (D-007 helpers).
 * Throws on backend error (the caller toasts). Navigate ids return
 * `{resolved:false}` untouched — they are the component's job.
 */
export async function resolveAttentionAction(
  item: AttentionItem,
  optionId: string,
): Promise<ResolveResult> {
  return await dispatchAttentionTerminalAction({
    item: item as unknown as TerminalAttentionItem,
    actionId: optionId,
    deps: {
      async resolveEscalation({ msgId, choice }) {
        const result = await resolveEscalation({ msg_id: msgId, choice });
        if (result?.error) throw new Error(result.error);
      },
      async acknowledgeMessage({ msgId }) {
        const result = await ackCoordMessage({ msg_id: msgId });
        if (result?.error) throw new Error(result.error);
      },
      async setPlanItemStatus(args) {
        const result = await setItemStatus(args);
        if ('error' in result) throw new Error(result.error ?? 'set-status failed');
      },
      wakePlanLoop({ harnessSlug }) {
        resumeLoop(harnessSlug);
      },
      async dismissImprovement({ issueId }) {
        const result = await dismissImprovement(issueId);
        if (result?.error) throw new Error(result.error);
      },
      async decideStandingApproval(args) {
        const result = await decideStandingApproval(args);
        if (result?.error) throw new Error(result.error);
      },
      async triageAttentionItem(args) {
        const result = await triageAttentionItem(args);
        if (result?.error) throw new Error(result.error);
      },
      async deliverOwnerReply(args) {
        const result = await deliverInboxReply(args);
        if (result.error) throw new Error(result.error);
        return { live: result.live, woken: result.woken };
      },
      // P-003 — the owner-gate terminals. Each throws on a backend error so the
      // card toasts and stays unresolved, exactly like the older effects: a
      // terminal option that silently no-ops is worse than one that fails loudly.
      async clearWorkItemOwnerGate(args) {
        const result = await clearWorkItemOwnerGate(args);
        if (result?.error) throw new Error(result.error);
      },
      async retractStandingFact(args) {
        const result = await retractStandingFact(args);
        if (result?.error) throw new Error(result.error);
      },
      async closeWorkItem(args) {
        const result = await closeWorkItem(args);
        if (result?.error) throw new Error(result.error);
      },
      async resolveConversation({ conversationId, acceptedAnswer, capture }) {
        const result = await resolveConversationAnswer({
          conversation_id: conversationId,
          accepted_answer: acceptedAnswer,
          capture,
        });
        if (result?.error) throw new Error(result.error);
      },
      async closeSessionGate(args) {
        const result = await clearSessionGate(args);
        if (result?.error) throw new Error(result.error);
      },
    },
  });
}

/**
 * Submit the inline Answer InputCard's free text. Two kinds answer with text:
 *
 *  - `plan-item` (P-021): record a plan decision the agent reads next, mark the
 *    item done, resume the loop. Mirrors the retired `InboxItemActions.handleAnswer`.
 *  - `conversation` (D-027 follow-on (1)): resolve the open question with the
 *    owner's text as the accepted answer — captures it to the knowledge layer for
 *    the next asker and drops it from the Queue. No loop resume (a coord:ask
 *    conversation isn't a plan-blocking decision).
 *
 * Any other kind (or empty text) is a no-op.
 */
export async function answerAttentionItem(item: AttentionItem, answerText: string): Promise<ResolveResult> {
  const body = answerText.trim();
  if (!body) return { resolved: false };
  const kind = (item.ref as { kind: string }).kind;

  if (kind === 'conversation') {
    const res = await resolveConversationAnswer({
      conversation_id: refField(item, 'conversationId'),
      accepted_answer: body,
    });
    if (res?.error) throw new Error(res.error);
    return { resolved: true };
  }

  if (kind !== 'plan-item') return { resolved: false };
  const slug = refField(item, 'slug');
  const itemId = refField(item, 'itemId');
  const dec = await addPlanDecision({ slug, title: `Answer to ${itemId}`, body, refs: [itemId] });
  if ('error' in dec) throw new Error(dec.error ?? 'add-decision failed');
  const r = await setItemStatus({ slug, itemId, status: 'done' });
  if ('error' in r) throw new Error(r.error ?? 'set-status failed');
  resumeLoop(item.harnessSlug);
  return { resolved: true };
}

export interface ReplyResult extends ResolveResult {
  /** True when the asker was live (coord:presence) and the reply was pushed
   *  straight to their inbox + they were woken. False (including on any
   *  delivery error) means the caller should treat this like today — the
   *  answer still resolved the item; only the extra push didn't happen. */
  live: boolean;
  woken: number;
}

/**
 * D-006/D-007 (owner-inbox-single-pane-2026-07-17 P-006): answer an ask item
 * AND route the reply straight back to its asker. Resolves via the existing
 * `answerAttentionItem` path first (unchanged behavior — the item still
 * resolves even if reply-routing below fails or the asker is dead), then,
 * only when the item names an asker (`ownerAgentId`), best-effort delivers +
 * wakes them via the admin-UI-only inbox-reply route (D-007) — which also
 * stamps the delivered turn `coord-inject:owner` in the turn-provenance
 * ledger (D-006). Never throws for a dead/unknown asker or a delivery
 * fault — those degrade to `{ live: false, woken: 0 }`; the resolve itself
 * already landed via the (already-thrown-on-failure) `answerAttentionItem`
 * call above.
 */
export async function replyToAttentionItem(item: AttentionItem, answerText: string): Promise<ReplyResult> {
  const askerId = item.ownerAgentId;
  const body = answerText.trim();
  const kind = (item.ref as { kind: string }).kind;

  // P-013: needs-human work items and owner walls are already durable source
  // records; their missing operation was the OWNER'S TEXT reaching the live
  // agent that can clear the source. Deliver first, then triage the attention
  // card only after that authoritative owner turn lands. If the agent is gone
  // or delivery fails, leave the card unresolved — the adapter exposes the
  // honest source/session fallback instead of silently losing the answer.
  if (kind === 'work-item-needs-human' || kind === 'owner-wall') {
    if (!askerId || !body) return { resolved: false, live: false, woken: 0 };
    try {
      const delivered = await deliverInboxReply({
        askerId,
        text: body,
        summary: `Owner answered your ${item.kind} (${item.id})`,
        planSlug: item.planSlug ?? undefined,
      });
      if (delivered.error || !delivered.delivered) {
        return { resolved: false, live: delivered.live, woken: delivered.woken };
      }
      const triaged = await triageAttentionItem({
        itemId: item.id,
        action: 'resolve',
        note: 'Owner answer delivered from the Resolution Inbox',
      });
      if (triaged?.error) throw new Error(triaged.error);
      return { resolved: true, live: delivered.live, woken: delivered.woken };
    } catch {
      return { resolved: false, live: false, woken: 0 };
    }
  }

  const resolved = await answerAttentionItem(item, answerText);
  if (!resolved.resolved || !askerId || !body) return { ...resolved, live: false, woken: 0 };
  try {
    const res = await deliverInboxReply({
      askerId,
      text: body,
      summary: `Owner answered your ${item.kind} (${item.id})`,
      planSlug: item.planSlug ?? undefined,
    });
    if (res.error) return { ...resolved, live: false, woken: 0 };
    return { ...resolved, live: res.live, woken: res.woken };
  } catch {
    // D-007: reply-routing is best-effort layered on top of the (already
    // successful) resolve — a delivery hiccup must never surface as an
    // "answer failed" toast.
    return { ...resolved, live: false, woken: 0 };
  }
}
