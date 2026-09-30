/**
 * conversations:supersede — retract an open question/discussion and open its
 * replacement as a real conversation gate. The row transaction retires the old
 * gate and inserts the replacement together, so a correction cannot get lost
 * as a coord:send message while the stale question remains open.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { supersedeConversation } from '../conversations';
import { runBulk, bulkContent } from '../../_bulk';
import { hardText } from '../../limits';

const replacementSpec = z.object({
  body: hardText(8000).describe('The corrected question or discussion body.'),
  title: z.string().max(500).optional().describe('Replacement title; defaults to the old title.'),
  topics: z.array(z.string().min(1)).max(50).optional().describe('Replacement topic tags.'),
  direct_to: z.array(z.string().min(1)).max(100).optional().describe('Agent ids to subscribe directly to the replacement.'),
  kind: z.enum(['question', 'discussion']).optional().describe('Replacement kind; defaults to the old kind.'),
});

const itemSpec = z.object({
  id: z.string().min(1).describe('conversation id (alias: conversation_id)'),
  conversation_id: z.string().min(1).optional().describe('alias for id'),
  replacement: replacementSpec,
  reason: hardText(2000).optional().describe('Why the original gate is no longer answerable.'),
});

export default defineTool({
  name: 'conversations:supersede',
  description:
    'Retract one OR many open conversations and open corrected replacements as real gates. The old row becomes superseded with a superseded_by pointer and the replacement row is inserted atomically; owner-ask escalation twins are retired too. Single: { id, replacement:{ body, title?, topics?, direct_to?, kind? }, reason? }. Many: items:[{ id, replacement, reason? }]. Returns replacement conversation/thread ids and the old RETRACTED state.',
  guidance: {
    when:
      'An open question was framed on a premise that is now false, stale, or otherwise not answerable; use this to replace the gate durably so the correction is visible in conversations and the old gate cannot continue to block work.',
    notWhen:
      'You are merely notifying someone → coord:send. The original question is answered → conversations:resolve. An unrelated new owner question → coord:ask-owner; a peer question → coord:send with expects:"answer". An owner question may only be superseded by the agent that asked it; ask that agent to make a correction when it is not yours.',
    chaining:
      'conversations:get → conversations:supersede → events:await { event: "conversation:answered:<replacement_id>" } or conversations:resolve on the replacement.',
    seeAlso: [
      'conversations:get (inspect the old gate first)',
      'coord:ask-owner { supersedes_conversation_id } (owner-ask shorthand)',
      'conversations:resolve (record an answer instead of retracting)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-supersede shorthand: the conversation id'),
      conversation_id: z.string().min(1).optional().describe('alias for id'),
      replacement: replacementSpec.optional().describe('replacement body and optional routing metadata'),
      reason: hardText(2000).optional().describe('why the original gate is no longer answerable'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('supersede many conversations, each with its own replacement'),
    })
    .refine(
      (a) => (a.items?.length ?? 0) > 0 || Boolean(a.id) || Boolean(a.conversation_id),
      { message: 'pass { id, replacement } for one, or items:[{ id, replacement }] for many' },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items.map((it) => ({
          id: it.id ?? (it.conversation_id as string),
          replacement: it.replacement,
          reason: it.reason,
        }))
      : [
          {
            id: (args.id ?? args.conversation_id) as string,
            replacement: args.replacement,
            reason: args.reason,
          },
        ];
    const env = await runBulk(
      list,
      async (it) => {
        if (!it.replacement) return { ok: false as const, id: it.id, error: 'need_replacement' };
        const result = await supersedeConversation(identity, {
          conversation_id: it.id,
          replacement: it.replacement,
          reason: it.reason,
        });
        if ('error' in result) return { ok: false as const, id: it.id, error: result.error };
        return {
          ok: true as const,
          id: result.conversation.id,
          state: result.conversation.state,
          superseded_by: result.conversation.superseded_by,
          replacement: {
            id: result.replacement.conversation.id,
            state: result.replacement.conversation.state,
            thread_id: result.replacement.thread_id,
          },
          notified_subscribers: result.delivered,
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
