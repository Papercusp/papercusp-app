/**
 * plans:get-template-data — read a plan's template TYPE + its STRUCTURED instance
 * data (the `template_data` jsonb), WITHOUT loading/parsing the markdown
 * (plan-templates-and-rubric-v2-2026-06-20 P-005).
 *
 * The structured read complement of plans:set-template-data: agents consume a
 * template-instance plan's data structured, never by scraping markdown. Returns the
 * `template` type (frontmatter-derived column), the `template_data` jsonb (null
 * until set), and the row `version`. Read-only.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getPlanRow } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { bulkContent, mergeIds, runBulk } from '../_bulk';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).optional().describe('Plan slug (filename stem).'),
  slugs: z.array(z.string().min(1)).min(1).max(100).optional().describe('Plan slugs to read in one call.'),
}).refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
  message: 'pass `slug` or `slugs`',
});

export default defineTool({
  name: 'plans:get-template-data',
  description:
    "Read a plan's template TYPE + its STRUCTURED instance data (the `template_data` jsonb) — the structured read complement of plans:set-template-data, without parsing the markdown. Returns { template, templateData, version }; templateData is null until set. Read-only.",
  guidance: {
    when: 'Reading a template-instance plan\'s structured data (e.g. a rubric instance\'s fields) to consume it programmatically — never scrape it out of the markdown.',
    notWhen:
      'You need the whole plan (Now / items / decisions / prose) — plans:get. Writing the data — plans:set-template-data. Listing plans of a template type — plans:list { template }.',
    chaining: 'plans:get-template-data { slug } → plans:set-template-data { slug, data } to update it.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  // + overwatch (read-only, like plans:get-item) so the supervisor can ground on template instances.
  agentRoles: [...SU_ROLES, 'kettle'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);
    const slugs = mergeIds(args.slug, args.slugs);
    const env = await runBulk(
      slugs,
      async (slug) => {
        const row = await getPlanRow(slug, opts);
        if (!row) return { ok: false as const, slug, error: 'not_found' };
        return {
          ok: true as const,
          slug: row.planSlug,
          template: row.template,
          templateData: row.templateData ?? null,
          version: row.version,
        };
      },
      { keyOf: (slug) => ({ slug }) },
    );
    return bulkContent(env);
  },
});
