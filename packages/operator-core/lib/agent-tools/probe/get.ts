/**
 * probe:get — read a captured-only federation probe receipt
 * (fleet-reliability-verification-2026-07-10 P-010, WI-3812).
 *
 * A receipt proves only that probe:emit captured a correctly stamped local
 * declaration (or refused it loudly). It is deliberately not a health verdict:
 * post-capture federation stages are observed in other processes and stores.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getProbe } from '../../sync/pot-git/federation-probe-store';

export default defineTool({
  name: 'probe:get',
  description:
    'Read a probe:emit-created receipt. An `acked` receipt proves the correctly stamped declaration was captured locally; `refused` names why emit could not create one. This is NOT a federation-health verdict and does not claim drain, replication, merge, member-guard, or projection. Read substrate_outbox, substrate_merge_cursor, and fresh origin=remote rows for those stages.',
  guidance: {
    when: 'Confirming whether probe:emit captured or refused a correctly stamped local diagnostic declaration.',
    notWhen: 'You never called probe:emit for this key — there is nothing to read.',
    chaining: 'probe:emit → probe:get { probeKey }; use real outbox/merge/remote-origin evidence for federation health.',
    seeAlso: ['probe:emit'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    probeKey: z.string().min(1).max(300).describe('The probeKey returned by probe:emit.'),
  }),
  async handler(args) {
    const receipt = await getProbe(args.probeKey);
    if (!receipt) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, found: false, probeKey: args.probeKey }) }],
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            found: true,
            probeKey: receipt.probeKey,
            harnessSlug: receipt.harnessSlug,
            workspaceId: receipt.workspaceId,
            emittedAt: new Date(receipt.emittedAtMs).toISOString(),
            status: receipt.status,
            ...(receipt.refusalReason ? { refusalReason: receipt.refusalReason } : {}),
            hops: Object.fromEntries(
              Object.entries(receipt.hops).map(([hop, atMs]) => [hop, new Date(atMs).toISOString()]),
            ),
            meaning:
              receipt.status === 'acked'
                ? 'captured locally; not proof of post-capture federation health'
                : 'emit refused before local capture; see refusalReason',
          }),
        },
      ],
    };
  },
});
