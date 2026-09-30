/**
 * scorecards:list — read structured rubric scorecards back
 * (plan-templates-and-rubric-v2-2026-06-20 P-013 / D-005).
 *
 * The READ side of the every-turn Overwatch scorecard. Until this tool, a
 * scorecard (a rubric-graded structured observation on
 * engineer_issues.payload.observation) was WRITE-ONLY — emission gaps + partial
 * scorecards were invisible except via raw PG. This is the linchpin the
 * monitoring layer builds on: P-010 (trend) aggregates over it, P-014
 * (emission-freshness + completeness) reads it, and the Overwatch's own
 * turn-over-turn self-comparison needs it.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { DbCallDeadlineError } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { listScorecardPage } from '../../scorecards';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';

export default defineTool({
  name: 'scorecards:list',
  profile: 'engineer',
  description:
    'Read rubric scorecards (rubricRef + per-criterion ratings/evidence), newest-first. Filter by rubricRef, sourceHive, scalar subjectRef, and since. Unlike scorecards:emit\'s structured subject:{kind,ref}, subjectRef is observation.subject.ref (for example a WI-/EI- id). Spec-quality refs are composite `spec-set:<classRef>:<specSetHash>:<planKey>`, not a plan or pot slug; get the exact ref from a scorecard or evaluator. Synthesized floor cards are excluded; pass includeSynthesized:true to include them.',
  guidance: {
    when: 'Read emitted scorecards for trend/freshness and completeness. Filter by scalar `subjectRef` (stored observation.subject.ref), not emit\'s `subject:{kind,ref}`; spec-quality uses exact composite `spec-set:<classRef>:<specSetHash>:<planKey>` subject ref, not a plan slug.',
    notWhen:
      'Need a rubric definition — rubrics:get/list; cross-corpus ideation rollup — curation:state-of-pot; or filing a scorecard — scorecards:emit.',
    chaining:
      'scorecards:list { rubricRef, subjectRef: "EI-123", since } → inspect missingKeys/ratings → drill row with work_items:get { id: issueId } or rubric criteria with rubrics:get { rubricRef }.',
    returns:
      'Rows include ratings, synthesized, nKeys, missingKeys; `ratings`, `gradedGeneration`, and `generationFreshness` are nested OBJECTS, not scalars (`generationFreshness` only appears with `gradedGeneration`), so flat/CSV projection fails. `count` is page size; `hasMore`/`truncatedByLimit` signal a capped page.',
    seeAlso: [
      'scorecards:freshness (staleness / partial-emit summary)',
      'scorecards:evaluate (typed grading skeleton + evidence delta)',
      'scorecards:emit (validated scorecard write)',
      'rubrics:trend (criteria trend over time)',
      'rubrics:get (the rubric criterion definitions)',
    ],
  },
  // EI-21437537919383948: this is a correctness read, not a browseable list.
  // Each row carries the complete per-criterion ratings/evidence map; allowing
  // the ambient trimmed session tier to reshape that nested map can turn a
  // 4-of-7 scorecard into an apparently complete 4-criterion card. Keep the
  // result-door spill lossless (the explicit hard ceiling still applies), just
  // as scorecards:evaluate and rubrics:get do for their correctness payloads.
  ignoreSessionPayloadTier: true,
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES, 'judge'],
  args: z.object({
    rubricRef: z
      .string()
      .optional()
      .describe('restrict to one rubric, e.g. "pot-coordination-health"; omit for all rubric-graded scorecards'),
    sourceHive: z.string().optional().describe('restrict to scorecards from one source-hive'),
    harness: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'Optional caller scope hint accepted for compatibility; scorecard history is workspace-scoped and this hint does not filter the read.',
      ),
    subjectRef: z
      .string()
      .optional()
      .describe(
        'restrict to scorecards GRADING one subject (observation.subject.ref) — the per-RUN axis: an agent ownerId, session id, WI-/EI- id, or rubric-defined subject identity. Use for a per-run rubric (e.g. goal-mode-e2e) where sourceHive only says which pot. For spec-quality and other plan-spec rubrics, this is the exact composite `spec-set:<classRef>:<specSetHash>:<planKey>` ref, not the plan or pot slug; obtain it from an existing scorecard or evaluator output. Absent on pre-2026-08-10 scorecards, which recorded no subject.',
      ),
    since: z
      .string()
      .optional()
      .describe('ISO timestamp — only scorecards filed at/after this (the time-window); omit for all'),
    limit: z.number().int().positive().max(500).optional().describe('max rows, newest-first (default 100, max 500)'),
    includeSynthesized: z
      .boolean()
      .optional()
      .describe(
        'also return SYNTHESIZED floor scorecards (turn-end backstop + scheduled-pulse). Default false — agent-emission reads exclude floors; pass true to verify the data layer itself (e.g. is the pulse filing while overwatch is paused?)',
      ),
    includeSuperseded: z
      .boolean()
      .optional()
      .describe('Audit view: also include scorecards replaced by a later payload-native supersedes filing.'),
    includeRetracted: z
      .boolean()
      .optional()
      .describe('Audit view: also include deliberately retracted scorecards and their withdrawal metadata.'),
  }),
  result: z
    .object({
      ok: z.boolean().optional(),
      count: z.number().int().nonnegative().optional(),
      hasMore: z.boolean().optional(),
      truncatedByLimit: z.boolean().optional(),
      scorecards: z.array(z.unknown()).optional(),
      error: z.string().optional(),
      retryable: z.boolean().optional(),
      pgCode: z.string().optional(),
      message: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    return runWithWorkspaceIfConcrete(identity.workspaceId ?? undefined, async () => {
      try {
        const page = await listScorecardPage({
          rubricRef: args.rubricRef,
          sourceHive: args.sourceHive,
          subjectRef: args.subjectRef,
          since: args.since,
          limit: args.limit,
          includeSynthesized: args.includeSynthesized,
          includeSuperseded: args.includeSuperseded,
          includeRetracted: args.includeRetracted,
          // WI-6124: links are opt-IN. This tool returns whole rows to an agent, so it is a
          // surfacing read — keep it true or agents silently see every scorecard as unlinked.
          includeLinks: true,
        });
        return {
          data: {
            ok: true,
            count: page.rows.length,
            hasMore: page.hasMore,
            truncatedByLimit: page.hasMore,
            scorecards: page.rows,
          },
        };
      } catch (error) {
        // EI-21592547181442895: an exhausted, transient read contention sequence is
        // actionable to callers and must not degrade into generic handler_error.
        if (error instanceof OrgTxnTimeoutError || error instanceof DbCallDeadlineError) {
          return {
            data: {
              ok: false,
              error: 'timeout',
              retryable: true,
              ...(error instanceof OrgTxnTimeoutError ? { pgCode: error.pgCode } : {}),
              message:
                `scorecards:list read hit transient database contention: ${error.message}. ` +
                'No scorecards were returned; retry shortly.',
            },
          };
        }
        throw error;
      }
    });
  },
});
