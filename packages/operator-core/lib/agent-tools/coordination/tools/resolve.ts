/**
 * coord:resolve — record the human's choice on one OR many escalations.
 *
 * Append-only: writes a sibling `escalation_resolved` event per escalation; the
 * open escalation file is never mutated. Idempotent on an already-resolved
 * escalation (returns already_resolved without appending).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): resolve ONE inline
 * ({ msg_id, choice, note? }), MANY with the SAME choice/note (msg_ids:[…] +
 * choice), or MANY heterogeneous (items:[{ msg_id, choice, note? }]) → { ok,
 * results:[{ ok, msg_id, escalation? | error }], counts }. Each result
 * self-describes its msg_id; a not_found / already_resolved on one never fails the
 * rest.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { resolveEscalation } from '../escalations';
import { unblockLinkedCard } from '../card-link';
import { COORD_ROLES } from '../roles';
import { runBulk, bulkContent } from '../../_bulk';

/**
 * EI-843: the Mug wake brief renders open escalations as AttentionItem-style
 * `escalation:<msg_id>` digest ids (mug-brief-launch.ts's `gatherEscalations`,
 * reusing the same prefixed-id format the triage-store "handled" overlay keys
 * on) — NOT a bare coord msg_id. Passing that digest id straight back into
 * coord:resolve used to 404 as not_found for every escalation surfaced by the
 * brief. Strip the prefix here (once, at the tool boundary every caller goes
 * through) so both forms resolve identically; a bare msg_id is unaffected.
 */
function normalizeEscalationMsgId(id: string): string {
  return id.startsWith('escalation:') ? id.slice('escalation:'.length) : id;
}

const itemSpec = z.object({
  msg_id: z.string().min(1).describe('the escalation msg_id (alias: id)'),
  id: z.string().min(1).optional().describe('alias for msg_id'),
  choice: z.string().min(1).describe('the chosen option id (or arbitrary string)'),
  note: z.string().optional(),
});

export default defineTool({
  name: 'coord:resolve',
  description:
    'Resolve one OR many escalations by msg_id. Records the chosen option id (or arbitrary string) and optional note as an append-only escalation_resolved event. Single: { msg_id, choice, note? }. Many same choice: { msg_ids:[…], choice, note? }. Many heterogeneous: items:[{ msg_id, choice, note? }]. Accepts either a bare msg_id or the `escalation:<msg_id>` digest id the Mug wake brief renders — both resolve the same escalation. Returns { ok, results:[{ ok, msg_id, escalation? | error }], counts } — correlate by msg_id; a not_found / already_resolved on one item never fails the rest.',
  guidance: {
    when: 'The human (or an authorised agent acting on their behalf) has decided how to proceed on open escalation(s). Resolve several at once via msg_ids:[…]+choice or items:[…].',
    notWhen: 'Acknowledging without deciding — use coord:ack. The escalation file is the human-resolution surface.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      msg_id: z.string().min(1).optional().describe('single-resolve shorthand: the escalation msg_id'),
      id: z.string().min(1).optional().describe('alias for msg_id (single form)'),
      choice: z.string().min(1).optional().describe('the chosen option id; applies to the inline msg_id / every id in `msg_ids`'),
      note: z.string().optional().describe('optional note; applies to the inline msg_id / every id in `msg_ids`'),
      msg_ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('resolve MANY escalations with the same `choice`/`note` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('resolve many escalations at once — each { msg_id, choice, note? }'),
    })
    .refine(
      (a) =>
        (a.items?.length ?? 0) > 0 ||
        (Boolean(a.choice) && ((a.msg_ids?.length ?? 0) > 0 || Boolean(a.msg_id) || Boolean(a.id))),
      { message: 'pass { msg_id, choice } for one, { msg_ids:[…], choice } for many same-choice, or items:[{ msg_id, choice }] for many' },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items.map((it) => ({ msg_id: normalizeEscalationMsgId(it.msg_id ?? (it.id as string)), choice: it.choice, note: it.note }))
      : args.msg_ids?.length
        ? args.msg_ids.map((msg_id) => ({ msg_id: normalizeEscalationMsgId(msg_id), choice: args.choice as string, note: args.note }))
        : [{ msg_id: normalizeEscalationMsgId((args.msg_id ?? args.id) as string), choice: args.choice as string, note: args.note }];
    const env = await runBulk(
      list,
      async (it) => {
        const out = await resolveEscalation({
          msg_id: it.msg_id,
          choice: it.choice,
          note: it.note,
          resolver: identity.ownerId,
        });
        if (out === 'not_found') {
          return { ok: false as const, msg_id: it.msg_id, error: 'not_found', detail: `no escalation with msg_id=${it.msg_id}` };
        }
        if (out === 'already_resolved') {
          return { ok: false as const, msg_id: it.msg_id, error: 'already_resolved', detail: `escalation msg_id=${it.msg_id} already has a resolution` };
        }
        if (out === 'requires_spawn_approve') {
          // unify-agent-spawn-chokepoint P-005/P-006: a new_subagent spawn-approval
          // request is brain-only — coord:resolve (open to all coord roles) may not
          // decide it; route the brain to the gated tool.
          return {
            ok: false as const,
            msg_id: it.msg_id,
            error: 'requires_spawn_approve',
            detail: `msg_id=${it.msg_id} is a new_subagent spawn request — only the brain may decide it, via new_subagent:approve`,
          };
        }
        // inbox-cards-unification Phase D (P-035): if this escalation was linked to
        // a live ctx.askUser card (agent blocked waiting), unblock it too so an
        // inbox resolution resumes the agent. No-op when unlinked (flag-off) or the
        // card already resolved; the escalation is resolved regardless.
        unblockLinkedCard(out, it.choice);
        return { ok: true as const, msg_id: it.msg_id, escalation: out };
      },
      { keyOf: (it) => ({ msg_id: it.msg_id }) },
    );
    return bulkContent(env);
  },
});
