/**
 * cross_harness:docs_outline — outline of any harness's docs by slug.
 *
 * For agents outside any harness context (SU engineer, operator,
 * oracle) who need to inspect a specific harness's docs. Takes an
 * explicit harnessSlug argument; ignores any ambient ctx.harnessSlug.
 *
 * Harness-internal agents (workers, scopers, validators, etc.) should
 * use docs:outline instead — same shape, no slug arg needed.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  buildOutline,
  harnessFsAdapter,
  RunCache,
  type OutlinePayload,
} from '@papercusp/docs-engine';
import { loadHarnessRegistry } from '../../harness-registry';

const cache = new RunCache<OutlinePayload>();

const argsSchema = z.object({
  harnessSlug: z
    .string()
    .min(1)
    .describe('Slug of the harness whose docs to outline (e.g. "sheets", "papercup-org").'),
  workspaceId: z
    .string()
    .optional()
    .describe('Optional workspace id when the target harness lives in a workspace other than the caller\'s active one. SU agents (admin across all workspaces) pass this; operator/oracle agents in a single workspace leave it unset.'),
});

export default defineTool({
  name: 'cross_harness:docs_outline',
  profile: 'engineer',
  description:
    "Outline of any registered harness's documentation by explicit slug. For engineers operating outside a harness context who need to query a specific harness's docs. Per-run cached.",
  guidance: {
    when: 'You are not inside a harness context (no spawn URL harness slug) but need a specific harness\'s documentation. Pass harnessSlug explicitly.',
    notWhen:
      'You are already inside a harness (ctx.harnessSlug is set) — use docs:outline instead, which auto-targets your harness.',
    chaining:
      'cross_harness:docs_outline { harnessSlug } → cross_harness:docs_get { harnessSlug, slugs }.',
    seeAlso: [
      'cross_harness:docs_get (read the slugs the outline lists)',
      'cross_harness:docs_search (find a page by term)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'oracle'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as {
      runId?: string;
      spawnId?: string;
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

    const hit = cache.get(ctxAny, args.harnessSlug);
    if (hit) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...hit, cached: true, harnessSlug: args.harnessSlug }) }],
      };
    }

    const adapter = harnessFsAdapter(project.path, { name: `harness:${args.harnessSlug}` });
    const payload = await buildOutline(adapter, {
      ...(ctxAny.runId !== undefined && { runId: ctxAny.runId }),
      ...(ctxAny.spawnId !== undefined && { spawnId: ctxAny.spawnId }),
      ...(ctxAny.signal && { signal: ctxAny.signal }),
      ...(ctxAny.metadata && { metadata: ctxAny.metadata }),
    });
    cache.set(ctxAny, payload, args.harnessSlug);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ...payload, cached: false, harnessSlug: args.harnessSlug }) }],
    };
  },
});
