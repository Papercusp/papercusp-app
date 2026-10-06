/**
 * cupboard:bind-identity-funding — choose which hosted payment channel pays for a
 * Cupboard identity release in this workspace (agent-economy-flywheel-2026-08-30
 * P-016, decision D-011).
 *
 * The explicit bind door. The per-use checkout preflight binds its own channel;
 * this door binds a channel opened some other way. It first reads the channel
 * back from the hosted owner-only route, so a channel this principal does not own
 * (or that does not exist) is refused and never stored. The binding is routing
 * only: the activation gate re-reads the channel's state and escrow on every
 * activation, so a stored binding is never evidence of funds.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'cupboard:bind-identity-funding',
  capability: 'harness:write',
  description:
    'Bind a hosted payment channel as the funding for one Cupboard identity release in this workspace. Reads the channel back from the hosted owner-only route first and refuses one that is unknown or not yours. The activation gate still re-reads funds on every activation.',
  guidance: {
    when: 'A priced identity is refused with identity-activation-unfunded and the buyer already has an open payment channel for it.',
    notWhen: 'Buying the identity (cupboard:checkout already binds its per-use channel). Prepaid credits need no binding.',
  },
  args: z.object({
    identityId: z.string().min(1).max(200).describe('Installed identity id, as in the refusal.'),
    version: z.string().min(1).max(100).describe('Installed identity release version.'),
    channelId: z.string().min(1).max(200).describe('Hosted payment channel id to bind.'),
  }),
  async handler(args, ctx) {
    const [{ identityReleaseSkuRef }, io, store, { activeWorkspaceId }, { getOrgPg }] = await Promise.all([
      import('../../cupboard/identity-per-use-offer'),
      import('../../cupboard/identity-activation-gate-io'),
      import('../../cupboard/identity-release-funding-store'),
      import('../../workspace-registry'),
      import('@papercusp/db-org'),
    ]);
    const skuRef = identityReleaseSkuRef({ id: args.identityId, version: args.version });
    const channel = await io.readHostedPaymentChannel(args.channelId);
    if (!channel.ok) {
      return text({ ok: false, error: 'channel-unverifiable', detail: channel.detail, skuRef });
    }
    if (!channel.value) {
      return text({
        ok: false,
        error: 'channel-not-found',
        detail: `the Cupboard has no payment channel ${args.channelId} owned by this principal`,
        skuRef,
      });
    }
    const workspaceId = ctx?.principal?.workspaceId ?? activeWorkspaceId();
    await store.bindIdentityReleaseFundingChannel(getOrgPg().sql as never, {
      workspaceId,
      skuRef,
      channelId: channel.value.channelId,
      source: 'explicit',
      boundBy: ctx?.principal?.slug ?? 'cupboard:bind-identity-funding',
    });
    return text({ ok: true, workspaceId, skuRef, channel: channel.value });
  },
});
