/**
 * pot:request_work — initiate a cross-Pot WORK-REQUEST to a peer Pot
 * (hive-network-surface-2026-06-11 P-003, brief B-04). The initiating side of the
 * sovereignty boundary for handing WORK across Pots: THIS Pot addresses a peer
 * Pot (by pubkey), and — if the peer has granted us `work-request` — the
 * envelope becomes a `change` work_item in THEIR backlog, which THEIR Mug
 * triages and prioritizes like any other work (we cannot jump their priorities).
 * The peer's acceptance/decline comes back through our boot-wired boundary and is
 * recorded in the C-1 ledger; await it on the returned answeredEvent key.
 *
 * Use to ask a peer Pot to DO something in its domain — not for a question
 * (pot:ask). Steer-don't-dispatch: we request; the peer Mug stays the
 * authority over whether/when it runs.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { hardText } from '../limits';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { sendCrossHiveAsk } from '../../cross-hive-ask-send';
import { productionSendCrossPotAskDeps } from './_cross-pot-ask-deps';

const json = (o: unknown) => ({ data: o });

export default defineTool({
  name: 'pot:request_work',
  profile: 'engineer',
  description:
    "Initiate a cross-Pot WORK-REQUEST to a peer Pot (by pubkey): ask the peer to do something in its domain. The envelope is signed, sent store-and-forward, and recorded in this Pot's ask ledger; it becomes a work_item in the peer's backlog that THEIR pot operator prioritizes. The peer's response arrives asynchronously — events:await the returned answeredEvent key. Requires an outbound grant to the peer.",
  guidance: {
    when: 'You or the owner want a peer Pot to take on a piece of work in its domain. Find the peer via discovery:pots, then pot:request_work, then events:await the returned answeredEvent.',
    notWhen:
      'Asking a QUESTION (use pot:ask). Placing work on your OWN Swarm (work_items:* / fleet:*). Granting a peer to send work-requests INTO this Pot (that is the inbound pot:cross_grant).',
    chaining:
      'discovery:pots (find the peer Pot pubkey) → pot:request_work { pot, peerPotPubkey, subject, body } → events:await { event: <answeredEvent> }. Review outstanding requests with pot:asks.',
    seeAlso: [
      'pot:asks (review outstanding requests + replies)',
      'pot:ask (ask a QUESTION instead of requesting work)',
      'discovery:pots (find the peer Pot to request from)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    pot: entityRef('pot', { soft: true, max: 120, describe: "THIS Pot's home slug — the requesting Pot (signer + boundary are scoped to it)." }),
    peerPotPubkey: z.string().min(1).max(400).describe('The peer Pot\'s pubkey (from discovery:pots) to address the work-request to.'),
    subject: z.string().min(1).max(200).describe('A short title for the requested work.'),
    body: hardText(8000).describe('What is being requested (becomes the peer work_item\'s summary).'),
    workspace: z.string().max(120).optional(),
    askedBy: z.string().max(200).optional().describe('Your coord ownerId (su-…). When supplied, the C-4 reply event fires with `to:[askedBy]` so you are woken on the answer rather than polling.'),
  }),
  async handler(args) {
    const ws = args.workspace ?? activeWorkspaceId();
    const result = await sendCrossHiveAsk(
      { workspaceId: ws, potSlug: args.pot, peerPubkey: args.peerPotPubkey, kind: 'work-request', subject: args.subject, body: args.body, askedBy: args.askedBy },
      productionSendCrossPotAskDeps(),
    );
    return json(result);
  },
});
