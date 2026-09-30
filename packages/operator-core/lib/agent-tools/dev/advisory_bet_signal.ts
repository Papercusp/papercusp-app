/**
 * dev:advisory_bet_signal — the instrument that can SETTLE the partition-advisory
 * bet, in either direction.
 *
 * Plan `dry-run-for-claims-preview-a-predicate-partition-null-traps-2026-09-20`,
 * P-003. The bet: showing an agent a predicate's PARTITION instead of a bare
 * scalar changes what it concludes. The plan states its own falsifiers, and this
 * tool exists to evaluate them rather than to advocate:
 *
 *   FALSE if the advisory fires regularly and the population-claim correction
 *         rate does not move  — an advisory nobody reads.
 *   FALSE if it fires on <5 queries/week — a trigger too narrow to matter.
 *
 * ⚠ THE TWO SIGNALS ARE NEVER JOINED. Corrections are counted over ALL authored
 * coord traffic, whether or not an advisory preceded them. That independence is
 * the plan's acceptance bar and it is not a stylistic choice: if corrections
 * were only counted downstream of a fire, the pair could never return "it fired
 * constantly and nothing changed", and the instrument would be structurally
 * incapable of condemning the thing it was built to judge.
 *
 * This tool computes NO overall verdict. It reports each falsifier's status —
 * including `indeterminate`, which is the honest answer far more often than
 * either of the other two, and the one a summary scalar would quietly discard.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { countAdvisoryFires, type AdvisoryFireCount } from '../../pg-query-advisory/fires';
import {
  countPopulationClaimCorrections,
  SPEECH_ACT_SQL_PREFILTER,
  type CorrectionReport,
} from '../../coord-lifecycle/population-claim-correction';

/** The plan's own "too narrow to matter" threshold, per week. */
export const TRIGGER_TOO_NARROW_FIRES_PER_WEEK = 5;

const ArgsSchema = z.object({
  /**
   * The boundary between "before" and "after" — normally when the advisory
   * shipped. Defaults to now, which makes both windows "before" and is useful
   * for establishing the baseline before P-002 lands.
   */
  pivot: z.string().optional(),
  windowDays: z.number().int().min(1).max(90).default(7),
});

export interface WindowSpec {
  since: string;
  until: string;
  elapsedHours: number;
  /** False when `until` is in the future — the window has not finished running. */
  complete: boolean;
}

export function windowOf(since: Date, until: Date, now: Date): WindowSpec {
  const effectiveUntil = until.getTime() > now.getTime() ? now : until;
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    elapsedHours:
      Math.max(0, effectiveUntil.getTime() - since.getTime()) / 3_600_000,
    complete: until.getTime() <= now.getTime(),
  };
}

/**
 * Load one window's coord corpus.
 *
 * The database applies the cheap half of the predicate (authored-only, plus the
 * deliberately-broad speech-act prefilter) because a 7-day window is ~60k rows.
 * The `authored` total is counted separately and WITHOUT the prefilter, so the
 * rate's denominator is the real authored population rather than the candidates
 * — dividing corrections by candidates would produce a ratio that rises as the
 * prefilter narrows, which is a metric that measures its own filter.
 */
async function loadWindow(
  workspaceId: string,
  since: string,
  until: string,
): Promise<CorrectionReport & { candidates: number }> {
  const sql = getOrgPg().sql;
  const scope = sql`
    from harness_shared.coord_event_log
   where surface = 'messages'
     and workspace_id = ${workspaceId}
     and ts >= ${since}::timestamptz
     and ts <  ${until}::timestamptz
     and coalesce((body->>'auto')::boolean, false) = false
  `;

  const [{ n: authoredRaw }] = (await sql`select count(*)::bigint as n ${scope}`) as Array<{
    n: string;
  }>;

  const candidates = (await sql`
    select body->>'body' as body, body->>'summary' as summary
      ${scope}
       and body::text ~* ${SPEECH_ACT_SQL_PREFILTER}
  `) as Array<{ body: string | null; summary: string | null }>;

  const report = countPopulationClaimCorrections(
    candidates.map((c) => ({ body: c.body ?? undefined, summary: c.summary ?? undefined })),
  );

  // The prefilter removed non-candidates, so `authored` from the report counts
  // only what was fetched. Replace it with the true population.
  const authored = Number(authoredRaw);
  return {
    ...report,
    authored,
    ratePerAuthored: authored > 0 ? report.corrections / authored : null,
    candidates: candidates.length,
  };
}

export type FalsifierStatus = 'met' | 'not-met' | 'indeterminate';

export interface Falsifier {
  status: FalsifierStatus;
  why: string;
}

export function triggerTooNarrow(after: AdvisoryFireCount, w: WindowSpec): Falsifier {
  if (after.status !== 'measured') {
    return {
      status: 'indeterminate',
      why: `advisory fires are ${after.status}: ${after.reason} — this is NOT a measured zero, so the trigger's width is unknown.`,
    };
  }
  if (w.elapsedHours < 1) {
    return { status: 'indeterminate', why: 'the after-window has barely started.' };
  }
  const perWeek = (after.total / w.elapsedHours) * 168;
  return {
    status: perWeek < TRIGGER_TOO_NARROW_FIRES_PER_WEEK ? 'met' : 'not-met',
    why: `${after.total} fires over ${w.elapsedHours.toFixed(1)}h = ${perWeek.toFixed(1)}/week vs a ${TRIGGER_TOO_NARROW_FIRES_PER_WEEK}/week floor.`,
  };
}

export function noBehaviourChange(
  fires: AdvisoryFireCount,
  before: CorrectionReport,
  after: CorrectionReport,
  afterWindow: WindowSpec,
): Falsifier {
  if (fires.status !== 'measured' || fires.total === 0) {
    return {
      status: 'indeterminate',
      why: 'this falsifier only applies once the advisory is actually firing; it says nothing about an advisory that never fired.',
    };
  }
  if (!afterWindow.complete) {
    return {
      status: 'indeterminate',
      why: 'the after-window is still running; comparing a partial window to a complete one measures elapsed time, not behaviour.',
    };
  }
  if (before.ratePerAuthored === null || after.ratePerAuthored === null) {
    return { status: 'indeterminate', why: 'a window had no authored traffic to divide by.' };
  }
  const delta = after.ratePerAuthored - before.ratePerAuthored;
  const relative = before.ratePerAuthored > 0 ? delta / before.ratePerAuthored : null;
  // A zero BEFORE-rate has no RELATIVE change to compute, but that is not the
  // same as "no change": 0 -> anything positive is the largest movement this
  // metric can express. Deciding from `relative` alone reported that maximal
  // move as 'met' (i.e. the advisory changed nothing), settling the bet in
  // precisely the wrong direction off a degenerate denominator. Fall back to the
  // absolute delta when there is no baseline to be relative to.
  const moved = relative === null ? delta > 0 : Math.abs(relative) >= 0.1;
  return {
    status: moved ? 'not-met' : 'met',
    why: `correction rate per authored message went ${before.ratePerAuthored.toFixed(5)} -> ${after.ratePerAuthored.toFixed(5)}${
      relative === null
        ? ' (no relative change from a zero baseline; compared absolutely)'
        : ` (${(relative * 100).toFixed(1)}%)`
    }; the advisory fired ${fires.total} times over the same window.`,
  };
}

export default defineTool({
  name: 'dev:advisory_bet_signal',
  profile: 'engineer',
  description:
    'Settle the dev:pg_query partition-advisory bet: labelled advisory fire counts and population-claim correction rates over two comparable windows, counted independently, with each of the plan’s falsifiers evaluated.',
  capability: 'intel:read',
  guidance: {
    when: 'Decide whether the partition advisory changed behaviour, or establish the baseline before it ships.',
    notWhen: 'For coord lifecycle bucket percentages use dev:coord_categorize; this measures one specific bet.',
    seeAlso: ['dev:coord_categorize (lifecycle bucket rollup)'],
  },
  // Role-gated, like every sibling dev: diagnostic (pg_query, coord_categorize,
  // state_counter). This is not a typecheck workaround: `requirePrincipal: false`
  // is the literal-typed discriminant that selects defineTool's role-gated
  // overload, whose handler receives a UnifiedToolContext carrying `workspaceId`
  // directly. The principal-gated default exposes identity only as
  // `ctx.principal.workspaceId` (non-optional), which is precisely why the
  // workspace guard below is load-bearing here rather than unreachable.
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'curator', 'judge'],
  args: ArgsSchema,
  async handler(args, ctx) {
    const now = new Date();
    const pivot = args.pivot ? new Date(args.pivot) : now;
    const ms = args.windowDays * 86_400_000;
    const beforeW = windowOf(new Date(pivot.getTime() - ms), pivot, now);
    const afterW = windowOf(pivot, new Date(pivot.getTime() + ms), now);
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) {
      // Both signals are per-workspace. Answering across an unknown scope would
      // pool unrelated fleets into one rate, which reads as a real movement.
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'workspace_required',
              reason:
                'Both counters are workspace-scoped; pass a workspace-scoped session rather than receiving a cross-tenant rate.',
            }),
          },
        ],
      };
    }

    const [firesBefore, firesAfter, corrBefore, corrAfter] = await Promise.all([
      countAdvisoryFires({
        workspaceId,
        since: new Date(beforeW.since),
        until: new Date(beforeW.until),
      }),
      countAdvisoryFires({
        workspaceId,
        since: new Date(afterW.since),
        until: new Date(afterW.until),
      }),
      loadWindow(workspaceId, beforeW.since, beforeW.until),
      loadWindow(workspaceId, afterW.since, afterW.until),
    ]);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            pivot: pivot.toISOString(),
            windows: { before: beforeW, after: afterW },
            comparable: beforeW.complete && afterW.complete,
            // Counted independently. Never joined.
            advisoryFires: { before: firesBefore, after: firesAfter },
            corrections: { before: corrBefore, after: corrAfter },
            falsifiers: {
              triggerTooNarrow: triggerTooNarrow(firesAfter, afterW),
              noBehaviourChange: noBehaviourChange(firesAfter, corrBefore, corrAfter, afterW),
            },
            verdict: null,
            verdictNote:
              'No overall verdict is computed on purpose: the falsifiers are the plan’s, and an indeterminate reading is a real result rather than a missing one.',
          }),
        },
      ],
    };
  },
});
