/**
 * feature-queue-row-types — PG-mirror row shape for
 * `harness_shared.feature_queue` per papercusp-dogfood-v5 §7.1
 * schema. Pointer-per-(user, feature) entries; one row per queue
 * entry.
 *
 * Types-only and PURE. No PG, no HYPERBEE.
 *
 * Eighteenth module in the dogfood-arc types-only spine. Closes
 * the queue triad:
 *   - `lib/harness/hyperbee-key-types.ts`'s `keyQueueEntry` composer
 *   - this file's `FeatureQueueRow` (PG mirror)
 *   - `lib/harness/contributor-row-types.ts` (joiner)
 *
 * Schema per v5:
 *   CREATE TABLE IF NOT EXISTS harness_shared.feature_queue (
 *     harness_slug TEXT NOT NULL,
 *     github_user_id BIGINT NOT NULL,
 *     feature_id TEXT NOT NULL,
 *     queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 *     removed_at TIMESTAMPTZ,
 *     schema_version BIGINT NOT NULL DEFAULT 1,
 *     PRIMARY KEY (harness_slug, github_user_id, feature_id)
 *   );
 */

export const FEATURE_QUEUE_ROW_SCHEMA_VERSION = 1 as const;
export type FeatureQueueRowSchemaVersion = typeof FEATURE_QUEUE_ROW_SCHEMA_VERSION;

/**
 * The full row shape per v5 §7.1. `removed_at` is the soft-delete
 * marker — when a queue entry is consumed (worker started) or
 * abandoned (user removed from queue), `removed_at` is set rather
 * than the row deleted. Lets historical replay reconstruct queue
 * state at any point in time.
 */
export interface FeatureQueueRow {
  harness_slug: string;
  github_user_id: number;
  feature_id: string;
  queued_at: number;
  removed_at: number | null;
  schema_version: FeatureQueueRowSchemaVersion;
}

/**
 * Structural predicate. Defensive against legacy rows that may
 * predate schema_version + removed_at.
 */
export function isFeatureQueueRow(input: unknown): input is FeatureQueueRow {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.harness_slug !== 'string' || r.harness_slug.length === 0) return false;
  if (
    typeof r.github_user_id !== 'number' ||
    !Number.isInteger(r.github_user_id) ||
    r.github_user_id <= 0
  ) {
    return false;
  }
  if (typeof r.feature_id !== 'string' || r.feature_id.length === 0) return false;
  if (typeof r.queued_at !== 'number' || !Number.isFinite(r.queued_at) || r.queued_at <= 0) {
    return false;
  }
  if (r.removed_at !== null && typeof r.removed_at !== 'number') return false;
  if (r.removed_at !== null && (!Number.isFinite(r.removed_at) || (r.removed_at as number) <= 0)) {
    return false;
  }
  if (r.schema_version !== FEATURE_QUEUE_ROW_SCHEMA_VERSION) return false;
  return true;
}

/**
 * Predicate: is this queue entry currently active (not soft-deleted)?
 */
export function isActiveQueueEntry(row: FeatureQueueRow): boolean {
  return row.removed_at === null;
}

/**
 * Build a fresh queue entry. Worker dispatch + manual queue-add
 * both call this with `now`.
 */
export function buildFreshQueueEntry(args: {
  harness_slug: string;
  github_user_id: number;
  feature_id: string;
  now: number;
}): FeatureQueueRow {
  if (!args.harness_slug) throw new TypeError('harness_slug required');
  if (!Number.isInteger(args.github_user_id) || args.github_user_id <= 0) {
    throw new TypeError('github_user_id must be a positive integer');
  }
  if (!args.feature_id) throw new TypeError('feature_id required');
  return {
    harness_slug: args.harness_slug,
    github_user_id: args.github_user_id,
    feature_id: args.feature_id,
    queued_at: args.now,
    removed_at: null,
    schema_version: FEATURE_QUEUE_ROW_SCHEMA_VERSION,
  };
}

/**
 * Soft-delete: stamps `removed_at`. Idempotent for already-removed
 * rows. Pure; caller passes `now`.
 */
export function markQueueEntryRemoved(
  row: FeatureQueueRow,
  now: number,
): FeatureQueueRow {
  if (row.removed_at !== null) return row;
  return { ...row, removed_at: now };
}

/**
 * Predicate: do two rows identify the same queue entry?
 * PK is (harness_slug, github_user_id, feature_id).
 */
export function isSameQueueEntry(
  a: Pick<FeatureQueueRow, 'harness_slug' | 'github_user_id' | 'feature_id'>,
  b: Pick<FeatureQueueRow, 'harness_slug' | 'github_user_id' | 'feature_id'>,
): boolean {
  return (
    a.harness_slug === b.harness_slug &&
    a.github_user_id === b.github_user_id &&
    a.feature_id === b.feature_id
  );
}

/**
 * Filter rows to only those active for a given user (used by the
 * "my queue" UI in §9.x).
 */
export function activeForUser(
  rows: ReadonlyArray<FeatureQueueRow>,
  githubUserId: number,
): FeatureQueueRow[] {
  return rows.filter(
    (r) => r.github_user_id === githubUserId && r.removed_at === null,
  );
}

/**
 * Compose a stable display key. Format: `<harness_slug>/<user>/<feature>`.
 */
export function composeQueueEntryKey(
  row: Pick<FeatureQueueRow, 'harness_slug' | 'github_user_id' | 'feature_id'>,
): string {
  return row.harness_slug + '/' + row.github_user_id + '/' + row.feature_id;
}
