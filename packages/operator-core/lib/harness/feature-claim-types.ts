/**
 * feature-claim-types — types for the `feature_claims` Autobase log
 * that backs the orchestrator's distributed claim resolution per
 * papercusp-dogfood-v5 §6 / Phase 6 P-036.
 *
 * Types-only — no Autobase driver, no Hyperbee writer, no PG client.
 * Source schema is concrete in v5 (~line 517-528) — see
 * `apps/operator/docs/plans/papercusp-dogfood-v5-2026-05-23.md`.
 *
 * Sixth module in the dogfood-arc types-only spine. Same one-per-
 * design-anchor pattern as:
 *   - apps/operator/lib/harness/binding-types.ts                  (P-068)
 *   - apps/operator/lib/identity/binding-verifier-types.ts        (P-075)
 *   - apps/operator/lib/identity/attestation-types.ts             (P-011)
 *   - apps/operator/lib/identity/contributor-file-types.ts        (P-075 Channel 2)
 *   - apps/operator/lib/harness/contributor-usage-event-types.ts  (P-070)
 *
 * When P-036 / P-037 runtime ships (Phase 6),
 * `apps/operator/lib/harness/feature-claims.ts` (the Autobase writer +
 * arbiter) imports these types verbatim; the PG-mirror projection
 * + orchestrator scheduler both consume the same shapes.
 *
 * Why types-first here: the claim arbitration race is the load-bearing
 * piece of multi-engineer orchestration. A diverging field shape or
 * outcome enum between writer and reader silently corrupts the audit
 * log AND the orchestrator's pick decision. Pinning the contract up
 * front prevents that.
 */

/**
 * Wire-version of the claim-record shape. PG mirror has
 * `schema_version BIGINT NOT NULL DEFAULT 1` (v5 line 526); this const
 * stays in lock-step. Bump when adding columns.
 */
export const FEATURE_CLAIM_SCHEMA_VERSION = 1 as const;
export type FeatureClaimSchemaVersion = typeof FEATURE_CLAIM_SCHEMA_VERSION;

/**
 * The outcome of an attempted claim. Three values:
 *
 *   `null`  — claim in-flight; Autobase still merging concurrent
 *             writes from other writers. Arbiter has not stamped a
 *             winner yet.
 *   `won`   — Autobase merge order placed this claim first; the
 *             claimer's worker dispatches. Exactly one `won` per
 *             feature in a healthy ledger.
 *   `lost`  — Autobase merge order placed this claim second-or-later;
 *             the claimer abandons. UI shows the claimer as "lost
 *             race to <winner>" if surfaced.
 *
 * The arbiter (P-037) writes `won` / `lost` after Autobase reaches
 * consensus on order; readers MUST NOT consume `null` rows as winners.
 */
export const CLAIM_OUTCOMES = ['won', 'lost'] as const;
export type ClaimOutcomeStamped = (typeof CLAIM_OUTCOMES)[number];
export type ClaimOutcome = ClaimOutcomeStamped | null;

/**
 * A single Autobase claim-log entry. Mirrors the v5 PG schema exactly:
 *
 *   PRIMARY KEY (harness_slug, feature_id, seq)
 *
 * `seq` is the Autobase sequence number for the claim within the
 * (writer_pubkey, counter) namespace. Sequence ordering across writers
 * is what arbitrates the race; a single writer's `seq` increases
 * monotonically per-feature.
 */
export interface FeatureClaimRecord {
  harness_slug: string;
  /** F-NNN-shaped feature id. */
  feature_id: string;
  /** Autobase sequence number. Monotone per (writer_pubkey, feature). */
  seq: number;
  /** The device pubkey that wrote the claim. Used by the arbiter to
   * match claims back to their authoring device for dedup + display. */
  claimer_pubkey: string;
  /** Stable numeric GitHub user id of the claimer's bound identity.
   * NOT login (login renames). */
  claimer_github_user_id: number;
  /** Epoch ms when the claim was emitted on the claimer device.
   * Used for display only — arbitration ranks on Autobase merge
   * order, not on this timestamp. */
  claimed_at: number;
  /** Arbiter-stamped outcome. `null` while in-flight. */
  outcome: ClaimOutcome;
  /** Wire-schema version of THIS row. */
  schema_version: FeatureClaimSchemaVersion;
}

/**
 * The subset of a claim record produced at write-time on the claimer
 * device. The arbiter computes `outcome` later; the writer never
 * stamps it themselves.
 */
export type FeatureClaimInFlight = Omit<FeatureClaimRecord, 'outcome'> & {
  outcome: null;
};

/**
 * Final outcome-stamped variant. The arbiter writes this after
 * Autobase reaches order consensus.
 */
export type FeatureClaimStamped = Omit<FeatureClaimRecord, 'outcome'> & {
  outcome: ClaimOutcomeStamped;
};

/**
 * Structural predicate. Verifies required fields are present + typed.
 * Verifier callers use this to validate Autobase reads before
 * applying them to the PG mirror or the orchestrator scheduler.
 */
export function isFeatureClaimRecord(input: unknown): input is FeatureClaimRecord {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' &&
    r.harness_slug.length > 0 &&
    typeof r.feature_id === 'string' &&
    r.feature_id.length > 0 &&
    typeof r.seq === 'number' &&
    Number.isInteger(r.seq) &&
    r.seq >= 0 &&
    typeof r.claimer_pubkey === 'string' &&
    r.claimer_pubkey.length > 0 &&
    typeof r.claimer_github_user_id === 'number' &&
    Number.isInteger(r.claimer_github_user_id) &&
    r.claimer_github_user_id > 0 &&
    typeof r.claimed_at === 'number' &&
    Number.isFinite(r.claimed_at) &&
    r.claimed_at > 0 &&
    (r.outcome === null ||
      (typeof r.outcome === 'string' &&
        (CLAIM_OUTCOMES as readonly string[]).includes(r.outcome))) &&
    r.schema_version === FEATURE_CLAIM_SCHEMA_VERSION
  );
}

/**
 * Discriminate in-flight from stamped claims. Useful for orchestrator
 * code that needs to skip not-yet-arbitrated rows.
 */
export function isStampedClaim(claim: FeatureClaimRecord): claim is FeatureClaimStamped {
  return claim.outcome !== null;
}

/**
 * Idempotency predicate. The PG-mirror upsert key is
 * `(harness_slug, feature_id, seq)`; re-applying the same record is
 * a no-op. Outcome MAY change `null` → `won`/`lost` over the
 * arbitration window — readers must handle that transition.
 */
export function isSameClaim(
  a: Pick<FeatureClaimRecord, 'harness_slug' | 'feature_id' | 'seq'>,
  b: Pick<FeatureClaimRecord, 'harness_slug' | 'feature_id' | 'seq'>,
): boolean {
  return (
    a.harness_slug === b.harness_slug &&
    a.feature_id === b.feature_id &&
    a.seq === b.seq
  );
}

/**
 * Compose a stable display key for a claim. Used by orchestrator UI
 * to render "in-flight" rows + by audit log row keys. Format:
 *
 *   <harness_slug>:<feature_id>:<seq>
 *
 * Keys are safe to round-trip in URLs (`:` is RFC 3986 sub-delim).
 */
export function composeClaimKey(
  claim: Pick<FeatureClaimRecord, 'harness_slug' | 'feature_id' | 'seq'>,
): string {
  return claim.harness_slug + ':' + claim.feature_id + ':' + claim.seq;
}

/**
 * Inverse of `composeClaimKey`. Returns null on any malformed input
 * (missing fields, non-numeric seq, etc.).
 */
export function parseClaimKey(
  key: string,
): Pick<FeatureClaimRecord, 'harness_slug' | 'feature_id' | 'seq'> | null {
  if (typeof key !== 'string') return null;
  const parts = key.split(':');
  if (parts.length < 3) return null;
  // feature_id may itself contain colons in theory; reconstruct
  // from the right by peeling seq off the end.
  const seqStr = parts[parts.length - 1];
  if (!seqStr) return null;
  const seq = Number(seqStr);
  if (!Number.isInteger(seq) || seq < 0) return null;
  const harness_slug = parts[0];
  if (!harness_slug) return null;
  const feature_id = parts.slice(1, parts.length - 1).join(':');
  if (!feature_id) return null;
  return { harness_slug, feature_id, seq };
}

/**
 * Arbiter-side decision: given an ordered list of in-flight claims
 * for a single feature (in Autobase merge order), produce the
 * outcome map. The first claim wins; the rest lose. Pure function —
 * the arbiter runtime calls this after Autobase reports consensus.
 *
 * Returns an array of `{seq, outcome}` matching the input order.
 * Empty input returns an empty array; single-element input returns
 * `[{seq: ..., outcome: 'won'}]`.
 */
export function arbitrateClaims(
  inFlightByMergeOrder: ReadonlyArray<Pick<FeatureClaimRecord, 'seq'>>,
): Array<{ seq: number; outcome: ClaimOutcomeStamped }> {
  return inFlightByMergeOrder.map((c, i) => ({
    seq: c.seq,
    outcome: i === 0 ? ('won' as const) : ('lost' as const),
  }));
}

/**
 * Find the winner from a list of stamped claims for a single feature.
 * Returns the `won` claim or `null` if none have been stamped yet.
 *
 * In a healthy ledger there's exactly one `won`; if multiple appear
 * (concurrent arbiter writes, replay), the FIRST encountered wins
 * to preserve idempotency — callers can detect the bug by checking
 * `winners.length > 1` upstream.
 */
export function findWinningClaim(
  claims: ReadonlyArray<FeatureClaimRecord>,
): FeatureClaimRecord | null {
  for (const c of claims) {
    if (c.outcome === 'won') return c;
  }
  return null;
}

/**
 * Convenience: produce a "claim is currently assigned to" answer for
 * the orchestrator UI. Returns `null` if no winner yet, the claimer's
 * github_user_id otherwise.
 */
export function activeClaimerGithubUserId(
  claims: ReadonlyArray<FeatureClaimRecord>,
): number | null {
  const winner = findWinningClaim(claims);
  return winner === null ? null : winner.claimer_github_user_id;
}
