/**
 * work_items:request_release — WI-5974: make "announced consequence" a RAIL instead
 * of a temperament, so reclaiming a stale-looking claim can never be done by surprise.
 *
 * ORIGIN: owner question 2026-07-26 06:26Z, "how would you improve our system so this
 * issue doesn't reoccur", after a leader moved to reassign a work-item from a holder
 * reading as an orphan and the claim rail correctly refused with `claim_conflict`. The
 * rail was RIGHT to refuse, but it refused and then STOPPED — no sanctioned path
 * forward, so the leader had to hand-roll the protocol out of judgment (ping the
 * holder, state a deadline, say what happens on silence, follow through). This tool
 * ENCODES that protocol: message the holder with the reason + an explicit deadline +
 * an explicit consequence, record the request DURABLY on the item (visible to every
 * peer, not just a DM), and — on silence past the deadline — the `release-request-sweep`
 * periodic check (in-process-periodic.ts) executes the ANNOUNCED consequence.
 *
 * Two ways the request resolves EARLY (before the deadline, no consequence fires):
 *   - the holder releases voluntarily (work_items:release wires this in — see release.ts)
 *   - the holder explicitly declines (work_items:decline_release_request)
 * Both make the humane path the DEFAULT path: the consequence is announced before it
 * happens, in a durable place, so no peer is ever surprised by losing work.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { sendMessage } from '../coordination/messages';
import { commentWorkItem } from '../../work-items';
import { lookupWorkItem } from './_lookup';
import { setWorkItemReleaseRequest, readWorkItemReleaseRequest, type ReleaseRequestOnSilence } from '../../work-items-release-request';
import { holderContextReader, resolveHolderAdvisory } from '../coordination/holder-advisory';

const ON_SILENCE_VALUES = ['reclaim', 'escalate', 'nothing'] as const;

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'work_items:request_release',
  profile: 'engineer',
  description:
    'Ask another agent to release a work-item they hold, with an explicit deadline + announced consequence — the ' +
    'sanctioned path when work_items:release{force:true} refuses (not_holder/force_unauthorized) on a LIVE peer\'s ' +
    'claim. onSilence: "reclaim" (the sweep force-frees at the deadline), "escalate" (pages the owner, item stays ' +
    'held), or "nothing". Messages the holder AND posts a durable comment on the item, so request+deadline+' +
    'consequence join its history. Resolves EARLY, with no consequence, if the holder releases or declines first.',
  guidance: {
    when:
      'A work-item reads as held by an orphan / stalled peer but work_items:release{force:true} refused (not_holder or ' +
      'force_unauthorized) — you have no authority to force-reclaim a LIVE holder\'s claim. This is the sanctioned ' +
      'next step instead of hand-rolling a ping-then-reclaim protocol.',
    notWhen:
      'The holder is already dead/stale by presence, or you lead their fleet / hold queen authority — ' +
      'work_items:release{force:true} already succeeds in those cases, so don\'t wait out a deadline. A live peer ' +
      'genuinely progressing the item → coordinate directly (coord:send), not a reclaim request against active work.',
    chaining:
      'work_items:release{force:true} refused → work_items:request_release → (holder releases/declines early, or the ' +
      'release-request-sweep fires the announced consequence at the deadline) → work_items:claim.',
    seeAlso: [
      'work_items:decline_release_request (the holder\'s explicit push-back)',
      'work_items:release (a voluntary release auto-resolves any pending request against you)',
      'work_items:hold_open (a DIFFERENT gate — you keep working an item so nobody closes/self-selects it)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe('the work-item id currently held by someone else'),
    harness: z.string().max(80).optional().describe('harness the item lives under (else resolved from the item)'),
    deadlineSec: z
      .number()
      .int()
      .min(30)
      .max(604_800)
      .describe('how long the holder has to respond before the announced consequence fires (30s–7d)'),
    onSilence: z
      .enum(ON_SILENCE_VALUES)
      .describe(
        '"reclaim" = force-release the item if the deadline passes unanswered; "escalate" = page the owner, item stays held; "nothing" = record the silence only, item stays held',
      ),
    reason: z.string().min(1).max(500).describe('why you are requesting release — sent to the holder and recorded on the item'),
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
    if (!holder) {
      return json({
        ok: false,
        id: args.id,
        error: 'not_held',
        hint: `${args.id} is unclaimed — nothing to request release of. Claim it directly (work_items:claim).`,
      });
    }
    if (holder === ident.ownerId) {
      return json({
        ok: false,
        id: args.id,
        error: 'self_held',
        hint: `You already hold ${args.id} — release it yourself (work_items:release), no request needed.`,
      });
    }

    // P-027 / D-055 A3 — resolved ONCE for every path below that names the holder.
    // Guarded + total: an unattributable caller or a dead store costs the advisory
    // and nothing else, and NOTHING here can change whether the request is filed.
    const reader = holderContextReader(ctx as Parameters<typeof holderContextReader>[0]);
    const holderContext = await resolveHolderAdvisory({
      holder,
      reader,
      // D-094: never report the holder as "also competing on" the very item this
      // request is about.
      subjectRef: args.id,
    });

    const existing = readWorkItemReleaseRequest(item.payload);
    if (existing && !existing.resolved && existing.by !== ident.ownerId) {
      // The blocking party here is the PRIOR REQUESTER, not the holder — you are
      // being told to coordinate with `existing.by`, so it is THEIR goal that
      // predicts whether they will stand down. Both are disclosed because they
      // answer different questions: `holderContext` = will the item free up at
      // all, `existingRequesterContext` = should I wait behind this request.
      const existingRequesterContext = await resolveHolderAdvisory({
        holder: existing.by,
        reader,
        subjectRef: args.id,
      });
      return json({
        ok: false,
        id: args.id,
        error: 'request_already_pending',
        existing: { by: existing.by, deadlineAt: existing.deadlineAt, onSilence: existing.onSilence, reason: existing.reason },
        ...(holderContext ? { holderContext } : {}),
        ...(existingRequesterContext ? { existingRequesterContext } : {}),
        hint: `${existing.by} already has a pending release request on ${args.id} (deadline ${new Date(existing.deadlineAt).toISOString()}) — wait for it to resolve, or coordinate with ${existing.by} instead of filing a second one.`,
      });
    }

    const deadlineAt = Date.now() + args.deadlineSec * 1000;
    const harness = item.harness ?? hintHarness;
    const rec = await setWorkItemReleaseRequest(args.id, {
      harness,
      by: ident.ownerId,
      holder,
      // The request was based on this exact holder read. The storage write repeats
      // the check atomically so a claim transfer cannot retarget the request.
      expectedHolder: holder,
      reason: args.reason,
      onSilence: args.onSilence,
      deadlineAt,
    });
    if (!rec) return json({ ok: false, id: args.id, error: 'request_failed' });

    const deadlineIso = new Date(deadlineAt).toISOString();
    const consequenceLine =
      args.onSilence === 'reclaim'
        ? `if unanswered by then, ${args.id} will be RECLAIMED (force-released) automatically`
        : args.onSilence === 'escalate'
          ? `if unanswered by then, this will be ESCALATED to the owner — the item stays with you`
          : `if unanswered by then, the silence will be recorded — the item stays with you, no further action`;

    await commentWorkItem(
      args.id,
      `🕐 RELEASE REQUEST by ${ident.ownerId} → ${holder}: ${args.reason}\n` +
        `Deadline: ${deadlineIso} (${args.deadlineSec}s from now). ${consequenceLine}. ` +
        `Respond by releasing (work_items:release) or declining (work_items:decline_release_request) before the deadline.`,
      ident.ownerId,
      { harness, writerOwnerId: ident.ownerId },
    ).catch(() => {});

    await sendMessage(ident, {
      to: [holder],
      summary: `🕐 ${ident.ownerId} requests you release ${args.id}: ${args.reason} — respond by ${deadlineIso} or ${consequenceLine.replace(/^if unanswered by then, /, '')}.`,
      harnessSlug: harness ?? undefined,
      expectsReply: true,
      extra: { auto: true, lifecycle: 'release_request', work_item: args.id, deadlineAt, onSilence: args.onSilence },
    }).catch(() => {});

    return json({
      ok: true,
      id: args.id,
      holder,
      // P-027 / D-055 A3 — THE question this tool exists to answer is "will they
      // actually give it up?", and the holder's declared goal is the single best
      // predictor available. Disclosed at the moment the request is filed, so the
      // requester can judge the deadline/consequence they just committed to
      // rather than discovering the holder's lane only when they push back.
      ...(holderContext ? { holderContext } : {}),
      requestedBy: ident.ownerId,
      deadlineAt,
      deadlineIso,
      onSilence: args.onSilence,
      reason: args.reason,
    });
  },
});
