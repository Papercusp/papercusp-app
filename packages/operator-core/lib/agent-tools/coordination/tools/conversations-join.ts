/**
 * conversations:join — follow ONE OR MANY conversations (the "I can contribute to
 * THIS thread" motivation, substrate D-005a). Each conversation's
 * replies/answers/resolution get injected into your inbox, honoring the delivery
 * mode you pick. This is the per-object subscribe; a topic-scoped watch is the
 * standing-interest one.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): join ONE inline
 * ({ id, mode?, ttl_sec?, leave? }), MANY with the SAME mode/leave (ids:[…] +
 * mode?/leave?), or MANY heterogeneous (items:[{ id, mode?, ttl_sec?, leave? }])
 * → { ok, results:[{ ok, id, mode? | left? | error }], counts }. Each result
 * self-describes its id; one not-found item never fails the rest.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { joinConversation, leaveConversation } from '../conversations';
import { runBulk, bulkContent } from '../../_bulk';

const MODE = z.enum(['full', 'digest', 'mention']);

const itemSpec = z.object({
  id: z.string().min(1).describe('conversation id (alias: conversation_id)'),
  conversation_id: z.string().min(1).optional().describe('alias for id'),
  mode: MODE.optional(),
  ttl_sec: z.number().int().positive().optional(),
  leave: z.boolean().optional().describe('Stop following this conversation.'),
});

export default defineTool({
  name: 'conversations:join',
  description:
    'Follow one OR many conversations so their updates are injected into your inbox. mode = full | digest | mention (D-006). Idempotent — re-joining updates the mode/TTL. leave:true stops following. Single: { id, mode?, ttl_sec?, leave? }. Many same mode: { ids:[…], mode?, leave? }. Many heterogeneous: items:[{ id, mode?, ttl_sec?, leave? }]. Returns { ok, results:[{ ok, id, mode? | left? | error }], counts } — correlate by id; one not-found item never fails the rest.',
  guidance: {
    when:
      'A specific conversation is one you want to track or contribute to. Posting/answering auto-joins you; call this to follow without posting, or to change your delivery mode. Follow several at once via ids:[…] or items:[…].',
    notWhen:
      'To follow an AREA (not one thread), use watch:create { targetKind:"topic", wake:false }. For a one-time read, just conversations:get. Consult participation is router-assigned by consult:get_feedback; use consult:reply / consult:decline / consult:close only after being routed.',
    chaining:
      'conversations:list / conversations:get → conversations:join.',
    seeAlso: [
      'conversations:list (find a conversation to join)',
      'conversations:post (contribute after joining)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-join shorthand: the conversation id'),
      conversation_id: z.string().min(1).optional().describe('alias for id (single form)'),
      mode: MODE.optional().describe('delivery mode for the inline id / every id in `ids`'),
      ttl_sec: z.number().int().positive().optional().describe('TTL for the inline id / every id in `ids`'),
      leave: z.boolean().optional().describe('stop following the inline id / every id in `ids`'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('join/leave MANY conversations with the same mode/leave (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('join many conversations at once — each { id, mode?, ttl_sec?, leave? }'),
    })
    .refine(
      (a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id) || Boolean(a.conversation_id),
      { message: 'pass { id } for one, { ids:[…] } for many same-mode, or items:[{ id, mode? }] for many' },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items.map((it) => ({
          id: it.id ?? (it.conversation_id as string),
          mode: it.mode,
          ttl_sec: it.ttl_sec,
          leave: it.leave,
        }))
      : args.ids?.length
        ? args.ids.map((id) => ({ id, mode: args.mode, ttl_sec: args.ttl_sec, leave: args.leave }))
        : [
            {
              id: (args.id ?? args.conversation_id) as string,
              mode: args.mode,
              ttl_sec: args.ttl_sec,
              leave: args.leave,
            },
          ];
    const env = await runBulk(
      list,
      async (it) => {
        if (it.leave) {
          await leaveConversation(identity, it.id);
          return { ok: true as const, id: it.id, left: it.id };
        }
        const res = await joinConversation(identity, { conversation_id: it.id, mode: it.mode, ttl_sec: it.ttl_sec });
        if ('error' in res) {
          return {
            ok: false as const,
            id: it.id,
            error: res.error,
            ...(res.error === 'consult_participation_router_assigned'
              ? { hint: 'Consult participation is router-assigned by consult:get_feedback; joining the conversation does not enroll you. Use consult:reply / consult:decline / consult:close only after being routed.' }
              : {}),
          };
        }
        return { ok: true as const, id: it.id, mode: res.mode };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
