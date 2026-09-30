/**
 * features:get — fetch one OR many features by (harness slug, feature id).
 *
 * Returns the full row from `harness_shared.harness_features_consolidated`.
 * For agent use when prompt-injected feature history was capped or when
 * inspecting a non-current feature (cross-feature exploration).
 *
 * Typed from the view's direct Drizzle select shape. Do not round-trip the
 * entire generated view through drizzle-zod merely to recover the row type:
 * TypeScript 7 correctly reaches its instantiation-depth guard on that graph.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): the feature key is the COMPOUND
 * `(slug, feature_id)`. Pass a single `{ slug, feature_id }` for n=1, or
 * `items:[{ slug, feature_id }]` for many → { ok, results:[{ ok, slug,
 * feature_id, feature? | error }], counts }. Each result self-describes its
 * (slug, feature_id), so a not-found / invalid-slug item never poisons the rest
 * and the agent correlates by key (not array position).
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { generated } from '@papercusp/db-org';
import { defineTool } from '@papercusp/tooldef';
// The bulk helpers' LEAF module — relative, NOT the '@papercusp/agent-mcp'
// barrel: the barrel re-exports through index.ts, an ESM circular-init that
// leaves runBulk/bulkContent undefined at runtime, AND the package-subpath
// self-reference fails the production build's `node` moduleResolution. The
// relative leaf resolves under both and dodges the cycle.
import { runBulk, bulkContent } from '../../_bulk';

const features = generated.harnessFeaturesConsolidatedInHarnessShared;
type FeatureRow = typeof features.$inferSelect;

const SLUG_RE = /^[a-z0-9._-]+$/i;

const FeatureKey = z.object({
  slug: z.string().min(1),
  feature_id: z.string().min(1),
});

export default defineTool({
  name: 'features:get',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'features:read',
  description:
    'Fetch one OR many features by (harness slug, feature id) in ONE call — pass `{ slug, feature_id }` for one or `items:[{ slug, feature_id }]` for several. Returns { ok, results:[{ ok, slug, feature_id, feature? | error }], counts } — correlate each result by its (slug, feature_id), not by position; a missing / invalid-slug item comes back as that item\'s { ok:false } without failing the rest.',
  guidance: {
    when: 'User names a specific feature ("the auth one", "F-AUTH-001") and you need its body / acceptance criteria. Pass every (slug, feature_id) you need at once via `items`.',
    notWhen: 'For a list of features in a harness, use `harness:list_features`. For changes over time, use `features:history`.',
    chaining: 'Follow `harness:list_features` or `features:search` to find the id. Bulk: single { slug, feature_id } | items[] → { ok, results, counts }; correlate by (slug, feature_id) not position; one failure never fails the rest.',
  },
  args: z
    .object({
      slug: z.string().min(1).optional().describe('a single feature\'s harness slug (n=1 shorthand, paired with feature_id)'),
      feature_id: z.string().min(1).optional().describe('a single feature id (n=1 shorthand, paired with slug)'),
      items: z.array(FeatureKey).min(1).max(100).optional().describe('feature keys to fetch (1–100), each { slug, feature_id }'),
    })
    .refine((a) => Boolean(a.items?.length) || (Boolean(a.slug) && Boolean(a.feature_id)), {
      message: 'pass `{ slug, feature_id }` (one) or `items:[{ slug, feature_id }]` (many)',
    }),
  async handler(args, ctx) {
    const keys =
      args.items?.length
        ? args.items
        : [{ slug: args.slug!, feature_id: args.feature_id! }];
    const txDb = drizzle(ctx.tx);
    const env = await runBulk(
      keys,
      async ({ slug, feature_id }) => {
        if (!SLUG_RE.test(slug)) {
          return { ok: false as const, slug, feature_id, error: `invalid slug ${JSON.stringify(slug)}` };
        }
        const rows = (await txDb
          .select()
          .from(features)
          .where(and(eq(features.harnessSlug, slug), eq(features.featureId, feature_id)))
          .limit(1)) as FeatureRow[];
        if (!rows.length) {
          return { ok: false as const, slug, feature_id, error: `feature ${feature_id} not found in harness ${slug}` };
        }
        return { ok: true as const, slug, feature_id, feature: rows[0] };
      },
      { keyOf: ({ slug, feature_id }) => ({ slug, feature_id }) },
    );
    return bulkContent(env);
  },
});
