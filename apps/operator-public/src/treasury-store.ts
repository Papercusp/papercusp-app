/**
 * D1 store for P-034 DAO treasury routing (mig 027).
 *
 * Two records, with different lifetimes. A Safe DEPLOYMENT is recorded once and
 * read on every routing as a precondition. A TRANSFER is written only AFTER the
 * Safe transaction returns a receipt, for the same reason mig 026 writes a batch
 * only after the claim lands: the row's whole purpose is to record what reached
 * the chain, and a row written first would assert a transfer that may never have
 * happened.
 *
 * Idempotency is the unique (receipt_hash, share) index rather than an
 * application check, because two concurrent routings of the same settlement is
 * an ordinary race and only the database can settle it.
 */
import type {
  SafeDeploymentRecord,
  TreasuryNetwork,
  TreasuryRole,
} from '@papercusp/operator-core/lib/p2p/treasury-controls.ts';
import type { RevenueShare } from '@papercusp/operator-core/lib/p2p/revenue-settlement.ts';
import { witnessAfterAppend } from './ledger-chain-store.ts';

interface TreasurySafeDeploymentRow {
  chain_id: number;
  safe_address: string;
  roles_module_address: string;
  roles_version: string;
  deployment_tx_hash: string;
  network: string;
  owners: string;
  threshold: number;
  automation_signer: string;
  deployed_at_ms: number;
  recorded_at_ms: number;
  recorded_by: string;
}

export interface StoredSafeDeployment extends SafeDeploymentRecord {
  readonly owners: readonly string[];
  readonly threshold: number;
  readonly automationSigner: string;
  readonly recordedAtMs: number;
  readonly recordedBy: string;
}

function parseOwners(value: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
}

function deploymentFromRow(row: TreasurySafeDeploymentRow): StoredSafeDeployment {
  return {
    chainId: Number(row.chain_id),
    safeAddress: row.safe_address,
    rolesModuleAddress: row.roles_module_address,
    // The CHECK constraint admits only 'v2', so the narrowing is a restatement
    // of the schema rather than a trusted cast of arbitrary text.
    rolesVersion: 'v2',
    deploymentTxHash: row.deployment_tx_hash,
    network: row.network as TreasuryNetwork,
    deployedAtMs: Number(row.deployed_at_ms),
    owners: parseOwners(row.owners),
    threshold: Number(row.threshold),
    automationSigner: row.automation_signer,
    recordedAtMs: Number(row.recorded_at_ms),
    recordedBy: row.recorded_by,
  };
}

export async function recordSafeDeployment(
  db: D1Database,
  input: {
    readonly deployment: SafeDeploymentRecord;
    readonly owners: readonly string[];
    readonly threshold: number;
    readonly automationSigner: string;
    readonly recordedBy: string;
    readonly nowMs: number;
  },
): Promise<StoredSafeDeployment> {
  const { deployment } = input;
  // A re-record of the SAME Safe updates the observed facts rather than
  // colliding: re-running the deployment recorder after a roles-module upgrade
  // is a legitimate operator action, and refusing it would leave the stored
  // record describing a module that is no longer the one enforcing the bounds.
  //
  // Because the registry overwrites, it cannot be hash-chained. Every record is
  // therefore ALSO appended to treasury_safe_deployment_records (mig 037) in the
  // same batch, and that log is the chained `treasury.safe-deployment-records`
  // stream: the values a re-record overwrites stay in tamper-evident history.
  const values = [
    deployment.chainId,
    deployment.safeAddress,
    deployment.rolesModuleAddress,
    deployment.rolesVersion,
    deployment.deploymentTxHash,
    deployment.network,
    JSON.stringify([...input.owners]),
    input.threshold,
    input.automationSigner,
    deployment.deployedAtMs,
    input.nowMs,
    input.recordedBy,
  ] as const;
  await db.batch([
    db
      .prepare(
        `INSERT INTO treasury_safe_deployments
           (chain_id, safe_address, roles_module_address, roles_version, deployment_tx_hash,
            network, owners, threshold, automation_signer, deployed_at_ms, recorded_at_ms, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (chain_id, safe_address) DO UPDATE SET
           roles_module_address = excluded.roles_module_address,
           roles_version = excluded.roles_version,
           deployment_tx_hash = excluded.deployment_tx_hash,
           network = excluded.network,
           owners = excluded.owners,
           threshold = excluded.threshold,
           automation_signer = excluded.automation_signer,
           deployed_at_ms = excluded.deployed_at_ms,
           recorded_at_ms = excluded.recorded_at_ms,
           recorded_by = excluded.recorded_by`,
      )
      .bind(...values),
    db
      .prepare(
        `INSERT INTO treasury_safe_deployment_records
           (record_id, chain_id, safe_address, roles_module_address, roles_version, deployment_tx_hash,
            network, owners, threshold, automation_signer, deployed_at_ms, recorded_at_ms, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), ...values),
  ]);
  await witnessAfterAppend(db, 'treasury.safe-deployment-records', input.nowMs);
  const stored = await getSafeDeployment(db, deployment.chainId, deployment.safeAddress);
  if (!stored) throw new Error('treasury Safe deployment did not persist');
  return stored;
}

export async function getSafeDeployment(
  db: D1Database,
  chainId: number,
  safeAddress: string,
): Promise<StoredSafeDeployment | null> {
  const row = await db
    .prepare(
      `SELECT * FROM treasury_safe_deployments
        WHERE chain_id = ? AND lower(safe_address) = lower(?)`,
    )
    .bind(chainId, safeAddress)
    .first<TreasurySafeDeploymentRow>();
  return row ? deploymentFromRow(row) : null;
}

export async function listSafeDeployments(db: D1Database): Promise<readonly StoredSafeDeployment[]> {
  const { results } = await db
    .prepare(`SELECT * FROM treasury_safe_deployments ORDER BY recorded_at_ms DESC`)
    .all<TreasurySafeDeploymentRow>();
  return (results ?? []).map(deploymentFromRow);
}

interface TreasuryTransferRow {
  transfer_id: string;
  batch_id: string;
  channel_id: string;
  principal_id: string;
  settlement_id: string;
  receipt_hash: string;
  split_manifest_hash: string;
  share: string;
  role: string;
  chain_id: number;
  safe_address: string;
  roles_module_address: string;
  token: string;
  recipient: string;
  amount_micros: number;
  safe_tx_hash: string;
  transaction_hash: string;
  block_number: string;
  proof_event_id: string | null;
  created_at_ms: number;
}

export interface StoredTreasuryTransfer {
  readonly transferId: string;
  readonly batchId: string;
  readonly channelId: string;
  readonly principalId: string;
  readonly settlementId: string;
  readonly receiptHash: string;
  readonly splitManifestHash: string;
  readonly share: RevenueShare;
  readonly role: TreasuryRole;
  readonly chainId: number;
  readonly safeAddress: string;
  readonly rolesModuleAddress: string;
  readonly token: string;
  readonly recipient: string;
  /** Decimal string: a micros allocation can exceed Number.MAX_SAFE_INTEGER. */
  readonly amountMicros: string;
  readonly safeTxHash: string;
  readonly transactionHash: string;
  readonly blockNumber: string;
  readonly proofEventId: string | null;
  readonly createdAtMs: number;
}

function transferFromRow(row: TreasuryTransferRow): StoredTreasuryTransfer {
  return {
    transferId: row.transfer_id,
    batchId: row.batch_id,
    channelId: row.channel_id,
    principalId: row.principal_id,
    settlementId: row.settlement_id,
    receiptHash: row.receipt_hash,
    splitManifestHash: row.split_manifest_hash,
    share: row.share as RevenueShare,
    role: row.role as TreasuryRole,
    chainId: Number(row.chain_id),
    safeAddress: row.safe_address,
    rolesModuleAddress: row.roles_module_address,
    token: row.token,
    recipient: row.recipient,
    amountMicros: String(row.amount_micros),
    safeTxHash: row.safe_tx_hash,
    transactionHash: row.transaction_hash,
    blockNumber: row.block_number,
    proofEventId: row.proof_event_id,
    createdAtMs: Number(row.created_at_ms),
  };
}

export interface RecordTreasuryTransferInput {
  readonly transferId: string;
  readonly batchId: string;
  readonly channelId: string;
  readonly principalId: string;
  readonly settlementId: string;
  readonly receiptHash: string;
  readonly splitManifestHash: string;
  readonly share: RevenueShare;
  readonly role: TreasuryRole;
  readonly chainId: number;
  readonly safeAddress: string;
  readonly rolesModuleAddress: string;
  readonly token: string;
  readonly recipient: string;
  readonly amountMicros: bigint;
  readonly safeTxHash: string;
  readonly transactionHash: string;
  readonly blockNumber: bigint;
  readonly proofEventId: string | null;
  readonly nowMs: number;
}

export type RecordTreasuryTransferResult =
  | { readonly ok: true; readonly transfer: StoredTreasuryTransfer }
  | { readonly ok: false; readonly code: 'already-routed'; readonly transfer: StoredTreasuryTransfer };

/**
 * Record a transfer that has already reached the chain.
 *
 * A collision on (receipt_hash, share) means this settlement's share was routed
 * by a concurrent request, and the EXISTING row is returned rather than an
 * error — the caller's own submission may still have landed, so reporting the
 * durable record is the only honest answer available here. Preventing the
 * double SUBMISSION is the caller's job (it re-reads this table before
 * submitting); this index is what stops a double RECORD.
 */
export async function recordTreasuryTransfer(
  db: D1Database,
  input: RecordTreasuryTransferInput,
): Promise<RecordTreasuryTransferResult> {
  await db
    .prepare(
      `INSERT INTO treasury_transfers
         (transfer_id, batch_id, channel_id, principal_id, settlement_id, receipt_hash,
          split_manifest_hash, share, role, chain_id, safe_address, roles_module_address,
          token, recipient, amount_micros, safe_tx_hash, transaction_hash, block_number,
          proof_event_id, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (receipt_hash, share) DO NOTHING`,
    )
    .bind(
      input.transferId,
      input.batchId,
      input.channelId,
      input.principalId,
      input.settlementId,
      input.receiptHash,
      input.splitManifestHash,
      input.share,
      input.role,
      input.chainId,
      input.safeAddress,
      input.rolesModuleAddress,
      input.token,
      input.recipient,
      Number(input.amountMicros),
      input.safeTxHash,
      input.transactionHash,
      input.blockNumber.toString(),
      input.proofEventId,
      input.nowMs,
    )
    .run();
  await witnessAfterAppend(db, 'treasury.transfers', input.nowMs);
  const stored = await getTreasuryTransferForShare(db, input.receiptHash, input.share);
  if (!stored) throw new Error('treasury transfer did not persist');
  return stored.transferId === input.transferId
    ? { ok: true, transfer: stored }
    : { ok: false, code: 'already-routed', transfer: stored };
}

export async function getTreasuryTransferForShare(
  db: D1Database,
  receiptHash: string,
  share: RevenueShare,
): Promise<StoredTreasuryTransfer | null> {
  const row = await db
    .prepare(`SELECT * FROM treasury_transfers WHERE receipt_hash = ? AND share = ?`)
    .bind(receiptHash, share)
    .first<TreasuryTransferRow>();
  return row ? transferFromRow(row) : null;
}

export async function listBatchTreasuryTransfers(
  db: D1Database,
  batchId: string,
): Promise<readonly StoredTreasuryTransfer[]> {
  const { results } = await db
    .prepare(`SELECT * FROM treasury_transfers WHERE batch_id = ? ORDER BY created_at_ms ASC, share ASC`)
    .bind(batchId)
    .all<TreasuryTransferRow>();
  return (results ?? []).map(transferFromRow);
}
