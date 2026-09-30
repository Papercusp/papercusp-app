/**
 * await-event engine — emit + the delivery pump + the background sweeper
 * (await-event-primitive-2026-06-05 P-002/P-005, D-001/D-002/D-004/D-007).
 *
 * `emitAwaitedEvent` is the ONE emit surface for sources (locks, plan runs,
 * conversations, CI, agents via events:emit). Per the layering (D-001) the
 * source has already resolved WHO the event concerns — a targeted key
 * (`lock:grant:<ticket>`) or an explicit `to[]` — and the delivery here is
 * dumb: wake the wake-awaiters (durable queue + the liveness ladder), put it
 * in everyone else's coord inbox (the notify path — durable in
 * coord_event_log, mid-turn injected by the PostToolUse hook when awake,
 * read on the next natural turn otherwise; NEVER wakes, D-002).
 *
 * Cost discipline (D-007): every wake is a turn. The pump caps resume-spawns
 * per tick and runs one wake per subscriber at a time (mass-unblock events
 * re-admit waiters paced, not all at once); the deliveries table is the
 * meter (per-agent attribution + channel; events:status reads it).
 */

import { getOrgPg } from '@papercusp/db-org';
import { decideWake } from '@papercusp/debounce-coalesce';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { withPgRetry } from '../../pg-transient-retry';
import { sendMessage } from '../../agent-tools/coordination/messages';
import { fetchPresenceFleet } from '../../agent-tools/coordination/presence-fleet';
import { eventKeySubscriberScope, listEventKeySubscribers } from '../../agent-tools/coordination/event-subscriptions';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { admitSpawn } from '../../fleet/governor';
import { activeWorkspaceId, backgroundWorkspaceIds } from '../../workspace-registry';
import { runWithWorkspace } from '../../workspace-als';
import {
  cancelAwaitsByIds,
  claimDueDeliveries,
  claimDueVerifiedAwaits,
  claimSpecificOnceAwaits,
  compactSupersededLoopDeliveries,
  expireLapsedAwaits,
  fireAwaitsForKey,
  listActiveAwaitsForKey,
  keyFireId,
  recordKeyFire,
  stampAnnouncementsFired,
  type LatchedEventSubscriber,
  fireTimedOutAwaits,
  insertDeliveries,
  lastWokenAtForSubscribers,
  markDeliveriesCoalesced,
  markDeliveryDeferred,
  markDeliveryDelivered,
  markDeliveryDropped,
  markDeliveryFailed,
  markDeliveryParked,
  reopenDeliveredAfterResumeDeath,
  recoverStuckDeliveries,
  reconcileFiredWakeDeliveries,
  settleCancelledAwaitDeliveries,
  settleVerifiedAwaitTimeout,
} from './store';
import { payloadMatchesFilter } from './pattern';
import {
  reconcileComposedRoot,
  reconcileComposedRoots,
} from './compose-store';
import { executeWake, degradeToInboxOrDrop, type ExecuteWakeDeps } from './wake-executor';
import { classifyResumeTurnExit, type ResumeTurnContext, type ResumeTurnExitRaw } from './resume-turn-outcome';
import { lastInboxReadAtBatch } from '../../agent-tools/coordination/inbox-read-freshness';
import { repliedMsgIdsBatch } from '../../agent-tools/coordination/messages';
import { getLineEnvelopeById } from '../../agent-tools/coordination/line-event-by-id';
import { withBoundedTimeout } from '../../bounded-timeout';
import { classifyInboxWakeGroup } from './inbox-wake-actionability';
import { wakeChannelInvokesTurn, type AwaitRow, type DeliveryWork, type WakeChannel } from './types';
import {
  payloadIsTimeout,
  recordTimeoutFires,
  summarizeTimeoutFires,
  wakeSummaryHeadline,
  TIMEOUT_WAKE_GUIDANCE,
  TIMEOUT_WAKE_SUMMARY,
} from './timeout-fallback';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { classifyVerifiedWaitTimeout } from './verified-wait';
import { observeCheckpointProducer } from './checkpoint-verified-wait';
import {
  advanceProgressLeaseCertificate,
  executeProgressLeaseRemedy,
  observeProgressLease,
  wakeProgressLeaseOwner,
} from './progress-lease';
import { appendFleetEventActivity } from '../../fleet-event-activity';

function log(msg: string): void {
  console.warn(`[await-event] ${msg}`);
}

/**
 * su-cold-auto-mode-2026-07-03 P-007: the master availability gate the wake-executor cold-fork
 * consults. Resolved HERE (the production wake pump) so wake-executor.ts stays a pure liveness
 * module with no flag-system coupling. Only CONSULTED when a wake carries a `carry:'cold'` loop
 * marker (a warm fleet never reads it), and even ON a loop goes cold only when armed
 * `carry:'cold'` AND a carry-note exists (decideColdWake). Default ON (owner-enabled 2026-07-03).
 */
const defaultColdAutoEnabled = (): Promise<boolean> => getFlag(FLAGS.SU_COLD_AUTO, 'system');

/**
 * deterministic-context-carry P-021: the verdict-gated cold-by-default resolver the
 * wake-executor's psu-host inject fork consults on a NO-carry loop marker (an
 * explicitly cold-armed loop never reads it). Lazily imported — the module pulls the
 * drill ledger reader; a warm fleet with the P-021 flag off pays one import and one
 * flag read per candidate wake, nothing more. Fail-soft false (warm) end to end.
 */
const defaultClassDefaultCold = async (host: {
  bridgeTty?: boolean | null;
  lastInputAt?: number | null;
}): Promise<boolean> => {
  try {
    const { classDefaultColdForWake } = await import('../../su-cold-by-default');
    return await classDefaultColdForWake(host);
  } catch {
    return false;
  }
};

/**
 * EI-21572316039386007: the human-presence resolver the wake-executor consults on EVERY
 * cold route — including the explicit `carry:'cold'` opt-in, which (unlike the P-021
 * verdict route above, per that resolver's own doc) never read a presence signal at all.
 * A cold-armed loop therefore reset live sessions mid-conversation while their owner was
 * typing. Same lazy-import + fail-soft-false shape as its sibling; false means "no human
 * observed", which is both today's behavior and what every headless session resolves to.
 */
const defaultActiveInteractiveExchange = async (host: {
  bridgeTty?: boolean | null;
  lastInputAt?: number | null;
}): Promise<boolean> => {
  try {
    const { activeInteractiveExchangeForWake } = await import('../../su-cold-by-default');
    return activeInteractiveExchangeForWake(host);
  } catch {
    return false;
  }
};

/** Resume-spawn cap per pump tick (a wake = a turn = tokens — pace mass unblocks). */
function maxResumesPerTick(): number {
  const n = Number(process.env.PAPERCUSP_AWAIT_MAX_RESUMES_PER_TICK ?? 3);
  return Number.isFinite(n) && n >= 1 ? n : 3;
}

const MAX_ATTEMPTS = 8;
const PARK_RECHECK_MS = 45_000;
const DEFER_MS = 30_000;
const STUCK_DELIVERING_MS = 5 * 60_000;
const backoffMs = (attempts: number): number => Math.min(5_000 * 2 ** attempts, 10 * 60_000);

/**
 * Internal fire-and-forget auto-pump kick (the `setImmediate(pumpWakeDeliveries)`
 * emit/deliver paths queue) — ON by default, so production behaviour is unchanged.
 *
 * An INTEGRATION test that drives the pump itself with an injected testbed
 * host-discovery dep (`pumpWakeDeliveries(ws, { findPsuHost: tb.findPsuHostDep() })`)
 * must be able to suppress this internal kick: it fires with PRODUCTION host
 * discovery (`deps={}` → `findLiveHost`), which cannot see the testbed's isolated
 * psu-pty sockets, so it RACES and mis-consumes (degrades to coord-inbox) the exact
 * delivery the test means to land over its live testbed socket. The race is timing
 * dependent — any extra `await` in emit before it returns (e.g. the WI-4014
 * event-key subscriber lookup) lets the kicked pump win — which is precisely how
 * `wake-on-message.integration.test.ts` started flaking. The test drives the pump
 * explicitly, so the internal kick is redundant there; disable it to make the test
 * the sole, controlled-deps pump. Never gate production on this flag.
 */
let autoPumpEnabled = true;
/** @internal test-only: suppress/restore the internal auto-pump kick. Returns the
 *  prior value so a test can restore it in teardown. */
export function setAutoPumpEnabledForTests(enabled: boolean): boolean {
  const prev = autoPumpEnabled;
  autoPumpEnabled = enabled;
  return prev;
}

/** System identity for the notify-path sends (mirrors green-checkpoint's). */
function emitterIdentity(source: string | undefined, workspaceId: string): AgentIdentity {
  return {
    ownerId: source ?? 'await-event',
    ownerLabel: source ?? 'await-event',
    source: 'static-client',
    workspaceId,
    userId: null,
  } as AgentIdentity;
}

export interface EmitAwaitedEventOpts {
  /** Exact event key, e.g. `lock:grant:<ticket>` / `plan-run:finished:<id>`. */
  key: string;
  /** Carried on wake deliveries + the notify message body. */
  payload?: unknown;
  /** One human line — becomes part of the wake turn / notify summary. */
  summary?: string;
  /** Additional notify audience: ownerIds, Brief 28 @-selectors, '*' or 'human'.
   *  Wake-awaiters are woken regardless and EXCLUDED from the notify send
   *  (their wake already carries the reason). */
  to?: string[];
  /** Emitter attribution (ownerId or a system name). */
  source?: string;
  /** Urgent: bypass the per-subscriber wake floor for the wake deliveries this emit
   *  queues (a human message, an escalation, a hard deadline). */
  urgent?: boolean;
  workspaceId?: string;
  /** EI-12457: exact event key(s) that are the MUTUALLY-EXCLUSIVE opposite outcome of
   *  this one (e.g. emitting `release:green:<pipeline>` names
   *  `green-checkpoint:red:<pipeline>` here). For every subscriber this emit actually
   *  WAKES, their still-pending awaits on these sibling keys that are BOUND TO THIS
   *  REGISTRATION GROUP (the same note as the fired row), or are BOUND TO THIS CANDIDATE
   *  (an explicit payload_filter matching this emit's payload), are atomically cancelled —
   *  that terminal outcome has resolved the group/candidate, so the dead registration is
   *  retired now instead of living until its own timeout.
   *
   *  An unrelated UNBOUND await (different note) is deliberately LEFT ARMED: it means
   *  "wake me on the next verdict, any candidate", and this candidate resolving says
   *  nothing about that separate registration. Best-effort/fail-soft: never breaks the emit.
   *  Omitted ⇒ no sibling cancellation. */
  cancelSiblingKeysFor?: string[];
}

export interface EmitResult {
  ok: true;
  key: string;
  /** Wake awaits fired by this emit (deliveries queued). */
  woken: number;
  /** Notify recipients the inbox message went to (post-expansion happens in sendMessage). */
  notified: string[];
  msgId: string | null;
  /** EI-9000: total ACTIVE events:await registrations matched on this key by
   *  this emit — `woken + notifyAwaits`, i.e. everyone who had actually
   *  registered before you fired (independent of any extra `to[]` audience,
   *  which is a fire-and-forget add-on, not a waiter). Lets the emitter tell
   *  "0 woken because nobody was listening on this key at all" apart from
   *  "0 woken but N were notified", and tells a caller BEFORE they decide the
   *  emit was worth it that it genuinely reached no one when `waiters` is 0
   *  and no `to[]` was given. Does NOT include event-key inject subscribers
   *  below (a different table/primitive — see `eventSubscribers`). */
  waiters: number;
  /** WI-4014 Part 2: count of STANDING event-key inject subscribers
   *  (watch:create wake:false targetKind:'event') this emit folded into the
   *  notify audience — distinct from `waiters` (the wake:true awaits table).
   *  Optional (not just always-0) so existing EmitResult literals/mocks built
   *  before this field existed (predicate-watch's test double, emit.test.ts's
   *  mocks) stay valid without every call site needing an update. */
  eventSubscribers?: number;
}

/**
 * EI-20079462322478221: a claimable await's payload_filter is intentionally a
 * conservative snapshot of the member's claim-spec view.  A spec revision is
 * a control-plane change, however, and must wake the member even when the next
 * claimable event would not satisfy that old snapshot.  Target the affected
 * subscribers, atomically consume their one-shot awaits, and enqueue the same
 * durable delivery path as an ordinary event.
 *
 * The wake is only a HINT: scheduler:get_next remains authoritative on resume.
 * Ordinary work-item emits still evaluate payload_filter normally, so this
 * escape hatch cannot widen a member's claim path.
 */
export async function wakeClaimableAwaitersForSubscribers(input: {
  subscriberIds: readonly string[];
  specId?: string | null;
  revision?: number | null;
}): Promise<number> {
  const subscribers = new Set(input.subscriberIds.filter((id) => typeof id === 'string' && id.length > 0));
  if (subscribers.size === 0) return 0;

  const active = await listActiveAwaitsForKey('work-item:claimable');
  const candidateIds = active
    .filter((row) => row.policy === 'wake' && row.once && subscribers.has(row.subscriberId))
    .map((row) => row.id);
  if (candidateIds.length === 0) return 0;

  // The row-level claim is atomic, so a real claimable emit racing this control
  // wake wins one row and the other path simply sees no pending await.
  const fired = await claimSpecificOnceAwaits(candidateIds, 'claim-spec-revision');
  if (fired.length === 0) return 0;

  const ref = input.specId
    ? `${input.specId}${input.revision == null ? '' : `@${input.revision}`}`
    : 'the updated claim spec';
  await insertDeliveries({
    awaits: fired,
    payload: {
      reason: 'claim-spec-revision',
      ...(input.specId ? { specId: input.specId } : {}),
      ...(input.revision == null ? {} : { revision: input.revision }),
    },
    summary: `Claim spec ${ref} changed; re-run scheduler:get_next to re-evaluate the live lane.`,
    source: 'scheduler:set_claim_spec',
  });

  // Keep the write path fast, as emitAwaitedEvent does. The durable delivery is
  // already committed before this kick; a later sweep is the fallback if the
  // detached pump cannot start immediately.
  if (autoPumpEnabled) {
    const ws = activeWorkspaceId();
    void pumpWakeDeliveries(ws).catch((e) => log(`claim-spec wake pump failed: ${e instanceof Error ? e.message : e}`));
  }
  return fired.length;
}

export async function emitAwaitedEvent(opts: EmitAwaitedEventOpts): Promise<EmitResult> {
  const ws = opts.workspaceId ?? activeWorkspaceId();

  // EI-13705: record the fire on the UNCONDITIONAL per-key latch BEFORE claiming
  // await rows. The bridge can start an event between an awaiter's pre-registration
  // probe and registerAwait; recording first makes the post-registration probe see
  // the fire and atomically retire a still-pending row instead of leaving it to time
  // out. Fail-soft — never break the emit when the diagnostic latch is unavailable.
  // Unknown (latch failed, or a stub returned nothing) ⇒ take the locked stamp path.
  let announcementPending = true;
  // WI-10003631: the latch statement also returns the standing event-key
  // subscribers; undefined (latch failed / stub) ⇒ the separate read below.
  let latchedSubscribers: LatchedEventSubscriber[] | undefined;
  const subscriberScope = eventKeySubscriberScope();
  try {
    const latch = await recordKeyFire({
      eventKey: opts.key, firedBy: opts.source ?? null, payload: opts.payload,
      subscribersFrom: subscriberScope,
    });
    if (latch && latch.announcementPending === false) announcementPending = false;
    latchedSubscribers = latch?.eventSubscribers;
    // P-018 (D-029 §2): worn async identity rules subscribe as muted rows. Each one
    // this fire reached becomes a durable reaction keyed by the latch's fire
    // identity; without that identity (latch failed) nothing is enqueued. Loaded
    // lazily so the emit path carries no identity/DBOS graph unless a derived row
    // exists; enqueueIdentityReactions keeps only the identity-rule kind.
    const identityRows = latchedSubscribers?.filter((s) => s.derived_from_kind != null) ?? [];
    if (latch?.fire && identityRows.length > 0) {
      try {
        const { enqueueIdentityReactions } = await import('../identity-reaction');
        await enqueueIdentityReactions({
          workspaceId: subscriberScope.workspaceId, eventKey: opts.key,
          fireId: keyFireId(opts.key, latch.fire), payload: opts.payload, rows: identityRows,
        });
      } catch (e) {
        log(`identity reaction enqueue failed for ${opts.key}: ${e instanceof Error ? e.message : e}`);
      }
    }
  } catch (e) {
    // WI-10003882: a Postgres lock failure's `detail` names both sides of the lock
    // cycle (which process waits on which transaction). The message alone
    // ("deadlock detected") leaves the contending statement unrecoverable.
    const detail = (e as { detail?: unknown } | null)?.detail;
    log(`key-fire latch record failed for ${opts.key}: ${e instanceof Error ? e.message : e}`
      + (typeof detail === 'string' && detail ? ` | ${detail.replace(/\s+/g, ' ')}` : ''));
  }

  // pui-agent-context-cockpit P-026: reuse the activity ledger + its existing
  // SSE transport as the fleet transition tape. This pure-filtered append only
  // accepts the six tape families and is fail-soft, so observability can never
  // break event delivery. Await it to preserve causal BIGSERIAL ordering when
  // related transitions (member-dead + claim-released) fire back-to-back.
  await appendFleetEventActivity({
    eventKey: opts.key,
    payload: opts.payload,
    summary: opts.summary,
    workspaceId: ws,
  });

  // 1. One-shot fire the awaits on this key (atomic — D-002). EI-8998: the payload is
  // threaded through so a row carrying a payload_filter is only fired when the
  // emitted payload actually satisfies it (rows with no filter are unaffected).
  const fired = await fireAwaitsForKey({
    eventKey: opts.key,
    reason: 'event',
    payload: opts.payload,
    source: opts.source,
  });
  // composable-event-awaits-2026-07-11: a fired row tagged with node_id is a composed-await LEAF.
  // It does NOT wake/notify its subscriber directly — its (already atomic, exactly-once) claim
  // PROPAGATES up the threshold tree, and only a ROOT trip queues a single wake. Split composed
  // leaves off the plain wake/notify paths; the composed rows are handled below (fail-soft).
  const composedLeaves = fired.filter((a) => a.nodeId != null);
  const plainFired = fired.filter((a) => a.nodeId == null);
  const wakes = plainFired.filter((a) => a.policy === 'wake');
  const notifyAwaits = plainFired.filter((a) => a.policy === 'notify');

  // EI-9270: latch any ANNOUNCED gate on this key (fired_at stamped, row kept) so a
  // late registrant is told the gate already opened. Fail-soft — never break the emit.
  // WI-10003631: skipped when the latch statement proved no unfired announcement existed.
  if (announcementPending) {
    try {
      await stampAnnouncementsFired(opts.key, { firedBy: opts.source ?? null, payload: opts.payload });
    } catch (e) {
      log(`announce latch stamp failed for ${opts.key}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 2. Queue durable wake deliveries + kick the pump off the hot path.
  if (wakes.length > 0) {
    await insertDeliveries({
      awaits: wakes,
      payload: opts.payload,
      summary: opts.summary ?? null,
      urgent: opts.urgent,
      // P0a: persist the emit attribution on the delivery so a later turn-death is
      // attributable to its source (e.g. a loop fire's `loop:<routineId>`).
      source: opts.source ?? null,
    });
    if (autoPumpEnabled) {
      setImmediate(() => {
        void pumpWakeDeliveries(ws).catch((e) => log(`pump kick failed: ${e instanceof Error ? e.message : e}`));
      });
    }
  }

  // 1b. EI-12457: sibling cancellation — for every subscriber THIS emit actually woke
  // (matched key + any payload_filter), retire their still-pending awaits on the
  // named opposite-outcome key(s). The resolved candidate can never fire those now;
  // without this they live until their own (possibly long) timeout, accumulating as
  // dead registrations. Scoped to subscribers actually woken, never every registrant
  // on the sibling key (a peer awaiting a DIFFERENT candidate must not be touched).
  if (opts.cancelSiblingKeysFor && opts.cancelSiblingKeysFor.length > 0 && wakes.length > 0) {
    try {
      // EI-21508340942800237: checkpoint:await arms three mutually-exclusive rows
      // with one shared note. Once any row wins, the two unbound sibling rows in THAT
      // registration group are dead too; leaving them pending produced false timeout
      // wakes hours after a terminal verdict. Match the fired row's subscriber+note so
      // a distinct unbound registration remains armed. Candidate-bound rows retain the
      // existing payload-filter match, which is the authoritative group identity for
      // targeted waits.
      const wokenBySubscriber = new Map<string, AwaitRow[]>();
      for (const wake of wakes) {
        const rows = wokenBySubscriber.get(wake.subscriberId) ?? [];
        rows.push(wake);
        wokenBySubscriber.set(wake.subscriberId, rows);
      }
      const deadIds = new Set<number>();
      for (const key of opts.cancelSiblingKeysFor) {
        const rows = await listActiveAwaitsForKey(key).catch((e) => {
          log(`sibling-await scan failed for ${key}: ${e instanceof Error ? e.message : e}`);
          return [] as AwaitRow[];
        });
        for (const row of rows) {
          const subscriberWakes = wokenBySubscriber.get(row.subscriberId);
          if (!subscriberWakes) continue; // never touch a peer's wait
          if (row.payloadFilter != null) {
            if (payloadMatchesFilter(row.payloadFilter, opts.payload)) deadIds.add(row.id);
            continue;
          }
          if (subscriberWakes.some((wake) => wake.note === row.note)) deadIds.add(row.id);
        }
      }
      if (deadIds.size > 0) await cancelAwaitsByIds([...deadIds]);
    } catch (e) {
      log(`sibling-await cancellation failed for ${opts.key}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 2b. Composed-await leaves: propagate each claim up its threshold tree (a root trip queues
  // its own wake + voids the tree). Fail-soft — a tree-propagation error must never break the
  // emit (the plain wake/notify halves above already fired).
  if (composedLeaves.length > 0) {
    try {
      await propagateComposedLeafClaims({ leaves: composedLeaves, payload: opts.payload, workspaceId: ws, source: opts.source ?? null });
    } catch (e) {
      log(`composed propagation failed for ${opts.key}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 3. The notify path — one coord message to the remaining audience.
  const wokenIds = new Set(wakes.map((a) => a.subscriberId));

  // WI-4014 Part 2: fold in STANDING event-key inject subscribers
  // (watch:create { wake:false, targetKind:'event' }) — the cheap, no-token-cost
  // sibling of the wake:true awaits above. 'muted' rows are deliberately excluded
  // (the one delivery_mode that means "never live-deliver"); every other mode
  // (full/digest/mention) is included here — this notify path has no per-mode
  // rendering tiers today (unlike deliverInjectMany's object/topic fan-out), so a
  // mention-mode row still gets the flat notify rather than being gated to
  // @-mentions only (no @-mention concept applies to a bare event fire). Fail-soft:
  // a lookup error must never break the emit (the wake half above already fired).
  let eventSubscriberIds: string[] = [];
  try {
    const subs = latchedSubscribers ?? await listEventKeySubscribers(opts.key);
    eventSubscriberIds = subs.filter((s) => s.delivery_mode !== 'muted').map((s) => s.subscriber_id);
  } catch (e) {
    log(`event-key subscriber lookup failed for ${opts.key}: ${e instanceof Error ? e.message : e}`);
  }

  const notifyTo = [
    ...new Set([...notifyAwaits.map((a) => a.subscriberId), ...eventSubscriberIds, ...(opts.to ?? [])]),
  ].filter((t) => !wokenIds.has(t));

  let msgId: string | null = null;
  if (notifyTo.length > 0) {
    try {
      const env = await sendMessage(emitterIdentity(opts.source, ws), {
        to: notifyTo,
        summary: `[event] ${opts.key}${opts.summary ? ` — ${opts.summary}` : ''}`,
        body: opts.payload != null ? JSON.stringify(opts.payload).slice(0, 2000) : undefined,
        category: 'event',
        extra: { auto: true, event_key: opts.key },
      });
      msgId = env.msg_id;
    } catch (e) {
      // The notify half is the politeness layer — never break the emit.
      log(`notify send failed for ${opts.key}: ${e instanceof Error ? e.message : e}`);
    }
  }

  return {
    ok: true,
    key: opts.key,
    woken: wakes.length,
    notified: notifyTo,
    msgId,
    waiters: fired.length,
    eventSubscribers: eventSubscriberIds.length,
  };
}

/**
 * WI-4957 / EI-20391462658650094 — wake checkpoint awaits bound to a candidate whose
 * run was just proven DEAD (a checkpoint run for it was stopped/superseded before it
 * could produce a verdict).
 *
 * The historical helper name says "cancel", but cancellation was the bug: it marked a
 * parked one-shot await as consumed without telling its subscriber why it would never
 * receive a verdict. A durable candidate-replaced wake gives that subscriber an
 * actionable reason to re-orient and register a fresh await for the replacement run.
 *
 * Deliberately narrow: only rows carrying an EXPLICIT payload_filter that matches
 * `{ sha: staleCandidateSha }`, and only `once` wake rows, are touched. The same
 * `payloadMatchesFilter` evaluator used by `fireAwaitsForKey` answers whether the row
 * was bound to this candidate. Unbound waits remain armed for the replacement run;
 * different-candidate, notify, and standing rows are untouched. The scan, claim, and
 * delivery path are best-effort/fail-soft so a problem here never blocks the fresh
 * checkpoint launch it runs ahead of.
 */
export async function cancelSupersededCandidateAwaits(input: {
  /** The checkpoint-family key(s) to sweep (global + pipeline-scoped outcomes). */
  keys: readonly string[];
  /** The candidate sha whose run is now dead — matched against each row's payload_filter,
   *  the same direction `payloadMatchesFilter` evaluates at fire time (a `{startsWith}`
   *  filter matches when THIS sha starts with the filter's prefix). */
  staleCandidateSha: string;
}): Promise<{ cancelled: number; ids: number[] }> {
  const staleRows = new Map<number, AwaitRow>();
  for (const key of new Set(input.keys)) {
    let rows: AwaitRow[];
    try {
      rows = await listActiveAwaitsForKey(key);
    } catch (e) {
      log(`cancelSupersededCandidateAwaits: listActiveAwaitsForKey(${key}) failed: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    for (const row of rows) {
      if (row.policy !== 'wake' || !row.once || row.payloadFilter == null) continue;
      if (payloadMatchesFilter(row.payloadFilter, { sha: input.staleCandidateSha })) staleRows.set(row.id, row);
    }
  }

  const staleIds = [...staleRows.keys()];
  if (staleIds.length === 0) return { cancelled: 0, ids: [] };

  let claimed: AwaitRow[];
  try {
    // Atomic exactly-once claim: a concurrent verdict or replacement handler may have
    // consumed one of these rows between the scan and this wake, and only the winner
    // should enqueue a delivery.
    claimed = await claimSpecificOnceAwaits(staleIds);
  } catch (e) {
    log(`cancelSupersededCandidateAwaits: claim failed: ${e instanceof Error ? e.message : e}`);
    return { cancelled: 0, ids: [] };
  }

  if (claimed.length === 0) return { cancelled: 0, ids: [] };

  try {
    await insertDeliveries({
      awaits: claimed,
      payload: { reason: 'candidate-replaced', sha: input.staleCandidateSha },
      summary: `Checkpoint candidate replacement: ${input.staleCandidateSha} was stopped before a verdict; re-evaluate the current candidate.`,
      source: 'release:checkpoint-run:candidate-replaced',
    });
  } catch (e) {
    log(`cancelSupersededCandidateAwaits: delivery enqueue failed: ${e instanceof Error ? e.message : e}`);
    return { cancelled: 0, ids: [] };
  }

  if (autoPumpEnabled) {
    const ws = activeWorkspaceId();
    setImmediate(() => {
      void pumpWakeDeliveries(ws).catch((e) => log(`candidate-replaced wake pump failed: ${e instanceof Error ? e.message : e}`));
    });
  }

  // Keep the legacy result shape for cancelStaleCheckpointAwaits callers. `ids` now
  // identifies rows that received the durable wake; no await was cancelled.
  return { cancelled: 0, ids: claimed.map((row) => row.id) };
}

/**
 * Deliver to SPECIFIC await rows rather than sweeping a whole key (EI-8998 predicate
 * dedup join, fleet-reliability-verification-2026-07-10 P-004): when a new subscriber
 * joins an ALREADY-matched shared predicate row, the normal edge-triggered fire will
 * never happen again for it while the value stays true — it must be told NOW, without
 * calling `emitAwaitedEvent` on the shared key (which would re-fire every OTHER
 * standing subscriber already registered there, even though nothing changed for them).
 * once=true rows are atomically claimed (exactly-once, same guard as
 * `fireAwaitsForKey`); once=false rows deliver without consuming. Non-wake-policy rows
 * are ignored (a predicate join always registers a wake await).
 */
export async function deliverToSpecificAwaits(input: {
  awaitRows: AwaitRow[];
  payload?: unknown;
  summary?: string;
  source?: string;
}): Promise<{ delivered: number }> {
  const wakeRows = input.awaitRows.filter((a) => a.policy === 'wake');
  const onceIds = wakeRows.filter((a) => a.once).map((a) => a.id);
  const standing = wakeRows.filter((a) => !a.once);
  const claimedOnce = await claimSpecificOnceAwaits(onceIds);
  const toDeliver = [...claimedOnce, ...standing];
  if (toDeliver.length === 0) return { delivered: 0 };
  const ws = activeWorkspaceId();
  await insertDeliveries({
    awaits: toDeliver,
    payload: input.payload,
    summary: input.summary ?? null,
    source: input.source ?? null,
  });
  if (autoPumpEnabled) {
    setImmediate(() => {
      void pumpWakeDeliveries(ws).catch((e) => log(`pump kick failed: ${e instanceof Error ? e.message : e}`));
    });
  }
  return { delivered: toDeliver.length };
}

// ── composed threshold-tree awaits (composable-event-awaits-2026-07-11) ──────────
//
// A fired composed leaf is the durable intent. The store re-reads each root's
// fired leaves and commits member stamps, counter bumps, root delivery and
// descendant void together under a transaction lock.

/** Propagate this emit's leaf claims through the recoverable root transaction. */
export async function propagateComposedLeafClaims(input: {
  leaves: AwaitRow[];
  payload?: unknown;
  workspaceId?: string;
  source?: string | null;
}): Promise<void> {
  const ws = input.workspaceId ?? activeWorkspaceId();
  const rootIds = new Set(input.leaves.flatMap((leaf) => leaf.nodeId != null && leaf.rootId != null ? [leaf.rootId] : []));
  let deliveries = 0;
  for (const rootId of rootIds) {
    const result = await reconcileComposedRoot(rootId);
    if (result.delivered) deliveries++;
  }
  if (deliveries > 0 && autoPumpEnabled) {
    setImmediate(() => {
      void pumpWakeDeliveries(ws).catch((e) => log(`composed pump kick failed: ${e instanceof Error ? e.message : e}`));
    });
  }
}
// ── the pump ──────────────────────────────────────────────────────────────────

// Keyed per workspace (audit P-033): a single module-global boolean made workspace
// A's in-flight pump silently swallow workspace B's emit kick — the kick is
// fire-and-forget, so the dropped tick was invisible and B's wakes starved until
// the next sweep. Concurrent pumps for DIFFERENT workspaces are safe (claiming is
// SKIP LOCKED and workspace-scoped); the guard only exists to stop one workspace
// from pumping itself reentrantly.
const pumpsInFlight = new Set<string>();
// A same-workspace kick that arrives while the singleton pump is busy is not
// re-entrant work, but it is still information: durable rows arrived after this
// batch was chosen. Latch one trailing-edge rerun instead of dropping that signal
// and waiting up to the 30-second sweep (EI-21303383797798186).
const pumpRerunRequested = new Map<string, ExecuteWakeDeps>();

export interface PumpStats {
  claimed: number;
  /** Claimed deliveries settled without a turn because their standing inbox-wake await was cancelled. */
  cancelled: number;
  /** Settled deliveries whose channel accepted a turn-burning invocation. */
  delivered: number;
  /** Settled through the coord inbox fallback; no turn was invoked. */
  inbox: number;
  parked: number;
  dropped: number;
  failed: number;
  deferred: number;
  /** Deliveries folded into another wake for the same subscriber (no turn spent). */
  coalesced: number;
  /** EI-18673058981655804: inbox-wake deliveries settled WITHOUT spending a turn because
   *  every message they would have quoted already predates the subscriber's own last
   *  coord:inbox/coord:orient read (channel='suppressed-redundant'). */
  suppressed: number;
}

/** Keep pump counters aligned with the durable channel semantics. */
function recordSettledDeliveryStats(stats: PumpStats, channel: WakeChannel): void {
  if (wakeChannelInvokesTurn(channel)) {
    stats.delivered++;
  } else if (channel === 'inbox') {
    stats.inbox++;
  } else if (channel === 'suppressed-redundant') {
    stats.suppressed++;
  }
}

/** The per-agent inbox-wake key prefix. Duplicated (not imported) from
 *  agent-tools/coordination/inbox-wake.ts to avoid the inbox-wake → engine →
 *  inbox-wake import cycle (inbox-wake.ts imports emitAwaitedEvent FROM this
 *  module) — same "two owners, one string, in lockstep" pattern documented in
 *  wake-executor.ts's own copy of this constant. */
const COORD_INBOX_WAKE_PREFIX = 'coord:inbox-wake:';

/** Best-effort extraction of a wake delivery payload's `msg_id` (send.ts stamps
 *  `{ msg_id: env.msg_id }` on every directed coord:send wake — EI-18663224517726594).
 *  Never throws on a malformed/foreign payload shape (a coalesced or non-coord-send
 *  delivery may carry no such field at all). */
function deliveryMsgId(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'msg_id' in payload) {
    const v = (payload as { msg_id?: unknown }).msg_id;
    return typeof v === 'string' && v ? v : null;
  }
  return null;
}

/** Upper bound for the delivery-time envelope reads behind the actionability gate. */
const INBOX_WAKE_ENVELOPE_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * P-024 clauses B/C: resolve the coord envelopes an inbox-wake group points at,
 * so `classifyInboxWakeGroup` can ask whether any of them carries something to
 * act on. Looks on `messages` first, then `plan-events`. Every failure mode
 * (a read error, a timeout, a missing row) leaves that id OUT of the map, which
 * the classifier reads as "unresolved ⇒ keep the turn" (fail open).
 */
export async function resolveInboxWakeEnvelopes(msgIds: readonly string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const unique = [...new Set(msgIds)];
  if (unique.length === 0) return out;
  await withBoundedTimeout(
    Promise.all(
      unique.map(async (id) => {
        try {
          const env = (await getLineEnvelopeById('messages', id)) ?? (await getLineEnvelopeById('plan-events', id));
          if (env) out.set(id, env);
        } catch {
          /* fail open: an unreadable envelope keeps the wake */
        }
      }),
    ),
    { fallback: [], timeoutMs: INBOX_WAKE_ENVELOPE_LOOKUP_TIMEOUT_MS, label: 'inbox-wake actionability envelopes' },
  );
  return out;
}

/**
 * EI-18673058981655804 (redundant-inbox-wake-suppression): is this GROUP of due
 * deliveries entirely redundant against the subscriber's OWN inbox reads?
 *
 * MEASURED (not hypothetical): a busy agent's own `coord:inbox`/`coord:orient`
 * polling routinely surfaces + acts on a message BEFORE the always-armed
 * inbox-wake for that same message is ever consumed — four consecutive empty
 * wakes were observed in one session, each re-quoting mail the agent had
 * already read and answered. The platform already tracks the watermark this
 * needs (`lastInboxReadAtBatch`, built for coord-deafness detection) — this
 * consults it instead of unconditionally spending a turn.
 *
 * EI-18676763837940562 (reply-linkage leg): the read-cursor check above cannot see
 * one real case — a subscriber who read AND REPLIED to the message within the SAME
 * turn a queued wake delivery for it later lands (the cleanest reported instance:
 * read + reply at T, wake for a delivery created at T-2min still fires at T+few-sec,
 * because whatever updates the read-cursor watermark hadn't yet been observed by
 * this batch, or lags the reply itself). A REPLY — a message this exact subscriber
 * sent whose `related_msg_id` equals the delivery's own `payload.msg_id` — is
 * unambiguous, independent proof of discharge: the recipient cannot have replied to
 * a message they never saw. `repliedMsgIds` is optional (omitted ⇒ this leg is a
 * no-op, byte-identical to before) and pre-resolved by the caller (batched over the
 * group's subscriber, mirroring `lastReadAtIso`) so this stays a pure, DB-free check.
 *
 * A delivery is redundant when it is non-urgent, an inbox-wake delivery, AND
 * (its `createdAt` is at or before the read-cursor OR its `msg_id` was replied to).
 * Fail-OPEN on every uncertain case — a mixed group (a genuine non-inbox-wake await
 * coalesced alongside it), an urgent delivery, or neither signal present is NEVER
 * suppressed, so the worst case of getting this wrong is identical to today's
 * status quo (an extra turn), never a dropped wake.
 */
export function isInboxWakeGroupRedundant(
  group: readonly (Pick<DeliveryWork, 'eventKey' | 'createdAt' | 'urgent'> & { payload?: unknown })[],
  lastReadAtIso: string | null | undefined,
  repliedMsgIds?: ReadonlySet<string>,
): boolean {
  if (group.length === 0) return false;
  const readMs = lastReadAtIso ? Date.parse(lastReadAtIso) : NaN;
  const hasReadSignal = !Number.isNaN(readMs);
  if (!hasReadSignal && (!repliedMsgIds || repliedMsgIds.size === 0)) return false;
  return group.every((d) => {
    if (d.urgent) return false;
    if (!d.eventKey.startsWith(COORD_INBOX_WAKE_PREFIX)) return false;
    if (hasReadSignal) {
      const createdMs = Date.parse(d.createdAt);
      if (!Number.isNaN(createdMs) && createdMs <= readMs) return true;
    }
    const msgId = deliveryMsgId(d.payload);
    return msgId != null && (repliedMsgIds?.has(msgId) ?? false);
  });
}

/**
 * Fold a subscriber's due deliveries into ONE wake (unify-watch-primitive P-005): the
 * newest is the headline; its summary/payload carry the union ("here are the N things
 * that fired while you slept"). The siblings settle as `coalesced` (no extra turns).
 */
export function coalesceDeliveries(group: DeliveryWork[]): DeliveryWork {
  const headline = group[group.length - 1];
  if (group.length === 1) return headline;
  // Timeout wakes are synthesized by the sweeper (`payload.timeout === true`),
  // not emitted by the event source. A checkpoint deadline can therefore put
  // several mutually-exclusive verdict awaits into the same subscriber group;
  // calling those rows "events fired" falsely claims that every verdict happened.
  const timeoutDeliveries = group.filter((d) => {
    const payload = d.payload;
    return payload != null && typeof payload === 'object' && (payload as { timeout?: unknown }).timeout === true;
  });
  const eventDeliveries = group.filter((d) => !timeoutDeliveries.includes(d));
  const eventKeys = eventDeliveries.map((d) => d.eventKey);
  const timeoutKeys = timeoutDeliveries.map((d) => d.eventKey);
  const plural = (count: number, singular: string): string => (count === 1 ? singular : `${singular}s`);
  const summaryParts: string[] = [];
  if (eventKeys.length > 0) {
    summaryParts.push(`${eventKeys.length} ${plural(eventKeys.length, 'event')} fired while you slept: ${eventKeys.join(', ')}`);
  }
  if (timeoutKeys.length > 0) {
    summaryParts.push(
      `${timeoutKeys.length} ${plural(timeoutKeys.length, 'await deadline')} expired while you slept: ${timeoutKeys.join(', ')}`,
    );
  }
  return {
    ...headline,
    summary:
      summaryParts.join('; ') +
      (headline.summary ? ` — latest: ${headline.summary}` : ''),
    payload: {
      coalesced: true,
      count: group.length,
      eventCount: eventDeliveries.length,
      timeoutCount: timeoutDeliveries.length,
      // Preserve the original delivery timestamp inside the union. Consumers that
      // enforce delivery-time lifecycle gates (notably loop-fire suppression) must
      // compare a folded sibling with the loop instance that produced it, rather
      // than with the newer headline's timestamp.
      events: group.map((d) => ({
        event: d.eventKey,
        summary: d.summary,
        payload: d.payload,
        delivery_id: d.id,
        createdAt: d.createdAt,
      })),
      latest: { event: headline.eventKey, payload: headline.payload, createdAt: headline.createdAt, delivery_id: headline.id },
    },
    coalescedCount: group.length,
  };
}

/**
 * Process due wake deliveries: claim (SKIP LOCKED) → GROUP by subscriber → per-subscriber
 * floor + coalesce (the unify-watch-primitive gap) → execute the liveness ladder → settle.
 *
 * Per subscriber, per tick: a `min_sleep` floor defers the whole group until the floor next
 * allows a wake (`decideWake`); when it does wake, the group's due deliveries COALESCE into a
 * single wake carrying their union — one turn for N events, not N turns. `urgent` deliveries
 * bypass the floor. Resume-spawns are still capped per tick across subscribers (D-007).
 */
export async function pumpWakeDeliveries(workspaceId?: string, deps: ExecuteWakeDeps = {}): Promise<PumpStats> {
  const stats: PumpStats = {
    claimed: 0,
    cancelled: 0,
    delivered: 0,
    inbox: 0,
    parked: 0,
    dropped: 0,
    failed: 0,
    deferred: 0,
    coalesced: 0,
    suppressed: 0,
  };
  const ws = workspaceId ?? activeWorkspaceId();
  if (pumpsInFlight.has(ws)) {
    pumpRerunRequested.set(ws, deps);
    return stats;
  }
  pumpsInFlight.add(ws);
  try {
    const claimed = await claimDueDeliveries({ limit: 25 });
    stats.claimed = claimed.length;
    const cancelledIds = await settleCancelledAwaitDeliveries(claimed);
    stats.cancelled = cancelledIds.length;
    const cancelled = new Set(cancelledIds);
    const executable = claimed.filter((delivery) => !cancelled.has(delivery.id));
    if (executable.length === 0) return stats;

    // Group claimed deliveries by subscriber — the coalesce + floor unit.
    const bySubscriber = new Map<string, DeliveryWork[]>();
    for (const d of executable) {
      const arr = bySubscriber.get(d.subscriberId);
      if (arr) arr.push(d);
      else bySubscriber.set(d.subscriberId, [d]);
    }

    // The per-subscriber floor anchor (last actual wake). Only queried when some delivery
    // declares a floor — the common one-shot-grant case (min_sleep=0) needs no extra read.
    const needFloor = executable.some((d) => (d.minSleepSec ?? 0) > 0);
    const lastWoken = needFloor
      ? await lastWokenAtForSubscribers([...bySubscriber.keys()])
      : new Map<string, number>();

    const now = Date.now();
    let resumes = 0;

    for (const [subscriberId, group] of bySubscriber) {
      // Oldest→newest: the union is ordered and the headline is the latest fire.
      group.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

      // Floor: the most eager (smallest declared) min_sleep in the group sets the cadence;
      // urgent on any delivery bypasses it (decideWake handles both). Only the POSITIVE
      // floors count — a co-incident floor-less one-shot (min_sleep=0) must NOT nullify a
      // standing watch's floor (`Math.min(…, 0)` → 0 would disable throttling and let the
      // one-shot's tick defeat the standing wake's cost discipline). No positive floor in
      // the group → 0 (no throttle), the genuine one-shot-grant default.
      const positiveFloors = group
        .map((d) => d.minSleepSec)
        .filter((s): s is number => s != null && s > 0);
      const minSleepMs = positiveFloors.length > 0 ? 1000 * Math.min(...positiveFloors) : 0;
      const decision = decideWake({
        lastWokenAt: lastWoken.get(subscriberId) ?? null,
        pending: group.map((d) => ({ at: Date.parse(d.createdAt), payload: d, urgent: d.urgent })),
        now,
        cfg: { minSleepMs, leadingEdge: true },
      });

      if (!decision.wake) {
        // Within the floor — defer the WHOLE group until the floor next allows a wake.
        const deferMs = Math.max(1_000, (decision.dueAt ?? now + DEFER_MS) - now);
        for (const d of group) {
          await markDeliveryDeferred(d.id, deferMs);
          stats.deferred++;
        }
        log(`floor: ${subscriberId} deferred ${group.length} wake(s) ${Math.round(deferMs / 1000)}s (min_sleep)`);
        continue;
      }

      const headline = group[group.length - 1];
      const siblings = group.slice(0, -1);

      // EI-18673058981655804: before spending resume-cap/governor budget or a whole
      // turn on this group, check whether it is PROVABLY redundant — every delivery
      // an inbox-wake for mail the subscriber's own coord:inbox/coord:orient polling
      // already surfaced. Cheap pre-check (no DB read) gates the actual watermark
      // lookup to just the common always-armed-standing-wake case.
      const allInboxWakeNoUrgent = group.every(
        (d) => !d.urgent && d.eventKey.startsWith(COORD_INBOX_WAKE_PREFIX),
      );
      if (allInboxWakeNoUrgent) {
        const lastRead = await lastInboxReadAtBatch([subscriberId]);
        const lastReadAt = lastRead.get(subscriberId) ?? null;
        // EI-18676763837940562: the read-cursor's own blind spot (read-then-reply within
        // the same turn a queued delivery lands after) — a bounded, msg_id-scoped query,
        // only when some delivery in the group actually carries one (the common
        // coord:send-directed-wake shape; see deliveryMsgId's doc).
        const candidateMsgIds = group.map((d) => deliveryMsgId(d.payload)).filter((id): id is string => id != null);
        const repliedMsgIds =
          candidateMsgIds.length > 0
            ? await repliedMsgIdsBatch(subscriberId, candidateMsgIds).catch(() => new Set<string>())
            : undefined;
        if (isInboxWakeGroupRedundant(group, lastReadAt, repliedMsgIds)) {
          await markDeliveryDelivered(headline.id, 'suppressed-redundant', group.length);
          recordSettledDeliveryStats(stats, 'suppressed-redundant');
          if (siblings.length > 0) {
            await markDeliveriesCoalesced(siblings.map((d) => d.id), headline.id);
            stats.coalesced += siblings.length;
          }
          log(
            `wake for ${subscriberId} SUPPRESSED (${group.length} inbox-wake event(s) already ` +
              `covered by its own coord:inbox read at ${lastReadAt})`,
          );
          continue;
        }

        // P-024 clauses B/C (review-system-rework-reduction-2026-09-23): the rule above
        // asks "was it seen?"; this one asks "is there anything to act on?". When every
        // delivery points at a message already durable in the inbox that carries no ask
        // (an FYI with no reply linkage, an ack receipt, a plan event with no state
        // change), settle without a turn. Directed asks, owner directives, required
        // wakes, replies, msg_id-less wakes and unreadable envelopes keep the turn
        // (classifyInboxWakeGroup fails open on all of them).
        if (candidateMsgIds.length === group.length) {
          const envelopes = await resolveInboxWakeEnvelopes(candidateMsgIds);
          const actionability = classifyInboxWakeGroup(group, envelopes);
          if (actionability.nonActionable) {
            await markDeliveryDelivered(headline.id, 'suppressed-redundant', group.length);
            recordSettledDeliveryStats(stats, 'suppressed-redundant');
            if (siblings.length > 0) {
              await markDeliveriesCoalesced(siblings.map((d) => d.id), headline.id);
              stats.coalesced += siblings.length;
            }
            log(
              `wake for ${subscriberId} SUPPRESSED (${group.length} inbox-wake event(s) with nothing to act on: ` +
                `${actionability.classes.join(', ')}; the messages remain in its coord inbox)`,
            );
            continue;
          }
        }
      }

      const needsSpawnLikely = headline.wakeHandle != null;

      // Resume cap: pace mass-unblocks across subscribers (the rest re-admit next tick).
      if (needsSpawnLikely && resumes >= maxResumesPerTick()) {
        for (const d of group) {
          await markDeliveryDeferred(d.id, DEFER_MS);
          stats.deferred++;
        }
        continue;
      }

      // D-007: a wake-resume is an agent spawn — pass it through the fleet governor's
      // admission (role 'await-wake'). One admit per COALESCED wake (N events, one spawn).
      // Fail-open: a governor-store hiccup must never strand a wake.
      if (needsSpawnLikely) {
        try {
          const verdict = await admitSpawn(getOrgPg().sql, { workspaceId: ws, role: 'await-wake' });
          if (!verdict.admitted) {
            for (const d of group) {
              await markDeliveryDeferred(d.id, DEFER_MS);
              stats.deferred++;
            }
            log(`wake for ${subscriberId} deferred by the fleet governor (${JSON.stringify(verdict)})`);
            continue;
          }
        } catch {
          /* fail-open */
        }
      }

      const coalesced = coalesceDeliveries(group);
      const downstreamOutcomeHandler = deps.onResumeTurnExit ?? resumeTurnOutcomeHandler ?? undefined;
      let deliveryRowsSettled = false;
      let earlyResumeExit: { d: DeliveryWork; exit: ResumeTurnExitRaw; context?: ResumeTurnContext } | null = null;
      const onResumeTurnExit = (d: DeliveryWork, exit: ResumeTurnExitRaw, context?: ResumeTurnContext) => {
        // A short-lived child can exit while the pump is still awaiting the
        // delivered write. Buffer it so a re-open cannot be overwritten by
        // that optimistic settlement.
        if (!deliveryRowsSettled) {
          earlyResumeExit = { d, exit, context };
          return;
        }
        void handleSettledResumeTurnExit(group, d, exit, downstreamOutcomeHandler, context);
      };

      const outcome = await executeWake(coalesced, {
        ...deps,
        // Capture every detached resume outcome. Loop wakes keep their
        // registered circuit handler; ordinary event wakes re-open on death.
        onResumeTurnExit,
        // su-cold-auto P-007: the cold-auto master gate (default ON, owner-enabled) — only
        // read when a wake carries a cold loop marker. An explicit dep (tests) still wins.
        coldAutoEnabled: deps.coldAutoEnabled ?? defaultColdAutoEnabled,
        // deterministic-context-carry P-021: the verdict-gated cold-by-default resolver
        // (kill-switch flag + drill-proven class + no active interactive exchange) —
        // only read on a no-carry loop marker behind the master gate. Resolved HERE
        // (like coldAutoEnabled) so wake-executor stays flag-system-free.
        classDefaultCold: deps.classDefaultCold ?? defaultClassDefaultCold,
        // EI-21572316039386007: human-presence guard for BOTH cold routes (D-005). The
        // opt-in route bypasses classDefaultCold entirely, so this is the only thing
        // standing between a cold-armed loop and resetting a session someone is talking to.
        activeInteractiveExchange: deps.activeInteractiveExchange ?? defaultActiveInteractiveExchange,
      });

      if (outcome.kind === 'delivered') {
        if (
          outcome.channel === 'resume' ||
          outcome.channel === 'resume-headless' ||
          outcome.channel === 'cold-fresh-successor' ||
          outcome.channel === 'resume-rehome-backend' ||
          outcome.channel === 'plan-run-resume'
        ) {
          resumes++;
        }
        await markDeliveryDelivered(headline.id, outcome.channel, group.length);
        recordSettledDeliveryStats(stats, outcome.channel);
        if (siblings.length > 0) {
          await markDeliveriesCoalesced(siblings.map((d) => d.id), headline.id);
          stats.coalesced += siblings.length;
        }
        deliveryRowsSettled = true;
        if (earlyResumeExit) {
          const observed = earlyResumeExit as { d: DeliveryWork; exit: ResumeTurnExitRaw; context?: ResumeTurnContext };
          void handleSettledResumeTurnExit(group, observed.d, observed.exit, downstreamOutcomeHandler, observed.context);
        }
        log(`wake #${headline.id} delivered → ${subscriberId} via ${outcome.channel} (${group.length} event(s): ${group.map((d) => d.eventKey).join(', ')})`);
        continue;
      }
      if (outcome.kind === 'park') {
        // A live-but-uninjectable subscriber may remain parked forever (for example,
        // a busy psu host that never proves a turn start). Park retries consume the
        // same delivery-attempt budget as errors, so honor the ceiling here too and
        // use the contract's inbox fallback instead of re-parking without end.
        if (headline.attempts >= MAX_ATTEMPTS) {
          const degraded = await degradeToInboxOrDrop(
            coalesced,
            `delivery remained parked and exhausted ${MAX_ATTEMPTS} attempts: ${outcome.reason}`,
            deps.sendCoordMessage ?? sendMessage,
          );
          if (degraded.kind === 'delivered') {
            await markDeliveryDelivered(headline.id, degraded.channel, group.length);
            recordSettledDeliveryStats(stats, degraded.channel);
            if (siblings.length > 0) {
              await markDeliveriesCoalesced(siblings.map((d) => d.id), headline.id);
              stats.coalesced += siblings.length;
            }
            log(
              `wake #${headline.id} exhausted ${MAX_ATTEMPTS} parked attempts → degraded to inbox for ${subscriberId} ` +
                `(last park: ${outcome.reason})`,
            );
              continue;
            }
          const dropReason = degraded.kind === 'error' ? degraded.error : degraded.reason;
          await markDeliveryDropped(headline.id, dropReason);
          stats.dropped++;
          for (const d of siblings) {
            await markDeliveryDropped(d.id, `subscriber park exhausted (coalesced with #${headline.id})`);
            stats.dropped++;
          }
          log(
            `wake #${headline.id} DROPPED after ${MAX_ATTEMPTS} parked attempts → ${subscriberId}: ${dropReason}`,
          );
          continue;
        }
        // One-time inbox nudge on the first park: the awake-but-uninjectable agent sees it
        // mid-turn (PostToolUse hook) or on its next turn; the parked row converts to a
        // resume when its process exits. Siblings re-coalesce with the headline next tick.
        if (headline.attempts <= 1) {
          try {
            await sendMessage(emitterIdentity('await-event', headline.workspaceId), {
              to: [subscriberId],
              summary: `${wakeSummaryHeadline(headline.eventKey, headline.payload)} — wake parked (${outcome.reason})`,
              body: `${headline.summary ?? ''}\nIf you act on this now, ack it with events:cancel { delivery_id: ${headline.id} } while it is still pending/parked so you are not also resumed for it later. If cancel reports already_settled:true/status:'delivered', the host handoff already crossed the recall boundary and a queued wake may still arrive — reconcile that wake once as stale rather than repeating the action. If events:cancel is not in your loaded tool set, reach it via tools:find("events:cancel") or tools:invoke { name: "events:cancel", args: { delivery_id: ${headline.id} } }.`.trim(),
              category: 'event',
              extra: { auto: true, event_key: headline.eventKey, wake_delivery_id: headline.id },
            });
          } catch {
            /* nudge is best-effort; the parked row is the durable truth */
          }
        }
        await markDeliveryParked(headline.id, outcome.reason, PARK_RECHECK_MS);
        stats.parked++;
        for (const d of siblings) await markDeliveryDeferred(d.id, PARK_RECHECK_MS);
        continue;
      }
      if (outcome.kind === 'drop') {
        await markDeliveryDropped(headline.id, outcome.reason);
        stats.dropped++;
        // The waiter is dead → its other coalesced wakes are equally undeliverable. Drop them
        // visibly rather than re-pumping a dead subscriber forever.
        for (const d of siblings) {
          await markDeliveryDropped(d.id, `subscriber dead (coalesced with #${headline.id})`);
          stats.dropped++;
        }
        log(`wake #${headline.id} DROPPED (dead waiter) → ${subscriberId}: ${outcome.reason} (${headline.eventKey})`);
        continue;
      }
      // EI-16559: about to exhaust retries — before letting the delivery finalize as
      // silently 'dead', try the SAME inbox fallback the 'drop' outcome already gets
      // (degradeToInboxOrDrop, P-001). Pre-existing gap: a delivery that kept ERRORing
      // (a transient channel/spawn failure, not a definitively-resolved dead waiter)
      // burned through MAX_ATTEMPTS and went 'dead' with ZERO trace ever reaching the
      // subscriber — the events:await registration contract's "you always have an
      // inbox to fall back to" was never honored for THIS failure class, only for the
      // 'drop' class. `headline.attempts` already reflects this claim (incremented by
      // claimDueDeliveries before executeWake ran), so `>= MAX_ATTEMPTS` here means
      // markDeliveryFailed below would otherwise mark it dead.
      if (headline.attempts >= MAX_ATTEMPTS) {
        const degraded = await degradeToInboxOrDrop(
          coalesced,
          `delivery kept failing and exhausted ${MAX_ATTEMPTS} attempts: ${outcome.error}`,
          deps.sendCoordMessage ?? sendMessage,
        );
        if (degraded.kind === 'delivered') {
          await markDeliveryDelivered(headline.id, degraded.channel, group.length);
          recordSettledDeliveryStats(stats, degraded.channel);
          if (siblings.length > 0) {
            await markDeliveriesCoalesced(siblings.map((d) => d.id), headline.id);
            stats.coalesced += siblings.length;
          }
          log(
            `wake #${headline.id} exhausted ${MAX_ATTEMPTS} attempts → degraded to inbox for ${subscriberId} ` +
              `(last error: ${outcome.error})`,
          );
          continue;
        }
        // The inbox write itself failed too — genuinely no resolvable owner; fall
        // through to the normal dead-finalize path below (folds `degraded.reason` in).
      }
      const verdict = await markDeliveryFailed({
        id: headline.id,
        error: outcome.error,
        attempts: headline.attempts,
        maxAttempts: MAX_ATTEMPTS,
        backoffMs: backoffMs(headline.attempts),
      });
      stats.failed++;
      for (const d of siblings) await markDeliveryDeferred(d.id, DEFER_MS);
      if (verdict === 'dead') log(`wake #${headline.id} DEAD after ${headline.attempts} attempts → ${subscriberId}: ${outcome.error}`);
    }
    return stats;
  } finally {
    pumpsInFlight.delete(ws);
    const rerunDeps = pumpRerunRequested.get(ws);
    if (rerunDeps) {
      pumpRerunRequested.delete(ws);
      setImmediate(() => {
        void pumpWakeDeliveries(ws, rerunDeps).catch((e) =>
          log(`trailing wake-pump rerun failed (ws=${ws}): ${e instanceof Error ? e.message : e}`),
        );
      });
    }
  }
}

// ── source reconcilers ────────────────────────────────────────────────────────

/** A source-side reconciliation hook run each sweep tick (D-004's durable
 *  backstop for missed NOTIFYs): e.g. the lock-grant bridge re-derives
 *  `lock:grant:<ticket>` fires from waiter-table truth. Must be cheap and
 *  self-catching; registered once at import (Set-deduped by identity). */
const reconcilers = new Set<(workspaceId: string) => Promise<void>>();

export function registerAwaitReconciler(fn: (workspaceId: string) => Promise<void>): void {
  reconcilers.add(fn);
}

/**
 * The resume-turn-exit observer (loop-wake-rate-limit-robustness P0a/P0b). A
 * `resume-headless` wake spawns a DETACHED turn whose later 429-death is otherwise
 * invisible (the delivery is 'delivered' on spawn). When set, the pump passes this to
 * `executeWake`, which fires it once the detached turn exits — the seam the loop
 * turn-outcome handler (harness/routines/loop-turn-outcome.ts) uses to feed the autoloop
 * circuit on a dead loop turn. A REGISTRATION seam (not a static import) so events/await
 * never imports harness/routines (no cycle). Fire-and-forget + best-effort: a missed exit
 * degrades to the reconcile stuck-park backstop (≥30min), exactly as today.
 */
let resumeTurnOutcomeHandler: ((d: DeliveryWork, exit: ResumeTurnExitRaw, context?: ResumeTurnContext) => void) | null = null;

export function registerResumeTurnOutcomeHandler(
  fn: (d: DeliveryWork, exit: ResumeTurnExitRaw, context?: ResumeTurnContext) => void,
): void {
  resumeTurnOutcomeHandler = fn;
}

/**
 * A detached resume is optimistically marked delivered before its child exits. If the
 * bounded retry ladder later exhausts, the row is terminally dead without ever reaching
 * the await owner. Keep that loss visible in the owner's durable coord inbox instead of
 * making `events:status` the only place where the failure can be found.
 */
async function notifyDeadResumeDeliveries(dead: DeliveryWork[], error: string): Promise<void> {
  if (dead.length === 0) return;

  const first = dead[0];
  const details = dead
    .map(
      (d) =>
        `delivery #${d.id} · event '${d.eventKey}' · attempts ${MAX_ATTEMPTS} · ` +
        `last error '${error}'`,
    )
    .join('\n');
  try {
    await sendMessage(emitterIdentity('await-event', first.workspaceId), {
      to: [first.subscriberId],
      summary:
        dead.length === 1
          ? `Event wake delivery #${first.id} for '${first.eventKey}' was abandoned after ${MAX_ATTEMPTS} resume-turn deaths.`
          : `${dead.length} event wake deliveries were abandoned after ${MAX_ATTEMPTS} resume-turn deaths.`,
      body:
        `An awaited event fired, but its detached resume delivery reached terminal status 'dead' ` +
        `after the retry budget was exhausted. No successful resumed turn completed.\n\n` +
        `${details}\n\n` +
        `Inspect events:status for the delivery rows and the await owner/session before re-registering ` +
        `the detector or taking a recovery action.`,
      category: 'event',
      extra: {
        auto: true,
        event_key: dead.length === 1 ? first.eventKey : undefined,
        event_keys: dead.map((d) => d.eventKey),
        wake_delivery_id: dead.length === 1 ? first.id : undefined,
        wake_delivery_ids: dead.map((d) => d.id),
        terminal_status: 'dead',
        attempts: MAX_ATTEMPTS,
        last_error: error,
      },
    });
  } catch (e) {
    // The delivery row and its terminal status remain authoritative when the
    // secondary inbox alarm is unavailable; never fail the outcome observer.
    log(
      `terminal dead resume delivery alarm failed for ${first.subscriberId}: ` +
        `${e instanceof Error ? e.message : e}`,
    );
  }
}

/** Surface a transcript-confirmed poisoned resume to the owner and its fleet. */
async function notifyPoisonedResumeSession(
  group: DeliveryWork[],
  context: ResumeTurnContext,
  error: string,
): Promise<void> {
  const first = group[0];
  if (!first) return;
  let to = [first.subscriberId];
  try {
    const membership = (await fetchPresenceFleet([first.subscriberId])).get(first.subscriberId);
    if (membership?.fleetSlug) to = [`@fleet:${membership.fleetSlug}`, first.subscriberId];
  } catch {
    // The owner inbox remains the fallback if the fleet membership read fails.
  }
  try {
    await sendMessage(emitterIdentity('await-event', first.workspaceId), {
      to,
      summary: `Claude session #${context.advSessionId} quarantined after repeated unavailable tool references`,
      body:
        `The Claude transcript recorded repeated assistant turns rejected because a Papercusp ` +
        `tool_reference was absent from the resumed tool list. Wake retries for this incarnation ` +
        `have stopped; the existing session-end lease cleanup was scheduled to release its work-item claims.\n\n` +
        `Event keys: ${group.map((delivery) => delivery.eventKey).join(', ')}\n` +
        `Last provider evidence: ${error}`,
      category: 'event',
      extra: {
        auto: true,
        event_keys: group.map((delivery) => delivery.eventKey),
        wake_delivery_ids: group.map((delivery) => delivery.id),
        adv_session_id: context.advSessionId,
        terminal_status: 'poisoned',
        poison_reason: context.poisonReason,
      },
    });
  } catch (e) {
    log(`poisoned resume notification failed for ${first.subscriberId}: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Settle a detached resume's asynchronous outcome after the pump has written
 * its optimistic delivered/coalesced rows. Loop wakes retain their specialized
 * circuit/re-arm handler; ordinary event wakes reuse the bounded delivery retry
 * ladder instead of silently dying until a later timeout happens to wake them.
 */
async function handleSettledResumeTurnExit(
  group: DeliveryWork[],
  observed: DeliveryWork,
  exit: ResumeTurnExitRaw,
  downstream?: (d: DeliveryWork, exit: ResumeTurnExitRaw) => void,
  context?: ResumeTurnContext,
): Promise<void> {
  try {
    downstream?.(observed, exit);
  } catch (e) {
    log(`resume-turn outcome observer failed: ${e instanceof Error ? e.message : e}`);
  }

  const outcome = classifyResumeTurnExit(exit);
  if (outcome.ok) return;

  if (context?.poisoned) {
    const reason = context.poisonReason ?? 'Claude session quarantined after repeated unavailable Papercusp tool references';
    await Promise.all(group.map((delivery) => markDeliveryDropped(delivery.id, reason)));
    await notifyPoisonedResumeSession(group, context, outcome.error.message);
    log(`resume turn for ${observed.subscriberId} quarantined (${reason})`);
    return;
  }

  // Reopening loop deliveries would double-fire them: their registered handler
  // feeds the autoloop circuit and re-arms with retry-after semantics. Timeout
  // deliveries are terminal fallback wakes: the await was already consumed by
  // the sweeper, so retrying after a detached turn death would inject the same
  // terminal delivery again (EI-21370407494826605).
  const retryable = group.filter((d) => !d.source?.startsWith('loop:') && !payloadIsTimeout(d.payload));
  if (retryable.length === 0) return;

  const error = `resume-turn-death:${outcome.error.class}`;
  const results = await Promise.all(
    retryable.map((d) =>
      reopenDeliveredAfterResumeDeath({
        id: d.id,
        error,
        maxAttempts: MAX_ATTEMPTS,
        backoffMs: backoffMs(d.attempts),
      }),
    ),
  );
  const reopened = results.filter((r) => r === 'retrying').length;
  const deadDeliveries = retryable.filter((_, index) => results[index] === 'dead');
  const dead = deadDeliveries.length;
  await notifyDeadResumeDeliveries(deadDeliveries, error);
  if (reopened || dead) {
    log(
      `resume turn DIED (${outcome.error.class}) for ${observed.subscriberId}: ` +
        `${reopened} delivery row(s) reopened, ${dead} exhausted`,
    );
  }
}

// ── the sweeper ───────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 30_000;

type Globals = typeof globalThis & { __papercuspAwaitSweeperStarted?: boolean };

/**
 * Background sweeper (locks-janitor pattern: lazy, unref'd, restart-safe —
 * all state is PG): recover stuck 'delivering' rows, fire timed-out awaits
 * (timeout_behavior 'wake' → a TIMEOUT wake delivery; 'expire' → visible
 * lapse), then pump anything due (incl. parked rows whose process died).
 *
 * A background reader has no request to scope it, so each tick sweeps every
 * workspace `backgroundWorkspaceIds()` names (per-window-workspace-context
 * P-020) — under the shared-operator model that is EVERY registered
 * workspace, so an await registered in a non-global workspace still times
 * out / resumes. Each sweep runs inside that workspace's ALS scope so nested
 * `activeWorkspaceId()` reads (reconcilers, wake delivery) resolve it.
 */
export function startAwaitSweeper(): void {
  const g = globalThis as Globals;
  if (g.__papercuspAwaitSweeperStarted) return;
  g.__papercuspAwaitSweeperStarted = true;
  managedSetInterval('await-event-sweeper', SWEEP_INTERVAL_MS, () => {
    void sweepAllWorkspaces();
  }, { category: 'global-sweep' });
}

/** One tick of the sweeper: sweepOnce per background workspace (P-020). */
export async function sweepAllWorkspaces(): Promise<void> {
  for (const ws of backgroundWorkspaceIds()) {
    // Bounded retry on a transient CONNECT_TIMEOUT (WI-2776). The sweeper is documented
    // restart-safe (all state is PG, every op state-guarded), so re-running it is
    // equivalent to the next tick — and a CONNECT_TIMEOUT fires in the connect phase, so
    // little-to-no work happened before the throw. Absorbs the self-healing pooler blip;
    // a sustained outage still exhausts retries and logs `sweep failed` below.
    await withPgRetry(() => runWithWorkspace(ws, () => sweepOnce(ws)), { label: `await-sweep:${ws}` }).catch(
      (e: unknown) => log(`sweep failed (ws=${ws}): ${e instanceof Error ? e.message : e}`),
    );
  }
}

export async function sweepOnce(workspaceId?: string): Promise<void> {
  const ws = workspaceId ?? activeWorkspaceId();

  // Source reconcilers first — they may fire awaits this very sweep delivers.
  for (const fn of reconcilers) {
    try {
      await fn(ws);
    } catch (e) {
      log(`reconciler failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // A producer can die after consuming a one-shot await and before queuing its
  // delivery. The fired await row is the durable intent; recover it before the
  // pump reads due deliveries. The store serializes this with a live producer.
  const missingWakes = await reconcileFiredWakeDeliveries();
  if (missingWakes > 0) log(`recovered ${missingWakes} fired awaits without wake deliveries`);

  const superseded = await compactSupersededLoopDeliveries();
  if (superseded > 0) log(`compacted ${superseded} superseded loop wake deliveries`);

  const recovered = await recoverStuckDeliveries({ olderThanMs: STUCK_DELIVERING_MS });
  if (recovered > 0) log(`recovered ${recovered} stuck deliveries`);

  // Verified waits diagnose the producer before deciding whether a deadline
  // should spend a wake. A progressing producer simply extends this same
  // one-shot subscription; push delivery remains primary throughout.
  const dueVerified = await claimDueVerifiedAwaits();
  const verifiedWakes: AwaitRow[] = [];
  for (const awaited of dueVerified) {
    const certificate = awaited.producerHealthCertificate;
    if (!certificate) continue;
    try {
      if (certificate.progressLease) {
        const result = await observeProgressLease(certificate);
        const nextMissCount =
          result.classification === 'progressing' ? 0 : certificate.progressLease.missCount + 1;
        if (result.classification === 'progressing') {
          const nextCertificate = advanceProgressLeaseCertificate(certificate, result);
          await settleVerifiedAwaitTimeout({ id: awaited.id, result, nextCertificate });
          continue;
        }
        if (nextMissCount < certificate.progressLease.remedyAfterMisses) {
          const wake = nextMissCount === 1 ? await wakeProgressLeaseOwner(certificate, result) : undefined;
          const nextCertificate = advanceProgressLeaseCertificate(certificate, result, { wake });
          await settleVerifiedAwaitTimeout({ id: awaited.id, result, nextCertificate });
          continue;
        }
        const remedy = await executeProgressLeaseRemedy(certificate);
        const finalCertificate = advanceProgressLeaseCertificate(certificate, result, { remedy });
        const fired = await settleVerifiedAwaitTimeout({ id: awaited.id, result, finalCertificate });
        if (fired) verifiedWakes.push(fired);
        continue;
      }
      const observation =
        certificate.producer.kind === 'green-checkpoint'
          ? await observeCheckpointProducer(certificate)
          : (() => {
              throw new Error(`no producer verifier registered for ${certificate.producer.kind}`);
            })();
      const result = classifyVerifiedWaitTimeout(certificate, observation);
      const nextCertificate =
        result.classification === 'progressing'
          ? {
              ...certificate,
              issuedAtMs: observation.checkedAtMs,
              lastProgressAtMs: observation.lastProgressAtMs,
              lastFireAtMs: observation.lastFireAtMs,
              verificationDeadlineMs: observation.checkedAtMs + certificate.expectedCadenceMs,
            }
          : undefined;
      const fired = await settleVerifiedAwaitTimeout({ id: awaited.id, result, nextCertificate });
      if (fired) verifiedWakes.push(fired);
    } catch (e) {
      // A verifier failure is itself diagnosed evidence, never permission to
      // silently drop the fallback. Classify it as stalled and wake ownership.
      const checkedAtMs = Math.max(Date.now(), certificate.verificationDeadlineMs);
      const result = {
        classification: 'stalled' as const,
        nextAction: 'wake-owner-or-takeover' as const,
        producer: certificate.producer,
        owner: certificate.owner,
        checkedAtMs,
        verificationDeadlineMs: certificate.verificationDeadlineMs,
        lastProgressAtMs: certificate.lastProgressAtMs,
        lastFireAtMs: certificate.lastFireAtMs,
        evidence: { verifierError: e instanceof Error ? e.message : String(e) },
      };
      const fired = await settleVerifiedAwaitTimeout({ id: awaited.id, result });
      if (fired) verifiedWakes.push(fired);
    }
  }
  if (verifiedWakes.length > 0) {
    await insertDeliveries({
      awaits: verifiedWakes,
      payload: {
        timeout: true,
        verified: true,
        results: verifiedWakes.map((awaited) => awaited.timeoutVerification),
        guidance: TIMEOUT_WAKE_GUIDANCE,
      },
      summary: 'Verified wait fallback classified the producer; inspect results before re-awaiting or takeover.',
    });
  }

  const timedOut = await fireTimedOutAwaits();
  if (timedOut.length > 0) {
    const wakes: AwaitRow[] = timedOut.filter((a) => a.policy === 'wake');
    if (wakes.length > 0) {
      // declared-gate-recovery-contract-2026-09-21: a timed-out wait on an
      // ANNOUNCED key gets the gate's deterministic classification + exact next
      // verb, and the idempotent escalation runs once per generation. Fail-open:
      // any key the hook cannot classify keeps the generic timeout wake below.
      let recovery = new Map<number, Record<string, unknown>>();
      try {
        const { annotateTimedOutAnnouncedAwaits } = await import('./declared-gate-recovery-runtime');
        recovery = await annotateTimedOutAnnouncedAwaits(wakes);
      } catch (e) {
        log(`declared-gate recovery skipped: ${e instanceof Error ? e.message : e}`);
      }
      const generic = wakes.filter((a) => !recovery.has(a.id));
      if (generic.length > 0) {
        await insertDeliveries({
          awaits: generic,
          // P-004: the non-event is a prompt to RECONCILE, not to give up — carry the
          // re-orient/re-arm guidance so the woken agent reconciles instead of re-hanging.
          payload: { timeout: true, guidance: TIMEOUT_WAKE_GUIDANCE },
          summary: TIMEOUT_WAKE_SUMMARY,
        });
      }
      for (const awaited of wakes) {
        const declaredGateRecovery = recovery.get(awaited.id);
        if (!declaredGateRecovery) continue;
        await insertDeliveries({
          awaits: [awaited],
          payload: { timeout: true, guidance: TIMEOUT_WAKE_GUIDANCE, declaredGateRecovery },
          summary: `${TIMEOUT_WAKE_SUMMARY} Announced gate classified ${String(declaredGateRecovery.classification ?? declaredGateRecovery.inactive ?? 'unknown')}; follow declaredGateRecovery.next_verb.`,
        });
      }
    }
    // P-003 detector: group this sweep's timeout-fires by key family and accumulate
    // across sweeps — a family that keeps timing out (with ~no event ever) is a
    // systematic dead-drop (mistyped key / dead or renamed emitter) the fallback
    // would otherwise silently mask. Log the per-sweep breakdown; warn loudly the
    // first time a family's lifetime total crosses the threshold.
    const families = summarizeTimeoutFires(timedOut);
    log(
      `fired ${timedOut.length} timed-out awaits — by key family: ` +
        families.map((f) => `${f.family}×${f.count}`).join(', '),
    );
    for (const c of recordTimeoutFires(families)) {
      log(
        `⚠ DEAD-DROP suspected: key family "${c.family}" has timed out ${c.total}× (process lifetime) — ` +
          'a mistyped key, a dead/renamed emitter, or an event that never fires. Investigate the emit side.',
      );
    }
  }

  const lapsed = await expireLapsedAwaits();
  if (lapsed > 0) log(`expired ${lapsed} lapsed awaits (timeout_behavior=expire)`);

  // Recover fired leaves left by a dead producer and settle due roots in the
  // same atomic path used by live emits. The pump below delivers queued wakes.
  const composed = await reconcileComposedRoots();
  if (composed.deliveries > 0) log(`composed: queued ${composed.deliveries} recovered or timed-out root wake(s)`);

  await pumpWakeDeliveries(ws);
}
