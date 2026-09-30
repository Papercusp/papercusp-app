/**
 * The delivery half of a GOAL holder election.
 *
 * The lease/CAS in modes/store is the authority source. This module makes the
 * losing holder aware immediately: disarm its recurring loop, persist a direct
 * stand-down message, invalidate its Orders projection, and wake it to finish
 * only the bounded handoff. All callers use this one seam so a system recovery
 * and an interactive current-holder handoff cannot drift.
 */
import type { GoalModeElectionReceipt } from '../modes/store';
import { deactivateLoop } from '../harness/routines/loop';
import { notifyAgentOrdersChanged } from '../agent-orders-notify';
import { sendMessage } from '../agent-tools/coordination/messages';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import {
  vacateDrainFleetLeadership,
  type DrainFleetVacancyOutcome,
} from './vacate-drain-fleet-leadership';

const HANDOFF_IDENTITY: AgentIdentity = {
  ownerId: 'goal-holder-election',
  ownerLabel: 'system · goal holder election',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export interface GoalHolderHandoffDeps {
  deactivate: (ownerId: string, reason: string) => Promise<boolean>;
  notifyOrders: (ownerId: string) => Promise<void>;
  message: (ownerId: string, summary: string, body: string) => Promise<void>;
  wake: (
    ownerId: string,
    summary: string,
    payload: Record<string, unknown>,
    workspaceId: string,
  ) => Promise<{ woken: number; staged: number }>;
  /**
   * EI-22402152554463916: clear the outgoing holder from the goal's drain-fleet leader seat.
   * The election disarms the loop here, so this is the one moment the system already knows
   * the agent is standing down — and the seat must be VACATED, never re-seated on the
   * incoming holder (see vacate-drain-fleet-leadership for why).
   */
  vacateDrainFleet: (
    workspaceId: string,
    goalId: string,
    outgoingOwnerId: string,
  ) => Promise<DrainFleetVacancyOutcome>;
}

const DEFAULT_DEPS: GoalHolderHandoffDeps = {
  deactivate: async (ownerId, reason) =>
    await deactivateLoop(ownerId, { actor: HANDOFF_IDENTITY.ownerId, reason }),
  notifyOrders: notifyAgentOrdersChanged,
  message: async (ownerId, summary, body) => {
    await sendMessage(HANDOFF_IDENTITY, { to: [ownerId], summary, body });
  },
  wake: async (ownerId, summary, payload, workspaceId) => {
    const result = await wakeRecipients([ownerId], {
      summary,
      payload,
      source: HANDOFF_IDENTITY.ownerId,
      workspaceId,
    });
    return { woken: result.woken, staged: result.staged };
  },
  vacateDrainFleet: vacateDrainFleetLeadership,
};

export interface GoalHolderHandoffNotice {
  predecessorOwnerId: string;
  successorOwnerId: string;
  goalId: string;
  epoch: number;
  handoffExpiresAt: string | null;
  loopDeactivated: boolean;
  woken: number;
  staged: number;
  /** What became of the goal's drain-fleet leader seat (EI-22402152554463916). */
  drainFleet: DrainFleetVacancyOutcome;
}

export async function notifyGoalHolderHandoff(
  workspaceId: string,
  election: GoalModeElectionReceipt,
  deps: GoalHolderHandoffDeps = DEFAULT_DEPS,
): Promise<GoalHolderHandoffNotice | null> {
  const predecessorOwnerId = election.predecessorOwnerId;
  if (!predecessorOwnerId) return null;
  const expiry = election.handoffExpiresAt ?? 'immediately';
  const summary =
    `GOAL holder handoff: '${election.goalId}' elected ${election.ownerId} ` +
    `(epoch ${election.epoch}); ${predecessorOwnerId} must stand down`;
  const loopDeactivated = await deps.deactivate(
    predecessorOwnerId,
    `GOAL lease '${election.goalId}' transferred to ${election.ownerId} at epoch ${election.epoch}`,
  );
  // EI-22402152554463916: standing down the holder while leaving it registered as the drain
  // fleet's leader is worse than leaving that fleet leaderless — a filled slot that never acts
  // reads as healthy on every liveness surface. Clear it in the same transaction that disarms
  // the loop, which is the one moment the system already knows this agent is standing down.
  const drainFleet = await deps.vacateDrainFleet(
    workspaceId,
    election.goalId,
    predecessorOwnerId,
  );
  const body =
    `Your GOAL holder lease for '${election.goalId}' was superseded by ${election.ownerId} ` +
    `(epoch ${election.epoch}). Your recurring loop has been disarmed. Finish only the atomic ` +
    `handoff already in flight before ${expiry}; after that boundary, goal-scoped context, ` +
    `mutations, and launches refuse with the elected-holder diagnosis. Checkpoint and release ` +
    `your lane; do not re-enter GOAL mode or retry acquisition.` +
    (drainFleet.vacated
      ? ` You were also the registered leader of drain fleet '${drainFleet.fleetSlug}'; that ` +
        `seat has been VACATED so a launched member can take it via fleet:take-leadership. ` +
        `Do not reclaim it — you have stood down.`
      : '');
  await deps.notifyOrders(predecessorOwnerId);
  await deps.message(predecessorOwnerId, summary, body);
  const wake = await deps.wake(
    predecessorOwnerId,
    summary,
    {
      goalId: election.goalId,
      electedOwnerId: election.ownerId,
      electedEpoch: election.epoch,
      handoffExpiresAt: election.handoffExpiresAt,
      action: 'stand-down',
    },
    workspaceId,
  );
  return {
    predecessorOwnerId,
    successorOwnerId: election.ownerId,
    goalId: election.goalId,
    epoch: election.epoch,
    handoffExpiresAt: election.handoffExpiresAt,
    loopDeactivated,
    woken: wake.woken,
    staged: wake.staged,
    drainFleet,
  };
}
