/** PostgreSQL census for P-530's own-log snapshot receipt filter. */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import { composeEngineerIssueKey } from './feature-issue-op-keys';
import type { GovernorReceiptEnvelopeKeys } from './governor-receipt-snapshot-filter';
import { loadEpochKeyIfPresent } from './hive-epoch-crypto-impl';
import { getHiveEpoch } from './hive-epoch-state';

export async function loadLiveGovernorReceiptSnapshotKeys(
  workspaceId: string,
  sql: postgres.Sql = getOrgPg().sql,
): Promise<string[]> {
  const rows = await sql<Array<{ harness_slug: string; feature_id: string }>>`
    SELECT harness_slug, feature_id
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND jsonb_exists(COALESCE(payload, '{}'::jsonb), 'resource_governor')
     ORDER BY harness_slug, feature_id
  `;
  return rows.map((row) => composeEngineerIssueKey(row.harness_slug, row.feature_id));
}

/**
 * D-024 — the epoch keys that open this device's `{__rekey}` own-log rows, for the P-530
 * filter. Epochs 1..current of the Hive; each key comes from the LOAD-ONLY keychain read
 * (`loadEpochKeyIfPresent` never mints, unlike `deriveEpochKey`). An epoch with no key
 * here is simply absent: its rows are kept and counted as unopened.
 */
export async function loadOwnCompactionEnvelopeKeys(
  workspaceId: string,
  potId: string,
): Promise<GovernorReceiptEnvelopeKeys> {
  const current = await getHiveEpoch(workspaceId, potId);
  const keys: Array<{ epoch: number; key: Uint8Array }> = [];
  for (let epoch = 1; epoch <= current; epoch++) {
    const key = await loadEpochKeyIfPresent(potId, epoch);
    if (key) keys.push({ epoch, key: Uint8Array.from(key) });
  }
  return { potId, keys };
}
