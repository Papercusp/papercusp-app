/**
 * conversations:get — read one OR many conversations in full: the
 * question/discussion seed, its topic tags, the whole reply/answer thread
 * (oldest-first), the accepted answer (if resolved), and the follower count.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): pass `id` (or its
 * `conversation_id` alias) for one or `ids` for several; the result is
 * `{ ok, results:[{ ok, id, conversation?, error? }], counts }`
 * — each result self-describes its id, so a not-found item never poisons the rest
 * and the agent correlates by id (not array position).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_READ_ROLES } from '../roles';
import { resolveAgentIdentity, type AgentIdentity } from '../identity';
import { getConversation, getConsultStates } from '../conversations';
import { mergeIds, runBulk, bulkContent } from '../../_bulk';

export default defineTool({
  name: 'conversations:get',
  description:
    'Read one or many conversations in full: seed, topics, thread (oldest-first), accepted answer, follower count, and consult lifecycle when applicable. Pass `id` (or `conversation_id`) for one or `ids` for 1–100; `id` wins when both single-item keys are supplied. Returns { ok, results:[{ ok, id, conversation?, topics, posts, subscriber_count, consult? | error }], counts }; correlate by id, and a missing id fails only its item. A unique-prefix fallback for a truncated id returns `warning` with the real id; ambiguous or nonexistent prefixes return `not_found`. For consults, read `consult.state` — `conversation.state` may remain open after expiry, and empty posts do not prove a stall.',
  guidance: {
    when: 'You have conversation ids and need the full thread. Use `id` or `conversation_id` for one, or `ids` for a batch.',
    notWhen: 'Browsing many → conversations:list.',
    chaining: 'conversations:get → conversations:answer / conversations:post / conversations:join / conversations:resolve.',
    seeAlso: [
      'conversations:answer (answer the question)',
      'conversations:post (reply to the thread)',
      'conversations:promote (turn it into a tracked work-item)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_READ_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single conversation id (n=1 shorthand for ids:[id])'),
      conversation_id: z.string().min(1).optional().describe('alias for id (single form); id wins when both are supplied'),
      ids: z.array(z.string().min(1)).max(100).optional().describe('conversation ids to fetch (1–100)'),
    })
    .refine((a) => Boolean(a.id) || Boolean(a.conversation_id) || (a.ids?.length ?? 0) > 0, {
      message: 'pass `id`/`conversation_id` (one) or `ids` (many)',
    }),
  async handler(args, ctx) {
    // Read scoped to the CALLER's workspace partition (WI-1571 read side): a
    // workspace-scoped agent's asks land under identity.workspaceId, so an
    // identity-less read here resolved 'default' and returned not_found for
    // the caller's own conversations. Fail-open: an unattributable context
    // keeps the request-ALS chain (glance.ts selfOwnerId pattern).
    let identity: AgentIdentity | undefined;
    try {
      identity = resolveAgentIdentity(ctx);
    } catch {
      identity = undefined;
    }
    // `id` is canonical; accept the caller-natural `conversation_id` spelling
    // for the single-item form without changing the keyed-array result shape.
    const ids = mergeIds(args.id ?? args.conversation_id, args.ids);
    // EI-21510601647367544: pre-fetch consult lifecycle in ONE query rather than
    // per-id inside the bulk loop (up to 100 ids ⇒ up to 100 round-trips).
    // Fail-soft inside getConsultStates: on error this is an empty map and the
    // read degrades to its previous shape.
    const consultStates = await getConsultStates(ids, identity);
    const env = await runBulk(
      ids,
      async (id) => {
        const detail = await getConversation(id, identity);
        if (!detail) return { ok: false as const, id, error: 'not_found' };
        const { conversation: c, topics, posts, subscriber_count, resolvedFromPrefix } = detail;
        const consult = consultStates.get(id);
        return {
          ok: true as const,
          id,
          /**
           * EI-21914051456641891: `id` (the requested value, above) did NOT
           * resolve as an exact match — it uniquely matched as a PREFIX of
           * `conversation.id` (the real, full id, below). Ids are minted as
           * `<prefix>-<8charMs>-<4charSeq>-<32hexUuid>`, and a durable
           * citation (a plan `## Now`, a rubric methodRef) commonly gets
           * hand-truncated to just the leading segment, which reads exactly
           * like a complete short id — so an EXACT lookup on that truncated
           * form used to return a clean, confident `not_found`
           * indistinguishable from genuine absence. Present ONLY on that
           * fallback path; cite `conversation.id` (the full id) from here on.
           */
          ...(resolvedFromPrefix
            ? {
                warning: `requested id '${resolvedFromPrefix}' did not exist as an exact conversation id — it matched uniquely as a PREFIX of the real id '${c.id}', and was resolved to it. This request likely came from a truncated/hand-typed citation; cite the full id ('${c.id}') going forward.`,
              }
            : {}),
          /**
           * Present ONLY for a consult conversation, so no existing consumer
           * shape changes. `conversation.state` above is the CONVERSATION's
           * state and stays 'open' after the consult itself has expired and
           * closed; `consult.state` is the lifecycle answer. Read this one
           * before concluding anything about whether a consult is still live —
           * and note that empty `posts` is NOT evidence of a stalled consult,
           * because a cascade advance wakes the next selectee instead of
           * posting to the thread (EI-21510601647367544).
           */
          ...(consult
            ? {
                consult: {
                  state: consult.state,
                  latency_contract: consult.latency_contract,
                  responder_id: consult.responder_id,
                  expires_at: consult.expires_at,
                  closed_at: consult.closed_at,
                  wakes_used: consult.wakes_used,
                  session_cost: consult.session_cost,
                  // Why each answering-session launch failed (WI-10003197);
                  // present only once a dispatch walk has been recorded.
                  ...(consult.dispatch ? { dispatch: consult.dispatch } : {}),
                },
              }
            : {}),
          conversation: {
            id: c.id,
            kind: c.kind,
            state: c.state,
            scope: c.scope,
            harness_slug: c.harness_slug,
            title: c.title,
            body: c.body,
            asker_id: c.asker_id,
            accepted_answer: c.accepted_answer,
            accepted_post_id: c.accepted_post_id,
            capture_target: c.capture_target,
            promoted_issue_id: c.promoted_issue_id,
            /** Which tool opened this. Readable on an ANSWERED conversation, not
             *  just an open one (EI-21462599108204160). null = opened before the
             *  column existed, or federated from a pre-attribution peer. */
            producer: c.producer,
            created_ts: c.created_ts,
            resolved_ts: c.resolved_ts,
          },
          topics,
          subscriber_count,
          posts: posts.map((p) => ({ id: p.id, author_id: p.author_id, body: p.body, created_ts: p.created_ts })),
        };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
