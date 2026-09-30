/**
 * work_items:subscribe — Subscribable (D-003). Follow a work-item to receive its
 * change fan-out (full | digest | mention).
 *
 * INJECT-ONLY (the wake-vs-inject axis, linking-notify-family-hardening P-001):
 * updates are injected into the subscriber's context at their NEXT turn — a
 * subscription never re-invokes an idle session. The only WAKING verb is
 * events:await (one-shot, on an exact event key like work-item:done:<id>).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): pass `id` for one or
 * `ids` for several (shared `mode`/`harness`) → { ok, results:[{ ok, id, error? }], counts }.
 * `followBlockers:true` opts a direct work-item subscription into one blocker
 * hop; generated follows remain inject-only and are removed on unlink/settle.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { subscribeWorkItem } from '../../work-items';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

export default defineTool({
  name: 'work_items:subscribe',
  profile: 'engineer',
  description:
    'Follow one OR many work-items: their updates are INJECTED into your inbox at your next turn — inject-only, this never WAKES an idle session. mode tiers the injected volume: full = every update (default) | digest = coalesced summaries | mention = only @-mentions and resolution. followBlockers:true adds one-hop blocker follows, still inject-only, with auto-unsubscribe on unlink/settle. Pass `id` for one or `ids` for several. Returns { ok, results:[{ ok, id, error? }], counts }.',
  guidance: {
    when: 'You want to SEE the progress of one or more work-items you do not own (e.g. ones that block yours). Subscribe to several at once via `ids`.',
    notWhen: 'You are BLOCKED until an item settles and need to be woken — that is events:await { event: "work-item:done:<id>" } (one-shot wake), not a subscription (inject-only, never wakes).',
    chaining: 'work_items:get → work_items:subscribe.',
    seeAlso: [
      'events:await (the ONLY waking verb — one-shot wake when an item settles)',
      'work_items:comment (post to the thread you are following)',
      'work_items:link (record that this item blocks yours)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single work-item id (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).max(100).optional().describe('work-item ids to subscribe to (1–100)'),
      mode: z
        .enum(['full', 'digest', 'mention'])
        .optional()
        .describe('injected-notification volume: full = every update (default) | digest = coalesced summaries | mention = only @-mentions and resolution'),
      followBlockers: z.boolean().optional().describe('also follow the subscribed item’s current blockers one hop; generated follows are inject-only and auto-removed on unlink/settle'),
      harness: z.string().max(80).optional(),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, { message: 'pass `id` (one) or `ids` (many)' }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const ids = mergeIds(args.id, args.ids);
    const env = await runBulk(
      ids,
      async (id) => {
        const res = await subscribeWorkItem(ident.ownerId, id, args.mode ?? 'full', {
          harness: args.harness,
          followBlockers: args.followBlockers,
        });
        return 'error' in res ? { ok: false as const, id, error: res.error } : { ok: true as const, id };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
