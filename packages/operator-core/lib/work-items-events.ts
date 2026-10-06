/**
 * work-items-events — terminal-lifecycle events through the await-event primitive
 * (await-event-primitive-2026-06-05 P-012/P-013, D-006 #4/#5).
 *
 * When a work-item reaches a terminal lifecycle state (feature →
 * passed/deprecated; issue → resolved/closed) two event families fire. This
 * lifecycle signal is independent of completionAuthority: a terminal row can
 * still have proposed or otherwise unsettled completion evidence. The done
 * event includes completionAuthority so consumers can distinguish those cases.
 *
 *   `work-item:done:<id>` — the children-done / delegated-work signal: the
 *   delegator (assignedBy) and the parent chunk's claimant are notified; any
 *   agent that registered `events:await` on the key is WOKEN. A parent
 *   spawning children no longer loses the thread — it awaits each child's
 *   done-key (or sleeps on the last one).
 *
 *   `work-item:unblocked:<id>` — fired for each dependent whose LAST live
 *   blocker just settled (`rel='blocks'` edges, work_items:link). Targeted at
 *   the dependent's claimant; wake-awaiters on the key are woken. The
 *   "conceptual wait" from the touch-point inventory — agents used to just
 *   lose the thread when a blocker cleared.
 *
 * Source layer per D-001: THIS module resolves who the events concern (the
 * delegator, the parent's claimant, the dependent's claimant); the delivery
 * layer stays dumb. Called fire-and-forget from setWorkItemState (lazy import
 * there — this module imports work-items statically, so the cycle is broken
 * on the caller's side); an emit failure can never break a state write.
 */

import type { LinkRow, ObjectRef } from '@papercusp/coordination/capabilities';
import { TERMINAL_STATUSES } from './dbos/frontier-readiness';
import { emitAwaitedEvent } from './events/await/engine';
import { FEATURE_KIND } from './issue-blocks-merge';
import {
  blockingEdgeReader,
  ISSUE_TERMINAL_STATUSES,
  readSettleEdges,
  type BlockingEdgeReader,
  type SettleEdges,
} from './work-item-blocking';
import { isObservationLaneItem } from './fleet/placement-gather';
// From the dependency-free leaf, NOT the `./work-items` re-export: this module reads
// the list at MODULE-EVAL time (CLAIMABLE_STATES below) and sits inside work-items.ts's
// import cycle, so under Node's CJS loader (tsx) the re-export getter ran before
// work-items.ts had required the leaf and threw "Cannot read properties of undefined
// (reading 'CLAIM_STATES_ALLOWLIST')" — killing the production host at load
// (WI-10004247; guarded by pui-e2e/operator-process-load.test.ts).
import { CLAIM_STATES_ALLOWLIST } from './scheduler/claim-states';
import {
  getWorkItem,
  isClaimHoldParked,
  workItemObjectRef,
  type WorkItem,
  type WorkItemFamily,
} from './work-items';
// EI-15185: single-source the plan-slug derivation shared with the claim-spec
// `plan` field, so the claimable payload's `plan` and a spec's `plan` filter agree.
// EI-14161: same single-sourcing for `tags`, so a spec's tag-based exclusion
// (the p2p/rig-fenced class title-globs used to stand in for) is derivable too.
import { planSlugOfWorkItem, staticTagsOfWorkItem } from './scheduler/claim-spec-match';
import type { PlanItemLaneBlock } from './scheduler/plan-item-lane-guard';
// Type-only (erased at runtime) — the subscriber inject shape. The concrete
// fanoutForObject is lazy-imported inside the default seam below so this module
// keeps no static edge to the fan-out projection (cycle-safe).
import type { InjectEvent } from './agent-tools/coordination/fanout-delivery';
import type { BatchResolveItem } from './agent-tools/coordination/escalations';
import { parseAgenticPlanExecutionTarget, type AgenticPlanExecutionTarget } from './agentic-plan-execution-target';
import { trackDetached } from './detached-imports';
import type { assignAndWakeActionableWorkItems } from './agent-tools/coordination/actionable-work-item-dispatch';

/**
 * Errors that are EXPECTED for a best-effort, fire-and-forget notification and
 * so must never warn (vitest-fail-on-console would then flake any rig test):
 *   - a partial test schema (a projection table the emit touches is absent →
 *     "… does not exist");
 *   - the emit's async query outliving the Postgres pool it ran on (a rig/test
 *     tearing down mid-emit → postgres.js CONNECTION_ENDED/CONNECTION_DESTROYED).
 * Anything else is a genuine surprise worth a warn.
 */
function failSoft(scope: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (/does not exist/.test(msg)) return;
  const code = (e as { code?: unknown } | null)?.code;
  if (
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED' ||
    /CONNECTION_ENDED|CONNECTION_DESTROYED|Connection ended/i.test(msg)
  ) {
    return;
  }
  console.warn(`[work-items-events] ${scope} emit failed: ${msg}`);
}

/**
 * Stamp a work-item lifecycle snapshot with the instant its payload was built.
 * Lifecycle payload fields are emit-time snapshots and can be stale by the time
 * a wake is delivered; this marker lets recipients age the snapshot explicitly.
 * The optional timestamp keeps the helper deterministic for unit tests.
 */
export function workItemEventPayload<T extends Record<string, unknown>>(
  payload: T,
  observedAt = new Date().toISOString(),
): T & { payloadObservedAt: string } {
  return { ...payload, payloadObservedAt: observedAt };
}

/**
 * `work-item:claimed:<id>` — fired when an agent claims an item
 * (plugin-system-hive-port P-004: the work_items lifecycle fire-point set).
 * Awaited-event leg only: the claim travels through the `work_items:claim` /
 * `work_items:claim_next` tools, which the reaction matcher already observes
 * via postInvoke — plugins subscribe there; this key serves `events:await`.
 * Fire-and-forget; never throws.
 */
export function emitWorkItemClaimedEvent(
  wi: WorkItem,
  assignee: string,
  deps: Pick<SettledEventsDeps, 'emit'> = {},
): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  const payload = workItemEventPayload({
    id: wi.id,
    state: wi.state,
    kind: wi.kind,
    harness: wi.harness,
    assignee,
    title: wi.title,
  });
  void trackDetached(Promise.resolve()
    .then(() =>
      emit({
        key: `work-item:claimed:${wi.id}`,
        summary: `${wi.id} claimed by ${assignee}: ${wi.title}`,
        payload,
        source: 'work-items',
      }),
    )
    .catch((e: unknown) => failSoft(`claimed-event for ${wi.id}`, e)));
}

/**
 * `work-item:created[:<severity>]` — fired when a NEW work item is minted
 * (EI-8296: no creation event existed, so "alert me when a new critical-severity
 * item is filed" was inexpressible as `watch:create` and had to fall back to a
 * 15-min poll+diff plan — critical-severity-alert-2026-07-06).
 *
 * Dual-emits the GLOBAL key `work-item:created` (every new item, any severity/
 * kind/harness — payload-filtered, mirroring the `release:deployed` /
 * `release:green` global+scoped precedent, P-102/EI-7646) AND, when the item
 * carries an issue-family severity, the severity-scoped key
 * `work-item:created:<severity>` — so "wake me on a new critical item" is
 * `events:await({ event: 'work-item:created:critical' })` instead of a poll.
 * `payload` carries `{id, kind, severity, harness, title}` so a waiter on the
 * global key can filter by kind/harness itself. Fire-and-forget; never throws.
 */
export function emitWorkItemCreatedEvent(
  wi: WorkItem,
  deps: Pick<SettledEventsDeps, 'emit' | 'duplicateAdmissionCheck'> = {},
): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  const payload = workItemEventPayload({
    id: wi.id,
    kind: wi.kind,
    severity: wi.severity,
    harness: wi.harness,
    title: wi.title,
  });
  const summary = `${wi.id} created (${wi.kind}${wi.severity ? `, ${wi.severity}` : ''}): ${wi.title}`;
  void trackDetached(Promise.resolve()
    .then(() => emit({ key: 'work-item:created', summary, payload, source: 'work-items' }))
    .catch((e: unknown) => failSoft(`created-event for ${wi.id}`, e)));
  if (wi.severity) {
    void trackDetached(Promise.resolve()
      .then(() => emit({ key: `work-item:created:${wi.severity}`, summary, payload, source: 'work-items' }))
      .catch((e: unknown) => failSoft(`created-event(severity) for ${wi.id}`, e)));
  }
  // P-007: a create that lands unclaimed-claimable also announces the canonical
  // pool key — co-fired HERE (not at the createWorkItem call site) so the event
  // family's semantics live in one module; the guard drops born-claimed items.
  emitWorkItemClaimableEvent(wi, 'created', deps);
}

type PlanItemLaneBlockReason = (wi: WorkItem) => Promise<PlanItemLaneBlock | null>;

/** Duplicate-screening admission seam for claimable lifecycle events. Kept async because
 * the WorkItem projection deliberately does not expose the durable admission column. */
type DuplicateAdmissionCheck = (workItemId: string) => Promise<boolean>;

/** Resolve the duplicate-screening floor lazily so this lifecycle module keeps its
 * documented work-items import cycle safe. A missing/unreadable row is fail-closed by
 * the shared predicate, which is required for claimable notifications to stay honest. */
async function defaultDuplicateAdmissionCheck(workItemId: string): Promise<boolean> {
  const { isWorkItemDuplicateAdmitted } = await import('./work-items-admission');
  return isWorkItemDuplicateAdmitted(workItemId);
}

/** WI-10005020: true when the item still has an unsatisfied `blocks` edge. A blocked→open
 * restore (an external-blocker clear, or the legacy work-item-ref migration) of such a row
 * would otherwise announce work that no claim can take. */
type UnresolvedDependencyCheck = (wi: WorkItem) => Promise<boolean>;

/** Lazy for the same documented work-items import cycle as the admission floor. */
async function defaultUnresolvedDependencyCheck(wi: WorkItem): Promise<boolean> {
  const { readUnresolvedDepBlockers } = await import('./work-items');
  if (typeof readUnresolvedDepBlockers !== 'function') return false;
  return (await readUnresolvedDepBlockers(wi.id, wi.harness ?? undefined)).length > 0;
}

/** Resolve the plan-lane guard lazily so the lifecycle event module keeps its documented
 * work-items import cycle safe. Claimable events are best-effort notifications; the guard's
 * own fail-open contract is preserved if a plan read is unavailable. */
async function defaultPlanItemLaneBlockReason(wi: WorkItem): Promise<PlanItemLaneBlock | null> {
  const { planItemLaneBlockReasonForClaimableEvent } = await import('./scheduler/plan-item-lane-guard');
  // Keep lifecycle notification fail-open when a rolling test/consumer surface has not yet
  // projected the optional parity seam; the scheduler remains authoritative for claims.
  if (typeof planItemLaneBlockReasonForClaimableEvent !== 'function') return null;
  return planItemLaneBlockReasonForClaimableEvent(wi);
}

/** Avoid a plan read for the overwhelmingly common unplanned lifecycle event. The mapped
 * WorkItem carries source-plan columns for current projections; payload.plan_item covers the
 * legacy promotion path and older event snapshots. */
function mayHavePlanItemLinkage(wi: WorkItem): boolean {
  if (wi.sourcePlanSlug && (wi.sourcePlanItemIds?.length ?? 0) > 0) return true;
  const payload = wi.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const planItem = (payload as Record<string, unknown>).plan_item;
  return Boolean(planItem && typeof planItem === 'object' && !Array.isArray(planItem));
}

/** The states an unassigned item can be pulled from — get_next/claim_next's floor. */
const CLAIMABLE_STATES: ReadonlySet<string> = new Set(CLAIM_STATES_ALLOWLIST);

/**
 * `work-item:claimable` — the CANONICAL "work may exist for you" key
 * (composable-event-awaits-2026-07-11 P-007). Dual-emitted alongside the
 * "returns to the pool" families (`work-item:created` on an unclaimed create,
 * `claim:released:<id>`, `work-item:unblocked:<id>`, and the bare set_state
 * requeue edge — see below) so an idle self-puller parks on ONE leaf —
 * `events:await { event: 'work-item:claimable', payload_filter:
 * { harness: { eq: … } } }` — instead of the 3-leaf composed any-spec. Sugar
 * only: the underlying families keep firing unchanged, so existing specs
 * keep working.
 *
 * The claimability guard lives HERE, single-sourced for every call site: an
 * item with an assignee, in a non-claimable state (blocked / terminal /
 * wip), or claim-hold PARKED (`payload._claimHold` — WI-2797), never fires —
 * the key must never advertise work a get_next pull would then refuse
 * (EI-18128621906886568: this guard used to omit the claim-hold check, so a
 * parked-but-unassigned row still fired on every release/requeue/unblock,
 * waking every parked fleet member on non-work and inviting an "inadvertent
 * re-claim" via the still-open claim-BY-ID path). `payload.reason` carries
 * which transition made it claimable. The FOURTH return-to-pool moment — a
 * bare status flip INTO a
 * claimable state (e.g. blocked→todo via set_state) — co-fires from
 * emitWorkItemStatusEvent with reason 'requeued' (WI-4180, the P-007 audit's
 * gap (A)), so it no longer strands a parked waiter to the ~30-min timeout
 * backstop. Fire-and-forget; never throws.
 */
export function emitWorkItemClaimableEvent(
  wi: WorkItem,
  reason: 'created' | 'admitted' | 'released' | 'unblocked' | 'requeued',
  deps: Pick<
    SettledEventsDeps,
    'emit' | 'planItemLaneBlockReason' | 'duplicateAdmissionCheck' | 'unresolvedDependencyCheck'
  > = {},
): void {
  // D-005: observation-lane rows are captured reflections, not work-queue material. Keep
  // the broad wake on the same floor as scheduler:get_next and fleet placement.
  if (wi.assignee || !CLAIMABLE_STATES.has(wi.state) || isClaimHoldParked(wi.payload) || isObservationLaneItem(wi.payload)) return;
  const emit = deps.emit ?? emitAwaitedEvent;
  const checkAdmission = deps.duplicateAdmissionCheck ?? defaultDuplicateAdmissionCheck;
  const payload = workItemClaimableEventPayload(wi, reason);
  // WI-10003882: registered so drainDetached() can await the fan-out (and its
  // key-fire latch write) instead of racing a test's TRUNCATE or pool teardown.
  void trackDetached(Promise.resolve()
    .then(async () => {
      // The scheduler rejects admission-pending rows before claiming them. Keep the
      // broad wake at the same floor or parked agents will wake on work they cannot
      // take (EI-22727753112811582). Admission errors also fail closed: an unknown
      // duplicate-screening result is not evidence of claimability.
      let admitted: boolean;
      try {
        admitted = await checkAdmission(wi.id);
      } catch (e) {
        failSoft(`claimable-admission-check for ${wi.id}`, e);
        return;
      }
      if (!admitted) return;
      const checkDependencies = deps.unresolvedDependencyCheck ?? defaultUnresolvedDependencyCheck;
      let dependencyBlocked = false;
      try {
        dependencyBlocked = await checkDependencies(wi);
      } catch (e) {
        // Parity guard, not a lifecycle floor: a failed read must not strand a genuinely
        // claimable event; the scheduler's claim floor remains authoritative.
        failSoft(`claimable-dependency-check for ${wi.id}`, e);
      }
      if (dependencyBlocked) return;
      if (mayHavePlanItemLinkage(wi)) {
        const check = deps.planItemLaneBlockReason ?? defaultPlanItemLaneBlockReason;
        let blocked: PlanItemLaneBlock | null = null;
        try {
          blocked = await check(wi);
        } catch (e) {
          // This is a diagnostic parity guard, not a hard lifecycle floor. A plan read failure
          // must not strand a genuinely claimable event; the scheduler remains authoritative.
          failSoft(`claimable-plan-lane-check for ${wi.id}`, e);
        }
        if (blocked) return;
      }
      await emit({
        key: 'work-item:claimable',
        summary: `${wi.id} claimable (${reason}): ${wi.title}`,
        payload,
        source: 'work-items',
      });
    }))
    .catch((e: unknown) => failSoft(`claimable-event for ${wi.id}`, e));
}

/**
 * Build the canonical `work-item:claimable` payload from a live item. The emitter
 * and the registration-time latch both use this helper so a payload filter is
 * evaluated against the same field/value derivation on both sides of the race.
 * Claimable emits are guarded to unassigned rows, but `assignee` is still carried
 * as an explicit null snapshot: claim specs may reference it inside boolean
 * combinators, and omitting it would change `(assignee ∧ kind) OR id` into
 * `kind OR id` during payload-filter derivation.
 *
 * `reason` is edge provenance, not current state. The live registration probe
 * deliberately omits it because it cannot infer which historical edge made a row
 * claimable; a caller filtering on `reason` therefore keeps ordinary edge-only
 * semantics instead of receiving a fabricated match.
 */
export function workItemClaimableEventPayload(
  wi: WorkItem,
  reason?: 'created' | 'admitted' | 'released' | 'unblocked' | 'requeued',
): Record<string, unknown> {
  return workItemEventPayload({
    id: wi.id,
    kind: wi.kind,
    severity: wi.severity,
    harness: wi.harness,
    title: wi.title,
    state: wi.state,
    assignee: wi.assignee,
    // WI-21834327391666056: carry goal provenance so goal-scoped claim specs
    // can narrow the canonical claimable await without falling back to a
    // hive-wide wake.
    goal: wi.goalId,
    ...(reason ? { reason } : {}),
    // EI-15185: carry the item's plan slug so a fleet member's derived
    // `payload_filter` (scheduler:get_next windDown → claim-spec-payload-filter)
    // can narrow a plan-DRAIN spec at the event layer, not just kind/title.
    // Single-sourced with the claim-spec `plan` field so the two agree.
    plan: planSlugOfWorkItem(wi),
    // EI-14161: carry the item's own static payload.tags too — a member whose
    // claim spec excludes an entire tagged category (p2p / rig-needed / etc,
    // e.g. `not: { field:'tags', op:'contains', value:'p2p' }`) previously had
    // NO way to build a payload_filter narrow enough to skip these: the payload
    // carried title/kind/plan but never tags, so a tag-only exclusion derived to
    // `undefined` (unscoped await) and the member re-woke, cold, on every one of
    // these releases only for scheduler:get_next to immediately re-reject the
    // SAME item as out-of-scope. Single-sourced with the claim-spec `tags` field
    // (staticTagsOfWorkItem) so the two agree exactly.
    tags: staticTagsOfWorkItem(wi),
  });
}

/**
 * Registration-time LATCH probe for one row surfaced by the authoritative
 * claimability oracle. Re-read the item and re-apply the event producer's own
 * shallow guard at the moment of the probe: a peer may have claimed/parked it
 * after the oracle snapshot, and returning a stale payload would manufacture an
 * `already_claimable` result after the work had left the pool.
 */
export async function liveWorkItemClaimableEventPayload(
  id: string,
  harness?: string,
  deps: Pick<SettledEventsDeps, 'getItem' | 'planItemLaneBlockReason' | 'duplicateAdmissionCheck'> = {},
): Promise<Record<string, unknown> | null> {
  const getItem = deps.getItem ?? getWorkItem;
  const wi = await getItem(id, harness);
  if (!wi || wi.assignee || !CLAIMABLE_STATES.has(wi.state) || isClaimHoldParked(wi.payload) || isObservationLaneItem(wi.payload)) return null;
  const checkAdmission = deps.duplicateAdmissionCheck ?? defaultDuplicateAdmissionCheck;
  try {
    if (!(await checkAdmission(wi.id))) return null;
  } catch {
    // Registration-time latches must never manufacture a match when the durable
    // duplicate-screening floor cannot be read.
    return null;
  }
  // Keep the registration-time latch aligned with the producer guard. Without this check a
  // waiter registering after a stale claimable emit could receive `already_claimable` for a
  // plan-linked row that scheduler:get_next would immediately reject on its plan-item DAG.
  if (mayHavePlanItemLinkage(wi)) {
    const check = deps.planItemLaneBlockReason ?? defaultPlanItemLaneBlockReason;
    const blocked = await check(wi).catch(() => null);
    if (blocked) return null;
  }
  return workItemClaimableEventPayload(wi);
}

/**
 * `claim:released:<id>` — fired when a work-item's claim is RELEASED and it returns
 * to the claimable pool (event-await-discoverability-and-coverage-2026-07-03 P-105).
 * The counterpart of `work-item:claimed:<id>`: an agent waiting to pick up a specific
 * orphaned / handed-back item awaits this and is WOKEN the moment it frees, instead of
 * polling. Fires from `releaseWorkItem` — the ONE path both `work_items:release` (voluntary)
 * AND the stale-claim reaper route through — so a reaper-freed item wakes waiters too.
 * Awaiter-only (no `to` push): the audience is whoever registered interest in this id.
 * Fire-and-forget; never throws.
 *
 * `announceClaimable` (EI-15019, default true — unchanged for every existing caller):
 * pass `false` for an INTERNAL claim-then-immediate-release round-trip that never
 * exposed any observable state change (the item was pool-claimable before the claim
 * AND after the release — e.g. claim-spec-store.ts's tier-3 issue-family fallback
 * claiming a row its OWN spec then rejects via the mandatory post-claim
 * matchesWorkItemClaimSpec recheck). Firing the broad `work-item:claimable` key for
 * that case carries zero new information (the item's real return-to-pool moment —
 * create/genuine-release/unblock/requeue — already announced it, or will), yet wakes
 * EVERY live awaiter on the canonical key for nothing. Live incident: EI-128
 * (harness:null, title matches a common `*p2p*` title-glob exclusion) got claimed +
 * quarantine-released by tier-3 every ~3-4min, broadcasting to all 7 live awaiters
 * each time. `claim:released:<id>` (the id-scoped, targeted key) still always fires —
 * suppressing only the broad pool-wide co-fire never drops a targeted waiter.
 */
export async function emitClaimReleasedEventAwaited(
  wi: WorkItem,
  deps: Pick<SettledEventsDeps, 'emit' | 'duplicateAdmissionCheck'> & { announceClaimable?: boolean } = {},
): Promise<void> {
  const emit = deps.emit ?? emitAwaitedEvent;
  const payload = workItemEventPayload({
    id: wi.id,
    state: wi.state,
    kind: wi.kind,
    harness: wi.harness,
    title: wi.title,
  });
  await Promise.resolve()
    .then(() =>
      emit({
        key: `claim:released:${wi.id}`,
        summary: `${wi.id} claim released — back to the pool: ${wi.title}`,
        payload,
        source: 'work-items',
      }),
    )
    .catch((e: unknown) => failSoft(`claim-released-event for ${wi.id}`, e));
  // P-007: a released item is back in the pool — co-fire the canonical claimable
  // key (the guard drops rows that released into a non-claimable end state).
  // EI-15019: skip the co-fire when the caller says this round-trip is internal-only.
  // EI-18146409983480148: some items have a legitimate "release again, a future
  // holder/auto-close will pick it up once an external condition clears" disposition
  // (a still-stale watchdog metric, a pending decay window) — a rotating cast of
  // agents re-claims, re-investigates, and re-releases the SAME item every few
  // minutes, and every release re-wakes EVERY live `work-item:claimable` awaiter
  // for zero new information (observed: 3 broad wakes on one item in <30min). The
  // targeted `claim:released:<id>` key above still fires unconditionally — an
  // agent awaiting THIS specific id is never starved; only the broad pool-wide
  // co-fire is throttled per item.
  if (deps.announceClaimable !== false && shouldFireClaimableRelease(wi.id)) {
    emitWorkItemClaimableEvent(wi, 'released', deps);
  }
}

/** Compatibility wrapper for callers that deliberately do not await delivery. */
export function emitClaimReleasedEvent(
  wi: WorkItem,
  deps: Pick<SettledEventsDeps, 'emit' | 'duplicateAdmissionCheck'> & { announceClaimable?: boolean } = {},
): void {
  void emitClaimReleasedEventAwaited(wi, deps);
}

/** In-process per-item throttle for the broad `work-item:claimable` co-fire on a
 *  voluntary release (EI-18146409983480148) — see emitClaimReleasedEvent. A
 *  rate-limiter, not a durable record: best-effort/in-process only (resets on
 *  restart), bounded eviction on overflow rather than swept every call. A missed
 *  throttle just costs one extra wake; a false-positive throttle never loses a
 *  claim — the item stays fully claimable by id or a fresh scheduler:get_next
 *  pull (its own claim-eligibility floors are unaffected, see releaseCooldownSec
 *  in work-items.ts for the separate SAME-releaser re-claim cooldown this is not). */
const CLAIMABLE_RELEASE_THROTTLE_MS = Math.max(
  0,
  Number(process.env.PAPERCUSP_CLAIMABLE_RELEASE_THROTTLE_MS ?? 5 * 60_000),
);
const CLAIMABLE_RELEASE_THROTTLE_MAX_ENTRIES = 5000;
const lastClaimableReleaseFireAt = new Map<string, number>();

function shouldFireClaimableRelease(id: string): boolean {
  if (CLAIMABLE_RELEASE_THROTTLE_MS <= 0) return true;
  const now = Date.now();
  const last = lastClaimableReleaseFireAt.get(id);
  if (last !== undefined && now - last < CLAIMABLE_RELEASE_THROTTLE_MS) return false;
  if (lastClaimableReleaseFireAt.size >= CLAIMABLE_RELEASE_THROTTLE_MAX_ENTRIES) {
    const cutoff = now - CLAIMABLE_RELEASE_THROTTLE_MS * 4;
    for (const [k, t] of lastClaimableReleaseFireAt) if (t < cutoff) lastClaimableReleaseFireAt.delete(k);
  }
  lastClaimableReleaseFireAt.set(id, now);
  return true;
}

/** Test-only: clear the in-process release throttle so tests reusing an item id
 *  across cases don't cross-contaminate. Not exported from the package surface. */
export function __resetClaimableReleaseThrottleForTests(): void {
  lastClaimableReleaseFireAt.clear();
}

/**
 * `work-item:blocked:<id>` — fired when an item transitions INTO `blocked`
 * (the durable "I can't proceed" record — see the repo guide's don't-silently-
 * defer rule). The delegator (assignedBy) is notified so blocked work is never
 * a prose message that scrolls away. Fire-and-forget; never throws.
 */
export function emitWorkItemBlockedEvent(wi: WorkItem, deps: Pick<SettledEventsDeps, 'emit'> = {}): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  const notify = wi.assignedBy && wi.assignedBy !== wi.assignee ? [wi.assignedBy] : [];
  const payload = workItemEventPayload({
    id: wi.id,
    state: wi.state,
    kind: wi.kind,
    harness: wi.harness,
    title: wi.title,
  });
  void trackDetached(Promise.resolve()
    .then(() =>
      emit({
        key: `work-item:blocked:${wi.id}`,
        summary: `${wi.id} is BLOCKED: ${wi.title}`,
        payload,
        to: notify,
        source: 'work-items',
      }),
    )
    .catch((e: unknown) => failSoft(`blocked-event for ${wi.id}`, e)));
}

/**
 * `work-item:status:<id>` — fired on EVERY real status transition of a work item
 * (event-await-discoverability-and-coverage-2026-07-03 P-101). The GENERAL
 * transition signal that answers "wake me on ANY change of WI-X" — a dependency's
 * progress, a peer's item, an issue moving through triage — in ONE await, instead
 * of polling `work_items:get`. It CO-fires with the specific keys
 * (`work-item:done` / `:blocked` / `:unblocked` / `:claimed`); per the catalog's
 * one-entry-one-family model those are never awaited together, so an agent picks
 * either the general key OR a specific one and is woken exactly once per
 * transition. `payload.prevState` + `payload.state` carry the edge so the waiter
 * needn't re-read. Fire-and-forget; never throws.
 */
export function emitWorkItemStatusEvent(
  wi: WorkItem,
  prevState: string,
  deps: Pick<SettledEventsDeps, 'emit' | 'duplicateAdmissionCheck'> & { announceClaimable?: boolean } = {},
): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  const payload = workItemEventPayload({
    id: wi.id,
    state: wi.state,
    prevState,
    kind: wi.kind,
    harness: wi.harness,
    title: wi.title,
  });
  void trackDetached(Promise.resolve()
    .then(() =>
      emit({
        key: `work-item:status:${wi.id}`,
        summary: `${wi.id} ${prevState} → ${wi.state}: ${wi.title}`,
        payload,
        source: 'work-items',
      }),
    )
    .catch((e: unknown) => failSoft(`status-event for ${wi.id}`, e)));
  // WI-4180 (the P-007 audit's gap (A), owner-requested close): a bare state
  // flip INTO a claimable state (blocked→todo, a done→open reopen) is the
  // fourth return-to-pool moment — it used to fire only this general key,
  // stranding a parked `work-item:claimable` waiter to its ~30-min timeout
  // backstop. Co-fired HERE, inside the sibling emitter (ONE import edge —
  // the vitest-4 same-literal-double-import paradox, EI-9658), behind an
  // ENTERING-EDGE guard: a move BETWEEN claimable states (todo→open) must not
  // re-announce an already-advertised row; the claimable emitter's own guard
  // still drops assigned rows and non-claimable landing states.
  if (deps.announceClaimable !== false && !CLAIMABLE_STATES.has(prevState)) {
    emitWorkItemClaimableEvent(wi, 'requeued', deps);
  }
}

export function isSettledWorkItem(wi: Pick<WorkItem, 'family' | 'state'>): boolean {
  // WI-4034: single-source the predicate from the two canonical family sets.
  // Do not aggregate them into a module-local top-level const: this module's
  // documented work-items import cycle can expose the hoisted function during
  // evaluation, and a call in that window hits the const's temporal dead zone
  // (`Cannot access 'SETTLED_STATES' before initialization`, EI-21222540632840457).
  // The imported leaf sets are cycle-free and are read only when invoked.
  return (wi.family === 'feature' ? TERMINAL_STATUSES : ISSUE_TERMINAL_STATUSES).has(wi.state);
}

/** Reverse of workItemObjectRef: a coord ObjectRef back to (id, harness). */
export function workItemIdFromRef(ref: { kind: string; ref: string }): { id: string; harness?: string } | null {
  if (ref.kind === FEATURE_KIND) {
    const i = ref.ref.indexOf('#');
    if (i <= 0) return null;
    return { id: ref.ref.slice(i + 1), harness: ref.ref.slice(0, i) };
  }
  if (ref.kind === 'issue') return { id: ref.ref };
  return null;
}

/** Injectable seams for tests. Edge reads go through the work-item-blocking
 *  seam (P-005) — this module owns NO store of its own. */
export interface SettledEventsDeps {
  emit?: typeof emitAwaitedEvent;
  /** EI-22727753112811582: duplicate-screening floor for claimable emits/latches. */
  duplicateAdmissionCheck?: DuplicateAdmissionCheck;
  /** WI-22699169150878155: injectable parity check so claimable lifecycle events do not
   * advertise a row whose linked plan-item lane is blocked/owner-gated/terminal. */
  planItemLaneBlockReason?: PlanItemLaneBlockReason;
  /** WI-10005020 (D-008 #4b): parity check so a claimable event never advertises a row whose
   * `blocks` dependency edges are still unsatisfied (the scheduler's claim floor excludes it). */
  unresolvedDependencyCheck?: UnresolvedDependencyCheck;
  getItem?: typeof getWorkItem;
  listOut?: BlockingEdgeReader['listOut'];
  listIn?: BlockingEdgeReader['listIn'];
  /**
   * Holder from immediately before the terminal state write. Terminal writes
   * release the row's assignee, but the fleet-scoped completion event must be
   * attributed to the holder that actually settled it.
   */
  priorAssignee?: string | null;
  /** Batched in-edge read; when absent it is DERIVED from `listIn` (test compat). */
  listInMany?: BlockingEdgeReader['listInMany'];
  /** P-010: inject-notify a fix-target's subscribers. Default = fanoutForObject
   *  (lazy-imported to avoid a static import cycle); tests inject a stub. */
  notifySubscribers?: NotifySubscribers;
  /** EI-20271572335296930: reconcile the exact owner-facing alert created for
   *  this critical item. Tests inject the resolver; production lazy-imports the
   *  escalation adapter so the settle event module stays cycle-safe. */
  reconcileCriticalWorkItemAlert?: (wi: WorkItem) => Promise<void>;
  /** Stable-agent successor dispatch; production resolves the shared composite lazily. */
  dispatchActionable?: typeof assignAndWakeActionableWorkItems;
}

/** The terminal work-item row carries this token until its matching done fire
 * is durably latched. Both family projections already return payload. */
export const WORK_ITEM_COMPLETION_EVENT_INTENT_KEY = '_completionEventIntentId';

export function completionEventIntentIdOf(wi: WorkItem): string | null {
  const payload = wi.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[WORK_ITEM_COMPLETION_EVENT_INTENT_KEY];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function defaultDispatchActionable(
  ...args: Parameters<typeof assignAndWakeActionableWorkItems>
): ReturnType<typeof assignAndWakeActionableWorkItems> {
  const { assignAndWakeActionableWorkItems: dispatch } =
    await import('./agent-tools/coordination/actionable-work-item-dispatch');
  return dispatch(...args);
}

/** Read the optional direct-execution target stamped on a promoted run item. */
export function planRunExecutionTarget(payload: unknown): AgenticPlanExecutionTarget | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const planRun = (payload as Record<string, unknown>).plan_run;
  if (planRun === null || typeof planRun !== 'object' || Array.isArray(planRun)) return null;
  return parseAgenticPlanExecutionTarget((planRun as Record<string, unknown>).execution);
}

/** Inject-notify the subscribers of an object (P-010) — the fanoutForObject shape. */
type NotifySubscribers = (object: ObjectRef, ev: InjectEvent) => Promise<number>;

/** Default subscriber-notify: the shared best-effort fan-out. Lazy-imported so
 *  this module carries no static edge to the fan-out projection (cycle-safe). */
async function defaultNotifySubscribers(object: ObjectRef, ev: InjectEvent): Promise<number> {
  const { fanoutForObject } = await import('./sync/hyperbee/fanout-projection');
  return fanoutForObject(object, ev);
}

// work-items.ts lazy-imports this module while this module imports work-items.ts.
// A settled-item callback can re-enter before top-level const initialization is
// complete, so keep these identifiers behind hoisted declarations rather than
// triggering a TDZ error during otherwise valid alert reconciliation.
function criticalWorkItemAlertSubject(workItemId: string): string {
  return `critical-wi-alert:${workItemId}`;
}

function criticalWorkItemAlertResolver(): string {
  return 'system:work-item-settle';
}

type OpenCriticalWorkItemAlert = {
  msg_id: string;
  subjectSignature?: unknown;
};

type CriticalWorkItemAlertDeps = {
  listOpen?: () => Promise<readonly OpenCriticalWorkItemAlert[]>;
  listOpenBySubject?: (subjectSignature: string) => Promise<readonly OpenCriticalWorkItemAlert[]>;
  resolveBatch?: (items: readonly BatchResolveItem[]) => Promise<unknown>;
};

/**
 * Select only the alert whose SUBJECT is this item. Do not match arbitrary
 * mentions: watchdog escalations legitimately cite settled work-item ids as
 * context for a newer incident (EI-20271572335296930's correction).
 */
export function selectCriticalWorkItemAlerts(
  opens: readonly OpenCriticalWorkItemAlert[],
  workItemId: string,
): OpenCriticalWorkItemAlert[] {
  const subject = criticalWorkItemAlertSubject(workItemId);
  return opens.filter((open) => open.subjectSignature === subject);
}

/**
 * Resolve the exact critical-item creation alert after the item settles. The
 * operation is idempotent and intentionally does not touch other escalation
 * kinds, including cards whose prose merely mentions this item's id.
 */
export async function reconcileCriticalWorkItemAlert(
  wi: Pick<WorkItem, 'id' | 'family' | 'state' | 'severity' | 'completionAuthority'>,
  deps: CriticalWorkItemAlertDeps = {},
): Promise<void> {
  if (!isSettledWorkItem(wi)) return;

  const adapter = await import('./agent-tools/coordination/escalations');
  const subject = criticalWorkItemAlertSubject(wi.id);
  const listOpen =
    deps.listOpen ??
    (deps.listOpenBySubject
      ? () => deps.listOpenBySubject!(subject)
      : async () => (await adapter.listOpenEscalationsBySubjectSignature(subject)) as OpenCriticalWorkItemAlert[]);
  const resolveBatch = deps.resolveBatch ?? adapter.resolveEscalationsBatch;
  const matches = selectCriticalWorkItemAlerts(await listOpen(), wi.id);
  if (matches.length === 0) return;

  // Terminal state and committed completion are separate lifecycle facts. A
  // close with proposed/unknown authority is out of the claimable pool, but
  // its evidence still needs settlement reconciliation; calling that row
  // "settled" makes the alert wake look like committed completion and caused
  // agents to trust dirty completion rows (EI-23193531614704959). Reserve the
  // settled wording for the same authority that emits work-item:settled:<id>.
  const committed = wi.completionAuthority === 'committed';
  const choice = committed ? 'work-item-settled' : 'work-item-terminal';
  const note = committed
    ? `${wi.id} settled; its creation alert is no longer an active owner-facing condition`
    : `${wi.id} reached terminal state with completion authority '${wi.completionAuthority ?? 'unknown'}'; its creation alert is cleared while completion evidence remains unsettled`;

  await resolveBatch(
    matches.map((open) => ({
      msg_id: open.msg_id,
      choice,
      resolver: criticalWorkItemAlertResolver(),
      note,
    })),
  );
}

/**
 * Resolve the batched in-edge reader: an injected `listInMany` wins; else an
 * injected per-dst `listIn` is lifted into a batch (existing tests inject only
 * `listIn` and stay a faithful spec of the shared core); else the seam reader.
 */
function resolveListInMany(deps: Pick<SettledEventsDeps, 'listIn' | 'listInMany'>): BlockingEdgeReader['listInMany'] {
  if (deps.listInMany) return deps.listInMany;
  const listIn = deps.listIn;
  if (listIn) return async (dsts, opts) => (await Promise.all(dsts.map((d) => listIn(d, opts)))).flat();
  return blockingEdgeReader.listInMany;
}

/** (kind, ref) identity for grouping/dedup — refs are opaque, kinds disjoint. */
const refKey = (r: ObjectRef): string => `${r.kind}\0${r.ref}`;

/**
 * WI-4034: for each dependent in `dstRefs` that is NOT itself settled and has
 * NO other live (non-settled) `blocks` edge into it beyond one from
 * `clearedById`, EMIT `work-item:unblocked:<dst>`.
 *
 * Single-sourced by BOTH callers below: the settle path (the just-settled
 * item's own edges are still PRESENT in the store when this runs — excluded by
 * id) and the unlink path (the triggering edge has ALREADY been removed from
 * the store by the time this runs, so nothing needs excluding — passing the
 * id is harmless either way). Extracted so the two call sites can never
 * silently diverge on what "last live blocker" means.
 *
 * Batched (P-005): ONE `listInMany` query fetches every dependent's in-edges
 * (the old shape was a per-dst listIn + per-blocker getItem — N+1 on a fan-out
 * settle), then each distinct work-item is fetched ONCE, in parallel (no bulk
 * getWorkItem exists — dedup is the available batching).
 */
async function emitUnblockedForClearedEdges(
  dstRefs: readonly ObjectRef[],
  clearedById: string,
  emit: typeof emitAwaitedEvent,
  getItem: typeof getWorkItem,
  listInMany: BlockingEdgeReader['listInMany'],
  dispatchActionable: typeof assignAndWakeActionableWorkItems,
  duplicateAdmissionCheck?: DuplicateAdmissionCheck,
): Promise<void> {
  // Dedup dsts — a duplicate src→dst edge must not double-emit for one dependent.
  const dsts = [...new Map(dstRefs.map((r) => [refKey(r), r])).values()];
  if (dsts.length === 0) return;

  const inEdges = await listInMany(dsts, { rel: 'blocks' });
  const edgesByDst = new Map<string, LinkRow[]>();
  for (const e of inEdges) {
    const k = refKey(e.dst);
    const arr = edgesByDst.get(k);
    if (arr) arr.push(e);
    else edgesByDst.set(k, [e]);
  }

  // Every item the checks below consult — dependents + candidate blockers (the
  // cleared one never is) — fetched once per unique (id, harness), in parallel.
  const wantKey = (w: { id: string; harness?: string }) => `${w.id}\0${w.harness ?? ''}`;
  const wanted = new Map<string, { id: string; harness?: string }>();
  for (const d of dsts) {
    const w = workItemIdFromRef(d);
    if (w) wanted.set(wantKey(w), w);
  }
  for (const e of inEdges) {
    const w = workItemIdFromRef(e.src);
    if (w && w.id !== clearedById) wanted.set(wantKey(w), w);
  }
  const fetched = new Map<string, WorkItem | null>();
  await Promise.all(
    [...wanted.entries()].map(async ([k, w]) => {
      fetched.set(k, await getItem(w.id, w.harness).catch(() => null));
    }),
  );
  const itemFor = (ref: ObjectRef): WorkItem | null => {
    const w = workItemIdFromRef(ref);
    return w ? (fetched.get(wantKey(w)) ?? null) : null;
  };

  for (const dstRef of dsts) {
    const dependent = itemFor(dstRef);
    if (!dependent || isSettledWorkItem(dependent)) continue;

    const stillBlocked = (edgesByDst.get(refKey(dstRef)) ?? []).some((be) => {
      const src = workItemIdFromRef(be.src);
      if (!src || src.id === clearedById) return false; // the one that just cleared
      const blocker = itemFor(be.src);
      return Boolean(blocker && !isSettledWorkItem(blocker)); // still genuinely blocked
    });
    if (stillBlocked) continue;

    const execution = dependent.assignee ? null : planRunExecutionTarget(dependent.payload);
    let dispatchFailure: unknown = null;
    if (execution) {
      try {
        const dispatched = await dispatchActionable({
          workItemIds: [dependent.id],
          targetAgent: execution.agentName,
          harness: execution.appHarnessSlug,
          summary: `${dependent.id} became actionable after ${clearedById} settled`,
          source: 'system:plan-run-successor-dispatch',
          // WI-10004815: `dependent` is a snapshot read before this call. The
          // plan-lane restore (system:plan-run-lane-dispatch) can assign and
          // wake the same stable agent inside that window. The claim inside the
          // dispatch is the real check, so only the writer whose claim actually
          // assigns the row spends the wake; a retained row is not woken twice.
          wakeRetained: false,
        });
        if (!dispatched.ok) {
          dispatchFailure = new Error(
            dispatched.failure?.message ?? dispatched.warning ?? 'stable-agent successor dispatch failed',
          );
        }
      } catch (error) {
        dispatchFailure = error;
      }
    }

    // Dispatch first so a waiter woken by the canonical unblocked edge cannot
    // win a generic claim race against the configured stable agent.
    await emit({
      key: `work-item:unblocked:${dependent.id}`,
      summary: `${dependent.id} is UNBLOCKED — its last blocker (${clearedById}) cleared: ${dependent.title}`,
      payload: workItemEventPayload({
        id: dependent.id,
        clearedBy: clearedById,
        harness: dependent.harness,
        title: dependent.title,
      }),
      to: dependent.assignee ? [dependent.assignee] : [],
      source: 'work-items',
    });
    await import('./interest-auto-arm')
      .then(({ retireInterestEventAwaits }) =>
        retireInterestEventAwaits({ kind: 'work-item-blocked', ref: dependent.id }),
      )
      .catch(() => {});
    if (execution) {
      if (dispatchFailure) failSoft(`agentic successor dispatch for ${dependent.id}`, dispatchFailure);
      continue;
    }
    // P-007: an unblocked dependent may have just become pool-claimable — the
    // canonical key co-fires here so BOTH unblock paths (settle + unlink) are
    // covered; the emitter's own guard drops assigned / non-claimable items.
    emitWorkItemClaimableEvent(dependent, 'unblocked', { emit, duplicateAdmissionCheck });
  }
}

/**
 * linking-notify-family-hardening P-006: live blocked-state probe for the
 * `events:await` registration LATCH on `work-item:unblocked:<id>` keys. That
 * event fires only on a blocked→unblocked EDGE, so awaiting it for an item
 * that is ALREADY unblocked (or settled) registers a wait that can only time
 * out — the same stranding the EI-9270 announced-gate latch closes for
 * declared keys. The reading keeps the target lifecycle and its dependency-edge
 * state separate: a target can be lifecycle-blocked with no `blocks` edge. The
 * old scalar result called that "unblocked" and advised proceeding through an
 * explicit manual/owner boundary (EI-21581161723225407). Callers may
 * short-circuit only when `verdict` is `unblocked` or `settled`.
 *
 * Best-effort by contract: 'unknown' (unreadable / ambiguous id, e.g. a feature
 * id whose harness the key doesn't carry) must never block a registration —
 * callers treat it as "go ahead and register".
 */
export type LiveBlockedStateProbe =
  | {
      verdict: 'blocked' | 'unblocked' | 'settled';
      lifecycleState: string;
      dependencyState: 'blocked' | 'unblocked' | 'not-applicable';
    }
  | {
      verdict: 'unknown';
      lifecycleState?: string;
      dependencyState: 'unknown';
    };

function isLifecycleBlockedState(state: string): boolean {
  // `needs-human` is the other non-terminal lifecycle state that explicitly
  // parks an item at an owner boundary. Keep the legacy underscore spelling
  // fail-safe as well; normalized rows use the hyphenated token.
  return state === 'blocked' || state === 'needs-human' || state === 'needs_human';
}

export async function liveBlockedState(
  id: string,
  deps: Pick<SettledEventsDeps, 'getItem' | 'listIn'> = {},
): Promise<LiveBlockedStateProbe> {
  const getItem = deps.getItem ?? getWorkItem;
  const listIn = deps.listIn ?? blockingEdgeReader.listIn;
  try {
    const item = await getItem(id, undefined).catch(() => null);
    if (!item) return { verdict: 'unknown', dependencyState: 'unknown' };
    if (isSettledWorkItem(item)) {
      return { verdict: 'settled', lifecycleState: item.state, dependencyState: 'not-applicable' };
    }
    const edges = await listIn(workItemObjectRef(item), { rel: 'blocks' });
    let dependencyState: 'blocked' | 'unblocked' = 'unblocked';
    for (const be of edges) {
      const src = workItemIdFromRef(be.src);
      if (!src) continue;
      const blocker = await getItem(src.id, src.harness).catch(() => null);
      if (blocker && !isSettledWorkItem(blocker)) {
        dependencyState = 'blocked';
        break;
      }
    }
    return {
      verdict: isLifecycleBlockedState(item.state) || dependencyState === 'blocked' ? 'blocked' : 'unblocked',
      lifecycleState: item.state,
      dependencyState,
    };
  } catch {
    return { verdict: 'unknown', dependencyState: 'unknown' };
  }
}

/**
 * The `work-item:done:<id>` registration LATCH probe (EI-13095, 2026-07-16 —
 * the WI-5075 stranded-await incident): `work-item:done:<id>` fires ONCE, at the
 * moment the item settles, so an await registered AFTER the settle can only ever
 * time out — the same await-after-the-fact strand the EI-9270 announced-gate
 * latch and the P-006 unblocked latch close for their keys. The work-item row
 * itself is the durable latch state (no event-log scan needed): if the item is
 * ALREADY settled, the event this caller wants has already happened. Lean by
 * design (no edge reads — settledness needs only the item row); 'unknown'
 * (unreadable / ambiguous id) must never block a registration.
 */
export async function liveSettledProbe(
  id: string,
  deps: Pick<SettledEventsDeps, 'getItem'> = {},
): Promise<{ verdict: 'settled' | 'live' | 'unknown'; itemState?: string }> {
  const getItem = deps.getItem ?? getWorkItem;
  try {
    const item = await getItem(id, undefined).catch(() => null);
    if (!item) return { verdict: 'unknown' };
    return { verdict: isSettledWorkItem(item) ? 'settled' : 'live', itemState: item.state };
  } catch {
    return { verdict: 'unknown' };
  }
}

/**
 * The SELF-AWAIT guard's probe (EI-18731480441007330 — the WI-6095 unbreakable
 * self-deadlock incident): an agent can hold a work-item as its own assignee
 * AND register an `events:await` on that same item's `work-item:status:<id>` /
 * `work-item:done:<id>` key — but that key can only fire when the awaiter
 * itself acts on the item (completes / transitions it), so the wait is
 * unsatisfiable by construction: a permanent self-deadlock that no fleet
 * health check surfaces (the resulting verdict looks identical to a
 * legitimate wait on a peer's work). Mirrors `liveSettledProbe`'s settledness
 * check (a settled item is never a deadlock risk — its key already fired or
 * never will) and additionally surfaces the current assignee so the caller
 * can compare it against its own identity. 'unknown' (unreadable / ambiguous
 * id) must never block a registration.
 */
export async function liveAssigneeProbe(
  id: string,
  deps: Pick<SettledEventsDeps, 'getItem'> = {},
): Promise<{ verdict: 'settled' | 'live' | 'unknown'; assignee?: string | null }> {
  const getItem = deps.getItem ?? getWorkItem;
  try {
    const item = await getItem(id, undefined).catch(() => null);
    if (!item) return { verdict: 'unknown' };
    return { verdict: isSettledWorkItem(item) ? 'settled' : 'live', assignee: item.assignee ?? null };
  } catch {
    return { verdict: 'unknown' };
  }
}

/**
 * WI-4034 DEFECT 1 (the unlink gap): `unlinkWorkItem` deleted a `blocks` edge
 * and returned — nothing ever re-checked whether that removal was the
 * dependent's LAST live blocker, so an `events:await('work-item:unblocked:<dep>')`
 * registrant never woke on an UNLINK (only on the blocker SETTLING) — a silent
 * strand to the awaiter's 30-min timeout-wake. Call this fire-and-forget
 * immediately after a successful `rel==='blocks'` unlink (mirrors the
 * settle-path's fire-and-forget shape in work-items.ts); `dst`'s remaining
 * blockers are re-checked with the edge ALREADY gone from the store. Never
 * throws.
 */
export async function emitUnblockedOnEdgeRemoved(
  dst: ObjectRef,
  clearedById: string,
  deps: Pick<
    SettledEventsDeps,
    'emit' | 'getItem' | 'listIn' | 'listInMany' | 'dispatchActionable' | 'duplicateAdmissionCheck'
  > = {},
): Promise<void> {
  const emit = deps.emit ?? emitAwaitedEvent;
  const getItem = deps.getItem ?? getWorkItem;
  try {
    await emitUnblockedForClearedEdges(
      [dst],
      clearedById,
      emit,
      getItem,
      resolveListInMany(deps),
      deps.dispatchActionable ?? defaultDispatchActionable,
      deps.duplicateAdmissionCheck,
    );
  } catch (e) {
    failSoft(`unlink-unblocked-event for ${clearedById}`, e);
  }
}

/**
 * linking-notify-family-hardening P-010 (WI-4014 Part 3 owner-fork, resolved as
 * Option A): when an item SETTLES, notify across its fixes/duplicates edges.
 * INJECT-ONLY (the wake-vs-inject axis, D-001) — settle-notify never wakes;
 * anyone who needs a WAKE uses events:await on work-item:done:<id>.
 *
 *  - `fixes` (wi FIXES target — an OUTGOING edge): the fix just landed, so
 *    inject-notify the FIXED target's existing SUBSCRIBERS ("the fix for your
 *    issue settled"). Routed through the shared subscriber fan-out, which reaches
 *    issue- AND feature-family subscribers uniformly; isResolution:true so even
 *    mention-mode followers receive this lifecycle resolution.
 *  - `duplicates` (dup DUPLICATES wi — an INCOMING edge; wi is the canonical):
 *    the canonical settled, so inject-notify each duplicate-holder's ASSIGNEE
 *    ("the item you were a duplicate of resolved"), keyed
 *    work-item:duplicate-settled:<wi> — a targeted `to`, not a subscriber fan-out.
 *
 * Fire-and-forget; the caller wraps this in its own failSoft scope (P-008) so a
 * notify failure can never drop the sibling done / unblocked emits.
 *
 * Only reads edges at settle time (no writes) — deliberately NOT the
 * subscribe{followBlockers} branch (Option B), which adds writes to the link hot
 * path and is deferred per D-003 until the work_item_deps backend flip.
 */
async function emitFixDuplicateSettledNotify(
  wi: WorkItem,
  emit: typeof emitAwaitedEvent,
  getItem: typeof getWorkItem,
  listOut: BlockingEdgeReader['listOut'],
  listIn: BlockingEdgeReader['listIn'],
  notifySubscribers: NotifySubscribers,
): Promise<void> {
  const ref = workItemObjectRef(wi);

  // fixes: wi FIXES dst (outgoing) → tell the fixed target's subscribers.
  const fixEdges = await listOut(ref, { rel: 'fixes' });
  for (const fe of fixEdges) {
    const t = workItemIdFromRef(fe.dst);
    const target = t ? await getItem(t.id, t.harness).catch(() => null) : null;
    await notifySubscribers(fe.dst, {
      from: wi.assignee ?? 'substrate',
      subject: `${fe.dst.kind}:${fe.dst.ref}`,
      summary: `${target?.id ?? t?.id ?? fe.dst.ref} — its fix ${wi.id} settled → ${wi.state}: ${wi.title}`,
      notify_kind: 'work_item_fix_settled',
      isResolution: true,
    });
  }

  // duplicates: dup DUPLICATES wi (incoming); wi is the canonical → tell each
  // distinct duplicate-holder's assignee (never the canonical's own agent).
  const dupEdges = await listIn(ref, { rel: 'duplicates' });
  const dupAssignees = new Set<string>();
  for (const de of dupEdges) {
    const s = workItemIdFromRef(de.src);
    const dup = s ? await getItem(s.id, s.harness).catch(() => null) : null;
    if (dup?.assignee && dup.assignee !== wi.assignee) dupAssignees.add(dup.assignee);
  }
  if (dupAssignees.size > 0) {
    await emit({
      key: `work-item:duplicate-settled:${wi.id}`,
      summary: `${wi.id} (the canonical item) settled → ${wi.state}: ${wi.title}`,
      payload: workItemEventPayload({
        id: wi.id,
        state: wi.state,
        kind: wi.kind,
        harness: wi.harness,
        title: wi.title,
      }),
      to: [...dupAssignees],
      source: 'work-items',
    });
  }
}

/** Share the id-scoped done payload and audience between normal settlement
 * and source reconciliation. A caller may await this unswallowed event write. */
export async function emitWorkItemDoneEvent(
  wi: WorkItem,
  deps: Pick<SettledEventsDeps, 'emit' | 'getItem'> = {},
): Promise<void> {
  const emit = deps.emit ?? emitAwaitedEvent;
  const getItem = deps.getItem ?? getWorkItem;
  const notifyDone = new Set<string>();
  if (wi.assignedBy && wi.assignedBy !== wi.assignee) notifyDone.add(wi.assignedBy);
  if (wi.parent) {
    const parent = await getItem(wi.parent, wi.harness ?? undefined).catch(() => null);
    if (parent?.assignee && parent.assignee !== wi.assignee) notifyDone.add(parent.assignee);
  }
  const completionIntentId = completionEventIntentIdOf(wi);
  await emit({
    key: `work-item:done:${wi.id}`,
    summary: `${wi.id} reached terminal state '${wi.state}' (completion authority: ${wi.completionAuthority ?? 'unknown'}): ${wi.title}`,
    payload: workItemEventPayload({
      id: wi.id,
      state: wi.state,
      kind: wi.kind,
      harness: wi.harness,
      title: wi.title,
      completionAuthority: wi.completionAuthority,
      ...(completionIntentId ? { completionIntentId } : {}),
    }),
    to: [...notifyDone],
    source: 'work-items',
  });
}

/**
 * WI-10003631: `listOut`/`listIn` stand-ins for ONE settle that answer the three
 * settle edge queries (blocks out, fixes out, duplicates in) for `ref` from a single
 * lazy prefetch (`readSettleEdges`), and pass every other query straight to the
 * production reader. A failed prefetch is not cached as an answer: it falls back to
 * the live per-relation read, so each fail-soft scope sees the same error it would
 * have seen before.
 */
export function settleEdgeReadersFor(
  ref: ObjectRef,
  read: (ref: ObjectRef) => Promise<SettleEdges> = readSettleEdges,
  fallback: Pick<BlockingEdgeReader, 'listOut' | 'listIn'> = blockingEdgeReader,
): Pick<BlockingEdgeReader, 'listOut' | 'listIn'> {
  let prefetch: Promise<SettleEdges | null> | null = null;
  const edges = () => (prefetch ??= read(ref).catch(() => null));
  const same = (r: ObjectRef) => r.kind === ref.kind && r.ref === ref.ref;
  return {
    listOut: async (src, opts) => {
      const rel = opts?.rel;
      if (same(src) && (rel === 'blocks' || rel === 'fixes')) {
        const e = await edges();
        if (e) return rel === 'blocks' ? e.blocksOut : e.fixesOut;
      }
      return fallback.listOut(src, opts);
    },
    listIn: async (dst, opts) => {
      if (same(dst) && opts?.rel === 'duplicates') {
        const e = await edges();
        if (e) return e.duplicatesIn;
      }
      return fallback.listIn(dst, opts);
    },
  };
}

/**
 * Fire the settled-item events for `wi` (which has ALREADY transitioned to a
 * settled state). Never throws.
 */
export async function emitWorkItemSettledEvents(wi: WorkItem, deps: SettledEventsDeps = {}): Promise<void> {
  const emit = deps.emit ?? emitAwaitedEvent;
  const getItem = deps.getItem ?? getWorkItem;
  // WI-10003631: with the production readers, the three settle edge reads (blocks
  // out, fixes out, duplicates in) are served from ONE prefetch statement. Injected
  // readers keep their exact per-call behaviour.
  const settleEdgeReaders = deps.listOut || deps.listIn ? null : settleEdgeReadersFor(workItemObjectRef(wi));
  const listOut = deps.listOut ?? settleEdgeReaders?.listOut ?? blockingEdgeReader.listOut;
  const listIn = deps.listIn ?? settleEdgeReaders?.listIn ?? blockingEdgeReader.listIn;
  const listInMany = resolveListInMany(deps);
  const notifySubscribers = deps.notifySubscribers ?? defaultNotifySubscribers;
  const reconcileCriticalAlert = deps.reconcileCriticalWorkItemAlert ?? reconcileCriticalWorkItemAlert;

  // A critical item creation alert is about the item's live existence, so it
  // must leave the owner's attention surface when the item reaches a terminal
  // state. Keep this in its own fail-soft scope: alert cleanup is valuable, but
  // a coordination read/write must never make a settled-item notification fail.
  try {
    await reconcileCriticalAlert(wi);
  } catch (e) {
    failSoft(`critical-alert-reconcile for ${wi.id}`, e);
  }

  // Terminal writes clear the row's assignee inline before this fan-out runs.
  // Preserve the targeted wake for agents awaiting the claim to become free,
  // but do not announce the broad claimable pool: terminalization is not a
  // return-to-pool transition, and the item is already settled/non-claimable.
  if (deps.priorAssignee) {
    try {
      await emitClaimReleasedEventAwaited(wi, { emit, announceClaimable: false });
    } catch (e) {
      failSoft(`settled claim-release-event for ${wi.id}`, e);
    }
  }

  // P-008 (linking-notify-family-hardening) durability split: the done-emit and
  // the unblocked loop each run in their OWN fail-soft scope. A single try used
  // to wrap BOTH, so a throw while resolving/emitting `work-item:done` (a parent
  // getItem, or the emit itself) silently skipped the unblocked loop — every
  // dependent whose last blocker just cleared went un-woken because a SIBLING
  // notification failed. They are independent signals; one failing must not drop
  // the other. (Full outbox durability is deferred — D-003; this is the bounded
  // fix.) Both scopes route through the shared `failSoft` so expected teardown
  // noise (CONNECTION_ENDED / partial-schema "does not exist") stays silent.

  // ── work-item:done — the children-done / delegated-work signal ────────
  try {
    await emitWorkItemDoneEvent(wi, { emit, getItem });
  } catch (e) {
    failSoft(`settled done-event for ${wi.id}`, e);
  }

  // ── fleet:item-completed — the FLEET-scoped counterpart (P-009 / D-008) ──
  // `work-item:done:<id>` above is id-scoped: it serves a delegator awaiting a
  // SPECIFIC child, but a leader does not know which of its fleet's items will
  // finish next, so it had to poll leader-brief for burn-down. This fires
  // `fleet:item-completed:<slug>` for the settling holder's fleet. Its own
  // fail-soft scope (the P-008 durability split above): a fleet-notify failure
  // must never drop the sibling done / unblocked emits.
  try {
    const { announceFleetItemCompleted } = await import('./fleet-transition-events');
    announceFleetItemCompleted(wi, deps.priorAssignee);
  } catch (e) {
    failSoft(`settled fleet-completed for ${wi.id}`, e);
  }

  // ── work-item:unblocked — dependents whose LAST live blocker cleared ──
  try {
    const ref = workItemObjectRef(wi);
    const blockEdges = await listOut(ref, { rel: 'blocks' });
    await emitUnblockedForClearedEdges(
      blockEdges.map((e) => e.dst),
      wi.id,
      emit,
      getItem,
      listInMany,
      deps.dispatchActionable ?? defaultDispatchActionable,
      deps.duplicateAdmissionCheck,
    );
  } catch (e) {
    failSoft(`settled unblocked-loop for ${wi.id}`, e);
  }

  // ── fix/duplicate settle-notify (P-010) — its own fail-soft scope ─────
  try {
    await emitFixDuplicateSettledNotify(wi, emit, getItem, listOut, listIn, notifySubscribers);
  } catch (e) {
    failSoft(`settled fix/dup-notify for ${wi.id}`, e);
  }
}
