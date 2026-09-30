/**
 * plans:revision-diff — unified diff between a revision and its
 * predecessor, sourced from the `plan_revisions` snapshot pair.
 *
 * plan-agent-launch-2026-05-21, Phase 4 (P-018).
 *
 * The conversation-linked counterpart to `plans:diff` (which is the
 * git-backed coarse view, D-003). Sources the patch from the two
 * `content_snapshot` rows — no `git diff` shell-out, no working-tree
 * coupling. Reads two rows in one query (`getPlanRevisionPairById`).
 *
 * - seq 1 returns the file-against-empty patch (the original creation
 *   diff) — `older` is `null`.
 * - Unknown `revisionId` returns `error: 'unknown_revision'` (not 404
 *   — same MCP envelope as the other plans:* verbs).
 * - DB failure returns `error: 'revision_diff_unavailable'`.
 *
 * Output is a standard unified-diff string consumable by
 * `react-diff-view`'s `parseDiff` — exactly what `plans:diff` returns.
 */

import { createPatch } from 'diff';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { resolvePlanScope } from './source';
import { getPlanRevisionPairById, type PlanRevisionPair } from './revisions';

const argsSchema = z.object({
  // z.coerce so the same schema accepts a numeric MCP arg AND a
  // string from `?revisionId=…` on the admin route.
  revisionId: z.coerce
    .number()
    .int()
    .positive()
    .describe('The plan_revisions row id (from plans:revisions.id) to diff against its predecessor.'),
  harness: harnessArg,
});

/**
 * Build the unified-diff string for one revision pair. Pure — split
 * out for unit testing. `pair.older === null` means seq 1; we diff
 * against an empty string so the modal still renders something
 * meaningful (every line shown as added).
 */
export function buildRevisionDiffText(pair: PlanRevisionPair): string {
  const filename = `${pair.newer.planSlug}.md`;
  const olderLabel = pair.older ? `revision #${pair.older.seq}` : '(empty)';
  const newerLabel = `revision #${pair.newer.seq}`;
  return createPatch(
    filename,
    pair.older?.contentSnapshot ?? '',
    pair.newer.contentSnapshot,
    olderLabel,
    newerLabel,
  );
}

export default defineTool({
  name: 'plans:revision-diff',
  description:
    "Unified diff between a plan revision and its immediate predecessor — sourced from the plan_revisions snapshot pair, not git. Returns a `react-diff-view`-parseable patch string. Seq 1 returns the file-against-empty creation diff.",
  guidance: {
    when: 'You have a revisionId from plans:revisions and want the patch — what exactly changed in that revision.',
    notWhen:
      'You want a coarse git patch — that is plans:diff. The revision chain — plans:revisions. The current plan body — plans:get.',
    chaining: 'plans:revisions → plans:revision-diff { revisionId } for any revision.',
    seeAlso: [
      'plans:revisions (list revisions)',
      'plans:revision-transcript (the authoring transcript for context)',
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
    try {
      // Workspace scope: revision rows are RLS-isolated per workspace
      // (audit P-008 / mig 218); resolve it from the harness arg.
      const harnessSlug = resolveCtxHarnessSlug(harnessScopedCtx(args.harness, ctx));
      const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
      const pair = await getPlanRevisionPairById(args.revisionId, { workspaceId: scope.workspaceId });
      if (!pair) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'unknown_revision',
                revisionId: args.revisionId,
              }),
            },
          ],
          isError: true,
        };
      }
      const diff = buildRevisionDiffText(pair);
      ctxAny.metadata?.({
        slug: pair.newer.planSlug,
        revisionId: args.revisionId,
        seq: pair.newer.seq,
        diffBytes: diff.length,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              diff,
              slug: pair.newer.planSlug,
              seq: pair.newer.seq,
              priorSeq: pair.older?.seq ?? null,
            }),
          },
        ],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'revision_diff_unavailable',
              message: message.slice(0, 400),
              revisionId: args.revisionId,
            }),
          },
        ],
        isError: true,
      };
    }
  },
});
