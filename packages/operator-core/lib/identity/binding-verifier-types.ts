/**
 * binding-verifier-types — types for the contributor binding state.
 *
 * Sources from `dogfood-design-memo-two-channel-binding-ux-2026-05-24.md`
 * (Phase 1b P-075). Types-only — no I/O, no Octokit calls, no PG.
 *
 * The two-channel `verifyBoth` runtime — and its `deriveBindingStatus`
 * pending/grace-window state machine + the `BindingVerificationResult` shape
 * and grace-window constants — was removed by the write-free-join work
 * (`non-collaborator-join-fork-pr-2026-06-02`): admission now gates on
 * `verifyAttestation` directly. What remains here is the `BindingStatus`
 * vocabulary, the `ChannelResult` shape (used by `verifyChannel1`), and the
 * per-status predicates the Contributors tab / Insights People card consume
 * (`statsAggregateForStatus`, `canClaimHarness`).
 */

/**
 * The three states from memo §"Visual vocabulary":
 *   - `verified`: both channels passed. Stats aggregate. ✓ badge.
 *   - `pending`: channel 1 passed; channel 2 still propagating or
 *     transient channel-2 re-verification failure within grace window.
 *     Stats do NOT aggregate yet. ⏳ badge.
 *   - `unverified`: channel 1 failed, or channel 2 conclusively missing
 *     (gist 404 / branch deleted), or pending grace window expired.
 *     Stats do not aggregate. ⚠ badge.
 */
export type BindingStatus = 'verified' | 'pending' | 'unverified';

/**
 * Per-channel verification result. The structured `reason` lets the
 * UI surface specific copy (e.g. "channel 2 file missing on
 * user/<id> branch") rather than free-text.
 *
 * Both channels return one of three outcomes; `pending` is the
 * channel-1-passed-channel-2-not-yet state, which is meaningful only
 * for channel 2 (channel 1 is synchronous OAuth re-check, no pending).
 */
export type ChannelResult =
  | { kind: 'ok' }
  | { kind: 'pending'; reason: ChannelPendingReason }
  | { kind: 'fail'; reason: ChannelFailReason };

export type ChannelPendingReason =
  | 'just_joined_channel2_propagating'
  | 'channel2_transient_network'
  | 'channel2_rate_limit_retry';

export type ChannelFailReason =
  // Channel 1 (OAuth re-check)
  | 'oauth_token_mismatch'
  | 'oauth_token_revoked'
  | 'oauth_user_id_mismatch'
  // Channel 2 (signed file on user branch)
  | 'channel2_file_missing'
  | 'channel2_signature_invalid'
  // Channel 2 (gist-ownership attestation — replaces commit-signing check)
  /** Gist 404 — was never published, or was deleted (revocation signal). */
  | 'channel2_attestation_missing'
  /** Gist exists but owner/pubkey/signature mismatch — forgery indicator. */
  | 'channel2_attestation_invalid'
  // Either
  | 'github_api_down'
  | 'unknown';

/**
 * Predicate: does the binding state allow this contributor to claim
 * a harness? Per memo D-E + addendum-1: only `verified` qualifies.
 * Used by the claim-CTA gate (Phase 8 P-069e).
 */
export function canClaimHarness(status: BindingStatus): boolean {
  return status === 'verified';
}

/**
 * Predicate: does the binding state count for stats aggregation?
 * Per memo §"Per-surface treatment": only verified contributors
 * contribute to any tier's rollup. `pending` defers; `unverified`
 * excludes outright.
 *
 * Used by the contributor_usage_events rollup (P-070) + the Insights
 * People card filter (memo D-B: unverified excluded).
 */
export function statsAggregateForStatus(status: BindingStatus): boolean {
  return status === 'verified';
}
