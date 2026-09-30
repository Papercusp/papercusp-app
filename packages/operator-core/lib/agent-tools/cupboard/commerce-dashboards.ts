/**
 * cupboard:commerce-dashboards — the P-011 read projections for one buying
 * organization (shared-pot-dao-cupboard-v1-2026-09-04 D-045 §3d).
 *
 * PURELY A READ. Every projection behind it is a fold over the commerce
 * snapshot and writes nothing; the gate adds authorization and never filters
 * the rows, because a dashboard that quietly hides rows is worse than one that
 * refuses outright.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'cupboard:commerce-dashboards',
  capability: 'harness:read',
  description:
    "Read a buying organization's Cupboard commerce state: `catalog` (offers, exact pricing and per-use microcharge terms), `checkout` (what it bought, each purchase's entitlement and seat usage, gross/refunded/net), `refunds` (per-order settled, in-flight and safely-refundable amounts plus what keeps running after revocation), and `audit` (a deterministic export of products, offers, orders, entitlements, refunds, payouts and installations with a rejection tally), and `per-use` (settled, claimed and reversed microcharge revenue per channel, in MICROS — a per-use unit is often worth under a cent, so these never convert to the ledger's minor units). Read-only. Revoked entitlements are reported, never hidden.",
  guidance: {
    when: 'You need what an organization bought, what is refundable, or a reproducible audit/export of its commerce state.',
    notWhen:
      "Starting a purchase (cupboard:checkout). Requesting a refund (cupboard:refund-request). Diagnosing one user's install block (cupboard:support-request).",
    chaining:
      'Ask for only the dashboards you need. `audit.integrity.rejections` names events the ledger refused — a non-empty list is a data problem, not a display one.',
    seeAlso: ['cupboard:checkout', 'cupboard:refund-request', 'cupboard:support-request'],
  },
  args: z.object({
    buyerOrgId: z.string().max(200).describe('The organization whose commerce state to read.'),
    actingUserId: z.string().max(200).describe('The user reading; must be a member of buyerOrgId.'),
    dashboards: z
      .array(z.enum(['catalog', 'checkout', 'refunds', 'audit', 'per-use']))
      .optional()
      .describe('Which projections to return; omit for all three.'),
    currency: z.string().max(3).optional().describe('Denomination for checkout totals (default USD).'),
  }),
  async handler(args) {
    const { commerceDashboardsDoor } = await import('../../cupboard/commerce-door-gate-io');
    const decision = await commerceDashboardsDoor({
      buyerOrgId: args.buyerOrgId,
      actingUserId: args.actingUserId,
      ...(args.dashboards !== undefined ? { dashboards: args.dashboards } : {}),
      ...(args.currency !== undefined ? { currency: args.currency } : {}),
    });

    if (!decision.ok) {
      return text({
        ok: false,
        error: decision.code,
        detail: decision.detail,
        refusedBy: 'commerce-door-gate',
      });
    }

    return text({ ok: true, ...decision.result });
  },
});
