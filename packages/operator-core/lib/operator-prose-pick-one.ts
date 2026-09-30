/**
 * Deterministic detector for the WI-4950 failure class: a TEXT-modality
 * operator reply that ENUMERATES 2+ options in prose and ends by asking the
 * user to pick — instead of calling chat:ask_choice to render clickable
 * buttons. That reply is a conversational dead-end (nothing to click, not
 * voice-answerable, no answered-pick recorded) and is invisible to unit
 * tests because the string itself looks perfectly healthy.
 *
 * Used post-stream in operator:converse as OBSERVABILITY (a measurable miss
 * rate for the prompt-level PICK-ONE contract) and as the seam for a future
 * registerCard salvage. Deliberately CONSERVATIVE: a false positive would
 * mislabel a healthy turn, so both signals must fire —
 *   (1) the reply ENDS on a short pick-question ("Which?", "Pick one?", …)
 *   (2) the body enumerates >=2 options (numbered/bulleted list, an
 *       "A, B, or C" enumeration, or an explicit count cue like "Three picks").
 *
 * Live repro this is calibrated against (operator_turns seq 11402 + 11822):
 *   "Three picks: unstick the placement stall, dig into the release-readiness
 *    rubric that's overdue, or triage the aging escalation backlog. Which?"
 */

export interface ProsePickOneHit {
  detected: boolean;
  /** Which enumeration signal fired (present iff detected). */
  reason?: string;
}

export function detectProsePickOne(reply: string): ProsePickOneHit {
  // Strip control tags (<say>, <continue/>, <spawn …>) and collapse whitespace.
  const text = reply.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return { detected: false };

  // (1) The reply must END on a short pick-question. Keyed on explicit
  // pick vocabulary — a generic trailing question ("Take a look?") is a
  // normal conversational move, not this failure class.
  const tail = text.slice(-100);
  const asksPick =
    /(\bwhich(\s+(one|way|of\s+these|do\s+you\s+\w+))?\b|\bpick(\s+one)?\b|\bchoose\b|\byour\s+(call|pick|choice)\b|\bpreference\b)[^.!?]{0,40}\?$/i.test(
      tail,
    );
  if (!asksPick) return { detected: false };

  // (2) The body must ENUMERATE >=2 options.
  const numbered = /(^|[\s(])1[.)]\s+\S[\s\S]*?(^|[\s(])2[.)]\s+\S/.test(reply);
  const bulleted = (reply.match(/(^|\n)\s*[-•]\s+\S/g) ?? []).length >= 2;
  const orEnumeration = /,\s+[^,.?]{2,80}?,?\s+or\s+[^,.?]{2,80}[.?]/i.test(text);
  const countCue =
    /\b(two|three|four|2|3|4|a\s+few|a\s+couple\s+of)\s+(picks|options|choices|candidates|paths|routes|ways)\b/i.test(
      text,
    );

  if (numbered) return { detected: true, reason: 'numbered-list+pick-question' };
  if (bulleted) return { detected: true, reason: 'bulleted-list+pick-question' };
  if (orEnumeration) return { detected: true, reason: 'or-enumeration+pick-question' };
  if (countCue) return { detected: true, reason: 'count-cue+pick-question' };
  return { detected: false };
}
