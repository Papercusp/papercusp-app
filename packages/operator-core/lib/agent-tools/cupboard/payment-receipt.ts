/**
 * cupboard:payment-receipt — per-payment receipts (agent-economy-flywheel-2026-08-30
 * P-046, D-029). Read-only: `issue` returns the receipt for one Stripe balance
 * transaction, `customer` lists every receipt for one Stripe customer, `verify`
 * checks a receipt against public chain data (the same check the open-source
 * scripts/verify-payment-receipt.mts runs).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const text = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:payment-receipt',
  capability: 'harness:read',
  description:
    'Per-payment receipts: a salted commitment to one Stripe balance transaction, proven by the hourly anchor. `issue` (balanceTransactionId), `customer` (stripeCustomerId), `verify` (receipt) against public chain data.',
  guidance: {
    when: 'A customer needs proof that one payment is in the anchored ledger, or you must check such a receipt.',
    notWhen: 'Proving a non-payment chain link (cupboard:ledger-anchor prove).',
    chaining: '`issue` returns `not-yet-anchored` until the next hourly pass covers the receipt link.',
    seeAlso: ['cupboard:ledger-anchor'],
  },
  args: z.object({
    op: z.enum(['issue', 'customer', 'verify']),
    balanceTransactionId: z.string().min(1).max(255).optional().describe('issue: the Stripe balance transaction id (txn_…).'),
    stripeCustomerId: z.string().min(1).max(255).optional().describe('customer: the Stripe customer id (cus_…).'),
    receipt: z.record(z.string(), z.unknown()).optional().describe('verify: a receipt exactly as `issue` returned it.'),
    expectedAttester: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional()
      .describe('verify: pin the published anchor address (defaults to the configured key).'),
  }),
  async handler(args, ctx) {
    const [{ activeWorkspaceId }, receipts] = await Promise.all([
      import('../../workspace-registry'),
      import('../../cupboard/payment-receipt-store'),
    ]);
    const workspaceId = ctx?.principal?.workspaceId ?? activeWorkspaceId();

    if (args.op === 'issue') {
      if (!args.balanceTransactionId) return text({ ok: false, error: 'issue needs balanceTransactionId' });
      const result = await receipts.issuePaymentReceipt(workspaceId, args.balanceTransactionId);
      return text({ ...result });
    }

    if (args.op === 'customer') {
      if (!args.stripeCustomerId) return text({ ok: false, error: 'customer needs stripeCustomerId' });
      const entries = await receipts.customerPaymentReceipts(workspaceId, args.stripeCustomerId);
      return text({ ok: true, count: entries.length, receipts: entries });
    }

    if (!args.receipt) return text({ ok: false, error: 'verify needs receipt' });
    const [receiptMod, eas] = await Promise.all([
      import('../../cupboard/payment-receipt'),
      import('../../cupboard/ledger-anchor-eas'),
    ]);
    const receipt = args.receipt as unknown as import('../../cupboard/payment-receipt').PaymentReceipt;
    const chainId = receipt.bundle?.anchor?.chainId ?? null;
    const spec = chainId === null ? undefined : eas.ANCHOR_CHAINS[chainId];
    if (receipt.bundle?.anchor?.backend !== 'eas' || !spec) {
      return text({ ok: false, reason: 'malformed', error: `cannot read anchors for chain ${String(chainId)}` });
    }
    const resolved = eas.resolveAnchorBackend();
    const { http } = await import('viem');
    const rpcUrl = chainId === resolved.config.chainId ? resolved.config.rpcUrl : spec.chain.rpcUrls.default.http[0]!;
    const reader = eas.easAnchorReader({ chain: spec.chain, transport: http(rpcUrl) });
    const expectedAttester = args.expectedAttester ?? (resolved.ok ? resolved.backend.attester : undefined);
    const verdict = await receiptMod.verifyPaymentReceipt(receipt, reader, expectedAttester ? { expectedAttester } : {});
    return text({ ...verdict, rpcUrl, ...(expectedAttester ? { expectedAttester: expectedAttester.toLowerCase() } : {}) });
  },
});
