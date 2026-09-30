/**
 * feedback-loop-prompt.ts — the CANONICAL Blender-side prompt guidance for the
 * Mug↔Blender feedback-iteration loop (queen-scout-feedback-loop-2026-06-20,
 * P-005 / D-001 / D-002 / D-003).
 *
 * The loop lets the Mug send actionable feedback on a Blender-routed DRAFT plan,
 * wake Blender, iterate, then converge to READY (Mug promotes) or DEPRECATE
 * (either party + a `learnings` observation) — riding on the existing coord+wake
 * rails (no new table, no new cadence mechanism).
 *
 * This module is the SINGLE SOURCE for the Blender side of that protocol:
 *   • {@link SCOUT_FEEDBACK_LOOP_GUIDANCE} — the agent instruction the Blender
 *     REVISION cycle injects when it wakes to Mug feedback. The cycle/cadence
 *     WIRING that reads coord:inbox and runs the targeted revision is a sibling
 *     brief (P-001/P-002, scheduler.ts/cadence.ts); this is the TEXT it carries.
 *   • {@link SCOUT_DRAFT_LOOP_NOTE} — the concise, state-describing note embedded
 *     in every Blender-generated draft's `## Now` (see scout-plan-draft.ts), so the
 *     draft is self-documenting about its lifecycle for whoever reads it (the
 *     Mug reviewing it, or a later Blender revision re-reading it).
 *
 * The Mug side of the SAME protocol is mirrored in the shared Mug persona
 * (`blueprints/base/prompts/mug.base.md`, the "Iterate on Blender's routed
 * drafts" bullet). The two are kept in lock-step by
 * `feedback-loop-prompt.test.ts`, which asserts both carry the loop's invariants
 * (announce → revise-on-feedback → ready|deprecate, the "still making progress?"
 * heuristics, the deprecate-emits-learnings rule).
 */

/**
 * The Blender-side agent guidance for one turn of the feedback loop — what Blender
 * does on a draft it has routed, and on a Mug-feedback wake. Authored as plain
 * markdown so the revision-cycle prompt can inject it verbatim.
 */
export const SCOUT_FEEDBACK_LOOP_GUIDANCE = `## Reviewer↔Blender feedback loop — your side of the iteration

When you route a broad idea to a \`status: draft\` plan, \`coord:send\` the REVIEWING
STEWARD to announce it so it reviews it (D-003 #1). The steward is whoever the nudge
ladder resolves — normally a GOAL-mode su holding the Blender goal, otherwise any live
su the ladder reaches. It is NOT a role lookup, and it is never the Mug or the Queen:
that tier is retired (retire-mug-kettle-su-only-2026-08-09). The 1–5 grade the steward
may give is a separate one-way LEARNING signal — THIS loop is the two-way ITERATION
signal on that one draft.

When you wake to reviewer feedback on a draft (a coord message carrying its
\`plan_slug\`), run a TARGETED revision on THAT draft: address the specific gaps it
named, record a new plan revision, then \`coord:send\` it back that it's ready for
re-review. Revise the EXISTING draft — do not re-ideate from scratch, and do not
start a fresh idea while a revision is pending (a pending revision preempts fresh
ideation, D-003 #4).

Iterate while you are making good progress — and do NOT loop forever. Stop when
progress stalls. Check yourself each round:
- Does my revision actually CLOSE the feedback, or just restate/dodge it?
- Is the gap to "ready" SHRINKING round over round?
- Am I re-litigating the SAME point a second time (a stall, not progress)?
- Is the open objection about EXECUTION (keep iterating) or the PREMISE (deprecate)?

Only the REVIEWING STEWARD marks a draft READY (it promotes it) — that's not yours
to do. Your terminal move is the other one: if you conclude the PREMISE is flawed (not
just the execution), self-deprecate the draft with one atomic call —
\`plans:set-plan-status { status: 'superseded', learnings: { tried, stalled,
salvageable } }\`, which marks it superseded AND emits the structured \`learnings\`
observation — then tell the steward. A deprecated draft still produces fuel (a
future cycle re-ideates from the salvage); the loop stays closed, no dead ends.`;

/**
 * The concise, state-describing lifecycle note embedded in a Blender draft's
 * `## Now` (`buildScoutPlanTemplate`). It tells whoever opens the draft what loop
 * it is in and how it terminates — without restating the full agent guidance.
 */
export const SCOUT_DRAFT_LOOP_NOTE =
  'If you are reading this, YOU are the reviewer — there is no separate role waiting ' +
  'to do it. The Mug/Queen tier is retired (retire-mug-kettle-su-only-2026-08-09), so ' +
  'this draft is reviewed by whichever steward or su the nudge ladder reached, and you ' +
  'hold the authority to dispose of it. Do one of three things, never nothing: promote ' +
  'it to greenlight (`ready`), `coord:send` plan-keyed feedback to its scout owner to ' +
  'revise, or deprecate it with a `learnings` observation. Iterate while making good ' +
  'progress; if the premise will not reach ready, either party deprecates it (no dead ends).';
