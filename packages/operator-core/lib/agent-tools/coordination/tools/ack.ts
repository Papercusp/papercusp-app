/**
 * coord:ack — acknowledge one OR many coord messages you received.
 *
 * Each ack is appended to the acker's OWN outbox (preserving the
 * one-writer-per-file invariant) with `related_msg_id` pointing at the original.
 * The sender sees it as a fresh inbox entry on their next coord:inbox.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): ack ONE inline
 * ({ msg_id }), MANY (msg_ids:[…]), or MANY heterogeneous (items:[{ msg_id }]) →
 * { ok, results:[{ ok, msg_id, ack_msg_id? + acked_from? | error }], counts }.
 * Each result self-describes its msg_id; an unknown msg_id never fails the rest.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { appendAck, resolveMessageRef } from '../messages';
import { COORD_REPLY_ROLES } from '../roles';
import { runBulk, bulkContent } from '../../_bulk';

const itemSpec = z.object({
  msg_id: z.string().min(1).describe('the coord msg_id to ack (alias: id)'),
  id: z.string().min(1).optional().describe('alias for msg_id'),
});

export default defineTool({
  name: 'coord:ack',
  description:
    'Acknowledge one OR many coord messages you received by msg_id. Messages authored by the caller are refused with self_authored_message. Posts a `kind: "ack"` entry in your outbox addressed back at each original sender, so they can see you received it. Single: { msg_id }. Many: { msg_ids:[…] } or items:[{ msg_id }]. Returns { ok, results:[{ ok, msg_id, ack_msg_id? + acked_from? | error }], counts } — correlate by msg_id; an unknown msg_id never fails the rest.',
  guidance: {
    when: 'After acting on (or deliberately not acting on) coord message(s) — closes the loop for the sender. Ack several at once via msg_ids:[…].',
    notWhen: 'For routine read-and-forget or messages you authored yourself. Acks are only meaningful for received messages and are most useful for hand-offs and questions where the sender is waiting.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_REPLY_ROLES],
  args: z
    .object({
      msg_id: z.string().min(1).optional().describe('single-ack shorthand: the coord msg_id'),
      id: z.string().min(1).optional().describe('alias for msg_id (single form)'),
      msg_ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('ack MANY messages at once'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('ack many messages at once — each { msg_id }'),
    })
    .refine(
      (a) => (a.items?.length ?? 0) > 0 || (a.msg_ids?.length ?? 0) > 0 || Boolean(a.msg_id) || Boolean(a.id),
      { message: 'pass { msg_id } for one, or { msg_ids:[…] } / items:[{ msg_id }] for many' },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items.map((it) => ({ msg_id: it.msg_id ?? (it.id as string) }))
      : args.msg_ids?.length
        ? args.msg_ids.map((msg_id) => ({ msg_id }))
        : [{ msg_id: (args.msg_id ?? args.id) as string }];
    const env = await runBulk(
      list,
      async (it) => {
        // Resolve the original so we can address the ack back at its sender.
        // resolveMessageRef includes the open-escalation projection, whose source
        // event may have been pruned while the escalation remains actionable.
        const resolution = await resolveMessageRef(it.msg_id);
        if (resolution.status === 'ambiguous') {
          return {
            ok: false as const,
            msg_id: it.msg_id,
            error: 'msg_id_ambiguous',
            candidates: resolution.candidates,
            detail:
              `msg_id=${it.msg_id} matches multiple coord messages (${resolution.candidates.join(', ')}) — ` +
              'use the full msg_id or a longer unique leading prefix',
          };
        }
        if (resolution.status !== 'found') {
          return { ok: false as const, msg_id: it.msg_id, error: 'unknown_msg_id', detail: `no coord message with msg_id=${it.msg_id}` };
        }
        const target = resolution.message;
        const resolvedMsgId = resolution.msgId;
        if (target.from === identity.ownerId) {
          return {
            ok: false as const,
            msg_id: resolvedMsgId,
            error: 'self_authored_message',
            detail: 'cannot acknowledge a coordination message authored by the caller',
          };
        }
        // Keep the canonical id when a unique leading prefix was supplied. The
        // related_msg_id on the ack must point at the durable projection id, and
        // the response should tell callers which id was actually acknowledged.
        // Preserve the original message's federation scope. `null` is
        // deliberate for operator-local rows: leaving the option undefined
        // would let sendMessage's AUTO scope resolver stamp the ack into a
        // shared hive even though the target was local.
        const acked = await appendAck(identity, resolvedMsgId, target.from, target.harness_slug ?? null);
        return { ok: true as const, msg_id: resolvedMsgId, ack_msg_id: acked.msg_id, acked: resolvedMsgId, acked_from: target.from };
      },
      { keyOf: (it) => ({ msg_id: it.msg_id }) },
    );
    return bulkContent(env);
  },
});
