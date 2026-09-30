/**
 * fleet:admit — the backpressure admission gate (P2, D-005).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. Before spawning, ask the governor
 * whether the fleet can afford it: the global token bucket (spend ceiling), the
 * per-harness/user bulkhead, the harness/role circuit breaker, and the role's credits
 * — all-or-nothing. On admit it debits the buckets + consumes a credit.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { admitSpawn } from '../../fleet/governor';

export default defineTool({
  name: 'fleet:admit',
  profile: 'engineer',
  description:
    'Ask the backpressure governor whether a spawn is affordable (global spend ceiling + per-harness/user bulkhead + circuit breaker + role credits). Debits the buckets/credit on admit; consumes nothing on refusal.',
  guidance: {
    when: 'Before spawning an agent, to bound runaway fleet spend. Unconfigured scopes are unconstrained, so this is a no-op until the curator seeds governor cells via fleet:governor.',
    chaining: 'fleet:governor (seed buckets/circuits/credits) → fleet:admit (per spawn) → spawn if admitted.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().max(120).optional(),
    user: z.string().max(120).optional(),
    role: z.string().max(80).optional(),
    cost: z.number().min(0).max(1_000_000).optional().describe('Tokens to debit (default 1).'),
    circuit_key: z.string().max(160).optional(),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    const actor = resolveAgentIdentity(ctx);
    const workspaceId = args.workspace ?? actor.workspaceId ?? activeWorkspaceId();
    const { sql } = getOrgPg();
    const res = await admitSpawn(sql, {
      workspaceId, cost: args.cost, harness: args.harness, user: args.user, role: args.role, circuitKey: args.circuit_key,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] };
  },
});
