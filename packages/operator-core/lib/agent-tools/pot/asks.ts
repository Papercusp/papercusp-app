/**
 * pot:asks — review this Pot's cross-Pot ask ledger
 * (hive-network-surface-2026-06-11 P-003, brief B-04). Lists the durable C-1
 * record of cross-Pot requests this Pot initiated (and, with direction:'in',
 * inbound ones) — each row carries the peer pubkey, kind, subject, correlation
 * id, state (queued | sent | answered | declined | expired) and the reply body
 * once it arrives. The read-back for the pot:ask / pot:request_work loop and
 * the dedupe check before initiating a new ask.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import type { ListCrossHiveAsksFilter } from '../../cross-hive-asks-store-port';
import { productionCrossPotAsksStore } from './_cross-pot-ask-deps';

const json = (o: unknown) => ({ data: o });

export default defineTool({
  name: 'pot:asks',
  profile: 'engineer',
  description:
    "List this Pot's cross-Pot ask ledger: the requests it initiated to peer Pots (and inbound ones with direction:'in'), with each row's peer, kind, subject, correlation id, state (queued|sent|answered|declined|expired) and reply. Filter by state / direction / peer / kind.",
  guidance: {
    when: 'Reviewing the status of cross-Pot asks/work-requests — what is still pending, what was answered/declined — or deduping before initiating a new ask to a peer that already owns one.',
    notWhen:
      'Inbound admission policy (pot:cross_grant list shows who may send INTO this Pot). Within-Pot work status (work_items:* / harness:status). Blocking on one specific pending ask (events:await its answeredEvent — do not poll this list).',
    chaining:
      'pot:ask / pot:request_work create rows here; pot:asks { pot, state: "answered" } reviews the replies.',
    seeAlso: [
      'pot:ask (post a new cross-Pot question)',
      'pot:request_work (the other row-creator — request work from a peer)',
    ],
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    pot: z.string().min(1).max(120).describe("THIS Pot's home slug — the ledger is Pot-scoped."),
    state: z
      .enum(['queued', 'sent', 'answered', 'declined', 'expired'])
      .optional()
      .describe('Filter to one ask state.'),
    direction: z.enum(['out', 'in']).optional().describe("Filter by direction (default: both). 'out' = asks this Pot initiated."),
    peerPotPubkey: z.string().max(400).optional().describe('Filter to one peer Pot.'),
    kind: z.enum(['ask', 'work-request']).optional().describe('Filter to asks or work-requests.'),
    limit: z.number().int().positive().max(500).optional().describe('Cap the rows returned (most-recent-first).'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args) {
    const ws = args.workspace ?? activeWorkspaceId();
    const filter: ListCrossHiveAsksFilter = {
      ...(args.state ? { state: args.state } : {}),
      ...(args.direction ? { direction: args.direction } : {}),
      ...(args.peerPotPubkey ? { peerPubkey: args.peerPotPubkey } : {}),
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
    };
    const asks = await productionCrossPotAsksStore().list(ws, args.pot, filter);
    return json({ ok: true, pot: args.pot, count: asks.length, asks });
  },
});
