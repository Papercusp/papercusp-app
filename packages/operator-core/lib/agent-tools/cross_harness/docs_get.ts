/**
 * cross_harness:docs_get — fetch any harness's doc pages by explicit slug.
 *
 * Same shape as docs:get but takes a required harnessSlug arg so
 * out-of-harness agents (SU engineer, operator, oracle) can query
 * any registered harness's docs.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getDocs, harnessFsAdapter, withPreamble } from '@papercusp/docs-engine';
import { loadHarnessRegistry } from '../../harness-registry';

const argsSchema = z
  .object({
    harnessSlug: z.string().min(1).describe('Slug of the target harness (e.g. "sheets").'),
    workspaceId: z
      .string()
      .optional()
      .describe('Optional workspace id when the target harness lives in a workspace other than the caller\'s active one.'),
    slugs: z
      .array(z.string().min(1))
      .min(1)
      .max(10)
      .describe('1–10 page slugs from cross_harness:docs_outline.'),
    heading: z
      .string()
      .optional()
      .describe('Heading anchor id. Only honored when slugs.length === 1.'),
  })
  .refine((v) => !v.heading || v.slugs.length === 1, {
    message: 'heading is only valid when slugs has exactly one entry',
    path: ['heading'],
  });

export default defineTool({
  name: 'cross_harness:docs_get',
  profile: 'engineer',
  description:
    "Fetch documentation pages from any registered harness by explicit slug. Batch up to 10; pass `heading` (single-slug only) for a section slice. Per-slug error envelope.",
  guidance: {
    when: 'You have slugs from cross_harness:docs_outline and need the page contents from a specific harness (named by harnessSlug arg).',
    notWhen:
      'You are inside a harness — use docs:get, which auto-targets your harness.',
    chaining:
      'cross_harness:docs_outline { harnessSlug } → cross_harness:docs_get { harnessSlug, slugs } → optionally re-fetch with { harnessSlug, slugs: [picked], heading } for surgical reads.',
    seeAlso: [
      'cross_harness:docs_outline (find slugs in that harness to read)',
      'cross_harness:docs_search (locate the right page by term)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'oracle'],
  modality: ['text'],
  rolesQuota: {
    operator: { perRun: 15 },
  },
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as {
      signal?: AbortSignal;
      metadata?: (d: Record<string, unknown>) => void;
    };
    const reg = await loadHarnessRegistry(args.workspaceId);
    const project = reg.projects.find((p) => p.slug === args.harnessSlug);
    if (!project) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ error: 'harness_not_registered', slug: args.harnessSlug }) },
        ],
        isError: true,
      };
    }
    ctxAny.metadata?.({ surface: 'cross_harness', harness_slug: args.harnessSlug });

    const base = harnessFsAdapter(project.path, { name: `harness:${args.harnessSlug}` });
    const adapter = {
      ...base,
      async getContent(page: Parameters<typeof base.getContent>[0]) {
        const body = await base.getContent(page);
        return withPreamble(body, {
          title: page.title,
          url: page.url,
          ...(page.description ? { description: page.description } : {}),
        });
      },
    };

    const { harnessSlug: _unusedSlug, workspaceId: _unusedWs, ...engineArgs } = args;
    const response = await getDocs(adapter, engineArgs, {
      ...(ctxAny.signal && { signal: ctxAny.signal }),
      ...(ctxAny.metadata && { metadata: ctxAny.metadata }),
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ...response, harnessSlug: args.harnessSlug }) }],
    };
  },
});
