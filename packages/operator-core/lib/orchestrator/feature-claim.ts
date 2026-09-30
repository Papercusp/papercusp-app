/**
 * Distributed feature-claim primitive (Model B, Stage 5).
 *
 * Plan: papercusp-substrate-model-b-rewrite-2026-05-31 (Stage 5).
 * Supersedes the Phase-6 P-036 Autobase merge-order arbiter.
 *
 * D-002 (settled): a claim ("I'm working on F-042") is an ADVISORY hint,
 * NOT a merge-order arbitration. There is no global ordering, no "did I
 * win the race" wait. `claimFeature`:
 *
 *   1. Appends ONE claim op to the peer's OWN single-writer log
 *      (`ownLog.append`). The op value is a `FeatureClaimRow` so the
 *      EXISTING `projections/feature-claims.ts` projection round-trips it
 *      to `harness_shared.feature_claims` verbatim on the next read-merge.
 *   2. Returns immediately `{ claimed: true }` — no awaiting convergence.
 *
 * `feature_claims` is an APPEND-ONLY per-attempt audit history. Each claim
 * op is keyed `<feature_id>/<seq>` where `seq = ownLog.length` — so each
 * claim a peer makes occupies a DISTINCT key (its own log's seq advances)
 * and every claim row persists as its own audit row. There is no
 * cross-author key collision on this path: two peers claiming the same
 * feature get different seqs → different keys → both rows survive the
 * read-merge, nothing is clobbered. "Who currently holds feature F" is a
 * SEPARATE derived read (the latest `claimed_at` row for F), not an
 * LWW winner-takes-the-key. Claims are advisory — the real authority is
 * the GitHub PR merge — so there is no LWW-clobber and no clobber-toast on
 * the claim path. (The clobber-toast is for row-OVERWRITE tables only —
 * feature-queue / contributor / working-set, which call `recordLocalWrite`;
 * `claimFeature` deliberately does not.) The own log is the claim handle
 * now — there is no Autobase `base`, no `addWriter`, no seq-tiebreak.
 *
 * Per D-024: every op carries `schema_version` (currently `1`).
 */

import { CURRENT_SCHEMA_VERSION } from '../sync/hyperbee/schema-version';
import type { PeerLogOp } from '../sync/hyperbee/peer-log';
import {
  CLAIMS_TABLE_TAG,
  _testing as featureClaimsProjection,
  type FeatureClaimRow,
} from '../sync/hyperbee/projections/feature-claims';

/**
 * The minimal own-log surface `claimFeature` needs: append a single op +
 * its hypercore key hex (used as the claimer pubkey + author attribution),
 * plus `length` (the next append's seq position, used as the append-only
 * `feature_claims.seq`). The booted handle's `ownLog` satisfies this.
 */
export interface ClaimOwnLog {
  /** Append one op to the peer's OWN single-writer log. */
  append(op: PeerLogOp): Promise<void>;
  /** 64-char lowercase hex hypercore key. Doubles as the claimer pubkey. */
  readonly keyHex: string;
  /** Number of ops appended so far — the seq the next append occupies. */
  readonly length: number;
}

export interface ClaimResult {
  /** Always true — the claim op was appended to the own log. Advisory: it
   *  records ONE attempt in the append-only `feature_claims` audit history;
   *  it does not arbitrate who holds the feature (that's a separate
   *  latest-`claimed_at` read), and the real authority is the GitHub PR
   *  merge. No cross-author collision, so no clobber on this path. */
  claimed: true;
}

export interface ClaimOpts {
  /** The harness this claim belongs to. Stamped onto the projected row so
   *  the registered feature-claims projection (which only inserts rows whose
   *  `harness_slug` matches its own harness) accepts + writes it to PG. */
  harness_slug: string;
  feature_id: string;
  claimer_github_user_id: number;
  /** Override for tests. Defaults to `Date.now()`. */
  now_ms?: number;
}

export class ClaimValidationError extends Error {
  constructor(public field: string) {
    super(`claimFeature: invalid ${field}`);
  }
}

/**
 * Append one advisory claim to the peer's own log + return immediately.
 *
 * The appended op's value is a `FeatureClaimRow` and its `hbKey` is the
 * feature-claims projection's `composeKey(row)` (`<feature_id>/<seq>`, with
 * `seq = ownLog.length`), so the existing projection materializes it to PG
 * on the next read-merge with no new projection logic. Because `seq`
 * advances per append, every claim is a DISTINCT append-only audit row;
 * claims do not collide cross-author, so this never clobbers another peer's
 * row. `claimer_pubkey` / `author_pubkey` are the own log's `keyHex` (author
 * attribution only — there is no clobber-event on the claim path).
 */
export async function claimFeature(
  ownLog: ClaimOwnLog,
  opts: ClaimOpts,
): Promise<ClaimResult> {
  if (!opts.harness_slug) throw new ClaimValidationError('harness_slug');
  if (!opts.feature_id) throw new ClaimValidationError('feature_id');
  if (!Number.isInteger(opts.claimer_github_user_id) || opts.claimer_github_user_id <= 0) {
    throw new ClaimValidationError('claimer_github_user_id');
  }

  const ts = opts.now_ms ?? Date.now();
  // Single-writer append-only log: the seq this claim will occupy is the
  // current length. The feature_claims projection PKs on
  // (workspace, harness, feature_id, seq), so this keeps each claim a
  // distinct append-only row, exactly as the projection expects.
  const seq = ownLog.length;

  // The projection's `writeToPg` only inserts rows whose `harness_slug`
  // matches the registered projection's harness, so the row must carry the
  // real slug (not a placeholder) to round-trip PG.
  const row: FeatureClaimRow = {
    harness_slug: opts.harness_slug,
    feature_id: opts.feature_id,
    seq,
    claimer_pubkey: ownLog.keyHex,
    claimer_github_user_id: opts.claimer_github_user_id,
    claimed_at: ts,
    // Advisory self-claim: this peer is asserting it is working the feature.
    outcome: 'won',
    schema_version: CURRENT_SCHEMA_VERSION,
  };

  const op: PeerLogOp = {
    type: 'put',
    table: CLAIMS_TABLE_TAG,
    hbKey: featureClaimsProjection.composeKey(row),
    value: row,
    ts,
    schema_version: CURRENT_SCHEMA_VERSION,
    author_pubkey: ownLog.keyHex,
  };

  await ownLog.append(op);
  return { claimed: true };
}
