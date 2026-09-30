/**
 * coord:couple — declare that two agents are working alongside each other.
 *
 * Plan: unified-agent-state-plane-2026-07-27, P-031 (ruling D-061).
 *
 * Coupling is the relevance gate on peer state: coupled peers are the ones worth
 * showing an agent in detail. It was DERIVED only (shared locks, recent coord
 * exchange, a plan blocked-by edge, awaiting an event they emit), so an agent that
 * already KNEW it was working alongside a peer had to wait for a derivation to
 * notice. This is the declaration path.
 *
 * NO RESTRICTIONS, deliberately (D-061 R1). Any agent may couple ANY two agents,
 * including a pair it is not part of — a third agent that spots two peers about to
 * collide is exactly the case worth serving. There is nothing to authorize here:
 * coupling decides which already-readable peers are worth surfacing, never what
 * may be read. The one refusal is a self-pair: an agent coupled to itself is not
 * a relation.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, resolveSelfLiteral } from '../identity';
import { COORD_ROLES } from '../roles';
import { declareCoupling, listCouplingsFor, peerOf, COUPLING_REASON_MAX } from '../../../coord/couplings';

export default defineTool({
  name: 'coord:couple',
  description:
    'Declare that two agents are coupled — working alongside each other, so each is worth surfacing in the other\'s peer state. Either agent arg accepts the literal "self"; `a` defaults to you, so { b } couples you with that agent. You may couple ANY two agents, including a pair you are not part of. Symmetric: coupling a↔b is one edge, not two. Re-coupling refreshes the reason/TTL, and coupling a pair you previously decoupled lifts that suppression. Returns the edge plus `a`\'s current declared couplings.',
  guidance: {
    when: 'You know you are working alongside a peer (same file, same deliverable, one of you blocks the other) and want their goal + state surfaced to you without waiting for a derivation to infer it — or you can see TWO OTHER agents heading for the same work and want each to see the other.',
    notWhen: 'You just want to read who is around — that is coord:presence. Coupling is a standing declaration, not a one-off lookup, and it grants no access: it only changes whose state is worth showing.',
    chaining: 'coord:couple { b: <peer> } → coord:presence (the coupled peer now rides your peer state) → coord:decouple { b: <peer> } when the shared work ends.',
    seeAlso: ['coord:decouple (end a coupling, or pre-empt a derived one)', 'coord:presence (who is around)'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    a: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('First agent — an ownerId, or "self". Defaults to you, so the common call is just { b }.'),
    b: z.string().min(1).max(200).describe('Second agent — an ownerId, or "self".'),
    reason: z
      .string()
      .max(COUPLING_REASON_MAX)
      .optional()
      .describe('Why they are coupled, for whoever finds the edge later ("both editing sync-resolver").'),
    ttlSec: z
      .number()
      .int()
      .positive()
      .max(30 * 24 * 3600)
      .optional()
      .describe('Expire the coupling after this many seconds. Omit for no TTL — it stands until someone decouples.'),
  }),
  async handler(args, ctx) {
    const me = resolveAgentIdentity(ctx);
    const a = (resolveSelfLiteral(args.a, me.ownerId) ?? me.ownerId).trim();
    const b = (resolveSelfLiteral(args.b, me.ownerId) ?? '').trim();
    if (!b) {
      return { data: { ok: false, error: 'missing_agent', detail: 'pass `b` (an ownerId or "self")' } };
    }
    if (a === b) {
      return {
        data: {
          ok: false,
          error: 'self_pair',
          detail: `an agent cannot be coupled to itself (both args resolved to ${a})`,
          hint: 'coupling is a relation BETWEEN two agents — pass a peer\'s ownerId as `b`',
        },
      };
    }
    const edge = await declareCoupling({
      agentA: a,
      agentB: b,
      declaredBy: me.ownerId,
      reason: args.reason ?? null,
      ttlSec: args.ttlSec ?? null,
    });
    if (!edge) {
      return { data: { ok: false, error: 'not_coupled', detail: 'the pair could not be normalized' } };
    }
    // `a`'s couplings, not the caller's: on a third-party couple the caller may be
    // in neither pair, and echoing the caller's own set would answer a question
    // nobody asked.
    const edges = await listCouplingsFor(a);
    return {
      data: {
        ok: true,
        coupled: { a: edge.agentA, b: edge.agentB },
        declaredBy: edge.declaredBy,
        reason: edge.reason,
        expiresAt: edge.expiresAt,
        thirdParty: a !== me.ownerId && b !== me.ownerId,
        couplingsOf: a,
        couplings: edges.map((e) => ({
          peer: peerOf(e, a),
          state: e.state,
          reason: e.reason,
          declaredBy: e.declaredBy,
          expiresAt: e.expiresAt,
        })),
      },
    };
  },
});
