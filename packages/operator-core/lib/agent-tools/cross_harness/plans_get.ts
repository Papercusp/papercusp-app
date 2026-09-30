/**
 * cross_harness:plans_get — fetch one plan from any harness by slug.
 *
 * P-013 of per-harness-plans-and-docs-2026-05-23. Mirrors plans:get
 * but takes an explicit harnessSlug arg + ignores ambient ctx.
 *
 * Format logic mirrors plans:get inline (P-012 will extract shared
 * formatters when the 25 plans:* tools migrate to per-harness opts).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readPlanBySlug, resolveHarnessPlansDir } from '../plans/source';
import { resolveEffectiveStatus } from '../plans/effective-status';
import { hashPlanContent } from '../plans/content-hash';

const argsSchema = z.object({
  harnessSlug: z.string().min(1).describe('Slug of the harness whose plan to fetch.'),
  workspaceId: z
    .string()
    .optional()
    .describe("Optional workspace id when the target harness lives in a workspace other than the caller's active one."),
  slug: z
    .string()
    .min(1)
    .describe('Plan slug (filename stem). Resolves both docs/plans/ and docs/plans/archive/ for the target harness.'),
});

export default defineTool({
  name: 'cross_harness:plans_get',
  profile: 'engineer',
  description:
    "Fetch the full parsed structure of one plan in any harness by explicit slug: frontmatter, ## Now, items with effectiveStatus, decisions. Read-only.",
  guidance: {
    when: 'You have a slug + harness from cross_harness:plans_list (or know both directly) and need the plan contents.',
    notWhen:
      'You are inside the target harness (ctx.harnessSlug is set) — use plans:get, which auto-targets your harness.',
    chaining:
      'cross_harness:plans_list → cross_harness:plans_get { harnessSlug, slug }.',
    seeAlso: [
      'cross_harness:plans_list (find the plan slug in that harness)',
      'cross_harness:plans_search (find a plan by term)',
    ],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'oracle'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as {
      metadata?: (d: Record<string, unknown>) => void;
      workspaceId?: string;
    };
    const workspaceId = args.workspaceId ?? (ctxAny.workspaceId !== '*' ? ctxAny.workspaceId : undefined);
    // Validate the harness is registered (throws if not) + resolve its workspace.
    const dirs = await resolveHarnessPlansDir(args.harnessSlug, {
      ...(workspaceId ? { workspaceId } : {}),
    });

    const result = await readPlanBySlug(args.slug, {
      harnessSlug: dirs.harnessSlug,
      workspaceId: dirs.workspaceId,
    });
    if (!result) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: 'not_found', harnessSlug: args.harnessSlug, slug: args.slug }),
          },
        ],
        isError: true,
      };
    }
    const { parsed, archived, row } = result;
    ctxAny.metadata?.({
      surface: 'cross_harness',
      harness_slug: args.harnessSlug,
      slug: args.slug,
      archived,
      legacy: parsed.isLegacy,
    });

    if (parsed.isLegacy) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              harnessSlug: args.harnessSlug,
              slug: parsed.slug,
              archived,
              legacy: true,
              prose: parsed.prose,
              raw: parsed.raw,
              contentHash: hashPlanContent(parsed.raw),
              filename: parsed.filename,
            }),
          },
        ],
      };
    }

    const resolved = resolveEffectiveStatus(parsed);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            harnessSlug: args.harnessSlug,
            // WI-7259 (sibling of WI-7246): a scheduled-run snapshot copies its
            // parent plan's body verbatim, frontmatter included — so
            // `parsed.frontmatter.slug` reads the PARENT's slug for every
            // snapshot. `row.planSlug` is the column this row was looked up BY.
            slug: row.planSlug,
            archived,
            legacy: false,
            frontmatter: parsed.frontmatter,
            now: parsed.now,
            items: resolved.items,
            decisions: parsed.decisions,
            missingRefs: resolved.missingRefs,
            cycleMembers: resolved.cycleMembers,
            prose: parsed.prose,
            raw: parsed.raw,
            contentHash: hashPlanContent(parsed.raw),
          }),
        },
      ],
    };
  },
});
