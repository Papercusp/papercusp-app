/**
 * conversations:list — browse open/resolved conversations (questions +
 * discussions). The "pick them up later" read: an agent subscribed to a topic
 * gets new ones injected, but anyone can browse here.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../roles';
import { resolveAgentIdentity, type AgentIdentity } from '../identity';
import { listConversationsWithTopics } from '../conversations';

export default defineTool({
  name: 'conversations:list',
  description:
    'List conversations (questions + discussions), newest first. Filter by kind, state (open|resolved|closed), harness, and topic. Each row carries its topic tags; conversations:get for the full thread.',
  guidance: {
    when:
      'Browsing for open questions you could answer, or finding a conversation by topic/harness. `{ kind:"question", state:"open", unansweredOnly:true }` is the set still waiting on someone — nobody is pushed these (topic subscriptions reach almost nobody), so pulling them here is how they get answered.',
    notWhen: 'You already have a conversation_id → conversations:get.',
    chaining: 'conversations:list → conversations:get → conversations:answer / conversations:join.',
    seeAlso: [
      'conversations:get (full detail on one conversation)',
      'conversations:join (participate in one)',
      'conversations:post (start a new one)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    kind: z.enum(['question', 'discussion']).optional(),
    state: z.enum(['open', 'resolved', 'closed']).optional(),
    harness: z.string().optional().describe('Restrict to a harness-scoped conversation set.'),
    topic: z.string().optional().describe('Restrict to conversations tagged with this topic slug.'),
    unansweredOnly: z
      .boolean()
      .optional()
      .describe(
        'Only conversations with ZERO replies — the set that is still waiting on someone. Pair with kind:"question", state:"open" for "what can I answer right now".',
      ),
    includeUnscoped: z
      .boolean()
      .optional()
      .describe(
        'With `harness`: ALSO include workspace-wide (operator-scope, harness-less) conversations instead of only that harness\'s. Most open questions here are workspace-wide, so a strict harness filter hides them.',
      ),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  async handler(args, ctx) {
    // Read scoped to the CALLER's workspace partition (WI-1571 read side) —
    // without it a workspace-scoped agent browses the 'default' partition and
    // never sees its own workspace's conversations. Fail-open on an
    // unattributable context (glance.ts selfOwnerId pattern).
    let identity: AgentIdentity | undefined;
    try {
      identity = resolveAgentIdentity(ctx);
    } catch {
      identity = undefined;
    }
    const rows = await listConversationsWithTopics(
      {
        kind: args.kind,
        state: args.state,
        // `includeUnscoped` deliberately DROPS the scope pin: the widening is
        // "this harness OR workspace-wide", and workspace-wide rows are
        // scope='operator', so pinning scope='harness' would filter out exactly
        // what the caller asked to include.
        scope: args.harness && !args.includeUnscoped ? 'harness' : undefined,
        harness_slug: args.harness,
        includeUnscoped: args.includeUnscoped,
        unansweredOnly: args.unansweredOnly,
        topic: args.topic,
        limit: args.limit,
      },
      identity,
    );
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          count: rows.length,
          conversations: rows.map((c) => ({
            id: c.id,
            kind: c.kind,
            state: c.state,
            scope: c.scope,
            harness_slug: c.harness_slug,
            title: c.title ?? c.body.slice(0, 100),
            asker_id: c.asker_id,
            topics: c.topics,
            promoted_issue_id: c.promoted_issue_id,
            created_ts: c.created_ts,
            resolved: c.state === 'resolved',
          })),
        }),
      }],
    };
  },
});
