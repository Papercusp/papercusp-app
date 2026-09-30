/**
 * List tasks across the workspace, optionally filtered by status, goal,
 * or harness. Summary returns id + title + status; full returns the row.
 *
 * The query uses a bounded projection and therefore infers its result directly;
 * it does not need to instantiate a Zod schema for the entire generated view.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { generated } from '@papercusp/db-org';
import { defineTool } from '@papercusp/tooldef';

const features = generated.harnessFeaturesConsolidatedInHarnessShared;

export default defineTool({
  name: 'tasks:list',
  needsWorkspaceTx: true,
  capability: 'tasks:read',
  guidance: {
    when: 'User asks "what tasks do I have?", "what\'s on my plate", or you need a task id before calling `tasks:get`.',
    notWhen: 'For ONE task by id, use `tasks:get`. For creating a task, use `tasks:create`. For PROJECTS / FEATURES (work the harness is doing), use `harness:*` — tasks are separate from harness features.',
    chaining: 'Pair with `tasks:get` for detail on a specific row.',
  },
  args: z.object({
    detail: z.enum(['summary', 'full']).default('summary'),
    status: z.string().optional(),
    goalId: z.string().optional(),
    harnessSlug: z.string().optional(),
    limit: z.number().int().positive().max(200).default(50),
    cursor: z.string().optional(),
  }),
  // Output schema (token-efficient-tool-result-formats P-013) — flat scalar
  // array (default `summary` shape) → unlocks CSV + outputSchema advertisement.
  result: z.array(
    z.object({
      harnessSlug: z.string().nullable(),
      id: z.string(),
      title: z.string(),
      status: z.string().nullable(),
    }),
  ),
  async handler(args, ctx) {
    const txDb = drizzle(ctx.tx);
    const preds = [
      args.harnessSlug ? eq(features.harnessSlug, args.harnessSlug) : undefined,
      args.status ? eq(features.status, args.status) : undefined,
      args.goalId ? eq(features.goalId, args.goalId) : undefined,
    ].filter((p): p is NonNullable<typeof p> => p !== undefined);

    const rows = (await txDb
      .select({
        harness_slug: features.harnessSlug,
        feature_id: features.featureId,
        title: features.title,
        summary: features.summary,
        status: features.status,
        updated_ts: features.updatedTs,
        attempts: features.attempts,
        kind: features.kind,
        project_id: features.projectId,
        expected_cost_cents: features.expectedCostCents,
        goal_id: features.goalId,
      })
      .from(features)
      .where(preds.length ? and(...preds) : undefined)
      .orderBy(desc(features.updatedTs))
      .limit(args.limit));

    if (args.detail === 'summary') {
      return {
        data: rows.map((r) => ({
          harnessSlug: r.harness_slug,
          id: r.feature_id,
          title: r.title,
          status: r.status,
        })),
      };
    }
    return { data: rows };
  },
});
