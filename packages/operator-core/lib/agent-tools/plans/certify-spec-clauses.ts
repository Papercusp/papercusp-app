/**
 * plans:certify-spec-clauses — evaluate spec-test adequacy and file a terminal card for
 * every PASSING clause, in one call.
 *
 * review-system-rework-reduction-2026-09-23 P-005 (absorbs P-006, D-005). This promotes the
 * hand-run recipe `evaluate-spec-test-adequacy-and-emit-terminal-scorecards-when-all-clauses-pass`
 * (4 runs) into a verb. The recipe read evidence, re-derived a `current[]` tuple by hand,
 * called the evaluator, then emitted each draft — and every hand step was a place for the
 * filed card to drift from what the evaluator measured.
 *
 * AUDITOR-REPRODUCIBLE BY CONSTRUCTION: this verb adds no grading logic of its own.
 *   1. It runs the REAL `plans:evaluate-spec-test-adequacy` handler, with no caller-supplied
 *      `current` — freshness comes only from the server's own measurement.
 *   2. It files each passing row's `scorecardDraft` UNEDITED (plus `terminal:true` and an
 *      explicit `acknowledgeExisting:true` retry when the caller requests one) through
 *      `emitScorecardForToolContext`, the exact body of the scorecards:emit handler, so the
 *      card crosses the same exact-replay gate an auditor's replay does. A card this verb
 *      files is therefore one the evaluator has just reproduced.
 * Pinned end to end by scorecards/emit.evaluator-round-trip.test.ts and
 * plans/certify-spec-clauses.test.ts.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { harnessArg } from '../_harness-scope';
import evaluatorTool, { argsSchema as evaluatorArgsSchema } from './evaluate-spec-test-adequacy';
import { PLAN_CLASS_RUBRIC_REFS } from './spec-test-adequacy';
import { emitScorecardForToolContext, scorecardEmitArgs, SCORECARD_EMIT_TIMEOUT_SEC } from '../scorecards/emit';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1),
  classRef: z
    .enum(PLAN_CLASS_RUBRIC_REFS)
    .describe('Existing plan-class standard rubric referenced by the plan acceptance rubric.'),
  workItemIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(2000)).min(1).max(500).optional(),
  specIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  planItemIds: z.array(z.string().regex(/^P-\d{3,}$/)).min(1).max(200).optional(),
  includeDraft: z.boolean().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  dryRun: z.boolean().optional().describe('Grade and report which clauses WOULD be filed, without filing any card.'),
  acknowledgeExisting: z.boolean().optional().describe('Explicitly acknowledge existing independent cards when filing another current-evidence card.'),
});

type EvaluatorRow = {
  specId?: unknown;
  specRevision?: unknown;
  verdict?: unknown;
  wouldBlock?: unknown;
  scorecardDraft?: unknown;
};

type ClauseOutcome = {
  specId: string;
  specRevision: number | null;
  verdict: string;
  wouldBlock: string[];
  card:
    | { status: 'filed' | 'unchanged'; issueId: string | null }
    | { status: 'would-file' }
    | { status: 'not-passing' }
    | { status: 'refused'; code: string | null; error: string };
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export default defineTool({
  name: 'plans:certify-spec-clauses',
  description:
    "Evaluate spec-test adequacy and file a terminal spec-test-adequacy card for every PASSING clause in one call. Runs plans:evaluate-spec-test-adequacy on the server's own measurement, then files each passing draft through the scorecards:emit path, including its exact-replay gate. Clauses that do not pass are reported with their wouldBlock criteria and never filed. dryRun:true reports without filing. If an existing_independent_scorecards refusal calls for a new sample, re-run with acknowledgeExisting:true.",
  guidance: {
    when: 'Certifying spec-covered work before work_items:complete, instead of evaluating and then emitting each draft by hand.',
    notWhen:
      "Reading one clause's ratings without filing — plans:evaluate-spec-test-adequacy. Filing any other rubric — scorecards:emit.",
    chaining: 'plans:bind-spec-evidence → plans:certify-spec-clauses → work_items:complete.',
    returns:
      '{ ok, dryRun, counts, clauses } — ok is true only when the evaluation succeeded and no passing clause was refused. counts = { clauses, passing, filed, unchanged, refused, notPassing }. Each clause row carries specId, specRevision, verdict, wouldBlock and card.status (filed | unchanged | would-file | not-passing | refused, with code and error when refused). When the evaluator itself refuses, ok is false and `evaluator` carries its reply (error, remedy) unchanged.',
    seeAlso: ['plans:evaluate-spec-test-adequacy', 'scorecards:emit'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // Both composed verbs manage their own connections; emit may run for minutes.
  skipWorkspaceTx: true,
  timeoutSec: SCORECARD_EMIT_TIMEOUT_SEC,
  agentRoles: [...COORD_ROLES, 'judge'],
  modality: ['text'],
  args: argsSchema,
  result: z
    .object({
      ok: z.boolean(),
      dryRun: z.boolean(),
      counts: z
        .object({
          clauses: z.number().int(),
          passing: z.number().int(),
          filed: z.number().int(),
          unchanged: z.number().int(),
          refused: z.number().int(),
          notPassing: z.number().int(),
        })
        .optional(),
      clauses: z.array(z.record(z.string(), z.unknown())).optional(),
      evaluator: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const dryRun = args.dryRun === true;
    // Parse through the evaluator's OWN schema so a selector it would reject is rejected
    // here too; no `current` is passed, so freshness is server-measured only.
    const evaluatorArgs = evaluatorArgsSchema.parse({
      ...(args.harness !== undefined ? { harness: args.harness } : {}),
      slug: args.slug,
      classRef: args.classRef,
      ...(args.workItemIds ? { workItemIds: args.workItemIds } : {}),
      ...(args.evidenceRefs ? { evidenceRefs: args.evidenceRefs } : {}),
      ...(args.specIds ? { specIds: args.specIds } : {}),
      ...(args.planItemIds ? { planItemIds: args.planItemIds } : {}),
      ...(args.includeDraft !== undefined ? { includeDraft: args.includeDraft } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      // The drafts this verb files exist only in the evaluator's full body (P-007).
      detail: 'full',
    });
    const evaluated = (await evaluatorTool.handler(evaluatorArgs, ctx)) as { data: Record<string, unknown> };
    const evaluation = evaluated.data;
    if (evaluation.ok !== true) {
      return { data: { ok: false, dryRun, evaluator: evaluation } };
    }

    const rows = Array.isArray(evaluation.rows) ? (evaluation.rows as EvaluatorRow[]) : [];
    const clauses: ClauseOutcome[] = [];
    // Sequential on purpose: scorecards:emit serializes on a per-rubric mutex anyway, and
    // a refusal on one clause must be attributable to that clause alone.
    for (const row of rows) {
      const verdict = typeof row.verdict === 'string' ? row.verdict : 'unknown';
      const wouldBlock = stringList(row.wouldBlock);
      const base = {
        specId: typeof row.specId === 'string' ? row.specId : '(unknown)',
        specRevision: typeof row.specRevision === 'number' ? row.specRevision : null,
        verdict,
        wouldBlock,
      };
      if (verdict !== 'pass' || wouldBlock.length > 0) {
        clauses.push({ ...base, card: { status: 'not-passing' } });
        continue;
      }
      if (dryRun) {
        clauses.push({ ...base, card: { status: 'would-file' } });
        continue;
      }
      const draft =
        row.scorecardDraft && typeof row.scorecardDraft === 'object' && !Array.isArray(row.scorecardDraft)
          ? (row.scorecardDraft as Record<string, unknown>)
          : null;
      const parsed = draft ? scorecardEmitArgs.safeParse({
        ...draft,
        terminal: true,
        ...(args.acknowledgeExisting === true ? { acknowledgeExisting: true } : {}),
      }) : null;
      if (!parsed?.success) {
        clauses.push({
          ...base,
          card: {
            status: 'refused',
            code: 'invalid_evaluator_draft',
            error: draft
              ? `the evaluator's scorecardDraft does not parse as scorecards:emit args: ${parsed?.error.issues
                  .slice(0, 3)
                  .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                  .join('; ')}`
              : 'the evaluator returned a passing row with no scorecardDraft',
          },
        });
        continue;
      }
      const emitted = (await emitScorecardForToolContext(parsed.data, ctx)) as {
        ok?: unknown;
        created?: unknown;
        issueId?: unknown;
        code?: unknown;
        error?: unknown;
      };
      if (emitted.ok === true) {
        clauses.push({
          ...base,
          card: {
            status: emitted.created === false ? 'unchanged' : 'filed',
            issueId: typeof emitted.issueId === 'string' ? emitted.issueId : null,
          },
        });
      } else {
        clauses.push({
          ...base,
          card: {
            status: 'refused',
            code: typeof emitted.code === 'string' ? emitted.code : null,
            error: typeof emitted.error === 'string' ? emitted.error : 'scorecards:emit refused without an error message',
          },
        });
      }
    }

    const count = (status: ClauseOutcome['card']['status']) =>
      clauses.filter((clause) => clause.card.status === status).length;
    const counts = {
      clauses: clauses.length,
      passing: clauses.length - count('not-passing'),
      filed: count('filed'),
      unchanged: count('unchanged'),
      refused: count('refused'),
      notPassing: count('not-passing'),
    };
    return {
      data: {
        ok: counts.refused === 0,
        dryRun,
        slug: evaluation.slug,
        classRef: evaluation.classRef,
        governing: evaluation.governing,
        ...(typeof evaluation.governingNote === 'string' ? { governingNote: evaluation.governingNote } : {}),
        counts,
        clauses,
      },
    };
  },
});
