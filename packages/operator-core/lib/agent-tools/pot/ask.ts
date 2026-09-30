/**
 * pot:ask — initiate a cross-Pot ASK to a peer Pot
 * (hive-network-surface-2026-06-11 P-003, brief B-04). The initiating side of the
 * sovereignty boundary: THIS Pot addresses a peer Pot (by pubkey, from
 * discovery:pots), the envelope lands at the peer's boundary and — if the peer
 * has granted us `ask` — becomes a conversation in THEIR substrate. The peer's
 * answer comes back asynchronously through our boot-wired boundary and is
 * recorded in the C-1 ledger; await it on the returned `answeredEvent` key.
 *
 * Use for a QUESTION the peer Pot is the authority on (it owns the domain) — not
 * to hand them work (that is pot:request_work). Dedupe via discovery:pots /
 * pot:asks first.
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
  name: 'pot:ask',
  profile: 'engineer',
  description:
    "Initiate a cross-Pot ASK to a peer Pot (by pubkey): a question the peer Pot owns the answer to. The envelope is signed, sent store-and-forward, and recorded in this Pot's ask ledger; the peer's answer arrives asynchronously — events:await the returned answeredEvent key. Requires an outbound grant to the peer.",
  guidance: {
    when: 'You or the owner need an answer another Pot is the authority on (it owns that domain). Find the peer via discovery:pots, then pot:ask, then events:await the returned answeredEvent.',
    notWhen:
      'Handing the peer WORK to do (use pot:request_work). Within-Pot questions (coord:send / coord:message-agent). Granting a peer to send asks INTO this Pot (that is the inbound pot:cross_grant).',
    chaining:
      'discovery:pots (find the peer Pot pubkey) → pot:ask { pot, peerPotPubkey, subject, body } → events:await { event: <answeredEvent> }. Review outstanding asks with pot:asks.',
    seeAlso: [
      'pot:asks (review outstanding asks + their replies)',
      'discovery:pots (find the peer Pot to ask)',
      'pot:request_work (ask a peer to DO work, not answer a question)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    pot: entityRef('pot', { soft: true, max: 120, describe: "THIS Pot's home slug — the asking Pot (signer + boundary are scoped to it)." }),
    peerPotPubkey: z.string().min(1).max(400).describe('The peer Pot\'s pubkey (from discovery:pots) to address the ask to.'),
    subject: z.string().min(1).max(200).describe('A short subject line for the ask.'),
    body: hardText(8000).describe('The question body.'),
    workspace: z.string().max(120).optional(),
    askedBy: z.string().max(200).optional().describe('Your coord ownerId (su-…). When supplied, the C-4 reply event fires with `to:[askedBy]` so you are woken on the answer rather than polling.'),
  }),
  async handler(args) {
    const ws = args.workspace ?? activeWorkspaceId();
    const result = await sendCrossHiveAsk(
      { workspaceId: ws, potSlug: args.pot, peerPubkey: args.peerPotPubkey, kind: 'ask', subject: args.subject, body: args.body, askedBy: args.askedBy },
      productionSendCrossPotAskDeps(),
    );
    return json(result);
  },
});
