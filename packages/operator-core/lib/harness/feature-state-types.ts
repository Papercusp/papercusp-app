/**
 * feature-state-types — pure state machine for the §0.5 feature
 * lifecycle per papercusp-dogfood-v5.
 *
 * Types-only and PURE. No PG, no orchestrator.
 *
 * Twenty-ninth module in the dogfood-arc types-only spine.
 *
 * Per v5 §0.5 five-state machine:
 *   backlog       → filed but not in any user's queue
 *   in_queue      → pulled into a user's queue (feature_queue row exists)
 *   working       → orchestrator claimed via §0.6 OR user flipped manually
 *   pending_done  → agent finished, PR opened, awaiting review/merge
 *   shipped       → PR merged; completion_ref populated
 *
 * Lifecycle on merge: feature row stays in PG/Hyperbee with status='shipped';
 * the user/<id> branch is NOT deleted (stays as workspace).
 */

import {
  type CompletionRef,
} from './completion-ref-types';

/**
 * The 5 canonical lifecycle states per §0.5.
 */
export const FEATURE_STATES = [
  'backlog',
  'in_queue',
  'working',
  'pending_done',
  'shipped',
] as const;
export type FeatureState = (typeof FEATURE_STATES)[number];

/**
 * Forward transitions per §0.5. Each entry lists the states that
 * are valid next-states from the key. Used by the runtime to refuse
 * illegal flips (e.g. backlog → shipped without going through
 * in_queue/working/pending_done first).
 *
 * Notably:
 *   - backlog can advance to in_queue (queued by a user).
 *   - in_queue can advance to working (claimed) OR revert to backlog
 *     (user removed from queue with no one else queued).
 *   - working can advance to pending_done (PR opened) OR revert to
 *     in_queue (user abandoned, agent crashed, rebase conflict per §16.3).
 *   - pending_done can advance to shipped (merged) OR revert to
 *     in_queue (PR closed without merge, user abandoned).
 *   - shipped is terminal — once `completion_ref` is populated and
 *     verified, no further transitions allowed in v1.
 */
export const FEATURE_STATE_FORWARD: Record<FeatureState, ReadonlySet<FeatureState>> = {
  backlog: new Set(['in_queue']),
  in_queue: new Set(['working', 'backlog']),
  working: new Set(['pending_done', 'in_queue']),
  pending_done: new Set(['shipped', 'in_queue']),
  shipped: new Set(),
};

/**
 * Terminal states per §0.5. `shipped` is the only terminal in v1;
 * a possible v2 might add `dropped` or `abandoned` — codified here
 * as a single source of truth so the orchestrator + UI can both
 * check "is this still in flight?"
 */
export const FEATURE_TERMINAL_STATES: ReadonlySet<FeatureState> = new Set(['shipped']);

/**
 * Pure predicate: is this transition allowed per §0.5?
 */
export function isLegalTransition(from: FeatureState, to: FeatureState): boolean {
  return FEATURE_STATE_FORWARD[from].has(to);
}

/**
 * Pure predicate: is this state terminal?
 */
export function isTerminal(state: FeatureState): boolean {
  return FEATURE_TERMINAL_STATES.has(state);
}

/**
 * Discriminated result for an attempted transition.
 *
 *   `ok`           — transition allowed; apply.
 *   `illegal`      — transition not in the forward-graph.
 *   `already_terminal` — `from` is shipped; v1 forbids re-opening.
 *   `missing_completion_ref` — `to === 'shipped'` but no completion_ref
 *                              supplied; the §15 trust-tier-B invariant
 *                              demands one before shipping.
 */
export type TransitionResult =
  | { kind: 'ok' }
  | { kind: 'illegal'; from: FeatureState; to: FeatureState }
  | { kind: 'already_terminal'; from: FeatureState }
  | { kind: 'missing_completion_ref' };

/**
 * Pure transition function. Inspects the from/to + (optionally) a
 * completion_ref and returns ok or a structured reason. The
 * orchestrator + UI both consume this to reject bad flips cleanly.
 */
export function attemptTransition(args: {
  from: FeatureState;
  to: FeatureState;
  completion_ref?: CompletionRef;
}): TransitionResult {
  if (isTerminal(args.from)) {
    return { kind: 'already_terminal', from: args.from };
  }
  if (!isLegalTransition(args.from, args.to)) {
    return { kind: 'illegal', from: args.from, to: args.to };
  }
  if (args.to === 'shipped' && args.completion_ref === undefined) {
    return { kind: 'missing_completion_ref' };
  }
  return { kind: 'ok' };
}

/**
 * Pure predicate: is this state one where the §9.1 Features tab
 * should render the feature in the "active" column vs "done" column?
 */
export function isActiveState(state: FeatureState): boolean {
  return state !== 'shipped';
}

/**
 * Pure predicate: does this state allow the orchestrator to pick
 * the feature (start a worker run on it)? Only `in_queue` per §0.6.
 */
export function isOrchestratorPickable(state: FeatureState): boolean {
  return state === 'in_queue';
}

/**
 * Pure predicate: does this state mean the feature has reached the
 * tier-B verifier surface? `pending_done` and `shipped` both have
 * completion_ref populated and are subject to the §15 verifier.
 */
export function hasCompletionRefSurface(state: FeatureState): boolean {
  return state === 'pending_done' || state === 'shipped';
}

/**
 * The dogfood-arc rebase-conflict path per §16.3 resets a working
 * feature back to in_queue. This helper builds the reset-target
 * state given the failure kind. Pure — caller maps git result into
 * the right reset.
 */
export type WorkingFailureReason =
  | 'rebase_conflict'
  | 'worker_crashed'
  | 'user_abandoned'
  | 'pr_closed_without_merge';

export function resetTargetForFailure(reason: WorkingFailureReason): FeatureState {
  // All known failure modes from a working state revert to in_queue
  // per §16.3 + §0.5 reverse-edge rules. Encoded as a function so
  // future failure modes can return different targets without
  // hunting through call-sites.
  void reason;
  return 'in_queue';
}

/**
 * Sort key for §9.1 Features tab ordering. Renders states in the
 * canonical lifecycle order (backlog → in_queue → working →
 * pending_done → shipped). Used by the UI to bucket features
 * within a single rendering pass.
 */
export const FEATURE_STATE_ORDER: Record<FeatureState, number> = {
  backlog: 0,
  in_queue: 1,
  working: 2,
  pending_done: 3,
  shipped: 4,
};

export function compareFeatureStatesByLifecycle(a: FeatureState, b: FeatureState): number {
  return FEATURE_STATE_ORDER[a] - FEATURE_STATE_ORDER[b];
}
