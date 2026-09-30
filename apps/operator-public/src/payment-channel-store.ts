/**
 * D1 lifecycle store for the P-032 funded payment-channel Worker door.
 *
 * A channel row is inserted before chain I/O. The rail adapter is required to
 * be idempotent by channel id, so an `opening` or `closing` row can be retried
 * safely after a process crash.
 */
import type {
  PaymentChannelFundingAdapter,
  PaymentChannelFundingSource,
  PaymentChannelRailReceipt,
} from '@papercusp/operator-core/lib/p2p/channel-funding.ts';

export type StoredPaymentChannelState =
  | 'opening'
  | 'open'
  | 'closing'
  | 'closed'
  | 'failed';

interface PaymentChannelRow {
  channel_id: string;
  principal_id: string;
  rail: string;
  chain_id: number;
  stablecoin_address: string;
  settlement_contract_address: string;
  funding_source: string;
  funding_ref: string;
  wallet_address: string | null;
  escrow_micros: number;
  committed_micros: number;
  refunded_micros: number;
  state: string;
  open_tx_hash: string | null;
  open_block_number: string | null;
  close_tx_hash: string | null;
  close_block_number: string | null;
  failure_code: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  closed_at_ms: number | null;
}

export interface StoredPaymentChannel {
  readonly channelId: string;
  readonly principalId: string;
  readonly rail: 'evm-x402';
  readonly chainId: number;
  readonly stablecoinAddress: string;
  readonly settlementContractAddress: string;
  readonly fundingSource: PaymentChannelFundingSource;
  readonly escrowMicros: number;
  readonly committedMicros: number;
  readonly refundedMicros: number;
  readonly state: StoredPaymentChannelState;
  readonly openReceipt: PaymentChannelRailReceipt | null;
  readonly closeReceipt: PaymentChannelRailReceipt | null;
  readonly failureCode: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly closedAtMs: number | null;
}

export interface CreatePaymentChannelInput {
  readonly channelId: string;
  readonly principalId: string;
  readonly adapter: PaymentChannelFundingAdapter;
  readonly fundingSource: PaymentChannelFundingSource;
  readonly escrowMicros: number;
  readonly nowMs: number;
}

export type CreatePaymentChannelResult =
  | { readonly ok: true; readonly created: boolean; readonly channel: StoredPaymentChannel }
  | { readonly ok: false; readonly code: 'channel-conflict' | 'funding-ref-conflict' };

function receipt(hash: string | null, block: string | null): PaymentChannelRailReceipt | null {
  if (!hash || block == null) return null;
  return { transactionHash: hash, blockNumber: BigInt(block) };
}

function fromRow(row: PaymentChannelRow): StoredPaymentChannel {
  const fundingSource: PaymentChannelFundingSource =
    row.funding_source === 'bound-wallet'
      ? {
          kind: 'bound-wallet',
          walletAddress: row.wallet_address ?? '',
        }
      : {
          kind: 'prepaid-credit',
          reservationId: row.funding_ref,
        };
  return {
    channelId: row.channel_id,
    principalId: row.principal_id,
    rail: 'evm-x402',
    chainId: Number(row.chain_id),
    stablecoinAddress: row.stablecoin_address,
    settlementContractAddress: row.settlement_contract_address,
    fundingSource,
    escrowMicros: Number(row.escrow_micros),
    committedMicros: Number(row.committed_micros),
    refundedMicros: Number(row.refunded_micros),
    state: row.state as StoredPaymentChannelState,
    openReceipt: receipt(row.open_tx_hash, row.open_block_number),
    closeReceipt: receipt(row.close_tx_hash, row.close_block_number),
    failureCode: row.failure_code,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    closedAtMs: row.closed_at_ms == null ? null : Number(row.closed_at_ms),
  };
}

export async function getPaymentChannel(
  db: D1Database,
  channelId: string,
): Promise<StoredPaymentChannel | null> {
  const row = await db
    .prepare(
      `SELECT channel_id, principal_id, rail, chain_id, stablecoin_address,
              settlement_contract_address, funding_source, funding_ref,
              wallet_address, escrow_micros, committed_micros, refunded_micros,
              state, open_tx_hash, open_block_number, close_tx_hash,
              close_block_number, failure_code, created_at_ms, updated_at_ms,
              closed_at_ms
       FROM payment_channels
       WHERE channel_id = ?`,
    )
    .bind(channelId)
    .first<PaymentChannelRow>();
  return row ? fromRow(row) : null;
}

function sameTerms(
  channel: StoredPaymentChannel,
  input: CreatePaymentChannelInput,
): boolean {
  return (
    channel.principalId === input.principalId &&
    channel.chainId === input.adapter.chainId &&
    channel.stablecoinAddress === input.adapter.stablecoinAddress &&
    channel.settlementContractAddress === input.adapter.settlementContractAddress &&
    channel.escrowMicros === input.escrowMicros &&
    channel.fundingSource.kind === input.fundingSource.kind &&
    (channel.fundingSource.kind === 'bound-wallet'
      ? input.fundingSource.kind === 'bound-wallet' &&
        channel.fundingSource.walletAddress === input.fundingSource.walletAddress
      : input.fundingSource.kind === 'prepaid-credit' &&
        channel.fundingSource.reservationId === input.fundingSource.reservationId)
  );
}

export async function createPaymentChannelOpening(
  db: D1Database,
  input: CreatePaymentChannelInput,
): Promise<CreatePaymentChannelResult> {
  const existing = await getPaymentChannel(db, input.channelId);
  if (existing) {
    return sameTerms(existing, input)
      ? { ok: true, created: false, channel: existing }
      : { ok: false, code: 'channel-conflict' };
  }

  const fundingRef =
    input.fundingSource.kind === 'bound-wallet'
      ? input.fundingSource.walletAddress
      : input.fundingSource.reservationId;
  const walletAddress =
    input.fundingSource.kind === 'bound-wallet'
      ? input.fundingSource.walletAddress
      : null;
  try {
    await db
      .prepare(
        `INSERT INTO payment_channels
         (channel_id, principal_id, rail, chain_id, stablecoin_address,
          settlement_contract_address, funding_source, funding_ref,
          wallet_address, escrow_micros, committed_micros, refunded_micros,
          state, created_at_ms, updated_at_ms)
         VALUES (?, ?, 'evm-x402', ?, ?, ?, ?, ?, ?, ?, 0, 0, 'opening', ?, ?)`,
      )
      .bind(
        input.channelId,
        input.principalId,
        input.adapter.chainId,
        input.adapter.stablecoinAddress,
        input.adapter.settlementContractAddress,
        input.fundingSource.kind,
        fundingRef,
        walletAddress,
        input.escrowMicros,
        input.nowMs,
        input.nowMs,
      )
      .run();
  } catch (error) {
    if (input.fundingSource.kind === 'prepaid-credit') {
      const conflicted = await db
        .prepare(
          `SELECT channel_id
           FROM payment_channels
           WHERE funding_source = 'prepaid-credit' AND funding_ref = ?`,
        )
        .bind(input.fundingSource.reservationId)
        .first<{ channel_id: string }>();
      if (conflicted && conflicted.channel_id !== input.channelId) {
        return { ok: false, code: 'funding-ref-conflict' };
      }
    }
    throw error;
  }

  const stored = await getPaymentChannel(db, input.channelId);
  if (!stored) throw new Error(`payment channel ${input.channelId} was not persisted`);
  return sameTerms(stored, input)
    ? { ok: true, created: true, channel: stored }
    : { ok: false, code: 'channel-conflict' };
}

export async function markPaymentChannelOpen(
  db: D1Database,
  channelId: string,
  receiptValue: PaymentChannelRailReceipt,
  nowMs = Date.now(),
): Promise<StoredPaymentChannel> {
  await db
    .prepare(
      `UPDATE payment_channels
       SET state = 'open', open_tx_hash = ?, open_block_number = ?,
           failure_code = NULL, updated_at_ms = ?
       WHERE channel_id = ? AND state IN ('opening', 'open')`,
    )
    .bind(
      receiptValue.transactionHash,
      receiptValue.blockNumber.toString(),
      nowMs,
      channelId,
    )
    .run();
  const channel = await getPaymentChannel(db, channelId);
  if (!channel || channel.state !== 'open') {
    throw new Error(`payment channel ${channelId} did not reach open state`);
  }
  return channel;
}

export async function markPaymentChannelFailed(
  db: D1Database,
  channelId: string,
  failureCode: string,
  nowMs = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE payment_channels
       SET state = 'failed', failure_code = ?, updated_at_ms = ?
       WHERE channel_id = ? AND state = 'opening'`,
    )
    .bind(failureCode, nowMs, channelId)
    .run();
}

export async function beginPaymentChannelClose(
  db: D1Database,
  channelId: string,
  committedMicros: number,
  refundedMicros: number,
  nowMs = Date.now(),
): Promise<StoredPaymentChannel> {
  await db
    .prepare(
      `UPDATE payment_channels
       SET state = 'closing', committed_micros = ?, refunded_micros = ?,
           failure_code = NULL, updated_at_ms = ?
       WHERE channel_id = ? AND state = 'open'`,
    )
    .bind(committedMicros, refundedMicros, nowMs, channelId)
    .run();
  const channel = await getPaymentChannel(db, channelId);
  if (!channel) throw new Error(`payment channel ${channelId} disappeared`);
  return channel;
}

export async function markPaymentChannelCloseRetryable(
  db: D1Database,
  channelId: string,
  failureCode: string,
  nowMs = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE payment_channels
       SET state = 'open', committed_micros = 0, refunded_micros = 0,
           failure_code = ?, updated_at_ms = ?
       WHERE channel_id = ? AND state = 'closing' AND close_tx_hash IS NULL`,
    )
    .bind(failureCode, nowMs, channelId)
    .run();
}

export async function recordPaymentChannelCloseReceipt(
  db: D1Database,
  channelId: string,
  input: {
    readonly committedMicros: number;
    readonly refundedMicros: number;
    readonly receipt: PaymentChannelRailReceipt;
    readonly nowMs?: number;
  },
): Promise<StoredPaymentChannel> {
  await db
    .prepare(
      `UPDATE payment_channels
       SET close_tx_hash = ?, close_block_number = ?, committed_micros = ?,
           refunded_micros = ?, updated_at_ms = ?
       WHERE channel_id = ? AND state = 'closing'`,
    )
    .bind(
      input.receipt.transactionHash,
      input.receipt.blockNumber.toString(),
      input.committedMicros,
      input.refundedMicros,
      input.nowMs ?? Date.now(),
      channelId,
    )
    .run();
  const channel = await getPaymentChannel(db, channelId);
  if (!channel || !channel.closeReceipt) {
    throw new Error(`payment channel ${channelId} close receipt was not persisted`);
  }
  return channel;
}

export async function markPaymentChannelClosed(
  db: D1Database,
  channelId: string,
  nowMs = Date.now(),
): Promise<StoredPaymentChannel> {
  await db
    .prepare(
      `UPDATE payment_channels
       SET state = 'closed', failure_code = NULL, updated_at_ms = ?,
           closed_at_ms = ?
       WHERE channel_id = ? AND state = 'closing' AND close_tx_hash IS NOT NULL`,
    )
    .bind(nowMs, nowMs, channelId)
    .run();
  const channel = await getPaymentChannel(db, channelId);
  if (!channel || channel.state !== 'closed') {
    throw new Error(`payment channel ${channelId} did not reach closed state`);
  }
  return channel;
}
