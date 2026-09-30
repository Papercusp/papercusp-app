/**
 * coord:decouple — stop two agents from being surfaced to each other in detail.
 *
 * Plan: unified-agent-state-plane-2026-07-27, P-031 (ruling D-061 R4).
 *
 * A DECOUPLE IS A SUPPRESSION, NOT A DELETE — and that is the whole subtlety.
 * Coupling is `derived ∪ declared`, and a decouple cannot un-make a derivation:
 * the shared lock really is held, the blocked-by edge really exists, so a decouple
 * that merely deleted the declared row would be silently re-created by the next
 * derivation tick. The agent would decouple, watch it come back, and reasonably
 * conclude the tool is broken. So it records a durable mask that outlives the
 * tick — visible on the pair, with its author, so a later reader can tell "never
 * coupled" from "deliberately decoupled by someone".
 *
 * Unrestricted like coord:couple (D-061 R1): any agent may decouple any two
 * agents, including a pair it is not part of.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, resolveSelfLiteral } from '../identity';
import { COORD_ROLES } from '../roles';
import { suppressCoupling, listCouplingsFor, peerOf, COUPLING_REASON_MAX } from '../../../coord/couplings';

export default defineTool({
  name: 'coord:decouple',
  description:
    'Stop two agents from being surfaced to each other in detail. Either agent arg accepts "self"; `a` defaults to you, so { b } decouples you from that agent. You may decouple ANY two agents, including a pair you are not part of. This SUPPRESSES the pair rather than deleting an edge, so it also holds against a coupling that would otherwise be DERIVED (shared locks, coord traffic, a blocked-by edge) — a decouple survives the next derivation tick instead of silently coming back. Re-couple with coord:couple to lift it.',
  guidance: {
    when: 'The shared work ended, or you no longer want a peer\'s state riding your reads. Decoupling is the cost control: each coupled peer adds their goal + state to every read that renders coupling, so a coupling you have stopped using is pure token spend on both sides. Decouple when you stop needing to watch each other.',
    notWhen: 'You only want to mute a noisy sender — that is not what coupling controls. Coupling governs whose STATE is surfaced to you, not who may message or wake you.',
    chaining: 'coord:decouple { b: <peer> } → the peer stops appearing in your coupled peer state; coord:couple { b: <peer> } re-couples if the work resumes.',
    seeAlso: ['coord:couple (declare a coupling)', 'coord:presence (who is around)'],
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
      .describe('Why they were decoupled, for whoever finds the suppression later ("shared work shipped").'),
    ttlSec: z
      .number()
      .int()
      .positive()
      .max(30 * 24 * 3600)
      .optional()
      .describe('Lift the suppression automatically after this many seconds. Omit for a standing decoupling.'),
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
        },
      };
    }
    const edge = await suppressCoupling({
      agentA: a,
      agentB: b,
      declaredBy: me.ownerId,
      reason: args.reason ?? null,
      ttlSec: args.ttlSec ?? null,
    });
    if (!edge) {
      return { data: { ok: false, error: 'not_decoupled', detail: 'the pair could not be normalized' } };
    }
    const edges = await listCouplingsFor(a);
    return {
      data: {
        ok: true,
        decoupled: { a: edge.agentA, b: edge.agentB },
        // Named so the caller understands what actually happened: the pair is
        // MASKED, which is what makes it hold against a live derivation.
        state: edge.state,
        suppressesDerived: true,
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
