/**
 * The social adapter contract
 * (social-platform-integrations-2026-08-23 P-003, shaped by the D-005 finding).
 *
 * WHY THIS EXISTS AS ONE CONTRACT. P-001 measured three different replay
 * behaviours across the Wave A platforms — a bounded cursor window (Bluesky), no
 * stream replay at all (Mastodon), and pure cursored polling (Reddit). The
 * temptation is to write three bespoke adapters. The finding recorded in D-005
 * is that all three collapse to ONE operation:
 *
 *     reconcile(cursor) -> emit the events missed since `cursor`, return a new cursor
 *
 * with a single hard requirement: the adapter must handle the case where the
 * stored cursor CANNOT be used — expired, refused, or never supported — by
 * falling back to a bounded backfill rather than silently starting from live and
 * losing the gap. That is exactly what the landed Gmail lane already does
 * (history.list from a stored historyId, full resync when the cursor expires),
 * so this generalizes a proven model instead of inventing one.
 *
 * The silent-loss failure is why `path` and `backfillReason` are part of the
 * RESULT rather than internal detail. An adapter that quietly restarted from
 * live would otherwise be indistinguishable from one that correctly found
 * nothing to replay — both emit zero events. Making the adapter declare which
 * path it took turns that ambiguity into an assertable fact, and the conformance
 * kit asserts it.
 */
import type { SocialPlatformId } from './platform-registry';

/** Which route the adapter took to close the gap since the last cursor. */
export type SocialReconcilePath =
  /** No stored cursor: first connect for this source. */
  | 'cold-start'
  /** The stored cursor was accepted and the provider replayed from it. */
  | 'cursor-replay'
  /** The cursor was unusable (or unsupported), so a bounded re-read closed the gap. */
  | 'backfill'
  /** Cursor accepted and the provider had nothing to replay — already current. */
  | 'live-only';

/** Why a backfill was required. Present exactly when `path` is 'backfill'. */
export type SocialBackfillReason =
  /** The provider refused the cursor as older than its retention window. */
  | 'cursor-expired'
  /** The provider rejected the cursor as invalid or ahead of its own position. */
  | 'cursor-rejected'
  /** This platform's stream carries no cursor at all, so REST is the only path. */
  | 'no-replay-supported';

/**
 * One event an adapter hands to the ingestion seam. `payload` is ALREADY
 * normalized to the canonical `social-post` datatype (D-004) — adapters
 * normalize exactly once, and the ingestion core validates the result against
 * the datatype's registered ajv schema.
 */
export interface SocialNormalizedEvent {
  /** Provider-side stable id for the object (post id, comment id). */
  externalId: string;
  /** Event name appended to the `ext:<platform>:` key, e.g. 'post' or 'mention'. */
  event: string;
  /** ISO timestamp the event occurred at provider-side, when known. */
  occurredAt?: string | null;
  /** The canonical social-post payload. */
  payload: Record<string, unknown>;
  /**
   * Stable per-delivery identity. MUST be derived from provider-side facts
   * (id plus a version/edit marker) and MUST NOT include wall-clock time or a
   * random value, or replay dedupe cannot work.
   */
  dedupeKey: string;
}

export interface SocialReconcileContext {
  /** The cursor persisted from the previous reconcile, or null on cold start. */
  cursor: unknown | null;
  /** Hand one normalized event to the caller. Called once per event, in provider order. */
  emit(event: SocialNormalizedEvent): Promise<void>;
  /** Cooperative cancellation for a long backfill. */
  signal?: AbortSignal;
}

/**
 * Positive evidence that events were missed AND cannot be recovered.
 *
 * This is a different statement from `path`/`backfillReason`, which say how the
 * adapter TRIED to close the gap. This says the gap could not be closed — and
 * says it in the one situation where the provider will never tell you: a result
 * set the provider caps and offers no paging for (D-031). Such a call returns a
 * full page whether or not there were more, so success and silent loss are
 * identical from the response alone; only the adapter, holding the watermark,
 * can compute the difference.
 *
 * It belongs on the RESULT for the same reason `path` does. This contract exists
 * because "emitted zero events" was ambiguous between correct and broken; this
 * field exists because "emitted a full page" is ambiguous between complete and
 * lossy. Both ambiguities are resolved by making the adapter declare what it
 * knows instead of leaving the caller to infer it from a count.
 */
export interface SocialLossRisk {
  /**
   * The provider capped a result set, documents no way to page past the cap, and
   * the window did not reach back to the last thing we saw.
   */
  kind: 'capped-window-overflow';
  /** How many distinct fetches hit the condition this pass. Never zero when set. */
  occurrences: number;
  /** Provider-specific detail a human can act on (which media, which cap). */
  detail: string;
}

export interface SocialReconcileResult {
  /** The cursor to persist. Null is legal only when the platform has no cursor concept. */
  cursor: unknown | null;
  /** How many events were emitted this pass. */
  emitted: number;
  /** Which route closed the gap — see SocialReconcilePath. */
  path: SocialReconcilePath;
  /** Required when `path` is 'backfill'. */
  backfillReason?: SocialBackfillReason;
  /**
   * Set ONLY when the adapter has positive evidence of unrecoverable loss.
   * Absent means "no evidence of loss", which is not the same as "no loss" —
   * an adapter that cannot compute the predicate simply never sets it.
   */
  lossRisk?: SocialLossRisk;
}

/**
 * What every social platform adapter implements. Deliberately small: connection
 * management, rate-limit backoff and credential handling are the adapter's own
 * business, but the RECONCILE contract above is what the conformance kit can
 * check generically, and it is where the loss-of-events bugs live.
 */
export interface SocialAdapter {
  readonly platformId: SocialPlatformId;
  reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult>;
}

/** True when the result's `path`/`backfillReason` pair is internally coherent. */
export function isCoherentReconcileResult(result: SocialReconcileResult): boolean {
  // A declared loss must be a real one. `occurrences: 0` would be an adapter
  // reporting loss it did not observe, which is worse than not reporting: it
  // trains a reader to discount the field.
  if (result.lossRisk && !(result.lossRisk.occurrences > 0)) return false;
  if (result.path === 'backfill') return Boolean(result.backfillReason);
  return result.backfillReason === undefined;
}
