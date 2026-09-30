/**
 * orchestrator-claim-decision-types — pure pre-flight + post-arbitration
 * decisions for the §0.6 orchestrator distributed claim flow per
 * papercusp-dogfood-v5 (D-002).
 *
 * Types-only and PURE. No Autobase, no PG.
 *
 * Thirtieth module in the dogfood-arc types-only spine.
 *
 * Per v5 §0.6 6-step protocol:
 *   1. Orchestrator reads PG, finds feature in_queue with empty working_users.
 *   2. Appends a claim record to harness Autobase.
 *   3. Awaits its own append being merged into local Autobase view.
 *   4. Reads merged view, finds ALL claims for the feature.
 *   5. If A's claim is first in (writer_pubkey, seq) order → A wins → fire agent.
 *   6. The losing peer NEVER fires its agent; mathematical guarantee.
 *
 * This module covers:
 *   - Pre-flight: should orchestrator attempt to claim?
 *     (decideShouldAttemptClaim — gates on state + empty working_users)
 *   - Post-arbitration: did this peer win? (reuses arbitrateClaims from
 *     feature-claim-types; this module adds the "dispatch the worker"
 *     decision atop)
 *   - Retry-on-loss: which feature to try next? (cooldown helpers)
 *
 * Sister to feature-claim-types: that one defines the wire shape +
 * arbitrator function; this one is the *orchestrator-side* decision
 * code that uses it.
 */

import {
  FEATURE_STATES,
  type FeatureState,
} from './feature-state-types';
import {
  arbitrateClaims,
  type ClaimOutcomeStamped,
  type FeatureClaimRecord,
} from './feature-claim-types';

/**
 * Discriminated pre-flight decision per §0.6 step 1.
 *
 *   `attempt` — feature is in_queue + working_users empty → attempt claim
 *   `skip_wrong_state` — feature is not in_queue (someone else's claim
 *                        already advanced it, or it's already shipped, etc.)
 *   `skip_already_working` — working_users is non-empty (another peer
 *                            already won + dispatched a worker)
 *   `skip_blocked` — feature has open blockers (e.g. dependency feature
 *                    not yet shipped)
 */
export type ClaimPreflightDecision =
  | { kind: 'attempt' }
  | { kind: 'skip_wrong_state'; state: FeatureState }
  | { kind: 'skip_already_working'; working_users: readonly number[] }
  | { kind: 'skip_blocked'; blocker_feature_ids: readonly string[] };

/**
 * Pre-flight: should the orchestrator attempt to claim this feature?
 * Pure — caller passes the current feature state + working_users +
 * any blocker list from a separate query.
 */
export function decideShouldAttemptClaim(args: {
  feature_state: FeatureState;
  working_users: readonly number[];
  blocker_feature_ids: readonly string[];
}): ClaimPreflightDecision {
  if (args.feature_state !== 'in_queue') {
    return { kind: 'skip_wrong_state', state: args.feature_state };
  }
  if (args.working_users.length > 0) {
    return { kind: 'skip_already_working', working_users: args.working_users };
  }
  if (args.blocker_feature_ids.length > 0) {
    return { kind: 'skip_blocked', blocker_feature_ids: args.blocker_feature_ids };
  }
  return { kind: 'attempt' };
}

/**
 * Discriminated post-arbitration decision per §0.6 step 5-6.
 *
 *   `dispatch` — this peer won; fire the worker
 *   `stand_down` — this peer lost; move on
 *   `await` — no arbitration yet (in-flight claim still null-outcome);
 *             keep polling
 */
export type ClaimResolutionDecision =
  | { kind: 'dispatch'; winning_claim: FeatureClaimRecord }
  | { kind: 'stand_down'; winner_pubkey: string; winner_seq: number }
  | { kind: 'await' };

/**
 * Post-arbitration: given the in-flight claims for a feature + this
 * peer's own claim record, decide whether to fire the worker.
 *
 * Returns `await` when the arbitrator hasn't yet stamped a winner
 * (orchestrator must poll the local Autobase view). Returns
 * `dispatch` when this peer's claim was first in the (writer_pubkey,
 * seq) merge order; `stand_down` when another peer's was.
 *
 * Pure — caller provides the in-flight list + this peer's pubkey.
 */
export function decideClaimResolution(args: {
  inflight_by_merge_order: ReadonlyArray<FeatureClaimRecord>;
  my_pubkey: string;
}): ClaimResolutionDecision {
  if (args.inflight_by_merge_order.length === 0) {
    return { kind: 'await' };
  }
  // Use arbitrateClaims to compute outcomes; the first claim wins.
  const outcomes = arbitrateClaims(
    args.inflight_by_merge_order.map((c) => ({ seq: c.seq })),
  );
  const winner_idx = outcomes.findIndex((o) => o.outcome === 'won');
  if (winner_idx === -1) {
    // Defensive: arbitrateClaims always stamps one winner when input
    // is non-empty; reaching here means an empty input slipped past
    // the guard above. Treat as await.
    return { kind: 'await' };
  }
  const winner = args.inflight_by_merge_order[winner_idx]!;
  if (winner.claimer_pubkey === args.my_pubkey) {
    return { kind: 'dispatch', winning_claim: winner };
  }
  return {
    kind: 'stand_down',
    winner_pubkey: winner.claimer_pubkey,
    winner_seq: winner.seq,
  };
}

/**
 * Per-loss cooldown: orchestrator that loses on feature F shouldn't
 * immediately re-try F (chance another claim is still racing). Wait
 * a small backoff, then move to a different in_queue feature.
 *
 * Pure constants — runtime imports.
 */
export const CLAIM_LOSS_COOLDOWN_MS = 5_000;
export const CLAIM_AWAIT_POLL_INTERVAL_MS = 100;

/**
 * §0.6 latency floor: "Autobase merge convergence (~50–200ms on
 * healthy mesh)". Encoded as a constant so the orchestrator's
 * watchdog can detect "I appended but my view never converged"
 * (means the mesh is unhealthy + escalate).
 */
export const AUTOBASE_MERGE_CONVERGENCE_HEALTHY_MS = 200;
export const AUTOBASE_MERGE_CONVERGENCE_TIMEOUT_MS = 5_000;

/**
 * Predicate: has the claim been pending long enough that the
 * orchestrator should escalate "mesh unhealthy"? Pure — caller
 * passes the claim's `claimed_at` + `now`.
 */
export function isMeshConvergenceTimeout(args: {
  claimed_at: number;
  now: number;
}): boolean {
  return args.now - args.claimed_at > AUTOBASE_MERGE_CONVERGENCE_TIMEOUT_MS;
}

/**
 * Pick-next helper: given a list of `(feature_id, state)` rows for
 * features the orchestrator could try, pick the next pickable one
 * filtered by states that are §0.6-eligible. Returns null if no
 * pickable features remain.
 *
 * Caller is responsible for excluding features the orchestrator
 * just lost on (within CLAIM_LOSS_COOLDOWN_MS); this is just the
 * state-filter step.
 */
export function pickNextClaimableFeature(
  candidates: ReadonlyArray<{ feature_id: string; state: FeatureState }>,
): string | null {
  for (const c of candidates) {
    if (c.state === 'in_queue') return c.feature_id;
  }
  return null;
}

/**
 * Pure predicate: does the §0.6 protocol allow this state to be a
 * claim source? Currently in_queue only. Encoded as a function so
 * a future "allow re-claim of pending_done features for a different
 * worker" can change in one place.
 */
export function isClaimable(state: FeatureState): boolean {
  return state === 'in_queue';
}

/**
 * Audit row helper: given a post-arbitration decision, what
 * `outcome` should the LOCAL claim_audit table record? Pure
 * mapping from decision to audit outcome.
 *
 * Uses ClaimOutcomeStamped values + 'error' for await-timeouts.
 */
export function auditOutcomeFromDecision(
  decision: ClaimResolutionDecision,
): ClaimOutcomeStamped | 'error' {
  switch (decision.kind) {
    case 'dispatch':
      return 'won';
    case 'stand_down':
      return 'lost';
    case 'await':
      return 'error';
  }
}

/**
 * Re-export for downstream convenience: every consumer of this
 * module also needs FEATURE_STATES.
 */
export { FEATURE_STATES };
