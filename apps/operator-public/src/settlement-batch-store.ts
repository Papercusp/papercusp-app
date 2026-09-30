/**
 * D1 lifecycle store for P-033 batch settlement execution.
 *
 * A batch row is written only AFTER the facilitator returns a transaction
 * receipt, because the row's whole purpose is to record which claim reached the
 * chain. Idempotency comes from the unique (channel_id, request_hash) index:
 * `planBatchSettlement` derives the request hash deterministically from the
 * channel state and the exact voucher set, so a retried submission of the same
 * batch collides with the existing row instead of claiming twice.
 *
 * ACCEPTANCE LINE 14: `state` distinguishes a claim from finality. Nothing in
 * here treats a `claimed` row as money received.
 */
import type {
  BatchSettlementPlan,
  EvmTransactionReceipt,
  SettlementLifecycleState,
} from '@papercusp/operator-core/lib/p2p/evm-settlement.ts';
import { REVENUE_SHARES, type RevenueShare } from '@papercusp/operator-core/lib/p2p/revenue-settlement.ts';
import type { PaymentChannelState } from '@papercusp/operator-core/lib/p2p/payment-channel.ts';

interface SettlementBatchRow {
  batch_id: string;
  channel_id: string;
  principal_id: string;
  request_hash: string;
  chain_id: number;
  settlement_contract_address: string;
  stablecoin_address: string;
  claim_micros: number;
  prior_cumulative_micros: number;
  cumulative_claim_micros: number;
  voucher_digests: string;
  settlement_id: string;
  split_manifest_hash: string;
  allocations_micros: string;
  provider_cost_micros: number;
  distributable_micros: number;
  dao_treasury: string;
  receipt_hash: string;
  state: string;
  required_confirmations: number;
  confirmations: number;
  claim_tx_hash: string;
  claim_block_number: string;
  claim_block_hash: string;
  refund_tx_hash: string | null;
  refund_block_number: string | null;
  freeze_reason: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  finalized_at_ms: number | null;
}

export interface StoredSettlementBatch {
  readonly batchId: string;
  readonly channelId: string;
  readonly principalId: string;
  readonly requestHash: string;
  readonly chainId: number;
  readonly settlementContractAddress: string;
  readonly stablecoinAddress: string;
  readonly claimMicros: number;
  readonly priorCumulativeMicros: number;
  readonly cumulativeClaimMicros: number;
  readonly voucherDigests: readonly string[];
  readonly settlementId: string;
  readonly splitManifestHash: string;
  readonly allocationsMicros: Readonly<Record<RevenueShare, string>>;
  readonly providerCostMicros: number;
  readonly distributableMicros: number;
  readonly daoTreasury: string;
  readonly receiptHash: string;
  readonly state: SettlementLifecycleState;
  readonly requiredConfirmations: number;
  readonly confirmations: number;
  readonly claimReceipt: EvmTransactionReceipt;
  readonly refundTransactionHash: string | null;
  readonly freezeReason: string | null;
  /** A reorged batch whose unwind has run. See `isSettlementFrozen`. */
  readonly recovered: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly finalizedAtMs: number | null;
}

function parseStringArray(value: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
}

function parseAllocations(value: string): Readonly<Record<RevenueShare, string>> {
  const parsed: unknown = JSON.parse(value);
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const allocations = {} as Record<RevenueShare, string>;
  for (const share of REVENUE_SHARES) {
    const entry = source[share];
    allocations[share] = typeof entry === 'string' ? entry : '0';
  }
  return allocations;
}

function fromRow(row: SettlementBatchRow): StoredSettlementBatch {
  const state = row.state as SettlementLifecycleState;
  return {
    batchId: row.batch_id,
    channelId: row.channel_id,
    principalId: row.principal_id,
    requestHash: row.request_hash,
    chainId: Number(row.chain_id),
    settlementContractAddress: row.settlement_contract_address,
    stablecoinAddress: row.stablecoin_address,
    claimMicros: Number(row.claim_micros),
    priorCumulativeMicros: Number(row.prior_cumulative_micros),
    cumulativeClaimMicros: Number(row.cumulative_claim_micros),
    voucherDigests: parseStringArray(row.voucher_digests),
    settlementId: row.settlement_id,
    splitManifestHash: row.split_manifest_hash,
    allocationsMicros: parseAllocations(row.allocations_micros),
    providerCostMicros: Number(row.provider_cost_micros),
    distributableMicros: Number(row.distributable_micros),
    daoTreasury: row.dao_treasury,
    receiptHash: row.receipt_hash,
    state,
    requiredConfirmations: Number(row.required_confirmations),
    confirmations: Number(row.confirmations),
    claimReceipt: {
      transactionHash: row.claim_tx_hash,
      blockNumber: BigInt(row.claim_block_number),
      blockHash: row.claim_block_hash,
    },
    refundTransactionHash: row.refund_tx_hash,
    freezeReason: row.freeze_reason,
    recovered: state === 'reorged' ? row.freeze_reason === null : true,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    finalizedAtMs: row.finalized_at_ms == null ? null : Number(row.finalized_at_ms),
  };
}

const COLUMNS = `batch_id, channel_id, principal_id, request_hash, chain_id,
       settlement_contract_address, stablecoin_address, claim_micros,
       prior_cumulative_micros, cumulative_claim_micros, voucher_digests,
       settlement_id, split_manifest_hash, allocations_micros,
       provider_cost_micros, distributable_micros, dao_treasury, receipt_hash,
       state, required_confirmations, confirmations, claim_tx_hash,
       claim_block_number, claim_block_hash, refund_tx_hash,
       refund_block_number, freeze_reason, created_at_ms, updated_at_ms,
       finalized_at_ms`;

export async function getSettlementBatch(
  db: D1Database,
  batchId: string,
): Promise<StoredSettlementBatch | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM settlement_batches WHERE batch_id = ?`)
    .bind(batchId)
    .first<SettlementBatchRow>();
  return row ? fromRow(row) : null;
}

/**
 * The LIVE batch for a request hash, if any.
 *
 * Deliberately not "any batch with this hash": a reorged or refunded batch is
 * void, and its vouchers are released for a re-claim that reproduces the same
 * deterministic hash. Matching a void row would answer that legitimate retry
 * with a replay of the claim the chain discarded.
 */
export async function getLiveSettlementBatchByRequestHash(
  db: D1Database,
  channelId: string,
  requestHash: string,
): Promise<StoredSettlementBatch | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM settlement_batches
        WHERE channel_id = ? AND request_hash = ?
          AND state IN ('claimed', 'final', 'disputed')`,
    )
    .bind(channelId, requestHash)
    .first<SettlementBatchRow>();
  return row ? fromRow(row) : null;
}

/** How many batches — live or void — this channel has recorded for a hash. */
export async function settlementClaimAttempts(
  db: D1Database,
  channelId: string,
  requestHash: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM settlement_batches WHERE channel_id = ? AND request_hash = ?`)
    .bind(channelId, requestHash)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function listChannelSettlementBatches(
  db: D1Database,
  channelId: string,
): Promise<readonly StoredSettlementBatch[]> {
  const rows = await db
    .prepare(`SELECT ${COLUMNS} FROM settlement_batches WHERE channel_id = ? ORDER BY created_at_ms ASC, batch_id ASC`)
    .bind(channelId)
    .all<SettlementBatchRow>();
  return (rows.results ?? []).map(fromRow);
}

/**
 * States whose claim still stands against the channel's escrow.
 *
 * `reorged` and `refunded` are void: the first never made it into the canonical
 * chain, the second returned the escrow to the payer. Excluding them is what
 * makes the vouchers they held re-claimable.
 */
const LIVE_STATES: readonly SettlementLifecycleState[] = ['claimed', 'final', 'disputed'];

function isLive(batch: StoredSettlementBatch): boolean {
  return LIVE_STATES.includes(batch.state);
}

/**
 * Rebuild the pure `PaymentChannelState` that `settleVoucherBatch` expects.
 *
 * `escrowMicros` comes from `payment_channels` (mig 023, the escrow authority);
 * the settled total, cumulative watermark, and claimed digests are derived from
 * the LIVE batches, so a reorged batch's vouchers reappear as claimable exactly
 * because its row stopped being live.
 */
export function paymentChannelStateFromBatches(input: {
  readonly channelId: string;
  readonly escrowMicros: number;
  readonly batches: readonly StoredSettlementBatch[];
}): PaymentChannelState {
  let settledMicros = 0n;
  let lastCumulativeMicros = 0n;
  const claimedVoucherDigests: string[] = [];
  for (const batch of input.batches) {
    if (!isLive(batch)) continue;
    settledMicros += BigInt(batch.claimMicros);
    const cumulative = BigInt(batch.cumulativeClaimMicros);
    if (cumulative > lastCumulativeMicros) lastCumulativeMicros = cumulative;
    claimedVoucherDigests.push(...batch.voucherDigests);
  }
  return {
    channelId: input.channelId,
    rail: 'evm-x402',
    escrowMicros: BigInt(input.escrowMicros),
    settledMicros,
    lastCumulativeMicros,
    claimedVoucherDigests,
  };
}

export interface RecordSettlementClaimInput {
  readonly batchId: string;
  readonly channelId: string;
  readonly principalId: string;
  readonly plan: BatchSettlementPlan;
  readonly receipt: EvmTransactionReceipt;
  readonly requiredConfirmations: number;
  readonly confirmations: number;
  readonly usageNonces: readonly string[];
  readonly nowMs: number;
}

export type RecordSettlementClaimResult =
  | { readonly ok: true; readonly created: boolean; readonly batch: StoredSettlementBatch }
  | { readonly ok: false; readonly code: 'voucher-already-claimed'; readonly detail: string };

/**
 * Persist a submitted claim and the receipts it consumed.
 *
 * The voucher link rows go in FIRST: their unique (channel_id, usage_nonce)
 * index is the durable double-spend guard, so a concurrent request that reached
 * the rail with an overlapping voucher set is rejected here rather than being
 * recorded as a second valid claim.
 */
export async function recordSettlementClaim(
  db: D1Database,
  input: RecordSettlementClaimInput,
): Promise<RecordSettlementClaimResult> {
  const existing = await getLiveSettlementBatchByRequestHash(
    db,
    input.channelId,
    input.plan.request.requestHash,
  );
  if (existing) return { ok: true, created: false, batch: existing };

  const allocations: Record<string, string> = {};
  for (const share of REVENUE_SHARES) {
    allocations[share] = input.plan.receipt.allocationsMicros[share].toString();
  }

  try {
    for (let index = 0; index < input.usageNonces.length; index += 1) {
      await db
        .prepare(
          `INSERT INTO settlement_batch_vouchers
             (batch_id, channel_id, usage_nonce, voucher_digest, cumulative_claim_micros)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          input.batchId,
          input.channelId,
          input.usageNonces[index],
          input.plan.voucherDigests[index] ?? '',
          Number(input.plan.cumulativeClaimMicros),
        )
        .run();
    }
  } catch (error) {
    await db.prepare(`DELETE FROM settlement_batch_vouchers WHERE batch_id = ?`).bind(input.batchId).run();
    return {
      ok: false,
      code: 'voucher-already-claimed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  await db
    .prepare(
      `INSERT INTO settlement_batches
         (batch_id, channel_id, principal_id, request_hash, chain_id,
          settlement_contract_address, stablecoin_address, claim_micros,
          prior_cumulative_micros, cumulative_claim_micros, voucher_digests,
          settlement_id, split_manifest_hash, allocations_micros,
          provider_cost_micros, distributable_micros, dao_treasury, receipt_hash,
          state, required_confirmations, confirmations, claim_tx_hash,
          claim_block_number, claim_block_hash, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.batchId,
      input.channelId,
      input.principalId,
      input.plan.request.requestHash,
      input.plan.request.chainId,
      input.plan.request.to,
      input.plan.request.stablecoin,
      Number(input.plan.claimMicros),
      Number(input.plan.priorChannel.lastCumulativeMicros),
      Number(input.plan.cumulativeClaimMicros),
      JSON.stringify([...input.plan.voucherDigests]),
      input.plan.receipt.settlementId,
      input.plan.receipt.splitManifestHash,
      JSON.stringify(allocations),
      Number(input.plan.receipt.providerCostMicros),
      Number(input.plan.receipt.distributableMicros),
      input.plan.receipt.daoTreasury,
      input.plan.receipt.receiptHash,
      input.requiredConfirmations,
      input.confirmations,
      input.receipt.transactionHash,
      input.receipt.blockNumber.toString(),
      input.receipt.blockHash,
      input.nowMs,
      input.nowMs,
    )
    .run();

  const batch = await getSettlementBatch(db, input.batchId);
  if (!batch) throw new Error(`settlement batch '${input.batchId}' vanished immediately after insert`);
  return { ok: true, created: true, batch };
}

export async function recordSettlementConfirmations(
  db: D1Database,
  batchId: string,
  confirmations: number,
  nowMs: number,
): Promise<StoredSettlementBatch> {
  await db
    .prepare(`UPDATE settlement_batches SET confirmations = ?, updated_at_ms = ? WHERE batch_id = ?`)
    .bind(confirmations, nowMs, batchId)
    .run();
  const batch = await getSettlementBatch(db, batchId);
  if (!batch) throw new Error(`settlement batch '${batchId}' not found`);
  return batch;
}

export async function markSettlementFinal(
  db: D1Database,
  batchId: string,
  confirmations: number,
  nowMs: number,
): Promise<StoredSettlementBatch> {
  await db
    .prepare(
      `UPDATE settlement_batches
          SET state = 'final', confirmations = ?, freeze_reason = NULL,
              finalized_at_ms = ?, updated_at_ms = ?
        WHERE batch_id = ?`,
    )
    .bind(confirmations, nowMs, nowMs, batchId)
    .run();
  const batch = await getSettlementBatch(db, batchId);
  if (!batch) throw new Error(`settlement batch '${batchId}' not found`);
  return batch;
}

/**
 * Freeze a reorged batch, then recover it.
 *
 * The freeze is written BEFORE the voucher links are released so a crash
 * between the two leaves the channel frozen — the safe direction. Deleting the
 * links is the recovery: it is what returns those usage receipts to the
 * unclaimed pool, and clearing `freeze_reason` records that it happened.
 */
export async function unwindReorgedBatch(
  db: D1Database,
  batchId: string,
  reason: string,
  nowMs: number,
): Promise<StoredSettlementBatch> {
  await db
    .prepare(
      `UPDATE settlement_batches
          SET state = 'reorged', freeze_reason = ?, confirmations = 0,
              finalized_at_ms = NULL, updated_at_ms = ?
        WHERE batch_id = ?`,
    )
    .bind(reason, nowMs, batchId)
    .run();
  await db.prepare(`DELETE FROM settlement_batch_vouchers WHERE batch_id = ?`).bind(batchId).run();
  await db
    .prepare(`UPDATE settlement_batches SET freeze_reason = NULL, updated_at_ms = ? WHERE batch_id = ?`)
    .bind(nowMs, batchId)
    .run();
  const batch = await getSettlementBatch(db, batchId);
  if (!batch) throw new Error(`settlement batch '${batchId}' not found`);
  return batch;
}

export async function markSettlementDisputed(
  db: D1Database,
  batchId: string,
  reason: string,
  nowMs: number,
): Promise<StoredSettlementBatch> {
  await db
    .prepare(
      `UPDATE settlement_batches
          SET state = 'disputed', freeze_reason = ?, finalized_at_ms = NULL, updated_at_ms = ?
        WHERE batch_id = ?`,
    )
    .bind(reason, nowMs, batchId)
    .run();
  const batch = await getSettlementBatch(db, batchId);
  if (!batch) throw new Error(`settlement batch '${batchId}' not found`);
  return batch;
}

/**
 * Resolve a dispute by refunding the claim.
 *
 * Like a reorg, the voucher links are released: the claim is void, so the
 * receipts it held must become claimable again rather than being stranded.
 */
export async function markSettlementRefunded(
  db: D1Database,
  batchId: string,
  refund: EvmTransactionReceipt,
  nowMs: number,
): Promise<StoredSettlementBatch> {
  await db.prepare(`DELETE FROM settlement_batch_vouchers WHERE batch_id = ?`).bind(batchId).run();
  await db
    .prepare(
      `UPDATE settlement_batches
          SET state = 'refunded', freeze_reason = NULL, finalized_at_ms = NULL,
              refund_tx_hash = ?, refund_block_number = ?, updated_at_ms = ?
        WHERE batch_id = ?`,
    )
    .bind(refund.transactionHash, refund.blockNumber.toString(), nowMs, batchId)
    .run();
  const batch = await getSettlementBatch(db, batchId);
  if (!batch) throw new Error(`settlement batch '${batchId}' not found`);
  return batch;
}

/** Dismiss a dispute: the claim stands and the channel unfreezes. */
export async function markSettlementDisputeDismissed(
  db: D1Database,
  batchId: string,
  nowMs: number,
): Promise<StoredSettlementBatch> {
  await db
    .prepare(
      `UPDATE settlement_batches
          SET state = 'claimed', freeze_reason = NULL, updated_at_ms = ?
        WHERE batch_id = ?`,
    )
    .bind(nowMs, batchId)
    .run();
  const batch = await getSettlementBatch(db, batchId);
  if (!batch) throw new Error(`settlement batch '${batchId}' not found`);
  return batch;
}

/** Usage nonces already consumed by a live batch on this channel. */
export async function claimedUsageNonces(
  db: D1Database,
  channelId: string,
): Promise<ReadonlySet<string>> {
  const rows = await db
    .prepare(`SELECT usage_nonce FROM settlement_batch_vouchers WHERE channel_id = ?`)
    .bind(channelId)
    .all<{ usage_nonce: string }>();
  return new Set((rows.results ?? []).map((row) => row.usage_nonce));
}
