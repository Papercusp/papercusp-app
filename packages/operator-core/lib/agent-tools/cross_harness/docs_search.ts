/**
 * cross_harness:docs_search — keyword search across any harness's docs.
 *
 * For agents outside a harness context (SU engineer, operator, oracle)
 * to search a specific harness's documentation by explicit slug.
 * Title×4, description×2, body×1 ranking, same as docs:search.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { searchDocs, harnessFsAdapter } from '@papercusp/docs-engine';
import { loadHarnessRegistry } from '../../harness-registry';

const argsSchema = z.object({
  harnessSlug: z.string().min(1).describe('Slug of the target harness (e.g. "sheets").'),
  workspaceId: z
    .string()
    .optional()
    .describe('Optional workspace id when the target harness lives in a workspace other than the caller\'s active one.'),
  query: z
    .string()
    .min(2)
    .max(200)
    .describe('Keyword query. Whitespace-separated tokens; tokens <2 chars dropped.'),
  limit: z.number().int().min(1).max(20).default(8).describe('Max hits returned. Default 8.'),
});

export default defineTool({
  name: 'cross_harness:docs_search',
  profile: 'engineer',
  description:
    "Keyword search across any registered harness's documentation by explicit slug. Returns ranked hits (slug, title, description, excerpt). For out-of-harness engineers who need to find content in a specific harness without scanning its outline by hand.",
  guidance: {
    when: 'You have specific terminology in mind and want to find which page in a specific harness covers it. Faster than scanning cross_harness:docs_outline by hand when the section name is non-obvious.',
    notWhen:
      'You are inside a harness — use docs:search, which auto-targets your harness. You do not know which harness to query — list with `harness:list` or `cross_harness:docs_outline` per slug first.',
    chaining:
      'cross_harness:docs_search { harnessSlug, query } → cross_harness:docs_get { harnessSlug, slugs: [top-hit] }.',
    seeAlso: [
      'cross_harness:docs_get (read a matched page)',
      'cross_harness:docs_outline (browse the harness doc tree)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'oracle'],
  modality: ['text'],
  rolesQuota: {
    operator: { perRun: 20 },
  },
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as {
      signal?: AbortSignal;
      metadata?: (d: Record<string, unknown>) => void;
      progress?: (pct: number, msg: string) => void;
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

    const adapter = harnessFsAdapter(project.path, { name: `harness:${args.harnessSlug}` });
    const { harnessSlug: _slug, workspaceId: _ws, ...engineArgs } = args;
    const response = await searchDocs(adapter, engineArgs, {
      ...(ctxAny.signal && { signal: ctxAny.signal }),
      ...(ctxAny.metadata && { metadata: ctxAny.metadata }),
      ...(ctxAny.progress && { progress: ctxAny.progress }),
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ...response, harnessSlug: args.harnessSlug }) }],
    };
  },
});
