/**
 * The `directed-implementer` persona makes two kinds of claim about its own toolset, and
 * BOTH are load-bearing prose that the deny list can silently falsify (P-004,
 * `directed-pair-work-items-2026-08-25`).
 *
 * 1. It names verbs as DENIED and then reasons from that denial. The compaction-recovery
 *    section's whole argument — "you have no wake source of your own, so do not end a turn
 *    silently" — rests on `loop:arm` being denied. Drop that entry and the persona keeps
 *    giving advice whose premise is gone, which is worse than no advice: the implementer
 *    now has a timer AND is told it does not.
 * 2. It instructs the implementer to CALL specific tools. If one of those is later added to
 *    the deny list, the instruction becomes uncallable at exactly the moment it matters —
 *    the recovery path after a compaction, which is the least-exercised path in the design.
 *
 * This is the same class as EI-21475119505876554 (a deny entry naming no real tool): a
 * hand-authored name is a second copy of a truth the registry owns. Unit tests over the
 * MATCHER cannot catch either failure, because both are about which names are on the list,
 * not about how the list is applied. So this judge folds the real gate
 * (`evaluateSessionConfinement`) rather than reimplementing glob semantics — a pin that
 * re-derived the matcher could agree with itself while disagreeing with the server.
 */

export interface PersonaToolClaimVerdict {
  readonly ok: boolean;
  /** Tools the persona tells the implementer to CALL that the deny list refuses. */
  readonly unusableInstructions: string[];
  /** Verbs the persona presents as denied that are NOT actually denied. */
  readonly unbackedDenialClaims: string[];
  /** Every `server:verb` token the persona mentions in backticks. */
  readonly mentionedTools: string[];
  readonly violations: string[];
}

/** A backticked span, so prose mentioning a colon cannot be mistaken for a tool call. */
const BACKTICK_SPAN = /`([^`]+)`/g;

/**
 * A `server:verb` token INSIDE such a span. The verb half must start with a letter
 * immediately after the colon, which is what keeps `expects: 'answer'`,
 * `root_msg_id: <…>` and `[owner:…]` from reading as tool names.
 */
const TOOL_TOKEN = /\b([a-z][a-z_]*:[a-z][a-z_]*(?:[.\-][a-z_]+)*)\b/g;

export function extractToolTokens(md: string): string[] {
  const found = new Set<string>();
  for (const span of md.matchAll(BACKTICK_SPAN)) {
    for (const tok of span[1].matchAll(TOOL_TOKEN)) found.add(tok[1]);
  }
  return [...found].sort();
}

export function judgePersonaToolClaims(args: {
  personaMd: string;
  /** Tokens the persona legitimately presents AS denied — these must in fact be denied. */
  deniedMentions: readonly string[];
  /** The real gate, pre-bound to the real confinement. */
  isDenied: (tool: string) => boolean;
}): PersonaToolClaimVerdict {
  const { personaMd, deniedMentions, isDenied } = args;
  const mentionedTools = extractToolTokens(personaMd);
  const denied = new Set(deniedMentions);

  const unbackedDenialClaims = [...denied].filter((t) => !isDenied(t)).sort();
  const unusableInstructions = mentionedTools.filter((t) => !denied.has(t) && isDenied(t));

  const violations: string[] = [];
  for (const tool of unbackedDenialClaims) {
    violations.push(
      `persona presents \`${tool}\` as denied, but the deny list does not refuse it — ` +
        `the reasoning that rests on that denial is now unsound`,
    );
  }
  for (const tool of unusableInstructions) {
    violations.push(
      `persona instructs the implementer to call \`${tool}\`, but it is denied — ` +
        `following the persona would hit a refusal`,
    );
  }

  return {
    ok: violations.length === 0,
    unusableInstructions,
    unbackedDenialClaims,
    mentionedTools,
    violations,
  };
}
