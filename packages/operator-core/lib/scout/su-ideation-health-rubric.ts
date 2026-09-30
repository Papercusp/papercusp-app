/**
 * su-ideation-health-rubric.ts — the PROPOSED grading standard for the su-ideation
 * learning loop (su-ideate-learning-substrate-2026-07-10 P-013).
 *
 * P-013 asks to PROPOSE a rubric 'su-ideation-health' — and to EMIT the proposal ONLY.
 * Ratification (flipping it 'active' so Overwatch/Scout grade against it) stays with the
 * an independent reviewer or owner via `rubrics:ratify`. That split is the D-012 PARITY PRECEDENT: the teaching
 * signal stays honest only when the party that AUTHORS the standard is not the party that
 * RATIFIES it (D-012: a grader is an owner-proxy that must not be the author). So the
 * emitter here HARD-PINS status:'proposed' — there is no code path in this module that
 * activates the rubric.
 *
 * The four criteria mirror the four health surfaces this plan built:
 *   - pass-cadence          ← P-010 tick ledger + P-011 OVERDUE fold (D-015: observation-count-keyed)
 *   - outcome-read-freshness ← P-003 outcome readback (won/lost/pending) grounding each pass
 *   - grade-loop-latency    ← P-005 grade→revise wake + P-006 ungraded-filings backstop watchdog
 *   - lens-diversity        ← P-002/P-004 su lens vocabulary + per-lens win-rate diversity floor
 */
import { proposeRubric, type ProposeRubricInput, type Rubric, type RubricCriterion, type RubricStatus } from '../rubrics';

/** Stable slug an su-ideation-health observation's ratings reference. */
export const SU_IDEATION_HEALTH_RUBRIC_ID = 'su-ideation-health';

/** The umbrella characteristic Scout's digest groups this rubric's observations under. */
export const SU_IDEATION_HEALTH_CHARACTERISTIC = 'su-ideation';

/** The four gradeable criteria (stable kebab keys — an observation rating is keyed by these). */
export const SU_IDEATION_HEALTH_CRITERIA: readonly RubricCriterion[] = [
  {
    key: 'pass-cadence',
    title: 'Ideate passes run at a healthy rhythm',
    model:
      'An ideate-active session mines accumulated signal into ideas at a sane cadence. Health is ' +
      'OBSERVATION-COUNT-keyed, never calendar-keyed (D-015): a session is overdue when its ' +
      'lane:observation count since its last recorded pass reaches SU_IDEATE_OBS_THRESHOLD, or its ' +
      'routed idea queue has drained — an idle session that accrued no signal is NOT overdue.',
    method:
      'Read the last su-ideate tick (scout_ticks origin=su-ideate, P-010) and the caller observation ' +
      'count since it (the P-011 orient OVERDUE fold); compare against the threshold. Cross-check the ' +
      'routed-idea drain (readIdeaQueueStatus).',
    driftMarkers:
      'Sessions sitting past the observation threshold with no new pass; the whole workspace showing no ' +
      'su-ideate tick for long stretches while observations pile up; the idea queue drained with no regeneration pass.',
  },
  {
    key: 'outcome-read-freshness',
    title: 'Passes are grounded in current outcomes',
    model:
      'Each pass opens on a fresh outcome readback — won/lost/pending per routed idea (P-003), lens ' +
      'win-rates (P-004), and federated priming (P-012) — so ideation self-corrects on what actually ' +
      'shipped vs was deprecated instead of re-deriving blind.',
    method:
      'Check how recently refreshScoutOutcomes ran over origin=su-ideate (outcome_checked_at staleness) ' +
      'and whether blender:ideation-feedback pass-opens carry a non-empty outcomes section.',
    driftMarkers:
      'outcome_checked_at stale across the su-ideate ledger; passes filed with no recent outcome readback; ' +
      'grades landing with no downstream priming refresh.',
  },
  {
    key: 'grade-loop-latency',
    title: 'The teaching signal turns around promptly',
    model:
      'su-originated filings get graded quickly so the grade→revise wake (P-005) and lens/priming learning ' +
      'actually close the loop. A grade of 3 or lower with feedback should wake the originator to revise; ' +
      'ungraded filings must not rot past the backstop deadline.',
    method:
      'Measure routed_at → human_grade latency for origin=su-ideate rows; count filings ungraded past ' +
      'SU_IDEATE_UNGRADED_STALE_SEC and the P-006 ungraded-filings watchdog fire rate ' +
      '(pot_watchdog_fires source=su-ideate-ungraded).',
    driftMarkers:
      'Filings ungraded well past the stale window; the ungraded-filings watchdog firing repeatedly with no ' +
      'grading follow-through; grade→revise wakes with no revision.',
  },
  {
    key: 'lens-diversity',
    title: 'Ideation spans the lens vocabulary, not one groove',
    model:
      'Passes spread across the su lens vocabulary (SU_IDEATION_LENSES) rather than collapsing to a single ' +
      'lens or the unlabeled sentinel — the diversity floor (samplingWeightsWithFloor) keeps a cold/losing ' +
      'lens alive so exploration never starves.',
    method:
      'Read the recent lens distribution over origin=su-ideate rows against the su lens roster and the ' +
      'per-lens win-rates (P-004); watch the share of the "su-ideate" sentinel lens (unlabeled filings).',
    driftMarkers:
      'One lens dominating recent filings; several lenses at zero share; a high share of the unlabeled ' +
      '"su-ideate" sentinel lens (agents not tagging a real lens).',
  },
];

/**
 * The su-ideation-health rubric PROPOSAL input. Status is deliberately NOT set here — the
 * {@link proposeSuIdeationHealthRubric} emitter hard-pins 'proposed' (D-012 parity: the
 * author never self-ratifies). The default rating scale (healthy/degraded/broken/unknown)
 * is inherited — no per-criterion override.
 */
export const SU_IDEATION_HEALTH_RUBRIC: ProposeRubricInput = {
  rubricId: SU_IDEATION_HEALTH_RUBRIC_ID,
  characteristic: SU_IDEATION_HEALTH_CHARACTERISTIC,
  title: 'su-ideation loop health',
  description:
    'Is the su-ideation learning loop still producing good ideas at a sane cadence, grading them ' +
    'honestly, and exploring the lens space — or has it quietly gone dark? Grades the four surfaces the ' +
    'su-ideate learning substrate built: pass cadence, outcome-read freshness, grade-loop latency, and ' +
    'lens diversity.',
  criteria: [...SU_IDEATION_HEALTH_CRITERIA],
  // P-011: WATCHED for staleness, but explicitly NOT release-gating. This rubric is the
  // Blender steward's health surface — "has the loop quietly gone dark?" is precisely the
  // question a stale scorecard answers wrong by saying nothing, so it must be watched.
  // It is not a ship gate though (WI-37911), and releaseGating would additionally impose
  // the machine-instrument contract that a judgement-based health rubric cannot satisfy.
  stalenessWatched: true,
};

/** Injectable propose port — tests drive it with no PG; production uses {@link proposeRubric}. */
export interface ProposeSuIdeationHealthDeps {
  propose: (input: ProposeRubricInput) => Promise<Rubric>;
}

const defaultDeps: ProposeSuIdeationHealthDeps = { propose: proposeRubric };

/**
 * Emit the su-ideation-health rubric as a PROPOSAL — and only a proposal. Whatever status a
 * caller might request, the write is HARD-PINNED to 'proposed' (D-012 parity: the proposer is
 * not the ratifier — activation to 'active' is an independent-reviewer/owner act via
 * rubrics:ratify). Idempotent
 * on rubricId (re-emit refreshes the proposal content, never its ratification).
 */
export async function proposeSuIdeationHealthRubric(
  opts: { by?: string } = {},
  deps: ProposeSuIdeationHealthDeps = defaultDeps,
): Promise<Rubric> {
  const status: RubricStatus = 'proposed'; // never 'active' — proposer≠ratifier stays enforced
  return deps.propose({
    ...SU_IDEATION_HEALTH_RUBRIC,
    ...(opts.by ? { by: opts.by } : {}),
    status,
  });
}
