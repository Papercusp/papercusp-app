/**
 * Pure progress accounting for the existing goal obligation/cursor machinery.
 * Receipts must come from delivery/native-turn and canonical effect writers,
 * never from an agent's assertion, a heartbeat or a launch request.
 */
export interface GoalPlacementProgressScope {
  workspaceId: string;
  ownerId: string;
  goalId: string;
  planRef: string;
}

export function goalPlacementProgressScopeKey(scope: GoalPlacementProgressScope): string {
  return JSON.stringify([scope.workspaceId, scope.ownerId, scope.goalId, scope.planRef]);
}

export interface GoalPlacementEffect {
  kind: 'member-claim' | 'verified-completion' | 'verified-repair';
  ref: string;
  at: string;
}

export interface GoalPlacementOpportunity {
  deliveryToken: string;
  completedTurnRef: string;
  offeredAt: string;
  completedAt: string;
  eligibleAtOffer: boolean;
  eligibleAtCompletion: boolean;
}

export interface GoalPlacementProgressState {
  version: 1;
  scopeKey: string;
  firstEligibleAt: string | null;
  lastEffect: GoalPlacementEffect | null;
  lastDeliveryToken: string | null;
  lastCompletedTurnRef: string | null;
  lastCompletedAt: string | null;
  /** Saturated at the two-opportunity repair threshold. */
  opportunities: number;
  /** Eligible completed repair decisions after stalledAt; absent on older v1 receipts. */
  repairOpportunities?: number;
  stalledAt: string | null;
}

export interface GoalPlacementProgressView {
  state: GoalPlacementProgressState;
  status: 'known' | 'unknown';
  reason: string | null;
  ageMs: number | null;
  stalled: boolean;
}

const EFFECT_KINDS = new Set(['member-claim', 'verified-completion', 'verified-repair']);
const time = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
const nonempty = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

export function advanceGoalPlacementProgress(input: {
  scopeKey: string;
  previous: GoalPlacementProgressState | null;
  now: string;
  effect?: GoalPlacementEffect | null;
  opportunity?: GoalPlacementOpportunity | null;
}): GoalPlacementProgressView {
  const state: GoalPlacementProgressState = input.previous ? { ...input.previous } : {
    version: 1, scopeKey: input.scopeKey, firstEligibleAt: null, lastEffect: null,
    lastDeliveryToken: null, lastCompletedTurnRef: null, lastCompletedAt: null,
    opportunities: 0, stalledAt: null,
  };
  const now = time(input.now);
  const view = (reason: string | null = null): GoalPlacementProgressView => {
    const anchor = time(state.lastEffect?.at ?? state.firstEligibleAt);
    return { state, status: reason ? 'unknown' : 'known', reason,
      ageMs: Number.isFinite(anchor) && Number.isFinite(now) ? Math.max(0, now - anchor) : null,
      stalled: reason == null && state.opportunities >= 2 };
  };
  if (!nonempty(input.scopeKey) || state.version !== 1 || state.scopeKey !== input.scopeKey || !Number.isFinite(now)) {
    return view('Progress scope or observation time is invalid.');
  }
  if (!Number.isInteger(state.opportunities) || state.opportunities < 0 || state.opportunities > 2) {
    return view('Stored progress counter is invalid.');
  }
  const repairs = state.repairOpportunities ?? 0;
  if (!Number.isInteger(repairs) || repairs < 0 || repairs > 2 ||
    (repairs > 0 && state.opportunities !== 2)) {
    return view('Stored repair counter is invalid.');
  }
  const storedTimes = [state.firstEligibleAt, state.lastCompletedAt, state.stalledAt, state.lastEffect?.at ?? null];
  if (storedTimes.some((at) => at !== null && (!Number.isFinite(time(at)) || time(at) > now)) ||
    (state.lastEffect && (!EFFECT_KINDS.has(state.lastEffect.kind) || !nonempty(state.lastEffect.ref))) ||
    (state.opportunities > 0 && (state.firstEligibleAt === null || state.lastCompletedAt === null)) ||
    ((state.opportunities === 2) !== (state.stalledAt !== null))) {
    return view('Stored progress receipts are invalid or incomplete.');
  }
  const effect = input.effect;
  if (effect && (!EFFECT_KINDS.has(effect.kind) || !nonempty(effect.ref) ||
    !Number.isFinite(time(effect.at)) || time(effect.at) > now)) {
    return view('Effect lacks a recognized canonical receipt or valid timestamp.');
  }
  const opportunity = input.opportunity;
  if (opportunity && (!nonempty(opportunity.deliveryToken) || !nonempty(opportunity.completedTurnRef) ||
    typeof opportunity.eligibleAtOffer !== 'boolean' || typeof opportunity.eligibleAtCompletion !== 'boolean' ||
    !Number.isFinite(time(opportunity.offeredAt)) || !Number.isFinite(time(opportunity.completedAt)) ||
    time(opportunity.offeredAt) > time(opportunity.completedAt) || time(opportunity.completedAt) > now)) {
    return view('Opportunity lacks exact delivery and completed-turn evidence.');
  }
  // A read, retry, lease renewal or repeated observation of the SAME receipt
  // cannot move the verified effect clock. Older out-of-order effects cannot either.
  if (effect && (!state.lastEffect || (effect.ref !== state.lastEffect.ref && time(effect.at) > time(state.lastEffect.at)))) {
    state.lastEffect = { ...effect };
    state.opportunities = 0;
    delete state.repairOpportunities;
    state.stalledAt = null;
  }
  if (!opportunity) return view();
  const completed = time(opportunity.completedAt);
  if (opportunity.deliveryToken === state.lastDeliveryToken ||
    opportunity.completedTurnRef === state.lastCompletedTurnRef ||
    completed <= time(state.lastCompletedAt)) return view();
  // Consume the receipt even when excluded: replaying a blocked interval with
  // a changed assertion must never manufacture another opportunity.
  state.lastDeliveryToken = opportunity.deliveryToken;
  state.lastCompletedTurnRef = opportunity.completedTurnRef;
  state.lastCompletedAt = opportunity.completedAt;
  if (!opportunity.eligibleAtOffer || !opportunity.eligibleAtCompletion) return view();
  if (state.lastEffect && time(opportunity.offeredAt) <= time(state.lastEffect.at)) return view();
  state.firstEligibleAt ??= opportunity.offeredAt;
  // Only a fresh, completed, eligible offer AFTER the initial stall can spend
  // the repair bound. Reads, live calls and excluded receipts never reach here.
  if (state.stalledAt && time(opportunity.offeredAt) > time(state.stalledAt)) {
    state.repairOpportunities = Math.min(2, (state.repairOpportunities ?? 0) + 1);
  }
  state.opportunities = Math.min(2, state.opportunities + 1);
  if (state.opportunities === 2) state.stalledAt ??= opportunity.completedAt;
  return view();
}
