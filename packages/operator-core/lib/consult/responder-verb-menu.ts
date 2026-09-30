/**
 * EI-21761566265989000 — the consult RESPONDER's verb menu, rendered in exactly one place.
 *
 * Every wake that routes a consult spells this menu out: the initial route (three branches:
 * lexical-fallback, best-available, relevance), the cascade advance, the revival brief, and the
 * follow-up ping. All five copies named consult:reply / consult:decline / consult:close and NONE
 * of them named the READ door, so a routed reviewer had no path from the verbs they were handed
 * to the verb that reads their own thread.
 *
 * That gap is not theoretical and it is not cheap. A reviewer answering a real consult posted,
 * verbatim: "I have NOT read your latest post — there is no `consult:read` tool and my attempts
 * to pull the thread body directly came back empty, so I am not going to pretend to answer an
 * argument I have not seen." They then reviewed a second time against the artifact alone. The
 * requester's replies were sitting in the thread the whole time.
 *
 * Three properties make this failure silent, and the wording below targets all three:
 *
 *   1. The natural guess is `consult:read`, which does not resolve — the verb family is
 *      write-only, so nothing an in-consult responder holds points at the reader. The door is
 *      `conversations:get`, discoverable only if you think to search for *conversations*.
 *   2. A wrong-door read returns EMPTY, which is indistinguishable from "the thread has no
 *      replies". A reviewer who draws that inference reviews without the requester's responses
 *      and reports lower-confidence findings than the evidence actually supports.
 *   3. The right door returns a keyed-array envelope: posts are at `results[0].posts`, not a
 *      top-level `posts` field. A responder who reads `.posts` literally gets `undefined` and
 *      can still mistake a successful read for an empty thread.
 *
 * Rendering the menu once is the whole point of this module. A hand-maintained sixth copy is
 * exactly how the omission got into five of them; `responder-verb-menu.test.ts` derives the wake
 * bodies from the real builders and fails if any stops naming the read door.
 */

/** Default evidence qualifier — overridden where a branch admits first-principles reasoning. */
const DEFAULT_EVIDENCE_NOTE = 'answer requires evidence';
/**
 * Default decline qualifier — overridden where a branch has a softer or narrower bar.
 *
 * WI-1700133: this used to read "only if you genuinely cannot add value", which is the
 * misroute in miniature. A reviewer who judges the QUESTION void reasons "I genuinely cannot
 * add value" and declines — the one exit that spends the next reviewer. The qualifier now
 * states decline's actual precondition (someone else might still cover it) and its actual cost.
 */
const DEFAULT_DECLINE_NOTE = 'only when another reviewer might still cover it — decline ADVANCES';

export interface ConsultResponderVerbMenuInput {
  /** The consult conversation the responder was routed into. */
  conversationId: string;
  /** Parenthetical after `consult:reply { kind }` (e.g. admitting first-principles reasoning). */
  evidenceNote?: string;
  /** Qualifier after `consult:decline { reason }` (e.g. "if it's not your area"). */
  declineNote?: string;
}

/**
 * The READ door, stated so that the silent-failure modes above are closed: it names the verb
 * (because the guessable name does not exist), the result path (because the keyed-array envelope
 * nests posts under `results[0]`), and what a wrong-door read LOOKS like (because an empty result
 * otherwise reads as an empty thread).
 */
export function consultReadDoorLine(conversationId: string): string {
  return (
    `READ THE THREAD FIRST — conversations:get { id: '${conversationId}' } returns every post oldest-first; ` +
    `posts are at results[0].posts (not a top-level .posts field), so a top-level read returns ` +
    `undefined and looks like an empty thread. ` +
    `There is NO consult:read: the verb family is write-only, so the natural guess does not resolve and a ` +
    `wrong-door read comes back EMPTY — which is indistinguishable from a thread with no replies. If you ` +
    `believe there are no replies, confirm it through this door before answering as though there are none.`
  );
}

/**
 * The VOID EXIT (WI-1700133), stated because the verb menu otherwise offers no cell for it.
 *
 * Every other responder verb ADVANCES the cascade: reply of ANY kind (`answers` counts only
 * kind='answer', so a new_fact leaves the min-answers floor unmet and WI-39861 extends the menu
 * anyway), decline by design (D-005), and silence via the expiry sweep. So a reviewer who has
 * correctly worked out that the consult SHOULD NOT EXIST could not act on that without spending
 * the next reviewer — and on an acceptance-grading cascade every reviewer spent is permanently
 * disqualified from grading that plan under D-009 independence. The worst case is walking the
 * entire independent-grader pool, the scarcest and least replenishable role in the system.
 *
 * The exit was never missing — `consult:close` admits any participant including the current
 * responder, and it is non-advancing (consult-verbs-core's close path never calls advanceCascade;
 * pinned by the mid-menu void-close test). What was missing is any copy SAYING so: close was
 * uniformly conditioned on "when settled" / "you engaged", neither of which describes a void
 * question, so the only door a reviewer could see was the one that burns a grader.
 */
export function consultVoidExitLine(conversationId: string): string {
  return (
    `IF THE QUESTION ITSELF IS VOID — duplicate, inadmissible, or already settled elsewhere — do NOT decline. ` +
    `Reply, decline and expiry ALL advance the cascade and spend the next reviewer; a spent acceptance-grader is ` +
    `then permanently disqualified from grading that plan (D-009). ` +
    `consult:close { outcome: 'cant_help', reason } on ${conversationId} is TERMINAL and NON-ADVANCING — it ends the ` +
    `consult and wakes the requester while spending nobody. ` +
    `Decline means "not me, try the next reviewer"; close means "nobody should answer this".`
  );
}

/** The full responder menu: read door first, then the write verbs, then the void exit. */
export function consultResponderVerbMenu(input: ConsultResponderVerbMenuInput): string {
  const evidenceNote = input.evidenceNote ?? DEFAULT_EVIDENCE_NOTE;
  const declineNote = input.declineNote ?? DEFAULT_DECLINE_NOTE;
  return (
    `${consultReadDoorLine(input.conversationId)}\n` +
    `Reply in conversation ${input.conversationId} with consult:reply { kind } (${evidenceNote}); ` +
    `consult:decline { reason } ${declineNote}; consult:close { outcome } when settled. ` +
    `Untyped conversations:post is refused.\n` +
    `${consultVoidExitLine(input.conversationId)}`
  );
}
