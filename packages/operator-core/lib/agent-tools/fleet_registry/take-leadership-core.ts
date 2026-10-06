/**
 * take-leadership-core — the SHARED D-002 leadership-transfer effect (named-su-agent-
 * fleets-2026-06-29 / EI-5705 + EI-5704). The ONE code path that both fleet:take-leadership
 * and fleet:join { as:'leader' } call, so "become the leader" behaves identically however
 * it is reached.
 *
 * It (1) installs the caller as the registry leader (single-leader invariant — there is
 * exactly one agent_fleets.leader_owner_id), (2) labels the caller's presence this fleet's
 * `leader`, (3) demotes the PRIOR leader's presence to `member` (always, except when they
 * have since moved to a different fleet — see shouldDemotePriorLeader), and (4) NOTIFIES the
 * displaced leader via a durable coord inbox inject so they know they were replaced — and
 * returns `notified` so the new leader knows the displaced leader was already told and does
 * NOT redundantly message them (owner spec 2026-06-30).
 */
import {
  promoteFleetLeaderIfMissing,
  setFleetLeader,
  type AgentFleetRecord,
} from '../../agent-fleets-store';
import { heartbeatPresence, setPresenceFleet, setCompactionLimit, getPresence } from '../coordination/presence';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { sendMessage } from '../coordination/messages';
import type { AgentIdentity } from '../coordination/identity';
import { shouldDemotePriorLeader } from './_shared';
import {
  ensureFleetLeaderControl,
  resolveFleetLeaderTransitionEventKeys,
  retireFleetLeaderWatches,
  type LeaderControlOutcome,
} from './leader-control';
import { clearOperatorCancelledAwaits } from '../../events/await/store';
import { getModeSubject } from '../../modes/store';
import { resolveGoalFleetLeadership } from './goal-fleet-leadership';

/** P-009: the outcome of the become-a-leader compaction-cap re-seed (below). */
export interface LeaderReseedOutcome {
  /** The soft compaction limit now stored for the new leader (tokens). */
  applied: number;
  /** What it was before (null = none stored, or unreadable). */
  from: number | null;
  /** Why the (non-)change happened. */
  reason:
    | 'explicit-limit' // caller passed compactionLimit → applied it (clamped to the leader ceiling)
    | 'explicit-context-size' // caller passed contextSize → left the limit alone
    | 'member-cap-lifted' // THE P-009 fix: a 300k member seed → the leader default (400k on [1m])
    | 'already-leader-grade' // current limit is not the member-cap seed → left untouched
    | 'non-1m-no-cap-gap'; // model caps member==leader (non-[1m]); nothing to lift
}

export interface AutoArmSuppressionOutcome {
  /** Whether this leadership action explicitly requested a re-arm. */
  requested: boolean;
  /** Concrete fleet-leader event keys whose operator-cancel markers were cleared. */
  eventKeys: string[];
  /** Number of persisted cancellation markers cleared. */
  cleared: number;
  /** Best-effort error; leadership is already committed if this is present. */
  error?: string;
}

export interface TakeLeadershipOutcome {
  slug: string;
  /** The new leader (the caller). */
  leader: string;
  /** Who led before the transfer (null when the fleet had no leader, or === caller). */
  previousLeader: string | null;
  /** The prior leader whose presence was actually demoted to `member` (null when there
   *  was none, the caller already led, or the prior leader had moved to another fleet). */
  demotedPriorLeader: string | null;
  /** Whether the displaced prior leader was sent the "you are now a member" notification.
   *  When true, the caller need NOT message them — they have already been told. */
  notified: boolean;
  /** P-009: the compaction-cap re-seed applied to the new leader (null = re-seed skipped/failed). */
  reseed: LeaderReseedOutcome | null;
  /** Explicit operator-cancel markers cleared before leader watch reconciliation. */
  autoArmSuppressions: AutoArmSuppressionOutcome;
  /** Durable AUTO + monitor-loop + transition-watch state installed with leadership. */
  control: LeaderControlOutcome;
}

/**
 * A fleet leader's transport scope is inherited from the fleet claim-spec row.
 * Refuse the handoff before writing registry/presence state when that row is
 * absent, defaulted, or unbound: installing a leader that the next MCP call
 * cannot scope strands the session behind `harness_scope_stale` with no recovery
 * door (EI-22722766022314236).
 */
export async function assertFleetLeadershipHarnessBinding(
  workspaceId: string,
  fleetSlug: string,
): Promise<void> {
  try {
    const { fleetSpecBeeKey, getClaimSpecRecord } = await import('../../scheduler/claim-spec-store');
    const record = await getClaimSpecRecord({ cupId: fleetSpecBeeKey(fleetSlug), workspaceId });
    const harnessSlug = record.harnessSlug?.trim();
    if (record.source === 'fleet' && harnessSlug && harnessSlug !== '*' && harnessSlug.toLowerCase() !== 'all') {
      return;
    }
    throw Object.assign(
      new Error(
        `fleet '${fleetSlug}' has no concrete harness-bound claim spec; author one with scheduler:set_claim_spec before taking leadership`,
      ),
      { code: 'fleet_harness_binding_required' },
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'fleet_harness_binding_required') {
      throw error;
    }
    throw Object.assign(
      new Error(
        `fleet '${fleetSlug}' claim-spec binding could not be verified; repair it with scheduler:set_claim_spec before taking leadership: ${error instanceof Error ? error.message : String(error)}`,
      ),
      { code: 'fleet_harness_binding_unavailable' },
    );
  }
}

/**
 * P-009 (owner directive 2026-07-19): when a session ACQUIRES fleet leadership, re-seed its
 * soft compaction limit to the LEADER default (COMPACTION_LIMIT_DEFAULT_1M_CAP, 400k on a
 * [1m] session) — fixing a member launched at the leaner 300k member cap that, once promoted,
 * stayed stuck below the leader ceiling (long-lived supervision state is expensive to
 * re-derive after compaction, which is exactly why leaders get the bigger window).
 *
 * Precise + non-clobbering: the auto-lift fires ONLY when the stored limit is EXACTLY the
 * member-cap seed (COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP) — a deliberately-tuned limit,
 * an already-leader-grade limit, or a null (read-time-derived, already role-aware) is left
 * untouched. An explicit `compactionLimit` on the make-leader call wins (clamped to the leader
 * ceiling); an explicit `contextSize` signals the caller is shaping the session, so the
 * auto-lift is suppressed. Best-effort: a resolve/write failure NEVER fails the (already
 * committed) leadership transfer. Exported so the launch-into-leadership path reuses it.
 */
export async function reseedLeaderCompactionLimit(
  ownerId: string,
  opts?: {
    compactionLimit?: number;
    contextSize?: 'trimmed' | 'steward';
    harnessSlug?: string | null;
    planSlug?: string | null;
    carry?: 'warm' | 'cold';
  },
): Promise<LeaderReseedOutcome | null> {
  try {
    const { resolveModelSpecForOwner } = await import('../../compaction-usage');
    const { clampCompactionLimit, defaultCompactionLimitForSpec, COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP } =
      await import('../../agent-config-constants');
    const spec = await resolveModelSpecForOwner(ownerId).catch(() => null);
    const leaderCap = defaultCompactionLimitForSpec(spec, { fleetMember: false });
    const currentRecord = await getPresence(ownerId).catch(() => null);
    const current = currentRecord?.compactionLimit ?? null;

    if (opts?.compactionLimit != null) {
      const applied = clampCompactionLimit(opts.compactionLimit, spec, { fleetMember: false });
      await setCompactionLimit(ownerId, applied, { explicit: true });
      return { applied, from: current, reason: 'explicit-limit' };
    }
    if (opts?.contextSize) {
      return { applied: current ?? leaderCap, from: current, reason: 'explicit-context-size' };
    }
    // The member/leader cap gap only exists for [1m] sessions; otherwise there is nothing to lift.
    if (leaderCap <= COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP) {
      return { applied: current ?? leaderCap, from: current, reason: 'non-1m-no-cap-gap' };
    }
    if (current === COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP && !currentRecord?.compactionLimitExplicit) {
      await setCompactionLimit(ownerId, leaderCap, { explicit: false });
      return { applied: leaderCap, from: current, reason: 'member-cap-lifted' };
    }
    return { applied: current ?? leaderCap, from: current, reason: 'already-leader-grade' };
  } catch {
    return null; // never fail the leadership transfer on a re-seed miss
  }
}

/**
 * Transfer fleet leadership to `ownerId`. Pure-ish orchestration over the store + presence +
 * coord seams; safe to call when the caller already leads (no-op demote/notify) or the fleet
 * had no leader (just installs the caller). Never throws on a notify miss — the transfer
 * itself always lands.
 */
export async function takeFleetLeadership(
  workspaceId: string,
  fleet: AgentFleetRecord,
  identity: AgentIdentity,
  ownerId: string,
  opts?: {
    compactionLimit?: number;
    contextSize?: 'trimmed' | 'steward';
    harnessSlug?: string | null;
    planSlug?: string | null;
    carry?: 'warm' | 'cold';
    clearAutoArmSuppressions?: boolean;
    /** Full registry snapshot guard for scheduler-driven missing-leader succession. */
    succession?: {
      expectedLeaderOwnerId: string | null;
      expectedLeaderMissingSinceMs: number;
      expectedUpdatedAtMs: number;
      nowMs: number;
      graceMs: number;
    };
  },
): Promise<TakeLeadershipOutcome> {
  const slug = fleet.fleetSlug;
  const previousLeader = fleet.leaderOwnerId; // may be null, or already === caller

  // All leadership transfers, including leader-brief's automatic recovery,
  // converge here. A tool-level refusal alone leaves that internal path open.
  let goalHolderSubject: string | null;
  try {
    goalHolderSubject = await getModeSubject(workspaceId, ownerId, 'goal');
  } catch (error) {
    throw Object.assign(new Error(`GOAL holder role could not be verified: ${String(error)}`), {
      code: 'goal_holder_role_unreadable',
    });
  }
  const leadership = resolveGoalFleetLeadership({
    goalHolderSubject,
    requested: 'caller',
    callerOwnerId: ownerId,
    existingLeaderOwnerId: previousLeader,
  });
  if (!leadership.ok) {
    throw Object.assign(new Error(leadership.message), { code: 'goal_plan_fleet_self_leadership' });
  }

  // Validate the scope BEFORE the registry write. A successful leadership transfer
  // without a concrete fleet binding makes every subsequent scoped request stale.
  await assertFleetLeadershipHarnessBinding(workspaceId, slug);

  // 1. Registry: the caller becomes the sole leader (single-leader invariant, D-002).
  const installed = opts?.succession
    ? await promoteFleetLeaderIfMissing({
        workspaceId,
        fleetSlug: slug,
        expectedLeaderOwnerId: opts.succession.expectedLeaderOwnerId,
        expectedLeaderMissingSinceMs: opts.succession.expectedLeaderMissingSinceMs,
        expectedUpdatedAtMs: opts.succession.expectedUpdatedAtMs,
        replacementLeaderOwnerId: ownerId,
        nowMs: opts.succession.nowMs,
        graceMs: opts.succession.graceMs,
      })
    : await setFleetLeader(workspaceId, slug, ownerId, undefined, previousLeader);
  if (!installed) {
    throw new Error(`fleet_leadership_superseded: '${slug}' leader changed after authorization; re-orient before retrying`);
  }
  if (previousLeader !== ownerId) {
    try {
      const { emitAwaitedEvent } = await import('../../events/await/engine');
      await emitAwaitedEvent({
        key: `fleet:leader-changed:${slug}`,
        summary: `Fleet '${slug}' leadership changed to ${ownerId}.`,
        payload: { fleet: slug, previousLeader, leader: ownerId },
        source: identity.ownerId,
        workspaceId,
      });
    } catch {
      // The registry CAS is authoritative; event delivery is a wake hint.
    }
  }
  // 2. The caller's presence → this fleet's leader.
  // Explicit take-leadership calls transfer to the caller and need a heartbeat
  // to ensure there is a row to label. Scheduler succession can elect another
  // positively-live roster member; do not refresh the requesting member's
  // heartbeat as if it belonged to the elected successor.
  if (identity.ownerId === ownerId) await heartbeatPresence(identity);
  await setPresenceFleet(workspaceId, ownerId, slug, 'leader');

  // An explicit events:cancel is sticky across ordinary leader-control repairs.
  // Re-taking leadership is the deliberate operator action that may opt back in;
  // clear only this owner's exact fleet-transition keys, before reconciliation.
  const autoArmSuppressions: AutoArmSuppressionOutcome = {
    requested: opts?.clearAutoArmSuppressions === true,
    eventKeys: [],
    cleared: 0,
  };
  if (autoArmSuppressions.requested) {
    autoArmSuppressions.eventKeys = resolveFleetLeaderTransitionEventKeys({ fleetSlug: slug });
    try {
      autoArmSuppressions.cleared = await clearOperatorCancelledAwaits(
        ownerId,
        autoArmSuppressions.eventKeys,
      );
    } catch (error) {
      autoArmSuppressions.error = error instanceof Error ? error.message : String(error);
    }
  }

  // P-009: now that the caller IS the leader, lift a stuck 300k member-cap seed to the leader
  // ceiling (400k on [1m]) — unless the make-leader call passed an explicit contextSize/limit.
  // AFTER the presence-role flip so a spec/role read here sees the new leader role.
  const reseed = await reseedLeaderCompactionLimit(ownerId, opts);

  let demotedPriorLeader: string | null = null;
  let notified = false;
  if (previousLeader && previousLeader !== ownerId) {
    // The previous leader's standing transition watches outlive its role unless
    // explicitly retired. Do this even if it has since joined another fleet: the
    // keys are scoped to this slug, so cancellation cannot disturb its new lane.
    await retireFleetLeaderWatches(previousLeader, slug).catch(() => 0);
    // 3. Demote the prior leader's presence → member (ONE leader per fleet). Demote when
    //    they are still labeled in THIS fleet OR carry no fleet label (leader-of-record only
    //    / ended — setPresenceFleet is UPDATE-only, so a gone agent is a harmless no-op);
    //    SKIP only when they have since moved to a DIFFERENT fleet.
    const priorFleet =
      (await fetchPresenceFleet([previousLeader])).get(previousLeader)?.fleetSlug ?? null;
    if (shouldDemotePriorLeader(previousLeader, ownerId, priorFleet, slug)) {
      await setPresenceFleet(workspaceId, previousLeader, slug, 'member');
      demotedPriorLeader = previousLeader;
    }
    // 4. Notify the displaced leader so they KNOW they were replaced — a durable inbox
    //    inject (persists even for an ended session). Best-effort: a notify miss must never
    //    fail the leadership transfer. `notified` lets the new leader skip a redundant message.
    try {
      await sendMessage(identity, {
        to: [previousLeader],
        summary: `${ownerId} took fleet leadership of '${slug}' — you are now a member.`,
        body:
          `Leadership of fleet '${slug}' was transferred to ${ownerId}; you have been demoted ` +
          `from leader to member. The new leader owns monitoring, coordination, and driving the ` +
          `plan to completion. No action needed unless you intend to reclaim the fleet.`,
      });
      notified = true;
    } catch {
      /* best-effort: a notify miss must never fail the (already-committed) transfer */
    }
  }

  const control = await ensureFleetLeaderControl({
    workspaceId,
    ownerId,
    fleetSlug: slug,
    harnessSlug: opts?.harnessSlug,
    planSlug: opts?.planSlug,
    carry: opts?.carry,
  });

  return {
    slug,
    leader: ownerId,
    previousLeader: previousLeader ?? null,
    demotedPriorLeader,
    notified,
    reseed,
    autoArmSuppressions,
    control,
  };
}
