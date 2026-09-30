/**
 * events:cancel — retract one of YOUR active awaits, or ACK one of your
 * pending/parked wake deliveries (await-event-primitive-2026-06-05 P-003,
 * D-007).
 *
 * Subscriber-scoped both ways: you can only cancel/ack your own (a peer's
 * await is their wait, not yours to kill).
 *
 * The ack half exists because the parked path delivers the wake reason via
 * your coord inbox while you are still awake — if you act on it in-turn, ack
 * the delivery so the pump does not also resume you later (a wake = a turn;
 * an acked wake never burns one).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { ackDelivery, cancelAwaitDetailed, retireAnnouncement } from '../../events/await/store';
import { cancelComposedTree } from '../../events/await/compose-store';
import { bulkContent, runBulk } from '../_bulk';

const cancelItemSchema = z
  .object({
    await_id: z.number().int().positive().optional().describe('The id events:await returned — retract the subscription.'),
    confirm_standing: z
      .boolean()
      .optional()
      .describe('Required when canceling a standing once:false watch; inspect events:status first because queued deliveries are also dropped.'),
    delivery_id: z.number().int().positive().optional().describe('A pending/parked wake delivery id — acknowledge it as received.'),
    root_id: z.number().int().positive().optional().describe('A composed await TREE root id (from events:status) — cancel the whole tree.'),
    announcement_id: z.number().int().positive().optional().describe('An announced gate declaration id from events:status — retire the unfired declaration.'),
    expected_generation: z.number().int().nonnegative().optional().describe('The declaration generation last observed; prevents retiring a newer replacement.'),
  })
  .refine((a) => a.await_id != null || a.delivery_id != null || a.root_id != null || a.announcement_id != null, {
    message: 'pass await_id, delivery_id, root_id, or announcement_id',
  });

type CancelItem = {
  await_id?: number;
  confirm_standing?: boolean;
  delivery_id?: number;
  root_id?: number;
  announcement_id?: number;
  expected_generation?: number;
};

export default defineTool({
  name: 'events:cancel',
  description:
    'Cancel one of your active events:await registrations (await_id — you will not be woken), retire one of your unfired announced gate declarations (announcement_id, optionally guarded by expected_generation), cancel a whole composed await TREE by its root_id, or ACK a pending/parked wake delivery (delivery_id). Standing once:false watches require confirm_standing:true after checking events:status because queued deliveries are dropped with the watch. Pass at least one.',
  guidance: {
    when: 'The thing you were waiting on no longer matters (cancel the await), or a parked wake reached you in-turn via the inbox and you handled it (ack the delivery so the system does not also resume you). For a standing watch, inspect events:status and pass confirm_standing:true deliberately.',
    notWhen: 'A fired await needs no cancel (one-shot — it already cleared). Do not use await_id as a mistaken substitute for the narrow delivery_id ACK path. You cannot cancel or ack a peer’s.',
    chaining: 'events:status to find the await_id / delivery_id / declaration id → events:cancel.',
    seeAlso: [
      'events:status (find the await_id / delivery_id / declaration id to cancel)',
      'events:await (re-arm a wait after cancelling)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z
    .object({
      await_id: z.number().int().positive().optional().describe('The id events:await returned — retract the subscription.'),
      confirm_standing: z
        .boolean()
        .optional()
        .describe('Required when canceling a standing once:false watch; inspect events:status first because queued deliveries are also dropped.'),
      await_ids: z.array(z.number().int().positive()).min(1).max(200).optional().describe('await registrations to cancel'),
      delivery_id: z.number().int().positive().optional().describe('A pending/parked wake delivery id (from events:status or the inbox nudge) — acknowledge it as received.'),
      delivery_ids: z.array(z.number().int().positive()).min(1).max(200).optional().describe('parked wake deliveries to acknowledge'),
      root_id: z.number().int().positive().optional().describe('A composed await TREE root id (from events:status) — cancel the whole tree (cascades to every leaf + node).'),
      root_ids: z.array(z.number().int().positive()).min(1).max(200).optional().describe('composed await trees to cancel'),
      announcement_id: z.number().int().positive().optional().describe('An announced gate declaration id from events:status — retire the unfired declaration.'),
      announcement_ids: z.array(z.number().int().positive()).min(1).max(200).optional().describe('announced gate declaration ids to retire'),
      expected_generation: z.number().int().nonnegative().optional().describe('The declaration generation last observed; only applies to announcement_id.'),
      items: z.array(cancelItemSchema).min(1).max(200).optional().describe('mixed await/delivery/tree cancel or ack operations'),
    })
    .refine(
      (a) =>
        a.await_id != null ||
        a.delivery_id != null ||
        a.root_id != null ||
        a.announcement_id != null ||
        (a.await_ids?.length ?? 0) > 0 ||
        (a.delivery_ids?.length ?? 0) > 0 ||
        (a.root_ids?.length ?? 0) > 0 ||
        (a.announcement_ids?.length ?? 0) > 0 ||
        (a.items?.length ?? 0) > 0,
      {
        message: 'pass await_id/delivery_id/root_id/announcement_id, *_ids, or items',
      },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const items: CancelItem[] = [
      ...(args.await_id != null || args.delivery_id != null || args.root_id != null || args.announcement_id != null
        ? [{
            await_id: args.await_id,
            confirm_standing: args.confirm_standing,
            delivery_id: args.delivery_id,
            root_id: args.root_id,
            announcement_id: args.announcement_id,
            expected_generation: args.expected_generation,
          }]
        : []),
      ...(args.await_ids ?? []).map((await_id): CancelItem => ({ await_id, confirm_standing: args.confirm_standing })),
      ...(args.delivery_ids ?? []).map((delivery_id): CancelItem => ({ delivery_id })),
      ...(args.root_ids ?? []).map((root_id): CancelItem => ({ root_id })),
      ...(args.announcement_ids ?? []).map((announcement_id): CancelItem => ({ announcement_id })),
      ...(args.items ?? []),
    ];
    const env = await runBulk(
      items,
      async (item) => {
        const out: Record<string, unknown> = { ok: true };
        if (item.await_id != null) {
          const cancellation = await cancelAwaitDetailed({
            awaitId: item.await_id,
            subscriberId: identity.ownerId,
            source: 'operator',
            confirmStanding: item.confirm_standing,
          });
          out.await_id = item.await_id;
          out.cancelled = cancellation.cancelled;
          if (cancellation.eventKey != null) out.event = cancellation.eventKey;
          if (cancellation.once != null) out.once = cancellation.once;
          if (cancellation.expiresTs !== undefined) out.expires_ts = cancellation.expiresTs;
          if (cancellation.cancelled) {
            out.dropped_deliveries = cancellation.droppedDeliveries;
            out.in_flight_deliveries = cancellation.inFlightDeliveries;
            if (cancellation.inFlightDeliveries > 0) {
              out.warning =
                'The await was canceled, but one or more deliveries were already in flight and cannot be recalled.';
            }
          } else {
            out.ok = false;
            if (cancellation.error != null) out.error = cancellation.error;
          }
        }
        if (item.root_id != null) {
          const cancelled = await cancelComposedTree({
            rootId: item.root_id,
            subscriberId: identity.ownerId,
            source: 'operator',
          });
          out.root_id = item.root_id;
          out.cancelled = cancelled;
          if (!cancelled) out.ok = false;
        }
        if (item.delivery_id != null) {
          const ack = await ackDelivery({ deliveryId: item.delivery_id, subscriberId: identity.ownerId });
          out.delivery_id = item.delivery_id;
          out.acked = ack.acked;
          if (ack.alreadySettled) {
            out.already_settled = true;
            out.status = ack.status;
            // EI-21537729216542022: `delivered` means the host handoff already
            // crossed the recall boundary. The turn may still arrive after
            // this tool response, so never let a benign `ok:true` read as
            // "the wake was suppressed".
            if (ack.status === 'delivered') {
              out.recallable = false;
              out.warning =
                'This delivery was already handed to the wake host and cannot be recalled. A queued/in-flight wake may still arrive; reconcile it once as stale rather than repeating the handled action.';
            }
          }
          if (!ack.acked && !ack.alreadySettled && item.await_id == null && item.root_id == null) out.ok = false;
        }
        if (item.announcement_id != null) {
          const retired = await retireAnnouncement({
            announcementId: item.announcement_id,
            subscriberId: identity.ownerId,
            expectedGeneration: item.expected_generation,
          });
          out.announcement_id = item.announcement_id;
          out.retired = retired.retired;
          if (retired.eventKey != null) out.event = retired.eventKey;
          if (retired.generation != null) out.generation = retired.generation;
          if (retired.supersededAt != null) out.superseded_at = retired.supersededAt;
          if (!retired.retired) {
            out.ok = false;
            out.error = retired.reason ?? 'not_found_or_not_yours_or_already_settled';
          }
        }
        if (out.ok !== true && out.error == null) out.error = 'not_found_or_not_yours_or_already_settled';
      return out as {
        ok: boolean;
        await_id?: number;
        delivery_id?: number;
        root_id?: number;
        announcement_id?: number;
        error?: string;
        warning?: string;
      };
      },
      { keyOf: (item) => ({ ...(item.await_id != null ? { await_id: item.await_id } : {}), ...(item.delivery_id != null ? { delivery_id: item.delivery_id } : {}), ...(item.root_id != null ? { root_id: item.root_id } : {}), ...(item.announcement_id != null ? { announcement_id: item.announcement_id } : {}) }) },
    );
    return bulkContent(env);
  },
});
