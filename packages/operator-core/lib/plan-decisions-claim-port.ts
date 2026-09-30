/**
 * plan-decisions-claim-port.ts — surface a plan's governing Decisions at CLAIM
 * time (agent-trap-guards-2026-07-26 P-003b).
 *
 * Rationale (recorded live on the same plan, D-002): a leader ruling recorded
 * via `plans:add-decision` is auditable and re-readable — but only for an
 * agent who thinks to go look. A member who never re-reads the plan's
 * Decisions section before acting on a claimed item gets none of that benefit.
 * This port closes the gap the OTHER way: attach a compact brief of the
 * claimed item's plan's CURRENT decisions to the claim result itself, so seeing
 * the governing rulings costs zero extra round-trips — mirroring the existing
 * claim-time checkpoint hint (./work-item-checkpoint) and memory recall port
 * (./memory/claim-port), which attach at exactly the same seam for the same
 * reason.
 *
 * WIRED AT FOUR claim surfaces — `scheduler:get_next`, `work_items:claim`,
 * `work_items:claim_next`, and `plan_items:claim` (EI-19387745408924340, fixed
 * 2026-08-03; `plan_items:claim` added EI-19963837641363759, fixed 2026-08-09).
 * This header used to claim all three work-item surfaces while the port was
 * actually wired at `scheduler:get_next` ONLY, which stayed false long enough
 * to mislead a plan written against it (false-premise-in-prescriptive-artifacts-2026-08-02
 * P-001, whose item text asserted both surfaces inline the decisions brief).
 * `plan_items:claim` had the SAME gap for longer — it is the verb an su reaches
 * for directly after `coord:orient { planItems }`, i.e. squarely on the path
 * the persona recommends — and cost a real retracted finding (EI-19963837641363759).
 * The rendered `planDecisionsNote` text is shared verbatim across all four via
 * `renderPlanDecisionsNote` below, so it cannot drift the way the WIRING itself
 * just had — see each call site for its own fail-soft join into that surface's
 * parallel hint batch (checkpoint / prior-work / lane-collision / premises for
 * `claim`; the memory recall port for `claim_next`; nothing else for
 * `plan_items:claim`, which has no equivalent hint batch).
 *
 * Fail-soft by contract, like those two ports: a lookup miss, an unresolved
 * plan slug, or a parse error degrades to `null` — this is decoration on a
 * claim, never a new way for the claim path to fail.
 */
import { planSlugOfWorkItem } from './scheduler/claim-spec-match';
import type { WorkItem } from './work-items';
import { getPlanRow } from './agent-tools/plans/source';
import { parsePlan } from './agent-tools/plans/parser';
import { clampSnippet } from './agent-tools/coordination/ref-hydrate';
import { planDecisionRef } from './agent-goal-ref';

export interface ClaimTimePlanDecision {
  id: string;
  title: string;
  /** Bounded verbatim excerpt — `plans:get { slug, heading:'Decisions' }` (or
   *  mode:'full') for the complete body. */
  snippet: string;
  /** Present only for an inbound decision whose canonical home is another plan. */
  sourcePlanSlug?: string;
  /** Globally citable form for an inbound decision (`<plan>#D-NNN`). */
  ref?: string;
  relation?: 'affects';
}

export interface ClaimTimePlanDecisionsBrief {
  planSlug: string;
  /** The surfaced window — the `MAX_DECISIONS` most RECENT decisions, oldest-first
   *  within the window. May be shorter than `totalDecisions`. */
  decisions: ClaimTimePlanDecision[];
  /**
   * How many structured decisions the plan actually has. ALWAYS report this
   * alongside `decisions.length` — never describe the window as if it were the
   * whole set (EI-19396519606401168: the note was built from the post-slice
   * length and read as "this plan has 8 decisions" on a plan with 25, so a
   * claimer that had been handed a deferred item was told, in the same payload,
   * that it had seen the governing rulings).
   */
  totalDecisions: number;
  /** Total local decisions before the bounded authority window is selected. */
  totalLocalDecisions: number;
  /** Total current decisions on other plans whose canonical `affects` edge targets this plan. */
  totalAffectedDecisions: number;
  /** Number of affected-plan decisions included in `decisions`. */
  affectedDecisions: number;
  /** The reverse-authority read failed. Absence must not be interpreted as no inbound authority. */
  authorityReadFailed: boolean;
}

export interface ClaimTimeAffectedDecisionRow {
  planSlug: string;
  decisionId: string;
  title: string;
  body: string;
}

export interface ClaimTimeAffectedDecisionLookupResult {
  decisions: ClaimTimeAffectedDecisionRow[];
  totalDecisions: number;
}

export type ClaimTimeAffectedDecisionLookup = (scope: {
  workspaceId: string;
  harnessSlug: string;
  affectedPlanSlug: string;
  limit: number;
}) => Promise<ClaimTimeAffectedDecisionLookupResult>;

/** Per-decision excerpt cap — generous enough to read the ruling's substance
 *  inline without re-fetching for the routine case, bounded so a decision-heavy
 *  plan can't overflow the claim payload the same way plans:get's own
 *  DECISION_BODY_CAP bounds its `sections` mode. */
const SNIPPET_CHARS = 240;
/**
 * Cap on how many decisions ride the claim payload — a plan with more than this
 * has a decision LOG, not a short list of live rulings; the excess stays one
 * `plans:get` away.
 *
 * ⚠ WHICH end of the log we keep is the load-bearing part, and it used to be the
 * wrong one (EI-19396519606401168). `parsePlan().decisions` is in DOCUMENT order,
 * and `plans:add-decision` APPENDS — so document order is append order, oldest
 * first, and the original `slice(0, MAX_DECISIONS)` kept the eight STALEST
 * rulings and dropped everything after them.
 *
 * That is backwards for the job this port does. Decisions accumulate over a
 * plan's life, so the newest ones are precisely the ones that retarget, defer,
 * re-scope or refute an existing item — the rulings a claimer is most likely to
 * be about to violate. Measured on `no-http-anywhere-2026-07-28` (25 decisions):
 * the retained window was D-001..D-009, while D-022 — which explicitly defers
 * P-004/005/006 — sat at ordinal 21 and never surfaced, so an agent handed P-004
 * was told it had seen the governing decisions and started building.
 *
 * So: keep the most RECENT window, and always report `totalDecisions` so the
 * window is never mistaken for the whole set. A foundational early ruling that
 * falls out of the window is the acceptable trade — it is one `plans:get` away,
 * and the note now says so — whereas a missed SUPERSEDING ruling sends the
 * claimer to do work the plan has already ruled out.
 */
const MAX_DECISIONS = 8;

async function defaultAffectedDecisionLookup(scope: {
  workspaceId: string;
  harnessSlug: string;
  affectedPlanSlug: string;
  limit: number;
}): Promise<ClaimTimeAffectedDecisionLookupResult> {
  const { withWorkspace } = await import('@papercusp/db-org');
  const rows = await withWorkspace(scope.workspaceId, async (tx) =>
    tx<Array<{
      plan_slug: string;
      decision_id: string;
      title: string;
      body: string;
      total_count: number | string;
    }>>`
      SELECT d.plan_slug, d.decision_id, d.title, d.body,
             count(*) OVER ()::int AS total_count
        FROM harness_shared.plan_decisions d
       WHERE d.workspace_id = ${scope.workspaceId}
         AND d.harness_slug = ${scope.harnessSlug}
         AND d.plan_slug <> ${scope.affectedPlanSlug}
         AND ${scope.affectedPlanSlug} = ANY(COALESCE(d.affects, ARRAY[]::text[]))
       ORDER BY d.updated_at DESC, d.plan_slug ASC, d.seq DESC
       LIMIT ${scope.limit}
    `,
  );
  return {
    decisions: rows.map((row) => ({
      planSlug: row.plan_slug,
      decisionId: row.decision_id,
      title: row.title,
      body: row.body,
    })),
    totalDecisions: Number(rows[0]?.total_count ?? 0),
  };
}

/**
 * Resolve the CURRENT structured Decisions (`### D-NNN` entries — see
 * `@papercusp/plan-parser`) for the plan the just-claimed work-item — or plan
 * item — belongs to. Two ways to name the plan: pass `workItem` (the slug is
 * derived from its plan_item back-pointer, as before) OR pass `planSlug`
 * directly when the caller already knows it — e.g. `plan_items:claim`, whose
 * args ARE `{ plan, item }`, so deriving it from a work-item would be a
 * needless indirection through a record that may not even exist yet (a bare
 * plan-item claim mints no work_item at all). `planSlug` wins when both are
 * given. Returns `null` when: neither is resolvable, the plan slug doesn't
 * resolve to a row, or the plan has zero PARSED decisions (the common case
 * for most plans — must stay silent rather than noise every claim). An
 * informally-authored Decisions section (bare `- **D-NNN** ...` bullets
 * rather than the `### D-NNN` heading form) is NOT parsed here either — same
 * known limitation `plans:add-decision`'s id allocator already works around
 * for allocation; authoring decisions via `plans:add-decision` (rather than
 * hand-editing the plan body) keeps them in the structured, surfaced form.
 */
export async function getClaimTimePlanDecisions(opts: {
  workItem?: Pick<WorkItem, 'payload'>;
  planSlug?: string | null;
  harness?: string | null;
  workspaceId?: string | null;
  lookupAffectedDecisions?: ClaimTimeAffectedDecisionLookup;
}): Promise<ClaimTimePlanDecisionsBrief | null> {
  const planSlug = opts.planSlug ?? (opts.workItem ? planSlugOfWorkItem(opts.workItem as WorkItem) : null);
  if (!planSlug) return null;
  try {
    const row = await getPlanRow(planSlug, {
      ...(opts.harness ? { harnessSlug: opts.harness } : {}),
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    });
    if (!row) return null;
    const localDecisions = parsePlan(row.content).decisions;
    let affected: ClaimTimeAffectedDecisionLookupResult = { decisions: [], totalDecisions: 0 };
    let authorityReadFailed = false;
    try {
      const lookup = opts.lookupAffectedDecisions ?? defaultAffectedDecisionLookup;
      // A real PlanRow always carries both keys. The guard keeps old partial
      // unit fixtures from accidentally opening a database connection.
      if (row.workspaceId && row.harnessSlug) {
        affected = await lookup({
          workspaceId: row.workspaceId,
          harnessSlug: row.harnessSlug,
          affectedPlanSlug: row.planSlug || planSlug,
          limit: MAX_DECISIONS,
        });
      }
    } catch {
      authorityReadFailed = true;
    }

    const affectedRows = affected.decisions.slice(0, MAX_DECISIONS);
    const remainingLocalSlots = Math.max(0, MAX_DECISIONS - affectedRows.length);
    const localWindow = remainingLocalSlots > 0 ? localDecisions.slice(-remainingLocalSlots) : [];
    const decisions: ClaimTimePlanDecision[] = [
      ...affectedRows.map((d) => ({
        id: d.decisionId,
        title: d.title,
        snippet: clampSnippet(d.body, SNIPPET_CHARS),
        sourcePlanSlug: d.planSlug,
        ref: planDecisionRef(d.planSlug, d.decisionId),
        relation: 'affects' as const,
      })),
      ...localWindow.map((d) => ({
        id: d.id,
        title: d.title,
        snippet: clampSnippet(d.body, SNIPPET_CHARS),
      })),
    ];
    const totalAffectedDecisions = Math.max(affected.totalDecisions, affected.decisions.length);
    if (!decisions.length && !authorityReadFailed) return null;
    return {
      planSlug,
      // Cross-plan execution authority consumes the bounded window first;
      // remaining space carries the most recent local rulings.
      decisions,
      totalDecisions: totalAffectedDecisions + localDecisions.length,
      totalLocalDecisions: localDecisions.length,
      totalAffectedDecisions,
      affectedDecisions: affectedRows.length,
      authorityReadFailed,
    };
  } catch {
    return null;
  }
}

/**
 * Render the claim-time `planDecisionsNote` shown alongside `decisions` —
 * shared VERBATIM by every claim surface that wires this port
 * (scheduler:get_next, work_items:claim, work_items:claim_next) so the
 * wording cannot drift between them the way the wiring itself already had
 * (EI-19387745408924340: this port's own docstring claimed all three call it,
 * while only one did). Extracted from scheduler:get_next's inline copy —
 * behavior-identical, not a rewording.
 */
export function renderPlanDecisionsNote(brief: ClaimTimePlanDecisionsBrief): string {
  const authorityWarning = brief.authorityReadFailed
    ? `⚠ CROSS-PLAN AUTHORITY READ FAILED for plan '${brief.planSlug}'. Do NOT interpret missing affected-plan decisions as absence; retry the claim or read the source plans before relying on local checkpoint/carry prose. `
    : brief.totalAffectedDecisions > 0
      ? `⚠ CROSS-PLAN AUTHORITY CONFLICT/SUPERSESSION WARNING: ${brief.totalAffectedDecisions} current decision(s) on other plan(s) explicitly affect '${brief.planSlug}' and are listed BEFORE plan-local rulings. If one conflicts with or supersedes local checkpoint/carry prose, do not let the local prose silently win; resolve the source-qualified decision before acting. `
      : '';

  if (brief.totalAffectedDecisions > 0) {
    const omitted = brief.totalDecisions - brief.decisions.length;
    return authorityWarning +
      (omitted > 0
        ? `Showing ${brief.decisions.length} of ${brief.totalDecisions} governing decision(s), prioritized as affected-plan authority first and then the most recent local rulings; ${omitted} lower-priority/older decision(s) are NOT shown. Read full bodies from the source-qualified refs before concluding no ruling governs your item.`
        : `${brief.totalDecisions} governing decision(s) are included, ordered as affected-plan authority first and then plan-local rulings. Read every source-qualified affected decision before acting.`);
  }
  if (brief.authorityReadFailed && brief.totalDecisions === 0) return authorityWarning.trim();
  return brief.totalDecisions > brief.decisions.length
    ? authorityWarning + `Showing the ${brief.decisions.length} MOST RECENT of ${brief.totalDecisions} governing decision(s) on plan '${brief.planSlug}' — ${brief.totalDecisions - brief.decisions.length} older one(s) are NOT shown. Read before acting, and read the rest before concluding no ruling governs your item: plans:get { slug:'${brief.planSlug}', heading:'Decisions' }.`
    : authorityWarning + `${brief.totalDecisions} governing decision(s) recorded on plan '${brief.planSlug}' — read before acting; a ruling other lanes must follow lives here, not only in coord (plans:get { slug:'${brief.planSlug}', heading:'Decisions' } for full bodies).`;
}
