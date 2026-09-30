/**
 * review:approve — Queen/operator-accessible "approve a pending review" verb
 * (queen-autonomy-policy-2026-06-13 B-04/P-016 coverage gap, filed EI-457;
 * closes action-surface.ts row `review.approve-code-review-merge`).
 *
 * Today, resolving a pending review (a code-review-shaped blocking question
 * the pipeline raised via `harness:pending_reviews`, or a `kind:"promotion"`
 * phase-merge review) is only reachable via the loopback-only HTTP route
 * `POST /harness/:slug/reviews/:id/resolve` (endpoint-route/routes/harness/
 * reviews.ts) — no MCP verb let a Queen/operator call it. This wraps that
 * route so the `review-merge` autonomy category has a real, governable verb:
 * the D-010 "every human-driving action is accessible to the Queen" claim
 * needs one to be true here.
 *
 * Resolving unblocks the review's feature (flips `blocked` → `todo` in
 * `harness_features` when `featureId` is set) so the pipeline can resume it.
 * A `kind:"promotion"` review still needs `merge:approve` afterward to
 * actually run the phase→phase merge — approving the review alone only
 * records the decision + unblocks the feature.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { loopbackFetch, readJsonBody } from '../../loopback-fetch';

function operatorBase(): string {
  const port = process.env.PORT ?? '3055';
  return process.env.INTERNAL_API_BASE ?? `http://127.0.0.1:${port}`;
}

interface ResolveReviewResponse {
  ok: boolean;
  review?: Record<string, unknown>;
  error?: string;
}

export default defineTool({
  name: 'review:approve',
  profile: 'engineer',
  description:
    'Approve (or reject-with-response) a pending review — e.g. a code-review-shaped blocking question the pipeline raised, listed via harness:pending_reviews — recording the decision and unblocking the review\'s feature. Wraps POST /harness/:slug/reviews/:id/resolve. Single call, one review.',
  guidance: {
    when: 'harness:pending_reviews lists an unresolved review you (operator / the owner) want to accept or answer, unblocking the feature it gated.',
    notWhen:
      'The review is `kind:"promotion"` (a phase-merge gate) and you also want the merge itself to run — approve here, then call merge:approve with the same id to actually merge the phase forward.',
    chaining: 'harness:pending_reviews (find the review id) → review:approve { slug, id }.',
    seeAlso: [
      'harness:pending_reviews (list pending reviews)',
      'merge:approve (confirm a promotion / phase merge)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    slug: z.string().min(1).describe('harness slug'),
    id: z.string().min(1).describe('the review id (harness:pending_reviews[].id)'),
    phase: z.string().optional().describe('worktree phase the review lives in (default: staging)'),
    accept: z.boolean().optional().describe("true: accept the review's recommendedAnswer verbatim"),
    response: z.string().optional().describe('explicit response text (overrides `accept`)'),
  }),
  async handler(args) {
    const qs = args.phase ? `?phase=${encodeURIComponent(args.phase)}` : '';
    const url = `${operatorBase()}/api/harness/${encodeURIComponent(args.slug)}/reviews/${encodeURIComponent(args.id)}/resolve${qs}`;
    const r = await loopbackFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: args.response, accept: args.accept }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: `resolve_failed:${r.status}`, detail: text.slice(0, 400) }),
          },
        ],
        isError: true as const,
      };
    }
    const j = await readJsonBody<ResolveReviewResponse>(r, url);
    return { content: [{ type: 'text' as const, text: JSON.stringify(j) }] };
  },
});
