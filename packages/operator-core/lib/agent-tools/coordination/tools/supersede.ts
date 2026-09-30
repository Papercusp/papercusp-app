/**
 * coord:supersede — correct a message you already sent, to the people who got it.
 *
 * plan `agent-epistemics-2026-08-02` P-004. From the session audit that motivated it:
 *
 *     "A wrong broadcast to 17 agents can only be corrected by another broadcast to
 *      17 agents — which invites a counter-retraction, and the Nth flip carries less
 *      information than the first. You built plans:add-decision precisely because
 *      'a message is not addressable after delivery' — but that only covers rulings.
 *      There's no equivalent for retracting an OBSERVATION, which is what actually
 *      cascaded."
 *
 * This closes both halves:
 *
 *  - **Reach**: the original envelope preserves `to`, so the correction re-resolves
 *    the ORIGINAL audience. One call, exactly the right set, no hand-retyped
 *    recipient list (and therefore no chance of the fabricated-ownerId mistake that
 *    silently dropped a whole multi-recipient send on 2026-08-02).
 *  - **The later reader**: the original row is marked superseded, so a peer running
 *    coord:catch-up afterwards is pointed at the correction instead of acting on
 *    retracted information. That reader is the silent half of a cascade — they
 *    generate no message and no argument, which is exactly why the problem survives
 *    a retraction everyone believes they have finished.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

import { COORD_ROLES } from '../roles';
import { resolveAgentIdentity } from '../identity';
import { getMessageById, getSupersededBy, markSuperseded, sendMessage } from '../messages';
import { planSupersession } from '../../../coord/supersede';

export default defineTool({
  name: 'coord:supersede',
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  description:
    'Correct a coord message YOU sent: delivers the correction to the ORIGINAL audience (re-resolved from the stored envelope, so you never retype a recipient list) and marks the original superseded so anyone catching up later sees the correction instead of acting on retracted information. The observation-shaped counterpart to plans:add-decision — use it INSTEAD of broadcasting a retraction to everyone a second time.',
  guidance: {
    when: 'You broadcast or sent something that turned out to be wrong, and the people who received it are still carrying it. Especially after a measurement you relayed does not survive re-checking.',
    notWhen:
      "Correcting SOMEONE ELSE's claim — reply to it instead (a reply is visibly attributed to you; only the original sender may supersede their own message). Also not for adding NEW information to an old thread: that is an ordinary coord:send.",
    chaining: 'plans:add-decision (for a RULING other lanes must follow, rather than an observation) · coord:catch-up (where a superseded original now surfaces its correction)',
  },
  args: z.object({
    msg_id: z.string().min(1).describe('The msg_id of YOUR message that is being corrected.'),
    correction: z
      .string()
      .min(1)
      .max(4000)
      .describe(
        'What is actually true. State the corrected claim outright — a bare "disregard my last" leaves the reader with a hole where a belief used to be, which is worse than the wrong belief because nothing prompts them to go find the right one.',
      ),
    summary: z.string().min(1).max(200).optional().describe('One-line headline for the correction (defaults to naming the superseded id).'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const original = await getMessageById(args.msg_id);
    const supersededBy = original ? await getSupersededBy(args.msg_id) : null;

    const plan = planSupersession({
      envelope: (original ?? null) as Parameters<typeof planSupersession>[0]['envelope'],
      ownerId: identity.ownerId,
      correction: args.correction,
      correctionSummary: args.summary,
      supersededByMsgId: supersededBy,
    });

    if (!plan.ok) {
      // A refusal is returned as DATA with a machine-readable `reason`, not thrown:
      // the caller's next action differs per reason (reply vs. re-check the id vs.
      // follow the chain), and an exception collapses that distinction into "it
      // broke", which sends an agent hunting a bug that is not there.
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, superseded: false, reason: plan.reason, detail: plan.detail, msg_id: args.msg_id }),
          },
        ],
      };
    }

    // SEND FIRST, then mark. A failure after this point leaves a delivered
    // correction and an unmarked original (noisy but safe); the reverse order
    // would tell every later reader to go find a correction that does not exist.
    const sent = await sendMessage(identity, {
      to: plan.audience,
      summary: plan.summary,
      body: plan.body,
      // Deliberately NOT expectsReply: a correction is a statement of fact, and
      // asking every recipient to acknowledge it is what turns one retraction
      // into the N-way counter-retraction thread this verb exists to prevent.
      related_msg_id: args.msg_id,
    });

    const correctionId = (sent as { msg_id?: string }).msg_id ?? '';
    const marked = correctionId ? await markSuperseded(args.msg_id, correctionId) : false;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            superseded: args.msg_id,
            correction_msg_id: correctionId,
            audience: plan.audience,
            /** false ⇒ the correction WAS delivered but the original is unmarked —
             *  later catch-up readers will not be pointed at it. Say so plainly
             *  rather than reporting a clean success. */
            original_marked: marked,
            note: marked
              ? `Correction delivered to the original audience (${plan.audience.length} selector(s)) and ${args.msg_id} is now marked superseded — anyone catching up later is pointed here instead of acting on it.`
              : `Correction DELIVERED, but ${args.msg_id} could not be marked superseded — later catch-up readers will still see the original as current. Re-run, or correct it in the thread.`,
          }),
        },
      ],
    };
  },
});
