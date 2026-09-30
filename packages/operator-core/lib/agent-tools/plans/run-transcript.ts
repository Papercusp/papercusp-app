/**
 * plans:run-transcript — paginated read of a plan run's transcript.
 *
 * plan-agent-launch-2026-05-21, Phase 5 (P-023).
 *
 * The data behind the Agents-tab run-detail view. Mirrors the shape
 * of `plans:revision-transcript` (P-008) — scoped (paginated +
 * substring filter, never a whole dump per D-002) — but takes a
 * `runId` and reads directly from `plan_run_turns` for that run.
 *
 * Unknown runId → `error: 'unknown_run'`.
 * DB failure   → `error: 'run_transcript_unavailable'`.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getPlanRun, readPlanRunTranscript } from './runs';

const argsSchema = z.object({
  runId: z.coerce
    .number()
    .int()
    .positive()
    .describe('plan_runs.id (from plans:runs) whose transcript to read.'),
  query: z
    .string()
    .optional()
    .describe('Case-insensitive substring filter over turn content.'),
  cursor: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Return turns after this seq — pass back the prior nextCursor.'),
  limit: z.coerce
    .number()
    .int()
    .optional()
    .describe('Page size (default 20, max 100).'),
});

export default defineTool({
  name: 'plans:run-transcript',
  description:
    "A paginated slice of a plan run's transcript — turns ordered by seq; substring-filterable, never a whole dump. The data behind the Agents-tab run-detail view.",
  guidance: {
    when: 'You want to inspect the back-and-forth of an existing run — e.g. find a specific turn before resuming.',
    notWhen:
      'You want the run launches list (plans:runs), the conversation behind a plan revision (plans:revision-transcript), or to continue the run (plans:resume).',
    chaining:
      'plans:runs → plans:run-transcript { runId } → page with cursor.',
    seeAlso: [
      'plans:runs (find the runId)',
      'plans:resume (continue the run)',
    ],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    try {
      const run = await getPlanRun(args.runId);
      if (!run) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'unknown_run',
                runId: args.runId,
              }),
            },
          ],
        };
      }
      const page = await readPlanRunTranscript(run.sessionId, {
        query: args.query,
        cursor: args.cursor,
        limit: args.limit,
      });
      ctxAny.metadata?.({
        runId: args.runId,
        turnCount: page.turns.length,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              runId: run.id,
              planSlug: run.planSlug,
              sessionId: run.sessionId,
              status: run.status,
              planContentHash: run.planContentHash,
              triggerRun: run.triggerRun ?? null,
              turns: page.turns,
              nextCursor: page.nextCursor,
              query: args.query ?? null,
            }),
          },
        ],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'run_transcript_unavailable',
              message: message.slice(0, 400),
              runId: args.runId,
            }),
          },
        ],
      };
    }
  },
});
