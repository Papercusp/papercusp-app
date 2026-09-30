/**
 * acceptance-grading-authority — which of several grading cards the acceptance
 * gate is entitled to read as THE grading
 * (unified-responder-selection-critique-and-grading-2026-08-30 P-004).
 *
 * WHY THIS EXISTS. Until D-002/D-003 of that plan, acceptance grading was n=1:
 * exactly one grader, so the gate's pick — `complete.filter(non-implementer)
 * .sort(desc createdAt)[0]` at `plan-acceptance-gate.ts` — had nothing to
 * choose between and its latest-wins ordering was inert. Two rulings changed
 * that together:
 *
 *  - D-003 [owner] made grading a CASCADE of up to two graders, where grader 2
 *    is woken holding grader 1's card. That is what makes latest-wins coherent
 *    rather than arbitrary: the latest card is also the most-informed one.
 *  - D-002 [owner] replaced the below-floor fresh-mint with MINIMUM-FILL, so
 *    the menu may contain a grader who did NOT clear the relevance floor,
 *    labelled `via:'minimum'`.
 *
 * Combined, they leave one residual that D-003 names explicitly: grader 2 can
 * be the below-floor pick, and unqualified latest-wins would then hand the
 * verdict to the less-qualified party. This module is that residual's fix — the
 * gate ranks by SELECTION AUTHORITY first (`outranks` from
 * `@papercusp/ranked-selection`, the generic kernel of "a below-floor
 * participant must not silently supersede a qualified one") and only then by
 * recency.
 *
 * TWO THINGS THIS MODULE IS DELIBERATE ABOUT.
 *
 * 1. THE DURABLE ROW IS THE AUTHORITY, NOT THE LIFECYCLE (D-006). `via` exists
 *    in two places: `AcceptanceGraderLifecycle.graders[].via`, which is a
 *    return value nobody persists, and `routing.selection.selected[].via` on
 *    the grading cascade's `harness_shared.consult_state` row, which survives
 *    the process that selected it. The gate runs long after selection — often
 *    in a different process entirely — so only the row can answer it.
 *
 * 2. UNKNOWN IS NOT 'minimum'. A card whose author appears in no grading
 *    cascade row — an owner-filed card, a card predating the cascade, a card
 *    from a hand-dispatched grader, or any card at all when the row read fails
 *    — is ranked as if it cleared the floor. Only a card KNOWN to have come
 *    from a below-floor fill may lose authority. The opposite default would let
 *    an unreadable row silently demote a legitimate grading and strand a
 *    shippable plan, which is the more expensive error and the harder one to
 *    diagnose.
 */
import { getOrgPg } from '@papercusp/db-org';
import { outranks, type SelectionVia } from '@papercusp/ranked-selection';
import { GRADING_CASCADE_FLAVOR } from './consult/grading-cascade';
// TYPE-ONLY (erased at build): keeps the derived RUBRIC_GRADING_AUTHORITIES union as the
// single source of truth without adding a runtime edge from lib/ into agent-tools/.
import type { RubricGradingAuthority } from './agent-tools/plans/rubric-template';

/** The `via` labels the selector emits. Anything else on a row is treated as
 * unknown rather than coerced — a future third label must be ranked
 * deliberately, not silently folded into one of these two. */
const KNOWN_VIA: ReadonlySet<string> = new Set<SelectionVia>(['floor', 'minimum']);

/**
 * Fold the persisted selection provenance of one or more grading cascade rows
 * into `graderOwnerId → via`. Pure: the caller supplies the routing snapshots.
 *
 * WHEN ONE GRADER APPEARS TWICE, THE BEST LABEL WINS. A re-grade after a reject
 * opens a second cascade over the same rubric, and a peer who cleared the floor
 * in one round can be a minimum-fill in another (the pool shrinks — D-006
 * records that answering a grading makes you an excluded heavy consult
 * participant for later rounds on the same plan). Demotion is a claim that must
 * be earned; a grader who cleared the floor in any round has earned the
 * opposite, so ambiguity resolves upward.
 */
export function graderSelectionVia(routingSnapshots: readonly unknown[]): Map<string, SelectionVia> {
  const byOwner = new Map<string, SelectionVia>();
  for (const routing of routingSnapshots) {
    const selected = (routing as { selection?: { selected?: unknown } } | null | undefined)?.selection?.selected;
    if (!Array.isArray(selected)) continue;
    for (const entry of selected) {
      const ownerId = (entry as { ownerId?: unknown } | null)?.ownerId;
      const via = (entry as { via?: unknown } | null)?.via;
      if (typeof ownerId !== 'string' || ownerId === '') continue;
      if (typeof via !== 'string' || !KNOWN_VIA.has(via)) continue;
      const current = byOwner.get(ownerId);
      if (current == null || outranks(via as SelectionVia, current)) byOwner.set(ownerId, via as SelectionVia);
    }
  }
  return byOwner;
}

/** How many grading cascade rows one rubric's authority read looks back over.
 * A rubric accumulates one row per grading round (open → graded → closed →
 * re-grade after a reject). Bounded because the map is only ever consulted for
 * authors of cards that are already in hand; a grader from an eighth-round-ago
 * cascade whose card still stands is a shape nothing else in the gate survives
 * either. */
export const GRADING_CASCADE_AUTHORITY_LOOKBACK_ROWS = 8;

/**
 * Read the durable selection provenance for a rubric's grading cascade(s).
 *
 * ⚠ DELIBERATELY DOES NOT FILTER `closed_at IS NULL`, unlike the two other
 * readers of these rows (`prodOpenGradingCascade`'s idempotency probe and
 * `advanceGradingCascadeOnCard`, both in `acceptance-grader.ts`). Those two ask
 * "is a cascade LIVE?" and must ignore finished ones. This asks "how was the
 * author of this card selected?", and by the time the gate runs the cascade has
 * usually done its job and closed. Copying the liveness predicate here would
 * make the map empty in exactly the common case, and — because unknown ranks as
 * 'floor' — the failure would present as the gate silently reverting to the
 * pre-P-004 latest-wins it was built to replace, with nothing red anywhere.
 *
 * FAIL-SOFT. A read fault yields an empty map, which ranks every card as
 * floor-qualified: the pre-P-004 behaviour. That is the status quo rather than
 * a new hazard, and it is the right direction for a gate whose other failure
 * mode is refusing every ship in the workspace over a transient database fault.
 */
export async function readGraderSelectionVia(
  workspaceId: string,
  rubricId: string,
): Promise<Map<string, SelectionVia>> {
  try {
    const { sql } = getOrgPg();
    const rows = (await sql`
      SELECT routing
        FROM harness_shared.consult_state
       WHERE workspace_id = ${workspaceId}
         AND routing -> 'cascade' ->> 'flavor' = ${GRADING_CASCADE_FLAVOR}
         AND routing -> 'cascade' ->> 'rubricId' = ${rubricId}
       ORDER BY created_at DESC
       LIMIT ${GRADING_CASCADE_AUTHORITY_LOOKBACK_ROWS}
    `) as unknown as Array<{ routing: unknown }>;
    return graderSelectionVia((rows ?? []).map((r) => r?.routing));
  } catch {
    return new Map();
  }
}

/** A grading card, reduced to what ranking needs. */
export interface RankableGrading {
  createdBy?: string | null;
  createdAt: string;
}

/**
 * Order grading cards by the authority of HOW their author was selected, then
 * by recency — the comparator behind the gate's pick.
 *
 * `outranks` is the kernel rather than an inline `via === 'minimum'` test on
 * purpose: the rule "a below-floor participant must not silently supersede a
 * qualified one" is owned by `@papercusp/ranked-selection` alongside the label
 * it ranks, so a third `via` gains its ordering in one place instead of in
 * every consumer that thought it knew the whole union.
 */
export function compareGradingAuthority<T extends RankableGrading>(
  viaOf: (card: T) => SelectionVia | null,
): (a: T, b: T) => number {
  return (a, b) => {
    // Unknown ranks with 'floor': see this module's header — only a card KNOWN
    // to be a below-floor fill is demoted.
    const va = viaOf(a) ?? 'floor';
    const vb = viaOf(b) ?? 'floor';
    if (outranks(va, vb)) return -1;
    if (outranks(vb, va)) return 1;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  };
}

/**
 * The one grading card no other card outranks — the gate's `independent` pick.
 * Returns `undefined` for an empty list, mirroring the `[0]` it replaces.
 */
export function pickAuthoritativeGrading<T extends RankableGrading>(
  cards: readonly T[],
  viaOf: (card: T) => SelectionVia | null,
): T | undefined {
  return cards.slice().sort(compareGradingAuthority(viaOf))[0];
}

/** Resolve one card's selection provenance against a map from
 * {@link readGraderSelectionVia}. `null` means "not attributable to a cascade
 * selection", which ranks as floor and is reported as such — never asserted to
 * BE floor. */
export function gradingViaOf(
  card: RankableGrading,
  byOwner: ReadonlyMap<string, SelectionVia>,
): SelectionVia | null {
  return (card.createdBy != null ? byOwner.get(card.createdBy) : undefined) ?? null;
}

// ───────────────────────────────────────────────────────────────────────────
// Is this grading SETTLED? (WI-1699998)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The scorecard fields a settlement verdict reads. Structural on purpose:
 * `ScorecardRow` satisfies it, and stating the five fields here keeps this
 * module from importing the scorecard surface just to name a shape.
 */
export interface SettlementCard {
  issueId: string;
  /** False when the rubric could not be resolved — `missingKeys` is then meaningless. */
  rubricResolved: boolean;
  missingKeys: readonly string[];
  synthesized: boolean;
  supersededBy?: string;
  /** The rubric's plan-row revision at emit. Absent on pre-P-004 historical cards. */
  rubricRevision?: number;
  /** Present only on the rubric AUTHOR's post-grading verdict (enforced by scorecards:emit). */
  acceptance?: unknown;
}

/**
 * Why a grading is (or is not) settled. Every non-`settled` reason is a reason to
 * DISPATCH — the read fails open, because suppressing a needed grading strands a
 * plan permanently while a redundant dispatch merely costs a wake.
 */
export type AcceptanceGradingSettlementReason =
  | 'settled'
  | 'revision_unreadable'
  | 'scorecards_unreadable'
  | 'no_independent_card'
  /** Every complete independent card on the live revision is one the ship gate's BAR
   * judged cohort-stale (WI-10003286). The gate refuses `self_graded_only` and asks
   * for a FRESH grading, so treating that card as settled would make every retry a
   * no-op: the gate says re-grade while the recruiter says done. */
  | 'stale_independent_card'
  /** The recruiter was invoked by a ship-gate refusal (`self_graded_only` /
   * `acceptance_ungraded`). The gate already ran the identity resolution this read
   * deliberately skips and found NO admissible independent grading, so the read is not
   * consulted: its weaker "no author verdict ⇒ independent" predicate would count a card
   * the gate excluded (an implementer/author card, or an older cohort-stale one) and
   * report settled, suppressing the very grading the gate asked for (WI-10003286). */
  | 'gate_found_no_admissible_grading'
  | 'no_author_acceptance'
  /** The settlement read itself threw past its own handlers — recorded rather than
   * swallowed, so a dispatch that happened because the guard could not run is
   * distinguishable from one that happened because nothing was graded yet. */
  | 'read_threw';

export interface AcceptanceGradingSettlement {
  settled: boolean;
  reason: AcceptanceGradingSettlementReason;
  /** The revision the verdict was computed AT (absent when the revision was unreadable). */
  rubricRevision?: number;
  independentCardId?: string;
  acceptanceCardId?: string;
}

/**
 * Is this rubric's acceptance grading already SETTLED at its CURRENT revision?
 *
 * WHY THIS IS NOT `evaluatePlanAcceptanceGate` (the whole point of the helper).
 * The obvious implementation is "skip when the ship gate is satisfied", and it is
 * wrong in exactly the case that produced WI-1699998. The gate answers *can this
 * plan ship*; a standing author REJECT makes it answer `satisfied:false` while the
 * grading is completely settled — an independent grader graded it and the author
 * ruled on it. Re-dispatching there re-routes a decided question to a fresh grader
 * and burns them: D-009 independence makes the eligible pool non-replenishable, so
 * the waste compounds until a plan has no eligible graders left. The predicate we
 * need is *is this grading DECIDED*, and it must be verdict-agnostic.
 *
 * WHY NO IDENTITY RESOLUTION. The gate needs `isImplementerScorecard` (and its
 * lineage walk) because it must decide which card is INDEPENDENT. This read does
 * not: `scorecards:emit` refuses an `acceptance` block from anyone but the rubric
 * author, and refuses it again unless a complete independent grading already
 * exists (emit.ts — "acceptance must follow a complete independent grading by
 * someone other than …"). So a standing complete card carrying `acceptance` IS the
 * author's call, and its existence already implies the independent half. Requiring
 * both halves explicitly is the belt to that braces: it can only make the skip
 * stricter, never looser.
 *
 * WHY REVISION-SCOPED. A settled grading must be able to REOPEN, and the only
 * machine-readable reopen signal is the rubric revision — bump it and the cards
 * pinned to the old one stop counting. A standing reject states its own
 * supersession condition in prose, which nothing here can evaluate, so revision
 * scoping is the defensible line. A card with no `rubricRevision` (historical)
 * never equals a live revision and therefore never suppresses a dispatch.
 *
 * FAIL-OPEN, DELIBERATELY. An unreadable revision or scorecard read reports
 * `settled:false` with the reason naming which read failed, rather than guessing.
 */
export async function readAcceptanceGradingSettlement(
  rubricId: string,
  deps: {
    listScorecards?: (filter: { rubricRef: string; limit: number }) => Promise<readonly SettlementCard[]>;
    readRubricPlanRevision?: (rubricId: string) => Promise<{ ok: boolean; revision: number | null }>;
  } = {},
  opts: {
    /** Scorecard ids the ship gate's acceptance BAR judged cohort-stale (its
     * `staleGradingScorecardId`). Revision scoping cannot see an evidence-cohort move,
     * so without this a stale grading reads as settled and suppresses the very
     * re-grade the gate is asking for (WI-10003286). */
    staleCardIds?: readonly string[];
  } = {},
): Promise<AcceptanceGradingSettlement> {
  const readRevision =
    deps.readRubricPlanRevision ?? (async (id: string) => (await import('./rubrics')).readRubricPlanRevision(id));
  const listCards =
    deps.listScorecards ??
    (async (filter: { rubricRef: string; limit: number }) =>
      (await import('./scorecards')).listScorecards(filter) as Promise<readonly SettlementCard[]>);

  let revision: number | null;
  try {
    const read = await readRevision(rubricId);
    revision = read.ok ? read.revision : null;
  } catch {
    revision = null;
  }
  // An unversioned rubric and a failed read are both `null` here, and both mean the
  // same thing for this decision: there is no revision to scope a skip to.
  if (revision == null) return { settled: false, reason: 'revision_unreadable' };

  let cards: readonly SettlementCard[];
  try {
    cards = await listCards({ rubricRef: rubricId, limit: 50 });
  } catch {
    return { settled: false, reason: 'scorecards_unreadable', rubricRevision: revision };
  }

  // Same completeness predicate the ship gate uses (plan-acceptance-gate.ts), plus
  // the revision pin. `supersededBy` is filtered here as well as by the default
  // read, so the predicate stays correct if a caller ever passes includeSuperseded.
  const complete = cards.filter(
    (c) =>
      c.rubricResolved &&
      c.missingKeys.length === 0 &&
      !c.synthesized &&
      !c.supersededBy &&
      c.rubricRevision === revision,
  );
  const stale = new Set((opts.staleCardIds ?? []).filter((id) => typeof id === 'string' && id.trim()));
  const independents = complete.filter((c) => c.acceptance == null);
  const independent = independents.find((c) => !stale.has(c.issueId));
  const authorCall = complete.find((c) => c.acceptance != null);
  if (!independent) {
    return {
      settled: false,
      reason: independents.length > 0 ? 'stale_independent_card' : 'no_independent_card',
      rubricRevision: revision,
    };
  }
  if (!authorCall) return { settled: false, reason: 'no_author_acceptance', rubricRevision: revision };
  return {
    settled: true,
    reason: 'settled',
    rubricRevision: revision,
    independentCardId: independent.issueId,
    acceptanceCardId: authorCall.issueId,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * WHO MAY GRADE — resolved from the RUBRIC, never inferred by the caller.
 *
 * generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20 D-002 (the rubric
 * is the authority boundary) + D-001 (platform behavior is generic — no per-goal
 * branch). Before this, independence was HARDCODED: the ship gate's only branch
 * demanded a non-implementer, so `independent` was correct by accident (it was the
 * sole possibility) and `owner-authorized` did not exist at all.
 *
 * These three helpers are PURE on purpose, matching this module's existing contract
 * ("Pure: the caller supplies the routing snapshots"). In particular the OWNER's
 * identity is a PARAMETER, not an import: the one verified owner-authority predicate
 * in this repo is `ident.ownerId === ADMIN_COORD_UI_OWNER` (identity.ts:213, used by
 * mode/set.ts, plans/set-property.ts, goals/set-property.ts), and it is the CALLER
 * that holds a resolved identity. Keeping it out of here also keeps this lib module
 * free of an agent-tools runtime import, and keeps every branch here unit-testable
 * without a database or a session.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The plan's declared grading authority, read from its own rubric.
 *
 * FAIL-CLOSED BY CONSTRUCTION: an explicit equality test against the one widening
 * value, never `rubric.gradingAuthority ?? 'independent'`. Any absent, legacy, typo'd
 * or future value therefore lands on `independent` — the stricter branch. A `??`
 * default only catches `null`/`undefined` and would pass an unrecognized string
 * straight through to a comparison that silently fails to match, which reads as
 * "independence not required" at exactly the seam where being wrong admits a
 * self-graded plan.
 */
export function rubricGradingAuthority(
  rubric: { gradingAuthority?: RubricGradingAuthority | null | undefined } | null | undefined,
): RubricGradingAuthority {
  return rubric?.gradingAuthority === 'owner-authorized' ? 'owner-authorized' : 'independent';
}

/**
 * Was this grading filed by the OWNER (via the admin coord UI, which
 * `resolveAgentIdentity` ties to a route-synthesized client id that an ordinary agent
 * context can never supply — so this is tool-layer-VERIFIED provenance, not a claim)?
 *
 * `ownerAuthorityId` is supplied by the caller; pass `ADMIN_COORD_UI_OWNER`.
 */
export function isOwnerFiledGrading(
  card: { createdBy?: string | null | undefined },
  ownerAuthorityId: string,
): boolean {
  return card.createdBy != null && card.createdBy !== '' && card.createdBy === ownerAuthorityId;
}

/**
 * Does the plan's declared authority ADMIT this card as its acceptance grading?
 *
 * `owner-authorized` WIDENS, it never replaces: an independent grading always
 * qualifies under either authority. The material difference is that an owner-filed
 * card is admitted even when the owner sits INSIDE the implementer lineage — the case
 * a plan the owner drove themselves could otherwise never satisfy, because every
 * non-implementer predicate correctly excludes them.
 *
 * Under `independent` an owner-filed card is NOT specially admitted — it does not need
 * to be, since an owner outside the implementer lineage already passes `isIndependent`.
 * That is what keeps this change non-breaking for the existing refusal text ("A
 * different agent or the owner must file the grading scorecard").
 */
export function gradingAuthorityAdmits(input: {
  authority: RubricGradingAuthority;
  isIndependent: boolean;
  isOwnerFiled: boolean;
}): boolean {
  if (input.isIndependent) return true;
  return input.authority === 'owner-authorized' && input.isOwnerFiled;
}
