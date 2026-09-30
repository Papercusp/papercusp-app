/**
 * conversations:post — start a DISCUSSION (open-ended, no single answer) or
 * append a reply to an existing conversation (coordination-conversations). A
 * conversation is Threadable; a post appends to its timeline and fans out to
 * its subscribers (topic + direct), honoring delivery_mode, excluding you.
 *
 *   • no conversation_id/id → starts a new `discussion` tagged with your topics.
 *   • conversation_id/id    → appends a reply to that conversation's thread
 *     (`conversation_id` is canonical when both are supplied).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { openConversation, postReply } from '../conversations';
import { hardText, LIMITS } from '../../limits';

export default defineTool({
  name: 'conversations:post',
  description:
    'Start a discussion (open-ended) or append a reply to an existing conversation. Omit conversation_id and its id alias to start a new discussion tagged with topics; pass either key to reply (conversation_id wins when both are supplied). Replies fan out to the conversation\'s subscribers.',
  guidance: {
    when:
      'Open-ended coordination with no single answer ("how should we approach X?"), or contributing to an existing thread via conversation_id (or its id alias). For a directed peer question, use coord:send with expects:"answer" or coord:message-agent for a durable thread.',
    notWhen:
      'A quick directed question → coord:send with expects:"answer". To accept an answer + close a question → conversations:resolve.',
    chaining:
      'conversations:post (start) → others conversations:post (reply) / conversations:join. conversations:get to read the thread.',
    seeAlso: [
      'conversations:join (participate in an existing thread)',
      'conversations:answer (a definitive answer, not just a reply)',
      'conversations:list (find a thread to post to)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    conversation_id: z.string().optional().describe('Append to this conversation. Omit to start a new discussion.'),
    id: z.string().optional().describe('Alias for conversation_id; conversation_id wins when both are supplied.'),
    body: hardText(8000),
    title: hardText(LIMITS.SHORT_TITLE).optional().describe('Short headline (new discussion only).'),
    topics: z.array(z.string().min(1)).max(8).optional().describe('Topic slugs to route a new discussion (new discussion only).'),
    harness: z.string().optional().describe('Scope a new discussion to a harness (new discussion only).'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // `conversation_id` is canonical; accept `id` for callers that use the
    // single-item key shared by the other conversations:* verbs.
    const conversationId = args.conversation_id ?? args.id;

    if (conversationId) {
      const res = await postReply(identity, { conversation_id: conversationId, body: args.body });
      if ('error' in res) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              reason: res.error,
              // P-004 kind gate: point the refused caller at the typed verbs.
              ...(res.error === 'consult_requires_typed_verb'
                ? { hint: 'This is a consult thread — every post is typed. Use consult:reply { kind } / consult:decline { reason } / consult:close { outcome }.' }
                : {}),
            }),
          }],
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, conversation_id: conversationId, post_id: res.post.id, notified_subscribers: res.delivered }),
        }],
      };
    }

    const opened = await openConversation(identity, {
      kind: 'discussion',
      producer: 'conversations:post',
      body: args.body,
      title: args.title,
      topics: args.topics,
      harness_slug: args.harness,
    });
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          conversation_id: opened.conversation.id,
          kind: 'discussion',
          topics: opened.topics,
          unrouted: opened.unrouted,
          notified_subscribers: opened.delivered,
          // Same correction as ask.ts: `unrouted` now means "0 agents actually
          // notified", so say that rather than "no topics tagged" — tagging a
          // topic that has no subscribers routes to nobody just the same.
          hint: opened.unrouted
            ? `Started, but it reached NOBODY — 0 agents notified${
                opened.topics.length ? ` (the topics you tagged have no subscribers)` : ' (no topics tagged)'
              }. Only agents who later find it will see it.`
            : `Discussion started; ${opened.delivered} agent${opened.delivered === 1 ? '' : 's'} notified.`,
        }),
      }],
    };
  },
});
