/**
 * plan-start-consult.ts — the plan-start CHECKPOINT consult (plan
 * get-feedback-relevance-consults-2026-08-16, P-010 / D-006).
 *
 * plans:start (the moment plan items fan out into work items) is the first
 * CHECKPOINT consult: a wrong assumption in a plan multiplies across every item
 * and claiming agent, and "about to build what a peer already attempted" is
 * best caught before the fan-out. The existing plans:new similar_exists dedup
 * is only lexical; this runs the P-002 relevance router over the PLAN BODY
 * itself — a system-authored query (the plan is already the ideal query
 * document, which kills checkbox-prompt ritualization).
 *
 * Selection semantics (consult-min-max-and-rubric-vetting-2026-08-17 P-002,
 * superseding the predecessor plan's below-floor-proceeds-silently D-006):
 *   - What is REQUIRED is the ROUTING, not a wake — and per D-001 §2 the
 *     plan-step consult runs with min:1: a plan never promotes with zero
 *     feedback merely because nobody cleared the relevance threshold. The
 *     shared selectResponders (D-001 §1) picks floor-qualified candidates
 *     first, then fills to the minimum with the best-available candidate
 *     below the floor, labeled via:'minimum' (D-002 — labeled, never silent).
 *     Liveness enters NONE of that (D-002): a consult forks or converts the
 *     expert's TRANSCRIPT, so an `ended` session is a first-class candidate.
 *   - ANY selected candidate → `nudge` (the tool layer refuses ONCE with the
 *     labeled candidates + evidence, overridable with consulted:false + a
 *     stated reason — the proven similar_exists/force:true shape). Qualified
 *     candidates past the max ride along as evidence — their history still
 *     grounds the "someone attempted this" claim.
 *   - Nothing selectable: floor-qualified but every owner PAUSED (the one gate
 *     that survived D-002, and the one kind of unreachable a fork cannot route
 *     around — starting a session under a paused owner is the thing the pause
 *     means) → inject transcript EXCERPTS instead (retrieval, not consult) and
 *     proceed. Excerpts stay scoped to FLOOR-QUALIFIED candidates —
 *     below-floor evidence is never injected (precision).
 *   - The honest proceed survives only where the minimum is physically
 *     unfillable (D-003): a pool that only the owner-pause gate kept out →
 *     `all_responders_paused`; no pool at all / embedder down →
 *     `no_qualified_responder` (+ degraded).
 *   - NUDGE, never a hard block — plan-start must not be hostage to
 *     consult-thread latency. This module never opens a consult thread and
 *     never wakes anyone; it only routes and annotates.
 *
 * Deps are injected (route, getExcerpts) relevance-router-style so the core is
 * unit-testable with a stub route; `fetchTurnExcerpts` is the prod excerpt
 * reader the tool layer wires in. This module deliberately does NOT import the
 * embedder or the presence oracle — the tool layer (plans:start) wires both,
 * mirroring the get_feedback tool's wiring of routeConsult.
 */
import type { Sql } from 'postgres';
import type { ConsultRouteParams, RouteResult, RoutingCandidate, SnapshotSelection, TurnEvidence } from './relevance-router';
import { selectResponders, selectionSnapshot } from './relevance-router';
import { DEFAULT_MAX_RESPONDERS, DEFAULT_MIN_RESPONDERS } from './get-feedback-core';

/** Query cap: the embedder's model window is far smaller than a big plan body,
 * and the query-embed memo keys on the full text — cap keeps both bounded. */
export const PLAN_START_QUERY_MAX_CHARS = 4000;
/** Excerpt size per matched turn (mirrors the interest-watch excerpt cap). */
export const PLAN_START_EXCERPT_CHARS = 240;
/** Max transcript excerpts injected on the dead-context branch. */
export const PLAN_START_EXCERPTS_MAX = 6;

export interface PlanStartExcerpt {
  ownerId: string;
  session_id: string;
  turn_idx: number;
  ts: string | null;
  sim: number;
  excerpt: string;
}

export type PlanStartConsultOutcome =
  /** The min:1 minimum was physically unfillable (D-003) — the start
   * proceeds, annotated honestly: 'all_responders_paused' = a candidate pool
   * existed but the owner-pause gate kept every one of them out;
   * 'no_qualified_responder' = no pool at all (no match, or the embedder was
   * down → degraded). Liveness is NOT a partition here any more (D-002). */
  | {
      outcome: 'proceed';
      verdict: 'no_qualified_responder' | 'all_responders_paused';
      degraded?: 'embed-unavailable';
    }
  /** At least one selectable candidate — floor-qualified or best-available
   * minimum fill (D-001 §2 min:1). The tool layer refuses once with these
   * candidates + their evidence; `selection` carries the via:'floor'|'minimum'
   * provenance per selectee (D-002). `candidates` lists the selected set
   * first, then any qualified candidates past the max whose evidence still
   * grounds the "someone attempted this" claim. */
  | {
      outcome: 'nudge';
      candidates: RoutingCandidate[];
      selection: SnapshotSelection;
    }
  /** Floor-qualified candidates exist but every one's OWNER is paused, so no
   * session may be started from them — inject transcript excerpts (retrieval,
   * not consult) and proceed. */
  | {
      outcome: 'proceed_with_excerpts';
      candidates: RoutingCandidate[];
      excerpts: PlanStartExcerpt[];
    };

export interface PlanStartConsultParams {
  workspaceId: string;
  /** The starting agent — excluded from candidacy by the router. */
  requesterId: string;
  planSlug: string;
  /** The plan's canonical content blob (frontmatter + body) — the
   * system-authored query document. Capped here, callers pass it whole. */
  planContent: string;
}

export interface PlanStartConsultDeps {
  /** The P-002 router, already wired with sql + embedder + liveness oracle. */
  route: (params: ConsultRouteParams) => Promise<RouteResult>;
  /** Excerpt reader for the dead-context branch (prod: fetchTurnExcerpts). */
  getExcerpts: (refs: Array<{ ownerId: string; evidence: TurnEvidence[] }>) => Promise<PlanStartExcerpt[]>;
}

/** The system-authored query: the plan content itself, capped. Prefixed with
 * the slug so even a sparse draft body carries its identifying tokens. */
export function buildPlanStartQuery(planSlug: string, planContent: string): string {
  const text = `plan ${planSlug}\n\n${planContent}`;
  return text.length > PLAN_START_QUERY_MAX_CHARS ? text.slice(0, PLAN_START_QUERY_MAX_CHARS) : text;
}

/** The goal-kickoff query document (consult-min-max-and-rubric-vetting
 * 2026-08-17 P-010 / D-004 §1): the goal OUTLINE — outcome + kill criterion +
 * intended approach — capped by the same window as the plan query. */
export function buildGoalKickoffQuery(outline: {
  title: string;
  body?: string | null;
  killCriterion?: string | null;
}): string {
  const parts = [`goal ${outline.title}`];
  if (outline.body?.trim()) parts.push(outline.body.trim());
  if (outline.killCriterion?.trim()) parts.push(`Kill criterion: ${outline.killCriterion.trim()}`);
  const text = parts.join('\n\n');
  return text.length > PLAN_START_QUERY_MAX_CHARS ? text.slice(0, PLAN_START_QUERY_MAX_CHARS) : text;
}

/** Generic checkpoint-consult params: any door where a system-authored query
 * document is committed (plan promotion, goal kickoff). The subject-specific
 * wrappers below own the query building; this core owns the partition. */
export interface CheckpointConsultParams {
  workspaceId: string;
  /** The committing agent — excluded from candidacy by the router. */
  requesterId: string;
  /** The system-authored query document, already built + capped by the wrapper. */
  query: string;
}

/**
 * Route a checkpoint query and partition the verdict per P-002 (D-001 §2/
 * D-002/D-003). Never throws for routing verdicts (an honest degrade IS a
 * proceed); infrastructure faults (SQL down) do propagate — the tool layer
 * catches and proceeds, because a checkpoint nudge must never block the door
 * it guards.
 */
export async function checkpointConsult(
  params: CheckpointConsultParams,
  deps: PlanStartConsultDeps,
): Promise<PlanStartConsultOutcome> {
  const route = await deps.route({
    workspaceId: params.workspaceId,
    requesterId: params.requesterId,
    question: params.query,
  });

  // D-001 §1 selection with the GLOBAL min/max defaults (D-003: min 1 —
  // reused from get-feedback-core so plan-start can never drift from the
  // get_feedback semantics): floor-qualified candidates best-first, then
  // best-available fill labeled via:'minimum' (D-002).
  //
  // No liveness gate, for the same reason get-feedback-core dropped its one
  // (D-002): delivery forks or converts the expert's TRANSCRIPT, so an
  // `ended`/`recorded` session is no reason to pass over the best-matched
  // expert. The owner PAUSE gate is different in kind and stays.
  const selected = selectResponders({
    qualified: route.qualified,
    allCandidates: route.snapshot.candidates,
    min: DEFAULT_MIN_RESPONDERS,
    max: DEFAULT_MAX_RESPONDERS,
    isSelectable: (c) => c.ownerPaused !== true,
  });

  if (selected.length > 0) {
    const selection = selectionSnapshot(DEFAULT_MIN_RESPONDERS, DEFAULT_MAX_RESPONDERS, selected);
    // Stamp the provenance into the snapshot exactly as get_feedback does —
    // the D-003 honesty feed keeps floor-qualified vs minimum-fill
    // distinguishable wherever this route ends up recorded.
    route.snapshot.selection = selection;
    const picked = new Set(selected.map((s) => s.candidate.ownerId));
    // Qualified candidates the max left off the selected set ride along AFTER
    // it — their evidence still grounds the "someone attempted this" claim.
    // (This used to be the DEAD ones specifically; liveness no longer removes
    // anyone from the selection, so what is left over is simply the overflow.)
    const unselectedQualified = route.qualified.filter((c) => !picked.has(c.ownerId));
    return {
      outcome: 'nudge',
      candidates: [...selected.map((s) => s.candidate), ...unselectedQualified],
      selection,
    };
  }

  // Nothing selectable. Floor-qualified but every owner PAUSED → retrieval:
  // inject their transcript excerpts and proceed (excerpts stay scoped to
  // floor-qualified evidence — below-floor matches are never injected).
  if (route.qualified.length > 0) {
    const excerpts = await deps
      .getExcerpts(route.qualified.map((c) => ({ ownerId: c.ownerId, evidence: c.evidence })))
      .catch(() => [] as PlanStartExcerpt[]);
    return { outcome: 'proceed_with_excerpts', candidates: route.qualified, excerpts };
  }

  // The minimum was physically unfillable (D-003): distinguish a pool that
  // only the owner-pause gate kept out (all_responders_paused) from no pool at
  // all / a downed embedder (no_qualified_responder + degraded) — mirrors the
  // get_feedback reason partition. Liveness is gone from this partition with
  // the gate that produced it (D-002): an `ended` candidate is selectable, so
  // reaching here with a non-empty pool now means every owner was paused.
  return {
    outcome: 'proceed',
    verdict: route.snapshot.candidates.length > 0 ? 'all_responders_paused' : 'no_qualified_responder',
    ...(route.snapshot.degraded ? { degraded: route.snapshot.degraded } : {}),
  };
}

/**
 * Route the plan body and partition the verdict per P-002 (D-001 §2/D-002/
 * D-003) — the plans:start wrapper over checkpointConsult.
 */
export async function planStartConsult(
  params: PlanStartConsultParams,
  deps: PlanStartConsultDeps,
): Promise<PlanStartConsultOutcome> {
  return checkpointConsult(
    {
      workspaceId: params.workspaceId,
      requesterId: params.requesterId,
      query: buildPlanStartQuery(params.planSlug, params.planContent),
    },
    deps,
  );
}

export interface GoalKickoffConsultParams {
  workspaceId: string;
  /** The goal-mode agent committing the outline — excluded from candidacy. */
  requesterId: string;
  title: string;
  body?: string | null;
  killCriterion?: string | null;
}

/**
 * The GOAL-mode kickoff consult (consult-min-max-and-rubric-vetting
 * 2026-08-17 P-010 / D-004 §1): route the goal OUTLINE — outcome + kill
 * criterion + intended approach — through the same checkpoint partition the
 * plan-step consult uses. Inherits the global min:1 (D-003); same nudge-not-
 * gate posture; same honest proceed verdicts where the minimum is unfillable.
 */
export async function goalKickoffConsult(
  params: GoalKickoffConsultParams,
  deps: PlanStartConsultDeps,
): Promise<PlanStartConsultOutcome> {
  return checkpointConsult(
    {
      workspaceId: params.workspaceId,
      requesterId: params.requesterId,
      query: buildGoalKickoffQuery(params),
    },
    deps,
  );
}

/**
 * Prod excerpt reader: resolve the evidence turns' text from the same
 * transcript index the router matched over. Bounded — at most
 * PLAN_START_EXCERPTS_MAX rows, best-sim first, PLAN_START_EXCERPT_CHARS each.
 */
export async function fetchTurnExcerpts(
  sql: Sql,
  workspaceId: string,
  refs: Array<{ ownerId: string; evidence: TurnEvidence[] }>,
): Promise<PlanStartExcerpt[]> {
  const flat = refs
    .flatMap((r) => r.evidence.map((e) => ({ ownerId: r.ownerId, ...e })))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, PLAN_START_EXCERPTS_MAX);
  if (flat.length === 0) return [];

  const sessionIds = flat.map((f) => f.session_id);
  const turnIdxs = flat.map((f) => f.turn_idx);
  // (session_id, turn_idx) pairwise match via unnest — bounded to ≤ MAX rows.
  const rows = (await sql`
    SELECT t.session_id, t.turn_idx, t.owner,
           COALESCE(t.ts, t.ingested_at) AS ts,
           left(t.text, ${PLAN_START_EXCERPT_CHARS}) AS excerpt
      FROM harness_shared.session_turns t
      JOIN unnest(${sessionIds}::text[], ${turnIdxs}::int[]) AS want(session_id, turn_idx)
        ON t.session_id = want.session_id AND t.turn_idx = want.turn_idx
     WHERE (t.workspace_id = ${workspaceId} OR t.workspace_id = 'default')
  `) as unknown as Array<{
    session_id: string;
    turn_idx: number;
    owner: string | null;
    ts: string | Date | null;
    excerpt: string | null;
  }>;

  const textByKey = new Map(rows.map((r) => [`${r.session_id}\x00${r.turn_idx}`, r]));
  const out: PlanStartExcerpt[] = [];
  for (const f of flat) {
    const hit = textByKey.get(`${f.session_id}\x00${f.turn_idx}`);
    if (!hit || !hit.excerpt) continue;
    out.push({
      ownerId: f.ownerId,
      session_id: f.session_id,
      turn_idx: f.turn_idx,
      ts: f.ts,
      sim: f.sim,
      excerpt: hit.excerpt,
    });
  }
  return out;
}
