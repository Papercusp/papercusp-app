/**
 * cupboard:ledger-chain-witness — chain a pot's governance events that have no
 * hash-chain link yet (agent-economy-flywheel-2026-08-30 P-040). Local appends
 * are witnessed automatically; this covers events that arrived from federated
 * peers and any append whose after-witness pass failed. Idempotent.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';

const text = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:ledger-chain-witness',
  capability: 'harness:write',
  description:
    "Append hash-chain links for a pot's plan-admission governance events that are not chained yet (peer-federated events, or a failed after-append pass), in fold order. Idempotent: a chained entry is never re-linked, and an edited entry stays flagged by verify rather than being re-chained.",
  guidance: {
    when: 'cupboard:ledger-chain verify reported unchainedCount > 0.',
    notWhen: 'Repairing a broken chain: a firstBreak is evidence of tampering and is not repairable by witnessing.',
    seeAlso: ['cupboard:ledger-chain'],
  },
  args: z.object({
    stream: z.enum(['plan-admission', 'money-journal']).default('plan-admission'),
    pot: entityRef('pot', { soft: true, max: 200, describe: "plan-admission: the pot's home slug." }).optional(),
  }),
  async handler(args, ctx) {
    const [{ activeWorkspaceId }, chain, { ledgerChainSource }] = await Promise.all([
      import('../../workspace-registry'),
      import('../../cupboard/ledger-chain'),
      import('./ledger-chain-source'),
    ]);
    const workspaceId = ctx?.principal?.workspaceId ?? activeWorkspaceId();
    const source = await ledgerChainSource(workspaceId, args.stream, args.pot);
    if ('error' in source) return text({ ok: false, error: source.error });
    const result = await chain.witnessLedger(workspaceId, source, chain.pgLedgerChainLinkStore());
    return text({ ok: true, ...result });
  },
});
