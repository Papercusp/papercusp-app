/**
 * The ONE definition of what counts as a written kill criterion
 * (goals-tab-improvement-2026-08-09 P-009).
 *
 * WHY THIS IS A MODULE AND NOT A LINE INSIDE `validateProposal`. It began as
 * four lines inside `goals:propose`, which was fine while `propose` was the
 * only door that could install a criterion. P-009 adds a SECOND door — the
 * owner editing the criterion inline, where the "nothing can stop this goal"
 * alarm is raised — and a second door with its own copy of the rule is how the
 * edit path quietly becomes the way to install a criterion the create path
 * would have refused. So the rule moved here and both doors call it. The item
 * states this as a hard constraint: "share the check rather than
 * re-implementing it".
 *
 * WHY IT LIVES IN operator-core RATHER THAN BESIDE THE OTHER SHARED GOAL
 * PRIMITIVES (`@papercusp/agent-mcp/goals` → `tools/goals/_core.ts`). Three
 * callers need it and one of them is a BROWSER bundle: `goals:propose` and
 * `goals:update` (agent-mcp) plus the HUD's inline editor (apps/operator). The
 * agent-mcp shared module imports `node:crypto` and `zod`, so importing it from
 * the client would drag a server module into the webview bundle. This file
 * imports NOTHING, agent-mcp already deep-imports operator-core for exactly
 * this kind of pure helper (`entity-resolvers-papercusp.ts` →
 * `lib/operator-fuzzy-dedup`), and the HUD already deep-imports
 * `@papercusp/operator-core/lib/*`. So this is the only home all three can
 * reach.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It cannot judge SUBSTANCE and does not try:
 * it catches the placeholder, not the merely-weak. A criterion is prose about
 * the future, and a checker that tried to rule on whether one is *good* would
 * refuse real criteria — which is worse than admitting a weak one, because the
 * owner can revise a weak criterion and cannot revise a refusal. The permissive
 * side is pinned by test for that reason.
 */

/**
 * Shortest string that can plausibly state an abandonment condition.
 *
 * Twelve characters is not a claim about quality — "no sales" (8) states a
 * subject with no condition, "nobody buys it" (14) states one. It is the point
 * below which a string is reliably a stub rather than a sentence.
 */
export const KILL_CRITERION_MIN_CHARS = 12;

/**
 * Prefix-anchored ON PURPOSE. "demand remains unknown after 200 installs" is a
 * real criterion that merely contains a placeholder word; only a string that
 * OPENS with one is standing in for an answer that was never given.
 */
const PLACEHOLDER_OPENER = /^(tbd|n\/?a|none|unknown|todo)\b/i;

/**
 * What a STANDING goal's kill criterion IS
 * (work-on-everything-goal-2026-08-23 P-001).
 *
 * A standing goal pursues an ongoing DUTY, not a checkable outcome, so the
 * question this module normally answers — "under what condition is this
 * abandoned?" — has a different shape rather than no answer. P-001 states it:
 * *kill criterion = tripwires + owner stop*. Both of those are real, countable
 * rails that already exist (`goals.tripwires`, and the owner's stop door which
 * writes `status='paused'`/`killed`), so nothing new is invented here — this
 * constant only NAMES the polarity so every surface says the same thing.
 *
 * WHY A CONSTANT AND NOT A LINE AT EACH DOOR. Exactly the reason this whole
 * module exists, one case further out: the standing polarity has to be stated
 * by the kickoff brief (so the agent does not go looking for an outcome), by
 * the auto-start rail (so it does not refuse a goal that legitimately has no
 * criterion), and by the HUD's "THIS GOAL ENDS WHEN" headline. Three copies of
 * a sentence is three chances to drift, and the drift would be silent —
 * a standing goal briefed with the ORDINARY absent-criterion wording reads as
 * an oversight the agent is invited to correct, which is the precise failure
 * this names away.
 *
 * ⚠ NOT a default written into the `kill_criterion` COLUMN. A standing goal
 * stores NULL there, like any goal with no criterion — fabricating a row value
 * would be the "lie about what the owner said" the `goals:start` args schema
 * refuses. This is presentation of a real absence, not an invented presence.
 */
export const STANDING_GOAL_KILL_POLARITY =
  'this goal is STANDING — an ongoing duty with no checkable outcome, so it ends ' +
  'only when the owner stops it or a tripwire fires. Do not invent a completion ' +
  'condition, and do not treat the absence of one as an oversight to correct.';

/**
 * The refusal message, or null when the criterion is acceptable.
 *
 * Returns a MESSAGE rather than a boolean because all three callers surface it
 * verbatim — `goals:propose` in `degradedReasons`, `goals:update` the same, and
 * the inline editor as the error under the field. A boolean would have each
 * caller writing its own wording, which is the same drift this module exists to
 * prevent, one layer up.
 *
 * ⚠ EMPTY IS A PROBLEM HERE, and callers must not read that as "a goal must
 * have a criterion". A goal may be created with none at all — the owner
 * overruled requiring it (WI-37604, 2026-08-09) — and `goals:update` treats a
 * blank as an explicit CLEAR without consulting this function. This function
 * answers one narrower question: *given that a criterion is being SET, is this
 * string one?* Blank fails it because a blank string is not a criterion, not
 * because criteria are mandatory.
 */
export function killCriterionProblem(criterion: string): string | null {
  const text = criterion.trim();
  if (text.length < KILL_CRITERION_MIN_CHARS || PLACEHOLDER_OPENER.test(text)) {
    return (
      `killCriterion '${text}' states no abandonment condition — GOAL mode requires a concrete one, ` +
      'and it is the only thing that can ever stop this goal'
    );
  }
  return null;
}
