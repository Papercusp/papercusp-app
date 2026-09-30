/**
 * placement-ranker — the ONE ranker for the Mug's placement domain
 * (queen-autonomous-execution-2026-06-13 B-08 / P-011, honoring D-004 + D-005).
 *
 * The Mug prioritizes across TWO views of one source (autonomy-policy D-013):
 *   - the PLAN-ITEM Queue (which started plan to pour cups into, pre-`plan_items:convert`)
 *   - the WORK-ITEM dispatch frontier (which ready work-item to place, post-convert)
 * Both are ranked HERE, by one registry, never a second ranker. We reuse the
 * FB-12 engine (lib/queue-ranker — `rankQueue`, the generic weighted-feature
 * core) and consume consume-edges B-08's blocking-impact module
 * (`BLOCKING_IMPACT_WEIGHTS` + `stalenessMultiplier`) — the scoring semantics
 * live there and only there; this file assembles the placement feature set.
 *
 * A `PlacementCandidate` is the unified shape both views map onto, so the SAME
 * features score a started plan and a ready work-item:
 *
 *   score(candidate) = Σ feature.weight × feature.value(candidate)
 *
 * Four named features (B-08): plan-importance, blocking-impact, staleness
 * (the P-031 anti-starvation aging lever), and escalation-pressure. Every
 * weight is an exported tunable; every ranked candidate carries its full
 * per-feature `rank` breakdown so "why does this plan/item rank here?" is
 * answerable from the data itself.
 *
 * Pure given inputs: features read fields already resolved onto the candidate
 * by the survey (lib/pot/survey.ts) — no IO in the hot path, so a ranking
 * pass never fails on a flaky read.
 */
import { IMPORTANCE_LEVELS, type Importance } from '@papercusp/plan-parser';
import {
  BLOCKING_IMPACT_WEIGHTS,
  stalenessMultiplier,
} from '../harness/improvements/blocking-impact';
import {
  describeFeatures,
  rankQueue,
  type FeatureValue,
  type QueueFeature,
  type Ranked,
} from '../queue-ranker';

/** Which of the two D-013 views a candidate came from. */
export type PlacementView = 'plan' | 'work-item';

/**
 * The unified placement unit. A started plan and a ready work-item both map
 * onto this so one feature registry ranks both views (D-004). Every signal
 * field is optional and degrades to its no-op (0 / 'normal') — a candidate
 * carrying only `{ id, view, harness, title }` ranks cleanly at the floor.
 */
export interface PlacementCandidate {
  /** Stable key: plan slug (view='plan') or work-item id (view='work-item'). */
  id: string;
  view: PlacementView;
  /** The member harness this plan/item belongs to. */
  harness: string;
  /**
   * The HOME pot slug this candidate's harness belongs to (P-001's source-pot
   * tag, resolved via the registry `hive_slug`). Set ONLY by the workspace-scoped
   * cross-pot survey (surveyWorkspace, WORKSPACE_COORDINATION ON) so the central
   * dispatcher can group + ROUTE placements onto the right pot's cups. Absent in
   * the per-pot (flag-OFF) survey — there is one pot, so the tag is implicit.
   */
  pot?: string;
  title: string;
  /** Plan/item importance (urgent..low). Default 'normal'. */
  importance?: Importance;
  /** Days since last activity — drives staleness/anti-starvation aging. */
  ageDays?: number;
  /** Manual op_priority steer (lower = sooner); the tie-breaker, not a feature. */
  opPriority?: number | null;
  /** Explicit downstream `blocks` out-edges (work this candidate gates). */
  blocksOut?: number;
  /** Inbound reference edges (other objects pointing at this candidate). */
  inboundRefs?: number;
  /** Issue/work-item severity prior (a critical item gates more). */
  severity?: 'critical' | 'major' | 'minor' | 'nit' | null;
  /** Open escalations / needs-human items waiting on this candidate. */
  escalations?: number;
  /** Plan view: open (todo/wip) item count — frontier depth, surfaced as
   *  placement capacity metadata (not a scoring feature). */
  openItems?: number;
  /** Plan view: surfaced as owner-eligible but NOT yet operationally started
   *  (mug-autonomy-and-selffeed C-1) — the Mug must start + decompose it
   *  before placing its work, vs an already-running plan. Metadata, not a
   *  scoring feature. Absent/false ⇒ a normal (started) candidate. */
  needsStart?: boolean;
}

/**
 * Context for placement features. Empty today — every feature scores off the
 * candidate's own pre-resolved fields. Typed (not removed) so a future injected
 * signal (e.g. live link degrees) lands without changing the feature shape.
 */
export type PlacementRankContext = Record<string, unknown>;

type PlacementFeature = QueueFeature<PlacementCandidate, PlacementRankContext>;

/** Importance → numeric value (most → least), derived from the canonical order. */
const IMPORTANCE_VALUE: Record<Importance, number> = Object.fromEntries(
  // IMPORTANCE_LEVELS is most→least urgent; map to descending integer values.
  IMPORTANCE_LEVELS.map((level, i) => [level, IMPORTANCE_LEVELS.length - 1 - i]),
) as Record<Importance, number>;

function sevWeight(sev: PlacementCandidate['severity']): number {
  if (!sev) return 0;
  return BLOCKING_IMPACT_WEIGHTS.severity[sev] ?? 0;
}

/**
 * Exported tunable weights for the placement ranker (B-08). One unit ≈ "one
 * minor thing waiting on this". Adjust from evidence, not by redesign.
 */
export const PLACEMENT_WEIGHTS = {
  /** Plan/item importance — the primary "which plan matters" signal (P-010). */
  importance: 4,
  /** Downstream blocking cost (reuses consume-edges B-08's per-edge weights). */
  blockingImpact: 1,
  /** Anti-starvation aging (P-031): how much a long-unplaced item self-promotes. */
  staleness: 3,
  /** Escalation/needs-human pressure waiting on this candidate. */
  escalationPressure: 5,
} as const;

/** Feature 1 — plan/item importance (P-010's "which plan to pour cups into"). */
const importanceFeature: PlacementFeature = {
  name: 'plan-importance',
  weight: PLACEMENT_WEIGHTS.importance,
  description:
    'Declared importance of the plan (its hottest open item) or work-item (urgent..low) — the primary "which plan matters" placement signal (B-08/P-010).',
  score(items) {
    const out = new Map<string, FeatureValue>();
    for (const it of items) {
      const imp = it.importance ?? 'normal';
      const value = IMPORTANCE_VALUE[imp] ?? IMPORTANCE_VALUE.normal;
      out.set(it.id, {
        value,
        reasons: imp !== 'normal' ? [`${imp} importance`] : [],
      });
    }
    return out;
  },
};

/**
 * Feature 2 — blocking impact: downstream cost of leaving this unplaced.
 * Reuses consume-edges B-08's tunable per-edge weights (blocks out-edges,
 * inbound references, severity prior) — the semantics stay owned by
 * harness/improvements/blocking-impact.ts.
 */
const blockingImpactFeature: PlacementFeature = {
  name: 'blocking-impact',
  weight: PLACEMENT_WEIGHTS.blockingImpact,
  description:
    'Downstream cost of leaving this unplaced: `blocks` out-edges, inbound references, severity prior — consuming consume-edges B-08 per-edge weights.',
  score(items) {
    const W = BLOCKING_IMPACT_WEIGHTS;
    const out = new Map<string, FeatureValue>();
    for (const it of items) {
      const blocksOut = it.blocksOut ?? 0;
      const inboundRefs = it.inboundRefs ?? 0;
      const sev = sevWeight(it.severity);
      const value = W.blocksOut * blocksOut + W.inboundRef * inboundRefs + sev;
      const reasons: string[] = [];
      if (blocksOut > 0) reasons.push(`blocks ${blocksOut} downstream item(s)`);
      if (inboundRefs > 0) reasons.push(`${inboundRefs} inbound reference(s)`);
      if (it.severity === 'critical' || it.severity === 'major') reasons.push(`${it.severity} severity`);
      out.set(it.id, { value, reasons });
    }
    return out;
  },
};

/**
 * Feature 3 — staleness / anti-starvation aging (P-031). A long-unplaced
 * candidate self-promotes on the same log curve consume-edges B-08 uses
 * (`stalenessMultiplier`), so old work can't be starved behind a steady stream
 * of fresh higher-importance arrivals. Value is the curve's boost above the
 * fresh baseline (0d → 0; ages up to the staleness cap).
 */
const stalenessFeature: PlacementFeature = {
  name: 'staleness',
  weight: PLACEMENT_WEIGHTS.staleness,
  description:
    'Anti-starvation aging (P-031): a long-unplaced candidate self-promotes on B-08\'s log staleness curve so the backlog tail never starves behind fresh arrivals.',
  score(items) {
    const out = new Map<string, FeatureValue>();
    for (const it of items) {
      const ageDays = Math.max(0, it.ageDays ?? 0);
      // stalenessMultiplier(0)=1.0; subtract the fresh baseline so a brand-new
      // candidate contributes 0 and only waiting accrues a boost.
      const value = Math.round((stalenessMultiplier(ageDays) - 1) * 100) / 100;
      out.set(it.id, {
        value,
        reasons: value >= 0.3 ? [`unplaced ${Math.round(ageDays)}d (aging +${value})`] : [],
      });
    }
    return out;
  },
};

/** Feature 4 — escalation / needs-human pressure waiting on this candidate. */
const escalationPressureFeature: PlacementFeature = {
  name: 'escalation-pressure',
  weight: PLACEMENT_WEIGHTS.escalationPressure,
  description:
    'Open escalations / needs-human items waiting on this plan or work-item — unattended decisions gate the work behind them.',
  score(items) {
    const out = new Map<string, FeatureValue>();
    for (const it of items) {
      const escalations = Math.max(0, it.escalations ?? 0);
      out.set(it.id, {
        value: escalations,
        reasons: escalations > 0 ? [`${escalations} open escalation(s)/needs-human`] : [],
      });
    }
    return out;
  },
};

/**
 * The placement feature registry — ORDER IS THE BREAKDOWN ORDER. One ranker,
 * two views (D-004). New placement signals APPEND here; never sort a placement
 * queue anywhere else.
 */
export const PLACEMENT_FEATURES: readonly PlacementFeature[] = [
  importanceFeature,
  blockingImpactFeature,
  stalenessFeature,
  escalationPressureFeature,
];

/** The registry as data — name/weight/description per feature. */
export function placementRankerSpec(): Array<{ name: string; weight: number; description: string }> {
  return describeFeatures(PLACEMENT_FEATURES);
}

/**
 * Rank a set of placement candidates (plans OR work-items) through the one
 * registry. Ties (equal weighted score) break on the manual op_priority steer
 * (lower = sooner; unset sinks last), then id — deterministic. The caller
 * decides which view it passed; the ranker is view-agnostic by construction.
 */
export async function rankPlacements(
  candidates: readonly PlacementCandidate[],
): Promise<Ranked<PlacementCandidate>[]> {
  return rankQueue<PlacementCandidate, PlacementRankContext>(candidates, {}, {
    features: PLACEMENT_FEATURES,
    getKey: (c) => c.id,
    tieBreak: (a, b) => {
      const ao = a.opPriority ?? Number.POSITIVE_INFINITY;
      const bo = b.opPriority ?? Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      return a.id.localeCompare(b.id);
    },
  });
}
