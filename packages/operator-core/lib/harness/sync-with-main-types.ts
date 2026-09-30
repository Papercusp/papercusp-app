/**
 * sync-with-main-types — types for the §16 sync-with-main UI per
 * papercusp-dogfood-v5.
 *
 * Types-only and PURE. No git, no fs.
 *
 * Twenty-third module in the dogfood-arc types-only spine.
 *
 * Per v5 §16 three surfaces:
 *   §16.1 — Status indicator ("behind main by N commits")
 *   §16.2 — Manual "Sync with main" button + $EDITOR conflict fallback
 *   §16.3 — Auto-rebase-on-push (default ON), unattended-conflict path
 *
 * The runtime (when P-041 lands) imports these for both the
 * status-poll path AND the auto-rebase decision path. The §16.3
 * conflict handler emits a harness_escalations row whose shape is
 * pinned here.
 */

/**
 * Status of `user/<github_user_id>` relative to `origin/main`.
 * Computed via `git rev-list --count user/<id>..origin/main` per
 * v5 §16.1 background-poll (60s when harness is active).
 *
 * `up_to_date` — behind == 0.
 * `behind`     — behind > 0; UI shows "behind by N" badge.
 * `unknown`    — last poll failed (transient network / fetch error).
 */
export const SYNC_STATUSES = ['up_to_date', 'behind', 'unknown'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/**
 * Sync status snapshot. Refreshed every 60s by the background poll
 * + on each manual sync action.
 */
export interface SyncStatusSnapshot {
  harness_slug: string;
  github_user_id: number;
  status: SyncStatus;
  /** Number of commits user/<id> is behind origin/main. 0 when
   * up_to_date; null when unknown. */
  behind_count: number | null;
  /** Epoch ms of most-recent poll completion. */
  polled_at: number;
  /** Optional error message when status='unknown'. Truncated to
   * 200 chars. */
  poll_error?: string;
}

/**
 * Pure builder for the status snapshot from a git-fetch + rev-list
 * result. The runtime calls this after `git rev-list --count`.
 */
export function snapshotFromBehindCount(args: {
  harness_slug: string;
  github_user_id: number;
  behind_count: number;
  now: number;
}): SyncStatusSnapshot {
  if (!Number.isInteger(args.behind_count) || args.behind_count < 0) {
    throw new TypeError('behind_count must be a non-negative integer');
  }
  return {
    harness_slug: args.harness_slug,
    github_user_id: args.github_user_id,
    status: args.behind_count === 0 ? 'up_to_date' : 'behind',
    behind_count: args.behind_count,
    polled_at: args.now,
  };
}

/**
 * Pure builder for the unknown-status snapshot from a fetch failure.
 */
export const SYNC_POLL_ERROR_MAX = 200;
export function snapshotFromPollError(args: {
  harness_slug: string;
  github_user_id: number;
  error_message: string;
  now: number;
}): SyncStatusSnapshot {
  const trimmed =
    args.error_message.length <= SYNC_POLL_ERROR_MAX
      ? args.error_message
      : args.error_message.slice(0, SYNC_POLL_ERROR_MAX);
  return {
    harness_slug: args.harness_slug,
    github_user_id: args.github_user_id,
    status: 'unknown',
    behind_count: null,
    polled_at: args.now,
    poll_error: trimmed,
  };
}

/**
 * Predicate: should the §16.1 "behind by N" badge render?
 */
export function shouldShowBehindBadge(snap: SyncStatusSnapshot): boolean {
  return snap.status === 'behind' && (snap.behind_count ?? 0) > 0;
}

/**
 * Predicate: is the snapshot stale enough to trigger another poll?
 * Default cadence per §16.1: 60s when harness is active.
 */
export const SYNC_POLL_INTERVAL_MS = 60 * 1000;
export function isStatusStale(
  snap: SyncStatusSnapshot,
  now: number,
  intervalMs: number = SYNC_POLL_INTERVAL_MS,
): boolean {
  return now - snap.polled_at > intervalMs;
}

// ─── Rebase outcome ─────────────────────────────────────────────

/**
 * Outcome of an attempted `git rebase origin/main` per v5 §16.2/§16.3.
 *
 * `clean`     — rebase applied without conflicts. UI shows success
 *               toast (§16.2) or push proceeds (§16.3).
 * `conflict`  — rebase produced merge conflicts. v5 §16.3 path
 *               diverges from §16.2: agent-driven gets the
 *               escalation row + stash branch; user-driven gets
 *               the $EDITOR fallback + inline panel.
 * `fetch_failed` — `git fetch origin main` failed before rebase
 *                  could begin. Both paths surface this as a
 *                  transient error.
 */
export const REBASE_OUTCOMES = ['clean', 'conflict', 'fetch_failed'] as const;
export type RebaseOutcome = (typeof REBASE_OUTCOMES)[number];

/**
 * Detailed result of a rebase attempt. Pure data — caller maps git
 * output into this shape.
 */
export interface RebaseAttemptResult {
  outcome: RebaseOutcome;
  /** Conflicted files list. Present only when outcome='conflict'. */
  conflicted_files?: string[];
  /** Error message for fetch_failed + conflict diagnostic copy. */
  error_message?: string;
}

// ─── §16.3 escalation ───────────────────────────────────────────

/**
 * Escalation row shape per v5 §16.3 — emitted when auto-rebase-on-push
 * hits a conflict during an agent run.
 *
 * Stored in `harness_escalations` with `kind: 'rebase_conflict'`.
 */
export const ESCALATION_KIND_REBASE_CONFLICT = 'rebase_conflict' as const;

export interface RebaseConflictEscalation {
  kind: typeof ESCALATION_KIND_REBASE_CONFLICT;
  harness_slug: string;
  feature_id: string;
  conflicted_files: string[];
  /** Git ref of the stash branch holding the agent's WIP, per §16.3
   * step 2 ("Stash the agent's changes to wip/conflict-F-<id>-<ts>"). */
  stash_ref: string;
  /** Epoch ms when the conflict was detected. */
  emitted_at: number;
}

/**
 * Compose the canonical stash branch name per §16.3 step 2.
 *
 *   wip/conflict-F-<feature_id_without_F_prefix>-<ts>
 *
 * Accepts both `F-001` and `001` forms for feature_id; strips the
 * `F-` prefix idempotently so callers don't double-encode.
 */
export function composeStashBranchRef(featureId: string, now: number): string {
  if (typeof featureId !== 'string' || featureId.length === 0) {
    throw new TypeError('featureId required');
  }
  if (!Number.isInteger(now) || now <= 0) {
    throw new TypeError('now must be a positive integer (epoch ms)');
  }
  const stripped = featureId.startsWith('F-') ? featureId.slice(2) : featureId;
  return 'wip/conflict-F-' + stripped + '-' + now;
}

/**
 * Build an escalation row from a conflict outcome. Pure constructor.
 */
export function buildRebaseConflictEscalation(args: {
  harness_slug: string;
  feature_id: string;
  conflicted_files: string[];
  now: number;
}): RebaseConflictEscalation {
  if (!args.harness_slug) throw new TypeError('harness_slug required');
  if (!args.feature_id) throw new TypeError('feature_id required');
  if (!Array.isArray(args.conflicted_files) || args.conflicted_files.length === 0) {
    throw new TypeError('conflicted_files must be a non-empty array');
  }
  return {
    kind: ESCALATION_KIND_REBASE_CONFLICT,
    harness_slug: args.harness_slug,
    feature_id: args.feature_id,
    conflicted_files: args.conflicted_files.slice(),
    stash_ref: composeStashBranchRef(args.feature_id, args.now),
    emitted_at: args.now,
  };
}

/**
 * Structural predicate.
 */
export function isRebaseConflictEscalation(input: unknown): input is RebaseConflictEscalation {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    r.kind === ESCALATION_KIND_REBASE_CONFLICT &&
    typeof r.harness_slug === 'string' &&
    r.harness_slug.length > 0 &&
    typeof r.feature_id === 'string' &&
    r.feature_id.length > 0 &&
    Array.isArray(r.conflicted_files) &&
    r.conflicted_files.length > 0 &&
    typeof r.stash_ref === 'string' &&
    r.stash_ref.startsWith('wip/conflict-F-') &&
    typeof r.emitted_at === 'number' &&
    Number.isFinite(r.emitted_at) &&
    r.emitted_at > 0
  );
}

// ─── Per-harness toggle for auto-rebase-on-push ─────────────────

/**
 * Per-harness setting per v5 §16.3 ("Per-harness toggle: auto_rebase_on_push,
 * default TRUE"). Pure helper — returns the value from a settings record
 * or the default when missing.
 */
export const AUTO_REBASE_ON_PUSH_DEFAULT = true;

export function resolveAutoRebaseOnPush(
  setting: { auto_rebase_on_push?: boolean } | null,
): boolean {
  if (setting === null) return AUTO_REBASE_ON_PUSH_DEFAULT;
  if (typeof setting.auto_rebase_on_push !== 'boolean') return AUTO_REBASE_ON_PUSH_DEFAULT;
  return setting.auto_rebase_on_push;
}

// ─── §16.2 conflict-resolution UX vocabulary ────────────────────

/**
 * Resolution actions the user can take in the inline conflict panel
 * per §16.2.
 *
 *   open_editor   — launch git's core.editor on the next conflicted file
 *   mark_resolved — mark current file as resolved
 *   abort_rebase  — git rebase --abort
 */
export const MANUAL_CONFLICT_ACTIONS = [
  'open_editor',
  'mark_resolved',
  'abort_rebase',
] as const;
export type ManualConflictAction = (typeof MANUAL_CONFLICT_ACTIONS)[number];
