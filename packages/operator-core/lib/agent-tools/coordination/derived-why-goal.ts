/**
 * derived-why-goal.ts — `why.goalRef` is DERIVABLE, not authored
 * (coord-derived-fields-2026-08-31, D-002).
 *
 * ── WHAT WAS MEASURED, AND WHY IT IS A FIELD AND NOT A PROMPT PROBLEM ────────
 *
 * `coord:send { why }` is an optional envelope argument — `{ goalRef, note? }`,
 * the goal a message serves (D-011). Measured live over 24h (2026-08-31,
 * papercusp-workspace) against hand-authored agent sends (agent-session sender,
 * `expects` present, not `auto`):
 *
 *   2,755  hand-authored sends
 *   1,635  omitted `why` (59%)
 *   1,563  of those — 95.6% — came from a sender whose `goal_ref` was stamped
 *          on `tool_invocations` in that same hour, across 151 DISTINCT senders
 *
 * A hundred and fifty-one senders is not an agent forgetting; it is a
 * convention that does not hold (D-016's shape — behaviour whose only
 * enforcement is prose). The sender had already told the system its goal —
 * every claim/`scheduler:get_next`/`loop:arm` writes `noteGoalClaimed`, and the
 * dispatcher stamps `goal_ref` onto every tool call — so each of those 1,563
 * messages was one in-process Map.get away from carrying it. The fix D-001
 * ranks first is tier 1, auto-stamp. When agents DO fill the field the values
 * are clean (75.8% work-item ids, 21.6% goal slugs, 0% prose — 7d), so this is
 * a coverage problem, not a quality problem: exactly the population an
 * auto-stamp serves.
 *
 * ── WHY THIS FIELD QUALIFIES (the derived-plan-slug test, applied) ───────────
 *
 * "Which goal was the sender on when it sent this" is a HISTORICAL fact about
 * an immutable log row — fixed at write time, same time-semantics as
 * `plan_slug` and `basedOn.readAt` (D-084 R4). It cannot decay after the stamp.
 * Absence today is AMBIGUOUS ("on no goal" vs "did not pass the arg", and the
 * measurement says the second is ~96% of it), so stamping ADDS information
 * (D-095's test).
 *
 * ── ⚠ A DEFAULT, NOT GROUND TRUTH — WHY EXPLICIT-WINS IS LOAD-BEARING ────────
 *
 * `goalRef` in the agent-state stamp is LAST-WRITE-WINS per owner (WI-134439's
 * measurements: one `string | null` per agent; ~26% of stamped refs are
 * `fleet:<slug>`-shaped). An agent holding two items carries whichever it
 * claimed most recently, so for a multi-item holder the derived value is a good
 * default and nothing more. That is why:
 *   · an explicit caller `why` ALWAYS wins (the send tool's authored value is
 *     the agent's own attribution and outranks the stamp), and
 *   · the stamped value is marked `fieldProvenance.why`, so no adoption or
 *     scorecard measurement ever counts a machine default as sender intent
 *     (the P-029 failure, mechanised — same rule as every stamp at this seam).
 *
 * The stamp's value was already guarded by `asGoalRef` when written
 * (agent-state-stamp.ts), so the shape a live reader accepts is the shape we
 * stamp — no second validation vocabulary here (D-041).
 *
 * ── FAIL-SOFT ────────────────────────────────────────────────────────────────
 *
 * EVERY failure degrades to NO field, never a wrong one, never a failed send —
 * based-on.ts and derived-plan-slug.ts state the same rule for the same reason:
 * a decorative stamp must never be able to fail the delivery it decorates. A
 * cold per-process cache (the stamp Map is per-process under cluster, WI-6594)
 * yields null and schedules its own rehydration; we simply do not stamp that
 * send.
 */

import { isAgentSessionSender } from './machine-authored';

/** `fieldProvenance.why` when this seam supplied the value. */
export const WHY_GOAL_DERIVED_PROVENANCE = 'goal-stamp-derived';

/**
 * Should the send seam derive `why` for this message?
 *
 * PURE — no IO, so the policy is testable without the stamp cache, and the
 * (cheap but non-zero) stamp read below happens only when this says yes.
 *
 * ⚠ THE `auto` TEST IS LOAD-BEARING AND ORDER-DEPENDENT — copied verbatim from
 * `shouldDerivePlanSlug`, for the same D-095 population: system code emitting
 * under a BORROWED AGENT IDENTITY passes `isAgentSessionSender` by
 * construction. It is excluded here only because the seam stamps `auto: true`
 * on it FIRST (messages.ts). Call this before that stamp and a lifecycle
 * notice would inherit the calling agent's goal — attributing a machine
 * message to work it has nothing to do with.
 */
export function shouldDeriveWhyGoal(input: {
  /** `env.why` as it currently stands — any defined value wins. */
  readonly explicitWhy: unknown;
  /** `env.auto` as it stands AFTER the machine stamps have run. */
  readonly auto: unknown;
  /** The sender's ownerId (`env.from`). */
  readonly from: string | null | undefined;
}): boolean {
  if (input.explicitWhy !== undefined) return false;
  if (input.auto === true) return false;
  return isAgentSessionSender(input.from);
}

/**
 * Resolve the sender's current goal ref, fail-soft.
 *
 * ⚠ EVERY FAILURE DEGRADES TO NO FIELD, NEVER TO A WRONG ONE — and never to a
 * failed send (see the module header). A throw, a cold cache, or a blank ref
 * all yield `null`.
 *
 * The reader is injected so the policy is testable without the process-global
 * stamp Map — the exact seam `derivePlanSlug` uses for the presence store.
 */
export async function deriveWhyGoal(opts: {
  readonly ownerId: string;
  /** Injected so tests never touch the process-global stamp cache. */
  readonly readGoalRef: (ownerId: string) => Promise<string | null | undefined> | string | null | undefined;
}): Promise<string | null> {
  try {
    const ref = await opts.readGoalRef(opts.ownerId);
    if (typeof ref !== 'string') return null;
    const trimmed = ref.trim();
    return trimmed.length ? trimmed : null;
  } catch {
    return null;
  }
}
