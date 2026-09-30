/**
 * Get a single harness by slug.
 *
 * Summary returns slug + status + name + last activity. Full returns
 * the entire `harness_shared.projects` row plus aggregate feature counts.
 *
 * Typed via `schemaOf(projects).select`.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { generated, schemaOf } from '@papercusp/db-org';
import { defineTool } from '@papercusp/tooldef';
import { readRegistryProjects, type SqlLike } from './registry-read';

const projects = generated.projectsInHarnessShared;
const features = generated.harnessFeaturesConsolidatedInHarnessShared;
const ProjectSelect = schemaOf(projects).select;
type ProjectRow = z.infer<typeof ProjectSelect>;

export default defineTool({
  name: 'harness:get',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'harness:read',
  guidance: {
    when: 'User asks about a specific harness by name ("tell me about sheets", "what\'s the status of forms") and you need its row + feature counts.',
    notWhen: 'For a list of all harnesses, use `harness:list`. For LIVE health (escalated/blocked), prefer `harness:status` or `coord:escalations` — `harness:get` is the static record.',
    chaining: 'Follow `harness:list` if you don\'t have the slug. Follow with `harness:status` if you also need live counts.',
  },
  args: z.object({
    slug: z.string().min(1),
    detail: z.enum(['summary', 'full']).default('summary'),
  }),
  async handler(args, ctx) {
    const txDb = drizzle(ctx.tx);
    const rows = (await txDb
      .select()
      .from(projects)
      .where(eq(projects.slug, args.slug))
      .limit(1)) as ProjectRow[];
    if (!rows.length) {
      // EI-1834: harness:get is a PROJECT lookup — a registered HIVE (or any non-project
      // harness_kind) has no projects row, so a bare "not found" is AMBIGUOUS: it conflates
      // "no such harness" with "exists, but not as a project". That ambiguity once misled a
      // live diagnosis (a correct papercup→papercusp migration root-cause was retracted
      // because the newly-merged hive read as "not found"). Check the harness REGISTRY (the
      // store-of-record for WHICH harnesses exist, hives included) and, when the slug is
      // there, report its kind — so the caller never reads "not found" as "doesn't exist".
      // Best-effort: a registry read failure falls back to the plain miss.
      const ws = ctx.principal?.workspaceId ?? '';
      const reg = (await readRegistryProjects(ctx.tx as SqlLike, ws).catch(() => [])).find(
        (p) => p.slug === args.slug,
      );
      if (reg) {
        const kind = reg.harness_kind ?? 'unknown';
        const surface = kind === 'hive' ? 'hives' : 'non-project harness kinds';
        const inspect = kind === 'hive' ? 'harness:list or pot:get' : 'harness:list';
        return {
          data: null,
          degraded: true,
          degradedReasons: [
            `harness '${args.slug}' EXISTS in the registry as harness_kind='${kind}', but has no projects row — ` +
              `harness:get is a PROJECT lookup and does not surface ${surface}. It is registered; inspect it via ${inspect}. ` +
              `Do NOT read this as "no such harness".`,
          ],
        };
      }
      return {
        data: null,
        degraded: true,
        degradedReasons: [
          `harness '${args.slug}' not found (no projects row and no harness registry entry). ` +
            `harness:get is a PROJECT lookup; if you expect a hive or other non-project harness, confirm with harness:list.`,
        ],
      };
    }
    const row = rows[0];
    if (args.detail === 'summary') {
      return {
        data: {
          slug: row.slug,
          name: row.name,
          status: row.status,
          updated_ts: row.updatedTs,
        },
      };
    }
    const counts = await txDb
      .select({ status: features.status, n: count() })
      .from(features)
      .where(eq(features.harnessSlug, args.slug))
      .groupBy(features.status);
    const featureCounts: Record<string, number> = {};
    for (const c of counts) {
      if (c.status != null) featureCounts[c.status] = Number(c.n);
    }
    return { data: { ...row, featureCounts } };
  },
});
