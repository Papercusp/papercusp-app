/**
 * coord:ask — ask a NAMED agent a question. `to` is REQUIRED.
 *
 * This tool is the backend for the owner's "Ask an agent" surfaces
 * (left-sidebar AskAgentPane + the /adv AskComposer modal), which proxy in via
 * POST /api/admin/coordination/coord/ask. It is NOT an agent-to-agent Q&A
 * mechanism — agents talk to each other with `coord:send`.
 *
 * WHY `to` IS REQUIRED (WI-5951, 2026-07-26). The old shape ran a knowledge
 * tier and, on a miss, opened a `question` conversation fanned out to TOPIC
 * SUBSCRIBERS. Measured over the 7 weeks to 2026-07-26: 53 question
 * conversations were opened and NOT ONE ever received a post — zero peer
 * answers, because there are zero topic subscribers workspace-wide. The
 * broadcast path's only durable effect was manufacturing 40 orphaned questions
 * (oldest 25 days). A question addressed to everyone is owned by no one.
 *
 * So the audience is now a precondition, not a fallback: no recipient, no
 * conversation. Enforced HERE rather than taught in a prompt, because the
 * playbook already said "coordination is queried, not chatted" and this tool's
 * own guidance already said "NAME the agents in `to:`" — and both were ignored
 * in every one of those 53 asks. A tool that refuses corrects every caller on
 * every call and needs no agent to remember anything.
 *
 * `topics` still TAG the conversation and may widen the audience additively,
 * but can no longer be the sole audience — that is what made orphans.
 */

import { z } from 'zod';
import { defineTool, UnauthorizedToolError } from '@papercusp/agent-mcp';
import { ADMIN_COORD_UI_OWNER, resolveAgentIdentity } from '../identity';
import { openConversation } from '../conversations';
import { hardText, LIMITS } from '../../limits';

export default defineTool({
  name: 'coord:ask',
  description:
    'OWNER-UI ONLY. The owner\'s "Ask an agent" UI asks one named agent a question, opening a `question` conversation addressed to them. Agent sessions are denied; use `coord:send` or `coord:message-agent` for agent-to-agent questions.',
  guidance: {
    when:
      'You need a SPECIFIC named agent to answer something only they know (resolve ids via coord:presence). Normally reached from the owner\'s Ask-an-agent UI, not from agent code.',
    notWhen:
      'Agent-to-agent: use `coord:send` (5,591 calls/30d vs this tool\'s 16 — it is what agents actually use, and it wakes the recipient). For live state do NOT ask a peer at all — query it: who holds a file → locks:queue { paths: [...] }; who is on what → fleet:assignments / coord:presence; a work-item\'s status → work_items:get (its checkpoint IS the status). For an owner decision → coord:ask-owner. Open-ended discussion → conversations:post.',
    chaining:
      'coord:presence (get the ownerId) → coord:ask { to:[id] } → conversations:get for replies → conversations:resolve when answered.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // Empty is an explicit deny-all role allowlist. The owner UI reaches the
  // HTTP projection through the loopback, CSRF-guarded admin proxy instead.
  agentRoles: [],
  args: z.object({
    question: hardText(LIMITS.ANNOTATION),
    to: z
      .array(z.string().min(1))
      .min(1, 'coord:ask requires at least one recipient in `to` — an unaddressed question reaches nobody.')
      .max(8)
      .describe('REQUIRED for the owner UI. Agent ids to ask (coord:presence lists live agents). Agent sessions cannot call this tool; use coord:send or coord:message-agent for agent-to-agent questions.'),
    topics: z.array(z.string().min(1)).max(8).optional().describe('Optional tags that also widen the audience additively. NOT an audience on their own — `to` is what guarantees delivery.'),
    harness: z.string().optional().describe('Tag the conversation harness-scoped.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    if (ctx.transport !== 'http' || identity.ownerId !== ADMIN_COORD_UI_OWNER) {
      throw new UnauthorizedToolError(
        'coord:ask is owner-UI-only; agents must use coord:send or coord:message-agent.',
      );
    }
    // `to` is schema-required (min 1), so a directed recipient always exists by
    // the time we get here. The old knowledge tier + force_open pair is gone:
    // a DIRECTED ask names a person, so knowledge must never answer on their
    // behalf (WI-5754) — which made the tier unreachable once `to` became
    // mandatory. Callers wanting knowledge should use search:semantic directly.
    const directTo = args.to;

    const opened = await openConversation(identity, {
      kind: 'question',
      producer: 'coord:ask',
      body: args.question,
      topics: args.topics,
      harness_slug: args.harness,
      direct_to: directTo,
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          found: false,
          conversation_id: opened.conversation.id,
          scope: opened.conversation.scope,
          topics: opened.topics,
          asked: opened.direct_to,
          unrouted: opened.unrouted,
          notified_subscribers: opened.delivered,
          interest_watch: opened.interestWatch,
          // `unrouted` is measured from ACTUAL delivery, not from what the
          // asker attempted. With `to` now mandatory it can only mean the named
          // recipient was undeliverable (dead/unknown ownerId) — the old "you
          // tagged topics that have no subscribers" case can no longer arise,
          // because topics are no longer an audience on their own.
          hint: opened.unrouted
            ? `Question opened but reached NOBODY: the agent(s) you named (${opened.direct_to.join(', ') || 'none resolved'}) could not be delivered to — most likely a dead or unknown ownerId. Confirm a LIVE id with coord:presence and re-ask; as-is nobody will answer.`
            : `Question opened and ${opened.delivered} agent${opened.delivered === 1 ? '' : 's'} notified (${opened.direct_to.join(', ')}); answers arrive in your inbox on a later turn. If you are BLOCKED on the answer, events:await { event: 'conversation:answered:${opened.conversation.id}' } and end your turn — the resolve wakes you. conversations:resolve when answered (captures the answer for the next asker).`,
        }),
      }],
    };
  },
});
