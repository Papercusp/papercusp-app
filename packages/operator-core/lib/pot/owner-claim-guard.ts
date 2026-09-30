/**
 * Guard against a wake carry-note / kickoff / subscription-note text
 * FABRICATING an owner decision that never happened (EI-18742016294354354).
 *
 * `pot:declare-wake` accepts free text (`events[].note`, `kickoff`,
 * `remember`) with no provenance discipline — an agent that *asked* the
 * owner something and *hoped* for a yes can write "the owner answered X" into
 * a note, and the claim outlives the session that knew it was speculative. At
 * the next wake, `pot:status` / the wake kickoff render that text as bare
 * fact, structurally indistinguishable from platform-verified state —
 * exactly the trap `coord:send { relayOf }` (relay-provenance.ts) and
 * `facts:assert { sourceRef }` exist to prevent for coordination messages
 * and durable facts. Wake text has neither mechanism, so the correct move is
 * to REFUSE a note that reads as an owner-decision claim rather than
 * silently persist it — this is the write-side half of the fix; the
 * read-side half (stamping ANY note as agent-authored/unverified wherever it
 * is rendered) lives in pot/status.ts and pot/wake.ts's syncPotWakeRules.
 *
 * Deliberately narrow + past-tense-anchored to avoid flagging legitimate
 * forward-looking notes ("wake when the owner approves X", "ask the owner to
 * confirm Y") — only a claim that the decision ALREADY happened trips it.
 */

const OWNER_TOKEN = '(?:owner|the human)';
const DECISION_VERB =
  '(?:answered|approved|confirmed|decided|okay(?:ed)?|agreed|authorized|authorised|sign(?:ed)?[\\s-]?off|greenlit|resolved|responded)';

/** owner-token ... decision-verb, e.g. "the owner answered resume-or-hold" */
const FORWARD_RE = new RegExp(`\\b${OWNER_TOKEN}\\b[^.!?\\n]{0,60}\\b${DECISION_VERB}\\b`, 'i');
/** decision-verb ... (by the) owner-token, e.g. "approved by the owner" */
const REVERSE_RE = new RegExp(`\\b${DECISION_VERB}\\b[^.!?\\n]{0,40}\\b(?:by\\s+)?(?:the\\s+)?${OWNER_TOKEN}\\b`, 'i');

/** True when `text` reads as a claim that the owner already made a decision —
 *  the pattern behind EI-18742016294354354's fabricated "the owner answered …". */
export function looksLikeUnverifiedOwnerClaim(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  return FORWARD_RE.test(t) || REVERSE_RE.test(t);
}

export const UNVERIFIED_OWNER_CLAIM_GUIDANCE =
  'This text reads as a claim that the owner already made a decision (e.g. "the owner answered …" / "approved by ' +
  'the owner"). A wake note/kickoff/carry-note has no provenance mechanism (unlike coord:send{relayOf} or ' +
  'facts:assert{sourceRef}), so a claim like this here would outlive the session that knew it was speculative and ' +
  'render as bare fact at the next wake (EI-18742016294354354). If the owner genuinely decided this, record it via ' +
  'facts:assert with a sourceRef instead, or verify it first (coord:thread / sessions:search) — never carry an ' +
  'unverified owner decision in this field.';

/** Explicit, machine-readable stamp applied at RENDER time (pot:status, the
 *  wake kickoff) to every non-empty note — belt-and-suspenders for text
 *  written before this guard existed, written by a caller other than
 *  pot:declare-wake, or that simply doesn't match the narrow claim pattern
 *  above. ALL wake notes are agent-authored and unverified by construction;
 *  this stamp says so wherever one is rendered, so it never reads as bare
 *  platform-corroborated fact next to genuinely computed state. */
export const UNVERIFIED_NOTE_STAMP = 'agent-authored, unverified';
