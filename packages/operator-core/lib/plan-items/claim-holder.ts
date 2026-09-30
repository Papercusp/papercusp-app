/**
 * claim-holder.ts — the ONE projection of "who holds this plan item, and WHY",
 * rendered identically on every NON-CONFLICT plan-item read.
 *
 * Plan: unified-agent-state-plane-2026-07-27, P-029 (ruling D-060).
 *
 * THE GAP THIS CLOSES. A holder's goal was surfaced ONLY on a refusal —
 * `claim-discipline.ts`'s conflict `holder{ owner, ownerLabel, intent, expiresTs }`
 * fires when your claim is REJECTED. A reader merely browsing what is taken saw a
 * bare ownerId and nothing about why, so the only way to learn a peer's goal was to
 * collide with them first. D-060 reversed D-055's exclusion of these surfaces on
 * MEASURED grounds: the p90 payload number that killed broad holder-surfacing was
 * measured against `coord:presence`, which enumerates ALL presence rows (124 here);
 * a claim surface enumerates CLAIMED ITEMS — 3 live plan-item claims, 4 work-item.
 *
 * IT IS A PROJECTION, NOT A BUILD. Every field below already sits on the row the
 * reader is already fetching: `plan_item_claims.intent` (written by
 * `reconcileDeclaredClaims` on every `coord:declare-intent { items }`) and its
 * `acquired_ts`/`last_activity_ts`. The `fleet_assignment` view carries the same
 * three as `detail` / `claim_acquired_ts` / `last_activity_ts`. No new query, no
 * new capture, and deliberately NO new column — see P-030 for why the work-item
 * leg must resolve its goal through a cell instead of growing a third place a goal
 * is written.
 *
 * ⚠ READER-INDEPENDENT BY CONSTRUCTION, and that is load-bearing. `plans:items`
 * caches its rows under a key that does NOT include the caller (it is documented
 * there as a PURE, non-principal read), so the first caller's view is served to
 * every other caller for the SWR window. Anything reader-relative placed inside
 * that cache leaks across identities and no single-identity test can see it. Every
 * field here is the same for all readers — the claim's own intent, already
 * disclosed unconditionally to anyone who collides with it, whose audience
 * boundary is the plan read itself. Audience-filtered state (an agent's
 * assumptions, whose visibility genuinely varies per reader) must therefore NOT be
 * added to this projection while its consumers cache non-principally; it belongs
 * to the P-026 HolderContext, resolved outside the cached region.
 */
import { computeIntentStale, INTENT_STALE_SEC } from '../agent-tools/coordination/presence-tier1';

/**
 * The claim intent `plans:set-status … → wip` writes when the auto-convert flag
 * mints a tracked work-item for the flip. Built here, and used at the WRITE site,
 * so {@link declaredGoalOf}'s detection can never drift from the string it
 * detects — the same one-constant discipline `PLACEHOLDER_INTENT` uses for the
 * turn-start heartbeat's presence intent.
 */
export function autoConvertClaimIntent(itemId: string): string {
  return `plans:set-status ${itemId} → wip (auto-convert)`;
}

/** Why a holder has no goal to show. Absent when `goalText` is present. */
export type GoalUnknownReason =
  /** The claim was taken by a mechanism (an auto-convert flip), not declared. */
  | 'auto-claimed'
  /** A claim exists but its intent is blank — nothing was ever declared. */
  | 'none-declared';

/**
 * A plan item's holder, as every non-conflict reader renders it. `null` for
 * `goalText` is an HONEST unknown carrying its reason — never a fabricated goal
 * and never a mechanism string dressed up as one.
 */
export interface ClaimHolder {
  ownerId: string;
  ownerLabel: string | null;
  /** The holder's DECLARED goal for this claim, or null (see `goalUnknown`). */
  goalText: string | null;
  /** Present only when `goalText` is null. */
  goalUnknown?: GoalUnknownReason;
  /** When the claim — and therefore the goal — was declared. */
  declaredAt: string | null;
  /** No genuine activity within INTENT_STALE_SEC. null ⇒ activity unknown. */
  stale: boolean | null;
}

/**
 * Split a raw claim intent into a declared goal or an honest unknown.
 *
 * Two intents reach `plan_item_claims.intent` that are NOT goals, and both read
 * like one if echoed verbatim:
 *   - the auto-convert flip's mechanism string (see {@link autoConvertClaimIntent}) —
 *     it names the TOOL CALL that took the claim, not the work;
 *   - the empty string, the store's default when `claimPlanItem` is called with no
 *     intent at all.
 *
 * Measured 2026-07-27 in this workspace: 15 claims, 0 blank, **5 auto-convert, 10
 * real goals**. So "the column is 100% populated" — true, and the finding that
 * unblocked P-029 — does NOT mean 100% of holders declared a goal; a third did
 * not. Rendering the mechanism string would have reported that third as goals.
 */
export function declaredGoalOf(
  intent: string | null | undefined,
  itemId: string,
): { goalText: string; goalUnknown?: undefined } | { goalText: null; goalUnknown: GoalUnknownReason } {
  const s = (intent ?? '').trim();
  if (!s) return { goalText: null, goalUnknown: 'none-declared' };
  if (s === autoConvertClaimIntent(itemId)) return { goalText: null, goalUnknown: 'auto-claimed' };
  return { goalText: s };
}

/** The claim facts this projection reads — structural, so a `PlanItemClaim` row
 *  and a `fleet_assignment` row both satisfy it without either importing the other. */
export interface ClaimHolderInput {
  /** The holding ownerId. Null/blank ⇒ no holder ⇒ the projection is null. */
  ownerId: string | null | undefined;
  ownerLabel?: string | null;
  itemId: string;
  /** Raw `plan_item_claims.intent` (the view's `detail` on a plan_item_claim row). */
  intent?: string | null;
  /** `acquired_ts` — when this claim, and so this goal, was declared. */
  acquiredTs?: string | null;
  /** `last_activity_ts` — the freshness signal `stale` is derived from. */
  lastActivityTs?: string | null;
  nowMs?: number;
}

/**
 * Project one holder. Returns null when there is NO holder — never a placeholder
 * row: a reader distinguishes "unheld" from "held by someone whose goal I cannot
 * read" (D-056), and the second case still yields a holder with an honest
 * `goalUnknown`. TOTAL by construction (P-026 rule f): no throw, no I/O, so it can
 * never fail the read it decorates.
 */
export function projectClaimHolder(input: ClaimHolderInput): ClaimHolder | null {
  const ownerId = (input.ownerId ?? '').trim();
  if (!ownerId) return null;
  const goal = declaredGoalOf(input.intent, input.itemId);
  return {
    ownerId,
    ownerLabel: input.ownerLabel?.trim() || null,
    ...goal,
    declaredAt: input.acquiredTs ?? null,
    stale: computeIntentStale(secAgo(input.lastActivityTs, input.nowMs ?? Date.now())),
  };
}

/** Seconds since a timestamp; null when absent or unparseable (⇒ `stale` unknown,
 *  not `false` — an unreadable activity stamp must never read as "fresh"). */
function secAgo(ts: string | null | undefined, nowMs: number): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

export { INTENT_STALE_SEC };
