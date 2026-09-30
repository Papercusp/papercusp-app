/**
 * await-event store — PG access for `event_awaits` + `event_wake_deliveries`
 * (migration 163; await-event-primitive-2026-06-05 P-001/P-002, D-009).
 *
 * Access mirrors attention/triage-store.ts: plain `getOrgPg().sql` with an
 * explicit `workspace_id` filter (the org handle connects as the table owner,
 * so RLS is enforced for the runtime app role and bypassed here, like every
 * other operator-state table).
 *
 * The one-shot guarantee (D-002) is the atomic
 *   `UPDATE … SET fired_at = now() WHERE fired_at IS NULL … RETURNING`
 * in `fireAwaitsForKey` — two concurrent emits of the same key can never
 * double-fire one await. Delivery is at-least-once on top (D-004): a claimed
 * row that the host crashes on is re-claimed by the sweeper's stuck-delivering
 * recovery; the wake itself is idempotent (re-invoking an agent that just woke
 * is a no-op turn).
 */

import { getOrgPg } from '@papercusp/db-org';
import { boundedOrgTxn } from '../../pg-bounded-txn';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { normalizeEventKey } from './announce-key';
import { isPattern, keyMatchesPattern, payloadMatchesFilter, patternLiteralPrefix } from './pattern';
import { WAKE_TURN_CHANNELS } from './types';
import { withEffectiveDeadlines } from './effective-deadline';
import { observeCheckpointProducer } from './checkpoint-verified-wait';
import { reconcileEventExternalBlockers } from '../../work-items';
import { reconcileEventDurableParks } from '../../work-items-durable-park-audit';
import type {
  AwaitPolicy,
  AwaitRow,
  LifecycleBinding,
  DeliveryStatus,
  DeliveryRow,
  DeliveryWork,
  KeyFireRow,
  TimeoutBehavior,
  WakeChannel,
  WakeHandle,
} from './types';
import { EXPLICIT_PARK_NOTE_MARKER, isExplicitParkNote } from './types';
import type { ProducerHealthCertificate, ProducerHealthObservation, VerifiedWaitTimeoutResult } from './verified-wait';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Events are coordination-plane state: like coord_event_log / coord_links /
 * coord_entity_subscriptions, ALL rows live in the one coord workspace,
 * regardless of the caller's scoping. The live bug this fixes: an unscoped SU
 * shell's identity carries workspaceId '*', so its awaits registered under
 * '*' while a system source (work-items settle) emitted under the ACTIVE
 * workspace — the key never matched and the wake never fired. Event keys
 * embed globally-unique ids (ticket/run/item), so cross-workspace collision
 * is a non-issue; one namespace is the trap-free choice.
 *
 * WI-3575: this module therefore takes NO `workspaceId` input anywhere —
 * every exported function below writes/reads the single coord workspace,
 * full stop. An earlier revision accepted a `workspaceId?` field on most of
 * these functions and silently discarded it (self-consistent today since
 * every row landed under the same constant regardless, but a caller passing
 * a specific workspaceId reasonably believed it was scoping the row, which it
 * never was — a latent trap for a future multi-workspace deployment, where
 * awaits/wakes would cross workspace boundaries silently). The dead
 * parameter was removed everywhere rather than "honored", because honoring
 * it would resurrect the exact cross-workspace mismatch this design already
 * fixed once (see above). If events:await ever needs genuine per-workspace
 * isolation, it needs a new design, not a parameter that was never wired.
 */
const eventsWs = (): string => DEFAULT_COORD_WORKSPACE;

/** Note prefix owned by the leader-managed fleet:bench surface. Bench rows are
 * intentionally independent from an agent's ordinary exact-key wait. */
export const FLEET_BENCH_NOTE_PREFIX = '[fleet:bench] ';

// events:await performs these two best-effort store calls before it can create
// the durable await row. Keep their pool acquisition and SQL execution inside a
// short bounded transaction so a saturated admin pool cannot consume the whole
// interactive tool deadline before registration starts.
const AWAIT_PRE_REGISTRATION_TXN_OPTIONS = {
  acquireTimeoutMs: 5_000,
  statementTimeoutMs: 5_000,
  lockTimeoutMs: 5_000,
} as const;

/** jsonb arrives parsed OR as text depending on the postgres-js client config
 *  (the repo's known sql.json quirk) — tolerate both. */
function parseJsonb<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

function mapAwait(r: any): AwaitRow {
  return {
    id: Number(r.id),
    workspaceId: r.workspace_id,
    subscriberId: r.subscriber_id,
    eventKey: r.event_key,
    policy: r.policy,
    note: r.note ?? null,
    explicitPark: isExplicitParkNote(r.note),
    wakeHandle: parseJsonb<WakeHandle>(r.wake_handle),
    timeoutBehavior: r.timeout_behavior,
    expiresTs: r.expires_ts ? new Date(r.expires_ts).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    firedAt: r.fired_at ? new Date(r.fired_at).toISOString() : null,
    firedReason: r.fired_reason ?? null,
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
    cancelReason: r.cancel_reason ?? null,
    once: r.once ?? true,
    minSleepSec: r.min_sleep_sec != null ? Number(r.min_sleep_sec) : null,
    urgency: r.urgency ?? false,
    payloadFilter: parseJsonb(r.payload_filter),
    boundTo: parseJsonb<LifecycleBinding>(r.bound_to),
    scopeKind: r.scope_kind ?? null,
    scopeRef: r.scope_ref ?? null,
    causalGeneration: r.causal_generation != null ? Number(r.causal_generation) : null,
    logicalGateKey: r.logical_gate_key ?? null,
    expectedCondition: parseJsonb(r.expected_condition),
    supersededAt: r.superseded_at ? new Date(r.superseded_at).toISOString() : null,
    firedBy: r.fired_by ?? null,
    firedPayload: parseJsonb(r.fired_payload),
    // composable-event-awaits-2026-07-11 (migration 572). A `SELECT *` on a DB predating the
    // migration returns these as undefined ⇒ null — so mapAwait is safe against the older
    // hand-rolled test DDLs, and the composed fire path (engine.ts) is inert until a row
    // actually carries a node_id.
    nodeId: r.node_id != null ? Number(r.node_id) : null,
    rootId: r.root_id != null ? Number(r.root_id) : null,
    memberFiredAt: r.member_fired_at ? new Date(r.member_fired_at).toISOString() : null,
    memberPayload: parseJsonb(r.member_payload),
    producerHealthCertificate: parseJsonb<ProducerHealthCertificate>(r.producer_health),
    timeoutVerification: parseJsonb<VerifiedWaitTimeoutResult>(r.timeout_verification),
    verificationClaimedAt: r.verification_claimed_at ? new Date(r.verification_claimed_at).toISOString() : null,
  };
}

export type AwaitGenerationState = 'undeclared' | 'declared' | 'fired' | 'expired' | 'cancelled' | 'superseded';

/**
 * Raised when an events:await caller pins a declaration generation that is no
 * longer the current, unfired declaration for the key. The handler turns this
 * into a structured resync response; keeping the check in the store makes the
 * status-read → await-registration handoff atomic with announcement writers.
 */
export class AwaitGenerationMismatchError extends Error {
  readonly code = 'await_generation_mismatch' as const;

  constructor(
    readonly eventKey: string,
    readonly expectedGeneration: number,
    readonly currentGeneration: number | null,
    readonly currentState: AwaitGenerationState,
    readonly firedAt: string | null = null,
  ) {
    super(
      `events:await generation pin ${expectedGeneration} for "${eventKey}" does not match ` +
        `the current ${currentState} declaration generation ${currentGeneration ?? 'none'}`,
    );
    this.name = 'AwaitGenerationMismatchError';
  }
}

function mapDelivery(r: any): DeliveryRow {
  return {
    id: Number(r.id),
    workspaceId: r.workspace_id,
    awaitId: Number(r.await_id),
    subscriberId: r.subscriber_id,
    eventKey: r.event_key,
    payload: parseJsonb(r.payload),
    summary: r.summary ?? null,
    status: r.status,
    channel: (r.channel as WakeChannel | null) ?? null,
    attempts: Number(r.attempts),
    lastError: r.last_error ?? null,
    nextAttemptAt: new Date(r.next_attempt_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
    deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
    urgent: r.urgent ?? false,
    minSleepSec: r.min_sleep_sec != null ? Number(r.min_sleep_sec) : null,
    coalescedCount: r.coalesced_count != null ? Number(r.coalesced_count) : 1,
    source: r.source ?? null,
  };
}

function mapWork(r: any): DeliveryWork {
  return {
    ...mapDelivery(r),
    wakeHandle: parseJsonb<WakeHandle>(r.wake_handle),
    note: r.await_note ?? null,
  };
}

export async function registerAwait(input: {
  subscriberId: string;
  eventKey: string;
  policy?: AwaitPolicy;
  note?: string | null;
  wakeHandle?: WakeHandle | null;
  timeoutBehavior?: TimeoutBehavior;
  /** Seconds until the await lapses; null = no deadline. */
  timeoutSec?: number | null;
  /** Cardinality (unify-watch-primitive): false = standing watch. Default true (one-shot). */
  once?: boolean;
  /** Per-subscriber wake floor in seconds for this watch (null/0 = no floor). */
  minSleepSec?: number | null;
  /** This watch's wakes always bypass the floor (a human-message / escalation watch). */
  urgency?: boolean;
  /** EI-8998: optional predicate (a @papercusp/rules DataCondition) tested against the
   *  emitted payload at fire time, IN ADDITION to the key/pattern match. null/undefined =
   *  no payload predicate (today's fast-path behavior, unchanged). */
  payloadFilter?: unknown | null;
  /** Optional verified-wait producer certificate. Legacy awaits omit it. */
  producerHealthCertificate?: ProducerHealthCertificate | null;
  /** Pin this await to the exact current announced declaration generation. */
  expectedGeneration?: number | null;
  /** Lifecycle owner for auto/suggested-armed rows. Manual awaits omit it. */
  boundTo?: LifecycleBinding | null;
  /** Retire this owner's pending rows atomically with the replacement insert. */
  supersedePending?: {
    /** Retire matching rows across every event key for this subscriber. Callers
     *  using this mode must identify one coordination surface by note prefix. */
    allEventKeys?: boolean;
    /** Preserve rows owned by a different coordination surface. */
    excludeNotePrefix?: string;
    /** Restrict cancellation to one coordination surface (used by re-stage). */
    includeNotePrefix?: string;
  };
}): Promise<AwaitRow> {
  const ws = eventsWs();
  // Safe-by-default (await-timeout-fallback-defaults-2026-07-03): a caller that sets a
  // deadline but names no behavior WAKEs at it (auto-woken to re-orient) rather than
  // lapsing silently. Every real caller (events:await / watch:create / the events sugar /
  // locks:acquire) passes 'wake' explicitly, so this changes no behavior today — it only
  // guards a future caller that forgets. The always-armed inbox-wake path is separate
  // (upsertInboxWakeAwait hardcodes 'expire' + no deadline), so it is unaffected.
  const timeoutBehavior: TimeoutBehavior = input.timeoutBehavior ?? 'wake';
  const expiresTs =
    // ISO text, not a raw Date — the live org postgres-js client throws on
    // Date binding (the repo's known quirk); PG casts text→timestamptz.
    input.timeoutSec != null ? new Date(Date.now() + input.timeoutSec * 1000).toISOString() : null;
  const supersedePending = input.supersedePending;
  const assertGenerationPin = async (tx: any): Promise<void> => {
    if (input.expectedGeneration == null) return;

    // registerAnnouncement and stampAnnouncementsFired use this same key lock.
    // Holding it through the declaration read and await insert closes the
    // status → await replacement race without adding a generation column to
    // ordinary waiter rows.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'event-announce:' + input.eventKey}, 0))`;
    const declarations = await tx`
      SELECT causal_generation, fired_at, fired_reason, cancelled_at, superseded_at
        FROM harness_shared.event_awaits
       WHERE workspace_id = ${ws}
         AND event_key = ${input.eventKey}
         AND policy = 'announce'
       ORDER BY causal_generation DESC NULLS LAST, created_at DESC
       LIMIT 1
    `;
    const declaration = declarations[0] as any;
    const currentGeneration = declaration?.causal_generation != null ? Number(declaration.causal_generation) : null;
    const currentState: AwaitGenerationState = !declaration
      ? 'undeclared'
      : declaration.fired_at
        ? declaration.fired_reason === 'expired'
          ? 'expired'
          : 'fired'
        : declaration.cancelled_at
          ? 'cancelled'
          : declaration.superseded_at
            ? 'superseded'
            : 'declared';
    if (currentGeneration !== input.expectedGeneration || currentState !== 'declared') {
      throw new AwaitGenerationMismatchError(
        input.eventKey,
        input.expectedGeneration,
        currentGeneration,
        currentState,
        declaration?.fired_at ? new Date(declaration.fired_at).toISOString() : null,
      );
    }
  };
  const insertAwait = async (tx: any): Promise<AwaitRow> => {
    const rows = input.boundTo
      ? await tx`
          INSERT INTO harness_shared.event_awaits
            (workspace_id, subscriber_id, event_key, policy, note, wake_handle, timeout_behavior,
             expires_ts, once, min_sleep_sec, urgency, payload_filter, producer_health, bound_to)
          VALUES
            (${ws}, ${input.subscriberId}, ${input.eventKey}, ${input.policy ?? 'wake'},
             ${input.note ?? null}, ${input.wakeHandle ? JSON.stringify(input.wakeHandle) : null}::text::jsonb,
             ${timeoutBehavior}, ${expiresTs}, ${input.once ?? true}, ${input.minSleepSec ?? null},
             ${input.urgency ?? false},
             ${input.payloadFilter != null ? JSON.stringify(input.payloadFilter) : null}::text::jsonb,
             ${input.producerHealthCertificate ? JSON.stringify(input.producerHealthCertificate) : null}::text::jsonb,
             ${JSON.stringify(assertLifecycleBinding(input.boundTo))}::text::jsonb)
          RETURNING *
        `
      : await tx`
          INSERT INTO harness_shared.event_awaits
            (workspace_id, subscriber_id, event_key, policy, note, wake_handle, timeout_behavior, expires_ts, once, min_sleep_sec, urgency, payload_filter, producer_health)
          VALUES
            (${ws}, ${input.subscriberId}, ${input.eventKey}, ${input.policy ?? 'wake'},
             ${input.note ?? null}, ${input.wakeHandle ? JSON.stringify(input.wakeHandle) : null}::text::jsonb,
             ${timeoutBehavior}, ${expiresTs}, ${input.once ?? true}, ${input.minSleepSec ?? null},
             ${input.urgency ?? false},
             ${input.payloadFilter != null ? JSON.stringify(input.payloadFilter) : null}::text::jsonb,
             ${input.producerHealthCertificate ? JSON.stringify(input.producerHealthCertificate) : null}::text::jsonb)
          RETURNING *
        `;
    return mapAwait(rows[0]);
  };
  // Ordinary, unfiltered exact one-shot registrations are the shared primitive
  // behind direct events:await, watch/interest auto-arm, and the events sugar
  // surfaces. Serialize their retire-and-insert operation so concurrent
  // registrations cannot leave two live rows for one subscriber/key. Payload-
  // filtered waits intentionally coexist (each filter is a distinct predicate),
  // as do leader-managed fleet benches. Composed rows are inserted by
  // compose-store and are excluded by root_id below. Explicit supersession has
  // its own surface-aware lock and intentionally bypasses this narrower policy.
  const exactOneShot =
    input.policy !== 'announce' &&
    input.once !== false &&
    !isPattern(input.eventKey) &&
    input.payloadFilter == null &&
    !input.note?.startsWith(FLEET_BENCH_NOTE_PREFIX);
  const retireExactPending = async (tx: any): Promise<number> => {
    if (!exactOneShot) return 0;
    const lockKey = `event-await:${ws}:${input.subscriberId}:${input.eventKey}`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const retired = await tx`
      UPDATE harness_shared.event_awaits
         SET cancelled_at = now()
       WHERE workspace_id = ${ws}
         AND subscriber_id = ${input.subscriberId}
         AND event_key = ${input.eventKey}
         AND policy <> 'announce'
         AND once = true
         AND root_id IS NULL
         AND payload_filter IS NULL
         AND (note IS NULL OR note NOT LIKE ${FLEET_BENCH_NOTE_PREFIX + '%'})
         AND fired_at IS NULL
         AND cancelled_at IS NULL
         AND superseded_at IS NULL
      RETURNING id
    `;
    return retired.length;
  };
  if (supersedePending) {
    return boundedOrgTxn(async (tx) => {
      const allEventKeys = supersedePending.allEventKeys === true;
      if (allEventKeys && !supersedePending.includeNotePrefix) {
        throw new Error('allEventKeys supersession requires includeNotePrefix');
      }
      await assertGenerationPin(tx);
      // Exact-key supersession serializes one subscriber/key pair. A coordination
      // surface that owns at most one current row per subscriber (fleet:bench)
      // serializes at subscriber scope so concurrent cross-key retargets cannot
      // leave two active replacements behind.
      const lockKey = allEventKeys
        ? `event-await:${ws}:${input.subscriberId}:*`
        : `event-await:${ws}:${input.subscriberId}:${input.eventKey}`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const eventFilter = allEventKeys ? tx`` : tx`AND event_key = ${input.eventKey}`;
      const noteFilter =
        supersedePending.includeNotePrefix != null
          ? tx`AND note LIKE ${supersedePending.includeNotePrefix + '%'}`
          : supersedePending.excludeNotePrefix != null
            ? tx`AND (note IS NULL OR note NOT LIKE ${supersedePending.excludeNotePrefix + '%'})`
            : tx``;
      const superseded = await tx`
        UPDATE harness_shared.event_awaits
           SET cancelled_at = now()
         WHERE workspace_id = ${ws}
           AND subscriber_id = ${input.subscriberId}
           ${eventFilter}
           AND policy <> 'announce'
           AND once = true
           AND fired_at IS NULL AND cancelled_at IS NULL
           ${noteFilter}
        RETURNING id
      `;
      const row = await insertAwait(tx);
      return { ...row, supersededPendingCount: superseded.length };
    }, AWAIT_PRE_REGISTRATION_TXN_OPTIONS);
  }
  // A generation-pinned registration must keep the declaration lock through
  // its insert even when the caller does not request supersession. Otherwise
  // an announcement can fire or be replaced after the validation read and
  // before the waiter row is committed.
  if (input.expectedGeneration != null) {
    return boundedOrgTxn(async (tx) => {
      await assertGenerationPin(tx);
      await retireExactPending(tx);
      return insertAwait(tx);
    }, AWAIT_PRE_REGISTRATION_TXN_OPTIONS);
  }
  if (exactOneShot) {
    return boundedOrgTxn(async (tx) => {
      await retireExactPending(tx);
      return insertAwait(tx);
    }, AWAIT_PRE_REGISTRATION_TXN_OPTIONS);
  }
  // Keep the legacy insert byte-for-byte free of `bound_to` when no binding was
  // supplied. Besides preserving manual-watch semantics, this lets older
  // hand-rolled test fixtures keep exercising the unbound path honestly. It is
  // still bounded: this is the final pre-registration write, so it must not
  // escape the interactive transaction budget merely because it is legacy.
  return boundedOrgTxn((tx) => insertAwait(tx), AWAIT_PRE_REGISTRATION_TXN_OPTIONS);
}

/**
 * Attach producer health after an await is durably registered.
 *
 * Producer observation can be slower than the interactive registration budget,
 * so callers must never build the certificate before inserting the await row.
 * Restrict the update to rows that are still pending (and before their
 * deadline): a fire, cancellation, supersession, or timeout that wins the
 * race leaves the row as an ordinary timeout await.
 */
export async function attachProducerHealthCertificate(input: {
  awaitIds: readonly number[];
  certificate: ProducerHealthCertificate;
}): Promise<number> {
  const awaitIds = [...new Set(input.awaitIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (awaitIds.length === 0) return 0;

  return boundedOrgTxn(async (tx) => {
    const rows = await tx`
      UPDATE harness_shared.event_awaits
         SET producer_health = ${JSON.stringify(input.certificate)}::text::jsonb
       WHERE workspace_id = ${eventsWs()}
         AND id = ANY(${awaitIds}::bigint[])
         AND producer_health IS NULL
         AND fired_at IS NULL
         AND cancelled_at IS NULL
         AND superseded_at IS NULL
         AND (expires_ts IS NULL OR expires_ts > now())
      RETURNING id
    `;
    return rows.length;
  }, AWAIT_PRE_REGISTRATION_TXN_OPTIONS);
}

/** Fail before SQL rather than persisting an unaddressable lifecycle owner. */
export function assertLifecycleBinding(binding: LifecycleBinding): LifecycleBinding {
  const kind = binding.kind?.trim();
  const ref = binding.ref?.trim();
  if (!kind || !ref) throw new Error('bound_to requires non-empty kind and ref');
  return { kind, ref };
}

export interface LifecycleRetirementResult {
  awaits: number;
  predicateWatches: number;
}

/**
 * Retire every auto/suggested watch carrying one exact lifecycle binding. An
 * optional owner filter is load-bearing for leadership transfer: old and new
 * leaders can share the same fleet binding during a handoff, but only the
 * displaced owner's rows may be cancelled.
 */
export async function retireLifecycleBoundWatches(
  binding: LifecycleBinding | readonly LifecycleBinding[],
  opts: { ownerIds?: readonly string[] } = {},
): Promise<LifecycleRetirementResult> {
  // WI-10003631 (P-013 C): a work-item settle retires several bindings at
  // once (claim + each plan lane). Each used to be its own bounded txn — two
  // UPDATEs plus BEGIN/set_config/COMMIT per binding. All bindings now go in
  // ONE statement: both UPDATEs as data-modifying CTEs over `bound_to = ANY`.
  const list = (Array.isArray(binding) ? binding : [binding]) as readonly LifecycleBinding[];
  if (list.length === 0) return { awaits: 0, predicateWatches: 0 };
  const bindingJsons = [...new Set(list.map((b) => JSON.stringify(assertLifecycleBinding(b))))];
  const owners = [...new Set((opts.ownerIds ?? []).map((id) => id.trim()).filter(Boolean))];
  const ownerFilter = owners.length > 0;
  return boundedOrgTxn(async (tx) => {
    const rows = await tx<{ awaits: number; predicate_watches: number }[]>`
      WITH retired_awaits AS (
        UPDATE harness_shared.event_awaits
           SET cancelled_at = now()
         WHERE bound_to = ANY(${bindingJsons}::text[]::jsonb[])
           AND (NOT ${ownerFilter}::boolean OR subscriber_id = ANY(${owners}::text[]))
           -- Announcements are declaration/latch rows, not lifecycle
           -- watches.  They intentionally survive declarer death so a
           -- successor can inherit the exact generation-guarded gate;
           -- only retireAnnouncement may settle one.
           AND policy <> 'announce'
           AND cancelled_at IS NULL
           AND (once = false OR fired_at IS NULL)
        RETURNING id
      ), retired_predicates AS (
        UPDATE harness_shared.predicate_watches
           SET active = false,
               last_error = coalesce(last_error, 'gc: lifecycle binding retired')
         WHERE bound_to = ANY(${bindingJsons}::text[]::jsonb[])
           AND (NOT ${ownerFilter}::boolean OR owner_id = ANY(${owners}::text[]))
           AND active
        RETURNING id
      )
      SELECT (SELECT count(*) FROM retired_awaits)::int AS awaits,
             (SELECT count(*) FROM retired_predicates)::int AS predicate_watches`;
    return { awaits: rows[0]?.awaits ?? 0, predicateWatches: rows[0]?.predicate_watches ?? 0 };
  });
}

/**
 * Presence-reap inverse: retire a confirmed-dead owner's pending watches.
 *
 * WI-10002094: this used to require `bound_to IS NOT NULL`, i.e. it retired
 * only machinery-authored awaits and left every MANUAL `events:await`
 * registration (which carries bound_to=NULL) behind forever. Nothing else
 * retires them, so they accumulated without bound — 370 retirable orphans
 * across 249 dead sessions, the oldest from 2026-07-13, when measured.
 *
 * The caller's edge is what licenses the wider sweep: `reapEndedPresenceRows`
 * passes only owners that are past the presence TTL *and* non-wakeable, i.e.
 * confirmed dead. A pending await owned by such a session can never usefully
 * fire again, so its provenance (machinery vs manual) is irrelevant to whether
 * it should be retired. Binding provenance describes WHO armed a watch, never
 * whether its owner is still alive.
 *
 * `policy <> 'announce'` stays, and is the load-bearing exclusion: a declared
 * gate is durable coordination state whose custody transfers to a successor,
 * so it must outlive its announcer. 33 of the measured orphans were announce
 * rows — retiring them would have destroyed live gate custody.
 *
 * predicate_watches intentionally keeps the `bound_to IS NOT NULL` filter: it
 * had zero active rows at measurement, so there is no evidence of the same
 * leak there and no way to test a widening.
 */
export async function retireWatchesForReapedOwners(
  ownerIds: readonly string[],
): Promise<LifecycleRetirementResult> {
  const owners = [...new Set(ownerIds.map((id) => id.trim()).filter(Boolean))];
  if (owners.length === 0) return { awaits: 0, predicateWatches: 0 };
  return boundedOrgTxn(async (tx) => {
    const awaits = await tx`
      UPDATE harness_shared.event_awaits
         SET cancelled_at = now()
       WHERE subscriber_id = ANY(${owners}::text[])
         -- A declared gate is durable coordination state, not an
         -- owner-scoped await.  Do not cancel it when the announcer is
         -- reaped; successor custody is resolved from the declaration.
         AND policy <> 'announce'
         AND cancelled_at IS NULL
         AND (once = false OR fired_at IS NULL)
      RETURNING id`;
    const predicateWatches = await tx`
      UPDATE harness_shared.predicate_watches
         SET active = false,
             last_error = coalesce(last_error, 'gc: bound owner presence reaped')
       WHERE owner_id = ANY(${owners}::text[])
         AND bound_to IS NOT NULL
         AND active
      RETURNING id`;
    return { awaits: awaits.length, predicateWatches: predicateWatches.length };
  });
}

/** Fold lifecycle provenance without overwriting source payload fields silently. */
export function withLifecycleBindingProvenance(
  payload: unknown,
  boundTo: LifecycleBinding | null | undefined,
): unknown {
  if (!boundTo) return payload;
  const binding = assertLifecycleBinding(boundTo);
  const provenance = {
    bound_to: binding,
    armed_because: `interest machinery bound this watch to ${binding.kind}:${binding.ref}`,
  };
  if (payload != null && typeof payload === 'object' && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), ...provenance };
  }
  return { event_payload: payload ?? null, ...provenance };
}

/**
 * Upsert the ONE standing inbox-wake await for an agent (turn-lifecycle-control
 * D-002): re-arming REFRESHES the handle / floor / note in place instead of
 * piling a duplicate row, so the operator can safely (re-)arm on every
 * SessionStart. Relies on the partial unique index
 * `event_awaits_inbox_wake_one_per_agent` (migration 183) — its predicate and
 * the ON CONFLICT inference predicate below MUST stay byte-identical. A null
 * `wakeHandle` on re-arm KEEPS the previously-captured handle (the session's
 * native id may only land in adv_sessions a moment after the first arm).
 */
export async function upsertInboxWakeAwait(input: {
  subscriberId: string;
  eventKey: string;
  note?: string | null;
  wakeHandle?: WakeHandle | null;
  minSleepSec?: number | null;
}): Promise<AwaitRow> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    INSERT INTO harness_shared.event_awaits
      (workspace_id, subscriber_id, event_key, policy, note, wake_handle, timeout_behavior, expires_ts, once, min_sleep_sec, urgency)
    VALUES
      (${ws}, ${input.subscriberId}, ${input.eventKey}, 'wake',
       ${input.note ?? null}, ${input.wakeHandle ? JSON.stringify(input.wakeHandle) : null}::text::jsonb,
       'expire', NULL, false, ${input.minSleepSec ?? null}, false)
    ON CONFLICT (workspace_id, subscriber_id, event_key)
      WHERE policy = 'wake' AND once = false AND cancelled_at IS NULL
            AND event_key LIKE 'coord:inbox-wake:%'
    DO UPDATE SET
      wake_handle = COALESCE(EXCLUDED.wake_handle, harness_shared.event_awaits.wake_handle),
      -- Automatic SessionStart re-arms must not erase a deliberate
      -- coord:await-inbox park annotation. An explicit marker wins when the
      -- caller intentionally parks; otherwise preserve an existing marker
      -- over the ordinary lifecycle note.
      note = CASE
        WHEN EXCLUDED.note LIKE ${EXPLICIT_PARK_NOTE_MARKER + '%'} THEN EXCLUDED.note
        WHEN harness_shared.event_awaits.note LIKE ${EXPLICIT_PARK_NOTE_MARKER + '%'} THEN harness_shared.event_awaits.note
        ELSE COALESCE(EXCLUDED.note, harness_shared.event_awaits.note)
      END,
      min_sleep_sec = EXCLUDED.min_sleep_sec
    RETURNING *
  `;
  return mapAwait(rows[0]);
}

/** Cancel an agent's standing inbox-wake await(s) — SessionEnd hygiene
 *  (turn-lifecycle-control D-003). Returns how many rows were cancelled. */
export async function cancelInboxWakeAwaits(subscriberId: string): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET cancelled_at = now()
     WHERE workspace_id = ${ws} AND subscriber_id = ${subscriberId}
       AND policy = 'wake' AND once = false AND fired_at IS NULL AND cancelled_at IS NULL
       AND event_key LIKE 'coord:inbox-wake:%'
    RETURNING id
  `;
  await settleQueuedDeliveriesForCancelledAwaits(
    rows.map((row: any) => Number(row.id)),
    'standing inbox-wake await cancelled before delivery',
  );
  return rows.length;
}

/** Cancel a subscriber's standing `work-item:claimable` await(s) — called when the
 *  agent SUCCESSFULLY claims work (scheduler:get_next / work_items:claim_next). Holding a
 *  claim and waiting for claimable work are mutually exclusive: the documented idle model is
 *  serial (park ONE `work-item:claimable` await when a self-pull misses → wake → claim → work
 *  → re-park on the next miss), so a claimable await that outlives its claim is always stale.
 *  EI-10541: a pre-claim idle-park await that isn't cancelled when the agent later claims via a
 *  leader-fed spec bump keeps firing spurious ~30-min timeout wakes while the agent is busy,
 *  each costing a full re-orient turn. Subscriber-scoped (you can only cancel your own, like
 *  cancelInboxWakeAwaits); best-effort at the call site. Returns how many rows were cancelled. */
export async function cancelClaimableAwaits(subscriberId: string): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET cancelled_at = now()
     WHERE workspace_id = ${ws} AND subscriber_id = ${subscriberId}
       AND event_key = 'work-item:claimable'
       AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING id
  `;
  await settleQueuedDeliveriesForCancelledAwaits(
    rows.map((row: any) => Number(row.id)),
    'claimable await cancelled after work was claimed',
  );
  return rows.length;
}

/**
 * Cancel PENDING (not yet fired/cancelled) awaits for the given subscribers on the
 * given EXACT event keys — the shared primitive behind two distinct EI-12457 uses:
 *
 * 1. SIBLING cancellation at FIRE time: a dual-outcome wait (checkpoint:await arms
 *    BOTH `release:green:<pipeline>` and `green-checkpoint:red:<pipeline>` so it wakes
 *    either way) leaves the OTHER key's registration alive until its own timeout once
 *    one outcome fires — for the resolved candidate it can now never legitimately fire.
 *    The caller (emitAwaitedEvent) passes the subscribers just woken by THIS fire plus
 *    the sibling key(s), so the dead registration is retired immediately instead of
 *    piling up (the "350 total registrations" noise release:trace was reporting).
 * 2. SUPERSEDED-wait retirement at REGISTRATION time: re-arming checkpoint:await for a
 *    pipeline (e.g. because the candidate moved) first cancels the SAME subscriber's
 *    own prior, still-pending checkpoint-family awaits for that pipeline — an old
 *    registration a caller has moved on from is exactly the "superseded" wait the
 *    ticket named; without this it lives on and can fire a stale/obsolete wake later.
 *
 * Subscriber-scoped (mirrors cancelClaimableAwaits — you can only cancel your own,
 * both directions). Best-effort at every call site; returns 0 rather than throwing
 * when there is nothing to cancel.
 */
export async function cancelAwaitsForSubscribersOnKeys(
  subscriberIds: readonly string[],
  eventKeys: readonly string[],
  options: {
    /** Preserve rows owned by a different coordination surface. */
    excludeNotePrefix?: string;
    /** Restrict cancellation to one coordination surface (used by re-stage). */
    includeNotePrefix?: string;
    /** Restrict cancellation to one-shot rows; standing watches remain armed. */
    onceOnly?: boolean;
  } = {},
): Promise<number> {
  if (subscriberIds.length === 0 || eventKeys.length === 0) return 0;
  const ws = eventsWs();
  const rows = await boundedOrgTxn(
    async (tx) => {
      const noteFilter =
        options.includeNotePrefix != null
          ? tx`AND note LIKE ${options.includeNotePrefix + '%'}`
          : options.excludeNotePrefix != null
            ? tx`AND (note IS NULL OR note NOT LIKE ${options.excludeNotePrefix + '%'})`
            : tx``;
      const onceFilter = options.onceOnly ? tx`AND once = true` : tx``;
      const cancelled = await tx`
        UPDATE harness_shared.event_awaits
           SET cancelled_at = now()
         WHERE workspace_id = ${ws}
           AND subscriber_id = ANY(${tx.array([...subscriberIds])}::text[])
           AND event_key = ANY(${tx.array([...eventKeys])}::text[])
           AND policy <> 'announce'
           ${onceFilter}
           AND fired_at IS NULL AND cancelled_at IS NULL
           ${noteFilter}
        RETURNING id
      `;
      // Settle INSIDE the bounded txn, threading `tx` as the client — matching
      // cancelAwait below, the only other call site that runs this settle from
      // inside a boundedOrgTxn. Omitting the client here defaulted the settle to
      // `getOrgPg().sql`, so this pre-registration path escaped its own
      // AWAIT_PRE_REGISTRATION_TXN_OPTIONS bounds (acquire/statement/lock) into an
      // UNBOUNDED UPDATE against event_wake_deliveries. Keeping it in-txn also makes
      // cancel+settle atomic, closing the window where awaits are already cancelled
      // but their queued deliveries are still live.
      await settleQueuedDeliveriesForCancelledAwaits(
        cancelled.map((row: any) => Number(row.id)),
        'await cancelled by lifecycle/supersession cleanup',
        { client: tx },
      );
      return cancelled;
    },
    AWAIT_PRE_REGISTRATION_TXN_OPTIONS,
  );
  return rows.length;
}

/**
 * Cancel PENDING awaits by exact row id, regardless of subscriber (WI-4957) — for when
 * the CALLER has already identified specific dead registrations (e.g. every await whose
 * payload_filter is bound to a candidate sha a checkpoint run was just superseded/killed
 * for) and needs to retire exactly those rows. Unlike cancelAwaitsForSubscribersOnKeys
 * (subscriber+key scoped, so it can't distinguish two different payload-bound waits on
 * the SAME key for the SAME subscriber) or cancelAwait (subscriber-scoped, self-only),
 * this is a precise by-id cancel — safe here because the caller derived the id set from
 * a payload-filter match, never a guess. Best-effort shape: returns the count actually
 * cancelled (already-fired/cancelled rows are silently skipped, not an error).
 */
export async function cancelAwaitsByIds(ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET cancelled_at = now()
     WHERE workspace_id = ${ws} AND id = ANY(${[...ids]})
       AND policy <> 'announce'
       AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING id
  `;
  await settleQueuedDeliveriesForCancelledAwaits(
    rows.map((row: any) => Number(row.id)),
    'await cancelled by exact-id cleanup',
  );
  return rows.length;
}

export type AwaitCancellationSource = 'operator';

/** A user cancellation marker that suppresses a later auto-arm re-registration. */
export interface OperatorCancelledAwait {
  id: number;
  subscriberId: string;
  eventKey: string;
  cancelledAt: string;
}

export interface CancelAwaitResult {
  awaitId: number;
  cancelled: boolean;
  eventKey?: string;
  once?: boolean;
  expiresTs?: string | null;
  droppedDeliveries: number;
  inFlightDeliveries: number;
  error?: 'standing_watch_requires_confirmation';
}

/**
 * Cancel one of MY awaits (subscriber-scoped — you cannot cancel a peer's) and
 * report the collateral wake-delivery state.
 *
 * `source:'operator'` is reserved for the explicit events:cancel surface;
 * internal cleanup callers intentionally omit it and do not create a suppression.
 * Public cancellation also requires `confirmStanding:true` for a standing
 * (`once:false`) watch. A one-word `await_id` slip must not silently disable a
 * recurring wake source.
 */
export async function cancelAwaitDetailed(input: {
  awaitId: number;
  subscriberId: string;
  source?: AwaitCancellationSource;
  confirmStanding?: boolean;
}): Promise<CancelAwaitResult> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  return sql.begin(async (tx) => {
    const candidates = await tx`
      SELECT id, event_key, once, expires_ts
        FROM harness_shared.event_awaits
       WHERE workspace_id = ${ws} AND id = ${input.awaitId}
         AND subscriber_id = ${input.subscriberId}
         -- Announcements share this table but are declarations, not awaits. They
         -- have their own generation-guarded retireAnnouncement path; accepting
         -- one here lets an await_id teardown silently retire a gate declaration.
         AND policy <> 'announce'
         AND fired_at IS NULL AND cancelled_at IS NULL
       FOR UPDATE
    `;
    if (candidates.length === 0) {
      return {
        awaitId: input.awaitId,
        cancelled: false,
        droppedDeliveries: 0,
        inFlightDeliveries: 0,
      };
    }

    const candidate = candidates[0] as any;
    const once = candidate.once !== false;
    const expiresTs = candidate.expires_ts == null ? null : new Date(candidate.expires_ts).toISOString();
    const base = {
      awaitId: input.awaitId,
      eventKey: String(candidate.event_key),
      once,
      expiresTs,
      droppedDeliveries: 0,
      inFlightDeliveries: 0,
    };
    if (input.source === 'operator' && !once && input.confirmStanding !== true) {
      return {
        ...base,
        cancelled: false,
        error: 'standing_watch_requires_confirmation',
      };
    }

    const rows = await tx`
      UPDATE harness_shared.event_awaits
         SET cancelled_at = now(), cancel_reason = ${input.source === 'operator' ? 'operator' : null}
       WHERE workspace_id = ${ws} AND id = ${input.awaitId}
         AND subscriber_id = ${input.subscriberId}
         AND policy <> 'announce'
         AND fired_at IS NULL AND cancelled_at IS NULL
      RETURNING id
    `;
    if (rows.length === 0) {
      return {
        awaitId: input.awaitId,
        cancelled: false,
        droppedDeliveries: 0,
        inFlightDeliveries: 0,
      };
    }

    const droppedDeliveries = await settleQueuedDeliveriesForCancelledAwaits(
      rows.map((row: any) => Number(row.id)),
      input.source === 'operator'
        ? 'await cancelled by subscriber via events:cancel'
        : 'await cancelled by internal lifecycle cleanup',
      { client: tx },
    );
    const inFlightRows = await tx`
      SELECT count(*)::int AS count
        FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = ${ws}
         AND await_id = ${input.awaitId}
         AND status = 'delivering'
    `;
    return {
      ...base,
      cancelled: true,
      droppedDeliveries,
      inFlightDeliveries: Number(inFlightRows[0]?.count ?? 0),
    };
  });
}

/** Boolean compatibility wrapper for internal cleanup callers. */
export async function cancelAwait(input: {
  awaitId: number;
  subscriberId: string;
  source?: AwaitCancellationSource;
  confirmStanding?: boolean;
}): Promise<boolean> {
  return (await cancelAwaitDetailed(input)).cancelled;
}

export type RetireAnnouncementReason =
  | 'not_found'
  | 'not_yours'
  | 'generation_mismatch'
  | 'already_settled';

export interface RetireAnnouncementResult {
  retired: boolean;
  announcementId: number;
  eventKey?: string;
  generation?: number | null;
  supersededAt?: string | null;
  reason?: RetireAnnouncementReason;
}

/** Retire one of MY current, unfired announced gate declarations.
 *
 * Retirement is deliberately different from ordinary await cancellation:
 * announcements are discovery/latch rows, so setting superseded_at preserves
 * their history while leaving every ordinary waiter row on the same key alone.
 * The per-key advisory lock is shared with declaration and fire-latch writes;
 * this makes retirement race-safe with both a replacement declaration and the
 * real event emit.
 */
export async function retireAnnouncement(input: {
  announcementId: number;
  subscriberId: string;
  expectedGeneration?: number;
}): Promise<RetireAnnouncementResult> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  return sql.begin(async (tx) => {
    const candidates = await tx`
      SELECT event_key
        FROM harness_shared.event_awaits
       WHERE workspace_id = ${ws}
         AND id = ${input.announcementId}
         AND policy = 'announce'
       LIMIT 1
    `;
    if (candidates.length === 0) {
      return { retired: false, announcementId: input.announcementId, reason: 'not_found' };
    }

    const eventKey = String(candidates[0].event_key);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'event-announce:' + eventKey}, 0))`;
    const rows = await tx`
      SELECT *
        FROM harness_shared.event_awaits
       WHERE workspace_id = ${ws}
         AND id = ${input.announcementId}
         AND policy = 'announce'
       FOR UPDATE
    `;
    if (rows.length === 0) {
      return { retired: false, announcementId: input.announcementId, reason: 'not_found' };
    }

    const row = rows[0] as any;
    const generation = row.causal_generation != null ? Number(row.causal_generation) : null;
    const base = {
      retired: false as const,
      announcementId: input.announcementId,
      eventKey,
      generation,
    };
    if (String(row.subscriber_id) !== input.subscriberId) {
      return { ...base, reason: 'not_yours' as const };
    }
    if (input.expectedGeneration != null && generation !== input.expectedGeneration) {
      return { ...base, reason: 'generation_mismatch' as const };
    }
    if (row.fired_at != null || row.cancelled_at != null || row.superseded_at != null) {
      return { ...base, reason: 'already_settled' as const };
    }

    const retired = await tx`
      UPDATE harness_shared.event_awaits
         SET superseded_at = now()
       WHERE workspace_id = ${ws}
         AND id = ${input.announcementId}
         AND policy = 'announce'
         AND fired_at IS NULL
         AND cancelled_at IS NULL
         AND superseded_at IS NULL
       RETURNING event_key, causal_generation, superseded_at
    `;
    if (retired.length === 0) {
      return { ...base, reason: 'already_settled' as const };
    }
    await reconcileEventExternalBlockers(tx, String(retired[0].event_key), input.subscriberId);
    return {
      retired: true,
      announcementId: input.announcementId,
      eventKey: String(retired[0].event_key),
      generation: retired[0].causal_generation != null ? Number(retired[0].causal_generation) : null,
      supersededAt: retired[0].superseded_at ? new Date(retired[0].superseded_at).toISOString() : null,
    };
  }) as Promise<RetireAnnouncementResult>;
}

/**
 * Read explicit operator cancellations for exact subscriber/key pairs. These
 * rows are historical markers, not active awaits; callers use the result only
 * to avoid silently re-arming a watch the operator deliberately retracted.
 */
export async function listOperatorCancelledAwaits(
  subscriberId: string,
  eventKeys: readonly string[],
): Promise<OperatorCancelledAwait[]> {
  const keys = [...new Set(eventKeys.map((key) => key.trim()).filter(Boolean))];
  if (keys.length === 0) return [];
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT id, subscriber_id, event_key, cancelled_at
      FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws}
       AND subscriber_id = ${subscriberId}
       AND event_key = ANY(${sql.array(keys)}::text[])
       AND policy <> 'announce'
       AND cancelled_at IS NOT NULL
       AND cancel_reason = 'operator'
     ORDER BY cancelled_at DESC, id DESC
  `;
  return rows.map((row: any) => ({
    id: Number(row.id),
    subscriberId: row.subscriber_id,
    eventKey: row.event_key,
    cancelledAt: new Date(row.cancelled_at).toISOString(),
  }));
}

/** Clear only explicit operator-cancellation markers for exact keys. The
 * canceled rows remain history; clearing the marker permits leader control to
 * register a fresh standing await on its next reconciliation. */
export async function clearOperatorCancelledAwaits(
  subscriberId: string,
  eventKeys: readonly string[],
): Promise<number> {
  const keys = [...new Set(eventKeys.map((key) => key.trim()).filter(Boolean))];
  if (keys.length === 0) return 0;
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET cancel_reason = NULL
     WHERE workspace_id = ${ws}
       AND subscriber_id = ${subscriberId}
       AND event_key = ANY(${sql.array(keys)}::text[])
       AND policy <> 'announce'
       AND cancelled_at IS NOT NULL
       AND cancel_reason = 'operator'
    RETURNING id
  `;
  return rows.length;
}

/** Active awaits for a subscriber (events:status). */
export async function listActiveAwaits(subscriberId: string): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND subscriber_id = ${subscriberId}
       AND policy <> 'announce'
       AND fired_at IS NULL AND cancelled_at IS NULL
     ORDER BY created_at DESC
     LIMIT 100
  `;
  // P-016: a composed LEAF carries no expires_ts of its own (the root node owns the
  // tree's deadline), and a NULL here reads as "waits forever" everywhere else in this
  // table. Resolve before the dossier/`events:status` renders it. No extra query when
  // the batch holds no composed awaits.
  return withEffectiveDeadlines(rows.map(mapAwait), { workspaceId: ws });
}

/**
 * Bounded delivery history for one class of lifecycle-bound awaits.
 *
 * Auto-armed coordination adapters need to distinguish pending rows from an
 * episode that already fired or was explicitly operator-cancelled. Reuse the
 * event_awaits receipt ledger for that decision instead of creating a parallel
 * reminder cursor.
 */
export async function listLifecycleBoundAwaits(
  subscriberId: string,
  bindingKind: string,
  limit = 500,
): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws}
       AND subscriber_id = ${subscriberId}
       AND policy <> 'announce'
       AND bound_to->>'kind' = ${bindingKind}
     ORDER BY created_at DESC
     LIMIT ${Math.max(1, Math.min(Math.floor(limit) || 500, 1_000))}
  `;
  return withEffectiveDeadlines(rows.map(mapAwait), { workspaceId: ws });
}

/** Active awaits whose key starts with a prefix — source-side reconciliation
 *  (e.g. the lock-grant bridge sweeping `lock:grant:%` against waiter status). */
export async function listActiveAwaitsByKeyPrefix(prefix: string): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND event_key LIKE ${prefix + '%'}
       AND policy <> 'announce'
       AND fired_at IS NULL AND cancelled_at IS NULL
     ORDER BY created_at ASC
     LIMIT 200
  `;
  return rows.map(mapAwait);
}

/** The always-armed per-agent self-wake key prefix (turn-lifecycle-control) —
 *  every live agent holds one, so it signals liveness, NOT a deliberate bench. */
export const INBOX_WAKE_KEY_PREFIX = 'coord:inbox-wake:';

/**
 * The system halt-rescue wake is deliberately not a message. It shares the
 * recipient's inbox-wake key so the standing keepalive can rescue a halted
 * session, but must not consume a separate one-shot await waiting for a real
 * directed message on that key.
 */
const UNGUARDED_HALT_RESCUE_SOURCE = 'unguarded-halt-rescue';

/**
 * P-001 (fleet-member-dx-improvements-2026-07-10, EI-9014): active deliberate
 * awaits for MANY subscribers in ONE round-trip — the "parked-on-event" read
 * that fleet:assignments and the claim-discipline watch derive a member's
 * deliberate bench state from. An agent holding an active, caller-owned await
 * on an event key is PARKED (benched awaiting a pushed event), not abandoned.
 * Excludes the always-armed, unbounded-expiring `coord:inbox-wake:%` self-await
 * (see INBOX_WAKE_KEY_PREFIX), but retains a deliberate bounded wake-on-timeout
 * await on that same key (EI-23154777064754970). Also excludes the
 * PLATFORM-ARMED bindings that are registered FOR an agent rather than BY it —
 * `work-item-claim` (defensive claim-release interest), `fleet-leadership`
 * (a leader's transition watches, armed on taking the fleet), and
 * `agent-obligation` (agenda change/deadline reminders) — and rows already
 * past their deadline (the sweeper may not have fired them yet).
 *
 * The distinction that matters to every caller: a park means "this agent chose to
 * sleep until an event arrives". An auto-armed row means the platform registered an
 * interest on the agent's behalf and the agent is still working. Reading the second
 * as the first silences a fleet leader's own supervision loop (EI-21295379735880011).
 */
export async function listParkedAwaitsForSubscribers(
  subscriberIds: readonly string[],
): Promise<Array<Pick<AwaitRow, 'subscriberId' | 'eventKey' | 'note' | 'expiresTs' | 'createdAt' | 'rootId' | 'boundTo'>>> {
  const ids = [...new Set(subscriberIds.filter((id) => !!id))];
  if (ids.length === 0) return [];
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT subscriber_id, event_key, note, expires_ts, created_at, root_id, bound_to
      FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws}
       AND subscriber_id = ANY(${ids as string[]}::text[])
       AND fired_at IS NULL AND cancelled_at IS NULL
       AND (
         event_key NOT LIKE ${INBOX_WAKE_KEY_PREFIX + '%'}
         OR note LIKE ${EXPLICIT_PARK_NOTE_MARKER + '%'}
         OR (
           event_key LIKE ${INBOX_WAKE_KEY_PREFIX + '%'}
           AND expires_ts IS NOT NULL
           AND timeout_behavior = 'wake'
         )
       )
       AND policy <> 'announce'
       -- PLATFORM-ARMED interests are not deliberate parks. These are armed FOR
       -- the agent rather than BY it:
       --   work-item-claim  a holder's claim-release interest is defensive: it wakes
       --                    if the claim disappears, but it never means the holder is
       --                    waiting for a capability.
       --   fleet-leadership a leader's transition watches (member-dead, drained,
       --                    claim-released, context-critical, admission-blocked) are
       --                    armed on taking leadership so the leader is NOTIFIED of a
       --                    change — not because it is waiting to proceed. Counting
       --                    them as parks silenced the loop a leader supervises WITH,
       --                    from the moment it took the fleet, ~5 rows per fleet
       --                    (EI-21295379735880011).
       --   agent-obligation  one-shot agenda change/deadline reminders. They notify
       --                    ongoing work; they never mean the owner chose to park.
       -- Keep other lifecycle-bound interests visible (for example, a blocked
       -- work-item or a hard-blocked consultation); this predicate is intentionally
       -- narrow so an unknown binding still fails open toward visibility.
       AND COALESCE(bound_to->>'kind', '') NOT IN ('work-item-claim', 'fleet-leadership', 'agent-obligation')
       AND (expires_ts IS NULL OR expires_ts > now())
     ORDER BY created_at DESC
     LIMIT 500
  `;
  const mapped = rows.map((r: any) => ({
    subscriberId: r.subscriber_id,
    eventKey: r.event_key,
    note: r.note ?? null,
    expiresTs: r.expires_ts ? new Date(r.expires_ts).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    rootId: r.root_id != null ? Number(r.root_id) : null,
    // Loop suppression needs the writer's provenance: an automatically bound
    // dependency watch is interest in ONE item, not a deliberate session park.
    boundTo: parseJsonb<LifecycleBinding>(r.bound_to),
  }));
  // P-016. This read IS the bench/park verdict behind fleet:assignments' `parkedOn`
  // and the claim-discipline watch, so both halves of the composed-leaf defect matter
  // here: a leaf's NULL expires_ts reads as an INDEFINITE park (the false-deadlock
  // reading), and the SQL filter above cannot see the root's deadline, so a leaf whose
  // TREE already lapsed survives it and reads as an ACTIVE park. `dropExpired` closes
  // the second — fixing only the first would trade one wrong verdict for another.
  return withEffectiveDeadlines(mapped, { workspaceId: ws, dropExpired: true });
}

/**
 * A verified wait that reached an authoritative stalled/absent verdict needs to
 * remain leader-legible after the one-shot await has fired.  The wake payload is
 * transient; this read projects the durable verdict stored on event_awaits.
 *
 * Keep the window bounded and return only the newest verdict per
 * subscriber/event pair.  This is an operational handoff signal, not an event
 * history API.
 */
export interface VerifiedWaitTakeoverAlert {
  subscriberId: string;
  eventKey: string;
  firedAt: string;
  classification: 'stalled' | 'absent';
  nextAction: 'wake-owner-or-takeover';
  producer: VerifiedWaitTimeoutResult['producer'];
  owner: VerifiedWaitTimeoutResult['owner'];
  checkedAtMs: number;
  verificationDeadlineMs: number;
  lastProgressAtMs: number | null;
  lastFireAtMs: number | null;
  evidence?: Record<string, unknown>;
  remedy: string;
  progressLease?: ProducerHealthCertificate['progressLease'];
}

export interface VerifiedWaitTakeoverReadDeps {
  /** Test seam; production uses the checkpoint adapter's live producer probe. */
  observeProducer?: (certificate: ProducerHealthCertificate) => Promise<ProducerHealthObservation>;
  /** Test seam for the condition singleton read used to reject stale lineage. */
  readCurrentConditionOwners?: (
    certificate: ProducerHealthCertificate,
  ) => Promise<CurrentConditionOwner[] | null>;
}

interface CurrentConditionOwner {
  workItemId: string;
  ownerId: string | null;
  lastProgressAtMs: number | null;
}

function conditionKeyForCertificate(certificate: ProducerHealthCertificate): {
  harnessSlug: string;
  conditionKey: string;
} | null {
  if (certificate.producer.kind !== 'green-checkpoint') return null;
  const details = certificate.details;
  const pipeline = details && typeof details.pipeline === 'string' ? details.pipeline.trim() : '';
  if (!pipeline) return null;
  return { harnessSlug: pipeline, conditionKey: `gate-red-streak:${pipeline}` };
}

function timestampMs(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const ms = new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Read the current condition singleton behind a green-checkpoint producer.
 *
 * `timeout_verification` is immutable history, while the condition singleton is
 * the live owner of the failure. A different live owner makes an older
 * wake-owner-or-takeover verdict historical even when the producer probe itself
 * has not emitted a newer progress marker. Fail open when this auxiliary read is
 * unavailable; the producer freshness probe remains the authoritative fallback.
 */
async function readCurrentConditionOwners(
  certificate: ProducerHealthCertificate,
): Promise<CurrentConditionOwner[] | null> {
  const key = conditionKeyForCertificate(certificate);
  if (!key) return [];
  try {
    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT feature_id, taken_by, last_progress_at
        FROM harness_shared.work_items
       WHERE harness_slug = ${key.harnessSlug}
         AND condition_key = ${key.conditionKey}
         AND status <> ALL(${ANY_FAMILY_TERMINAL_STATES}::text[])
    `;
    return (rows as any[]).map((row) => ({
      workItemId: String(row.feature_id),
      ownerId: row.taken_by == null ? null : String(row.taken_by),
      lastProgressAtMs: timestampMs(row.last_progress_at),
    }));
  } catch {
    return null;
  }
}

function conditionOwnerSupersedesAlert(
  alert: Pick<VerifiedWaitTakeoverAlert, 'checkedAtMs' | 'owner'>,
  current: CurrentConditionOwner,
): boolean {
  return (
    current.workItemId !== (alert.owner.workItemId ?? '') ||
    current.ownerId !== alert.owner.ownerId ||
    (current.lastProgressAtMs != null && current.lastProgressAtMs > alert.checkedAtMs)
  );
}

function laterThan(current: number | null, previous: number | null): boolean {
  return current != null && (previous == null || current > previous);
}

/**
 * A timeout verdict is actionable only while the producer is still in the state
 * that caused it. The durable timeout row is deliberately a snapshot, so a
 * later run-lock/progress/completion must suppress the old takeover remedy.
 * Re-check failures keep the old alert visible (fail-open): losing the freshness
 * probe must not hide a genuinely stalled producer.
 */
function takeoverSuperseded(
  alert: Pick<VerifiedWaitTakeoverAlert, 'checkedAtMs' | 'lastProgressAtMs' | 'lastFireAtMs'>,
  observation: ProducerHealthObservation,
): boolean {
  const verdictActivityAtMs = Math.max(
    alert.checkedAtMs,
    alert.lastProgressAtMs ?? Number.NEGATIVE_INFINITY,
    alert.lastFireAtMs ?? Number.NEGATIVE_INFINITY,
  );
  return (
    observation.state === 'active' ||
    laterThan(observation.lastProgressAtMs, verdictActivityAtMs) ||
    laterThan(observation.lastFireAtMs, verdictActivityAtMs) ||
    laterThan(observation.completedAtMs, verdictActivityAtMs)
  );
}

export async function listVerifiedWaitTakeoversForSubscribers(
  subscriberIds: readonly string[],
  sinceHours = 24,
  deps: VerifiedWaitTakeoverReadDeps = {},
): Promise<VerifiedWaitTakeoverAlert[]> {
  const ids = [...new Set(subscriberIds.filter((id) => !!id))];
  if (ids.length === 0) return [];
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const boundedHours = Math.min(Math.max(sinceHours, 1), 168);
  const rows = await sql`
    SELECT DISTINCT ON (subscriber_id, event_key)
           subscriber_id, event_key, fired_at, producer_health, timeout_verification
      FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws}
       AND subscriber_id = ANY(${ids as string[]}::text[])
       AND fired_reason = 'verified-timeout'
       AND fired_at >= now() - make_interval(hours => ${boundedHours})
       AND timeout_verification IS NOT NULL
     ORDER BY subscriber_id, event_key, fired_at DESC
     LIMIT 500
  `;
  const candidates = rows.flatMap((row: any) => {
    const result = parseJsonb<VerifiedWaitTimeoutResult>(row.timeout_verification);
    if (
      !result ||
      (result.classification !== 'stalled' && result.classification !== 'absent') ||
      result.nextAction !== 'wake-owner-or-takeover'
    ) {
      return [];
    }
    const certificate = parseJsonb<ProducerHealthCertificate>(row.producer_health);
    const typedRemedy = certificate?.progressLease?.history
      .slice()
      .reverse()
      .find((transition) => transition.remedy)?.remedy;
    const ownerTarget = result.owner.workItemId ?? result.owner.ownerId;
    return [
      {
        alert: {
          subscriberId: row.subscriber_id,
          eventKey: row.event_key,
          firedAt: new Date(row.fired_at).toISOString(),
          classification: result.classification,
          nextAction: result.nextAction,
          producer: result.producer,
          owner: result.owner,
          checkedAtMs: result.checkedAtMs,
          verificationDeadlineMs: result.verificationDeadlineMs,
          lastProgressAtMs: result.lastProgressAtMs,
          lastFireAtMs: result.lastFireAtMs,
          ...(result.evidence ? { evidence: result.evidence } : {}),
          remedy:
            typedRemedy?.summary ??
            (ownerTarget
              ? `Wake the owner of ${ownerTarget}; if it does not resume promptly, claim/take over ${ownerTarget}.`
              : 'No owning work-item or agent was recorded; claim the producer repair before retrying this wait.'),
          ...(certificate?.progressLease ? { progressLease: certificate.progressLease } : {}),
        } satisfies VerifiedWaitTakeoverAlert,
        certificate,
      },
    ];
  });
  if (candidates.length === 0) return [];
  // EI-20540454577146535: `timeout_verification` is a SNAPSHOT written once, when the
  // fallback verifier fired — it is never re-checked against the work item's CURRENT
  // state. Filed live: a checkpoint response recommended wake-owner-or-takeover for
  // WI-39333 forty-three minutes after that item had already closed (state=done), a
  // stale warning that can steer a monitor to seize completed work. Suppress rows
  // whose owning work item has since gone terminal.
  const terminalOwners = await terminalWorkItemIds(
    candidates.map(({ alert }) => alert.owner.workItemId).filter((id): id is string => !!id),
  );
  const nonTerminal = candidates.filter(
    ({ alert }) => !alert.owner.workItemId || !terminalOwners.has(alert.owner.workItemId),
  );
  // EI-21139615450004027 / WI-40626: a legacy or stale certificate can point
  // the wait back at its subscriber, sometimes retaining an unrelated work-item
  // id. That subscriber cannot wake or take over itself; a stale id does not
  // make the self-referential remedy actionable.
  const actionable = nonTerminal.filter(
    ({ alert }) => alert.owner.ownerId !== alert.subscriberId,
  );
  if (actionable.length === 0) return [];

  const readConditionOwners = deps.readCurrentConditionOwners ?? readCurrentConditionOwners;
  const conditionOwnerReads = new Map<string, Promise<CurrentConditionOwner[] | null>>();
  const currentConditionOwners = (certificate: ProducerHealthCertificate) => {
    const key = JSON.stringify(conditionKeyForCertificate(certificate));
    const existing = conditionOwnerReads.get(key);
    if (existing) return existing;
    const pending = readConditionOwners(certificate).catch(() => null);
    conditionOwnerReads.set(key, pending);
    return pending;
  };

  // EI-21158111951285029: the producer id/owner embedded in a timeout verdict is
  // historical. Reconcile it with the live condition singleton before surfacing a
  // takeover remedy, otherwise a monitor can seize an old ownerless run while the
  // current gate-red-streak item is already owned and progressing elsewhere.
  const lineageChecked = await Promise.all(
    actionable.map(async ({ alert, certificate }) => {
      if (!certificate) return { alert, certificate };
      const owners = await currentConditionOwners(certificate);
      if (!owners || !owners.some((current) => conditionOwnerSupersedesAlert(alert, current))) {
        return { alert, certificate };
      }
      return null;
    }),
  );
  const lineageActionable = lineageChecked.filter(
    (entry): entry is { alert: VerifiedWaitTakeoverAlert; certificate: ProducerHealthCertificate | null } =>
      entry !== null,
  );
  if (lineageActionable.length === 0) return [];

  const observeProducer = deps.observeProducer ?? observeCheckpointProducer;
  const observations = new Map<string, Promise<ProducerHealthObservation | null>>();
  const currentObservation = (certificate: ProducerHealthCertificate) => {
    const key = JSON.stringify({ producer: certificate.producer, details: certificate.details ?? null });
    const existing = observations.get(key);
    if (existing) return existing;
    const pending = observeProducer(certificate).catch(() => null);
    observations.set(key, pending);
    return pending;
  };

  const fresh = await Promise.all(
    lineageActionable.map(async ({ alert, certificate }) => {
      // Certificates were added after the original timeout projection. Keep
      // legacy rows visible because there is no authoritative producer to probe.
      if (!certificate) return alert;
      const observation = await currentObservation(certificate);
      if (!observation || takeoverSuperseded(alert, observation)) return null;
      return alert;
    }),
  );
  return fresh.filter((alert): alert is VerifiedWaitTakeoverAlert => alert !== null);
}

/**
 * Which of these work-item ids are terminal RIGHT NOW — read fresh, never inferred
 * from the (possibly stale) certificate that produced the takeover alert.
 *
 * Best-effort and fails OPEN (empty set ⇒ nothing suppressed): a lookup failure, or
 * an id this read cannot resolve, must never hide a genuinely stalled producer just
 * because the freshness check itself broke — that would trade one wrong verdict for
 * another. A `feature_id` collision across workspaces (F-B3: a bare `WI-`/`F-` id is
 * unique only within a workspace+harness, not globally) is treated as terminal ONLY
 * when EVERY matching row is, for the same reason: suppressing could otherwise hide
 * the alert for the live namesake.
 */
async function terminalWorkItemIds(ids: readonly string[]): Promise<Set<string>> {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return new Set();
  try {
    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT feature_id, status
        FROM harness_shared.work_items
       WHERE feature_id = ANY(${distinct}::text[])
    `;
    const statusesById = new Map<string, boolean[]>();
    for (const r of rows as any[]) {
      const list = statusesById.get(r.feature_id) ?? [];
      list.push(ANY_FAMILY_TERMINAL_STATES.includes(r.status ?? ''));
      statusesById.set(r.feature_id, list);
    }
    const terminal = new Set<string>();
    for (const [id, verdicts] of statusesById) {
      if (verdicts.length > 0 && verdicts.every(Boolean)) terminal.add(id);
    }
    return terminal;
  } catch {
    return new Set();
  }
}

/**
 * EI-19447204017443244: the caller's OWN live WAKE-capable awaits — the falsifier for
 * loop:arm's interval-cap sentence "nothing can push you a wake", which asserted that
 * as fact while consulting only `blockedOn.event`.
 *
 * Three filters carry the meaning, and each was measured rather than assumed:
 *
 *  • `policy = 'wake'` — NOT `<> 'announce'` like the bench read below. 'notify' rows
 *    inject into the inbox without waking, so counting one would answer "can anything
 *    WAKE you" with a row that cannot — re-committing the same over-claim in miniature.
 *  • `NOT LIKE INBOX_WAKE_KEY_PREFIX%` — every live agent holds exactly one standing
 *    inbox-wake row (measured 2026-08-03: 61 of the 64 live wake-awaits fleet-wide, and
 *    it is created at session start), so without this the caller ALWAYS looks like it
 *    holds a push channel. That would be strictly worse than the sentence it replaces:
 *    a rare false assertion swapped for a constant misleading one.
 *  • the liveness pair (`fired_at IS NULL AND cancelled_at IS NULL` + unexpired) is
 *    lifted verbatim from `listParkedAwaitsForSubscribers` so the two reads cannot
 *    drift on what "live" means; `withEffectiveDeadlines` then drops composed leaves
 *    whose TREE has lapsed (zero extra queries when none are composed).
 *
 * Bounded sample (see `listActiveAwaitsForKey`'s note): this runs on loop:arm's hot path
 * and is purely advisory, so a stall must fail fast rather than hang the arm. The
 * windowed total is deliberately returned separately from the bounded sample: callers
 * must not mistake the sample cap for the number of live awaits. Callers treat a
 * rejection as "unknown" — deliberately NOT as "none", which would launder an
 * unmeasurable into a measurement and re-create this very defect.
 */
type WakeAwaitSample = { eventKey: string; expiresTs: string | null; rootId: number | null };

export async function listWakeAwaitsForSubscriber(
  subscriberId: string,
  limit = 5,
): Promise<{ totalCount: number; sample: WakeAwaitSample[] }> {
  const ws = eventsWs();
  const rows = await boundedOrgTxn(
    (tx) => tx`
    SELECT event_key, expires_ts, root_id, COUNT(*) OVER() AS total_count
      FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws}
       AND subscriber_id = ${subscriberId}
       AND policy = 'wake'
       AND fired_at IS NULL AND cancelled_at IS NULL
       AND (
         event_key NOT LIKE ${INBOX_WAKE_KEY_PREFIX + '%'}
         OR note LIKE ${EXPLICIT_PARK_NOTE_MARKER + '%'}
       )
       AND (expires_ts IS NULL OR expires_ts > now())
     ORDER BY created_at DESC
     LIMIT ${limit}
  `,
  );
  const totalCount = rows.length > 0 ? Number((rows[0] as any).total_count) : 0;
  const mapped = rows.map((r: any) => ({
    eventKey: r.event_key as string,
    expiresTs: r.expires_ts ? new Date(r.expires_ts).toISOString() : null,
    rootId: r.root_id != null ? Number(r.root_id) : null,
  }));
  return {
    totalCount,
    sample: await withEffectiveDeadlines(mapped, { workspaceId: ws, dropExpired: true }),
  };
}

/** Exact, non-composed live-await identity used by the monitor/await dedup gate. */
export async function hasLiveExactAwaitForSubscriberKey(
  subscriberId: string,
  eventKey: string,
): Promise<boolean> {
  const ws = eventsWs();
  const normalized = normalizeEventKey(eventKey);
  const rows = await boundedOrgTxn((tx) => tx`
    SELECT 1
      FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws}
       AND subscriber_id = ${subscriberId}
       AND event_key = ${normalized}
       AND policy = 'wake'
       AND root_id IS NULL
       AND fired_at IS NULL
       AND cancelled_at IS NULL
       AND superseded_at IS NULL
       AND (expires_ts IS NULL OR expires_ts > now())
     LIMIT 1
  `);
  return rows.length > 0;
}

/** Active awaits matching an event key — peek without firing (sources may use
 *  this to decide whether anyone is waiting at all).
 *
 *  EI-19284963139619048: this is one of the reads `loop:status`'s wake-reachability
 *  probe runs (gate 1, "is a standing await armed"). It used to run on the plain,
 *  unbounded `getOrgPg()` admin pool like the rest of this file — a deliberate
 *  convention for most of the file's traffic, per the module header — but a stall
 *  here (lock wait / slow scan under fleet load) hung `loop:status` itself until
 *  the client's own 300s idle-timeout killed the call blind (pg-bounded-txn.ts's
 *  header documents this exact symptom class, already fixed for `work_items:comment`).
 *  boundedOrgTxn sets a real statement_timeout so a stall now fails fast + typed
 *  instead — every caller here already treats a rejection as "no live await"
 *  (fail-soft), so a timeout degrades the same way a genuine empty result would. */
export async function listActiveAwaitsForKey(eventKey: string): Promise<AwaitRow[]> {
  const ws = eventsWs();
  const rows = await boundedOrgTxn(
    (tx) => tx`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND event_key = ${eventKey}
       AND fired_at IS NULL AND cancelled_at IS NULL
       AND policy <> 'announce'
     ORDER BY created_at ASC
  `,
  );
  return rows.map(mapAwait);
}

/**
 * EI-9000 (fleet-reliability-verification-2026-07-10 P-005): count LIVE (unfired,
 * uncancelled) awaits per key-PREFIX, for MANY prefixes in one round trip — the
 * events:catalog "is anyone actually listening" read. A prefix with zero matches
 * comes back as 0 (not absent), so a caller can zip this 1:1 against its family
 * list without a presence check. Best-effort caller contract: this is a discovery
 * aid (events:catalog), not the emit-time source of truth (fireAwaitsForKey /
 * listActiveAwaitsForKey own that).
 */
export async function countActiveAwaitsByPrefixes(prefixes: readonly string[]): Promise<Map<string, number>> {
  const uniq = [...new Set(prefixes.filter((p) => p.length > 0))];
  const out = new Map<string, number>();
  if (uniq.length === 0) return out;
  for (const p of uniq) out.set(p, 0);
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT p.prefix AS prefix, count(a.id)::int AS n
      FROM unnest(${uniq}::text[]) AS p(prefix)
      LEFT JOIN harness_shared.event_awaits a
        ON a.workspace_id = ${ws}
       AND a.event_key LIKE p.prefix || '%'
       AND a.fired_at IS NULL AND a.cancelled_at IS NULL
       AND a.policy <> 'announce'
     GROUP BY p.prefix
  `;
  for (const r of rows as unknown as Array<{ prefix: string; n: number }>) {
    out.set(r.prefix, Number(r.n) || 0);
  }
  return out;
}

/**
 * WI-1611805 — the family-scoped twin of {@link countActiveAwaitsByPrefixes}, for
 * callers that have a catalog ENTRY rather than a bare key.
 *
 * `countActiveAwaitsByPrefixes` matches `prefix || '%'`, which is not `:`-bounded:
 * for `plan-event`, whose derived prefix is the bare namespace `plan`, that swept in
 * every `plan-item:` / `plan-run:` await as well (measured live: 5 reported over a
 * true 4). The bound the template already knows is arity, so this takes the
 * per-family shape — `exact` (the bare prefix, which familyAdmitsKey still matches)
 * plus `like` from `familyKeyLikePattern` — and keys the result by FAMILY, so the
 * caller never has to re-derive or re-key anything. Same best-effort contract and
 * same zero-fill: a family with no live awaits comes back 0, not absent.
 */
export async function countActiveAwaitsByKeyShapes(
  shapes: readonly { family: string; exact: string; like: string }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const usable = shapes.filter((s) => s.family.length > 0 && s.exact.length > 0 && s.like.length > 0);
  if (usable.length === 0) return out;
  for (const s of usable) out.set(s.family, 0);
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT s.family AS family, count(a.id)::int AS n
      FROM unnest(
             ${usable.map((s) => s.family)}::text[],
             ${usable.map((s) => s.exact)}::text[],
             ${usable.map((s) => s.like)}::text[]
           ) AS s(family, exact, like_pattern)
      LEFT JOIN harness_shared.event_awaits a
        ON a.workspace_id = ${ws}
       AND (a.event_key = s.exact OR a.event_key LIKE s.like_pattern)
       AND a.fired_at IS NULL AND a.cancelled_at IS NULL
       AND a.policy <> 'announce'
     GROUP BY s.family
  `;
  for (const r of rows as unknown as Array<{ family: string; n: number }>) {
    out.set(r.family, Number(r.n) || 0);
  }
  return out;
}

/**
 * Fire every active watch on a key, returning the rows fired BY THIS CALL.
 *
 * Cardinality is honored (unify-watch-primitive D-001/D-004):
 *  - **one-shot** watches (`once = true`, today's await) are claimed ATOMICALLY
 *    (`UPDATE … SET fired_at WHERE fired_at IS NULL`) — exactly-once, a concurrent emit
 *    gets the others, an await can never wake-loop.
 *  - **standing** watches (`once = false`, the pot-style recurring watch) are MATCHED but
 *    NOT consumed — they keep firing on every emit until cancelled or expired.
 */
export async function fireAwaitsForKey(input: {
  eventKey: string;
  reason?: 'event' | 'timeout';
  /** Emitter attribution used for source-specific matching safeguards. */
  source?: string | null;
  /** EI-8998: the emitted payload — tested against any active payload_filter before a
   *  matching row is allowed to fire. Rows with no payload_filter are unaffected. */
  payload?: unknown;
}): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  // A fired one-shot row is itself the durable delivery intent. Keep the
  // event payload on that same committed row so the sweeper can reconstruct a
  // wake after a crash between this claim and insertDeliveries.
  const firePayloadJson = input.payload === undefined ? null : JSON.stringify(input.payload);
  // The rescue wake is a synthetic liveness signal, not directed mail. Exclude
  // it only from one-shot inbox-wake rows: the always-armed standing row is the
  // rescue path and must continue to fire, while ordinary coord:send wakes must
  // still consume one-shot waits on the same key.
  const suppressRescueInboxOneShot =
    input.source === UNGUARDED_HALT_RESCUE_SOURCE && input.eventKey.startsWith(INBOX_WAKE_KEY_PREFIX);

  // One-shot, EXACT KEY, NO payload_filter: today's single-atomic-UPDATE fast path,
  // unchanged (D-002) — the overwhelmingly common case pays zero extra cost for EI-8998.

  // WI-10003631: the three candidate reads below (one-shot filtered exact-key,
  // standing exact-key, active patterns) used to be three round trips per fire —
  // ~8 statements per blueprint operation. They are now ONE statement: a UNION ALL
  // whose branches are the three original predicates verbatim, each tagged with a
  // branch label. UNION ALL (not one OR'd WHERE) is deliberate: an OR across the
  // three forced a parallel seq scan on the live table, while each branch alone
  // keeps its own index plan (idx_event_awaits_active_key / (workspace_id,
  // event_key) / event_awaits_pattern_active). A row matching two branches (an
  // emitted key that itself contains `*`) appears once per branch, exactly as it
  // did across the three separate reads, so every partition below is unchanged.
  // WI-10003631 (fold 2): the unfiltered one-shot claim rides in the SAME
  // statement as a data-modifying CTE (branch 'once') — one round trip per emit,
  // not two. The read branches see the pre-UPDATE snapshot: once_filter/standing
  // are disjoint from the claim by predicate (payload_filter NOT NULL / once =
  // false); the pattern branch excludes claimed ids explicitly, matching the old
  // claim-then-read ordering.
  const candidateRows = await sql`
    WITH claimed_once AS (
      UPDATE harness_shared.event_awaits
         SET fired_at = now(), fired_reason = ${input.reason ?? 'event'},
             fired_delivery_intent_at = CASE WHEN policy = 'wake' AND node_id IS NULL AND root_id IS NULL THEN now() ELSE NULL END,
             fired_by = ${input.source ?? null}, fired_payload = ${firePayloadJson}::text::jsonb
       WHERE workspace_id = ${ws} AND event_key = ${input.eventKey}
         AND once = true AND fired_at IS NULL AND cancelled_at IS NULL
         AND payload_filter IS NULL
         AND policy <> 'announce'
         AND ${!suppressRescueInboxOneShot}
      RETURNING *
    )
    SELECT 'once'::text AS m_branch, c.* FROM claimed_once c
    UNION ALL
    SELECT 'once_filter'::text AS m_branch, a.* FROM harness_shared.event_awaits a
     WHERE a.workspace_id = ${ws} AND a.event_key = ${input.eventKey}
       AND a.once = true AND a.fired_at IS NULL AND a.cancelled_at IS NULL
       AND a.payload_filter IS NOT NULL
       AND a.policy <> 'announce'
       AND ${!suppressRescueInboxOneShot}
    UNION ALL
    SELECT 'standing'::text AS m_branch, a.* FROM harness_shared.event_awaits a
     WHERE a.workspace_id = ${ws} AND a.event_key = ${input.eventKey}
       AND a.once = false AND a.cancelled_at IS NULL
       AND (a.expires_ts IS NULL OR a.expires_ts > now())
       AND a.policy <> 'announce'
    UNION ALL
    SELECT 'pattern'::text AS m_branch, a.* FROM harness_shared.event_awaits a
     WHERE a.workspace_id = ${ws}
       AND a.event_key LIKE '%*%'
       AND a.fired_at IS NULL AND a.cancelled_at IS NULL
       AND (a.once = true OR a.expires_ts IS NULL OR a.expires_ts > now())
       AND a.policy <> 'announce'
       AND a.id NOT IN (SELECT id FROM claimed_once)
  `;
  const onceRows = candidateRows.filter((r: any) => r.m_branch === 'once');
  const onceFilterCandidates = candidateRows.filter((r: any) => r.m_branch === 'once_filter');
  const standingCandidates = candidateRows.filter((r: any) => r.m_branch === 'standing');
  const patternCandidates = candidateRows.filter((r: any) => r.m_branch === 'pattern');

  // One-shot, EXACT KEY, WITH a payload_filter: can't be tested in SQL (it's an
  // arbitrary mingo DataCondition evaluated in JS), so this can't be one atomic
  // UPDATE — filter the (tiny) candidate set in JS, then atomic-claim by id
  // (mirrors the pattern-claim two-step below; a concurrent emit racing the SAME row
  // still can't double-fire it — the final UPDATE's `fired_at IS NULL` guard holds).
  const onceFilterMatchedIds = onceFilterCandidates
    .filter((r: any) => payloadMatchesFilter(parseJsonb(r.payload_filter), input.payload))
    .map((r: any) => Number(r.id));
  const claimedOnceFilterRows =
    onceFilterMatchedIds.length > 0
      ? await sql`
          UPDATE harness_shared.event_awaits
             SET fired_at = now(), fired_reason = ${input.reason ?? 'event'},
                 fired_delivery_intent_at = CASE WHEN policy = 'wake' AND node_id IS NULL AND root_id IS NULL THEN now() ELSE NULL END,
                 fired_by = ${input.source ?? null}, fired_payload = ${firePayloadJson}::text::jsonb
           WHERE id = ANY(${onceFilterMatchedIds})
             AND fired_at IS NULL AND cancelled_at IS NULL
          RETURNING *
        `
      : [];

  // Standing watches (exact key): match without consuming (still active after this
  // fire), then apply any payload_filter in JS before including in the result.
  const standingRows = standingCandidates.filter((r: any) =>
    payloadMatchesFilter(parseJsonb(r.payload_filter), input.payload),
  );

  // Pattern awaits (P-201): a stored event_key containing a literal `*` is a glob
  // (`work-item:done:*`, `fleet:*:<slug>`). Fetch the ACTIVE pattern rows — a tiny
  // set, index-backed by event_awaits_pattern_active (migration 480) — and fire the
  // ones whose pattern matches THIS exact fired key, reusing @papercusp/rules' mingo
  // matcher (keyMatchesPattern), THEN (EI-8998) any payload_filter on the same row.
  // One-shots keep the atomic exactly-once claim; standing pattern watches match
  // without consuming. `*` is a literal in SQL LIKE (% and _ are the wildcards), so
  // `LIKE '%*%'` = "event_key contains an asterisk". (Read above, in candidateRows.)
  // WI-3309/EI-8413: `event_key` is schema NOT NULL in real Postgres (a NULL/undefined
  // value can never satisfy the `LIKE '%*%'` filter above either), so this guard only
  // ever trips on a malformed candidate row from a non-conforming caller (a test double
  // that stubs `sql` to answer every query with a canned, differently-shaped row was
  // hitting this — `keyMatchesPattern(undefined, ...)` threw `undefined.startsWith`,
  // which escaped as a console.warn via the emit's fire-and-forget .catch). A malformed
  // row can never usefully match a pattern, so skip it instead of crashing the emit.
  const matched = patternCandidates.filter(
    (r: any) =>
      typeof r.event_key === 'string' &&
      keyMatchesPattern(r.event_key, input.eventKey) &&
      payloadMatchesFilter(parseJsonb(r.payload_filter), input.payload),
  );
  const matchedOnceIds = matched.filter((r: any) => (r.once ?? true) === true).map((r: any) => Number(r.id));
  const matchedStanding = matched.filter((r: any) => (r.once ?? true) === false);
  // Atomic exactly-once claim of the matched one-shot patterns (mirrors onceRows: a
  // concurrent emit of a different key that also matches can never double-fire one row).
  const claimedPatternRows =
    matchedOnceIds.length > 0
      ? await sql`
          UPDATE harness_shared.event_awaits
             SET fired_at = now(), fired_reason = ${input.reason ?? 'event'},
                 fired_delivery_intent_at = CASE WHEN policy = 'wake' AND node_id IS NULL AND root_id IS NULL THEN now() ELSE NULL END,
                 fired_by = ${input.source ?? null}, fired_payload = ${firePayloadJson}::text::jsonb
           WHERE id = ANY(${matchedOnceIds})
             AND fired_at IS NULL AND cancelled_at IS NULL
          RETURNING *
        `
      : [];

  return [...onceRows, ...claimedOnceFilterRows, ...standingRows, ...claimedPatternRows, ...matchedStanding].map(
    mapAwait,
  );
}

/**
 * Atomically claim SPECIFIC once-awaits by id (same exactly-once `fired_at IS NULL`
 * guard as `fireAwaitsForKey`'s fast path), rather than sweeping every await on a key.
 * Used for a TARGETED delivery (EI-8998 predicate dedup join,
 * fleet-reliability-verification-2026-07-10 P-004): a subscriber that joins an
 * ALREADY-matched shared predicate row must be told directly, without re-firing every
 * OTHER standing subscriber already registered on that same key. Rows already
 * fired/cancelled are silently skipped (not in the result).
 */
export async function claimSpecificOnceAwaits(
  ids: number[],
  reason: 'event' | 'timeout' | 'claim-spec-revision' = 'event',
): Promise<AwaitRow[]> {
  if (ids.length === 0) return [];
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET fired_at = now(), fired_reason = ${reason},
           fired_delivery_intent_at = CASE WHEN policy = 'wake' AND node_id IS NULL AND root_id IS NULL THEN now() ELSE NULL END
     WHERE workspace_id = ${ws} AND id = ANY(${ids})
       AND once = true AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING *
  `;
  return rows.map(mapAwait);
}

/** Queue wake deliveries for fired awaits (one row per recipient, D-004). Carries the
 *  per-watch floor (denormalized from each await) + the emit-time `urgent` bypass so the
 *  pump can apply the floor + coalesce without re-joining (unify-watch-primitive P-005). */
export async function insertDeliveries(input: {
  awaits: AwaitRow[];
  payload?: unknown;
  summary?: string | null;
  /** Emit-time urgency: bypass the per-subscriber floor for these deliveries. */
  urgent?: boolean;
  /** Emit-time attribution (migration 387) — persisted on the delivery so the async
   *  resume-turn-exit handler can attribute a turn death to its source (e.g. a loop fire's
   *  `loop:<routineId>`). */
  source?: string | null;
}): Promise<number> {
  if (input.awaits.length === 0) return 0;
  const { sql } = getOrgPg();
  const ws = eventsWs();
  let n = 0;
  for (const a of input.awaits) {
    // The delivery is urgent if EITHER the emit declared it OR the watch is an
    // always-urgent watch (a.urgency) — either bypasses the floor.
    const urgent = (input.urgent ?? false) || a.urgency;
    const deliveryPayload = withLifecycleBindingProvenance(input.payload, a.boundTo);
    const payloadJson = deliveryPayload === undefined ? null : JSON.stringify(deliveryPayload);
    const write = (tx: typeof sql) => tx<Array<{ id: number }>>`
      INSERT INTO harness_shared.event_wake_deliveries
        (workspace_id, await_id, subscriber_id, event_key, payload, summary, urgent, min_sleep_sec, source)
      VALUES (${ws}, ${a.id}, ${a.subscriberId}, ${a.eventKey}, ${payloadJson}::text::jsonb,
              ${input.summary ?? null}, ${urgent}, ${a.minSleepSec ?? null}, ${input.source ?? null})
      RETURNING id
    `;
    // A standing watch may deliver many times. A consumed one-shot may deliver
    // only once, including when its original emitter races the recovery sweep.
    // Both writers take the same transaction lock before the existence check.
    const inserted = a.once
      ? await boundedOrgTxn(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`event-delivery:${ws}:${a.id}`}, 0))`;
          const existing = await tx`
            SELECT id FROM harness_shared.event_wake_deliveries
             WHERE workspace_id = ${ws} AND await_id = ${a.id} LIMIT 1
          `;
          return existing.length > 0 ? [] : write(tx as typeof sql);
        })
      : await write(sql);
    if (inserted.length === 0) continue;
    const deliveryId = Number(inserted[0]?.id);

    // EI-21303383797798186: a loop fire supersedes every older undelivered fire
    // from the SAME loop instance. Keeping all of them live is actively harmful:
    // an uninjectable cold loop can accumulate hundreds of parked retries, and
    // claimDueDeliveries' bounded batches then spend every slot re-reading stale
    // checkpoints while fresh wakes stay at attempts=0. Do not call these rows
    // delivered/coalesced before the replacement itself lands — `dropped` with an
    // explicit supersession reason is the honest state.
    if (input.source?.startsWith('loop:') && Number.isFinite(deliveryId)) {
      await sql`
        UPDATE harness_shared.event_wake_deliveries
           SET status = 'dropped',
               last_error = ${`superseded by newer loop wake #${deliveryId}`}
         WHERE workspace_id = ${ws}
           AND subscriber_id = ${a.subscriberId}
           AND source = ${input.source}
           AND id < ${deliveryId}
           AND status IN ('pending', 'parked')
      `;
    }
    n++;
  }
  return n;
}

/** Recover a consumed one-shot whose producer died after firing it but before
 * creating its wake row. Only NEW claims carry fired_delivery_intent_at: older
 * fired rows lack provenance and must never be resurrected. A marked intent
 * remains recoverable after an arbitrarily long outage; age is not a proof of
 * settlement. insertDeliveries serializes with a still-running producer. */
export async function reconcileFiredWakeDeliveries(limit = 100): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT a.* FROM harness_shared.event_awaits a
     WHERE a.workspace_id = ${ws}
       AND a.once = true AND a.policy = 'wake'
       AND a.node_id IS NULL AND a.root_id IS NULL
       AND a.fired_at IS NOT NULL AND a.fired_at < now() - interval '2 seconds'
       AND a.fired_delivery_intent_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.event_wake_deliveries d
          WHERE d.workspace_id = a.workspace_id AND d.await_id = a.id
       )
     ORDER BY a.fired_at, a.id LIMIT ${limit}
  `;
  let recovered = 0;
  for (const raw of rows) {
    const awaited = mapAwait(raw);
    const timeout = awaited.firedReason === 'timeout';
    recovered += await insertDeliveries({
      awaits: [awaited],
      payload: awaited.firedPayload ?? {
        recoveredDelivery: true,
        eventKey: awaited.eventKey,
        ...(timeout ? { timeout: true } : {}),
      },
      summary: timeout
        ? `The timeout for ${awaited.eventKey} fired; inspect the producer and current state.`
        : `${awaited.eventKey} fired; inspect current state before continuing.`,
      source: awaited.firedBy ?? 'await-delivery-reconciler',
    });
  }
  return recovered;
}

/**
 * Collapse historical residue left by pre-EI-21303383797798186 writers (and the
 * narrow race where an older row was already `delivering` when its replacement
 * was inserted). At most the newest pending/parked delivery for one
 * subscriber+loop-instance remains live; ordinary event wakes are untouched.
 *
 * Run by the 30-second sweeper, so deployment repairs the existing queue without
 * an operator data migration and a crashed mid-delivery row is compacted after
 * recoverStuckDeliveries makes it pending again on the next sweep.
 */
export async function compactSupersededLoopDeliveries(): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    WITH ranked AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY subscriber_id, source
               ORDER BY created_at DESC, id DESC
             ) AS keep_rank
        FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = ${ws}
         AND status IN ('pending', 'parked')
         AND source LIKE 'loop:%'
    )
    UPDATE harness_shared.event_wake_deliveries d
       SET status = 'dropped',
           last_error = 'superseded by a newer loop wake before delivery'
      FROM ranked r
     WHERE d.id = r.id
       AND r.keep_rank > 1
    RETURNING d.id
  `;
  return rows.length;
}

/**
 * Claim due deliveries for the pump: flip pending/parked → delivering and
 * return them joined with their await's wake handle. `FOR UPDATE SKIP LOCKED`
 * keeps two hosts from double-claiming one row.
 */
export async function claimDueDeliveries(input: { limit?: number }): Promise<DeliveryWork[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const limit = input.limit ?? 10;
  // Fresh first-attempt work should usually win, but a permanently uninjectable
  // subscriber can otherwise keep a retried row behind an unbounded stream of new
  // deliveries. Reserve one slot for the oldest retry once it has waited past this
  // bound; the remaining slots preserve the fresh-first policy and keep a bad
  // subscriber from monopolizing the batch.
  const retryStarvationAgeSec = 60;
  const retryReserveSlots = limit > 0 ? 1 : 0;
  const rows = await sql`
    WITH ranked AS (
      SELECT id,
             (
               attempts > 0
               AND created_at <= now() - make_interval(secs => ${retryStarvationAgeSec})
             ) AS aged_retry,
             row_number() OVER (
               PARTITION BY (
                 attempts > 0
                 AND created_at <= now() - make_interval(secs => ${retryStarvationAgeSec})
               )
               ORDER BY created_at ASC, id ASC
             ) AS retry_rank
        FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = ${ws}
         AND status IN ('pending', 'parked')
         AND next_attempt_at <= now()
    ),
    due AS (
      SELECT d.id
        FROM harness_shared.event_wake_deliveries d
        JOIN ranked r ON r.id = d.id
       WHERE d.workspace_id = ${ws}
         AND d.status IN ('pending', 'parked')
         AND d.next_attempt_at <= now()
       -- A permanently uninjectable subscriber can legitimately PARK for a long
       -- time, but its retries must never monopolize this bounded batch. Give an
       -- untouched/no-error row its first delivery attempt before retrying recent
       -- failures, while reserving one slot for the oldest retry after it has waited
       -- long enough to prove that fresh-first ordering is starving it. The final
       -- FIFO keys keep each tier deterministic. Loop-source compaction above keeps
       -- repeated fires from becoming an unbounded fresh tier of their own
       -- (EI-21303383797798186).
       ORDER BY CASE
                  WHEN r.aged_retry AND r.retry_rank <= ${retryReserveSlots} THEN 0
                  WHEN d.attempts = 0 AND d.last_error IS NULL THEN 1
                  WHEN r.aged_retry THEN 2
                  ELSE 3
                END,
                CASE WHEN r.aged_retry THEN r.retry_rank END ASC NULLS LAST,
                d.attempts ASC,
                d.next_attempt_at ASC,
                d.created_at ASC,
                d.id ASC
       LIMIT ${limit}
       FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE harness_shared.event_wake_deliveries d
       SET status = 'delivering', attempts = d.attempts + 1
      FROM due
     WHERE d.id = due.id
    RETURNING d.*,
      (SELECT a.wake_handle FROM harness_shared.event_awaits a WHERE a.id = d.await_id) AS wake_handle,
      (SELECT a.note FROM harness_shared.event_awaits a WHERE a.id = d.await_id) AS await_note
  `;
  return rows.map(mapWork);
}

export async function markDeliveryDelivered(id: number, channel: WakeChannel, coalescedCount = 1): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'delivered', channel = ${channel}, delivered_at = now(), last_error = NULL,
           coalesced_count = ${coalescedCount}
     WHERE id = ${id}
  `;
}

/**
 * Settle the deliveries that folded INTO another subscriber's wake (the coalesce siblings):
 * delivered, channel='coalesced', no turn spent. unify-watch-primitive P-005/D-003.
 */
export async function markDeliveriesCoalesced(ids: number[], intoDeliveryId: number): Promise<void> {
  if (ids.length === 0) return;
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'delivered', channel = 'coalesced', delivered_at = now(),
           last_error = ${`coalesced into wake #${intoDeliveryId}`}
     WHERE id = ANY(${ids})
  `;
}

/**
 * The most-recent ACTUAL wake (a turn-burning channel) per subscriber — the floor anchor
 * the pump uses to decide whether a subscriber may be re-woken yet (P-005). 'inbox' and
 * 'coalesced' deliveries are excluded (they spend no turn). Returns epoch ms per subscriber
 * (absent = never woken). Bounded by the handful of subscribers due this tick.
 */
export async function lastWokenAtForSubscribers(subscriberIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (subscriberIds.length === 0) return out;
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT subscriber_id, max(delivered_at) AS last_woken_at
      FROM harness_shared.event_wake_deliveries
     WHERE workspace_id = ${ws}
       AND subscriber_id = ANY(${subscriberIds})
       AND status = 'delivered'
       AND channel = ANY(${WAKE_TURN_CHANNELS as unknown as string[]})
       AND delivered_at IS NOT NULL
     GROUP BY subscriber_id
  `;
  for (const r of rows as any[]) {
    if (r.last_woken_at) out.set(r.subscriber_id, new Date(r.last_woken_at).getTime());
  }
  return out;
}

export async function markDeliveryParked(id: number, reason: string, recheckMs: number): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'parked', last_error = ${reason},
           next_attempt_at = now() + make_interval(secs => ${Math.ceil(recheckMs / 1000)})
     WHERE id = ${id}
  `;
}

export async function markDeliveryDropped(id: number, reason: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'dropped', last_error = ${reason}
     WHERE id = ${id}
  `;
}

/** Retry with backoff, or kill after `maxAttempts` (→ 'dead', loudly logged by the pump). */
export async function markDeliveryFailed(input: {
  id: number;
  error: string;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
}): Promise<'retrying' | 'dead'> {
  const { sql } = getOrgPg();
  if (input.attempts >= input.maxAttempts) {
    await sql`
      UPDATE harness_shared.event_wake_deliveries
         SET status = 'dead', last_error = ${input.error}
       WHERE id = ${input.id}
    `;
    return 'dead';
  }
  await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'pending', last_error = ${input.error},
           next_attempt_at = now() + make_interval(secs => ${Math.ceil(input.backoffMs / 1000)})
     WHERE id = ${input.id}
  `;
  return 'retrying';
}

/**
 * Re-open a delivery that was optimistically marked delivered when a detached
 * `resume-headless` process spawned, but whose turn later exited non-zero.
 *
 * This is deliberately separate from {@link markDeliveryFailed}: the
 * synchronous failure path owns `delivering` rows, while this asynchronous
 * capture-and-watch path may only revise a row that is still `delivered`.
 */
export async function reopenDeliveredAfterResumeDeath(input: {
  id: number;
  error: string;
  maxAttempts: number;
  backoffMs: number;
}): Promise<'retrying' | 'dead' | 'ignored'> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ status: DeliveryStatus }>>`
    UPDATE harness_shared.event_wake_deliveries
       SET status = CASE WHEN attempts >= ${input.maxAttempts} THEN 'dead' ELSE 'pending' END,
           channel = NULL,
           delivered_at = NULL,
           coalesced_count = 1,
           last_error = ${input.error},
           next_attempt_at = CASE
             WHEN attempts >= ${input.maxAttempts} THEN next_attempt_at
             ELSE now() + make_interval(secs => ${Math.ceil(input.backoffMs / 1000)})
           END
     WHERE id = ${input.id} AND status = 'delivered'
    RETURNING status
  `;
  const status = rows[0]?.status;
  if (status === 'dead') return 'dead';
  if (status === 'pending') return 'retrying';
  return 'ignored';
}

/** Defer a claimed row without burning its attempt as a failure (pacing). */
export async function markDeliveryDeferred(id: number, deferMs: number): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'pending', attempts = greatest(attempts - 1, 0),
           next_attempt_at = now() + make_interval(secs => ${Math.ceil(deferMs / 1000)})
     WHERE id = ${id}
  `;
}

/** Sweep half 1: stuck 'delivering' rows (host crashed mid-attempt) → pending. */
export async function recoverStuckDeliveries(input: { olderThanMs: number }): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'pending'
     WHERE workspace_id = ${ws} AND status = 'delivering'
       AND next_attempt_at < now() - make_interval(secs => ${Math.ceil(input.olderThanMs / 1000)})
    RETURNING id
  `;
  return rows.length;
}

/** Sweep half 2a: timeout-behavior 'wake' awaits past deadline → fire as timeout. */
export async function fireTimedOutAwaits(): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_awaits AS await
       SET fired_at = now(), fired_reason = 'timeout',
           fired_delivery_intent_at = CASE WHEN await.policy = 'wake' AND await.node_id IS NULL AND await.root_id IS NULL THEN now() ELSE NULL END
     WHERE await.workspace_id = ${ws} AND await.timeout_behavior = 'wake'
       AND await.once = true
       AND await.expires_ts IS NOT NULL AND await.expires_ts <= now()
       AND await.producer_health IS NULL
       AND await.fired_at IS NULL AND await.cancelled_at IS NULL
       -- An emit records its fire latch before claiming waiter rows. If the
       -- latest fire for this key landed during this await's lifetime, let
       -- the event claim win this timeout race.
       AND NOT EXISTS (
         SELECT 1
           FROM harness_shared.event_key_fires AS fire
          WHERE fire.workspace_id = await.workspace_id
            AND fire.event_key = await.event_key
            AND fire.last_fired_at >= await.created_at
            AND fire.last_fired_at <= await.expires_ts
       )
    RETURNING *
  `;
  return rows.map(mapAwait);
}

/** Claim due verified waits without consuming them; stale verifier leases self-heal. */
export async function claimDueVerifiedAwaits(limit = 100): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    WITH due AS (
      SELECT id
        FROM harness_shared.event_awaits
       WHERE workspace_id = ${ws}
         AND timeout_behavior = 'wake'
         AND producer_health IS NOT NULL
         AND expires_ts IS NOT NULL AND expires_ts <= now()
         AND fired_at IS NULL AND cancelled_at IS NULL
         AND (verification_claimed_at IS NULL OR verification_claimed_at < now() - interval '2 minutes')
       ORDER BY expires_ts ASC
       LIMIT ${Math.min(Math.max(limit, 1), 500)}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE harness_shared.event_awaits a
       SET verification_claimed_at = now()
      FROM due
     WHERE a.id = due.id
    RETURNING a.*
  `;
  return rows.map(mapAwait);
}

/**
 * Persist a verified timeout verdict. Progress extends the same one-shot await;
 * every other classification consumes it and returns the row for wake delivery.
 */
export async function settleVerifiedAwaitTimeout(input: {
  id: number;
  result: VerifiedWaitTimeoutResult;
  nextCertificate?: ProducerHealthCertificate;
  finalCertificate?: ProducerHealthCertificate;
}): Promise<AwaitRow | null> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  if (input.result.classification === 'progressing' && !input.nextCertificate) {
    throw new Error('progressing verified wait requires nextCertificate');
  }
  if (input.nextCertificate) {
    await sql`
      UPDATE harness_shared.event_awaits
         SET producer_health = ${JSON.stringify(input.nextCertificate)}::text::jsonb,
             expires_ts = to_timestamp(${input.nextCertificate.verificationDeadlineMs} / 1000.0),
             timeout_verification = ${JSON.stringify(input.result)}::text::jsonb,
             verification_claimed_at = NULL
       WHERE workspace_id = ${ws} AND id = ${input.id}
         AND fired_at IS NULL AND cancelled_at IS NULL
    `;
    return null;
  }
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET fired_at = now(), fired_reason = 'verified-timeout',
           fired_delivery_intent_at = CASE WHEN policy = 'wake' AND node_id IS NULL AND root_id IS NULL THEN now() ELSE NULL END,
           timeout_verification = ${JSON.stringify(input.result)}::text::jsonb,
           producer_health = COALESCE(${input.finalCertificate ? JSON.stringify(input.finalCertificate) : null}::text::jsonb, producer_health),
           verification_claimed_at = NULL
     WHERE workspace_id = ${ws} AND id = ${input.id}
       AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING *
  `;
  return rows[0] ? mapAwait(rows[0]) : null;
}

/** Sweep half 2b: timeout-behavior 'expire' awaits past deadline → lapse (visible, no turn). */
export async function expireLapsedAwaits(): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_awaits
       SET fired_at = now(), fired_reason = 'expired'
     WHERE workspace_id = ${ws} AND timeout_behavior = 'expire'
       AND expires_ts IS NOT NULL AND expires_ts <= now()
       AND fired_at IS NULL AND cancelled_at IS NULL
    RETURNING id
  `;
  return rows.length;
}

/**
 * Acknowledge one of MY undelivered wakes (subscriber-scoped): "I saw the
 * parked nudge and acted — do not resume me." Settles the row as delivered
 * via the inbox channel (which is how it actually reached the acker). The
 * D-007 cost saver: an acked wake never burns a resume turn.
 */
export type AckDeliveryResult = {
  /** The call changed an active delivery to inbox-delivered. */
  acked: boolean;
  /** The caller owns an existing delivery that was already terminal. */
  alreadySettled: boolean;
  status?: string;
};

export async function ackDelivery(input: { deliveryId: number; subscriberId: string }): Promise<AckDeliveryResult> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'delivered', channel = COALESCE(channel, 'inbox'), delivered_at = now(),
           last_error = 'acked by subscriber while awake'
     WHERE workspace_id = ${ws} AND id = ${input.deliveryId} AND subscriber_id = ${input.subscriberId}
       AND status IN ('pending', 'parked')
     RETURNING id
  `;
  if (rows.length > 0) return { acked: true, alreadySettled: false };

  // A wake can be settled by the inbox/wake path between the nudge and the
  // caller's acknowledgement. Distinguish that benign race from a missing or
  // peer-owned delivery so events:cancel can report an explicit outcome.
  const settled = await sql<{ status: string }[]>`
    SELECT status
      FROM harness_shared.event_wake_deliveries
     WHERE workspace_id = ${ws} AND id = ${input.deliveryId}
       AND subscriber_id = ${input.subscriberId}
     LIMIT 1
  `;
  if (settled.length > 0) {
    const status = settled[0].status;
    if (status === 'pending' || status === 'parked' || status === 'delivering') {
      return { acked: false, alreadySettled: false, status };
    }
    return { acked: false, alreadySettled: true, status };
  }
  return { acked: false, alreadySettled: false };
}

/**
 * Settle PENDING/PARKED deliveries on the caller's OWN standing inbox-wake key
 * that were queued at-or-before a cutoff the caller has now read past — the
 * turn-end-settle counterpart of `ackDelivery` (EI-9389). The standing
 * inbox-wake await (`once = false`) is matched but never consumed by
 * `fireAwaitsForKey`, so every `coord:send {wake:true}` while the recipient is
 * busy queues its OWN delivery row, independent of the recipient's inbox READ
 * cursor. A later bulk `coord:inbox` read already shows all of those messages,
 * but the queued delivery rows don't know that — each still fires a full
 * (billable) resume turn once the recipient goes idle, even for traffic
 * already seen and acted on. Settling them at the server-side turn-end cursor
 * settle (`turn-end-tracking-io.ts`, the canonical "I've now seen everything up
 * to X" signal — it moved there from the retired `coord:watermark-set` under
 * plan fleet-deltas-leader-primitives-2026-07-10 D-014) closes that gap
 * the same way `ackDelivery` does for a single delivery: `delivered`,
 * channel `'coalesced'` (no turn burned, WAKE_TURN_CHANNELS-excluded), never
 * touching another subscriber's rows (subscriber_id-scoped, like ackDelivery).
 * Deliveries created AFTER the cutoff are left alone — a message that arrived
 * mid-read must still wake normally next time. Returns rows settled.
 */
export async function settleCaughtUpInboxWakeDeliveries(input: {
  subscriberId: string;
  cutoffTs: string;
}): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const key = `${INBOX_WAKE_KEY_PREFIX}${input.subscriberId}`;
  const rows = await sql`
    UPDATE harness_shared.event_wake_deliveries
       SET status = 'delivered', channel = 'coalesced', delivered_at = now(),
           last_error = 'caught up at turn-end cursor settle — already seen in a bulk coord:inbox read (EI-9389)'
     WHERE workspace_id = ${ws} AND subscriber_id = ${input.subscriberId}
       AND event_key = ${key}
       AND status IN ('pending', 'parked')
       AND created_at <= ${input.cutoffTs}
    RETURNING id
  `;
  return rows.length;
}

/**
 * Immediately retire delivery rows that have not crossed the pump's claim
 * boundary when their source await is cancelled. This is the write-side half
 * of cancellation: cancelling only event_awaits leaves its already-queued
 * deliveries live, so a supposedly quiet session can still receive a backlog
 * of wakes from machinery it explicitly retracted (WI-1062047).
 *
 * `delivering` is deliberately excluded here: the pump may already be inside
 * the external wake handoff, which cannot be truthfully recalled. The pump
 * re-check below catches a row that was claimed after cancellation; a row that
 * crossed the handoff first remains an honest delivered wake.
 */
export async function settleQueuedDeliveriesForCancelledAwaits(
  awaitIds: readonly number[],
  reason: string,
  opts: { client?: any } = {},
): Promise<number> {
  const ids = [...new Set(awaitIds.filter((id) => Number.isFinite(id)))];
  if (ids.length === 0) return 0;
  const sql = opts.client ?? getOrgPg().sql;
  const ws = eventsWs();
  const rows = await sql<Array<{ id: number }>>`
    UPDATE harness_shared.event_wake_deliveries AS d
       SET status = 'dropped',
           last_error = ${`${reason} (WI-1062047)`}
      FROM harness_shared.event_awaits AS a
     WHERE d.workspace_id = ${ws}
       AND d.await_id = ANY(${ids}::bigint[])
       AND d.status IN ('pending', 'parked')
       AND a.workspace_id = ${ws}
       AND a.id = d.await_id
       AND a.cancelled_at IS NOT NULL
     RETURNING d.id
  `;
  return rows.length;
}

/**
 * Settle delivery rows claimed by the pump after their source await had already
 * been cancelled. Re-checking the joined await immediately after SKIP LOCKED
 * claim closes the cancellation/claim race before any external wake executes.
 */
export async function settleCancelledAwaitDeliveries(
  deliveries: readonly Pick<DeliveryWork, 'id'>[],
): Promise<number[]> {
  const ids = [...new Set(deliveries.map((delivery) => delivery.id))];
  if (ids.length === 0) return [];

  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql<Array<{ id: number }>>`
    UPDATE harness_shared.event_wake_deliveries AS d
       SET status = 'dropped',
           channel = NULL,
           delivered_at = NULL,
           last_error = 'source await cancelled before pump execution (WI-1062047)'
      FROM harness_shared.event_awaits AS a
     WHERE d.workspace_id = ${ws}
       AND d.id = ANY(${ids}::bigint[])
       AND d.status = 'delivering'
       AND a.workspace_id = ${ws}
       AND a.id = d.await_id
       AND a.cancelled_at IS NOT NULL
     RETURNING d.id
  `;
  return rows.map((row) => Number(row.id));
}

export interface DeliveryBacklogSummary {
  total: number;
  pending: number;
  parked: number;
  delivering: number;
  fromCancelledAwaits: number;
  oldestCreatedAt: string | null;
}

/** Full-ledger outstanding delivery summary for events:status.
 *
 * listRecentDeliveries is intentionally capped at ten display rows. It cannot
 * prove a subscriber is quiet: older pending rows can sit behind newer terminal
 * rows. This aggregate reads the complete live-status population and names the
 * especially actionable subset whose source await is already cancelled.
 */
export async function deliveryBacklogSummary(subscriberId: string): Promise<DeliveryBacklogSummary> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql<Array<{
    total: number;
    pending: number;
    parked: number;
    delivering: number;
    from_cancelled_awaits: number;
    oldest_created_at: string | Date | null;
  }>>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE d.status = 'pending')::int AS pending,
           count(*) FILTER (WHERE d.status = 'parked')::int AS parked,
           count(*) FILTER (WHERE d.status = 'delivering')::int AS delivering,
           count(*) FILTER (WHERE a.cancelled_at IS NOT NULL)::int AS from_cancelled_awaits,
           min(d.created_at) AS oldest_created_at
      FROM harness_shared.event_wake_deliveries AS d
      LEFT JOIN harness_shared.event_awaits AS a
        ON a.workspace_id = d.workspace_id AND a.id = d.await_id
     WHERE d.workspace_id = ${ws}
       AND d.subscriber_id = ${subscriberId}
       AND d.status IN ('pending', 'parked', 'delivering')
  `;
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    pending: Number(row?.pending ?? 0),
    parked: Number(row?.parked ?? 0),
    delivering: Number(row?.delivering ?? 0),
    fromCancelledAwaits: Number(row?.from_cancelled_awaits ?? 0),
    oldestCreatedAt: row?.oldest_created_at ? new Date(row.oldest_created_at).toISOString() : null,
  };
}

/** Recent deliveries for a subscriber (events:status). */
export async function listRecentDeliveries(
  subscriberId: string,
  limit = 10,
  awaitId?: number,
): Promise<DeliveryRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT * FROM harness_shared.event_wake_deliveries
     WHERE subscriber_id = ${subscriberId}
       AND (${awaitId ?? null}::bigint IS NULL OR await_id = ${awaitId ?? null})
     ORDER BY created_at DESC
     LIMIT ${limit}
  `;
  return rows.map(mapDelivery);
}

/** The D-007 meter: wake counts by subscriber + channel over a window. */
export async function wakeMeter(
  input: {
    sinceHours?: number;
  } = {},
): Promise<Array<{ subscriberId: string; status: string; channel: string | null; turnInvoked: boolean; count: number }>> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT subscriber_id, status, channel,
           COALESCE(channel = ANY(${WAKE_TURN_CHANNELS as unknown as string[]}), false) AS turn_invoked,
           count(*)::int AS count
      FROM harness_shared.event_wake_deliveries
     WHERE workspace_id = ${ws}
       AND created_at > now() - make_interval(hours => ${input.sinceHours ?? 24})
     GROUP BY subscriber_id, status, channel
     ORDER BY count DESC
     LIMIT 50
  `;
  return rows.map((r: any) => ({
    subscriberId: r.subscriber_id,
    status: r.status,
    channel: r.channel ?? null,
    turnInvoked: r.turn_invoked === true,
    count: Number(r.count),
  }));
}

// ── Announced gate events (EI-9270, fleet-member-native-guidance-2026-07-10 P-010) ──
// An announcement is a policy='announce' row in THIS table (no parallel surface):
// an emitter-side declaration "this key WILL fire — await it", discoverable via
// events:catalog / coord:orient, and LATCHED (fired_at stamped by the real emit)
// so a late registrant is told the gate already opened instead of sleeping forever.
// Every delivery path above excludes policy='announce'; only the functions below
// touch these rows.

/** Register (or refresh) the announcement for a key. One ACTIVE announcement per
 *  key: re-announcing updates note/scope/expiry in place instead of duplicating. */
export async function registerAnnouncement(input: {
  subscriberId: string;
  eventKey: string;
  note?: string | null;
  scopeKind: 'fleet' | 'plan' | 'harness' | 'global';
  scopeRef?: string | null;
  /** Optional declared completion condition, normalized by events:emit. */
  expectedCondition?: unknown | null;
  /** Stable identity for the logical gate represented by this route. */
  logicalGateKey?: string | null;
  /** Durable owner selector used by exact-key status to resolve successors. */
  boundTo?: LifecycleBinding | null;
  /** Seconds until the DECLARATION lapses (sweeper marks it fired_reason='expired'); null = standing. */
  expiresSec?: number | null;
}): Promise<AwaitRow> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const logicalGateKey = input.logicalGateKey?.trim() || null;
  const expiresTs = input.expiresSec != null ? new Date(Date.now() + input.expiresSec * 1000).toISOString() : null;
  // P-018: every declaration is a durable causal generation.  The advisory
  // transaction lock closes max(generation) -> insert races for the same key;
  // older rows are marked superseded instead of mutated/erased.
  return sql.begin(async (tx) => {
    // Serialize the logical identity before the transport-key lock. Two
    // concurrent declarations for one gate but different event keys must not
    // both pass the active-identity check.
    if (logicalGateKey) {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'event-announce-logical:' + ws + ':' + logicalGateKey}, 0))`;
      const conflicts = await tx`
        SELECT event_key, causal_generation
          FROM harness_shared.event_awaits
         WHERE workspace_id = ${ws}
           AND policy = 'announce'
           AND logical_gate_key = ${logicalGateKey}
           AND event_key <> ${input.eventKey}
           AND superseded_at IS NULL
           AND cancelled_at IS NULL
           AND fired_at IS NULL
         ORDER BY causal_generation DESC NULLS LAST, created_at DESC
         LIMIT 1
      `;
      if (conflicts.length > 0) {
        throw new Error(
          `logical gate '${logicalGateKey}' is already announced on event key '${conflicts[0].event_key}'`,
        );
      }
    }
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'event-announce:' + input.eventKey}, 0))`;
    const generationRows = await tx`
      SELECT COALESCE(MAX(causal_generation), 0)::bigint + 1 AS next_generation
        FROM harness_shared.event_awaits
       WHERE workspace_id = ${ws} AND policy = 'announce' AND event_key = ${input.eventKey}
    `;
    const generation = Number(generationRows[0]?.next_generation ?? 1);
    const superseded = await tx`
      UPDATE harness_shared.event_awaits
         SET superseded_at = COALESCE(superseded_at, now())
       WHERE workspace_id = ${ws} AND policy = 'announce' AND event_key = ${input.eventKey}
         AND superseded_at IS NULL
      RETURNING event_key
    `;
    if (superseded.length > 0) {
      await reconcileEventExternalBlockers(tx, input.eventKey, input.subscriberId);
    }
    const rows = await tx`
      INSERT INTO harness_shared.event_awaits
        (workspace_id, subscriber_id, event_key, policy, note, wake_handle, timeout_behavior, expires_ts,
         once, min_sleep_sec, urgency, payload_filter, scope_kind, scope_ref, causal_generation,
         expected_condition, logical_gate_key, bound_to)
      VALUES
        (${ws}, ${input.subscriberId}, ${input.eventKey}, 'announce', ${input.note ?? null}, NULL,
         'expire', ${expiresTs}, false, NULL, false, NULL, ${input.scopeKind}, ${input.scopeRef ?? null},
         ${generation}, ${input.expectedCondition != null ? JSON.stringify(input.expectedCondition) : null}::text::jsonb,
         ${logicalGateKey},
         ${input.boundTo ? JSON.stringify(assertLifecycleBinding(input.boundTo)) : null}::text::jsonb)
      RETURNING *
    `;
    return mapAwait(rows[0]);
  }) as Promise<AwaitRow>;
}

/** Announcements for one exact key — the events:await registration-time LATCH read.
 * The default returns only the current declaration generation. `includeCancelled`
 * preserves a current cancelled generation for stale-pin diagnostics without
 * making it discoverable as a waitable declaration. `includeSuperseded` is for
 * history-aware advisories that must distinguish a pending generation from a key
 * that has never fired at all; it includes prior non-cancelled generations.
 * fired_reason='event' = the gate genuinely fired; 'expired' = the declaration
 * lapsed unfired (NOT a latch). */
export async function findAnnouncementsForKey(
  eventKey: string,
  opts?: { includeSuperseded?: boolean; includeCancelled?: boolean },
): Promise<AwaitRow[]> {
  const ws = eventsWs();
  const rows = await boundedOrgTxn(
    (tx) =>
      opts?.includeSuperseded
        ? tx`
            SELECT * FROM harness_shared.event_awaits
             WHERE workspace_id = ${ws} AND policy = 'announce' AND event_key = ${eventKey}
               AND cancelled_at IS NULL
             ORDER BY causal_generation DESC NULLS LAST, created_at DESC
             LIMIT 50
          `
        : opts?.includeCancelled
          ? tx`
              SELECT * FROM harness_shared.event_awaits
               WHERE workspace_id = ${ws} AND policy = 'announce' AND event_key = ${eventKey}
                 AND superseded_at IS NULL
               ORDER BY causal_generation DESC NULLS LAST, created_at DESC
               LIMIT 1
            `
        : tx`
            SELECT * FROM harness_shared.event_awaits
             WHERE workspace_id = ${ws} AND policy = 'announce' AND event_key = ${eventKey}
               AND cancelled_at IS NULL AND superseded_at IS NULL
             ORDER BY causal_generation DESC NULLS LAST, created_at DESC
             LIMIT 1
          `,
    AWAIT_PRE_REGISTRATION_TXN_OPTIONS,
  );
  return rows.map(mapAwait);
}

/** A key that nearly matches one being emitted/awaited — the advisory
 *  near-miss read (event-key-nearmiss-guard-2026-07-10 P-003). */
export interface NearMissKey {
  eventKey: string;
  kind: 'await' | 'announce';
  /** Distinct subscribers holding active rows on that key. */
  holders: number;
}

/**
 * Advisory near-miss scan: ACTIVE rows (unfired, uncancelled, non-pattern)
 * whose NORMALIZED key equals the target's but whose raw key differs — the
 * `phase3-ready` vs `phase-3-ready` drift that never rendezvouses. Bounded
 * candidate read + in-process normalize compare; callers treat any failure
 * as "no near misses" (D-001: advisory, never blocking).
 */
export async function findNearMissKeys(eventKey: string, opts?: { excludeOwner?: string }): Promise<NearMissKey[]> {
  const target = normalizeEventKey(eventKey);
  if (!target) return [];
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT event_key, policy, subscriber_id FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND cancelled_at IS NULL AND fired_at IS NULL
       AND event_key <> ${eventKey}
       AND position('*' in event_key) = 0
     ORDER BY created_at DESC
     LIMIT 200
  `;
  const byKey = new Map<string, { kind: 'await' | 'announce'; holders: Set<string> }>();
  for (const r of rows) {
    const key = String(r.event_key);
    const sub = String(r.subscriber_id);
    if (opts?.excludeOwner && sub === opts.excludeOwner) continue;
    if (normalizeEventKey(key) !== target) continue;
    const kind: 'await' | 'announce' = String(r.policy) === 'announce' ? 'announce' : 'await';
    const cur = byKey.get(key);
    if (cur) {
      cur.holders.add(sub);
      if (kind === 'announce') cur.kind = 'announce';
    } else {
      byKey.set(key, { kind, holders: new Set([sub]) });
    }
  }
  return [...byKey.entries()].slice(0, 5).map(([key, v]) => ({ eventKey: key, kind: v.kind, holders: v.holders.size }));
}

/** Emit-time latch: stamp fired_at on the key's unfired announcement rows (kept,
 *  never consumed/delivered). Returns how many were latched. */
export async function stampAnnouncementsFired(
  eventKey: string,
  meta: { firedBy?: string | null; payload?: unknown } = {},
): Promise<number> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  // P-018: share registerAnnouncement's per-key advisory transaction lock.
  // Without this, an emit can commit a fired latch while a newer declaration
  // is between superseding the old generation and inserting its replacement.
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'event-announce:' + eventKey}, 0))`;
    const rows = await tx`
      UPDATE harness_shared.event_awaits
         SET fired_at = now(), fired_reason = 'event', fired_by = ${meta.firedBy ?? null},
             fired_payload = ${meta.payload !== undefined ? JSON.stringify(meta.payload) : null}::text::jsonb
       WHERE workspace_id = ${ws} AND policy = 'announce' AND event_key = ${eventKey}
         AND fired_at IS NULL AND cancelled_at IS NULL AND superseded_at IS NULL
      RETURNING id
    `;
    // EI-20721448404004954: a gate that FIRES must settle the typed event blockers
    // waiting on it, exactly as retirement and supersession already do. Without this
    // the third settlement path was missing, and the asymmetry ran the wrong way: an
    // item unblocked when its gate was CANCELLED or RE-DECLARED but not when the gate
    // actually opened — so the SUCCESS case was the one that stranded finished work.
    // (The filing: a deployed a11y fix read as an open major bug for 3 days because
    // the gate fired after its holder's session had ended, and nothing else could
    // clear a blocker bound to that session's await.)
    //
    // Same transaction and advisory lock as the other two settlement paths, per
    // reconcileEventExternalBlockers' own contract — otherwise the announcement can
    // latch fired while the work item stays parked outside scheduler self-select.
    //
    // Gated on a real transition, like the supersede path. The reconciler probes
    // work_items by payload containment, which is a parallel seq scan here (~350ms,
    // measured 2026-09-05: 180k rows, no GIN on payload); announcements fire ~7×/day,
    // so it stays off the ordinary emit path, where stampAnnouncementsFired is called
    // for every key and this UPDATE matches nothing.
    if (rows.length > 0) {
      await reconcileEventExternalBlockers(tx, eventKey, meta.firedBy ?? undefined);
      await reconcileEventDurableParks(tx, eventKey, meta.firedBy ?? undefined);
    }
    return rows.length;
  }) as Promise<number>;
}

/** ACTIVE announcements (not cancelled, not lapsed) — the discovery read for
 *  events:catalog / coord:orient. The set is tiny (index-backed, migration 548);
 *  callers filter visibility in JS via announcementVisibleTo (announce-key.ts). */
export async function listActiveAnnouncements(
  input: {
    /** true (default) = only gates that have NOT fired yet; false includes latched ones. */
    unfiredOnly?: boolean;
    limit?: number;
  } = {},
): Promise<AwaitRow[]> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const unfiredOnly = input.unfiredOnly !== false;
  const rows = await sql`
    SELECT * FROM harness_shared.event_awaits
     WHERE workspace_id = ${ws} AND policy = 'announce'
       AND cancelled_at IS NULL AND superseded_at IS NULL
       AND (expires_ts IS NULL OR expires_ts > now())
       AND (${!unfiredOnly} OR fired_at IS NULL)
     ORDER BY created_at DESC
     LIMIT ${Math.min(input.limit ?? 100, 200)}
  `;
  return rows.map(mapAwait);
}

/**
 * Fired announced gates that remain useful for catalog discovery after their
 * declaration rows leave the active set.
 *
 * Announcements are lifecycle-managed: a later generation supersedes the
 * previous row, and owner cleanup can cancel the current row. The
 * event_key_fires latch is the durable evidence that the concrete key really
 * fired, but it contains every emitted key in the system. Joining it to a
 * historical announce row keeps this read bounded to keys explicitly declared
 * as gates; arbitrary fire-latch rows must not become catalog entries.
 */
export async function listFiredAnnouncements(
  input: { limit?: number } = {},
): Promise<Array<{ announcement: AwaitRow; fireLatch: KeyFireRow }>> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
  const rows = await sql`
    SELECT fired_announcements.*
      FROM (
        SELECT DISTINCT ON (a.event_key)
               a.*,
               f.first_fired_at AS fire_first_fired_at,
               f.last_fired_at AS fire_last_fired_at,
               f.last_fired_by AS fire_last_fired_by,
               f.last_payload AS fire_last_payload,
               f.fire_count AS fire_count
          FROM harness_shared.event_awaits AS a
          JOIN harness_shared.event_key_fires AS f
            ON f.workspace_id = a.workspace_id
           AND f.event_key = a.event_key
         WHERE a.workspace_id = ${ws}
           AND a.policy = 'announce'
           AND a.fired_at IS NOT NULL
           AND a.fired_reason = 'event'
         ORDER BY a.event_key, a.causal_generation DESC NULLS LAST, a.created_at DESC
      ) AS fired_announcements
     ORDER BY fire_last_fired_at DESC, created_at DESC
     LIMIT ${limit}
  `;
  return rows.map((row: any) => ({
    announcement: mapAwait(row),
    fireLatch: mapKeyFire({
      workspace_id: row.workspace_id,
      event_key: row.event_key,
      first_fired_at: row.fire_first_fired_at,
      last_fired_at: row.fire_last_fired_at,
      last_fired_by: row.fire_last_fired_by,
      last_payload: row.fire_last_payload,
      fire_count: row.fire_count,
    }),
  }));
}

function mapKeyFire(row: any): KeyFireRow {
  return {
    workspaceId: row.workspace_id,
    eventKey: row.event_key,
    firstFiredAt: row.first_fired_at,
    lastFiredAt: row.last_fired_at,
    lastFiredBy: row.last_fired_by ?? null,
    lastPayload: row.last_payload ?? null,
    fireCount: Number(row.fire_count) || 0,
  };
}

// ── unconditional per-key fire latch (EI-13705) ─────────────────────────────
// harness_shared.event_key_fires (migration 632): ONE row per (workspace, key),
// upserted on every real emitAwaitedEvent call — independent of announce and
// independent of whether any waiter/delivery row exists to remember it by. The
// announce/waiter machinery above is fire-once (rows get consumed/superseded/
// swept), so days later "did this key ever fire" can no longer be answered from
// it; this latch is the durable, always-cheap answer.

/** Record a real fire on `eventKey` — called unconditionally from
 *  `emitAwaitedEvent`'s non-announce path, regardless of waiters/`fired.length`.
 *  Best-effort at the call site (fail-soft): never blocks or breaks an emit.
 *
 *  P-013 C / WI-10003631 (D-028): the same statement also probes whether the key
 *  has an unfired announcement, so the emit can skip `stampAnnouncementsFired`'s
 *  BEGIN + advisory lock + UPDATE + COMMIT (4 round trips) on the overwhelmingly
 *  common no-announcement path. The probe is lock-free on purpose: an announcement
 *  committed after this snapshot linearizes AFTER this fire (it is a pending gate
 *  for the next fire), exactly as one registered after the locked stamp would.
 *  `announcementPending: true` is conservative — the locked stamp re-checks.
 *
 *  P-018 (D-029 §2): the latch row is the only per-fire identity the emit has —
 *  event_key_fires carries no id. `fire` is read from the upserted row itself, so
 *  it is exactly the fire this call recorded: `firstFiredAtUs` survives every upsert
 *  and resets only when clearKeyFire drops the row, and `count` is taken under the
 *  row lock. `firstFiredAtUs` is decimal text because a bigint's wire form depends
 *  on driver config (string vs BigInt); text is exact under both. */
export async function recordKeyFire(input: {
  eventKey: string;
  firedBy?: string | null;
  payload?: unknown;
  /** WI-10003631: when set, the same statement also returns the key's active
   *  standing event-key subscribers (the emit fan-out's read) from this
   *  subscription workspace — saving the emit a separate round trip. */
  subscribersFrom?: { workspaceId: string; targetKind: string };
}): Promise<{
  announcementPending: boolean;
  fire?: KeyFireIdentity;
  eventSubscribers?: LatchedEventSubscriber[];
}> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const subs = input.subscribersFrom;
  const subscribersSql = subs
    ? sql`, (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'subscriber_id', sub.subscriber_id, 'delivery_mode', sub.delivery_mode,
                 'derived_from_kind', sub.derived_from_kind, 'derived_from_ref', sub.derived_from_ref)
               ORDER BY sub.created_at ASC, sub.id ASC), '[]'::jsonb)
          FROM harness_shared.coord_entity_subscriptions AS sub
         WHERE sub.workspace_id = ${subs.workspaceId} AND sub.target_kind = ${subs.targetKind}
           AND sub.target_ref = ${input.eventKey}
           AND sub.cancelled_at IS NULL AND (sub.expires_ts IS NULL OR sub.expires_ts > now())
      ) AS event_subscribers`
    : sql``;
  const rows = await sql`
    WITH latch AS (
      INSERT INTO harness_shared.event_key_fires
        (workspace_id, event_key, first_fired_at, last_fired_at, last_fired_by, last_payload, fire_count)
      VALUES
        (${ws}, ${input.eventKey}, now(), now(), ${input.firedBy ?? null},
         ${input.payload !== undefined ? JSON.stringify(input.payload) : null}::text::jsonb, 1)
      ON CONFLICT (workspace_id, event_key) DO UPDATE
         SET last_fired_at = now(),
             last_fired_by = ${input.firedBy ?? null},
             last_payload = ${input.payload !== undefined ? JSON.stringify(input.payload) : null}::text::jsonb,
             fire_count = harness_shared.event_key_fires.fire_count + 1
      RETURNING fire_count,
                floor(extract(epoch FROM first_fired_at) * 1000000)::bigint::text AS first_fired_at_us
    )
    SELECT (SELECT fire_count FROM latch) AS fire_count,
           (SELECT first_fired_at_us FROM latch) AS first_fired_at_us,
           EXISTS (
      SELECT 1 FROM harness_shared.event_awaits
       WHERE workspace_id = ${ws} AND policy = 'announce' AND event_key = ${input.eventKey}
         AND fired_at IS NULL AND cancelled_at IS NULL AND superseded_at IS NULL
    ) AS announcement_pending${subscribersSql}
  `;
  const raw = subs ? rows[0]?.event_subscribers : undefined;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const count = Number(rows[0]?.fire_count);
  const firstFiredAtUs = rows[0]?.first_fired_at_us;
  return {
    announcementPending: rows[0]?.announcement_pending !== false,
    ...(Number.isInteger(count) && count > 0 && typeof firstFiredAtUs === 'string'
      ? { fire: { count, firstFiredAtUs } }
      : {}),
    ...(Array.isArray(parsed) ? { eventSubscribers: parsed } : {}),
  };
}

/** P-018 (D-029 §2): the identity of one recorded fire on the per-key latch. */
export interface KeyFireIdentity {
  /** The latch's fire_count after this fire (1 on the first). */
  count: number;
  /** The latch row's first_fired_at, as integer epoch microseconds (decimal text). */
  firstFiredAtUs: string;
}

/** A standing event-key subscriber as the latch statement returns it. The
 *  derived-from pair lets the emit recognise machine-maintained rows (identity
 *  rule subscriptions, D-029 §2) by column rather than by subscriber-id shape. */
export interface LatchedEventSubscriber {
  subscriber_id: string;
  delivery_mode: string;
  derived_from_kind?: string | null;
  derived_from_ref?: string | null;
}

/** `<eventKey>@<firstFiredAtUs>#<count>` — stable for one fire, distinct across
 *  fires, and distinct across a clearKeyFire + re-fire (first_fired_at resets). */
export function keyFireId(eventKey: string, fire: KeyFireIdentity): string {
  return `${eventKey}@${fire.firstFiredAtUs}#${fire.count}`;
}

/** The latch row for one key, or null if it has never genuinely fired. */
export async function getKeyFireLatch(eventKey: string): Promise<KeyFireRow | null> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const rows = await sql`
    SELECT * FROM harness_shared.event_key_fires
     WHERE workspace_id = ${ws} AND event_key = ${eventKey}
     LIMIT 1
  `;
  return rows.length > 0 ? mapKeyFire(rows[0]) : null;
}

/** EI-21342578761370279: drop the fire latch for `eventKey`. Used when a
 *  work-item REOPENS: its previous terminal cycle's `work-item:done:<id>`
 *  latch is obsolete against the live item and misreports `fired_undeclared`
 *  to events:status readers. `firedBefore` bounds the delete to latches
 *  recorded before that epoch-ms, so a clear racing a fresh re-settle cannot
 *  erase the NEW cycle's row. The next real emit re-upserts via
 *  `recordKeyFire`. Best-effort at the call site. */
export async function clearKeyFire(
  eventKey: string,
  opts?: { firedBefore?: number },
): Promise<void> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const before = new Date(opts?.firedBefore ?? 0);
  await sql`
    DELETE FROM harness_shared.event_key_fires
     WHERE workspace_id = ${ws} AND event_key = ${eventKey}
       AND last_fired_at < ${before}
  `;
}

/**
 * EI-18676056143796303 — EMITTER EVIDENCE for the EI-10870 orphan-await guard.
 *
 * The orphan guard can only check catalog MEMBERSHIP, but it phrased its verdict
 * as knowledge about EMITTERS ("nothing in this system will ever fire it"). When a
 * family is emitted but simply never got registered in the catalog, that verdict is
 * flatly false — and it tells the agent to abandon a VALID park. The live case was
 * `coord:inbox-wake:<ownerId>`, the single most-fired key in the system and the
 * mechanism that rescues a stranded agent.
 *
 * The fire latch (`harness_shared.event_key_fires`, EI-13705) is direct evidence an
 * emitter exists: a row means the key genuinely fired at least once. This reads it
 * two ways, strongest first:
 *   - EXACT: this precise key has fired before (`release:deployed:abc123`);
 *   - PREFIX/SIBLING: some key sharing this key's first two segments has fired
 *     (`coord:inbox-wake:su-NEW` has never fired, but 118 sibling owner keys have —
 *     so the SHAPE demonstrably has an emitter, which is what the warning claims
 *     does not exist).
 *
 * A genuine orphan (the EI-10870 case: `overwatch:surface-landed`, 0 fires ever,
 * appears nowhere in the tree) matches NEITHER, so the warning still fires for the
 * keys it was built for — this only removes the false positives.
 *
 * Two segments is the family granularity every builtin template uses before its
 * first placeholder (`coord:inbox-wake`, `work-item:done`, `release:deployed`), so
 * the prefix is the family, not a loose namespace match. A key with fewer than two
 * segments probes itself exactly.
 */
export interface KeyFireEvidence {
  /** The prefix the sibling probe used (the key's first two `:` segments). */
  prefix: string;
  /** This EXACT key has fired before. */
  exact: boolean;
  /** Distinct keys sharing the prefix that have ever fired (includes the exact key). */
  distinctKeys: number;
  /** Total fires across those keys. */
  fires: number;
  /** Most recent fire across those keys, ISO-ish timestamp, or null when none. */
  lastFiredAt: string | null;
}

/** The family prefix an evidence probe uses: the key's first two `:` segments. */
export function keyFireEvidencePrefix(eventKey: string): string {
  const parts = String(eventKey ?? '')
    .trim()
    .split(':');
  return parts.length <= 2 ? parts.join(':') : parts.slice(0, 2).join(':');
}

/**
 * Has anything ever fired this key — or a sibling of its family? Returns
 * `fires: 0` when there is no evidence at all (the genuine-orphan case).
 * Read-only and index-backed (the latch's PK is `(workspace_id, event_key)`, so
 * the prefix scan is a btree range read).
 */
export async function probeKeyFireEvidence(eventKey: string): Promise<KeyFireEvidence> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const key = String(eventKey ?? '').trim();
  const prefix = keyFireEvidencePrefix(key);
  const empty: KeyFireEvidence = { prefix, exact: false, distinctKeys: 0, fires: 0, lastFiredAt: null };
  if (!prefix) return empty;
  // `prefix` is a literal key segment, never a caller-supplied LIKE pattern —
  // escape the wildcards anyway so a key containing `%`/`_` cannot widen the scan.
  const escaped = prefix.replace(/([\\%_])/g, '\\$1');
  const rows = await sql`
    SELECT count(*)::int                                             AS distinct_keys,
           coalesce(sum(fire_count), 0)::bigint                      AS fires,
           max(last_fired_at)                                        AS last_fired_at,
           bool_or(event_key = ${key})                               AS exact
      FROM harness_shared.event_key_fires
     WHERE workspace_id = ${ws}
       AND (event_key = ${prefix} OR event_key LIKE ${`${escaped}:%`} ESCAPE '\\')
  `;
  const row = rows[0];
  if (!row) return empty;
  return {
    prefix,
    exact: row.exact === true,
    distinctKeys: Number(row.distinct_keys) || 0,
    fires: Number(row.fires) || 0,
    lastFiredAt: row.last_fired_at ? String(row.last_fired_at) : null,
  };
}

/**
 * EI-19332682533219755 — what a PATTERN await will ACTUALLY match, from observed
 * history rather than from the author's mental model of their own glob.
 *
 * The incident: an agent parked on `release:green:*` expecting "the gate went
 * green". It fired `satisfied: true` carrying `pipeline: "oddsmith"` — a
 * DIFFERENT project co-hosted on this box, whose sha is not even an object in
 * this repository. `*` is a plain glob over the rest of the key, and the pipeline
 * is a key SEGMENT (`release:green:<pipeline>`), so on a multi-pipeline host the
 * "obvious generalisation" of the catalogued template silently becomes a
 * CROSS-PROJECT subscription. Every affordance then reads as success: the key
 * family is literally named `release:green`, the wake says `satisfied: true`, and
 * the documented next step after green is to SHIP. Nothing in the wake discloses
 * that the pipeline is foreign — the incident was caught only by hand-checking
 * the sha against the repo.
 *
 * The glob is not broken; it does exactly what a glob does. What was missing is
 * DISCLOSURE, so this answers the one question the author cannot answer from the
 * pattern alone: which concrete keys does this actually cover? Purely
 * observational — it never narrows or rejects an await (a coordination primitive
 * the fleet parks on must not start dropping wakes to fix a reporting gap).
 *
 * Read-only and index-backed: the latch's PK is `(workspace_id, event_key)`, so
 * an anchored prefix is a btree range read. Bounded by `limit` in every branch —
 * a glob with no anchorable prefix (`*:papercusp`) degrades to a bounded
 * recency-ordered scan rather than an unbounded one.
 */
export interface PatternMatchScope {
  /** The literal prefix the scan anchored on; `''` when the glob leads with a wildcard. */
  prefix: string;
  /** Distinct concrete keys already observed that this pattern WOULD match, most-recent first. */
  matchedKeys: string[];
  /** The scan hit its row cap, so `matchedKeys` may be incomplete. */
  truncated: boolean;
}

export async function probePatternMatchScope(glob: string, opts?: { limit?: number }): Promise<PatternMatchScope> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  const pattern = String(glob ?? '').trim();
  const limit = Math.max(1, Math.min(500, opts?.limit ?? 200));
  const prefix = patternLiteralPrefix(pattern);
  const empty: PatternMatchScope = { prefix, matchedKeys: [], truncated: false };
  if (!pattern.includes('*')) return empty;

  // `prefix` is derived from literal key text, never a caller-supplied LIKE
  // pattern — escape the wildcards anyway so a key containing `%`/`_` cannot
  // widen the scan (same defence as probeKeyFireEvidence).
  const rows = prefix
    ? await sql`
        SELECT event_key
          FROM harness_shared.event_key_fires
         WHERE workspace_id = ${ws}
           AND (event_key = ${prefix} OR event_key LIKE ${`${prefix.replace(/([\\%_])/g, '\\$1')}:%`} ESCAPE '\\')
         ORDER BY last_fired_at DESC
         LIMIT ${limit}
      `
    : await sql`
        SELECT event_key
          FROM harness_shared.event_key_fires
         WHERE workspace_id = ${ws}
         ORDER BY last_fired_at DESC
         LIMIT ${limit}
      `;

  // Narrow with the EXACT matcher the fire path uses, so this can never claim a
  // key that would not really wake the caller (or miss one that would).
  const matchedKeys: string[] = [];
  for (const r of rows) {
    const key = typeof r?.event_key === 'string' ? r.event_key : null;
    if (key && keyMatchesPattern(pattern, key)) matchedKeys.push(key);
  }
  return { prefix, matchedKeys, truncated: rows.length >= limit };
}

/** Exact-key event history for events:status.  One call returns declarations,
 * waiter registrations, wake outcomes, and the unconditional fire latch so an
 * agent does not have to stitch four partially ordered surfaces together by
 * hand. */
export async function inspectEventKey(eventKey: string): Promise<{
  announcements: AwaitRow[];
  waiters: AwaitRow[];
  deliveries: DeliveryRow[];
  fireLatch: KeyFireRow | null;
  composedRoot: {
    rootId: number;
    state: 'active' | 'fired' | 'cancelled' | 'missing';
    requiredCount?: number;
    firedCount?: number;
    firedAt?: string | null;
    cancelledAt?: string | null;
    expiresTs?: string | null;
    timeoutBehavior?: TimeoutBehavior;
  } | null;
}> {
  const { sql } = getOrgPg();
  const ws = eventsWs();
  return sql.begin(async (tx) => {
    const announcementRows = await tx`
      SELECT * FROM harness_shared.event_awaits
       WHERE workspace_id = ${ws} AND event_key = ${eventKey} AND policy = 'announce'
       ORDER BY causal_generation DESC NULLS LAST, created_at DESC
       LIMIT 50
    `;
    const waiterRows = await tx`
      SELECT * FROM harness_shared.event_awaits
       WHERE workspace_id = ${ws} AND event_key = ${eventKey} AND policy <> 'announce'
       ORDER BY created_at DESC
       LIMIT 200
    `;
    const deliveryRows = await tx`
      SELECT * FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = ${ws} AND event_key = ${eventKey}
       ORDER BY created_at DESC
       LIMIT 200
    `;
    const fireLatchRows = await tx`
      SELECT * FROM harness_shared.event_key_fires
       WHERE workspace_id = ${ws} AND event_key = ${eventKey}
       LIMIT 1
    `;
    const composedRootText = /^composed-root:([1-9]\d*)$/.exec(eventKey)?.[1] ?? null;
    const composedRootId = composedRootText == null ? null : Number(composedRootText);
    const composedRootRows = composedRootId != null && Number.isSafeInteger(composedRootId)
      ? await tx`
          SELECT id, required_count, fired_count, fired_at, cancelled_at, expires_ts, timeout_behavior
            FROM harness_shared.event_await_nodes
           WHERE workspace_id = ${ws} AND id = ${composedRootId} AND parent_id IS NULL
           LIMIT 1
        `
      : [];
    const composedRootRow = composedRootRows[0] as any | undefined;
    const composedRoot = composedRootId == null || !Number.isSafeInteger(composedRootId)
      ? null
      : composedRootRow
        ? {
            rootId: composedRootId,
            state: composedRootRow.cancelled_at != null ? 'cancelled' as const : composedRootRow.fired_at != null ? 'fired' as const : 'active' as const,
            requiredCount: Number(composedRootRow.required_count),
            firedCount: Number(composedRootRow.fired_count),
            firedAt: composedRootRow.fired_at ? new Date(composedRootRow.fired_at).toISOString() : null,
            cancelledAt: composedRootRow.cancelled_at ? new Date(composedRootRow.cancelled_at).toISOString() : null,
            expiresTs: composedRootRow.expires_ts ? new Date(composedRootRow.expires_ts).toISOString() : null,
            timeoutBehavior: composedRootRow.timeout_behavior as TimeoutBehavior,
          }
        : { rootId: composedRootId, state: 'missing' as const };
    return {
      announcements: announcementRows.map(mapAwait),
      waiters: waiterRows.map(mapAwait),
      deliveries: deliveryRows.map(mapDelivery),
      fireLatch: fireLatchRows.length > 0 ? mapKeyFire(fireLatchRows[0]) : null,
      composedRoot,
    };
  }) as Promise<{
    announcements: AwaitRow[];
    waiters: AwaitRow[];
    deliveries: DeliveryRow[];
    fireLatch: KeyFireRow | null;
    composedRoot: {
      rootId: number;
      state: 'active' | 'fired' | 'cancelled' | 'missing';
      requiredCount?: number;
      firedCount?: number;
      firedAt?: string | null;
      cancelledAt?: string | null;
      expiresTs?: string | null;
      timeoutBehavior?: TimeoutBehavior;
    } | null;
  }>;
}
