/**
 * merge:approve — Queen/operator-accessible "approve a merge to a later
 * phase" verb (queen-autonomy-policy-2026-06-13 B-04/P-016 coverage gap,
 * filed EI-457; closes action-surface.ts row
 * `review.approve-code-review-merge` alongside `review:approve`).
 *
 * Today, confirming a promotion (merging a `from` worktree phase into `to`,
 * e.g. staging → testing/production, optionally smoke-building) is only
 * reachable via the loopback-only HTTP route
 * `POST /harness/:slug/promote/:id/confirm` (endpoint-route/routes/harness/
 * promote.ts) — no MCP verb let a Queen/operator call it. This wraps that
 * route so the `review-merge` autonomy category has a real, governable verb
 * for the "merge" half of "approve a code review / merge to staging".
 *
 * The promotion must already exist (`harness:pending_reviews` lists it,
 * `kind:"promotion"`) — created by the pipeline's `POST /harness/:slug/promote`.
 * Reversible: a confirmed promotion can be undone via the phase's rollback
 * route (git reset --hard to the previous promotion's SHA).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { loopbackFetch, readJsonBody } from '../../loopback-fetch';

function operatorBase(): string {
  const port = process.env.PORT ?? '3055';
  return process.env.INTERNAL_API_BASE ?? `http://127.0.0.1:${port}`;
}

interface ConfirmPromotionResponse {
  ok: boolean;
  sha?: string;
  promotion?: Record<string, unknown>;
  error?: string;
}

export default defineTool({
  name: 'merge:approve',
  profile: 'engineer',
  description:
    'Confirm a pending promotion — merges the `from` worktree phase into `to` (e.g. staging → testing/production), optionally smoke-building, and records the promotion. Wraps POST /harness/:slug/promote/:id/confirm. Reversible via the phase rollback route.',
  guidance: {
    when: 'A `kind:"promotion"` pending review (harness:pending_reviews) is ready — its review was approved (review:approve, if it also gated on one) and criteria are met — and you (operator / the owner) want to actually run the merge.',
    notWhen: 'The item is a plain (non-promotion) pending review — use review:approve; there is no merge to confirm.',
    chaining: 'harness:pending_reviews (find the promotion id) → [review:approve, if gated] → merge:approve { slug, id }.',
    seeAlso: [
      'harness:pending_reviews (list pending reviews / promotions)',
      'review:approve (approve a plain pending review)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    slug: z.string().min(1).describe('harness slug'),
    id: z.string().min(1).describe('the promotion id (harness:pending_reviews[].id, kind:"promotion")'),
    phase: z.string().optional().describe('the promotion\'s `from` worktree phase (default: staging)'),
  }),
  async handler(args) {
    const qs = args.phase ? `?phase=${encodeURIComponent(args.phase)}` : '';
    const url = `${operatorBase()}/api/harness/${encodeURIComponent(args.slug)}/promote/${encodeURIComponent(args.id)}/confirm${qs}`;
    const r = await loopbackFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: `confirm_failed:${r.status}`, detail: text.slice(0, 400) }),
          },
        ],
        isError: true as const,
      };
    }
    const j = await readJsonBody<ConfirmPromotionResponse>(r, url);
    return { content: [{ type: 'text' as const, text: JSON.stringify(j) }] };
  },
});
