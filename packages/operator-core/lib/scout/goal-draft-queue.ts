/**
 * goal-draft-queue.ts — WI-39879 (plan blender-goal-amendment-rail-2026-08-19 P-001).
 *
 * THE QUESTION THIS ANSWERS: "what did the Blender propose before direct goal
 * creation was admitted, and what plan-hinted work would the live override call
 * goal-scale?" That was once unanswerable. `scout_routed_ideas` carried 1,682
 * rows and ZERO at `rail='goal'` (measured 2026-08-19, Jun 11 → Aug 18), because
 * the pre-D-016 intake never accepted the hint — so every argument about whether the
 * Blender should be allowed near goals was being made with no evidence at all.
 *
 * THE MECHANISM, and why it is this small: the evidence was almost already there.
 * `scout_cycle_stage_artifacts.proposals` has persisted full proposal content all
 * along; the only thing missing was the field saying which of those proposals were
 * goal-scale, which `parseProposal` recorded and then dropped one hop before the
 * Proposal was built (WI-39721 tallied it, but the tally died at the `recombine` port
 * boundary — the port is typed `=> Promise<Proposal[]>`, so the cycle never saw it and
 * the only trace was a console.warn). Carrying `droppedRouteHint` onto the Proposal
 * turned an existing artifact into the draft queue. This module is the READ side.
 *
 * ⚠ THIS MODULE WRITES NOTHING, BY CONSTRUCTION — that is its entire safety argument,
 * and it is enforced, not promised:
 *   • it issues exactly one SELECT and holds no write port;
 *   • it never imports a goals writer, so it CANNOT reach `goals:create`/`goals:update`;
 *   • the drafted rails come from {@link draftGoalRails}, a PURE function;
 *   • routing is untouched — a historically rejected proposal still took
 *     DEFAULT_ROUTING_RAIL when its cycle ran, and nothing here re-routes it.
 * `goal-draft-queue.test.ts` asserts each of those, including a fake-pg statement
 * recorder that fails on any non-SELECT. D-016 later admitted both direct goal
 * creation and amendments; this module remains a read-only historical/projection
 * surface and is NOT part of the write path.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import {
  GOAL_SCALE_MARKERS,
  draftGoalRails,
  goalScaleMarkerHits,
  makeGoalScaleOverride,
  proposalTitle,
  type GoalScaleMarkerHit,
} from './router';
import type { Proposal } from './types';

/** The rail whose starvation this queue exists to make readable. */
export const DEFAULT_DRAFT_RAIL = 'goal';

/**
 * HOW a proposal came to be goal-scale. Both are recorded, because they answer
 * different questions and only one of them is currently live.
 *
 * • 'asked'    — the MODEL explicitly asked for the goal rail and the pre-D-016
 *                intake coerced the hint away (`droppedRouteHint`). Measured
 *                2026-08-19: this had NEVER happened in the 30 retained cycles —
 *                every proposal carried an accepted hint — so a queue keyed on this
 *                alone read empty. New direct goal hints are accepted and routed,
 *                not represented as drafts.
 * • 'override' — the proposal was 'plan'-hinted AND matched the goal-scale vocabulary,
 *                so {@link makeGoalScaleOverride} WOULD bump it to the goal rail. This
 *                is the path that is actually live in production (cycle-deps.ts wires
 *                exactly this override, and BLENDER_GOAL_RAIL is default-ON).
 */
export type GoalDraftPath = 'asked' | 'override';

/**
 * One historical or override-projected goal draft. Direct post-D-016 goal hints are
 * routed live and therefore do not appear here as drafts.
 *
 * `killCriterion` and `budgetCents` are DRAFTED here at read time by the same pure
 * function the live goal rail would have used — they were never stored, because the
 * proposal never reached the rail. That is deliberate: it keeps the queue a pure
 * projection of what was actually recorded, with no second copy to drift.
 */
export interface GoalDraft {
  /** The cycle that produced it — joins to scout_ticks / scout_routed_ideas. */
  cycleId: string;
  /** When that cycle's artifacts landed. */
  createdAt: Date;
  /** How this became goal-scale — see {@link GoalDraftPath}. */
  path: GoalDraftPath;
  /** The rail the model asked for and did not get, verbatim. Null on the 'override'
   *  path, where the model asked for 'plan' and the vocabulary did the work. */
  askedRail: string | null;
  /** Which goal-scale markers the text matched ('override' path). Empty on 'asked'.
   *  Recorded because a marker like 'campaign' can match incidentally, and a reader
   *  deciding whether to trust this draft needs to see WHICH word triggered it.
   *  D-012 makes this BINDING: a reader shown a draft without its trigger word would
   *  read an incidental match as a genuine goal-scale ask. */
  matchedMarkers: string[];
  /** The same matches with their provenance — which FIELDS each marker appears in, and
   *  whether every occurrence sits inside a code-ish span. `fields:['mechanism']` +
   *  `onlyInCodeSpan:true` is D-012's measured false-positive shape, and is exactly what
   *  a reader needs to dismiss a draft without reading the whole proposal. */
  markerHits: GoalScaleMarkerHit[];
  /** The proposal's human title — first non-empty line of the framing, capped. */
  title: string;
  /** The full proposal as persisted, minus nothing. */
  proposal: Proposal;
  /** What the goal rail WOULD have set as the abandonment condition. */
  killCriterion: string;
  /** What the goal rail WOULD have set as the spend ceiling, in cents. */
  budgetCents: number;
}

/** One persisted stage-artifact row, narrowed to what this queue reads. */
export interface StageArtifactRow {
  cycle_id: string;
  created_at: Date | string;
  proposals: unknown;
}

const isProposal = (v: unknown): v is Proposal =>
  v != null && typeof v === 'object' && typeof (v as { framing?: unknown }).framing === 'string';

/**
 * PURE core: persisted stage-artifact rows → the drafts among them. No IO, no clock,
 * no writes — so a caller can assert the whole selection with fixtures and never touch
 * Postgres (scout invariant #5: assert behaviour without real writes).
 *
 * A row whose `proposals` is null, not an array, or full of malformed entries yields
 * nothing rather than throwing: the artifact store is BEST-EFFORT by contract
 * (stage-artifacts.ts), so a partial row must degrade to less evidence, never to an
 * exception on the read path.
 */
export function selectGoalDrafts(
  rows: readonly StageArtifactRow[],
  opts: {
    rail?: string;
    budgetCentsCap?: number;
    markers?: readonly string[];
    /** Count a marker that appears ONLY inside a code-ish span (P-009 / D-012). Default
     *  FALSE, matching live routing. Exists so the historical false positive stays
     *  reproducible as evidence — not as a production option. */
    includeCodeSpanMatches?: boolean;
  } = {},
): GoalDraft[] {
  const rail = opts.rail ?? DEFAULT_DRAFT_RAIL;
  const markers = opts.markers ?? GOAL_SCALE_MARKERS;
  const includeCodeSpans = opts.includeCodeSpanMatches === true;
  // Ask the REAL production override, not a reimplementation of it. If the live
  // bump rule changes (its hint domain, its predicate, its marker seam), this queue
  // follows automatically — a hand-copied condition here would drift silently and
  // report on a rule the router stopped using, which is the whole failure class
  // this plan is trying to measure its way out of.
  const wouldBump = makeGoalScaleOverride(markers, { includeCodeSpans });
  const drafts: GoalDraft[] = [];

  for (const row of rows) {
    if (!Array.isArray(row.proposals)) continue;
    for (const raw of row.proposals) {
      if (!isProposal(raw)) continue;

      const asked = raw.droppedRouteHint === rail;
      const overridden = !asked && wouldBump(raw) === rail;
      if (!asked && !overridden) continue;

      // Provenance comes from the SAME primitive the predicate above consulted, so the
      // markers a reader is shown are exactly the ones that were considered — never a
      // second, separately-computed list that can disagree with the routing decision.
      const hits = asked ? [] : goalScaleMarkerHits(raw, markers);
      const { killCriterion, budgetCents } = draftGoalRails(raw, {
        ...(opts.budgetCentsCap == null ? {} : { budgetCentsCap: opts.budgetCentsCap }),
      });

      drafts.push({
        cycleId: row.cycle_id,
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
        path: asked ? 'asked' : 'override',
        askedRail: asked ? (raw.droppedRouteHint ?? null) : null,
        matchedMarkers: hits.map((h) => h.marker),
        markerHits: hits,
        title: proposalTitle(raw),
        proposal: raw,
        killCriterion,
        budgetCents,
      });
    }
  }
  return drafts;
}

/**
 * Read the draft queue for a workspace, newest cycle first.
 *
 * The ONLY statement this module issues, and it is a SELECT. `limit` bounds CYCLES
 * read, not drafts returned — a cycle can contribute several drafts, and truncating
 * mid-cycle would silently under-report a burst, which is the shape of error this
 * queue exists to prevent.
 */
export async function readGoalDraftQueue(opts: {
  workspaceId?: string;
  rail?: string;
  budgetCentsCap?: number;
  /** Goal-scale vocabulary (the P-009 scout-config seam). Defaults to the live set. */
  markers?: readonly string[];
  /** Count a marker that appears ONLY inside a code-ish span (P-009 / D-012). Default
   *  FALSE, matching live routing. */
  includeCodeSpanMatches?: boolean;
  /** Max CYCLES scanned (default: the artifact store's full retention). */
  limit?: number;
} = {}): Promise<GoalDraft[]> {
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT cycle_id, created_at, proposals
      FROM harness_shared.scout_cycle_stage_artifacts
     WHERE workspace_id = ${ws}
       AND proposals IS NOT NULL
     ORDER BY created_at DESC
     LIMIT ${opts.limit ?? 30}`) as unknown as StageArtifactRow[];
  return selectGoalDrafts(rows, {
    ...(opts.rail == null ? {} : { rail: opts.rail }),
    ...(opts.budgetCentsCap == null ? {} : { budgetCentsCap: opts.budgetCentsCap }),
    ...(opts.markers == null ? {} : { markers: opts.markers }),
    ...(opts.includeCodeSpanMatches == null
      ? {}
      : { includeCodeSpanMatches: opts.includeCodeSpanMatches }),
  });
}
