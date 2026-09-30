/**
 * Append helpers for the `feature_queue` Hyperbee table.
 *
 * Plan: papercusp-dogfood-phase5b-hyperbee-ui-integration-2026-05-24
 * P-032 (and the P-031b "PG → Hyperbee write fan-out" precondition
 * from Phase 5a).
 *
 * v5 §7.1: per-user queue is a pointer table, written by appending a
 * `put` op to the harness's Autobase. The projection in
 * `projections/feature-queue.ts` consumes that op + writes the PG
 * row. Same shape on both sides, single key composer.
 *
 * Dequeue is a soft-delete: another `put` with `removed_at != null`.
 * We never emit `del` here — the projection treats `del` as a hard
 * delete and we want the row to remain visible for "previously
 * queued by X" history. Per the projection comment.
 */

import type { BootedHarnessHandle } from './boot';
import { composeFeatureQueueKey, type FeatureQueueRow } from './projections/feature-queue';
import { CURRENT_SCHEMA_VERSION } from './schema-version';
import { recordLocalWrite } from './clobber-events';

export interface QueueWriteOpts {
  handle: BootedHarnessHandle;
  githubUserId: number;
  featureId: string;
  /** Override clock — test injection point. */
  now?: number;
  /**
   * Optional local-writer pubkey (hex). When provided, this write is
   * registered with the clobber-events tracker so a later remote
   * override on the same key fires a `clobber` event. Omit when the
   * caller doesn't have the pubkey resolved — the write still
   * succeeds, it just won't be eligible for clobber detection.
   */
  writerPubkey?: string;
}

function validate(opts: QueueWriteOpts): void {
  if (!opts.handle) throw new Error('queue write: handle required');
  if (!Number.isInteger(opts.githubUserId) || opts.githubUserId <= 0) {
    throw new Error('queue write: githubUserId must be positive integer');
  }
  if (!opts.featureId) throw new Error('queue write: featureId required');
}

/**
 * Append a put op marking the feature as queued by this user. If
 * the row already exists (queued earlier, dequeued, now re-queued)
 * the projection's INSERT...ON CONFLICT will refresh queued_at +
 * clear removed_at.
 */
export async function enqueueFeature(opts: QueueWriteOpts): Promise<void> {
  validate(opts);
  const ts = opts.now ?? Date.now();
  const row: FeatureQueueRow = {
    harness_slug: opts.handle.harnessSlug,
    github_user_id: opts.githubUserId,
    feature_id: opts.featureId,
    queued_at: ts,
    removed_at: null,
    schema_version: CURRENT_SCHEMA_VERSION,
  };
  const hbKey = composeFeatureQueueKey(opts.githubUserId, opts.featureId);
  if (opts.writerPubkey) {
    recordLocalWrite({ table: 'queue', hbKey, ts, pubkey: opts.writerPubkey });
  }
  await opts.handle.append({
    type: 'put',
    table: 'queue',
    hbKey,
    value: row,
    schema_version: CURRENT_SCHEMA_VERSION,
    ts,
    writerPubkey: opts.writerPubkey,
  });
}

/**
 * Append a put op with removed_at set — soft delete tombstone. The
 * row stays in PG so the UI can render "previously queued by X" if
 * we ever want it; for now Phase 5b just filters on removed_at IS
 * NULL when rendering avatars.
 */
export async function dequeueFeature(opts: QueueWriteOpts): Promise<void> {
  validate(opts);
  const ts = opts.now ?? Date.now();
  const row: FeatureQueueRow = {
    harness_slug: opts.handle.harnessSlug,
    github_user_id: opts.githubUserId,
    feature_id: opts.featureId,
    queued_at: ts,
    removed_at: ts,
    schema_version: CURRENT_SCHEMA_VERSION,
  };
  const hbKey = composeFeatureQueueKey(opts.githubUserId, opts.featureId);
  if (opts.writerPubkey) {
    recordLocalWrite({ table: 'queue', hbKey, ts, pubkey: opts.writerPubkey });
  }
  await opts.handle.append({
    type: 'put',
    table: 'queue',
    hbKey,
    value: row,
    schema_version: CURRENT_SCHEMA_VERSION,
    ts,
    writerPubkey: opts.writerPubkey,
  });
}
