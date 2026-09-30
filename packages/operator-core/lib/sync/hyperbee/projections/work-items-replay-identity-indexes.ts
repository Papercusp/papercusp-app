/**
 * Replay policy for every UNIQUE index on harness_shared.work_items.
 *
 * The engineer-issues projection writes a replayed peer row with an
 * ON CONFLICT on the PHYSICAL row identity only. A separate logical-identity
 * unique index (one row per watchdog key, per admission title key, per
 * governor idempotency key, ...) can therefore reject a replay with a 23505
 * that no retry clears, and the merge path then holds the whole peer log
 * behind that single op. WI-2142873 hit this twice: the tower's cursor pinned
 * 2.7 days on migration 1157's index, then the Mac VM's cursor pinned at
 * position 5868039 on migration 986's index (2026-09-23).
 *
 * Every unique index therefore needs an explicit replay policy:
 *   - coalesced: the replay resolves the 23505 onto the existing winner and
 *     treats the remote PUT as a no-op (engineer-issues.ts resolver table);
 *   - physical-row: the projection's own ON CONFLICT arbitrates it;
 *   - unreachable: the projection's writes cannot enter the index predicate.
 *
 * work-items-replay-identity-indexes.test.ts scans the migrations and fails on
 * any unique index with no entry here, so a new identity index cannot silently
 * reintroduce the wedge.
 */

export const WATCHDOG_IDENTITY_INDEX = 'work_items_watchdog_identity_uq';
export const KEYLESS_TITLE_IDENTITY_INDEX = 'work_items_keyless_title_identity_uq';
export const RESOURCE_GOVERNOR_IDENTITY_INDEX = 'work_items_resource_governor_identity_uq';

export type WorkItemsReplayIndexPolicy =
  | { readonly kind: 'coalesced'; readonly migration: string }
  | { readonly kind: 'physical-row'; readonly reason: string }
  | { readonly kind: 'unreachable'; readonly reason: string };

export const WORK_ITEMS_UNIQUE_INDEX_REPLAY_POLICY: Readonly<Record<string, WorkItemsReplayIndexPolicy>> = {
  [WATCHDOG_IDENTITY_INDEX]: { kind: 'coalesced', migration: '865' },
  [KEYLESS_TITLE_IDENTITY_INDEX]: { kind: 'coalesced', migration: '1157' },
  [RESOURCE_GOVERNOR_IDENTITY_INDEX]: { kind: 'coalesced', migration: '986' },
  work_items_pkey: {
    kind: 'physical-row',
    reason: 'the (harness_slug, feature_id) physical key is the projection ON CONFLICT arbiter',
  },
  work_items_scoped_identity: {
    kind: 'physical-row',
    reason: '(workspace_id, harness_slug, feature_id) is the same physical row identity the ON CONFLICT resolves',
  },
  work_items_condition_key_uq: {
    kind: 'unreachable',
    reason:
      'the engineer-issues projection never writes condition_key and no trigger derives it, while the index covers only non-null values',
  },
};

export function coalescedReplayIdentityIndexes(): string[] {
  return Object.entries(WORK_ITEMS_UNIQUE_INDEX_REPLAY_POLICY)
    .filter(([, policy]) => policy.kind === 'coalesced')
    .map(([name]) => name)
    .sort();
}
