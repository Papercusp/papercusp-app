/**
 * claims:retract — retract (or reinstate) a carried CLAIM by its id, once, so every
 * surface that renders it shows `⛔ RETRACTED` instead of serving it as fact
 * (EI-23765337478012299). The claim id is a carried `checks[]` row's `id`
 * (loop:checkpoint / work_items:checkpoint) or a `claim:<id>` mention in prose.
 *
 * Append-only: the original row/prose is never edited — a retraction is an EVENT
 * about the id, and `reinstate:true` appends the reversal, so an over-retraction is
 * repairable and the full oscillation stays auditable.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  CLAIM_BECAUSE_MAX,
  CLAIM_SUPERSEDED_BY_MAX,
  recordClaimEvent,
  renderRetractedMarker,
  isRetracted,
} from '../../claim-retractions';

export default defineTool({
  name: 'claims:retract',
  capability: 'coord:write',
  description:
    'Retract a carried claim by id (a checks[] row `id`, or `claim:<id>` in prose) with a reason — carry briefs then render it ⛔ RETRACTED instead of as a standing fact. Append-only; reinstate:true reverses it.',
  guidance: {
    when:
      'A claim you or a peer carried (a loop:checkpoint / work_items:checkpoint checks[] row with an id) turned out wrong. Retract it ONCE here instead of hand-writing "retracted" into titles/prose on each surface you remember — every surface you forget keeps serving the dead claim.',
    notWhen:
      'The claim is merely refined/updated — re-checkpoint the row with the same id. A row with no id has no identity to retract: re-checkpoint it WITH an id first.',
    chaining:
      'Give the check row an `id` at write time (checks: [{ id, claim, recheck }]); later claims:retract { claimId, because, supersededBy? }. Over-retracted? claims:retract { claimId, because, reinstate:true }.',
    seeAlso: ['loop:checkpoint (checks[].id)', 'work_items:checkpoint (checks[].id)', 'facts:retract (standing FACTS, not claims)'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: z.object({
    claimId: z.string().min(1).max(80).describe('The claim id — a checks[] row `id`, or the `<id>` of a `claim:<id>` mention. A leading `claim:`/`#` is stripped.'),
    because: z.string().min(1).max(CLAIM_BECAUSE_MAX).describe('Why the claim is wrong (or, with reinstate, why the retraction was wrong). Shown beside the ⛔ marker.'),
    supersededBy: z
      .string()
      .max(CLAIM_SUPERSEDED_BY_MAX)
      .optional()
      .describe('What replaces it — a work-item id, a claim id, or a short pointer to the corrected conclusion.'),
    reinstate: z.boolean().optional().describe('Reverse a prior retraction (the claim stands again). Refused when the claim is not currently retracted.'),
  }),
  async handler(args, ctx) {
    const { resolveAgentIdentity } = await import('../coordination/identity');
    const identity = resolveAgentIdentity(ctx);
    const result = await recordClaimEvent({
      claimId: args.claimId,
      kind: args.reinstate ? 'reinstate' : 'retract',
      because: args.because,
      supersededBy: args.supersededBy ?? null,
      actor: identity.ownerId,
    });
    if (!result.ok) return { data: { ok: false, error: result.error, detail: result.detail } };
    return {
      data: {
        ok: true,
        changed: result.changed,
        claimId: result.standing.claimId,
        standing: isRetracted(result.standing) ? 'retracted' : 'standing',
        eventSeq: result.standing.eventSeq,
        rendered: isRetracted(result.standing) ? renderRetractedMarker(result.standing) : null,
      },
    };
  },
});
