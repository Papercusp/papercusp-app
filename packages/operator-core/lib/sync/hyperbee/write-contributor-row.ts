/**
 * publishContributorRow — Phase 5b P-033.
 *
 * Plan: papercusp-dogfood-phase5b-hyperbee-ui-integration-2026-05-24.
 *
 * Appends a `put` op to the harness's Autobase that writes one
 * `contributors/<github_user_id>` row into the Hyperbee. Mirrors the
 * shape consumed by `projections/contributors.ts` so the PG projection
 * picks it up + upserts into `harness_shared.contributors`.
 *
 * Pure-wrapper: takes a booted handle + a row, builds the op envelope.
 * The hbKey is `<github_user_id>` (no prefix — the table tag does the
 * namespacing inside the projection registry).
 */

import type { BootedHarnessHandle } from './boot';
import type { ContributorRow } from '../../harness/contributor-row-types';
import { CURRENT_SCHEMA_VERSION } from './schema-version';
import { recordLocalWrite } from './clobber-events';

export interface PublishContributorRowOpts {
  handle: BootedHarnessHandle;
  row: ContributorRow;
  /** Override clock — test injection point. */
  now?: number;
  /**
   * Optional local-writer pubkey (hex). When provided, registers this
   * write with the clobber-events tracker so a later remote override
   * on the same row fires a `clobber` event.
   */
  writerPubkey?: string;
}

function validate(opts: PublishContributorRowOpts): void {
  if (!opts.handle) throw new Error('publishContributorRow: handle required');
  if (!opts.row) throw new Error('publishContributorRow: row required');
  if (!Number.isInteger(opts.row.github_user_id) || opts.row.github_user_id <= 0) {
    throw new Error('publishContributorRow: row.github_user_id must be positive integer');
  }
  if (opts.row.harness_slug !== opts.handle.harnessSlug) {
    throw new Error(
      `publishContributorRow: row.harness_slug ${opts.row.harness_slug} does not match handle harnessSlug ${opts.handle.harnessSlug}`,
    );
  }
}

export async function publishContributorRow(
  opts: PublishContributorRowOpts,
): Promise<void> {
  validate(opts);
  const ts = opts.now ?? Date.now();
  const hbKey = String(opts.row.github_user_id);
  if (opts.writerPubkey) {
    recordLocalWrite({ table: 'contributors', hbKey, ts, pubkey: opts.writerPubkey });
  }
  await opts.handle.append({
    type: 'put',
    table: 'contributors',
    hbKey,
    value: opts.row,
    schema_version: CURRENT_SCHEMA_VERSION,
    ts,
    writerPubkey: opts.writerPubkey,
  });
}
