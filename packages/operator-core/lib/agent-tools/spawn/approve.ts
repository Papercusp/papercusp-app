/**
 * new_subagent:approve — BRAIN-ONLY: approve or deny a new_subagent spawn request
 * (unify-agent-spawn-chokepoint-2026-06-06, P-006 / D-008 — the one genuinely new bit).
 *
 * Resolves a `new_subagent:request` + wakes the requester (which then spawns on
 * approve). The "only the brain decides" rule is enforced at the DISPATCH LAYER, not
 * prompt convention: `requireRoles: [BRAIN_PRINCIPAL_ROLE]` is the fail-closed RBAC
 * gate (the operator/brain principal carries that role; a spawned worker/scoper/etc.
 * carries none → denied), with `agentRoles: ['operator']` as defense-in-depth on the
 * orchestration axis. A superuser bypasses both (admin). This narrows what the
 * general `coord:resolve` left open to ALL coord roles.
 */
import { z } from 'zod';
import { defineTool, BRAIN_PRINCIPAL_ROLE } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveEscalation } from '../coordination/escalations';

export default defineTool({
  name: 'new_subagent:approve',
  description:
    'BRAIN-ONLY: approve or deny a pending new_subagent spawn request. Resolves it + wakes the requester (which spawns on approve). Enforced at the dispatch layer — only the brain (operator principal) or a superuser may call it.',
  guidance: {
    when: 'You are the brain and a new_subagent:request is pending; you have judged whether the spawn is worth it given open work + the live spawn headroom.',
    notWhen: 'You are a pipeline/worker agent — you cannot approve spawns (the gate denies you). To ASK for a spawn, use new_subagent:request.',
    seeAlso: [
      'new_subagent:request (ASK for a spawn — the counterpart)',
      'capability:launch-agent (spawn after approval)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  requireRoles: [BRAIN_PRINCIPAL_ROLE],
  agentRoles: ['operator'],
  args: z.object({
    request_id: z.string().min(1).describe('The new_subagent:request msg_id.'),
    decision: z.enum(['approve', 'deny']),
    note: z.string().optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const out = await resolveEscalation(
      { msg_id: args.request_id, choice: args.decision, note: args.note, resolver: identity.ownerId },
      { allowSpawnRequest: true },
    );
    if (out === 'not_found') {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'not_found', detail: `no spawn request msg_id=${args.request_id}` }) }],
        isError: true,
      };
    }
    if (out === 'already_resolved') {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'already_resolved', detail: `request ${args.request_id} already decided` }) }],
        isError: true,
      };
    }
    if (out === 'requires_spawn_approve') {
      // Defensive — we pass allowSpawnRequest, so this branch shouldn't be reached.
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'requires_spawn_approve' }) }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, decision: args.decision, request_id: args.request_id }) }],
    };
  },
});
