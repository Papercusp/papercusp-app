/**
 * events:unsubscribe — stop a standing EVENT-KEY inject subscription
 * (watch:create { wake:false, targetKind:'event' } — WI-4014 Part 2).
 *
 * The wake:false / event-key sibling of topics:unsubscribe: idempotent
 * soft-cancel, bulk by default. Not for a WAKE watch (that's events:cancel,
 * which cancels an await/delivery row on the separate events/await table) and
 * not for a topic (that's topics:unsubscribe) — this is specifically the
 * `coord_entity_subscriptions` row with target_kind='event'.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { unsubscribeEventKey } from '../coordination/event-subscriptions';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

export default defineTool({
  name: 'events:unsubscribe',
  description:
    'Unsubscribe from one OR many standing event-key inject subscriptions (watch:create wake:false targetKind:"event"). Idempotent — unsubscribing from a key you do not follow is a no-op. Single: { key }. Many: { keys:[…] } or items:[{ key }]. Returns { ok, results:[{ ok, key, error? }], counts }.',
  guidance: {
    when: 'A standing watch:create({wake:false, targetKind:"event"}) subscription is no longer relevant.',
    notWhen: 'A wake watch (wake:true) — use events:cancel instead. A topic subscription — use topics:unsubscribe instead.',
    seeAlso: [
      'watch:create (register a standing event-key subscription — targetKind:"event", wake:false)',
      'events:cancel (retract a wake:true watch instead)',
      'topics:unsubscribe (retract a topic subscription instead)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z
    .object({
      key: z.string().min(1).optional().describe('single-unsubscribe shorthand: the event key'),
      keys: z.array(z.string().min(1)).min(1).max(200).optional().describe('unsubscribe from MANY event keys (homogeneous)'),
      items: z
        .array(z.object({ key: z.string().min(1) }))
        .min(1)
        .max(200)
        .optional()
        .describe('unsubscribe from many event keys at once — each { key }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.keys?.length ?? 0) > 0 || Boolean(a.key), {
      message: 'pass { key } for one, or { keys:[…] } / items:[{ key }] for many',
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const keys = mergeIds(args.key, [
      ...(args.keys ?? []),
      ...(args.items?.map((it) => it.key) ?? []),
    ]);
    const env = await runBulk(
      keys,
      async (key) => {
        await unsubscribeEventKey(identity, key);
        return { ok: true as const, key };
      },
      { keyOf: (key) => ({ key }) },
    );
    return bulkContent(env);
  },
});
