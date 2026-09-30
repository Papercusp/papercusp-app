/**
 * derived-plan-slug.ts — `plan_slug` is DERIVABLE, not authored (P-005,
 * coordination-spec-adoption-2026-08-03, D-097).
 *
 * ── WHAT WAS MEASURED, AND WHY IT IS A FIELD AND NOT A PROMPT PROBLEM ────────
 *
 * `coord:send { plan_slug }` is an optional caller argument, and `coord:feed`
 * offers `plan_slug` as a filter ("Restrict to one plan slug"). Measured live
 * over 24h (2026-08-03, papercusp/papercusp-workspace) against the APPEND-ONLY
 * intent log rather than the mutated presence row:
 *
 *   343  hand-authored agent sends (D-095's corrected denominator: agent-session
 *        sender, `expects` present, not `auto`)
 *   228  of those came from a sender that had DECLARED a plan lane in the window
 *    12  carried `plan_slug`
 *   216  did not — across 24 DISTINCT senders
 *
 * Twenty-four senders is not an agent forgetting; it is a convention that does
 * not hold. The sender had already told the system its plan (`coord:orient
 * { planSlug }` → `coord_presence.current_plan_slug`), so every one of those 216
 * messages was one indexed lookup away from carrying it. That is D-016's shape
 * exactly — a behaviour whose only enforcement is prose — and the fix D-001
 * ranks first is tier 1, auto-stamp.
 *
 * The cost is paid by the READER: a plan-scoped `coord:feed { plan_slug }` today
 * returns roughly 5% of that plan's real traffic, and returns it as though it
 * were the whole. A filter that silently omits 95% is worse than one that errors.
 *
 * ── WHY THIS FIELD QUALIFIES WHEN `current_files` DOES NOT ───────────────────
 *
 * P-005's stated criterion is "derivable rather than authored", but derivability
 * alone is NOT sufficient, and the difference is what keeps this stamp honest.
 * The real test is whether the value is FIXED AT WRITE TIME:
 *
 *   - `plan_slug` — "which plan was the sender on when it sent this" is a
 *     HISTORICAL fact about an immutable log row. It cannot decay. Same time-
 *     semantics as `basedOn.readAt` / `versionAtSend` (D-084 R4).
 *   - `current_files` — LIVE state. It changes as locks are taken and released,
 *     so a stamped copy starts rotting immediately. Its two consumers both
 *     worked this out independently and route around the field to the LOCK plane
 *     instead (`listPathLockAgents` for `@file:`, `deriveCouplingsFromHeldFiles`
 *     for coupling; see coupling-derivation.ts's note). Stamping it would have
 *     added a third, staleness-generating copy of a fact two readers already
 *     derive authoritatively at READ time.
 *
 * So the rule this module encodes, and the one P-005's list is built on: STAMP
 * WHAT IS FIXED AT WRITE TIME; DERIVE AT READ WHAT IS LIVE. Every field already
 * stamped at this seam satisfies it — `auto` and `expects:'none'` (properties of
 * the sender identity), `premisesClassified` (a classification of authored text),
 * `basedOn` (what was read BEFORE the send), `couplingDivergence` (a comparison
 * made AT the claim, which its own header says cannot be reconstructed later),
 * and `capability_tags` (a machine fact its own module caches precisely because
 * it "does not change turn-to-turn").
 *
 * ── D-095's TEST, APPLIED ────────────────────────────────────────────────────
 *
 * "Can the compliant minimum produce a row that reads as failure?" For
 * `plan_slug`: yes. An absent key is today indistinguishable between "the sender
 * was on no plan" and "the sender was on a plan and did not pass the arg", and
 * the measurement says the second case is 95% of it. Absence is AMBIGUOUS, so
 * stamping ADDS information.
 *
 * That is the opposite of `sections`, which D-095 ruled must keep its omission:
 * there the compliant minimum omits the key to avoid duplicating the entire body
 * on the wire. The asymmetry is one of PRICE. Omitting `sections` buys back a
 * whole payload; omitting `plan_slug` saves a slug and destroys a filter.
 *
 * ── NEVER OVERRIDE, AND ALWAYS SAY IT WAS DERIVED ────────────────────────────
 *
 * An explicit caller value always wins (the `auto`/`expects`/`harness_slug`
 * stamps at this seam all hold that line). And the stamped value is marked
 * `fieldProvenance.plan_slug = 'presence-derived'`, because an adoption metric
 * must never count a machine default as sender intent — the same reason the
 * `expects` stamp records its own provenance. Without that, P-001's scorecard
 * would read this change as agents suddenly adopting a convention they did not.
 */

import { isAgentSessionSender } from './machine-authored';

/** `fieldProvenance.plan_slug` when this seam supplied the value. */
export const PLAN_SLUG_DERIVED_PROVENANCE = 'presence-derived';

/**
 * Should the send seam derive `plan_slug` for this message?
 *
 * PURE — no IO, so the policy is testable without a database, and the (cheap but
 * non-zero) presence read below happens only when this says yes.
 *
 * ⚠ THE `auto` TEST IS LOAD-BEARING AND ORDER-DEPENDENT. D-095's population —
 * system code emitting under a BORROWED AGENT IDENTITY — passes
 * {@link isAgentSessionSender} by construction, because `from` really is an
 * agent's ownerId. It is excluded here only because the seam stamps `auto: true`
 * on it FIRST (messages.ts), exactly as that block's own comment explains for the
 * `expects` stamp it feeds. Call this before that stamp and library code would
 * start inheriting the calling agent's plan — attributing a lifecycle notice to
 * work it has nothing to do with.
 *
 * Named machine emitters (`git-sync-integrator`, `service-health`, …) are
 * excluded by the agent-session shape itself rather than by a second negative
 * pattern, which also keeps the hottest path in the coordination substrate free:
 * ~94% of sends in the measured window never reach the lookup at all.
 */
export function shouldDerivePlanSlug(input: {
  /** `env.plan_slug` as it currently stands — any defined value wins. */
  readonly explicitPlanSlug: unknown;
  /** `env.auto` as it stands AFTER the machine stamps have run. */
  readonly auto: unknown;
  /** The sender's ownerId (`env.from`). */
  readonly from: string | null | undefined;
}): boolean {
  if (input.explicitPlanSlug !== undefined) return false;
  if (input.auto === true) return false;
  return isAgentSessionSender(input.from);
}

/**
 * Resolve the sender's declared plan, fail-soft.
 *
 * ⚠ EVERY FAILURE DEGRADES TO NO FIELD, NEVER TO A WRONG ONE — and never to a
 * failed send. based-on.ts states the same rule for the same reason, and
 * send.ts's `.catch` on `deriveBasedOn` records what is at stake: "a decorative
 * trace must never be able to fail the delivery it decorates". A message with no
 * `plan_slug` is exactly what we have today; a PG blip that eats a message is a
 * fleet-wide outage. So a throw, a timeout, or a blank slug all yield `null`.
 */
export async function derivePlanSlug(opts: {
  readonly ownerId: string;
  /** Injected so the policy is testable without a live presence store. */
  readonly readPlanSlug: (ownerId: string) => Promise<string | null | undefined>;
}): Promise<string | null> {
  try {
    const slug = await opts.readPlanSlug(opts.ownerId);
    if (typeof slug !== 'string') return null;
    const trimmed = slug.trim();
    return trimmed.length ? trimmed : null;
  } catch {
    return null;
  }
}
