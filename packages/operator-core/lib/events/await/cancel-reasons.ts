/**
 * The cancel_reason each SYSTEM cancel path stamps on harness_shared.event_awaits
 * (WI-10005938 class fix).
 *
 * A NULL reason reads as unexplained churn wherever delivery is measured:
 * goal-holder-behavior-metrics counts `cancel_reason IS NULL` as unexplained,
 * so a cancel that names no reason makes a reminder plane look broken. In one
 * measured 2h window, 18 agent-obligation watches were cancelled through these
 * generic paths with no reason at all, beside 22 more retired by re-registration.
 *
 * Rule: every UPDATE that sets event_awaits.cancelled_at also sets a non-null
 * cancel_reason. cancel-reason-coverage.test.ts scans the tree and fails on a
 * new path that does not.
 *
 * 'operator' is deliberately absent: it is the user-cancel marker that
 * suppresses a later auto-arm (index event_awaits_operator_cancelled_key) and
 * is set only through cancelAwaitDetailed's `source:'operator'`.
 *
 * Leaf module (no imports) so store.ts, compose-store.ts, the idle-session
 * reaper and rebind-identity can all import it without a cycle.
 */
export const AWAIT_CANCEL_REASONS = {
  /** retireLifecycleBoundWatches: the claim / lane / obligation the watch was bound to ended. */
  lifecycleBindingRetired: 'lifecycle-binding-retired',
  /** retireWatchesForReapedOwners: the subscriber was reaped as confirmed dead. */
  ownerReaped: 'owner-reaped',
  /** cancelInboxWakeAwaits: SessionEnd hygiene for the standing inbox wake. */
  inboxWakeSessionEnded: 'inbox-wake-session-ended',
  /** cancelClaimableAwaits: the subscriber claimed work, so its idle wait is stale. */
  claimableWorkClaimed: 'claimable-work-claimed',
  /** cancelClaimableAwaits { includeStanding }: the subscriber's fleet is paused. */
  claimableFleetPaused: 'claimable-fleet-paused',
  /** cancelAwaitsForSubscribersOnKeys default: a sibling outcome fired, or a re-arm superseded the key. */
  siblingOrSupersededKey: 'sibling-or-superseded-key',
  /** cancelAwaitsByIds default: the caller identified exactly these dead registrations. */
  exactIdCleanup: 'exact-id-cleanup',
  /** cancelAwaitDetailed without source or reason: an internal cleanup caller. */
  internalCleanup: 'internal-cleanup',
  /** voidTreeDescendants: a composed root fired, so its pending leaves are void. */
  composedTreeVoided: 'composed-tree-voided',
  /** cancelComposedTree without source:'operator': an internal caller cancelled the tree. */
  composedTreeCancelled: 'composed-tree-cancelled',
  /** reconcileComposedRoot: the root settled, so its remaining leaves are void. */
  composedRootSettled: 'composed-root-settled',
  /** rebind-identity: the moved await duplicated one the new identity already holds. */
  identityRebound: 'identity-rebound',
  /** reclaimDanglingInboxWakeAwaits: the idle reaper found the owner dead. */
  danglingInboxWakeReclaimed: 'dangling-inbox-wake-reclaimed',
} as const;

export type AwaitSystemCancelReason = (typeof AWAIT_CANCEL_REASONS)[keyof typeof AWAIT_CANCEL_REASONS];
