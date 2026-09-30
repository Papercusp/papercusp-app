/** Durable, bounded Personal Vault historical-import worker (P-009 / D-007). */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import {
  runPersonalVaultImportBatch,
  type PersonalVaultImportBatchOptions,
  type PersonalVaultImportBatchResult,
} from '../../personal-vault/import-jobs';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export interface PersonalVaultImportActionDeps {
  sql?: postgres.Sql;
  runBatch?: typeof runPersonalVaultImportBatch;
}

// The durable routine engine already collapses overlapping fires under the
// stable `routine:<id>` DBOS deduplication id. Keep the action itself safe too:
// direct/manual callers and alternate executors can invoke this exported seam
// without passing through that queue, and the stable lease owner deliberately
// allows a later cadence tick to resume the same running job. Without this
// process-local boundary, two such calls could therefore work the same
// checkpoint concurrently. Workspace + install slug is the owner identity;
// unrelated workspaces remain parallel.
const activeOwners = new Set<string>();

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export async function runPersonalVaultImportAction(
  ctx: SystemActionCtx,
  provided: PersonalVaultImportActionDeps = {},
): Promise<PersonalVaultImportBatchResult> {
  const ownerKey = `${ctx.workspaceId}\u001f${ctx.installSlug}`;
  if (activeOwners.has(ownerKey)) {
    return {
      claimed: false,
      jobId: null,
      status: 'idle',
      documentsSeen: 0,
      documentsImported: 0,
      entriesFailed: 0,
      warnings: 0,
      error: null,
    };
  }
  activeOwners.add(ownerKey);
  const sql = provided.sql ?? getOrgPg().sql;
  const runBatch = provided.runBatch ?? runPersonalVaultImportBatch;
  const options: PersonalVaultImportBatchOptions = {
    batchSize: boundedInteger(ctx.triggerConfig.batch_size, 100, 1, 1_000),
    leaseSeconds: boundedInteger(ctx.triggerConfig.lease_seconds, 600, 30, 3_600),
    leaseOwner: `system:personal-vault-import:${ctx.installSlug}`,
  };
  try {
    return await runBatch(sql, ctx.workspaceId, options);
  } finally {
    activeOwners.delete(ownerKey);
  }
}

registerSystemAction('personal-vault-import', async (ctx) => {
  const result = await runPersonalVaultImportAction(ctx);
  if (result.claimed) {
    console.log(
      `[personal-vault-import] job=${result.jobId} status=${result.status} ` +
        `seen=${result.documentsSeen} imported=${result.documentsImported} ` +
        `failed=${result.entriesFailed} ` +
        `warnings=${result.warnings}${result.error ? ` error=${result.error}` : ''}`,
    );
  }
});
