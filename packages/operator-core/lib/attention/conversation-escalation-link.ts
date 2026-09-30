/**
 * conversation-escalation-link — link a `coord:ask-owner` question's TWO
 * attention rows so answering it clears BOTH.
 *
 * THE DEFECT THIS CLOSES (measured 2026-08-03, EI-19399318647145782).
 * `coord:ask-owner` (coord-ops/ops/compose.ts `askOp.run`) writes the owner ONE
 * question as TWO independent attention rows:
 *
 *   (a) a `coord_conversations` row  -> conversationToAttention -> ALERT tier
 *   (b) a `coord_open_escalations` row (severity 'question')
 *                                     -> escalationToAttention  -> DECISION tier
 *
 * Nothing linked them, and `conversations:resolve` only ever closed (a). So the
 * owner ANSWERING a question left (b) open FOREVER, in the highest-priority
 * tier. Measured on the live workspace: of the 11 question conversations ever
 * resolved, **9 (82%) still had an open escalation twin**; 131 open
 * `severity='question'` escalations, 112 of them older than 7 days, the oldest
 * from 2026-06-15 (49 days).
 *
 * That is the rot the filing's own symptom ("my questions are unreachable in
 * the GUI") actually rests on. It is NOT under-tiering — the escalation twin
 * already reaches the Decision tier. It is that the Decision tier is
 * over-populated with the un-cleared twins of questions the owner ALREADY
 * ANSWERED, so the live ones are buried. Promoting the conversation leg to the
 * Decision tier as well — the filing's literal request — would have made it
 * strictly worse: two Decision rows per ask instead of one.
 *
 * THE LINK. `openEscalation` spreads its `meta` bag flat onto the escalation
 * envelope (escalations.ts: `Object.assign(env, input.meta)`), so stamping
 * `{ conversationId }` at ask time costs no column and no migration — the same
 * seam P-033 already uses for `cardCorrelationId`. `escalationDedupIdentity`
 * reads only `subjectSignature`/`dedupKind`, so an extra meta key cannot
 * perturb escalation dedup.
 *
 * PURE + IO-FREE on purpose: the selector is the part worth testing, and a leaf
 * with no imports cannot drift out of sync with a test double.
 */

/** Meta key stamped on an ask-owner escalation naming its conversation twin. */
export const CONVERSATION_LINK_META_KEY = 'conversationId';

/** Resolver identity stamped on an escalation auto-cleared by its answer. */
export const ANSWERED_QUESTION_RESOLVER = 'system:conversation-answered';

/**
 * Choice recorded on the auto-resolve. `coord:resolve` semantics want a named
 * choice; the owner's real answer lives on the conversation, so this names the
 * MECHANISM rather than pretending to be a decision the owner made here.
 */
export const ANSWERED_QUESTION_CHOICE = 'answered-in-conversation';

/** Resolver identity stamped when an owner ask is replaced before answering. */
export const SUPERSEDED_QUESTION_RESOLVER = 'system:conversation-superseded';

/** Choice recorded when the old owner ask is retired by a replacement ask. */
export const SUPERSEDED_QUESTION_CHOICE = 'superseded-in-conversation';

/** The stamp to merge into an escalation's `meta` at ask time. */
export function conversationLinkMeta(
  conversationId: string,
): Record<string, string> {
  return { [CONVERSATION_LINK_META_KEY]: conversationId };
}

/** The shape this module needs off an open escalation — nothing more. */
export interface LinkedEscalationInput {
  msg_id: string;
  /** Flat-spread meta; `conversationId` lands here (see module doc). */
  [key: string]: unknown;
}

/**
 * PURE: msg_ids of the open escalations linked to `conversationId`.
 *
 * Deliberately an EXACT match on the stamped id and nothing else. It would be
 * easy to "helpfully" fall back to matching on the id prefix (a conversation
 * and its escalation are minted ~30ms apart, so their base36 ids share a
 * prefix) — that heuristic is how the 9 existing zombies were FOUND, but it is
 * not sound enough to RESOLVE on: a prefix collision would silently close an
 * unrelated owner decision, which is a strictly worse failure than leaving a
 * zombie. Un-stamped pre-existing rows are a one-off backfill, not a reason to
 * make the live path guess.
 */
export function selectEscalationsForConversation(
  opens: readonly LinkedEscalationInput[],
  conversationId: string,
): string[] {
  const wanted = conversationId.trim();
  if (!wanted) return [];
  const out: string[] = [];
  for (const e of opens) {
    if (typeof e?.msg_id !== 'string' || !e.msg_id) continue;
    const linked = e[CONVERSATION_LINK_META_KEY];
    if (typeof linked === 'string' && linked.trim() === wanted) out.push(e.msg_id);
  }
  return out;
}
