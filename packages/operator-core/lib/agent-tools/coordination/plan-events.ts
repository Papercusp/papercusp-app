/**
 * plan-events.ts — operator host adapter for the working-memory history
 * feed.
 *
 * Event types + the read filter live in @papercusp/coordination/core; the
 * append + read I/O lives behind the CoordEventLog seam (coordLog), which
 * the operator backs with Postgres (harness_shared.coord_event_log).
 *
 * agent-coordination-architecture-v2 §8. Emission is BEST-EFFORT — a
 * failure must never break a plan write (emitPlanEventForCaller swallows).
 */

import {
  newMsgId,
  filterPlanEvents,
  type CoordEnvelope,
  type PlanEventType,
  type ReadPlanEventsOpts,
} from '@papercusp/coordination/core';
import { coordLog } from './log';
import { getLineEnvelopeById } from './line-event-by-id';
import {
  resolveAgentIdentity,
  type AgentIdentity,
  type ResolveIdentityCtx,
} from './identity';

export type { PlanEventType, ReadPlanEventsOpts };

export interface EmitPlanEventOpts {
  planSlug: string;
  event: PlanEventType;
  identity?: AgentIdentity | null;
  before?: unknown;
  after?: unknown;
  detail?: string;
}

/** Plan mutations that can change the canonical acceptance verdict. Goal-only
 * property/package events share this log but deliberately do not qualify. */
export function planEventChangesAcceptance(event: PlanEventType): boolean {
  return (
    event === 'created' ||
    event === 'decision_added' ||
    event === 'decision_ratified' ||
    event === 'item_added' ||
    event === 'item_status_changed' ||
    event === 'status_changed' ||
    event === 'plan_audited'
  );
}

/** Append one plan_event line. Throws on fs failure — prefer
 *  emitPlanEventForCaller() from a plans:* write verb. */
export async function emitPlanEvent(opts: EmitPlanEventOpts): Promise<void> {
  const env: CoordEnvelope = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: opts.identity?.ownerId ?? 'system',
    to: ['*'],
    kind: 'plan_event',
    plan_slug: opts.planSlug,
    event: opts.event,
  };
  if (opts.before !== undefined) env.before = opts.before;
  if (opts.after !== undefined) env.after = opts.after;
  if (opts.detail !== undefined) env.detail = opts.detail;
  await coordLog.appendLine('plan-events', env.from, env);
}

/**
 * Best-effort emit used by `plans:*` write verbs. Resolves the caller's
 * identity (falling back to 'system' if unresolvable) and swallows any
 * error — emission must NEVER break a plan write.
 */
export async function emitPlanEventForCaller(
  ctx: ResolveIdentityCtx,
  details: Omit<EmitPlanEventOpts, 'identity'>,
): Promise<void> {
  let identity: AgentIdentity | null = null;
  try {
    try {
      identity = resolveAgentIdentity(ctx);
    } catch {
      identity = null;
    }
    await emitPlanEvent({ ...details, identity });
  } catch {
    // Best-effort. Observability, not state.
  }

  if (!planEventChangesAcceptance(details.event)) return;
  try {
    const [{ emitAwaitedEvent }, { planAcceptanceChangedKey }] = await Promise.all([
      import('../../events/await/engine'),
      import('../../agent-obligations'),
    ]);
    await emitAwaitedEvent({
      key: planAcceptanceChangedKey(details.planSlug),
      payload: {
        planSlug: details.planSlug,
        event: details.event,
        ...(details.before !== undefined ? { before: details.before } : {}),
        ...(details.after !== undefined ? { after: details.after } : {}),
        ...(details.detail !== undefined ? { detail: details.detail } : {}),
      },
      summary: `plan acceptance inputs changed (${details.event})`,
      source: identity?.ownerId ?? 'system',
    });
  } catch {
    // The plan event/write is durable truth; this is only its push hint.
  }
}

/** The newest-N storage bound on every plan-events read (EI-1737 /
 *  fleet-concurrency-first P-005). readLines('plan-events') was UNBOUNDED — orient's
 *  per-turn delta (×fleet-size) serialized/parsed the WHOLE ~3.5MB history on the
 *  single event loop. Every caller wants a recency window (a turn-start watermark
 *  delta, the UI history's own limit, the curation fresh-window), so we bound the
 *  STORAGE read to the newest N matching and push since_ts/plan_slug down — riding
 *  the coord_event_log_surface_id index — instead of loading all then slicing. 500
 *  comfortably covers every caller's presentation limit (tool 100, UI history ≤1000
 *  but typically 200); the storage layer hard-clamps to ≤1000 regardless. */
export const READ_PLAN_EVENTS_BOUND = 500;

/** Read the plan-event log, BOUNDED to the newest {@link READ_PLAN_EVENTS_BOUND}
 *  matching events (since_ts + single plan_slug pushed into the storage read),
 *  then filtered + sorted ascending by the pure filterPlanEvents. `filesBack` is
 *  accepted for call-site compatibility but no longer needed — the newest-N bound
 *  subsumes the old rotation-file windowing (and the PG backend never had files). */
export async function readPlanEvents(
  opts: ReadPlanEventsOpts & { filesBack?: number; limit?: number } = {},
): Promise<CoordEnvelope[]> {
  const limit = Math.max(
    1,
    Math.min(Math.floor(opts.limit ?? READ_PLAN_EVENTS_BOUND) || READ_PLAN_EVENTS_BOUND, 1000),
  );
  // Push the high-cardinality recency filter (since_ts) + a single-plan filter
  // into the storage read; the remaining filters (event-type list, MULTI-slug,
  // the authoritative since_ts re-check + ascending sort) stay in filterPlanEvents
  // over the bounded set, so the result is identical to the old read-all-then-filter
  // for any caller whose matching tail fits in the bound (every real caller).
  const singlePlan =
    opts.planSlugs && opts.planSlugs.length === 1 ? opts.planSlugs[0] : undefined;
  const bounded = await coordLog.readLinesBounded('plan-events', {
    limit,
    kinds: ['plan_event'],
    ...(opts.since_ts ? { sinceTs: opts.since_ts } : {}),
    ...(singlePlan ? { planSlug: singlePlan } : {}),
  });
  return filterPlanEvents(bounded, opts);
}

/**
 * Look up a SINGLE plan-event envelope by its `msg_id`.
 *
 * `readPlanEvents` above is a bounded newest-N window, so scanning it for one
 * id answers a confident `null` for anything older than the bound — the wrong
 * answer, not a slow one. This is the targeted read instead (WI-7297): the
 * /coord history viewer fetches one row's payload on demand when a user
 * expands it, and any row visible in that list must resolve regardless of how
 * far back it sits.
 *
 * Returns null when no such plan-event exists.
 */
export async function getPlanEventById(msgId: string): Promise<CoordEnvelope | null> {
  return getLineEnvelopeById('plan-events', msgId);
}
