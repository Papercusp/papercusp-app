/**
 * work_items:withdraw_release_request — the requester-side cancellation for a
 * pending work_items:request_release. Resolves the request before its deadline
 * without firing the announced consequence, so a stale or no-longer-needed
 * request does not have to be cleaned up by the current holder.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { sendMessage } from '../coordination/messages';
import { commentWorkItem } from '../../work-items';
import { lookupWorkItem } from './_lookup';
import { readWorkItemReleaseRequest, resolveWorkItemReleaseRequest } from '../../work-items-release-request';

function json(obj: unknown) {
  return { data: obj };
}

export default defineTool({
  name: 'work_items:withdraw_release_request',
  profile: 'engineer',
  description:
    'Withdraw a pending work_items:request_release filed by you — resolves it immediately, before its deadline, ' +
    'with NO consequence firing. The item stays with its current holder. Refuses with no_pending_request when ' +
    'there is nothing to withdraw, or not_requester when another agent filed the request.',
  guidance: {
    when:
      'You filed a release request that is stale, no longer needed, or was based on a holder snapshot that changed — ' +
      'withdraw it instead of asking the current holder to decline it.',
    notWhen:
      'You are the holder pushing back on someone else\'s request — use work_items:decline_release_request; or you ' +
      'agree the item should go — use work_items:release.',
    chaining:
      'work_items:request_release → work_items:withdraw_release_request (requester cancels) → the item remains with ' +
      'its current holder and no consequence fires.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe('the work-item with your pending release request'),
    harness: z.string().max(80).optional().describe('harness the item lives under (else resolved from the item)'),
    reason: z.string().max(500).optional().describe('why you are withdrawing — recorded on the item and sent to the holder'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const c = ctx as { harnessSlug?: string | null };
    const hint = args.harness ?? c.harnessSlug ?? undefined;
    const hintHarness = hint && hint !== '*' ? hint : undefined;

    const lookup = await lookupWorkItem(args.id, hintHarness);
    if (lookup.status === 'unreadable') {
      return json({
        ok: false,
        id: args.id,
        error: `work_item_unreadable — could not read '${args.id}' (${lookup.error}). This is a READ FAILURE, not a missing item: retry.`,
      });
    }
    if (lookup.status === 'missing') return json({ ok: false, id: args.id, error: `work_item '${args.id}' not found` });
    const item = lookup.item;
    const req = readWorkItemReleaseRequest(item.payload);
    if (!req || req.resolved) {
      return json({ ok: false, id: args.id, error: 'no_pending_request', hint: `${args.id} has no pending release request to withdraw.` });
    }
    if (req.by !== ident.ownerId) {
      return json({
        ok: false,
        id: args.id,
        error: 'not_requester',
        requestedBy: req.by,
        holder: req.holder,
        hint: `The pending release request on ${args.id} was filed by ${req.by}, not you (${ident.ownerId}).`,
      });
    }

    const harness = item.harness ?? hintHarness;
    const resolved = await resolveWorkItemReleaseRequest(args.id, {
      harness,
      resolution: 'requester-withdrawn',
      expectedBy: ident.ownerId,
      expectedHolder: req.holder,
    });
    if (!resolved) {
      return json({ ok: false, id: args.id, error: 'already_resolved', hint: 'The request changed or was resolved by something else first — re-check work_items:get.' });
    }

    const reasonLine = args.reason?.trim() ? `: ${args.reason.trim()}` : '';
    await commentWorkItem(
      args.id,
      `↩️ ${ident.ownerId} WITHDREW the release request against ${resolved.holder}${reasonLine} — item stays with the holder, no consequence fires.`,
      ident.ownerId,
      { harness },
    ).catch(() => {});

    await sendMessage(ident, {
      to: [resolved.holder],
      summary: `↩️ ${ident.ownerId} withdrew the release request on ${args.id}${reasonLine} — the item stays with you and no consequence fires.`,
      harnessSlug: harness ?? undefined,
      extra: { auto: true, lifecycle: 'release_request_resolved', work_item: args.id, resolution: 'requester-withdrawn' },
    }).catch(() => {});

    return json({
      ok: true,
      id: args.id,
      resolution: 'requester-withdrawn',
      holder: resolved.holder,
      reason: args.reason ?? null,
    });
  },
});
