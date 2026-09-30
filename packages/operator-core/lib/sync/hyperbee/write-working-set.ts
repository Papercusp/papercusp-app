/**
 * Append helpers for the `feature_working_set` Hyperbee table.
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24 P-038
 * (manual "set active") + v5 §0.5 working_users.
 *
 * setActiveFeature / clearActiveFeature mirror enqueue/dequeueFeature:
 * both emit `put` ops; clear is a soft-delete via `cleared_at = now`
 * (the projection treats `del` as a hard delete + we want history).
 *
 * writerPubkey is optional → when provided, the write registers with
 * the clobber-events tracker so a remote override surfaces a toast
 * (same path as the queue helpers).
 */

import type { BootedHarnessHandle } from './boot';
import {
  composeFeatureWorkingSetKey,
  type FeatureWorkingSetRow,
} from './projections/feature-working-set';
import { CURRENT_SCHEMA_VERSION } from './schema-version';
import { recordLocalWrite } from './clobber-events';

export interface WorkingSetWriteOpts {
  handle: BootedHarnessHandle;
  githubUserId: number;
  featureId: string;
  /** Override clock — test injection point. */
  now?: number;
  /** Optional local-writer pubkey (hex) for clobber-detection eligibility. */
  writerPubkey?: string;
}

function validate(opts: WorkingSetWriteOpts): void {
  if (!opts.handle) throw new Error('working-set write: handle required');
  if (!Number.isInteger(opts.githubUserId) || opts.githubUserId <= 0) {
    throw new Error('working-set write: githubUserId must be positive integer');
  }
  if (!opts.featureId) throw new Error('working-set write: featureId required');
}

/** Mark the feature as actively worked by this user. */
export async function setActiveFeature(opts: WorkingSetWriteOpts): Promise<void> {
  validate(opts);
  const ts = opts.now ?? Date.now();
  const row: FeatureWorkingSetRow = {
    harness_slug: opts.handle.harnessSlug,
    github_user_id: opts.githubUserId,
    feature_id: opts.featureId,
    started_at: ts,
    cleared_at: null,
    schema_version: CURRENT_SCHEMA_VERSION,
  };
  const hbKey = composeFeatureWorkingSetKey(opts.githubUserId, opts.featureId);
  if (opts.writerPubkey) {
    recordLocalWrite({ table: 'working-set', hbKey, ts, pubkey: opts.writerPubkey });
  }
  await opts.handle.append({
    type: 'put',
    table: 'working-set',
    hbKey,
    value: row,
    schema_version: CURRENT_SCHEMA_VERSION,
    ts,
    writerPubkey: opts.writerPubkey,
  });
}

/** Clear the active mark (soft delete via cleared_at). */
export async function clearActiveFeature(opts: WorkingSetWriteOpts): Promise<void> {
  validate(opts);
  const ts = opts.now ?? Date.now();
  const row: FeatureWorkingSetRow = {
    harness_slug: opts.handle.harnessSlug,
    github_user_id: opts.githubUserId,
    feature_id: opts.featureId,
    started_at: ts,
    cleared_at: ts,
    schema_version: CURRENT_SCHEMA_VERSION,
  };
  const hbKey = composeFeatureWorkingSetKey(opts.githubUserId, opts.featureId);
  if (opts.writerPubkey) {
    recordLocalWrite({ table: 'working-set', hbKey, ts, pubkey: opts.writerPubkey });
  }
  await opts.handle.append({
    type: 'put',
    table: 'working-set',
    hbKey,
    value: row,
    schema_version: CURRENT_SCHEMA_VERSION,
    ts,
    writerPubkey: opts.writerPubkey,
  });
}
