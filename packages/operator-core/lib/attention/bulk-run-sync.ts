/**
 * Push helpers for the Inbox bulk-run projections.
 *
 * The sync invalidation bus is FIRST-WINS within its default 90-second dedupe
 * window. A normal run emits `running`, one or more outcome changes, then
 * `complete`/`review` well inside that window. Letting those writes use the
 * default therefore drops the terminal update and leaves an already-mounted
 * Inbox on "Papercup is resolving…" even though Postgres is complete.
 *
 * Every call here represents a distinct, persisted state transition in a
 * bounded owner-triggered run, so source-side dedupe is deliberately disabled
 * per call. Do not lower the bus-wide default; that protects hot producers.
 */

export const BULK_RUN_SYNC_QUERY = 'plans.attentionBulkRun';
export const PLAN_CLEANUP_RUN_SYNC_QUERY = 'plans.cleanupRun';
export const BULK_RUN_SYNC_DEDUPE_MS = 0;

/** Push the durable run/item state to every mounted bulk strip. */
export async function notifyBulkRunChanged(): Promise<void> {
  const { notifySyncInvalidate } = await import('../sync-sse');
  await notifySyncInvalidate(BULK_RUN_SYNC_QUERY, undefined, undefined, {
    dedupeWindowMs: BULK_RUN_SYNC_DEDUPE_MS,
  });
}

/** Push one persisted plan-cleanup transition to its mounted strip/report. */
export async function notifyPlanCleanupRunChanged(): Promise<void> {
  const { notifySyncInvalidate } = await import('../sync-sse');
  await notifySyncInvalidate(PLAN_CLEANUP_RUN_SYNC_QUERY, undefined, undefined, {
    dedupeWindowMs: BULK_RUN_SYNC_DEDUPE_MS,
  });
}

/**
 * Push both the run and the owner Attention feed after a resolver outcome.
 * Terminal bulk actions can remove several inbox rows inside 90 seconds, so
 * the Attention invalidation needs the same per-transition delivery contract.
 */
export async function notifyBulkRunAndAttentionChanged(): Promise<void> {
  const { notifySyncInvalidate } = await import('../sync-sse');
  await Promise.all([
    notifySyncInvalidate(BULK_RUN_SYNC_QUERY, undefined, undefined, {
      dedupeWindowMs: BULK_RUN_SYNC_DEDUPE_MS,
    }),
    notifySyncInvalidate('plans.attention', undefined, undefined, {
      dedupeWindowMs: BULK_RUN_SYNC_DEDUPE_MS,
    }),
  ]);
}
