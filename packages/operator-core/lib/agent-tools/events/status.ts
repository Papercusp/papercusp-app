/**
 * events:status — your active awaits + recent wake deliveries + the wake meter
 * (await-event-primitive-2026-06-05 P-003/P-005, D-007).
 *
 * The meter half is the cost-discipline window: every wake is a turn, so
 * per-agent wake counts (by status + channel, last 24h) make a wake-storm
 * visible immediately.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { hostAudienceResolvers } from '../coordination/audience-host';
import { listMyEventKeySubscriptions } from '../coordination/event-subscriptions';
import { resolveLiveRoleHolders } from '../coordination/role-slot-live-resolve';
import { resolveSessionStates, type LivenessVerdict } from '../coordination/liveness-oracle';
import {
  deliveryBacklogSummary,
  inspectEventKey,
  listActiveAwaits,
  listRecentDeliveries,
  wakeMeter,
} from '../../events/await/store';
import { wakeChannelInvokesTurn, type KeyFireRow } from '../../events/await/types';
import { listActiveComposedRoots, loadTreeLeaves } from '../../events/await/compose-store';
import {
  announcementExpectedVerdict as expectedVerdict,
  announcementGenerationState as announcementState,
  firedPayloadSha as payloadSha,
} from '../../events/await/announcement-verdict';
import type { AwaitRow } from '../../events/await/types';
import { evaluateDeclaredGateGeneration } from '../../events/await/declared-gate-recovery';
import {
  declaredGateRecoveryPayload,
  gatherDeclaredGateEvidence,
} from '../../events/await/declared-gate-recovery-runtime';
import { withBoundedTimeout } from '../../bounded-timeout';

const EVENTS_SCOPE_NOTE =
  'Workspace-global read surface: scope comes from request context and caller identity; do not pass `harness` or `workspace` as JSON arguments (those keys are rejected).';

const STATUS_WAKE_PAYLOAD_MAX_CHARS = 2_000;

function statusWakePayload(payload: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(payload) ?? 'null';
  if (serialized.length <= STATUS_WAKE_PAYLOAD_MAX_CHARS) return { payload };
  return {
    payload_preview: serialized.slice(0, STATUS_WAKE_PAYLOAD_MAX_CHARS),
    payload_chars: serialized.length,
    payload_truncated: true,
  };
}

/**
 * EI-13705: the top-level `current_state` an agent actually reads. Previously this
 * came ONLY from the announce-policy declaration history, so a key that was fired via
 * a bare `events:emit` (no `announce:true`) read as `undeclared` FOREVER — identical to
 * a key that has never fired at all — once its waiter/delivery rows aged out of view.
 * That false-negative cost a real 7-day stall (see the bug writeup). The unconditional
 * fire latch (harness_shared.event_key_fires, migration 632) now backstops this: when
 * there is no active (non-superseded) announcement but the key HAS genuinely fired,
 * report `fired_undeclared` instead of `undeclared` so a reader can never again mistake
 * "nobody bothered to check the discovery box" for "this never happened".
 */
function currentState(
  currentAnnouncement: AwaitRow | null,
  fireLatch: KeyFireRow | null,
  composedRoot?: { state: 'active' | 'fired' | 'cancelled' | 'missing' } | null,
): 'declared' | 'fired' | 'cancelled' | 'expired' | 'superseded' | 'fired_undeclared' | 'undeclared' | 'composed_active' | 'composed_fired' | 'composed_cancelled' | 'composed_missing' {
  if (currentAnnouncement) return announcementState(currentAnnouncement);
  if (composedRoot) return `composed_${composedRoot.state}`;
  if (fireLatch) return 'fired_undeclared';
  return 'undeclared';
}

export type AnnouncementOwnership = {
  declaredByLiveness: string | null;
  liveSuccessorIds: string[];
  staleOwner: boolean;
};

/**
 * Resolve announcement ownership from durable selectors rather than the mortal
 * subscriber id.  The liveness oracle is the final filter for both the durable
 * fleet leader candidate and role-slot candidates; a missing/degraded verdict
 * is deliberately not treated as live evidence.
 */
export async function resolveAnnouncementOwnership(
  announcements: AwaitRow[],
  workspaceId: string | null,
): Promise<Map<number, AnnouncementOwnership>> {
  const owners = new Set<string>();
  const bindings = new Map<string, { kind: 'fleet-leadership' | 'role'; ref: string }>();
  for (const row of announcements) {
    owners.add(row.subscriberId);
    const binding = row.boundTo;
    if (binding?.ref && (binding.kind === 'fleet-leadership' || binding.kind === 'role')) {
      bindings.set(`${binding.kind}:${binding.ref}`, {
        kind: binding.kind,
        ref: binding.ref,
      });
    }
  }

  const successorsByBinding = new Map<string, string[]>();
  await Promise.all(
    [...bindings.entries()].map(async ([key, binding]) => {
      let ids: string[] = [];
      try {
        ids = binding.kind === 'fleet-leadership'
          ? await hostAudienceResolvers.listFleetLeader(binding.ref)
          : await resolveLiveRoleHolders(binding.ref, { workspaceId });
      } catch {
        ids = [];
      }
      successorsByBinding.set(key, [...new Set(ids.filter((id) => id.trim()))]);
    }),
  );

  const candidateIds = new Set<string>(owners);
  for (const ids of successorsByBinding.values()) {
    for (const id of ids) candidateIds.add(id);
  }
  let verdicts = new Map<string, LivenessVerdict>();
  if (candidateIds.size > 0) {
    try {
      verdicts = await resolveSessionStates(
        [...candidateIds].map((ownerId) => ({ ownerId })),
        { hydratePerId: true },
      );
    } catch {
      verdicts = new Map();
    }
  }
  const isLive = (ownerId: string) => verdicts.get(ownerId)?.sessionState !== 'ended' && verdicts.has(ownerId);
  const out = new Map<number, AnnouncementOwnership>();
  for (const row of announcements) {
    const binding = row.boundTo;
    const bindingKey = binding && (binding.kind === 'fleet-leadership' || binding.kind === 'role')
      ? `${binding.kind}:${binding.ref}`
      : null;
    const liveSuccessorIds = bindingKey
      ? (successorsByBinding.get(bindingKey) ?? []).filter((id) => id !== row.subscriberId && isLive(id))
      : [];
    const declaredByLiveness = verdicts.get(row.subscriberId)?.sessionState ?? null;
    out.set(row.id, {
      declaredByLiveness,
      liveSuccessorIds,
      staleOwner:
        announcementState(row) === 'declared' &&
        declaredByLiveness === 'ended' &&
        liveSuccessorIds.length === 0,
    });
  }
  return out;
}

export default defineTool({
  name: 'events:status',
  description:
    `Inspect the await-event surface: your active wake awaits, standing event-key inject subscriptions, trees, and recent wakes, or pass an exact event key for its declaration generations, expected condition, waiter registrations, wake outcomes, and a deterministic watermark/resync verdict. Optionally include the fleet-wide wake meter. ${EVENTS_SCOPE_NOTE}`,
  guidance: {
    when: 'Checking what will reach or wake you (active wake awaits plus standing event-key inject subscriptions), whether a wake fired and via which channel, or whether the fleet is wake-storming (meter: true).',
    notWhen: `Reading your message stream — that is coord:inbox. Following an area — topics:feed. ${EVENTS_SCOPE_NOTE}`,
    seeAlso: [
      'events:cancel (cancel an await you found here)',
      'events:unsubscribe (cancel a standing event-key inject subscription you found here)',
      'events:await (arm a new wait)',
      'coord:inbox (your message stream, not the event registry)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES],
  args: z.object({
    meter: z.boolean().optional().describe('Include the wake meter (per-agent counts by status/channel, 24h; events:await is single-workspace by design, so this is fleet-wide, not scoped to your workspace).'),
    await_id: z.number().int().positive().optional().describe('Filter active awaits and recent wake deliveries to the id returned by events:await. A targeted recent delivery includes its payload (capped at 2000 characters). Mutually exclusive with `event`.'),
    event: z.string().min(1).max(200).optional().describe('Exact event key to inspect across declarations, waiter registrations, and wake outcomes. Mutually exclusive with `await_id`.'),
    after_generation: z.number().int().nonnegative().optional().describe('Your cached declaration generation for `event`. The response says whether it is stale and how to resync.'),
  }),
  async handler(args, ctx) {
    if (args.await_id != null && args.event != null) {
      throw new Error('events:status — await_id and event are mutually exclusive; use await_id to inspect one registration or event to inspect one key.');
    }
    if (args.after_generation != null && !args.event) {
      throw new Error('events:status — after_generation requires an exact `event` key.');
    }
    const identity = resolveAgentIdentity(ctx);
    // Exact-key inspection is an authority read for one event.  Do not spend
    // the result budget rendering this caller's unrelated await tree first —
    // under a busy fleet that list can hide the only requested evidence.
    const exactEvent = args.event != null;
    const [awaits, recent, backlog, meter, composedRoots, eventHistory, eventSubscriptions] = await Promise.all([
      exactEvent ? Promise.resolve([]) : listActiveAwaits(identity.ownerId),
      exactEvent
        ? Promise.resolve([])
        : args.await_id == null
          ? listRecentDeliveries(identity.ownerId, 10)
          : listRecentDeliveries(identity.ownerId, 1, args.await_id),
      exactEvent ? Promise.resolve(null) : deliveryBacklogSummary(identity.ownerId),
      args.meter ? wakeMeter() : Promise.resolve(null),
      exactEvent ? Promise.resolve([]) : listActiveComposedRoots(identity.ownerId),
      args.event ? inspectEventKey(args.event) : Promise.resolve(null),
      exactEvent ? Promise.resolve([]) : listMyEventKeySubscriptions(identity),
    ]);
    // Render each active composed tree: its authored spec + which leaves have fired vs.
    // are still pending. loadTreeLeaves reads a tree's leaves across all its nodes.
    const composed = await Promise.all(
      composedRoots.map(async (root) => ({
        root_id: root.id,
        spec: root.spec,
        required: root.requiredCount,
        fired_count: root.firedCount,
        expires_ts: root.expiresTs,
        on_timeout: root.timeoutBehavior,
        note: root.note,
        leaves: (await loadTreeLeaves(root.id)).map((l) => ({
          event: l.eventKey,
          fired: l.memberFiredAt != null,
          member_fired_at: l.memberFiredAt,
        })),
      })),
    );
    const currentAnnouncement = eventHistory?.announcements.find((a) => !a.supersededAt) ?? null;
    const fireLatch = eventHistory?.fireLatch ?? null;
    const composedRoot = eventHistory?.composedRoot ?? null;
    const authoritativeGeneration = currentAnnouncement?.causalGeneration ?? null;
    const resyncRequired = args.after_generation != null && args.after_generation !== authoritativeGeneration;
    const resyncReason = args.after_generation == null
      ? 'watermark_not_supplied'
      : authoritativeGeneration == null
        ? 'no_current_declaration'
        : args.after_generation < authoritativeGeneration
          ? 'consumer_behind'
          : args.after_generation > authoritativeGeneration
            ? 'consumer_ahead'
            : 'in_sync';
    const announcementOwnership = eventHistory
      ? await resolveAnnouncementOwnership(eventHistory.announcements, identity.workspaceId)
      : new Map<number, AnnouncementOwnership>();
    // declared-gate-recovery-contract-2026-09-21 (R-001/R-003): the current
    // declaration's deterministic classification + exact next verb, from the SAME
    // evaluator the await sweeper uses on a timeout. Read-only here — the bridge's
    // side effects run only on the sweeper path. Bounded; a failed read omits it.
    const recovery = eventHistory && currentAnnouncement
      ? (
          await withBoundedTimeout(
            async () => {
              const owned = announcementOwnership.get(currentAnnouncement.id);
              const evidence = await gatherDeclaredGateEvidence(currentAnnouncement, {
                eventKey: args.event,
                currentGeneration: authoritativeGeneration,
                history: eventHistory.announcements,
                ownership: owned
                  ? {
                      status: 'measured',
                      value: { declaredByLiveness: owned.declaredByLiveness, liveSuccessorIds: owned.liveSuccessorIds },
                    }
                  : { status: 'unavailable', reason: 'ownership was not resolved for this declaration' },
                workspaceId: identity.workspaceId,
              });
              return declaredGateRecoveryPayload(evaluateDeclaredGateGeneration(evidence), null);
            },
            { fallback: null, timeoutMs: 3_000, label: 'events-status:declared-gate-recovery' },
          )
        ).value
      : null;
    const eventInspection = eventHistory
      ? {
          event: args.event,
          current_generation: authoritativeGeneration,
          current_state: currentState(currentAnnouncement, fireLatch, composedRoot),
          ...(composedRoot
            ? {
                composed_root: {
                  root_id: composedRoot.rootId,
                  state: composedRoot.state,
                  ...(composedRoot.requiredCount != null ? { required: composedRoot.requiredCount } : {}),
                  ...(composedRoot.firedCount != null ? { fired_count: composedRoot.firedCount } : {}),
                  ...(composedRoot.firedAt !== undefined ? { fired_at: composedRoot.firedAt } : {}),
                  ...(composedRoot.cancelledAt !== undefined ? { cancelled_at: composedRoot.cancelledAt } : {}),
                  ...(composedRoot.expiresTs !== undefined ? { expires_ts: composedRoot.expiresTs } : {}),
                  ...(composedRoot.timeoutBehavior ? { on_timeout: composedRoot.timeoutBehavior } : {}),
                },
              }
            : {}),
          ...(fireLatch
            ? {
                fire_latch: {
                  first_fired_at: fireLatch.firstFiredAt,
                  last_fired_at: fireLatch.lastFiredAt,
                  last_fired_by: fireLatch.lastFiredBy,
                  fire_count: fireLatch.fireCount,
                },
              }
            : {}),
          ...(!currentAnnouncement && fireLatch
            ? {
                advice: `This key has genuinely fired ${fireLatch.fireCount}× (most recently ${fireLatch.lastFiredAt}${fireLatch.lastFiredBy ? ` by ${fireLatch.lastFiredBy}` : ''}) but was never declared via events:emit { announce:true } — do NOT read current_state:'fired_undeclared' as "never happened". If you were about to conclude this gate never opened, it did; check waiters[]/wake_outcomes[] below or last_fired_at for when.`,
              }
            : {}),
          declarations: eventHistory.announcements.map((a) => ({
            ...(announcementOwnership.has(a.id)
              ? {
                  bound_to: a.boundTo ?? null,
                  declared_by_liveness: announcementOwnership.get(a.id)!.declaredByLiveness,
                  live_successor_ids: announcementOwnership.get(a.id)!.liveSuccessorIds,
                  ...(announcementOwnership.get(a.id)!.staleOwner ? { stale_owner: true } : {}),
                }
              : {}),
            generation: a.causalGeneration ?? null,
            logical_gate: a.logicalGateKey ?? null,
            state: announcementState(a),
            declared_at: a.createdAt,
            declared_by: a.subscriberId,
            note: a.note,
            expected: a.expectedCondition ?? null,
            expected_verdict: expectedVerdict(a),
            actual_sha: payloadSha(a.firedPayload),
            fired_at: a.firedAt,
            fired_by: a.firedBy ?? null,
            cancelled_at: a.cancelledAt,
            superseded_at: a.supersededAt ?? null,
          })),
          waiters: eventHistory.waiters.map((a) => ({
            await_id: a.id,
            subscriber_id: a.subscriberId,
            policy: a.policy,
            state: a.rootId != null && composedRoot?.rootId === a.rootId
              ? composedRoot.state === 'fired'
                ? 'fired'
                : composedRoot.state === 'cancelled'
                  ? 'cancelled'
                  : composedRoot.state === 'missing'
                    ? 'orphaned'
                    : 'registered'
              : a.cancelledAt ? 'cancelled' : a.firedAt ? (a.firedReason === 'expired' ? 'expired' : 'fired') : 'registered',
            registered_at: a.createdAt,
            fired_at: a.firedAt,
            fired_reason: a.firedReason,
            cancelled_at: a.cancelledAt,
            expires_ts: a.expiresTs,
          })),
          wake_outcomes: eventHistory.deliveries.map((d) => ({
            delivery_id: d.id,
            subscriber_id: d.subscriberId,
            status: d.status,
            channel: d.channel,
            /** Derived from channel; inbox/coalesced/suppressed do not invoke a turn. */
            turn_invoked: wakeChannelInvokesTurn(d.channel),
            attempts: d.attempts,
            source: d.source,
            last_error: d.lastError,
            created_at: d.createdAt,
            delivered_at: d.deliveredAt,
          })),
          ...(recovery ? { recovery } : {}),
          resync: {
            required: resyncRequired,
            reason: resyncReason,
            consumer_generation: args.after_generation ?? null,
            authoritative_generation: authoritativeGeneration,
            rule: 'Replace cached state with this exact-key snapshot whenever required=true; then persist authoritative_generation as the next watermark.',
            next_verb: authoritativeGeneration == null
              ? `events:status { event: "${args.event}" }`
              : `events:status { event: "${args.event}", after_generation: ${authoritativeGeneration} }`,
          },
        }
      : null;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            ...(exactEvent
              ? {}
              : {
                  // Standing event-key subscriptions live in coord_entity_subscriptions,
                  // not event_awaits. Keep them as a separate collection and label the
                  // delivery kind so an inject subscription cannot be mistaken for a
                  // wake await (or passed to events:cancel).
                  active_event_subscriptions: eventSubscriptions.map((s) => ({
                    subscription_id: s.id,
                    event: s.target_ref,
                    delivery: 'inject',
                    mode: s.delivery_mode,
                    expires_ts: s.expires_ts,
                    created_at: s.created_ts,
                  })),
                  // Plain awaits only — a composed tree's leaves + anchor (rootId set)
                  // render under composed_awaits below, not as loose rows here.
                  // Announcements are emitter-side declarations and render only
                  // under exact-key event_inspection.declarations. Keeping them
                  // out of active_awaits prevents their row id being mistaken for
                  // an events:await id and passed to events:cancel.
                  active_awaits: awaits
                    .filter((a) => a.rootId == null && a.policy !== 'announce' && (args.await_id == null || a.id === args.await_id))
                    .map((a) => ({
                      await_id: a.id,
                      event: a.eventKey,
                      policy: a.policy,
                      note: a.note,
                      expires_ts: a.expiresTs,
                      on_timeout: a.timeoutBehavior,
                      created_at: a.createdAt,
                    })),
                  ...(composed.length > 0 ? { composed_awaits: composed } : {}),
                  recent_wakes: recent.map((d) => ({
                    delivery_id: d.id,
                    event: d.eventKey,
                    status: d.status,
                    channel: d.channel,
                    /** Derived from channel; status='delivered' alone is not a turn receipt. */
                    turn_invoked: wakeChannelInvokesTurn(d.channel),
                    attempts: d.attempts,
                    last_error: d.lastError,
                    created_at: d.createdAt,
                    delivered_at: d.deliveredAt,
                    ...(args.await_id != null ? statusWakePayload(d.payload) : {}),
                  })),
                  outstanding_deliveries: {
                    total: backlog?.total ?? 0,
                    by_status: {
                      pending: backlog?.pending ?? 0,
                      parked: backlog?.parked ?? 0,
                      delivering: backlog?.delivering ?? 0,
                    },
                    from_cancelled_awaits: backlog?.fromCancelledAwaits ?? 0,
                    oldest_created_at: backlog?.oldestCreatedAt ?? null,
                    recent_wakes_limit: 10,
                    shown_in_recent_wakes: recent.filter((d) =>
                      d.status === 'pending' || d.status === 'parked' || d.status === 'delivering'
                    ).length,
                    hidden_from_recent_wakes: Math.max(
                      0,
                      (backlog?.total ?? 0) - recent.filter((d) =>
                        d.status === 'pending' || d.status === 'parked' || d.status === 'delivering'
                      ).length,
                    ),
                    ...((backlog?.fromCancelledAwaits ?? 0) > 0
                      ? {
                          warning:
                            'Outstanding wake deliveries still reference cancelled awaits; the pump should settle them before execution. Do not infer a quiet queue from recent_wakes alone.',
                        }
                      : {}),
                  },
                }),
            ...(meter ? { meter } : {}),
            ...(eventInspection ? { event_inspection: eventInspection } : {}),
          }),
        },
      ],
    };
  },
});
