/**
 * fleet:governor — configure / record against the backpressure governor (P2, D-005).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. The curator's control-loop knob:
 * seed a token bucket (spend ceiling / bulkhead), a circuit breaker, or a credit pool;
 * grant credits as a downstream drains; record a spawn's success/failure against a
 * circuit. Admission itself is fleet:admit.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  configureBucket, configureCircuit, configureCredits, grantCredits,
  recordCircuitSuccess, recordCircuitFailure,
} from '../../fleet/governor';

export default defineTool({
  name: 'fleet:governor',
  profile: 'engineer',
  description:
    'Configure the backpressure governor: set a token bucket (spend ceiling/bulkhead), a circuit breaker, or a credit pool; grant credits; or record a spawn success/failure against a circuit.',
  guidance: {
    when: 'Seeding or tuning fleet backpressure (the curator owns this). scope_key examples: "global", "harness:papercup", "user:alice", "role:worker".',
    chaining: 'fleet:governor { op:"set_bucket", scope_key:"global", capacity, refill_per_sec } → fleet:admit per spawn.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    op: z.enum(['set_bucket', 'set_circuit', 'set_credits', 'grant_credits', 'record_success', 'record_failure']),
    scope_key: z.string().min(1).max(160),
    capacity: z.number().min(0).optional(),
    refill_per_sec: z.number().min(0).optional(),
    tokens: z.number().min(0).optional(),
    threshold: z.number().int().min(1).optional(),
    cooldown_sec: z.number().int().min(1).optional(),
    credits: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
    n: z.number().int().optional(),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    const actor = resolveAgentIdentity(ctx);
    const workspaceId = args.workspace ?? actor.workspaceId ?? activeWorkspaceId();
    const { sql } = getOrgPg();
    const sk = args.scope_key;
    let result: unknown = { ok: true };
    switch (args.op) {
      case 'set_bucket':
        await configureBucket(sql, { workspaceId, scopeKey: sk, capacity: args.capacity ?? 0, refillPerSec: args.refill_per_sec ?? 0, tokens: args.tokens });
        break;
      case 'set_circuit':
        await configureCircuit(sql, { workspaceId, scopeKey: sk, threshold: args.threshold, cooldownSec: args.cooldown_sec });
        break;
      case 'set_credits':
        await configureCredits(sql, { workspaceId, scopeKey: sk, credits: args.credits ?? 0, max: args.max });
        break;
      case 'grant_credits':
        result = { ok: true, credits: await grantCredits(sql, { workspaceId, scopeKey: sk, n: args.n ?? 1 }) };
        break;
      case 'record_success':
        await recordCircuitSuccess(sql, { workspaceId, scopeKey: sk });
        break;
      case 'record_failure':
        result = { ok: true, circuit: await recordCircuitFailure(sql, { workspaceId, scopeKey: sk }) };
        break;
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
});
