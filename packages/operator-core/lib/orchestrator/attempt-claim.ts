/**
 * attemptClaimWithAudit — single-call wrapper for orchestrator pickup.
 *
 * Plan: papercusp-substrate-model-b-rewrite-2026-05-31 (Stage 5).
 *
 * Pairs the two things the orchestrator always does together:
 *
 *   1. claimFeature(ownLog, opts) — append one advisory claim to the
 *      peer's OWN log (Model B; D-002). Returns `{ claimed: true }`.
 *   2. recordClaimAttempt({...}) — LOCAL PG audit row per attempt.
 *
 * The Autobase merge-order arbiter is gone: there is no won/lost race, so
 * the audit outcome is always `'won'` (this peer asserted the claim). The
 * claim appends to the APPEND-ONLY `feature_claims` audit history keyed
 * `<feature_id>/<seq>`; it does not cross-author-collide, so there is no
 * LWW-clobber and no clobber-toast on this path. Who currently holds a
 * feature is derived separately (latest `claimed_at`); the real authority
 * is the GitHub PR merge.
 *
 * If the audit write fails (PG unreachable, schema not present), the claim
 * still succeeds — auditing is best-effort. The orchestrator's decision
 * must not depend on the audit succeeding.
 */

import {
  claimFeature,
  ClaimValidationError,
  type ClaimOwnLog,
  type ClaimResult,
} from './feature-claim';
import {
  recordClaimAttempt,
  type ClaimOutcome,
} from './claim-audit';

export interface AttemptClaimOpts {
  workspaceId: string;
  harnessSlug: string;
  feature_id: string;
  claimer_github_user_id: number;
  /** Override for tests; defaults to Date.now(). */
  now_ms?: number;
}

export interface AttemptClaimResult extends ClaimResult {
  audit_outcome: ClaimOutcome;
  audit_recorded: boolean;
  audit_error?: string;
}

export async function attemptClaimWithAudit(
  ownLog: ClaimOwnLog,
  opts: AttemptClaimOpts,
): Promise<AttemptClaimResult> {
  let result: ClaimResult;
  try {
    result = await claimFeature(ownLog, {
      harness_slug: opts.harnessSlug,
      feature_id: opts.feature_id,
      claimer_github_user_id: opts.claimer_github_user_id,
      now_ms: opts.now_ms,
    });
  } catch (e) {
    // Validation errors propagate; only ClaimValidationError is expected.
    // Anything else (own-log append failure) gets audited as 'error' before
    // re-throwing.
    if (e instanceof ClaimValidationError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await recordClaimAttempt({
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
        feature_id: opts.feature_id,
        claimer_pubkey: ownLog.keyHex,
        outcome: 'error',
        detail: msg.slice(0, 500),
        attempt_ts: opts.now_ms,
      });
    } catch {
      // best-effort; swallow audit failure and re-throw the original error.
    }
    throw e;
  }

  // Advisory claim: the attempt always succeeds (the op was appended).
  const outcome: ClaimOutcome = 'won';
  let auditRecorded = false;
  let auditError: string | undefined;
  try {
    await recordClaimAttempt({
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      feature_id: opts.feature_id,
      claimer_pubkey: ownLog.keyHex,
      outcome,
      attempt_ts: opts.now_ms,
    });
    auditRecorded = true;
  } catch (e) {
    auditError = e instanceof Error ? e.message : String(e);
    // best-effort; don't fail the claim outcome
  }

  return {
    ...result,
    audit_outcome: outcome,
    audit_recorded: auditRecorded,
    audit_error: auditError,
  };
}
