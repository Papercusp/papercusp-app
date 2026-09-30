/**
 * Durable fleet-leader control bootstrap.
 *
 * Leadership is a control-plane state transition, not prompt advice. Every path
 * that installs a leader calls this effect so the leader holds AUTO mode, an
 * active loop, and standing wake watches for the fleet's transition events. The
 * effect is idempotent and repairs partial/stale state without overwriting an
 * active loop's deliberately chosen cadence or mission.
 */
import { getModes, setMode } from '../../modes/store';
import { modeImpliesAutonomy } from '../../modes/registry';
import {
  buildLoopWakePrompt,
  getLoopStatus,
  materializeLoop,
  readActiveLoopFacts,
  type LoopStatus,
  type PriorLoopFacts,
} from '../../harness/routines/loop';
import {
  cancelAwait,
  listActiveAwaits,
  listOperatorCancelledAwaits,
  registerAwait,
  retireLifecycleBoundWatches,
} from '../../events/await/store';
import type { AwaitRow } from '../../events/await/types';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { armInboxWake } from '../../events/await/inbox-wake-arm';
import {
  findMatchingActivePredicateWatch,
  registerPredicateWatch,
  startPredicateWatchPoller,
} from '../../events/await/predicate-watch';
import { buildKey, catalogEntry } from '../../events/await/catalog';
import { getCell, type CellReader } from '../../cell-registry';
import { interestProfilesFor, type InterestProfileRow } from '../../interest-profiles';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getPresence } from '../coordination/presence';
import type { FleetControlState } from '../../agent-fleets-store';
import { MONITOR_NO_DELTA_BUDGET_MAX, type PersistedMonitorConfig } from '../../harness/routines/monitor-policy';

export const LEADER_MONITOR_INTERVAL_SEC = 60;
/** One leader/profile may never manufacture an unbounded interrupt fan-out. */
export const LEADER_PROFILE_AUTO_ARM_CAP = 16;

/**
 * A typed fleet wind-down is a durable stop boundary for leader supervision.
 * Keep the legacy `undefined` case active for callers that predate the fleet
 * control-state field; current callers pass the registry value explicitly.
 */
export function shouldMaintainFleetLeaderControl(controlState?: FleetControlState | null): boolean {
  return controlState !== 'winding-down';
}

export type LeaderAutoArmTarget =
  | {
      kind: 'event';
      label: string;
      eventKey: string;
      row: InterestProfileRow;
    }
  | {
      kind: 'cell';
      label: string;
      cell: string;
      predicate: {
        tool: string;
        args: Record<string, unknown>;
        path: string;
        op: NonNullable<InterestProfileRow['on']>['op'];
        value?: unknown;
      };
      row: InterestProfileRow;
    };

export interface LeaderAutoArmResolution {
  targets: LeaderAutoArmTarget[];
  omitted: LeaderAutoArmTarget[];
}

/** Pure, reusable bound used by the resolver and directly falsifiable in tests. */
export function capLeaderProfileTargets<T>(
  targets: readonly T[],
  cap = LEADER_PROFILE_AUTO_ARM_CAP,
): {
  selected: T[];
  omitted: T[];
} {
  if (!Number.isSafeInteger(cap) || cap < 1)
    throw new Error(`leader profile auto-arm cap must be a positive integer, got ${cap}`);
  return { selected: targets.slice(0, cap), omitted: targets.slice(cap) };
}

function profileSubject(field: string, fleetSlug: string): string {
  if (field === 'fleet.slug') return fleetSlug;
  throw new Error(`fleet-leader auto-arm cannot resolve profile subject '${field}'`);
}

function resolveFleetLeaderEventTarget(
  row: InterestProfileRow,
  fleetSlug: string,
): Extract<LeaderAutoArmTarget, { kind: 'event' }> {
  if (row.watch.kind !== 'event') {
    throw new Error(`fleet-leader transition resolver received non-event watch '${row.watch.kind}'`);
  }
  const entry = catalogEntry(row.watch.family);
  if (!entry) throw new Error(`fleet-leader auto-arm references unknown event family '${row.watch.family}'`);
  const fields = row.of ?? [];
  const params: Record<string, string | undefined> = {};
  entry.params.forEach((param, index) => {
    const field = fields[index];
    params[param.name] = field == null ? undefined : profileSubject(field, fleetSlug);
  });
  const eventKey = buildKey(row.watch.family, params);
  return { kind: 'event', label: eventKey, eventKey, row };
}

/**
 * The concrete transition-event set a fleet leader is expected to monitor.
 * Kept separate from the full resolver so read-only diagnostics can inspect the
 * event set without resolving (or accidentally depending on) future poll-cell rows.
 */
export function resolveFleetLeaderTransitionEventKeys(input: {
  fleetSlug: string;
  rows?: readonly InterestProfileRow[];
}): string[] {
  const rows = (input.rows ?? interestProfilesFor('fleet-leader')).filter(
    (row) => row.context === 'fleet-leader' && row.tier === 'auto-arm' && row.watch.kind === 'event',
  );
  return [...new Set(rows.map((row) => resolveFleetLeaderEventTarget(row, input.fleetSlug).eventKey))];
}

/**
 * Resolve the fleet-leader profile into concrete event keys / predicate polls.
 * The profile is the source of truth: no event family is repeated in this module.
 */
export function resolveFleetLeaderAutoArmTargets(input: {
  fleetSlug: string;
  reader: CellReader;
  rows?: readonly InterestProfileRow[];
  cap?: number;
}): LeaderAutoArmResolution {
  const rows = (input.rows ?? interestProfilesFor('fleet-leader')).filter(
    (row) => row.context === 'fleet-leader' && row.tier === 'auto-arm',
  );
  const candidates: LeaderAutoArmTarget[] = rows.map((row) => {
    if (row.watch.kind === 'event') {
      return resolveFleetLeaderEventTarget(row, input.fleetSlug);
    }

    // owner-attention rows are interactive surface selections, never wake
    // sources. The registry validator rejects auto-arm owner-attention rows,
    // but keep this resolver exhaustively narrowed too: a malformed injected
    // row must fail closed instead of being treated as a cell by fallthrough.
    if (row.watch.kind !== 'cell') {
      throw new Error(`fleet-leader auto-arm cannot arm owner-attention source '${row.watch.source}'`);
    }

    const spec = getCell(row.watch.cell, input.reader);
    if (!spec) {
      throw new Error(
        `fleet-leader auto-arm cell '${row.watch.cell}' is absent for this leader (unregistered or outside its audience)`,
      );
    }
    if (spec.changeSignal.kind !== 'poll') {
      throw new Error(`fleet-leader auto-arm cell '${row.watch.cell}' is event-signalled, not poll-signalled`);
    }
    if (!row.on) throw new Error(`fleet-leader auto-arm cell '${row.watch.cell}' has no predicate`);

    const args: Record<string, unknown> = {};
    if (spec.callerRelativity.kind === 'parameter') {
      const field = row.of?.[0];
      if (!field) {
        throw new Error(
          `fleet-leader auto-arm cell '${row.watch.cell}' requires profile subject '${spec.callerRelativity.param}'`,
        );
      }
      args[spec.callerRelativity.param] = profileSubject(field, input.fleetSlug);
    } else if ((row.of?.length ?? 0) > 0) {
      throw new Error(
        `fleet-leader auto-arm cell '${row.watch.cell}' declares a subject but its cell is ${spec.callerRelativity.kind}`,
      );
    }

    return {
      kind: 'cell',
      label: `cell:${row.watch.cell}`,
      cell: row.watch.cell,
      predicate: {
        tool: spec.changeSignal.tool,
        args,
        path: spec.changeSignal.path,
        op: row.on.op,
        ...(row.on.value === undefined ? {} : { value: row.on.value }),
      },
      row,
    };
  });

  // A duplicate declaration should not spend two cap slots or create two awaits.
  const unique = [...new Map(candidates.map((target) => [target.label, target])).values()];
  const { selected, omitted } = capLeaderProfileTargets(unique, input.cap);
  return { targets: selected, omitted };
}

export interface LeaderControlOutcome {
  healthy: boolean;
  repaired: boolean;
  mode: { healthy: boolean; changed: boolean; error?: string };
  loop: {
    healthy: boolean;
    changed: boolean;
    harness: string | null;
    intervalSec: number | null;
    mode: LoopStatus['mode'] | null;
    error?: string;
  };
  watches: {
    enabled: boolean;
    healthy: boolean;
    expected: string[];
    active: string[];
    added: string[];
    repaired: string[];
    removed: number;
    awaitIds: number[];
    cap: number;
    capped: boolean;
    omitted: string[];
    /** Concrete profile keys deliberately canceled through events:cancel. */
    suppressed: string[];
    wakeReachable: boolean;
    handleNote: string | null;
    cancel: { tool: 'events:cancel'; args: { await_ids: number[] } } | null;
    flag: { fallback: boolean; error?: string };
    error?: string;
  };
  inboxWake: { healthy: boolean; error?: string };
  errors: string[];
}

export interface EnsureFleetLeaderControlInput {
  workspaceId: string;
  ownerId: string;
  fleetSlug: string;
  harnessSlug?: string | null;
  planSlug?: string | null;
  carry?: 'warm' | 'cold';
  agentRole?: string | null;
}

function concrete(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== '*' && trimmed !== 'all' ? trimmed : null;
}

/**
 * A fleet registry row deliberately does not duplicate harness scope. When a
 * leader takeover has no explicit/session harness, the fleet claim-spec
 * sentinel is the narrow canonical fallback: it is the same binding inherited
 * by fleet members and is workspace-scoped. Fail closed if that optional read
 * cannot resolve a concrete scope.
 */
async function claimSpecHarnessForFleetLeader(workspaceId: string, fleetSlug: string): Promise<string | null> {
  try {
    const { fleetSpecBeeKey, getClaimSpecRecord } = await import('../../scheduler/claim-spec-store');
    const record = await getClaimSpecRecord({
      cupId: fleetSpecBeeKey(fleetSlug),
      workspaceId,
    });
    return concrete(record.harnessSlug);
  } catch {
    return null;
  }
}

function monitorGoal(fleetSlug: string, planSlug?: string | null): string {
  return planSlug
    ? `Continuously lead and monitor fleet ${fleetSlug} until plan ${planSlug} is terminal; repair unhealthy lanes and preserve completion evidence.`
    : `Continuously lead and monitor fleet ${fleetSlug}; repair dead, stalled, blocked, or evidence-deficient lanes until its active work is terminal.`;
}

/**
 * Retire the standing transition watches installed by ensureFleetLeaderControl.
 *
 * Fleet membership is mutable while event awaits are durable.  Without an explicit
 * inverse, a departed/demoted leader keeps receiving the old fleet's transition wakes
 * forever.  Keep this key-exact so ordinary member-authored fleet awaits are untouched.
 */
export async function retireFleetLeaderWatches(ownerId: string, fleetSlug: string): Promise<number> {
  const retired = await retireLifecycleBoundWatches(
    { kind: 'fleet-leadership', ref: fleetSlug },
    { ownerIds: [ownerId] },
  );
  return retired.awaits + retired.predicateWatches;
}

function selfExcludingPayloadFilter(eventKey: string, fleetSlug: string, ownerId: string): unknown | undefined {
  if (
    eventKey !== `fleet:member-dead:${fleetSlug}` &&
    eventKey !== `fleet:member-left:${fleetSlug}` &&
    eventKey !== `fleet:context-critical:${fleetSlug}`
  ) {
    return undefined;
  }
  return { not: { agentId: { equals: ownerId } } };
}

function payloadFilterMatches(actual: unknown | null | undefined, expected: unknown | undefined): boolean {
  if (expected == null) return actual == null;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * Identify rows owned by fleet-leader control, including rows written by the
 * pre-profile armer before lifecycle bindings were added.  The legacy note is
 * deliberately exact to this machinery so a leader's unrelated manual await
 * on the same transition key is never retired during reconciliation.
 */
function isFleetLeaderControlAwait(row: AwaitRow, fleetSlug: string): boolean {
  if (row.boundTo?.kind === 'fleet-leadership' && row.boundTo.ref === fleetSlug) return true;
  if (row.policy !== 'wake' || row.once !== false) return false;
  const note = row.note?.trim() ?? '';
  return (
    note.startsWith(`standing fleet leader transition watch (${fleetSlug})`) ||
    note.startsWith('fleet-leader auto-arm (')
  );
}

export async function ensureFleetLeaderControl(input: EnsureFleetLeaderControlInput): Promise<LeaderControlOutcome> {
  const errors: string[] = [];
  let repaired = false;

  const mode = { healthy: false, changed: false } as LeaderControlOutcome['mode'];
  try {
    const held = await getModes(input.workspaceId, input.ownerId);
    if (held.some((row) => modeImpliesAutonomy(row.mode))) {
      mode.healthy = true;
    } else {
      const result = await setMode({
        workspaceId: input.workspaceId,
        ownerId: input.ownerId,
        modeId: 'auto',
        enabled: true,
        reason: `fleet leadership control for '${input.fleetSlug}'`,
        setBy: input.ownerId,
      });
      mode.healthy = result.ok;
      mode.changed = result.ok;
      repaired ||= result.ok;
      if (!result.ok) throw new Error(result.error ?? 'AUTO mode write was refused');
    }
  } catch (error) {
    mode.error = error instanceof Error ? error.message : String(error);
    errors.push(`mode: ${mode.error}`);
  }

  let priorLoop: LoopStatus | null = null;
  try {
    priorLoop = await getLoopStatus(input.ownerId);
  } catch (error) {
    errors.push(`loop-read: ${error instanceof Error ? error.message : String(error)}`);
  }
  // getLoopStatus intentionally omits the potentially multi-KB kickoff. When a
  // recovery is about to replace an INACTIVE row, read the full prior payload so
  // the repair can retain an explicit cadence/lifecycle/mode and any blocker
  // premise embedded in the kickoff. Active rows return above without this extra
  // read and remain completely untouched.
  let priorLoopFacts: PriorLoopFacts | null = null;
  if (priorLoop && !priorLoop.active) {
    try {
      priorLoopFacts = await readActiveLoopFacts(input.ownerId);
    } catch (error) {
      errors.push(`loop-recovery-read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let presence: Awaited<ReturnType<typeof getPresence>> = null;
  try {
    presence = await getPresence(input.ownerId);
  } catch {
    presence = null;
  }
  let harness = concrete(input.harnessSlug) ?? concrete(priorLoop?.harnessSlug) ?? concrete(presence?.potSlug);
  if (!harness && priorLoop?.active !== true) {
    harness = await claimSpecHarnessForFleetLeader(input.workspaceId, input.fleetSlug);
  }
  const loop = {
    healthy: false,
    changed: false,
    harness,
    intervalSec: priorLoop?.intervalSec ?? null,
    mode: priorLoop?.mode ?? null,
  } as LeaderControlOutcome['loop'];
  // `materializeLoop` is an upsert that replaces the existing loop's cadence,
  // mode, goal, and kickoff. An active loop may be deliberately retuned by the
  // leader (for example, widened to a 1200s fallback heartbeat or switched to a
  // work mission) immediately before a carry-respawn or leader-brief refresh.
  // Leader control owns the wake/watch safety net, not the leader's loop
  // mission, so repair only a missing or inactive loop and preserve every active
  // loop configuration verbatim.
  const priorLoopHealthy = priorLoop?.active === true;
  if (priorLoopHealthy) {
    loop.healthy = true;
  } else if (!harness) {
    loop.error = 'no concrete harness available for the leader monitor loop';
    errors.push(`loop: ${loop.error}`);
  } else {
    try {
      const goal = priorLoopFacts?.goal ?? priorLoop?.goal ?? monitorGoal(input.fleetSlug, input.planSlug);
      const intervalSec = priorLoop?.intervalSec ?? priorLoopFacts?.intervalSec ?? LEADER_MONITOR_INTERVAL_SEC;
      const carry = input.carry ?? priorLoop?.carry ?? priorLoopFacts?.carry ?? 'warm';
      const continuation = priorLoop?.continuation ?? priorLoopFacts?.continuation ?? 'settle';
      const mode = priorLoop?.mode ?? priorLoopFacts?.mode ?? 'monitor';
      const monitor: PersistedMonitorConfig | undefined =
        mode === 'monitor'
          ? (priorLoopFacts?.monitor ?? {
              predicateKey: `fleet:${input.fleetSlug}`,
              stopCondition: `Fleet ${input.fleetSlug} is drained, enters winding-down, or ${input.ownerId} no longer holds durable leadership.`,
              noDeltaBudget: MONITOR_NO_DELTA_BUDGET_MAX,
              remainingNoDeltaBudget: MONITOR_NO_DELTA_BUDGET_MAX,
              authority: { kind: 'fleet-leader', fleet: input.fleetSlug },
            })
          : undefined;
      const kickoff =
        priorLoopFacts?.kickoff?.trim() ||
        buildLoopWakePrompt({
          ownerId: input.ownerId,
          intervalSec,
          harness,
          goal,
          carry,
          continuation,
          mode,
        });
      const materialized = await materializeLoop({
        workspaceId: input.workspaceId,
        harnessSlug: harness,
        ownerId: input.ownerId,
        intervalSec,
        kickoff,
        goal,
        carry,
        continuation,
        mode,
        ...(monitor ? { monitor } : {}),
        // This is a repair of a stale/inactive loop read. The row-level guard
        // must yield to an explicit loop:arm that wins the race after our read.
        onlyIfInactive: true,
        ...(priorLoopFacts?.customWakePrompt === true ? { customWakePrompt: true } : {}),
      });
      loop.healthy = true;
      loop.changed = materialized.changed;
      loop.intervalSec = materialized.intervalSec ?? intervalSec;
      loop.mode = mode;
      repaired ||= materialized.changed;
    } catch (error) {
      loop.error = error instanceof Error ? error.message : String(error);
      errors.push(`loop: ${loop.error}`);
    }
  }

  const inboxWake = { healthy: false } as LeaderControlOutcome['inboxWake'];
  try {
    await armInboxWake({
      ownerId: input.ownerId,
      note: `fleet leader control (${input.fleetSlug})`,
      minSleepSec: LEADER_MONITOR_INTERVAL_SEC,
    });
    inboxWake.healthy = true;
  } catch (error) {
    inboxWake.error = error instanceof Error ? error.message : String(error);
    errors.push(`inbox-wake: ${inboxWake.error}`);
  }

  const watches = {
    enabled: true,
    healthy: false,
    expected: [] as string[],
    active: [] as string[],
    added: [] as string[],
    repaired: [] as string[],
    removed: 0,
    awaitIds: [] as number[],
    cap: LEADER_PROFILE_AUTO_ARM_CAP,
    capped: false,
    omitted: [] as string[],
    suppressed: [] as string[],
    wakeReachable: false,
    handleNote: null as string | null,
    cancel: null,
    flag: { fallback: false } as { fallback: boolean; error?: string },
  } as LeaderControlOutcome['watches'];

  try {
    watches.enabled = await getFlag(FLAGS.FLEET_LEADER_PROFILE_AUTO_ARM, `fleet-leader:${input.ownerId}`);
  } catch (error) {
    // Existing behaviour is auto-arm ON. A flag-backend miss must not silently
    // turn a leader blind, so preserve that state and disclose the fallback.
    watches.enabled = true;
    watches.flag.fallback = true;
    watches.flag.error = error instanceof Error ? error.message : String(error);
  }

  const binding = { kind: 'fleet-leadership', ref: input.fleetSlug } as const;
  try {
    if (!watches.enabled) {
      const retired = await retireLifecycleBoundWatches(binding, { ownerIds: [input.ownerId] });
      watches.removed = retired.awaits + retired.predicateWatches;
      repaired ||= watches.removed > 0;
      watches.healthy = true;
      return {
        healthy: mode.healthy && loop.healthy && inboxWake.healthy,
        repaired,
        mode,
        loop,
        watches,
        inboxWake,
        errors,
      };
    }

    const role = concrete(input.agentRole) ?? concrete(presence?.agentRole) ?? 'su';
    const resolution = resolveFleetLeaderAutoArmTargets({
      fleetSlug: input.fleetSlug,
      reader: {
        ownerId: input.ownerId,
        roles: [role],
        ...(harness ? { harnessSlug: harness } : {}),
      },
      cap: LEADER_PROFILE_AUTO_ARM_CAP,
    });
    watches.expected = resolution.targets.map((target) => target.label);
    watches.capped = resolution.omitted.length > 0;
    watches.omitted = resolution.omitted.map((target) => target.label);

    // An explicit events:cancel is an operator decision, not a stale row for
    // reconciliation to repair. Only concrete event keys are suppressible;
    // predicate watches have no stable profile key to honor here.
    const suppressedEventKeys = new Set(
      (
        await listOperatorCancelledAwaits(
          input.ownerId,
          resolution.targets
            .filter((target): target is Extract<LeaderAutoArmTarget, { kind: 'event' }> => target.kind === 'event')
            .map((target) => target.eventKey),
        )
      ).map((row) => row.eventKey),
    );
    watches.suppressed = resolution.targets
      .filter(
        (target): target is Extract<LeaderAutoArmTarget, { kind: 'event' }> =>
          target.kind === 'event' && suppressedEventKeys.has(target.eventKey),
      )
      .map((target) => target.label);

    const current = await listActiveAwaits(input.ownerId);
    const { handle, note } = await captureWakeHandleForOwner(input.ownerId);
    watches.handleNote = note;
    watches.wakeReachable = handle != null;
    const retainedAwaitIds = new Set<number>();
    const cancelledAwaitIds = new Set<number>();
    const cancelControlAwait = async (row: AwaitRow): Promise<void> => {
      if (retainedAwaitIds.has(row.id) || cancelledAwaitIds.has(row.id)) return;
      if (await cancelAwait({ awaitId: row.id, subscriberId: input.ownerId })) watches.removed += 1;
      cancelledAwaitIds.add(row.id);
    };

    for (const target of resolution.targets) {
      if (target.kind === 'event' && suppressedEventKeys.has(target.eventKey)) {
        for (const row of current.filter(
          (candidate) =>
            candidate.eventKey === target.eventKey && isFleetLeaderControlAwait(candidate, input.fleetSlug),
        )) {
          await cancelControlAwait(row);
        }
        continue;
      }
      let eventKey: string;
      let predicateExists = true;
      if (target.kind === 'event') {
        eventKey = target.eventKey;
      } else {
        const existing = await findMatchingActivePredicateWatch({
          workspaceId: input.workspaceId,
          role,
          harnessSlug: harness,
          tool: target.predicate.tool,
          args: target.predicate.args,
          path: target.predicate.path,
          op: target.predicate.op,
          value: target.predicate.value,
          intervalSec: LEADER_MONITOR_INTERVAL_SEC,
          once: false,
        });
        predicateExists = existing != null;
        eventKey = existing?.eventKey ?? `predicate:${globalThis.crypto.randomUUID()}`;
      }

      const rows = current.filter((row) => row.eventKey === eventKey);
      const payloadFilter = selfExcludingPayloadFilter(eventKey, input.fleetSlug, input.ownerId);
      const healthy = rows.find(
        (row) =>
          row.policy === 'wake' &&
          row.once === false &&
          row.wakeHandle != null &&
          payloadFilterMatches(row.payloadFilter, payloadFilter) &&
          row.boundTo?.kind === 'fleet-leadership' &&
          row.boundTo.ref === input.fleetSlug,
      );
      if (healthy) {
        watches.active.push(target.label);
        watches.awaitIds.push(healthy.id);
        retainedAwaitIds.add(healthy.id);
        // A legacy/unbound armer may have left a second standing row for the
        // same key. Keep the correctly-bound row and retire only control-owned
        // duplicates; manual waits on that key remain untouched.
        for (const row of rows.filter(
          (candidate) => candidate.id !== healthy.id && isFleetLeaderControlAwait(candidate, input.fleetSlug),
        )) {
          await cancelControlAwait(row);
        }
        continue;
      }
      const staleControlRows = rows.filter((row) => isFleetLeaderControlAwait(row, input.fleetSlug));
      for (const row of staleControlRows) {
        await cancelControlAwait(row);
      }
      const row = await registerAwait({
        subscriberId: input.ownerId,
        eventKey,
        policy: 'wake',
        note: `fleet-leader auto-arm (${target.label}): ${target.row.why}`,
        wakeHandle: handle,
        timeoutBehavior: 'wake',
        timeoutSec: null,
        once: false,
        minSleepSec: LEADER_MONITOR_INTERVAL_SEC,
        ...(payloadFilter == null ? {} : { payloadFilter }),
        boundTo: binding,
      });
      try {
        if (target.kind === 'cell' && !predicateExists) {
          startPredicateWatchPoller();
          await registerPredicateWatch({
            id: eventKey.slice('predicate:'.length),
            workspaceId: input.workspaceId,
            ownerId: input.ownerId,
            role,
            harnessSlug: harness,
            eventKey,
            tool: target.predicate.tool,
            args: target.predicate.args,
            path: target.predicate.path,
            op: target.predicate.op,
            value: target.predicate.value,
            intervalSec: LEADER_MONITOR_INTERVAL_SEC,
            once: false,
            boundTo: binding,
          });
        }
      } catch (error) {
        await cancelAwait({ awaitId: row.id, subscriberId: input.ownerId });
        throw error;
      }
      watches.active.push(target.label);
      watches.awaitIds.push(row.id);
      retainedAwaitIds.add(row.id);
      if (staleControlRows.length > 0) watches.repaired.push(target.label);
      else watches.added.push(target.label);
      repaired = true;
      if (row.wakeHandle == null) watches.wakeReachable = false;
    }

    // Reconcile profile removals as well as additions. This retires old
    // hard-coded/legacy control awaits without touching manual awaits on the key.
    for (const row of current) {
      if (
        isFleetLeaderControlAwait(row, input.fleetSlug) &&
        !retainedAwaitIds.has(row.id) &&
        !cancelledAwaitIds.has(row.id)
      ) {
        await cancelControlAwait(row);
      }
    }
    repaired ||= watches.removed > 0;
    watches.cancel =
      watches.awaitIds.length > 0 ? { tool: 'events:cancel', args: { await_ids: [...watches.awaitIds] } } : null;
    const profileSatisfied = watches.active.length + watches.suppressed.length === watches.expected.length;
    watches.healthy = profileSatisfied && (watches.suppressed.length > 0 || watches.wakeReachable);
    if (!watches.wakeReachable && watches.suppressed.length < watches.expected.length) {
      watches.error = 'transition watches are registered but no resumable wake handle is available yet';
      errors.push(`watches: ${watches.error}`);
    }
  } catch (error) {
    watches.error = error instanceof Error ? error.message : String(error);
    errors.push(`watches: ${watches.error}`);
  }

  return {
    healthy: mode.healthy && loop.healthy && inboxWake.healthy && watches.healthy,
    repaired,
    mode,
    loop,
    watches,
    inboxWake,
    errors,
  };
}
