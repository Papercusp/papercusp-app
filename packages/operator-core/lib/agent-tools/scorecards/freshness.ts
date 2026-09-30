/**
 * scorecards:freshness — has the Overwatch emitted a COMPLETE scorecard recently?
 * (plan-templates-and-rubric-v2-2026-06-20 P-014b / D-005).
 *
 * The emission-freshness READ — the monitor-the-monitor query. P-014a's completeness GATE makes a
 * partial scorecard fail at WRITE; this makes a NO-emit or PARTIAL-only window VISIBLE at READ, so
 * a silently-skipping or silently-truncating Overwatch surfaces as a status instead of being missed
 * (D-005: a ~4h emission gap + 2-of-4 partials were invisible until a raw PG read). Built on
 * checkScorecardFreshness over scorecards:list (P-013, su-3a5d7).
 *
 * `subjectPlan` (EI-22084134815763318 — the scorecards:freshness sibling of EI-22084090899431625's
 * rubrics:list fix): callers repeatedly guessed `subjectPlan` here too, expecting the same
 * plan-slug ergonomics rubrics:list/propose already carry, because they know the PLAN they are
 * checking freshness for, not the generated acceptance-rubric id. Resolves to the plan's single
 * ACTIVE acceptance rubric via listRubrics(); zero or multiple matches is a clear ok:false, never
 * a guess.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { checkScorecardFreshness, interpretOverwatchEmission } from '../../scorecard-freshness';
import { COORDINATION_RUBRIC_REF } from '../../overwatch/scorecard-backstop';
import { getOverwatchLiveness } from '../../overwatch/snapshot';
import { listRubrics } from '../../rubrics';

export default defineTool({
  name: 'scorecards:freshness',
  profile: 'engineer',
  description:
    'Has Overwatch emitted a COMPLETE scorecard for a rubric since a given time (its last wake)? The emission-freshness check (monitor-the-monitor): returns status = fresh (a COMPLETE scorecard landed in-window) | partial-only (scorecards landed but ALL incomplete — a silent truncation) | stale (NOTHING landed — a silent emission gap), plus emitted / complete / count / partialCount, lastEmittedAt, lastCompleteAt, and latestMissingKeys (what is unrated right now). Reads scorecards:list (P-013); a "complete" scorecard rates every rubric criterion. Pass `rubricRef` directly, or `subjectPlan` to auto-resolve its active acceptance rubric.',
  guidance: {
    when: 'You want to know whether Overwatch is actually emitting COMPLETE scorecards, not just whether it emitted anything — monitor-the-monitor. Did a complete pot-coordination-health scorecard land since the last wake (status fresh), or is it silently skipping (stale) / truncating to partials (partial-only)? Pass `since` = the last wake for a precise check.',
    notWhen:
      'You want the scorecard ROWS + their ratings — scorecards:list. You want a criterion\'s rating TREND over time — rubrics:trend. You are FILING a scorecard — scorecards:emit.',
    chaining:
      'scorecards:freshness { rubricRef: "pot-coordination-health", since } → status stale/partial-only ⇒ Overwatch missed or truncated → scorecards:list { rubricRef, since } to see what (if anything) it emitted, or check latestMissingKeys for which criteria were dropped.',
    seeAlso: [
      'scorecards:list (the raw scorecards behind the freshness view)',
      'rubrics:trend (per-criterion trend over time)',
      'rubrics:list (subjectPlan filter — inspect a plan\'s acceptance rubric(s) directly, incl. non-active ones)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      rubricRef: z
        .string()
        .optional()
        .describe(
          'the rubric to check freshness for, e.g. "pot-coordination-health". Mutually exclusive with subjectPlan — pass exactly one.',
        ),
      subjectPlan: z
        .string()
        .optional()
        .describe(
          "resolve rubricRef automatically from this plan slug's ACTIVE acceptance rubric (mirrors rubrics:list's subjectPlan filter) — for when you know the plan, not the generated rubric id. Mutually exclusive with rubricRef.",
        ),
      sourceHive: z.string().optional().describe('restrict to scorecards from one source-hive'),
      since: z
        .string()
        .optional()
        .describe(
          'ISO timestamp — the window start; pass the emitter\'s last wake for a precise "since last wake" check. Omit for a lookback default.',
        ),
      lookbackMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('fallback window size in ms when `since` is omitted (default 2h)'),
    })
    .superRefine((val, ctx) => {
      if (!val.rubricRef && !val.subjectPlan) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'either rubricRef or subjectPlan is required',
          path: ['rubricRef'],
        });
      }
      if (val.rubricRef && val.subjectPlan) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'rubricRef and subjectPlan are mutually exclusive — pass exactly one',
          path: ['subjectPlan'],
        });
      }
    }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    let rubricRef: string | undefined = args.rubricRef;
    let resolvedFromSubjectPlan: { subjectPlan: string; rubricRef: string } | undefined;
    // EI-22084134815763318: resolve subjectPlan → the plan's single ACTIVE acceptance rubric via
    // the same listRubrics() the sibling rubrics:list fix (EI-22084090899431625) already exposes —
    // no duplicated resolution logic, and a zero/ambiguous match is a clear ok:false, never a guess.
    if (!rubricRef && args.subjectPlan) {
      const candidates = await listRubrics({
        subjectPlan: args.subjectPlan,
        kind: 'acceptance',
        status: 'active',
      });
      if (candidates.length === 0) {
        return {
          data: {
            ok: false as const,
            error:
              `no ACTIVE acceptance rubric found for subjectPlan '${args.subjectPlan}' — check ` +
              `rubrics:list { subjectPlan: '${args.subjectPlan}' } (it also surfaces retired/proposed ` +
              'rows, so a rubric may exist but not be active right now), or file one via rubrics:propose.',
          },
        };
      }
      if (candidates.length > 1) {
        return {
          data: {
            ok: false as const,
            error:
              `subjectPlan '${args.subjectPlan}' resolves to ${candidates.length} ACTIVE acceptance ` +
              `rubrics (${candidates.map((r) => r.rubricId).join(', ')}) — ambiguous; pass rubricRef ` +
              'directly.',
          },
        };
      }
      rubricRef = candidates[0].rubricId;
      resolvedFromSubjectPlan = { subjectPlan: args.subjectPlan, rubricRef };
    }
    if (!rubricRef) {
      // Unreachable given the schema's superRefine (rubricRef or subjectPlan is required) — kept
      // so the branch below is fully typed (string, not string | undefined) without an assertion.
      return { data: { ok: false as const, error: 'either rubricRef or subjectPlan is required' } };
    }
    const freshness = await checkScorecardFreshness({
      rubricRef,
      sourceHive: args.sourceHive,
      since: args.since,
      lookbackMs: args.lookbackMs,
    });
    const out: {
      ok: true;
      freshness: typeof freshness;
      resolvedFromSubjectPlan?: { subjectPlan: string; rubricRef: string };
      overwatch?: {
        flagEnabled: boolean;
        started: boolean;
        loopAlive: boolean;
        loopStale: boolean;
        lastRunAt: string | null;
        cadenceSec: number;
        inFlight: boolean;
      };
      interpretation?: ReturnType<typeof interpretOverwatchEmission>;
    } = { ok: true, freshness, ...(resolvedFromSubjectPlan ? { resolvedFromSubjectPlan } : {}) };
    // WI-1724 (monitor-the-monitor is silent): a bare `stale`/`partial-only` verdict for the
    // Overwatch's OWN rubric is ambiguous — disabled (ignore) vs paused/not-started (ignore) vs
    // a DEAD wake-loop (revive) vs a live-loop-but-skipping AGENT (fix the turn) all read the
    // same. Cross-reference the live overwatch liveness so the verdict self-interprets. Only for
    // the coordination rubric (the Overwatch's mandate); fail-soft — a degraded liveness read
    // just omits the enrichment rather than erroring the freshness check.
    if (rubricRef === COORDINATION_RUBRIC_REF) {
      try {
        const liveness = await getOverwatchLiveness(
          args.sourceHive ? { potSlug: args.sourceHive } : undefined,
        );
        const overwatch = {
          flagEnabled: liveness.flagEnabled,
          started: liveness.started,
          loopAlive: liveness.alive,
          loopStale: liveness.stale,
          lastRunAt: liveness.lastRunAt,
          cadenceSec: liveness.cadenceSec,
          inFlight: liveness.inFlight,
        };
        out.overwatch = overwatch;
        out.interpretation = interpretOverwatchEmission(freshness.status, overwatch);
      } catch {
        // fail-soft — omit the enrichment; the raw freshness still returns.
      }
    }
    return {
      data: out,
    };
  },
});
