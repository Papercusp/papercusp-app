/**
 * cupboard:support-request — "why can't this user install?", answered per
 * entitlement (shared-pot-dao-cupboard-v1-2026-09-04 D-045 §3d).
 *
 * The subject need not be the actor — an org admin diagnosing a colleague is
 * the whole point of the surface — but the ACTOR must still belong to the org,
 * which is why both ids are taken.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'cupboard:support-request',
  capability: 'harness:read',
  description:
    "Diagnose why a user cannot install, update or repair something their organization bought: returns, per entitlement, the seat usage, that user's installation, and the specific blocker (no entitlement, not a member, entitlement revoked, installation released, or no seats available). Refusals are ordered like seat allocation, so an unentitled user is never told to buy more seats.",
  guidance: {
    when: 'A user reports they cannot install/update/repair a purchased unit and you need the specific reason.',
    notWhen:
      'Requesting money back (cupboard:refund-request). Reading org-wide purchase totals (cupboard:commerce-dashboards).',
    chaining:
      'Read findings[].blocked.code — "no-seats-available" means buy or release a seat; "entitlement-revoked" usually means a refund; "not-entitled" means the user is not in the buying org.',
    seeAlso: ['cupboard:commerce-dashboards', 'cupboard:refund-request'],
  },
  args: z.object({
    buyerOrgId: z.string().max(200).describe('The organization that bought the unit.'),
    actingUserId: z.string().max(200).describe('The user asking; must be a member of buyerOrgId.'),
    subjectUserId: z
      .string()
      .max(200)
      .optional()
      .describe('The user being diagnosed; defaults to actingUserId.'),
    intent: z
      .enum(['install', 'update', 'repair'])
      .describe('What the subject user is trying to do.'),
  }),
  async handler(args) {
    const { supportRequestDoor } = await import('../../cupboard/commerce-door-gate-io');
    const decision = await supportRequestDoor({
      buyerOrgId: args.buyerOrgId,
      actingUserId: args.actingUserId,
      ...(args.subjectUserId !== undefined ? { subjectUserId: args.subjectUserId } : {}),
      intent: args.intent,
    });

    if (!decision.ok) {
      return text({
        ok: false,
        error: decision.code,
        detail: decision.detail,
        refusedBy: 'commerce-door-gate',
      });
    }

    const d = decision.dashboard;
    return text({
      ok: true,
      userId: d.userId,
      buyerId: d.buyerId,
      intent: d.intent,
      orgRole: d.orgRole,
      entitled: d.entitled,
      anyPermitted: d.anyPermitted,
      findings: d.findings,
      ...(d.findings.length === 0
        ? { note: 'This organization holds no entitlements for the subject user to install against.' }
        : {}),
    });
  },
});
