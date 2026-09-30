/**
 * pot:cross_grant — owner management of cross-Pot capability grants
 * (cross-hive-boundary-2026-06-08 P-002; hive-network-surface-2026-06-11 P-004 B-05).
 * Grant / revoke / list which peer-Pot pubkeys may exchange which kinds
 * (ask | work-request) with this Pot, DIRECTED:
 *
 *   direction:'in'  — peers sending INTO this Pot (admission; admitCrossPotEnvelope).
 *   direction:'out' — this Pot sending TO a peer (egress; admitOutboundCrossPot). The
 *                     Mug cannot ask / request work from a peer until the owner grants
 *                     it `out`.
 *
 * Default-deny in BOTH directions. Grants live in hive_settings, so they federate to every
 * Swarm of this Pot (uniform policy).
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  loadDirectedCrossHiveGrants as loadDirectedCrossPotGrants,
  setCrossHiveGrant as setCrossPotGrant,
  revokeCrossHiveGrant as revokeCrossPotGrant,
} from '../../cross-hive-grants';

const json = (o: unknown) => ({ data: o });

export default defineTool({
  name: 'pot:cross_grant',
  profile: 'engineer',
  description:
    "Owner-managed cross-Pot grants: grant/revoke/list which peer-Pot pubkeys may exchange which kinds (ask | work-request) with this Pot. DIRECTED: 'in' admits a peer's traffic INTO this Pot; 'out' lets THIS Pot send to a peer (required before this Pot can ask another). Default-deny both ways; grants are quota-capped (maxPerHour/maxBodyBytes, defaults 60/hr + 64KiB), optionally expiring (expiresInHours), and federate to all of this Pot's Swarms.",
  guidance: {
    when: "Setting this Pot's cross-Pot policy — grant 'in' (admission) or 'out' (egress; owner-gated before this Pot's first pot:ask to a new peer), list, or revoke. maxPerHour/maxBodyBytes/expiresInHours tune quota/expiry.",
    notWhen:
      'Within-Pot coordination (coord:*/topics) or Swarm work placement (work_items:co_locate) — this is only the sovereignty boundary between Pots.',
    chaining:
      'discovery:pots (peer pubkey) → pot:cross_grant {action:"grant", direction, peerPotPubkey, kinds}; "out" before pot:ask / pot:request_work.',
    seeAlso: [
      'discovery:pots (find the peer Pot pubkey to grant to)',
      'pot:ask (use an "out" grant to ask a peer)',
      'pot:request_work (use an "out" grant to request work)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    pot: entityRef('pot', { soft: true, max: 120, describe: "This Pot's home slug (grants are Pot-scoped + federate to its Swarms)." }),
    action: z.enum(['grant', 'revoke', 'list']),
    direction: z
      .enum(['in', 'out'])
      .optional()
      .describe("Grant direction: 'in' (peers→this Pot, admission) or 'out' (this Pot→peers, egress). Default 'in'."),
    peerPotPubkey: z.string().max(400).optional().describe('The peer Pot\'s pubkey (required for grant/revoke).'),
    kinds: z
      .array(z.enum(['ask', 'work-request']))
      .optional()
      .describe('Kinds to grant (grant action; default ["ask"]). An empty array clears the grant.'),
    maxPerHour: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('P-013 quota: max requests per rolling hour with this peer (default 60). Omitted on a re-grant = keep the existing value.'),
    maxBodyBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('P-013 quota: max request body size in bytes (default 65536). Omitted on a re-grant = keep the existing value.'),
    expiresInHours: z
      .number()
      .positive()
      .optional()
      .describe('P-013 expiry: void the grant after this many hours. Omitted on a re-grant = keep the existing expiry; revoke + re-grant to clear one.'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args) {
    const ws = args.workspace ?? activeWorkspaceId();
    const direction = args.direction ?? 'in';
    if (args.action === 'list') {
      return json({ ok: true, action: 'list', pot: args.pot, grants: await loadDirectedCrossPotGrants(ws, args.pot) });
    }
    if (!args.peerPotPubkey) {
      return json({ ok: false, error: 'peerPotPubkey is required for grant/revoke' });
    }
    if (args.action === 'grant') {
      await setCrossPotGrant(ws, args.pot, args.peerPotPubkey, args.kinds ?? ['ask'], direction, undefined, {
        ...(args.maxPerHour != null ? { maxPerHour: args.maxPerHour } : {}),
        ...(args.maxBodyBytes != null ? { maxBodyBytes: args.maxBodyBytes } : {}),
        ...(args.expiresInHours != null ? { expiresAt: Date.now() + args.expiresInHours * 3_600_000 } : {}),
      });
    } else {
      await revokeCrossPotGrant(ws, args.pot, args.peerPotPubkey, direction);
    }
    return json({
      ok: true,
      action: args.action,
      direction,
      pot: args.pot,
      grants: await loadDirectedCrossPotGrants(ws, args.pot),
    });
  },
});
