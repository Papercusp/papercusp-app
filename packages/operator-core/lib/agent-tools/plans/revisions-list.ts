/**
 * plans:revisions — the conversation-linked revision chain for a plan.
 *
 * plan-agent-launch-2026-05-21, Phase 1 (P-004 / D-003).
 *
 * One row per recorded `plans:*` write (the `plan_revisions` spine),
 * newest-first: seq, author, the rationale, the session that produced
 * it, a `+N/-N` diff-stat vs the prior revision, and a timestamp. The
 * conversation-linked counterpart to `plans:history` — which is git
 * commits over the file, coarse and rationale-free (D-003).
 *
 * A plan with no recorded revisions returns an empty chain, not an
 * error (matches `plans:history`). A genuine DB failure is reported
 * as `revisions_unavailable` rather than a misleading empty list.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { listPlanRevisions } from './revisions';
import { resolvePlanScope } from './source';

const argsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .describe('Plan slug (filename stem) whose revision chain to read.'),
  harness: harnessArg,
});

export default defineTool({
  name: 'plans:revisions',
  description:
    'The revision chain for a plan, newest-first — one row per recorded plans:* write: seq, author (agent|human), the rationale, the session that produced it, a +/- diff-stat vs the prior revision, and timestamp. The conversation-linked counterpart to plans:history (git commits). Empty chain when the plan has no recorded revisions yet.',
  guidance: {
    when: "You need a plan's edit history with the *why* — what changed at each revision and the rationale behind it. The basis of the Revisions panel and of the context an agent launched from the plan is seeded with.",
    notWhen:
      'You want raw git commit history of the file — that is plans:history. The current plan body — plans:get.',
    chaining:
      'plans:revisions → plans:revision-diff for one revision patch, or plans:revision-transcript for the conversation behind a revision.',
    seeAlso: [
      'plans:revision-diff (the patch for one revision)',
      'plans:revision-transcript (the authoring conversation)',
      'plans:summarize-revision (backfill a rationale)',
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
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    try {
      // Resolve the full (workspaceId, harnessSlug) scope so the read
      // targets the plan's own workspace spine (audit P-008 / mig 218).
      const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
      const revisions = await listPlanRevisions(args.slug, scope);
      ctxAny.metadata?.({ slug: args.slug, revisionCount: revisions.length });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ revisions }) }],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'revisions_unavailable',
              message: message.slice(0, 400),
              slug: args.slug,
            }),
          },
        ],
        isError: true,
      };
    }
  },
});
