/**
 * conversations:promote — a question/discussion that concludes "this is a real
 * problem" promotes into an engineer issue (coordination-conversations D-005).
 * It CARRIES its thread (re-parented onto the issue, not migrated), mints the
 * engineer_issues row via the issues surface (carrying the conversation's topic
 * tags + scope), closes the conversation, and records the issue id. The
 * discussion then continues on the issue.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): promote ONE inline
 * ({ id, severity?, source?, harness? }), MANY with the SAME severity/source/harness
 * (ids:[…] + scalars), or MANY heterogeneous (items:[{ id, severity?, source?,
 * harness? }]) → { ok, results:[{ ok, id, issue? | error }], counts }. Each result
 * self-describes its id; one not-found item never fails the rest.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { promoteConversation } from '../conversations';
import { runBulk, bulkContent } from '../../_bulk';

const SEVERITY = z.enum(['critical', 'major', 'minor', 'nit']);
const SOURCE = z.enum(['engineer', 'su']);

const itemSpec = z.object({
  id: z.string().min(1).describe('conversation id (alias: conversation_id)'),
  conversation_id: z.string().min(1).optional().describe('alias for id'),
  severity: SEVERITY.optional().describe('Issue severity (default minor).'),
  source: SOURCE.optional().describe('Issue source (default su).'),
  harness: z.string().optional().describe('Force a harness-scoped issue.'),
});

export default defineTool({
  name: 'conversations:promote',
  description:
    'Promote one OR many conversations (question/discussion) into engineer issues, carrying their thread. Mints an engineer_issues row (with the conversation\'s topics + scope), closes the conversation, and records the issue id. Single: { id, severity?, source?, harness? }. Many same severity/source: { ids:[…], severity?, source? }. Many heterogeneous: items:[{ id, severity?, source?, harness? }]. Returns { ok, results:[{ ok, id, issue? + thread_carried | error }], counts } — correlate by id; one not-found item never fails the rest. Use when a discussion concludes there is a real problem to track.',
  guidance: {
    when:
      'A conversation has concluded that there is a concrete, trackable problem — turn it into an issue so it can be claimed, prioritized, and promoted to a feature. Promote several at once via ids:[…] or items:[…].',
    notWhen:
      'A question that just needs an answer → conversations:resolve (captures the answer). An open discussion still in progress → leave it. To file a fresh issue unrelated to a conversation → work_items:create.',
    chaining:
      'conversations:get → conversations:promote → work_items:get / work_items:claim. The issue keeps the conversation\'s thread; further discussion uses work_items:comment.',
    seeAlso: [
      'conversations:get (inspect the conversation before promoting)',
      'work_items:claim (take the promoted work-item)',
      'conversations:resolve (close it with an answer instead of promoting)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-promote shorthand: the conversation id'),
      conversation_id: z.string().min(1).optional().describe('alias for id (single form)'),
      severity: SEVERITY.optional().describe('Issue severity (default minor); applies to the inline id / every id in `ids`.'),
      source: SOURCE.optional().describe('Issue source (default su); applies to the inline id / every id in `ids`.'),
      harness: z.string().optional().describe('Force a harness-scoped issue; applies to the inline id / every id in `ids`.'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('promote MANY conversations with the same severity/source/harness (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('promote many conversations at once — each { id, severity?, source?, harness? }'),
    })
    .refine(
      (a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id) || Boolean(a.conversation_id),
      { message: 'pass { id } for one, { ids:[…] } for many same-severity, or items:[{ id }] for many' },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items.map((it) => ({
          id: it.id ?? (it.conversation_id as string),
          severity: it.severity ?? args.severity,
          source: it.source ?? args.source,
          harness: it.harness ?? args.harness,
        }))
      : args.ids?.length
        ? args.ids.map((id) => ({ id, severity: args.severity, source: args.source, harness: args.harness }))
        : [
            {
              id: (args.id ?? args.conversation_id) as string,
              severity: args.severity,
              source: args.source,
              harness: args.harness,
            },
          ];
    const env = await runBulk(
      list,
      async (it) => {
        const res = await promoteConversation(identity, {
          conversation_id: it.id,
          severity: it.severity,
          source: it.source,
          harness: it.harness,
        });
        if ('error' in res) return { ok: false as const, id: it.id, error: res.error };
        return {
          ok: true as const,
          id: res.conversation.id,
          state: res.conversation.state,
          issue: res.issue,
          thread_carried: res.thread_reparented,
          notified_subscribers: res.delivered,
          hint: `Promoted to engineer issue ${res.issue.id}. The conversation is closed; the discussion continues via work_items:comment { id: "${res.issue.id}" }.`,
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
