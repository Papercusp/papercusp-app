/**
 * dev:code_run_adoption — the code:run ADOPTION metric as a first-class read
 * (code-run-adoption directive 2026-06-29).
 *
 * Of the spawns that COULD have batched — a same-tool burst or a fan-out, classified by the
 * SAME thresholds as the live inline nudge (so metric and nudge can never disagree) — how many
 * actually folded the flow into one code:run / recipes:run? Returns the per-(role, day) rollup,
 * a fleet-wide figure, and the graded `tool-utilization` rating (the pot-coordination-health
 * criterion). This is the number the inline batch-nudge + recipes-at-orient are meant to MOVE;
 * exposing it as one call lets the Overwatch grade tool-utilization from data rather than vibes,
 * and makes any A/B of the nudges (flip a CODE_RUN_*_NUDGE flag, compare) measurable. Read-only.
 *
 * The canonical SQL (CODE_RUN_ADOPTION_SQL) is also runnable directly via dev:pg_query; this tool
 * wraps it + the grader so callers get a ready answer in one round-trip (itself the lesson).
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import {
  evaluateStagedRollout,
  gradeToolUtilization,
  readCodeRunAdoption,
  readCodeRunInstrumentation,
  readNativeExecRouting,
  rollupAdoption,
  type RunQuery,
  type StagedRolloutThresholds,
} from '../../code-run-adoption';
import { NUDGE_CONVERSION_SQL } from '../../code-run-nudge-telemetry';
import { readStagingBuildIdentity, type StagingBuildIdentity } from '../../harness/dev-operators';
import {
  clientResidueBounds,
  FUNCTIONS_EXEC_CLIENT_RESIDUE_SNAPSHOT,
  MEASURED_SUMMARY_BUDGET_CHARS,
  ORCHESTRATION_BENCHMARK_CORPUS,
} from '../../orchestration-benchmark-corpus';

export default defineTool({
  name: 'dev:code_run_adoption',
  profile: 'engineer',
  description:
    'code:run adoption: of spawns that COULD batch (same-tool burst / fan-out), how many folded the ' +
    'flow into one code:run — plus per-run instrumentation, aggregate-output escape alerts, native-exec routing, ' +
    'and the frozen P-002 comparison baseline. Last N days.',
  capability: 'intel:read',
  guidance: {
    when:
      'Grading pot-coordination-health tool-utilization, or checking whether the code:run nudges / ' +
      'recipes-at-orient are moving adoption. Also use it to inspect run quality, aggregate-output escapes, ' +
      'or D-017 migration away from native client execution.',
    notWhen: 'Raw per-tool call counts (dev:telemetry); which tools co-occur in a spawn (dev:tool_cooccurrence).',
    seeAlso: ['dev:telemetry (raw per-tool call counts)', 'dev:tool_cooccurrence (which tools co-occur in a spawn)'],
  },
  requirePrincipal: false,
  // ALL roles — a read-only metric the whole fleet (esp. the Overwatch grading tool-utilization) can pull.
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    sinceDays: z.number().int().positive().max(90).optional().describe('Window in days (default 7).'),
    // WI-40720 gap 4. EVERY threshold is optional AND nullable, with NO default, on purpose: a
    // defaulted threshold is a number nobody chose, and the gate would then enforce this tool's
    // guess as policy. Supplying none is the safe state — the rollout verdict is then `hold`
    // (insufficient evidence), never `advance`.
    rolloutThresholds: z
      .object({
        minRuns: z.number().int().nonnegative().nullable().optional(),
        minWindowMs: z.number().int().nonnegative().nullable().optional(),
        maxFailureRate: z.number().min(0).max(1).nullable().optional(),
        minSpillResolutionRate: z.number().min(0).max(1).nullable().optional(),
        minRecipeReuseRate: z.number().min(0).max(1).nullable().optional(),
        maxMeanReturnedContextBytes: z.number().nonnegative().nullable().optional(),
        maxMeanDurationMs: z.number().nonnegative().nullable().optional(),
        minBackendRoutingAccuracy: z.number().min(0).max(1).nullable().optional(),
      })
      .optional()
      .describe(
        'P-020 staged-rollout acceptance thresholds. Omit any (or all) to leave that gate UNJUDGED — ' +
          'an unjudged gate cannot qualify, so the verdict stays `hold` rather than `advance`.',
      ),
  }),
  async handler(args) {
    const sinceDays = args.sinceDays ?? 7;
    // Capture the window ONCE, BEFORE issuing any query, so every part of the emitted verdict
    // describes the same interval. Note honestly what this is: the SQL selects rows by POSTGRES'
    // now() at query time, so this JS stamp is an approximation of that boundary, not the
    // boundary itself. Taking it BEFORE the queries makes the error conservative in the only
    // direction that matters — windowStartMs lands at or BEFORE the true SQL boundary, so the
    // build-attribution test (build must start at or before windowStartMs) is if anything
    // stricter than reality. An over-strict gate holds; an over-loose one would certify a window
    // the build did not cover.
    const windowEndMs = Date.now();
    const windowStartMs = windowEndMs - sinceDays * 24 * 60 * 60 * 1000;
    const { sql } = getOrgPg();
    const runQuery: RunQuery = async <T = unknown>(query: string, params: unknown[]) =>
      (await sql.unsafe(query, params as never)) as unknown as T[];
    const [byRoleDay, instrumentation, nativeExecRouting] = await Promise.all([
      readCodeRunAdoption(runQuery, { sinceDays }),
      readCodeRunInstrumentation(runQuery, sinceDays),
      readNativeExecRouting(runQuery, sinceDays),
    ]);
    const fleet = rollupAdoption(byRoleDay);
    const grade = gradeToolUtilization(fleet);
    const incident = ORCHESTRATION_BENCHMARK_CORPUS.find((entry) => entry.id === 'incident-01a02a75-nine-read-fanout');
    if (!incident) throw new Error('P-002 incident baseline missing from orchestration benchmark corpus');
    const residue = clientResidueBounds();
    const perRun = (total: number): number | null => (instrumentation.runs > 0 ? total / instrumentation.runs : null);
    const runQuality = {
      totals: instrumentation,
      perRun: {
        toolCalls: perRun(instrumentation.toolCalls),
        intermediateBytes: perRun(instrumentation.intermediateBytes),
        returnedContextBytes: perRun(instrumentation.returnedContextBytes),
        spilledBytes: perRun(instrumentation.spilledBytes),
        durationMs: perRun(instrumentation.durationMs),
      },
      p002Baseline: {
        incidentId: incident.id,
        incidentMetrics: incident.metrics,
        authoredSummaryBudgetChars: MEASURED_SUMMARY_BUDGET_CHARS,
        clientOnlyResidue: {
          source: FUNCTIONS_EXEC_CLIENT_RESIDUE_SNAPSHOT.source,
          capturedThroughTs: FUNCTIONS_EXEC_CLIENT_RESIDUE_SNAPSHOT.capturedThroughTs,
          totalCalls: FUNCTIONS_EXEC_CLIENT_RESIDUE_SNAPSHOT.totalCalls,
          ...residue,
        },
      },
    };
    const alerts = {
      aggregateOutputEscape: {
        status: instrumentation.aggregateOutputEscapes > 0 ? 'firing' : 'clear',
        severity: 'critical',
        threshold: 0,
        count: instrumentation.aggregateOutputEscapes,
        message:
          instrumentation.aggregateOutputEscapes > 0
            ? `${instrumentation.aggregateOutputEscapes} code:run result(s) exceeded the aggregate output budget in the last ${sinceDays} day(s)`
            : `No code:run result exceeded the aggregate output budget in the last ${sinceDays} day(s)`,
      },
    };
    // Nudge→conversion funnel (P-005): of sessions that received a batch-hint in the window,
    // how many then called code:run/recipes:run. Best-effort — the fires table (mig 482) may
    // not exist yet on an un-migrated host; the adoption read must not fail for it.
    let nudge: { nudgedSessions: number; convertedSessions: number } | null = null;
    try {
      const rows = await runQuery<{ nudged_sessions: number | string; converted_sessions: number | string }>(
        NUDGE_CONVERSION_SQL,
        [sinceDays],
      );
      if (rows[0]) {
        nudge = {
          nudgedSessions: Number(rows[0].nudged_sessions) || 0,
          convertedSessions: Number(rows[0].converted_sessions) || 0,
        };
      }
    } catch {
      /* fires table absent / query failed — omit the funnel rather than fail the read */
    }
    // WI-40893 / D-052: P-020 is a STAGED rollout judged by regression telemetry, and a
    // measurement you cannot attribute to a build cannot establish a regression. This is
    // the P-020 rollout telemetry door, so the live staging build identity is derived
    // HERE at read time rather than hand-recorded into evidence after the fact. It is a
    // typed measured/not_measured value: unreachable, non-JSON, and the literal 'unknown'
    // sentinel all render as not_measured, because absence must never read as a build.
    // Best-effort, like the funnel above — the adoption read must not fail for it.
    let stagingBuildIdentity: StagingBuildIdentity = {
      status: 'not_measured',
      reason: 'unreachable',
      sidecarSha: null,
      sidecarStartedAtMs: null,
      origin: '',
    };
    try {
      stagingBuildIdentity = await readStagingBuildIdentity();
    } catch {
      /* readStagingBuildIdentity is already never-throws; this is belt-and-braces so a
         future change to it can never take the adoption read down with it. */
    }
    // WI-40720 gap 4 — the staged-rollout verdict, emitted through THIS door rather than left as
    // an uncalled helper (D-052 rail). Thresholds absent ⇒ every soft gate is unjudged ⇒
    // `action: 'hold'`. A hard trigger (an invariant breach) yields `rollback` regardless of
    // thresholds, so the rollback signal works even before anyone has stated a policy.
    const t = args.rolloutThresholds;
    const thresholds: StagedRolloutThresholds = {
      minRuns: t?.minRuns ?? null,
      minWindowMs: t?.minWindowMs ?? null,
      maxFailureRate: t?.maxFailureRate ?? null,
      minSpillResolutionRate: t?.minSpillResolutionRate ?? null,
      minRecipeReuseRate: t?.minRecipeReuseRate ?? null,
      maxMeanReturnedContextBytes: t?.maxMeanReturnedContextBytes ?? null,
      maxMeanDurationMs: t?.maxMeanDurationMs ?? null,
      minBackendRoutingAccuracy: t?.minBackendRoutingAccuracy ?? null,
    };
    const stagedRollout = evaluateStagedRollout({
      rollup: instrumentation,
      buildIdentity: stagingBuildIdentity,
      windowStartMs,
      windowEndMs,
      thresholds,
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            sinceDays,
            window: { startMs: windowStartMs, endMs: windowEndMs },
            fleet,
            grade,
            nudge,
            runQuality,
            nativeExecRouting,
            stagingBuildIdentity,
            stagedRollout,
            alerts,
            byRoleDay,
          }),
        },
      ],
    };
  },
});
