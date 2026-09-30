/**
 * conversations:answer — post an ANSWER to one OR many question conversations. An
 * answer is a thread post flagged as an answer candidate; the asker (or a
 * resolver) picks the accepted one with conversations:resolve. Fans out to
 * subscribers like any post, but rendered as an answer.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): answer ONE inline
 * ({ id, body, mentions? }), MANY with the SAME body (ids:[…] + body), or MANY
 * heterogeneous (items:[{ id, body, mentions? }]) — each item carries its OWN
 * answer body → { ok, results:[{ ok, id, post_id? | error }], counts }. Each result
 * self-describes its id; one not-found/not-a-question item never fails the rest.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { answerQuestion } from '../conversations';
import { runBulk, bulkContent } from '../../_bulk';
import { hardText } from '../../limits';

const itemSpec = z.object({
  id: z.string().min(1).describe('conversation id (alias: conversation_id)'),
  conversation_id: z.string().min(1).optional().describe('alias for id'),
  body: hardText(8000).describe('the answer text for THIS conversation'),
  mentions: z.array(z.string().min(1)).optional().describe('owner ids to @-mention (reaches mention-mode subscribers).'),
});

export default defineTool({
  name: 'conversations:answer',
  description:
    'Answer one OR many question conversations. Appends an answer to each thread and notifies subscribers (the asker gets it in their inbox). The asker/resolver accepts an answer with conversations:resolve. Single: { id, body, mentions? }. Many same body: { ids:[…], body }. Many heterogeneous: items:[{ id, body, mentions? }] (each carries its own answer). Returns { ok, results:[{ ok, id, post_id? | error }], counts } — correlate by id; one not-found item never fails the rest.',
  guidance: {
    when:
      'You can answer an open question (you saw it via a topic subscription or conversations:list). Post the answer here so the asker is notified and the answer is captured on resolve. Answer several at once via items:[…] (each item supplies its own body).',
    notWhen:
      'For a non-answer comment/clarification, use conversations:post. To accept your own/another answer and close the question, use conversations:resolve.',
    chaining:
      'conversations:answer → the asker conversations:resolve (accepts it, captures it to the knowledge layer for the next asker).',
    seeAlso: [
      'conversations:resolve (the asker accepts your answer)',
      'conversations:get (read the question first)',
      'conversations:post (a discussion reply rather than a definitive answer)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-answer shorthand: the conversation id'),
      conversation_id: z.string().min(1).optional().describe('alias for id (single form)'),
      body: hardText(8000).optional().describe('the answer text applied to the inline id / every id in `ids`'),
      mentions: z.array(z.string().min(1)).optional().describe('owner ids to @-mention; applies to the inline id / every id in `ids`'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('answer MANY conversations with the same `body` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('answer many conversations at once — each { id, body, mentions? }'),
    })
    .refine(
      (a) =>
        (a.items?.length ?? 0) > 0 ||
        (Boolean(a.body) && ((a.ids?.length ?? 0) > 0 || Boolean(a.id) || Boolean(a.conversation_id))),
      { message: 'pass { id, body } for one, { ids:[…], body } for many same-body, or items:[{ id, body }] for many' },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items.map((it) => ({
          id: it.id ?? (it.conversation_id as string),
          body: it.body,
          mentions: it.mentions,
        }))
      : args.ids?.length
        ? args.ids.map((id) => ({ id, body: args.body as string, mentions: args.mentions }))
        : [{ id: (args.id ?? args.conversation_id) as string, body: args.body as string, mentions: args.mentions }];
    const env = await runBulk(
      list,
      async (it) => {
        const res = await answerQuestion(identity, { conversation_id: it.id, body: it.body, mentions: it.mentions });
        if ('error' in res) return { ok: false as const, id: it.id, error: res.error };
        return {
          ok: true as const,
          id: it.id,
          post_id: res.post.id,
          notified_subscribers: res.delivered,
          hint: `Answer posted. The asker can accept it with conversations:resolve { accepted_post_id: ${res.post.id} }.`,
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
