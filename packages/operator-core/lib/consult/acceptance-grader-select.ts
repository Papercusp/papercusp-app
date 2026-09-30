/**
 * acceptance-grader-select.ts — router-driven grader DISCOVERY for the plan
 * acceptance gate (get-feedback-relevance-consults-2026-08-16, P-011 / D-009).
 *
 * The acceptance gate's grader-≠-implementer rule had an unsolved discovery
 * problem: WHO grades, concretely, was ad-hoc. Checkpoint #3 (after plan-start,
 * D-006 — earned because it replaces an existing mandatory ad-hoc step rather
 * than adding a ritual): route the plan + acceptance rubric through the P-002
 * relevance router with an EXCLUSION SET — implementers and heavy consult
 * participants on the plan's threads are excluded EVEN WHEN ABOVE-FLOOR
 * (independence outranks familiarity).
 *
 * ⚠ THE FLOOR ASYMMETRY IS GONE — SUPERSEDED, NOT SOFTENED.
 * unified-responder-selection-critique-and-grading-2026-08-30 D-002 [owner]
 * overturns D-009's grading half. D-009 held that for GRADING, WRONG or
 * CONFLICTED context is the disqualifier and a grader MUST exist, so below-floor
 * minted a FRESH session rather than settle for a confidently-stale grader
 * ("a fresh session agent is better than an agent with THE WRONG context").
 * That ruling is recorded here because it explains the code this module used to
 * contain — it is NOT the live policy. Grading now MINIMUM-FILLS exactly as a
 * consult does: the best-available below-floor candidate is selected, labelled
 * `via:'minimum'`, and woken with honest first-principles copy.
 *
 * D-002 states the cost plainly rather than denying it: a below-floor grader IS
 * the confidently-stale grader D-009 preferred to avoid. What makes it
 * acceptable is that grading is no longer n=1 — under this plan's D-001/D-003
 * the menu is bounded by the shared ACCEPTANCE_GRADING_POLICY (see
 * `selection-policies.ts` for the current min/max) and delivered as a
 * cascade, so a minimum-fill pick is normally a SECOND opinion arriving after
 * an above-floor grader, and P-004
 * makes the gate refuse to let a `via:'minimum'` card supersede an above-floor
 * one. Where no above-floor grader exists at all, this is a knowing regression
 * against D-009's intent.
 *
 * WHAT STILL MINTS FRESH: only an EMPTY menu. Nothing to select is not the same
 * epistemic state as selecting weakly — the embedder being unavailable
 * (relevance never measured) or a measured-empty non-excluded actor pool.
 * Deadness is NOT one of them (R-2 / D-013): grading dispatches rather than
 * wakes, so a candidate whose session ended is forked or converted from their
 * transcript exactly like a live one, and an all-dead pool yields a full menu.
 * No selectability gate is passed into the generic selector at all.
 *
 * THE MENU IS PARTY-DISTINCT, NOT ID-DISTINCT (D-008). `selectRanked` dedupes on
 * `ownerId`, which is a claim about strings; one agent can hold several
 * coordination identities (a rebind chain, a launcher and what it launched), and
 * a two-entry menu that is one party twice makes D-003's carried second opinion a
 * self-review the gate then ranks as better-informed. So the POOL is collapsed to
 * one candidate per party before selection — at the pool because
 * `routing.candidates` is what cascade-core's refill and revival legs extend the
 * menu from, and a menu-level fix would leave that path open.
 *
 * SELECTION ITSELF IS NOT WRITTEN HERE. The bounds come from the shared registry
 * (`selection-policies.ts`, key ACCEPTANCE_GRADING_POLICY) and the algorithm is
 * `@papercusp/ranked-selection` — the same two things the critique consult
 * reads (D-001 [owner]: neither step may carry its own copy of the policy).
 *
 * Deps-injected (route, sql) relevance-router style; the plan-acceptance-gate
 * wires the prod embedder + liveness oracle, mirroring get-feedback/plans:start.
 */
import type { Sql } from 'postgres';
import { selectRanked, selectionPolicy, type Selected } from '@papercusp/ranked-selection';
import { canonicalCoordRole } from '../agent-tools/coordination/roles';
import type { ConsultRouteParams, RouteResult, RoutingCandidate, RoutingSnapshot } from './relevance-router';
import { selectionSnapshot } from './relevance-router';
import { ACCEPTANCE_GRADING_POLICY } from './selection-policies';

export const GRADER_QUERY_MAX_CHARS = 4000;

export interface GraderSelectParams {
  workspaceId: string;
  planSlug: string;
  /** The plan's canonical content (query document half 1). */
  planContent: string;
  /** Rubric title + criteria prompts (query document half 2). */
  rubricText: string;
  /** Owners excluded beyond the computed set — the rubric author and the
   * shipper at minimum (the gate passes them). */
  extraExclusions?: Array<string | null | undefined>;
}

export interface GraderSelectDeps {
  getSql: () => Sql;
  /** The P-002 router, wired with sql + embedder + liveness oracle. */
  route: (params: ConsultRouteParams) => Promise<RouteResult>;
  /** Resolve the durable role for every routed owner in the plan workspace. */
  getCandidateRoles: (workspaceId: string, ownerIds: string[]) => Promise<ReadonlyMap<string, string | null>>;
  /**
   * Map every candidate to its PARTY key — one agent's several coordination
   * identities collapse to one key (D-008). Required, not optional: a consumer
   * that forgot to wire it would lose the independence guard silently, so the
   * type refuses to compile instead. `lineagePartyKeys` is the production impl.
   */
  getPartyKeys: (workspaceId: string, ownerIds: string[]) => Promise<ReadonlyMap<string, string>>;
}

/** One selected grader with the provenance of HOW it was selected. `via` is on
 * the record because P-004 has to be able to refuse a `'minimum'` card that
 * would otherwise supersede a `'floor'` one under latest-wins. */
export type SelectedGrader = Selected<RoutingCandidate>;

export interface GraderSelection {
  verdict: 'assigned' | 'fresh';
  /**
   * The ordered grader MENU (non-empty exactly when verdict is 'assigned').
   * CASCADE order, never a parallel-wake set: head is grader 1, and grader k+1
   * is woken only after k replies, declines or expires — carrying k's card
   * (D-003 [owner]). Bounded by the ACCEPTANCE_GRADING_POLICY registry entry,
   * not by a number written here.
   */
  graders: SelectedGrader[];
  /**
   * EXACTLY the routing snapshot to persist on the grading cascade's row — the
   * router's own snapshot with two deliberate adjustments:
   *
   *  - `selection` stamped with this menu's provenance (min/max + per-selectee
   *    via/score/liveness). It is the same `SnapshotSelection` record the
   *    critique consult persists, which is what lets cascade-core advance a
   *    grading cascade with no grading-specific parsing.
   *  - `candidates` narrowed to the COORD-CAPABLE eligible pool. cascade-core's
   *    post-exhaustion refill leg extends the menu from `candidates`, so
   *    persisting the router's unfiltered list would let a refill wake a
   *    principal that `coord:send` cannot reach — a grader selected here can
   *    never be one this module already refused.
   *
   * Absent when the menu is empty (verdict 'fresh'): there is no cascade.
   */
  routing?: RoutingSnapshot;
  /** The full exclusion set applied — the D-009 independence audit trail. */
  excluded: string[];
  /**
   * Candidates dropped because a better-ranked candidate resolved to the SAME
   * PARTY (D-008). Kept separate from `excluded`, which is the D-009 set and
   * means something different: these are not disqualified actors, they are
   * duplicate representations of an actor already on the menu.
   *
   * Present (possibly empty) whenever party resolution ran; ABSENT when the
   * lookup faulted and selection degraded to raw-ownerId distinctness — so a
   * reader can tell "no duplicates found" from "not checked", which an empty
   * array alone cannot say.
   */
  partyCollapsed?: string[];
  /**
   * What the router could measure after applying the independence exclusions.
   * `eligibleCount` is the known non-excluded actor pool; `qualifiedCount` is
   * the subset that cleared the semantic floors. Keeping both counts makes an
   * empty actor pool distinguishable from a populated pool whose context simply
   * did not qualify.
   */
  eligibility: GraderEligibility;
  /** A structured escalation for a measured empty non-excluded actor pool. */
  escalation?: GraderEscalation;
  /**
   * Why the menu came back EMPTY. Renamed from the pre-D-002 set on purpose:
   * the old `no_qualified_non_excluded` / `all_qualified_dead` were statements
   * about the QUALIFIED (above-floor) pool, because above-floor was the only
   * pool that could be selected from. Under minimum-fill the whole eligible
   * pool is selectable, so a name that still said "qualified" would describe a
   * condition that no longer causes a fresh mint at all.
   *
   * 'no_eligible_non_excluded' — measured, and the non-excluded actor pool is
   * empty (the `zero_eligible` escalation). 'degraded' — relevance was never
   * measured, so there is no ranking to fill from; see the branch comment at
   * the selection site. 'all_eligible_unselectable' is LEGACY-ONLY: it meant
   * "populated pool, every member dead", which stopped being a reason to mint
   * fresh when grading moved from waking to dispatch (D-013). Nothing produces
   * it now; rows written earlier still carry it, so readers must keep it.
   */
  freshReason?: 'no_eligible_non_excluded' | 'all_eligible_unselectable' | 'degraded';
}

export interface GraderEligibility {
  /** Number of known non-excluded candidates in the router snapshot. */
  eligibleCount: number;
  /** Number of known candidates that cleared both routing floors. */
  qualifiedCount: number;
  /** False when semantic qualification could not be measured. */
  measured: boolean;
  /** Present only when a measured route found no known non-excluded actor. */
  reason?: 'zero_eligible';
}

export interface GraderEscalation {
  /** No known non-excluded actor can perform either vetting or grading. */
  code: 'zero_eligible';
}

/**
 * Roles that must never be handed an acceptance-grading request. A `judge` is a
 * purpose-built grading principal; routing an acceptance grading to one is the
 * conflict this policy exists to prevent.
 */
const GRADER_INELIGIBLE_ROLES: ReadonlySet<string> = new Set(['judge']);

/**
 * Grader-eligibility by role. This is a DENYLIST, and the direction is
 * load-bearing (plan D-003).
 *
 * It used to be an ALLOWLIST over COORD_ROLES, on the premise that "coord:send
 * is role-gated by COORD_ROLES, so a candidate without a durable role cannot
 * receive the blocking grading request". Both halves of that premise are false:
 *
 *  - The grading request is NOT delivered by coord:send. `prodOpenGradingCascade`
 *    uses conversations.openConversation({ direct_to }) + notifyAgents — the same
 *    pair get-feedback-core binds in prod, and neither is role-gated. So role
 *    membership never predicted deliverability in the first place.
 *  - The role is read from harness_shared.coord_presence, which migration
 *    949-coord-presence-state-only-contract.sql defines as "a live, TTL-reaped
 *    projection" whose missing row "is not evidence that the owner was absent".
 *    A durable property cannot be read from it.
 *
 * Measured consequence of the allowlist: it rejected 100% of real candidates.
 * Across the WHOLE database coord_presence carries only agent_role='su' (38 rows,
 * absent from COORD_ROLES) and NULL (3) — so every candidate failed, every
 * discovery returned no_eligible_non_excluded, and the grading cascade never
 * opened once in 349 consults.
 *
 * Fail-OPEN is deliberate here. Because the source is TTL-reaped, neither
 * direction is reliable; the choice is between occasionally asking a judge to
 * grade (recoverable, and the party/implementer exclusions still apply) and
 * permanently disabling acceptance grading (what the allowlist actually did).
 * Reachability is enforced where it is actually knowable — the liveness gate in
 * `selectRanked` below.
 */
function isGraderEligibleRole(role: string | null | undefined): boolean {
  if (!role) return true;
  return !GRADER_INELIGIBLE_ROLES.has(canonicalCoordRole(role));
}

export function filterGraderEligibleCandidates(
  candidates: RoutingCandidate[],
  roles: ReadonlyMap<string, string | null>,
): RoutingCandidate[] {
  return candidates.filter((candidate) => isGraderEligibleRole(roles.get(candidate.ownerId)));
}

/**
 * Collapse two ranked pools to one candidate per PARTY (D-008).
 *
 * `selectRanked` dedupes on `ownerId`, which is a claim about strings, not about
 * agents. Since D-003 made the menu a min-1/max-2 cascade, two ownerIds of one
 * party would produce a "second opinion" that is that party reviewing its own
 * carried card — WI-905074's shape one level up. Collapsing here rather than
 * after selection is deliberate: `routing.candidates` is the pool cascade-core's
 * refill and revival legs extend the menu from, so a menu-level fix would leave
 * exactly that hole open.
 *
 * A party's representative prefers its best-ranked QUALIFIED member over its
 * best-ranked eligible one. Collapsing on eligible order alone could keep an
 * above-floor party's below-floor face and shrink the qualified pool, turning an
 * independence guard into an accidental floor demotion.
 *
 * Both inputs must be in ranked order; `qualified` is expected to be a subset of
 * `eligible`, as the router produces it.
 */
export function collapseToDistinctParties(
  eligible: RoutingCandidate[],
  qualified: RoutingCandidate[],
  partyKeys: ReadonlyMap<string, string>,
): { eligible: RoutingCandidate[]; qualified: RoutingCandidate[]; collapsed: string[] } {
  const partyOf = (candidate: RoutingCandidate) => partyKeys.get(candidate.ownerId) ?? candidate.ownerId;
  const representative = new Map<string, string>();
  for (const candidate of qualified) {
    const party = partyOf(candidate);
    if (!representative.has(party)) representative.set(party, candidate.ownerId);
  }
  for (const candidate of eligible) {
    const party = partyOf(candidate);
    if (!representative.has(party)) representative.set(party, candidate.ownerId);
  }
  const keep = new Set(representative.values());
  return {
    eligible: eligible.filter((candidate) => keep.has(candidate.ownerId)),
    qualified: qualified.filter((candidate) => keep.has(candidate.ownerId)),
    collapsed: eligible.filter((candidate) => !keep.has(candidate.ownerId)).map((c) => c.ownerId),
  };
}

/** The system-authored grader-discovery query: rubric first (the definition of
 * done IS what the grader must know), then the plan, capped. */
export function buildGraderQuery(planSlug: string, rubricText: string, planContent: string): string {
  const text = `acceptance grading for plan ${planSlug}\n\n${rubricText}\n\n${planContent}`;
  return text.length > GRADER_QUERY_MAX_CHARS ? text.slice(0, GRADER_QUERY_MAX_CHARS) : text;
}

/**
 * The D-009 exclusion set, computed mechanically:
 *  - IMPLEMENTERS: terminal_owner / taken_by of any work-item sourced from the
 *    plan (the fan-out population). `taken_by` IS the assignee: the
 *    harness_shared.engineer_issues VIEW exposes it as `taken_by AS assignee`,
 *    and the base table has no `assignee` column — querying one here threw
 *    `column "assignee" does not exist` on EVERY call, which is what kept the
 *    grading cascade from ever opening (plan D-001/D-002);
 *  - HEAVY CONSULT PARTICIPANTS on the plan's threads: every requester (they
 *    asked from inside the work), and responders whose thread actually carried
 *    content (active / closed_answered / graduated — a decline or no-show does
 *    NOT contaminate; "heavy" means they contributed, not that they were asked).
 * Thread scope: consult_state.origin_task_ref = the plan slug itself or any
 * work-item id sourced from the plan.
 */
export async function computeGraderExclusions(
  sql: Sql,
  workspaceId: string,
  planSlug: string,
  extra: Array<string | null | undefined> = [],
): Promise<string[]> {
  const rows = (await sql`
    SELECT DISTINCT x.owner FROM (
      SELECT terminal_owner AS owner FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND source_plan_slug = ${planSlug} AND terminal_owner IS NOT NULL
      UNION
      SELECT taken_by FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND source_plan_slug = ${planSlug} AND taken_by IS NOT NULL
      UNION
      SELECT cs.requester_id FROM harness_shared.consult_state cs
       WHERE cs.workspace_id = ${workspaceId}
         AND (cs.origin_task_ref = ${planSlug}
           OR cs.origin_task_ref IN (SELECT feature_id FROM harness_shared.work_items
                                      WHERE workspace_id = ${workspaceId} AND source_plan_slug = ${planSlug}))
      UNION
      SELECT cs.responder_id FROM harness_shared.consult_state cs
       WHERE cs.workspace_id = ${workspaceId}
         AND cs.responder_id IS NOT NULL
         AND cs.state IN ('active', 'closed_answered', 'graduated')
         AND (cs.origin_task_ref = ${planSlug}
           OR cs.origin_task_ref IN (SELECT feature_id FROM harness_shared.work_items
                                      WHERE workspace_id = ${workspaceId} AND source_plan_slug = ${planSlug}))
    ) x
    WHERE x.owner IS NOT NULL
  `) as unknown as Array<{ owner: string }>;
  const set = new Set<string>(rows.map((r) => r.owner));
  for (const e of extra) if (e) set.add(e);
  return [...set];
}

/**
 * Select the acceptance grader per D-009. Router verdicts are handled honestly
 * (a degrade is a fresh, not an error); infrastructure faults propagate — the
 * gate catches and falls back to its generic message (discovery is a service,
 * never a new failure mode for shipping).
 */
export async function selectAcceptanceGrader(
  params: GraderSelectParams,
  deps: GraderSelectDeps,
): Promise<GraderSelection> {
  const sql = deps.getSql();
  const excluded = await computeGraderExclusions(
    sql,
    params.workspaceId,
    params.planSlug,
    params.extraExclusions ?? [],
  );

  const route = await deps.route({
    workspaceId: params.workspaceId,
    // Synthetic requester: the gate itself asks, and no real owner carries this
    // id, so the router's requester exclusion excludes nobody real. The REAL
    // exclusions (implementers, participants, author, shipper) ride excludeOwners.
    requesterId: `acceptance-gate:${params.planSlug}`,
    question: buildGraderQuery(params.planSlug, params.rubricText, params.planContent),
    excludeOwners: excluded,
  });

  const candidateOwners = [...new Set(route.snapshot.candidates.map((candidate) => candidate.ownerId))];
  const candidateRoles = candidateOwners.length
    ? await deps.getCandidateRoles(params.workspaceId, candidateOwners)
    : new Map<string, string | null>();
  // Filter both pools. The router's qualified list is a subset of its
  // snapshot, but keeping the filtering explicit prevents a future router
  // change from allowing an incompatible candidate through the assignment
  // path while eligibility still counts the safe pool.
  const coordCapableEligible = filterGraderEligibleCandidates(route.snapshot.candidates, candidateRoles);
  const coordCapableQualified = filterGraderEligibleCandidates(route.qualified, candidateRoles);

  // D-008: distinct ownerIds are not distinct PARTIES. Collapse before anything
  // downstream counts, selects from, or persists these pools, so the menu, the
  // eligibility counts and the refill pool all describe the same party set.
  //
  // FAIL-SOFT, disclosed (D-008, matching D-007's read): a party-lookup fault
  // degrades to raw-ownerId distinctness — precisely the pre-D-008 behaviour —
  // rather than refusing every ship in the workspace on a transient PG fault.
  // `partyCollapsed` is then left ABSENT, so the degrade is legible instead of
  // looking like a clean "no duplicate parties found".
  let partyKeys: ReadonlyMap<string, string> | null = null;
  try {
    partyKeys = await deps.getPartyKeys(params.workspaceId, [
      ...new Set([...excluded, ...coordCapableEligible.map((candidate) => candidate.ownerId)]),
    ]);
  } catch {
    partyKeys = null;
  }
  // An exclusion names a PARTY, not merely one of its owner ids. The router
  // applies the raw ids before returning candidates; this second pass removes
  // a launched/rebound identity of an excluded implementer or vetting critic.
  // Put exclusions first in the party lookup so each excluded group receives
  // its excluded id as the stable key.
  const excludedParties = partyKeys ? new Set(excluded.map((ownerId) => partyKeys!.get(ownerId) ?? ownerId)) : null;
  const partyEligibleCandidates = excludedParties
    ? coordCapableEligible.filter(
        (candidate) => !excludedParties.has(partyKeys!.get(candidate.ownerId) ?? candidate.ownerId),
      )
    : coordCapableEligible;
  const partyQualifiedCandidates = excludedParties
    ? coordCapableQualified.filter(
        (candidate) => !excludedParties.has(partyKeys!.get(candidate.ownerId) ?? candidate.ownerId),
      )
    : coordCapableQualified;
  const partyExcluded = coordCapableEligible
    .filter((candidate) => !partyEligibleCandidates.includes(candidate))
    .map((candidate) => candidate.ownerId);
  const appliedExcluded = [...new Set([...excluded, ...partyExcluded])];
  const parties = partyKeys
    ? collapseToDistinctParties(partyEligibleCandidates, partyQualifiedCandidates, partyKeys)
    : null;
  const eligibleCandidates = parties?.eligible ?? partyEligibleCandidates;
  const qualifiedCandidates = parties?.qualified ?? partyQualifiedCandidates;
  const partyCollapsed = parties ? { partyCollapsed: parties.collapsed } : {};

  const eligibility: GraderEligibility = {
    eligibleCount: eligibleCandidates.length,
    qualifiedCount: qualifiedCandidates.length,
    measured: route.snapshot.degraded === undefined,
    ...(route.snapshot.degraded === undefined && eligibleCandidates.length === 0
      ? { reason: 'zero_eligible' as const }
      : {}),
  };
  const escalation: GraderEscalation | undefined = eligibility.reason ? { code: eligibility.reason } : undefined;

  // UNMEASURED is not below-floor. D-002 replaces below-floor fresh-mint with
  // minimum-fill, but a fill is a pick from a RANKING — with no embedder there
  // is no ranking to fill from, only an arbitrary row order. Minting fresh here
  // is the honest outcome, not a survival of the overturned asymmetry.
  if (route.snapshot.degraded === 'embed-unavailable' || route.verdict === 'relevance_unmeasured') {
    return {
      verdict: 'fresh',
      graders: [],
      excluded: appliedExcluded,
      ...partyCollapsed,
      eligibility,
      freshReason: 'degraded',
    };
  }

  // D-001 [owner]: bounds from the shared registry, algorithm from the shared
  // library. `qualifiedCandidates` are the above-floor picks; `eligibleCandidates`
  // is the full ranked non-excluded pool the minimum-fill reaches into.
  //
  // There is NO liveness gate (R-2 / D-013). There used to be, and it was right
  // while the grader was WOKEN: a dead session cannot be woken, so an honest
  // short menu beat a grader who could never answer. Acceptance grading now
  // DISPATCHES — the grader's transcript is forked or converted into a session
  // launched to grade — so deadness stops being unreachability, and skipping a
  // dead candidate would just hand the rubric to a worse-matched judge.
  //
  // ⚠ That equivalence is what makes removing the gate safe, and it is the
  // whole of it: if acceptance-grader.ts ever goes back to notifyAgents, this
  // gate has to come back in the SAME change or the cascade will queue wakes
  // nobody picks up while reporting an engaged grader.
  const bounds = selectionPolicy(ACCEPTANCE_GRADING_POLICY);
  const graders = selectRanked<RoutingCandidate>({
    qualified: qualifiedCandidates,
    allCandidates: eligibleCandidates,
    bounds,
    identity: (candidate) => candidate.ownerId,
  });

  if (graders.length === 0) {
    return {
      verdict: 'fresh',
      graders: [],
      excluded: appliedExcluded,
      ...partyCollapsed,
      eligibility,
      ...(escalation ? { escalation } : {}),
      // There is now exactly ONE empty menu: nobody eligible to ask. The policy
      // min is 1 and nothing is unselectable any more, so a non-empty eligible
      // pool always yields a grader — `all_eligible_unselectable` is no longer
      // producible here. It stays in the union because rows written before the
      // gate came out still carry it, and readers must keep handling it.
      freshReason: 'no_eligible_non_excluded',
    };
  }

  return {
    verdict: 'assigned',
    graders,
    routing: {
      ...route.snapshot,
      candidates: eligibleCandidates,
      selection: selectionSnapshot(bounds.min, bounds.max, graders),
    },
    excluded: appliedExcluded,
    ...partyCollapsed,
    eligibility,
  };
}
