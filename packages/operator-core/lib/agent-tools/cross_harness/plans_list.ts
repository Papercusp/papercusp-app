/**
 * cross_harness:plans_list — list plans of any harness by explicit slug.
 *
 * P-013 of per-harness-plans-and-docs-2026-05-23. Mirrors
 * cross_harness:docs_outline: takes an explicit harnessSlug argument,
 * ignores ambient ctx. For SU/operator/oracle agents working outside
 * a single harness who need to inspect another harness's plans.
 *
 * Harness-internal agents should use plans:list, which auto-targets
 * the caller's ctx.harnessSlug.
 *
 * Format logic intentionally mirrors plans:list inline — when P-012
 * lands and the 25 plans:* tools accept plansDir opts, this can call
 * into the shared formatter instead.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readAllPlans, resolveHarnessPlansDir } from '../plans/source';
import { resolveEffectiveStatus } from '../plans/effective-status';
import { ITEM_STATUSES, PLAN_STATUSES } from '../plans/parser';

const argsSchema = z.object({
  harnessSlug: z
    .string()
    .min(1)
    .describe('Slug of the harness whose plans to list (e.g. "sheets", "papercup").'),
  workspaceId: z
    .string()
    .optional()
    .describe(
      "Optional workspace id when the target harness lives in a workspace other than the caller's active one.",
    ),
  status: z
    .enum([...PLAN_STATUSES, 'unknown'] as [string, ...string[]])
    .optional()
    .describe('Filter by plan-level status. "unknown" returns legacy plans only.'),
  includeArchived: z.boolean().optional().describe('Include plans under docs/plans/archive/. Default false.'),
  includeLegacy: z.boolean().optional().describe('Include plans without valid frontmatter. Default true.'),
});

type ListRow = {
  slug: string;
  title: string | null;
  status: string;
  updated: string | null;
  owner: string | null;
  archived: boolean;
  isLegacy: boolean;
  itemCounts: Partial<Record<(typeof ITEM_STATUSES)[number] | 'unknown', number>> | null;
  nextAction: string | null;
};

export default defineTool({
  name: 'cross_harness:plans_list',
  profile: 'engineer',
  description:
    "List plans of any registered harness by explicit slug. For agents operating outside a single harness context who need to query another harness's plans. Read-only — writes go through ambient plans:*.",
  guidance: {
    when: 'You are not inside a harness context (or want to inspect a different harness from outside) and need a directory of that harness\'s plans. Pass harnessSlug explicitly.',
    notWhen:
      'You are already in the target harness (ctx.harnessSlug is set) — use plans:list, which auto-targets your harness.',
    chaining:
      'cross_harness:plans_list { harnessSlug } → cross_harness:plans_get { harnessSlug, slug }.',
    seeAlso: [
      'cross_harness:plans_get (read one plan)',
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
    const resolved = await resolveHarnessPlansDir(args.harnessSlug, {
      ...(workspaceId ? { workspaceId } : {}),
    });
    const opts = { harnessSlug: resolved.harnessSlug, workspaceId: resolved.workspaceId };
    const includeArchived = args.includeArchived === true;
    const includeLegacy = args.includeLegacy !== false;

    const rows: ListRow[] = [];
    for (const { parsed, archived, row } of await readAllPlans({ ...opts, includeArchived })) {
      if (parsed.isLegacy && !includeLegacy) continue;

      let itemCounts: ListRow['itemCounts'] = null;
      if (!parsed.isLegacy) {
        const { items } = resolveEffectiveStatus(parsed);
        const counts: Record<string, number> = {};
        for (const it of items) counts[it.effectiveStatus] = (counts[it.effectiveStatus] ?? 0) + 1;
        itemCounts = counts;
      }

      // WI-7259 (sibling of WI-7246's coord.plans fix): a scheduled-run
      // snapshot copies its parent plan's body verbatim, frontmatter
      // included, so `parsed.frontmatter.status`/`.slug` read the PARENT's
      // identity/lifecycle for every snapshot. Canonical-first from the row;
      // `title`/`owner` stay frontmatter-first (display text, not identity,
      // matching WI-7246's precedent), `updated` canonical-first like
      // WI-7246's own `updated` fix.
      const status = row.status ?? parsed.frontmatter.status ?? (parsed.isLegacy ? 'unknown' : 'draft');
      if (args.status && status !== args.status) continue;

      rows.push({
        slug: row.planSlug,
        title: parsed.frontmatter.title ?? null,
        status,
        updated: row.updated ?? parsed.frontmatter.updated ?? null,
        owner: parsed.frontmatter.owner ?? null,
        archived,
        isLegacy: parsed.isLegacy,
        itemCounts,
        nextAction: parsed.now?.next ?? null,
      });
    }

    ctxAny.metadata?.({
      surface: 'cross_harness',
      harness_slug: args.harnessSlug,
      count: rows.length,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ harnessSlug: args.harnessSlug, plans: rows }),
        },
      ],
    };
  },
});
