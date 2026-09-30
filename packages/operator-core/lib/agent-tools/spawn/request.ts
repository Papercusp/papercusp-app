/**
 * new_subagent:request — ask the BRAIN to spin up a new sub-agent
 * (unify-agent-spawn-chokepoint-2026-06-06, P-005 / D-002 / D-008).
 *
 * Admission is the brain's judgment, not a rules budget: any agent may INITIATE a
 * spawn request (decentralized initiative), it routes to the brain as a typed,
 * brain-only-approvable request, and the requester sleeps on `events:await` until
 * the brain decides. Composed from the existing escalation request→resolve fold +
 * the wake-on-grant rail; the request carries `meta.spawnRequest`, which makes it
 * resolvable ONLY by the brain-gated `new_subagent:approve` (see resolveEscalation's
 * guard + new_subagent:approve's requireRoles).
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { armEscalationRequesterInterest, openEscalation } from '../coordination/escalations';

export default defineTool({
  name: 'new_subagent:request',
  description:
    'Request the brain spin up a new sub-agent. Routes a typed, brain-only-approvable request; you then events:await the grant and spawn on approval. The BRAIN decides whether it is worth it (informed by the live spawn headroom + open work) — this is judgment, not a rules budget.',
  guidance: {
    when: 'You want to spawn a sub-agent (a helper/specialist) as an autonomous initiative beyond your own role — a spawn worth a brain decision.',
    notWhen:
      'You ARE the brain/operator (you allocate directly) OR this is already-decided pipeline work (the pipeline admits its own role progression) OR a human-initiated psu session (no request needed).',
    chaining:
      'new_subagent:request → events:await { event: <await_event> } (end your turn) → on wake, if choice="approve", capability:launch-agent { harness, members:[{ role, feature }] }.',
    seeAlso: [
      'new_subagent:approve (the brain approves the request)',
      'capability:launch-agent (spawn once approved)',
      'events:await (wait for the approval decision)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  args: z.object({
    role: entityRef('role', {
      describe: 'The child agent role to spawn (an AGENT_ROLES id or a plugin-namespaced role).',
    }),
    harness: z.string().optional().describe('Harness slug to spawn into.'),
    feature: z.string().optional().describe('Feature id the child should work, if any.'),
    reason: z.string().min(1).describe('Why this spawn is worth it — the brain reads this to decide.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Surface the live limit/headroom so the brain's worth-it call is informed (P-007).
    let headroom: { ceiling: number; running: number; headroom: number } | null = null;
    if (ctx.workspaceId) {
      try {
        const { getSpawnHeadroom } = await import('../../fleet/operator-spawn');
        headroom = await getSpawnHeadroom(ctx.workspaceId);
      } catch {
        /* best-effort — the brain can still decide without the live number */
      }
    }

    // P-009 pre-alloc: if the brain has granted this requester's STREAM a spawn
    // budget (a fleet_governor credit pool keyed `spawn-budget:<owner>`, granted via
    // `fleet:governor { op:'grant_n', scopeKey }`), consume one + AUTO-APPROVE here —
    // per-spawn brain adjudication is OPTIONAL for a trusted stream with budget. Only
    // when the budget is exhausted (or none was granted) does the request route to
    // the brain. Decentralized initiative + the brain still sets the budget (D-002).
    if (ctx.workspaceId) {
      try {
        const { getOrgPg } = await import('@papercusp/db-org');
        const { tryConsumeSpawnCredit, spawnBudgetScopeKey } = await import('../../fleet/governor');
        const budgetScope = spawnBudgetScopeKey(identity.ownerId);
        if (await tryConsumeSpawnCredit(getOrgPg().sql, { workspaceId: ctx.workspaceId, scopeKey: budgetScope })) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  approved: true,
                  via: 'budget',
                  budget_scope: budgetScope,
                  next:
                    `Pre-approved from your stream budget (no brain round-trip) — ` +
                    `capability:launch-agent {${args.harness ? ` harness: "${args.harness}",` : ''} members: [{ role: "${args.role}"${args.feature ? `, feature: "${args.feature}"` : ''} }] }.`,
                }),
              },
            ],
          };
        }
      } catch {
        /* best-effort — fall through to the brain-approval request */
      }
    }

    const rec = await openEscalation(identity, {
      severity: 'question',
      summary: `${identity.ownerLabel ?? identity.ownerId} requests a ${args.role} sub-agent${args.harness ? ` in ${args.harness}` : ''}`,
      body:
        `**Requested role:** \`${args.role}\`` +
        `${args.harness ? `  ·  **harness:** \`${args.harness}\`` : ''}` +
        `${args.feature ? `  ·  **feature:** \`${args.feature}\`` : ''}\n\n` +
        `**Why:** ${args.reason}\n\n` +
        (headroom
          ? `**Live spawn headroom:** ${headroom.running}/${headroom.ceiling} running (${headroom.headroom} free).\n\n`
          : '') +
        `Approve → the requester spawns it; deny → it does not. Only the brain may resolve this (new_subagent:approve).`,
      options: [
        { id: 'approve', label: `Approve — spawn the ${args.role}` },
        { id: 'deny', label: 'Deny — not worth it right now' },
      ],
      meta: {
        spawnRequest: true,
        requestedRole: args.role,
        harness: args.harness ?? null,
        feature: args.feature ?? null,
        reason: args.reason,
        requester: identity.ownerId,
      },
    });
    const awaitEvent = `escalation:resolved:${rec.msg_id}`;
    const interestWatch = await armEscalationRequesterInterest(identity.ownerId, rec.msg_id);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            request_id: rec.msg_id,
            await_event: awaitEvent,
            interest_watch: interestWatch,
            headroom,
            next:
              `events:await { event: "${awaitEvent}" } then end your turn. On wake, if choice==="approve", ` +
              `capability:launch-agent {${args.harness ? ` harness: "${args.harness}",` : ''} members: [{ role: "${args.role}"${args.feature ? `, feature: "${args.feature}"` : ''} }] }.`,
          }),
        },
      ],
    };
  },
});
