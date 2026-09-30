/**
 * control-core.ts — the shared engine behind fleet:wind-down / fleet:resume /
 * fleet:pause (coord-authority-hardening-2026-07-11 P-009 / H4).
 *
 * A fleet's wind-down is TYPED PLATFORM STATE, not a free-text broadcast:
 *   1. GUARD the invoker — owner (an `su` interactive session, the owner's own
 *      agent — the established owner-authority proxy), THAT fleet's recorded
 *      leader, or the queen (`mug` / `kettle` pane kinds). Everything else —
 *      cups, papercups, planners, peer-fleet automation — is refused: exactly
 *      the EI-9501 class (an unauthorized agent steering a fleet it doesn't
 *      own) this hardening plan exists to kill.
 *   2. PERSIST the control state on the durable registry row (mig 575:
 *      winding-down|active + reason + by + ts) — late joiners read it at
 *      orient, so control never depends on having been live for a message.
 *   3. CUE the live member set with a TYPED control message stamped
 *      fleet-scoped cueAuthority (fleetScopedCueAuthority — authority intrinsic
 *      to the action, like pot:pause's hive-wide stamp): binding for members,
 *      receive-side demoted (H1) for everyone else. Typed cues are binding;
 *      free-text "please pause" remains advisory by definition.
 *
 * The cue leg is best-effort BY CONTRACT: the registry write is the source of
 * truth, and a presence/send hiccup must never wedge the state flip.
 */
import { classifyAgentPane } from '@papercusp/agent-mcp';
import {
  fleetSlugFromName,
  getFleet,
  setFleetControlState,
  type AgentFleetRecord,
  type FleetControlState,
} from '../../agent-fleets-store';
import { sendMessage } from '../coordination/messages';
import { getPresence } from '../coordination/presence';
import {
  CUE_AUTHORITY_FIELD,
  EXPECTED_LIFECYCLE_ACK_FIELD,
  expectedFleetWindDownAck,
  fleetScopedCueAuthority,
} from '../coordination/cue-authority';
import { listFleetControlMembers } from '../coordination/audience-host';
import { resolveFleetCaller } from './_shared';
import { classifyFleetControlInvoker } from './fleet-auth';
import type { ResolveIdentityCtx } from '../coordination/identity';
import type { FleetPauseHoldResult } from './pause-holds';
import { withBoundedTimeout } from '../../bounded-timeout';
import {
  clearSessionBriefReleasedForFleet,
  markSessionBriefReleased,
} from '../../session-brief';
import { buildAnnouncedKey } from '../../events/await/announce-key';
import { FLEET_PARK_DEFAULT_RESUME_GATE } from '../../fleet-park-resume-path';

export type FleetControlAction = 'wind-down' | 'resume';

/** The durable controller marker written by the janitorial fleet reconcile routine. */
export const FLEET_CONTROL_RECONCILER = 'system:fleet-control-reconcile';

/**
 * A reconciler-owned winding-down fleet with no live members is terminal cleanup,
 * not a recoverable dead-leader handoff. Taking leadership there recreates the
 * stale-scope incident this control path is meant to avoid.
 */
export function isReconciledEmptyFleet(
  fleet: Pick<AgentFleetRecord, 'controlState' | 'controlBy'>,
  liveMemberIds: readonly string[],
): boolean {
  return (
    fleet.controlState === 'winding-down' &&
    fleet.controlBy === FLEET_CONTROL_RECONCILER &&
    liveMemberIds.length === 0
  );
}

const ACTION_TO_STATE: Record<FleetControlAction, FleetControlState> = {
  'wind-down': 'winding-down',
  resume: 'active',
};

/** Optional control-plane reads/writes must never hold the receipt path indefinitely. */
export const FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS = 2_000;
/** The typed state flip is durable before this bounded best-effort saga starts. */
export const FLEET_CONTROL_RESPONSE_TIMEOUT_MS = 5_000;

export interface FleetControlResult {
  ok: boolean;
  fleet?: string;
  controlState?: FleetControlState;
  reason?: string | null;
  by?: string;
  invokedAs?: 'leader' | 'queen' | 'owner';
  /** True when the fleet was ALREADY in the requested state — the row's
   *  reason/by/at were still refreshed, but no duplicate cue was sent. */
  alreadyInState?: boolean;
  /** Live members the typed cue was delivered to ([] = none live / cue skipped
   *  — the registry state still stands, and late joiners see it at orient). */
  notified?: string[];
  cueMsgId?: string | null;
  /** P-006 (work-item-claimability-clarity-2026-07-20): on a wind-down, the live
   *  scheduler-oracle drain snapshot auto-stamped onto the reason — the per-floor
   *  exclusion breakdown + the exact re-verify command. Absent when it could not be
   *  computed (fails soft) or the action was resume. */
  drainStamp?: import('./drain-stamp').FleetDrainStamp;
  /** EI-20199397615670608 / EI-21275382431686489: the claim-holds this control flip
   *  SET (resumable wind-down) or CLEARED (resume / terminal wind-down) on the fleet's
   *  work-items. Absent when nothing matched or the leg failed soft. */
  pauseHolds?: FleetPauseHoldResult;
  /** True when the durable state flip returned before optional release/cue work settled. */
  postControlPending?: boolean;
  /** True when the optional post-flip saga failed before it could return a receipt. */
  postControlDegraded?: boolean;
  /** WI-2034563: the park directive's declared way back, and — on a resume — whether
   *  the previously declared gate was actually fired. Absent when neither applies. */
  resumePath?: FleetControlResumePathReceipt;
  error?: string;
  message?: string;
}

/** What a control flip did about the park's resume path, reported so a leader never
 *  has to assume a gate was declared/fired that in fact was not. */
export interface FleetControlResumePathReceipt {
  /** The declared, latching gate key (wind-down) or the key that was fired (resume). */
  gate: string | null;
  /** wind-down: did the DECLARATION land? A gate is stored on the row only when it did,
   *  so the registry never advertises a key with no announcement behind it. */
  declared?: boolean;
  /** resume: did the emit of the previously declared gate land, and how many awaiters
   *  did it actually reach? `waiters: 0` means nobody was parked on it. */
  fired?: boolean;
  waiters?: number;
  /** Epoch ms the park is due to lift (wind-down only). */
  expiresAt?: number | null;
  /** True when this park was deliberately declared terminal — no gate, by design. */
  terminal?: boolean;
  /** Why a gate could not be declared/fired, when one was intended. */
  warning?: string;
}

// classifyFleetControlInvoker (the pure authority predicate) now lives in the dependency-free
// fleet-auth module (P-006), imported above for local use and re-exported here so every existing
// importer keeps its import path.
export { classifyFleetControlInvoker };

/** The member-facing body for each action's typed cue. */
export function fleetControlCueText(
  action: FleetControlAction,
  fleet: string,
  reason: string | null,
  byHandle: string,
  cueMsgId?: string,
  /** WI-2034563: the park's declared resume path, so the cue can name the exact key
   *  to await instead of telling every member to stop wake-less. */
  park?: { gate: string | null; expiresAt: number | null; terminal: boolean } | null,
): { summary: string; body: string } {
  if (action === 'wind-down') {
    const ackInstruction = cueMsgId
      ? `ack this exact cue with coord:ack { msg_id: '${cueMsgId}' }`
      : 'ack this exact cue with coord:ack { msg_id }';
    // WI-2034563: the stop instruction is the part that stranded ~23 members for
    // 2.5-6h. The old text ended at "loop:end … acknowledgeWakeLessAutonomy:true",
    // which is a correct way to comply and a guaranteed way to become unreachable:
    // the loop was the member's only wake source and nothing replaced it. When the
    // park declares a resume gate, the cue now hands over that exact key FIRST —
    // copied from the declaration, never retyped — so the member's stop leaves an
    // await behind and fleet:resume's fire is what wakes it.
    // The three cases are deliberately distinct, and the third is NOT the default:
    // an omitted `park` means the caller supplied no park information at all, which
    // must keep the historical wording rather than assert something about a park it
    // never read. Only a park that POSITIVELY declared no gate gets the warning.
    const historicalStop =
      'Then end any armed loop with loop:end. If an autonomy-implying mode remains active without a ' +
      'deliberate independent event await, retry with loop:end { acknowledgeOpenDirectives:true, ' +
      'acknowledgeWakeLessAutonomy:true }; alternatively register an events:await wake or exit the mode ' +
      'before ending the loop.';
    const stopInstruction = park?.gate
      ? `Then hand over your wake source BEFORE you stop: register events:await { event: '${park.gate}' } ` +
        '(copy that key EXACTLY — a retyped key never rendezvouses; it LATCHES, so registering after ' +
        'the lift still resolves immediately), and only then loop:end. That await IS your way back: ' +
        'fleet:resume fires this exact key. Do NOT pass acknowledgeWakeLessAutonomy — with the await ' +
        'registered you will not need it, and using it instead of the await is what leaves you unreachable.'
      : park?.terminal
        ? 'Then end any armed loop with loop:end. This park is TERMINAL — no resume is expected, so a ' +
          'wake-less stop is correct here; if an autonomy-implying mode remains active, retry with ' +
          'loop:end { acknowledgeOpenDirectives:true, acknowledgeWakeLessAutonomy:true }.'
        : park
          ? '⚠ This park declared NO resume gate, so nothing will wake you once you stop. ' + historicalStop +
            ' Prefer the await over the acknowledgement, and tell the leader which you chose.'
          : historicalStop;
    const deadline =
      park?.expiresAt != null
        ? ` The park is bounded: it is due to lift by ${new Date(park.expiresAt).toISOString()}.`
        : '';
    return {
      summary: `Fleet ${fleet} WIND-DOWN (typed control cue, by ${byHandle})${reason ? `: ${reason}` : ''}`,
      body:
        `Fleet ${fleet} is WINDING DOWN${reason ? ` — reason: ${reason}` : ''}. ` +
        'This is a TYPED, BINDING control cue [system-derived:fleet-control] ' +
        '(registry control_state=winding-down). ' +
        'Finish only the atomic step in hand, then: work_items:checkpoint + release your claims ' +
        '(or complete with evidence), and release your file locks. ' +
        `${stopInstruction}${deadline} Finally, ${ackInstruction}. ` +
        'That ack is a LIFECYCLE RECEIPT: it takes only msg_id and carries no free text, so do not ' +
        'attach a summary/note to it. Report your one-line disposition (or a blocker) as a SEPARATE ' +
        "coord:send { expects:'none', summary:'…' } — a plain inject, so like the lifecycle ack it " +
        'reaches the leader without re-invoking them. Do NOT pull new work from this fleet\'s lanes ' +
        'until a fleet:resume cue (control_state=active) lands.',
    };
  }
  return {
    summary: `Fleet ${fleet} RESUMED (typed control cue, by ${byHandle})${reason ? `: ${reason}` : ''}`,
    body:
      `Fleet ${fleet} is ACTIVE again${reason ? ` — ${reason}` : ''}. ` +
      'The wind-down is lifted (registry control_state=active): resume normal pull-work cadence ' +
      '(scheduler:get_next / your plan lane) and re-arm your loop if you ended it.',
  };
}

/** Compact agent handle for cue text — mirrors the [coord+N] short-handle form. */
function shortHandle(ownerId: string): string {
  return (ownerId ?? '').replace(/^su-/, '').slice(0, 5) || ownerId;
}

interface FleetControlPostSagaResult {
  effectiveReason: string | null;
  drainStamp?: import('./drain-stamp').FleetDrainStamp;
  pauseHolds?: FleetPauseHoldResult;
  notified: string[];
  cueMsgId: string | null;
  record?: AgentFleetRecord;
  degraded: boolean;
}

/** The park directive a wind-down is publishing, threaded through the post-saga so
 *  the cue text and the reason-stamp rewrite both see the SAME resolved path. The
 *  rewrite matters: setFleetControlState writes all three park columns on every
 *  winding-down write, so a refresh that omitted them would silently erase the gate
 *  moments after declaring it. */
export interface FleetParkDirectivePlan {
  gate: string | null;
  expiresAt: number | null;
  terminal: boolean;
}

/**
 * Start an optional leg and retain its original promise so a dependent leg can
 * wait for settlement after the caller has already received its bounded receipt.
 * `withBoundedTimeout` deliberately does not cancel work; keeping the promise here
 * lets the wind-down saga preserve pause-holds-before-cue even when the hold write
 * outlives the response budget.
 */
async function startBoundedOptional<T>(
  work: Promise<T> | (() => Promise<T>),
  opts: { fallback: T; timeoutMs: number; label: string },
): Promise<{
  result: Awaited<ReturnType<typeof withBoundedTimeout<T>>>;
  settled: Promise<T>;
}> {
  const settled = Promise.resolve().then(() => (typeof work === 'function' ? work() : work));
  return {
    result: await withBoundedTimeout(settled, opts),
    settled,
  };
}

/**
 * Best-effort work after the typed state flip. Resume-gate firing is deliberately
 * not part of this saga: it is the receipt-critical step in `applyFleetControl`
 * and must happen before any slow optional leg can consume the response budget.
 * This function keeps the remaining dependent legs ordered in the background if
 * one of the underlying promises outlives an individual optional-leg budget.
 */
async function runFleetControlPostSaga(args: {
  action: FleetControlAction;
  alreadyInState: boolean;
  ctx: ResolveIdentityCtx;
  effectiveReason: string | null;
  fleet: AgentFleetRecord;
  identity: Parameters<typeof sendMessage>[0];
  ownerId: string;
  slug: string;
  workspaceId: string;
  /** WI-2034563: the resume path this wind-down published (null on a resume). */
  park?: FleetParkDirectivePlan | null;
  opts?: {
    harness?: string | null;
    rigAvailable?: boolean;
    sessionHarness?: string | null;
  };
}): Promise<FleetControlPostSagaResult> {
  // A scheduler-oracle drain stamp describes the ISSUE-family lane. It is useful on
  // the fleet control row/cue, but it must never be copied into a FEATURE-family
  // work-item's claim_hold_reason. Preserve the caller-authored reason separately
  // before `effectiveReason` is augmented below.
  const pauseHoldReason = args.effectiveReason;
  let effectiveReason = args.effectiveReason;
  let drainStamp: import('./drain-stamp').FleetDrainStamp | undefined;
  let pauseHolds: FleetPauseHoldResult | undefined;
  let record: AgentFleetRecord | undefined;
  let degraded = false;

  if (args.action === 'wind-down') {
    const { buildFleetDrainStamp } = await import('./drain-stamp');
    const stampWork = await startBoundedOptional(
      () =>
        buildFleetDrainStamp({
          fleetSlug: args.slug,
          ownerId: args.ownerId,
          workspaceId: args.workspaceId,
          harnessCandidates: [
            args.opts?.harness,
            args.opts?.sessionHarness ?? (args.ctx as { harnessSlug?: string | null }).harnessSlug,
          ],
          rigAvailable: args.opts?.rigAvailable,
        }),
      { fallback: null, timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS, label: 'fleet:wind-down:drainStamp' },
    );
    if (stampWork.result.degraded) {
      degraded = true;
      // A late stamp must not race the hold/cue legs with a reason that may
      // otherwise be persisted below.
      await stampWork.settled.catch(() => null);
    }
    const stamp = stampWork.result.value;
    if (stamp) {
      drainStamp = stamp;
      effectiveReason = args.effectiveReason ? `${args.effectiveReason} | ${stamp.summary}` : stamp.summary;

      // The state boundary already landed. Refresh only the optional reason
      // metadata so the durable row retains the auto-drain stamp when it is
      // available, without putting the stamp read on the receipt's critical
      // path.
      const reasonWork = await startBoundedOptional(
        () =>
          setFleetControlState(
            args.workspaceId,
            args.slug,
            {
              state: ACTION_TO_STATE[args.action],
              reason: effectiveReason,
              by: args.ownerId,
              // WI-2034563: RE-SEND the park columns. This refresh is a full write of
              // every control_* field, so omitting them here would erase the resume
              // gate declared seconds earlier and hand members back the exact
              // no-way-back park this work exists to remove.
              resumeGate: args.park?.gate ?? null,
              expiresAt: args.park?.expiresAt ?? null,
              noResumePath: args.park?.terminal === true,
            },
            undefined,
            args.fleet.leaderOwnerId,
          ),
        {
          fallback: null,
          timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS,
          label: 'fleet:wind-down:reasonStamp',
        },
      );
      if (reasonWork.result.degraded) {
        degraded = true;
        await reasonWork.settled.catch(() => null);
      }
      if (reasonWork.result.value) record = reasonWork.result.value;
    }
  }

  const { applyFleetPauseHolds, clearFleetPauseHolds } = await import('./pause-holds');
  const pauseWork = await startBoundedOptional(
    () =>
      args.action === 'wind-down'
        ? args.park?.terminal === true
          ? // A terminal park has no successor resume edge. Setting durable holds here
            // strands the successor fleet forever; clear only this fleet's own marker
            // instead. The operation is idempotent, so a repeated terminal wind-down
            // also sweeps residue left by the pre-fix implementation.
            clearFleetPauseHolds({ fleetSlug: args.slug, workspaceId: args.workspaceId })
          : applyFleetPauseHolds({
              fleetSlug: args.slug,
              workspaceId: args.workspaceId,
              byOwnerId: args.ownerId,
              leaderOwnerId: args.fleet.leaderOwnerId,
              reason: pauseHoldReason,
            })
        : clearFleetPauseHolds({ fleetSlug: args.slug, workspaceId: args.workspaceId }),
    {
      fallback: null,
      timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS,
      label: `fleet:${args.action}:pauseHolds`,
    },
  );
  if (pauseWork.result.degraded) degraded = true;
  const held = pauseWork.result.value;
  if (held && (held.items.length > 0 || held.failed.length > 0)) pauseHolds = held;
  // The cue MUST remain after the hold promise settles. This wait happens in
  // the post-flip saga, so a slow hold cannot take the durable receipt down.
  if (pauseWork.result.degraded) await pauseWork.settled.catch(() => null);

  if (args.fleet.leaderOwnerId) {
    const { ensureFleetLeaderControl, retireFleetLeaderWatches } = await import('./leader-control');
    // The two branches return DIFFERENT types (a retired-watch count vs a control
    // outcome), so inference collapses `T` to whichever branch it sees first and then
    // rejects the other. Only `degraded` is read from this leg, so name the union
    // explicitly instead of forcing the branches to agree on a shape nobody consumes.
    const leaderWork = await startBoundedOptional<number | import('./leader-control').LeaderControlOutcome | null>(
      () =>
        args.action === 'wind-down'
          ? retireFleetLeaderWatches(args.fleet.leaderOwnerId!, args.slug)
          : ensureFleetLeaderControl({
              workspaceId: args.workspaceId,
              ownerId: args.fleet.leaderOwnerId!,
              fleetSlug: args.slug,
              harnessSlug: args.opts?.harness ?? (args.ctx as { harnessSlug?: string | null }).harnessSlug,
            }),
      {
        fallback: null,
        timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS,
        label: `fleet:${args.action}:leaderControl`,
      },
    );
    if (leaderWork.result.degraded) degraded = true;
  }

  let liveMembers: string[] | undefined;
  if (args.action === 'wind-down') {
    const membersWork = await startBoundedOptional(
      () => listFleetControlMembers(args.slug),
      { fallback: [] as string[], timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS, label: 'fleet:wind-down:members' },
    );
    if (membersWork.result.degraded) degraded = true;
    liveMembers = membersWork.result.value.filter((id) => id !== args.ownerId);
    const releasedAt = new Date().toISOString();
    const releaseWork = await startBoundedOptional(
      () =>
        Promise.allSettled(
          liveMembers!.map((memberOwnerId) =>
            markSessionBriefReleased(memberOwnerId, args.workspaceId, {
              fleet: args.slug,
              at: releasedAt,
              by: args.ownerId,
            }),
          ),
        ),
      { fallback: [] as PromiseSettledResult<unknown>[], timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS, label: 'fleet:wind-down:release' },
    );
    if (releaseWork.result.degraded) degraded = true;
  } else {
    const releaseWork = await startBoundedOptional(
      () => clearSessionBriefReleasedForFleet(args.workspaceId, args.slug),
      { fallback: 0, timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS, label: 'fleet:resume:release' },
    );
    if (releaseWork.result.degraded) degraded = true;
  }

  let notified: string[] = [];
  let cueMsgId: string | null = null;
  if (!args.alreadyInState) {
    const cueWork = await startBoundedOptional(
      async () => {
        const members =
          liveMembers ??
          (await listFleetControlMembers(args.slug)).filter((id) => id !== args.ownerId);
        if (members.length === 0) return { notified: [], cueMsgId: null as string | null };

        const { summary } = fleetControlCueText(
          args.action,
          args.slug,
          effectiveReason,
          shortHandle(args.ownerId),
          undefined,
          args.park ?? null,
        );
        const env = await sendMessage(args.identity, {
          to: members,
          summary,
          bodyWithMsgId: (cueMsgId) =>
            fleetControlCueText(
              args.action,
              args.slug,
              effectiveReason,
              shortHandle(args.ownerId),
              cueMsgId,
              args.park ?? null,
            ).body,
          extra: {
            [CUE_AUTHORITY_FIELD]: fleetScopedCueAuthority(args.slug),
            ...(args.action === 'wind-down'
              ? {
                  [EXPECTED_LIFECYCLE_ACK_FIELD]: expectedFleetWindDownAck(args.slug),
                  wakeOnReply: true,
                }
              : {}),
          },
        });
        return { notified: members, cueMsgId: (env as { msg_id?: string })?.msg_id ?? null };
      },
      {
        fallback: { notified: [], cueMsgId: null as string | null },
        timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS,
        label: `fleet:${args.action}:cue`,
      },
    );
    if (cueWork.result.degraded) degraded = true;
    notified = cueWork.result.value.notified;
    cueMsgId = cueWork.result.value.cueMsgId;
  }

  return {
    effectiveReason,
    ...(drainStamp ? { drainStamp } : {}),
    ...(pauseHolds ? { pauseHolds } : {}),
    notified,
    cueMsgId,
    ...(record ? { record } : {}),
    degraded,
  };
}

/**
 * Fire the park's declared resume gate on the receipt-critical path. A resume
 * must not report success while this emit is still pending: parked members are
 * reachable only through this event, not through the live-member cue.
 */
async function fireFleetResumeGate(args: {
  gate: string;
  slug: string;
  workspaceId: string;
  ownerId: string;
  reason: string | null;
}): Promise<FleetControlResumePathReceipt> {
  const fireWork = await withBoundedTimeout(
    async () => {
      const { emitAwaitedEvent } = await import('../../events/await/engine');
      return emitAwaitedEvent({
        key: args.gate,
        workspaceId: args.workspaceId,
        source: args.ownerId,
        summary: `Fleet ${args.slug} RESUMED — the park declared this gate; pick your lane back up.`,
        payload: { fleet: args.slug, controlState: 'active', by: args.ownerId, reason: args.reason },
      });
    },
    { fallback: null, timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS, label: 'fleet:resume:fireGate' },
  );
  const emitted = fireWork.value as { waiters?: number } | null;
  if (emitted) {
    return { gate: args.gate, fired: true, waiters: emitted.waiters ?? 0 };
  }
  return {
    gate: args.gate,
    fired: false,
    warning:
      `The fleet is ACTIVE, but firing its declared resume gate '${args.gate}' was not confirmed. ` +
      'Members parked on that key were NOT woken by this call and cannot be reached by the resume cue ' +
      `either. Re-fire it: events:emit { event: '${args.gate}', summary: 'fleet resumed' }.`,
  };
}

/**
 * The shared handler: guard → persist → cue. `fleetArg` accepts a slug or a
 * human name (slugified like every other registry surface).
 */
export async function applyFleetControl(
  ctx: ResolveIdentityCtx,
  fleetArg: string,
  action: FleetControlAction,
  reason?: string,
  opts?: {
    /** P-006: explicit harness for the wind-down drain stamp (else the invoker's
     *  session harness, else the fleet sentinel spec's own scope). */
    harness?: string | null;
    /** P-006: pass true only with a live ≥2-machine rig — mirrors scheduler:get_next. */
    rigAvailable?: boolean;
    /** Internal goal-stop seam: the goal transition already owns this fleet. */
    skipAuthorization?: boolean;
    /** Internal callers do not have a session harness fallback. */
    sessionHarness?: string | null;
    /** WI-2034563 (wind-down only): the gate NAME this park publishes for members to
     *  await. Scoped to `fleet:<slug>:<name>` before it is declared or stored, so two
     *  fleets parking on the same name cannot collide on the flat rendezvous plane.
     *  Omitted ⇒ FLEET_PARK_DEFAULT_RESUME_GATE, because a park that publishes NO key
     *  is the defect, not the default. */
    resumeGate?: string | null;
    /** WI-2034563 (wind-down only): bound the park to this many seconds. Sets the
     *  registry deadline AND the declaration's own lapse, so an abandoned park does
     *  not leave a standing declaration behind it. */
    resumeWithinSec?: number | null;
    /** WI-2034563 (wind-down only): this park is deliberately TERMINAL — nobody is
     *  coming back, so no gate is declared and a member's wake-less loop:end stays
     *  authorized. The janitorial reconcile path (every member already terminal) and
     *  a real end-of-mission shutdown are the legitimate users. */
    noResumePath?: boolean;
  },
): Promise<FleetControlResult> {
  const { ownerId, workspaceId, identity } = resolveFleetCaller(ctx);
  const slug = fleetSlugFromName(fleetArg);
  const fleet = await getFleet(workspaceId, slug);
  if (!fleet) {
    return {
      ok: false,
      error: 'fleet_not_found',
      message: `No fleet '${slug}' in this workspace — fleet:list shows the registry.`,
    };
  }

  // 1. GUARD — owner (su) / this fleet's leader / queen (mug|kettle). The pane
  // kind derives from live presence exactly like resolveSenderCueAuthority
  // (never self-asserted). A presence-read failure classifies by ownerId alone
  // (an `su-…` id still resolves to the su pane kind).
  let paneKind = 'unknown';
  try {
    const pres = await getPresence(ownerId).catch(() => null);
    paneKind = classifyAgentPane({ role: pres?.agentRole ?? null, ownerId }).kind;
  } catch {
    paneKind = classifyAgentPane({ role: null, ownerId }).kind;
  }
  const invokedAs = (opts?.skipAuthorization
    ? 'owner'
    : classifyFleetControlInvoker({
        callerOwnerId: ownerId,
        leaderOwnerId: fleet.leaderOwnerId,
        paneKind,
      })) ?? undefined;
  if (!opts?.skipAuthorization && !invokedAs) {
    return {
      ok: false,
      error: 'not_authorized',
      message:
        `fleet:${action} on '${slug}' is restricted to the owner (an su session), that fleet's ` +
        `recorded leader (${fleet.leaderOwnerId ?? 'none'}), or the queen — you are ${paneKind} `
        + `(${ownerId}). Ask the leader (coord:send @fleet-leader:${slug}) instead of steering a ` +
        'fleet you do not own (EI-9501).',
    };
  }

  // The typed cue below is deliberately fleet-leader-scoped. An owner/queen may
  // authorize a fleet control action, but must not emit a leader-shaped cue when
  // the registry points at an absent leader: members would obey the cue and route
  // their follow-up to a dead `@fleet-leader` while the real controller is this
  // session (EI-21094636043854606). Keep the recovery explicit — take leadership
  // first — rather than silently changing the fleet's owner as a side effect of a
  // control read. A liveness read failure also fails closed; an unverified leader
  // cannot safely back a leader-authority cue.
  if (!opts?.skipAuthorization && invokedAs !== 'leader') {
    let leaderIsLive = false;
    let leaderReadFailed = false;
    if (fleet.leaderOwnerId) {
      try {
        leaderIsLive = (await getPresence(fleet.leaderOwnerId)) !== null;
      } catch {
        leaderReadFailed = true;
      }
    }
    if (!leaderIsLive) {
      const leaderState = leaderReadFailed ? 'could not be confirmed live' : 'has no live presence';
      // The reconciler only winds down fleets after a successful liveness read
      // found every known member terminal. Re-read the live control audience before
      // emitting recovery advice; a read failure keeps the old conservative advice
      // rather than turning an unavailable roster into a terminal verdict.
      if (fleet.controlState === 'winding-down' && fleet.controlBy === FLEET_CONTROL_RECONCILER) {
        try {
          const liveMembers = await listFleetControlMembers(slug);
          if (isReconciledEmptyFleet(fleet, liveMembers)) {
            return {
              ok: false,
              fleet: slug,
              invokedAs,
              error: 'fleet_reconciled_terminal',
              message:
                `fleet:${action} cannot recover '${slug}' by taking leadership: the fleet is ` +
                `winding-down under ${FLEET_CONTROL_RECONCILER} and has no live members. ` +
                'This is terminal janitorial cleanup; use the owner/relaunch path only if the mission ' +
                'must be restarted, or finish the wind-down. No takeover was performed.',
            };
          }
        } catch {
          // Preserve the ordinary recovery advice when the live-member read is degraded.
        }
      }
      return {
        ok: false,
        fleet: slug,
        invokedAs,
        error: 'fleet_leader_mismatch',
        message:
          `fleet:${action} cannot emit a fleet-leader cue as ${invokedAs}: the registry leader ` +
          `(${fleet.leaderOwnerId ?? 'none'}) ${leaderState}. ` +
          `Recover authority first: either call fleet:take-leadership { fleet: "${slug}" } and retry, ` +
          `or keep this caller outside the fleet by using fleet:launch-on-plan { name: "${slug}", ` +
          `leader: "spawn", ... } to install a freshly launched delegated leader; that new leader ` +
          `then calls fleet:${action}.`,
      };
    }
  }

  // 2. PERSIST the typed state FIRST. Every optional leg runs only after this
  // durable boundary has landed. Resume's declared gate is fired immediately
  // after that boundary, before the slower optional saga, so a receipt cannot
  // report success before parked members have a confirmed wake.
  const targetState = ACTION_TO_STATE[action];
  const alreadyInState = fleet.controlState === targetState;
  let resumePath: FleetControlResumePathReceipt | undefined;

  // ── WI-2034563: mint + DECLARE the park's resume gate BEFORE persisting it ──
  // Declaring first is the honest order: the row must never advertise a key that
  // has no announcement behind it, because the announcement is what makes the key
  // discoverable (orient's announcedGates) and — the part that matters for a member
  // parking late after a carry-respawn — what LATCHES the eventual fire. If the
  // declaration fails we store NO gate and say so, rather than publishing a key that
  // silently behaves like an ordinary unlatched event.
  let park: FleetParkDirectivePlan | null = null;
  if (action === 'wind-down') {
    const terminal = opts?.noResumePath === true;
    const expiresAt =
      !terminal && typeof opts?.resumeWithinSec === 'number' && Number.isFinite(opts.resumeWithinSec) && opts.resumeWithinSec > 0
        ? Date.now() + Math.floor(opts.resumeWithinSec) * 1000
        : null;
    if (terminal) {
      park = { gate: null, expiresAt: null, terminal: true };
      resumePath = { gate: null, terminal: true };
    } else {
      const gateName = opts?.resumeGate?.trim() || FLEET_PARK_DEFAULT_RESUME_GATE;
      const gateKey = buildAnnouncedKey(gateName, { kind: 'fleet', ref: slug });
      try {
        const { registerAnnouncement } = await import('../../events/await/store');
        await registerAnnouncement({
          subscriberId: ownerId,
          eventKey: gateKey,
          note: `Fleet ${slug} resume gate — fired by fleet:resume. Members parked under this wind-down await this key.`,
          scopeKind: 'fleet',
          scopeRef: slug,
          logicalGateKey: `fleet-park-resume:${slug}`,
          boundTo: { kind: 'fleet-leadership', ref: slug },
          expiresSec:
            expiresAt === null ? null : Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)),
        });
        park = { gate: gateKey, expiresAt, terminal: false };
        resumePath = { gate: gateKey, declared: true, expiresAt, terminal: false };
      } catch (e) {
        park = { gate: null, expiresAt, terminal: false };
        resumePath = {
          gate: null,
          declared: false,
          expiresAt,
          terminal: false,
          warning:
            `Could not declare the resume gate '${gateKey}' (${e instanceof Error ? e.message : String(e)}), so ` +
            'this park is being recorded WITHOUT one and members are being told so. Declare it by hand — ' +
            `events:emit { event: '${gateName}', announce: true, announceScope: 'fleet', announceScopeRef: '${slug}' } ` +
            '— and re-issue the wind-down, or resume the fleet.',
        };
      }
    }
  }

  const updated = await setFleetControlState(
    workspaceId,
    slug,
    {
      state: targetState,
      reason: reason ?? null,
      by: ownerId,
      resumeGate: park?.gate ?? null,
      expiresAt: park?.expiresAt ?? null,
      noResumePath: park?.terminal === true,
    },
    undefined,
    fleet.leaderOwnerId,
  );
  if (!updated) {
    return {
      ok: false,
      fleet: slug,
      controlState: fleet.controlState,
      ...(resumePath ? { resumePath } : {}),
      error: 'fleet_leadership_superseded',
      message: `Fleet '${slug}' changed leaders after this control action was authorized; re-orient before retrying.`,
    };
  }
  const record: AgentFleetRecord = updated;
  // A stale ACTIVE row can still carry a declared park gate when the previous
  // resume returned early or the state and event planes were reconciled
  // separately.  Idempotent resume must reconcile that gate too: clearing the
  // columns without firing leaves members parked forever while reporting
  // success.  Event emission is latching/idempotent, so repeating it is safe.
  if (action === 'resume' && (fleet.controlResumeGate ?? '').trim()) {
    resumePath = await fireFleetResumeGate({
      gate: (fleet.controlResumeGate ?? '').trim(),
      slug,
      workspaceId,
      ownerId,
      reason: reason ?? null,
    });
  }
  const post = await withBoundedTimeout(
    () =>
      runFleetControlPostSaga({
        action,
        alreadyInState,
        ctx,
        effectiveReason: reason ?? null,
        fleet,
        identity,
        ownerId,
        slug,
        workspaceId,
        park,
        opts,
      }),
    {
      fallback: null,
      timeoutMs: FLEET_CONTROL_RESPONSE_TIMEOUT_MS,
      label: `fleet:${action}:post-control`,
    },
  );
  const postResult = post.value;
  const responseRecord = postResult?.record ?? record;

  return {
    ok: resumePath?.fired === false ? false : true,
    fleet: slug,
    controlState: responseRecord.controlState,
    reason: responseRecord.controlReason,
    by: ownerId,
    invokedAs,
    ...(alreadyInState ? { alreadyInState: true } : {}),
    notified: postResult?.notified ?? [],
    cueMsgId: postResult?.cueMsgId ?? null,
    ...(postResult?.drainStamp ? { drainStamp: postResult.drainStamp } : {}),
    ...(postResult?.pauseHolds ? { pauseHolds: postResult.pauseHolds } : {}),
    ...(resumePath ? { resumePath } : {}),
    ...(post.degraded ? { postControlPending: true } : {}),
    ...(post.degraded || postResult?.degraded ? { postControlDegraded: true } : {}),
    ...(resumePath?.fired === false
      ? {
          error: 'resume_gate_not_confirmed',
          message:
            'The fleet state is active, but its declared resume gate was not confirmed fired; ' +
            're-fire the gate before treating parked members as resumed.',
        }
      : {}),
  };
}

/**
 * Wind down the standing fleet minted for a goal.
 *
 * This is deliberately not routed through the public invoker guard: a terminal
 * goal transition is the authority that owns the declaration, while the fleet's
 * recorded leader may already be gone. The actual state/cue/release work stays in
 * applyFleetControl so goal stops and fleet:wind-down cannot drift apart.
 */
export async function windDownGoalFleet(args: {
  workspaceId: string;
  fleetSlug: string;
  goalId: string;
  status: string;
  actor?: string | null;
}): Promise<FleetControlResult> {
  const controller = args.actor?.trim() || 'goal-stop-fanout';
  const ctx: ResolveIdentityCtx = {
    uiClientId: controller,
    workspaceId: args.workspaceId,
    isSuperuser: true,
  };
  return applyFleetControl(
    ctx,
    args.fleetSlug,
    'wind-down',
    `goal ${args.goalId} reached ${args.status} — standing drain fleet wind-down`,
    // WI-2034563: a goal that reached a terminal status is not coming back, so this
    // park is genuinely TERMINAL. Declaring a resume gate here would publish a key
    // nobody will ever fire and would refuse members' loop:end for no reason.
    { skipAuthorization: true, sessionHarness: null, noResumePath: true },
  );
}
