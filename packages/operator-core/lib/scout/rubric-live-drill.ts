/**
 * Deployed Blender rubric-seeding drill (blender-self-learning P-013 follow-through).
 *
 * The original P-013 integration test proved the real rails in an ephemeral DB, but
 * a public-release gate needs fresh evidence from the deployed generation. This
 * module runs the same bounded, deterministic vaccination against the live stores:
 * a synthetic scorecard is visible only to drill-mode readers, one production Scout
 * composition routes a grounded idea, every resulting artifact/ledger row is stamped
 * origin='drill', and the grading write is exercised. Organic readers, cadence rows,
 * and lens weights remain untouched by construction and are compared before/after.
 */
import { getOrgPg } from '@papercusp/db-org';

import { createIssue } from '../issues-engineer';
import { OBSERVATION_TOPIC } from '../harness/improvements/read-items';
import { activeWorkspaceId } from '../workspace-registry';
import { runScoutCycle } from './cycle';
import { buildScoutCycleDeps } from './cycle-deps';
import { buildStateOfHiveReaders } from './corpus-digest-deps';
import { createScoutPlanDraft } from './scout-plan-draft';
import { buildScoutArchivePort } from './scout-archive-port';
import {
  gradeRoutedIdea,
  readRoutedIdeas,
  recordRoutedIdea,
} from './routed-ledger';
import { groundingLaneHistogram } from './scheduler';
import type { ScoutLlmCall } from './types';

const DRILL_RUBRIC_REF = 'blender-live-drill';
const DRILL_ACTOR = 'blender-live-drill';

export interface BlenderDrillOrganicSnapshot {
  routed: number;
  graded: number;
  scoutTicks: number;
  lensRows: number;
  lensWins: number;
  lensDecided: number;
  lensWeight: number;
}

export interface BlenderDrillEvidence {
  rubricSurfaced: boolean;
  cycleCompleted: boolean;
  routedRows: number;
  groundedRows: number;
  rubricGroundingCount: number;
  gradedRows: number;
  syntheticScorecard: boolean;
  syntheticRoutes: number;
  /** Causal assertion: this drill's cycle id produced zero non-drill routes/ticks. */
  organicMetricsUnchanged: boolean;
  /** Diagnostic only: false means legitimate concurrent organic activity occurred
   *  during the drill window; it is not attributable to the drill. */
  organicCountersStable: boolean;
}

export interface BlenderRubricDrillResult {
  ok: boolean;
  drillId: string;
  cycleId: string;
  scorecardId: string;
  patternRef: string;
  stop: string;
  modelCalls: number;
  routedRefs: string[];
  organicBefore: BlenderDrillOrganicSnapshot;
  organicAfter: BlenderDrillOrganicSnapshot;
  evidence: BlenderDrillEvidence;
  failures: string[];
}

export function evaluateBlenderDrillEvidence(
  evidence: BlenderDrillEvidence,
): { ok: boolean; failures: string[] } {
  const checks: Array<[boolean, string]> = [
    [evidence.rubricSurfaced, 'drill scorecard did not surface in the rubric-rating digest lane'],
    [evidence.cycleCompleted, 'Scout cycle did not complete'],
    [evidence.routedRows > 0, 'no origin=drill routed-ledger row landed'],
    [evidence.groundedRows > 0, 'no routed row retained the planted rubric ref'],
    [evidence.rubricGroundingCount > 0, 'rubric-rating grounding metric stayed at zero'],
    [evidence.gradedRows === evidence.routedRows, 'not every drill route reached the grading surface'],
    [evidence.syntheticScorecard, 'the planted scorecard lost origin=drill provenance'],
    [evidence.syntheticRoutes === evidence.routedRows, 'a routed drill artifact leaked into the organic issue lane'],
    [evidence.organicMetricsUnchanged, 'the drill cycle leaked a route or tick into an organic origin'],
  ];
  const failures = checks.filter(([pass]) => !pass).map(([, message]) => message);
  return { ok: failures.length === 0, failures };
}

function drillLlm(patternRef: string, stamp: string): ScoutLlmCall {
  return async (opts) => {
    let json: unknown;
    if ((opts.system ?? '').includes('You are a SCOUT')) {
      json = {
        ideas: [
          {
            title: `Release drill: self-escalate a repeated broken criterion (${stamp})`,
            body: 'A repeatedly broken measured criterion should trip a scoped guard instead of waiting for manual discovery.',
            mechanism: 'After a second broken grade, file a scoped guard item and expose the regression in the release scorecard.',
            addressesPatternRefs: [patternRef],
          },
        ],
      };
    } else if ((opts.system ?? '').includes('TWO adversarial critics')) {
      json = {
        conceptualNovelty: 0.86,
        feasibility: 0.82,
        rationale: 'deterministic deployed drill keep verdict',
      };
    } else if ((opts.system ?? '').includes('Scout proposer')) {
      json = {
        framing: 'A measured-broken criterion should self-escalate',
        mechanism: 'On a repeat broken grade, file a scoped guard item and surface it in release readiness.',
        whyNew: 'The current path depends on a human noticing a grade regression.',
        bet: 'Broken release criteria stop persisting silently across cycles.',
        experiment: {
          hypothesis: 'A repeated broken grade produces one scoped guard without organic signal leakage.',
          method: 'Run the origin=drill vaccination and inspect the drill-only ledgers.',
          falsifiableSignal: 'No grounded route lands, or an organic counter changes.',
        },
        route: 'improvement',
      };
    } else {
      json = { items: [] };
    }
    const text = JSON.stringify(json);
    return {
      text,
      json,
      costUsd: 0,
      inputTokens: Math.max(1, Math.ceil(((opts.system?.length ?? 0) + text.length) / 4)),
      outputTokens: Math.max(1, Math.ceil(text.length / 4)),
    };
  };
}

async function readOrganicSnapshot(
  workspaceId: string,
): Promise<BlenderDrillOrganicSnapshot> {
  const { sql } = getOrgPg();
  const rows = await sql<
    Array<{
      routed: string | number;
      graded: string | number;
      scout_ticks: string | number;
      lens_rows: string | number;
      lens_wins: string | number;
      lens_decided: string | number;
      lens_weight: string | number;
    }>
  >`
    SELECT
      (SELECT count(*) FROM harness_shared.scout_routed_ideas
        WHERE workspace_id = ${workspaceId} AND origin IN ('scout', 'su-ideate')) AS routed,
      (SELECT count(*) FROM harness_shared.scout_routed_ideas
        WHERE workspace_id = ${workspaceId} AND origin IN ('scout', 'su-ideate')
          AND human_grade IS NOT NULL) AS graded,
      (SELECT count(*) FROM harness_shared.scout_ticks
        WHERE workspace_id = ${workspaceId} AND origin = 'scout') AS scout_ticks,
      (SELECT count(*) FROM harness_shared.scout_lens_weights
        WHERE workspace_id = ${workspaceId}) AS lens_rows,
      (SELECT COALESCE(sum(wins), 0) FROM harness_shared.scout_lens_weights
        WHERE workspace_id = ${workspaceId}) AS lens_wins,
      (SELECT COALESCE(sum(decided), 0) FROM harness_shared.scout_lens_weights
        WHERE workspace_id = ${workspaceId}) AS lens_decided,
      (SELECT COALESCE(sum(weight), 0) FROM harness_shared.scout_lens_weights
        WHERE workspace_id = ${workspaceId}) AS lens_weight`;
  const row = rows[0];
  return {
    routed: Number(row?.routed ?? 0),
    graded: Number(row?.graded ?? 0),
    scoutTicks: Number(row?.scout_ticks ?? 0),
    lensRows: Number(row?.lens_rows ?? 0),
    lensWins: Number(row?.lens_wins ?? 0),
    lensDecided: Number(row?.lens_decided ?? 0),
    lensWeight: Number(row?.lens_weight ?? 0),
  };
}

async function readSyntheticIntegrity(args: {
  workspaceId: string;
  cycleId: string;
  scorecardId: string;
}): Promise<{
  syntheticScorecard: boolean;
  syntheticRoutes: number;
  organicRouteLeaks: number;
  organicTickLeaks: number;
}> {
  const { sql } = getOrgPg();
  const rows = await sql<
    Array<{
      scorecard_is_drill: boolean;
      synthetic_routes: string | number;
      organic_route_leaks: string | number;
      organic_tick_leaks: string | number;
    }>
  >`
    SELECT
      EXISTS (
        SELECT 1 FROM harness_shared.engineer_issues
         WHERE issue_id = ${args.scorecardId} AND signal_origin = 'drill'
      ) AS scorecard_is_drill,
      (
        SELECT count(*)
          FROM harness_shared.scout_routed_ideas r
          JOIN harness_shared.engineer_issues i
            ON r.routed_ref = 'wi:' || i.issue_id
         WHERE r.workspace_id = ${args.workspaceId}
           AND r.cycle_id = ${args.cycleId}
           AND r.origin = 'drill'
           AND i.signal_origin = 'drill'
      ) AS synthetic_routes,
      (
        SELECT count(*)
          FROM harness_shared.scout_routed_ideas
         WHERE workspace_id = ${args.workspaceId}
           AND cycle_id = ${args.cycleId}
           AND origin IS DISTINCT FROM 'drill'
      ) AS organic_route_leaks,
      (
        SELECT count(*)
          FROM harness_shared.scout_ticks
         WHERE workspace_id = ${args.workspaceId}
           AND origin = 'scout'
           AND detail->>'cycleId' = ${args.cycleId}
      ) AS organic_tick_leaks`;
  return {
    syntheticScorecard: rows[0]?.scorecard_is_drill === true,
    syntheticRoutes: Number(rows[0]?.synthetic_routes ?? 0),
    organicRouteLeaks: Number(rows[0]?.organic_route_leaks ?? 0),
    organicTickLeaks: Number(rows[0]?.organic_tick_leaks ?? 0),
  };
}

export async function runBlenderRubricDrill(args: {
  harnessSlug: string;
  sourceHive?: string;
  workspaceId?: string;
  nowMs?: number;
}): Promise<BlenderRubricDrillResult> {
  const workspaceId = args.workspaceId ?? activeWorkspaceId();
  const sourceHive = args.sourceHive ?? args.harnessSlug;
  const nowMs = args.nowMs ?? Date.now();
  const stamp = nowMs.toString(36);
  const drillId = `blender-live-drill-${stamp}`;
  const cycleId = `${drillId}-cycle`;
  const criterion = `seeded-broken-${stamp}`;
  const patternRef = `rubric:${DRILL_RUBRIC_REF}#${criterion}@${sourceHive}`;

  const organicBefore = await readOrganicSnapshot(workspaceId);
  const scorecard = await createIssue({
    title: `Blender deployed rubric drill scorecard (${stamp})`,
    topics: [OBSERVATION_TOPIC],
    scope: `harness:${args.harnessSlug}`,
    createdBy: DRILL_ACTOR,
    signalOrigin: 'drill',
    payload: {
      // D-005: synthetic scorecards are observations, never generic work-queue items.
      // Keep the lane marker alongside the rubric payload so scheduler self-selectors
      // cannot pick the drill artifact as a bug.
      lane: 'observation',
      observation: {
        rubricRef: DRILL_RUBRIC_REF,
        sourceHive,
        ratings: {
          [criterion]: {
            rating: 'broken',
            evidence: `drill:${drillId} vaccination-planted broken criterion`,
          },
        },
      },
    },
  });

  // Only synthetic observations enter the rubric lane. The other production
  // readers remain real so this exercises the deployed composition without
  // allowing the drill scorecard into organic learning.
  const readers = buildStateOfHiveReaders({ observationOrigins: ['drill'] });
  const archive = await buildScoutArchivePort({ workspaceId, harnessSlug: args.harnessSlug });
  const deps = buildScoutCycleDeps({
    harnessSlug: args.harnessSlug,
    llmCall: drillLlm(patternRef, stamp),
    createPlanDraft: (input) =>
      createScoutPlanDraft({
        ...input,
        harnessSlug: args.harnessSlug,
        workspaceId,
        date: new Date(nowMs).toISOString().slice(0, 10),
      }),
    archive,
    cycleId,
    limits: { maxIdeators: 1, maxCostUsd: 0.05 },
    stateOfHiveReaders: readers,
    digestOptions: { nowMs },
    noveltyCorpus: async () => [],
    captureOptions: {
      origin: 'drill',
      scope: `harness:${args.harnessSlug}`,
      foundDuring: drillId,
      sourceRole: 'Scout',
    },
  });

  const result = await runScoutCycle(deps);
  await archive.flush();
  for (const row of result.provenance) {
    await recordRoutedIdea({
      ideaId: row.ideaId,
      lens: row.lens,
      rail: row.rail,
      routedRef: row.routedRef,
      ...(row.title ? { title: row.title } : {}),
      ...(row.addressesPatternRefs
        ? { addressesPatternRefs: row.addressesPatternRefs }
        : {}),
      ...(row.targetHive ? { targetHive: row.targetHive } : {}),
      harnessSlug: args.harnessSlug,
      sourceHive,
      workspaceId,
      cycleId,
      origin: 'drill',
      createdBy: DRILL_ACTOR,
    });
  }

  const routed = await readRoutedIdeas({
    workspaceId,
    harnessSlug: args.harnessSlug,
    cycleId,
    origin: 'drill',
  });
  for (const row of routed) {
    await gradeRoutedIdea({
      ideaId: row.ideaId,
      grade: 5,
      feedback: `Automated ${drillId}: deployed rubric-seeding route reached the grading surface.`,
      gradedBy: 'auto-grader',
    });
  }
  const graded = await readRoutedIdeas({
    workspaceId,
    harnessSlug: args.harnessSlug,
    cycleId,
    origin: 'drill',
  });
  const synthetic = await readSyntheticIntegrity({
    workspaceId,
    cycleId,
    scorecardId: scorecard.id,
  });
  const organicAfter = await readOrganicSnapshot(workspaceId);
  const histogram = groundingLaneHistogram(result.provenance);
  const evidence: BlenderDrillEvidence = {
    rubricSurfaced:
      result.digest.rubricRatings?.some((rating) => rating.ref === patternRef) === true,
    cycleCompleted: result.stop === 'completed',
    routedRows: graded.length,
    groundedRows: graded.filter((row) => row.addressesPatternRefs?.includes(patternRef)).length,
    rubricGroundingCount: histogram['rubric-rating'] ?? 0,
    gradedRows: graded.filter((row) => row.humanGrade === 5).length,
    syntheticScorecard: synthetic.syntheticScorecard,
    syntheticRoutes: synthetic.syntheticRoutes,
    // Exact workspace counters are diagnostic only: Scout may legitimately run
    // concurrently. The release assertion is CAUSAL — this drill's cycle id must
    // never appear under an organic route/tick origin.
    organicMetricsUnchanged:
      synthetic.organicRouteLeaks === 0 && synthetic.organicTickLeaks === 0,
    organicCountersStable: JSON.stringify(organicBefore) === JSON.stringify(organicAfter),
  };
  const verdict = evaluateBlenderDrillEvidence(evidence);
  return {
    ok: verdict.ok,
    drillId,
    cycleId,
    scorecardId: scorecard.id,
    patternRef,
    stop: result.stop,
    modelCalls: result.calls.length,
    routedRefs: graded.map((row) => row.routedRef),
    organicBefore,
    organicAfter,
    evidence,
    failures: verdict.failures,
  };
}
