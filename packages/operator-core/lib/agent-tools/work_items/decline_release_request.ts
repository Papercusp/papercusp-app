/**
 * work_items:decline_release_request — the holder's explicit push-back on a pending
 * work_items:request_release (WI-5974). Resolves the request IMMEDIATELY (before its
 * deadline) with NO consequence firing — the humane path requires the holder get a
 * genuine chance to respond, and an explicit decline IS a response. The requester is
 * notified; deciding what to do next (accept it, escalate manually, coordinate further)
 * is on them — this tool does not auto-escalate.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { sendMessage } from '../coordination/messages';
import { commentWorkItem } from '../../work-items';
import { lookupWorkItem } from './_lookup';
import { readWorkItemReleaseRequest, resolveWorkItemReleaseRequest } from '../../work-items-release-request';
import { holderContextReader, resolveHolderAdvisory } from '../coordination/holder-advisory';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'work_items:decline_release_request',
  profile: 'engineer',
  description:
    'Decline a pending work_items:request_release filed against a work-item you hold — resolves it immediately, ' +
    'before its deadline, with NO consequence firing (the item stays yours). Notifies the requester + records a ' +
    'comment on the item. { id, reason? }. Refuses with no_pending_request if there is nothing to decline, or ' +
    'not_holder if you are not the item\'s current holder.',
  guidance: {
    when: 'You hold a work-item and received a work_items:request_release you are pushing back on — you are still ' +
      'genuinely progressing it and want the requester to know before their deadline fires a consequence.',
    notWhen: 'You agree the item should go — just work_items:release it (a voluntary release auto-resolves any ' +
      'pending request against you as "holder-released", no separate call needed).',
    chaining: 'work_items:request_release (peer) → work_items:decline_release_request (you) → the requester ' +
      'coordinates further or accepts your decline.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe('the work-item id you hold, with a pending release request against it'),
    harness: z.string().max(80).optional().describe('harness the item lives under (else resolved from the item)'),
    reason: z.string().max(500).optional().describe('why you are declining — sent to the requester and recorded on the item'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const c = ctx as { harnessSlug?: string | null };
    const hint = args.harness ?? c.harnessSlug ?? undefined;
    const hintHarness = hint && hint !== '*' ? hint : undefined;

    // WI-6746: absence and unreachability are different answers — see _lookup.ts.
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

    const holder = item.assignee?.trim();
    if (holder !== ident.ownerId) {
      return json({
        ok: false,
        id: args.id,
        error: 'not_holder',
        holder: holder ?? null,
        hint: `You do not hold ${args.id} (held by ${holder ?? 'nobody'}) — only the current holder can decline a release request.`,
      });
    }

    const req = readWorkItemReleaseRequest(item.payload);
    if (!req || req.resolved) {
      return json({ ok: false, id: args.id, error: 'no_pending_request', hint: `${args.id} has no pending release request to decline.` });
    }

    const harness = item.harness ?? hintHarness;
    const resolved = await resolveWorkItemReleaseRequest(args.id, { harness, resolution: 'holder-declined' });
    if (!resolved) {
      return json({ ok: false, id: args.id, error: 'already_resolved', hint: 'The request was resolved by something else first (a race) — re-check work_items:get.' });
    }

    const reasonLine = args.reason?.trim() ? `: ${args.reason.trim()}` : '';
    await commentWorkItem(
      args.id,
      `🙅 ${ident.ownerId} DECLINED the release request from ${resolved.by}${reasonLine} — item stays with ${ident.ownerId}, no consequence fires.`,
      ident.ownerId,
      { harness },
    ).catch(() => {});

    await sendMessage(ident, {
      to: [resolved.by],
      summary: `🙅 ${ident.ownerId} declined your release request on ${args.id}${reasonLine} — the item stays with them.`,
      harnessSlug: harness ?? undefined,
      extra: { auto: true, lifecycle: 'release_request_resolved', work_item: args.id, resolution: 'holder-declined' },
    }).catch(() => {});

    /**
     * P-027 / D-055 A3 — THE ROLES INVERT HERE, AND THAT IS WHY THIS DISCLOSES THE
     * REQUESTER RATHER THAN THE HOLDER.
     *
     * P-027's text asks for "the holder's goal … in the request path AND in the
     * decline". In the request path the reader is the REQUESTER, so the holder's
     * goal is exactly right. At the decline the caller IS the holder (enforced by
     * the `not_holder` guard above), so injecting the holder's context here would
     * show an agent its OWN goal — the precise case D-055 refuses by name for
     * `work_items:checkpoint` ("re-injected to the item's OWN holder"). Doing it
     * anyway would satisfy the sentence and violate the ruling behind it.
     *
     * The genuinely-blocked reader at this moment is the holder deciding how firm
     * to be, and the party they are contending with is the REQUESTER — whose goal
     * predicts whether this push-back settles it or escalates. So the same
     * projection is rendered against the other participant.
     *
     * ⚠ The requester's own notification is deliberately NOT enriched: it is
     * delivered to a DIFFERENT reader, and holder context is reader-relative by
     * construction. Fabricating a CellReader for the recipient would default the
     * audience — and a defaulted access check fails OPEN, which is the one thing
     * `resolveHolderContext` refuses to do.
     */
    const requesterContext = await resolveHolderAdvisory({
      holder: resolved.by,
      reader: holderContextReader(ctx as Parameters<typeof holderContextReader>[0]),
      // D-094: never report the requester as "also competing on" this very item.
      subjectRef: args.id,
    });
    return json({
      ok: true,
      id: args.id,
      resolution: 'holder-declined',
      requestedBy: resolved.by,
      ...(requesterContext ? { requesterContext } : {}),
      reason: args.reason ?? null,
    });
  },
});
