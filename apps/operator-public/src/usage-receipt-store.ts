/**
 * D1 store for the P-031 metering interception.
 *
 * `p2p/microcharge.ts` keeps its channel state in memory — a reservations map,
 * a receipts map, and a cumulative watermark. A Worker has no memory between
 * requests, so this module REHYDRATES that exact shape from D1 before the pure
 * core decides, and persists the decision after it. The consequence is what
 * matters: `duplicate-nonce`, `cumulative-regression` and `cap-exhausted` stop
 * being properties of one process's heap and become properties of the row store
 * plus the `payment_channels` CHECK constraint (mig 023), so a restart, a retry
 * or a second concurrent buyer cannot spend the same escrow twice.
 *
 * D-055: the Worker STORES facts the parties signed; it never authors them. The
 * payer's voucher signature and the seller's receipt signature are persisted
 * verbatim.
 */
import type { MicrochargeChannel } from '@papercusp/operator-core/lib/p2p/microcharge.ts';
import type { StoredPaymentChannel } from './payment-channel-store.ts';

export type UsageReceiptState = 'reserved' | 'settled';

interface UsageReceiptRow {
  channel_id: string;
  usage_nonce: string;
  principal_id: string;
  offer_id: string;
  payer: string;
  seller: string;
  release_ref: string;
  meter_unit: string;
  meter_quantity: number;
  unit_price_micros: number;
  price_version: string;
  split_manifest_hash: string;
  reserved_micros: number;
  amount_micros: number | null;
  cumulative_claim_micros: number;
  expires_at_ms: number;
  voucher_digest: string;
  voucher_signature: string;
  receipt_signature: string | null;
  state: string;
  reserved_at_ms: number;
  settled_at_ms: number | null;
}

export interface StoredUsageReceipt {
  readonly channelId: string;
  readonly usageNonce: string;
  readonly principalId: string;
  readonly offerId: string;
  readonly payer: string;
  readonly seller: string;
  readonly releaseRef: string;
  readonly meterUnit: string;
  readonly meterQuantity: number;
  readonly unitPriceMicros: number;
  readonly priceVersion: string;
  readonly splitManifestHash: string;
  readonly reservedMicros: number;
  readonly amountMicros: number | null;
  readonly cumulativeClaimMicros: number;
  readonly expiresAtMs: number;
  readonly voucherDigest: string;
  readonly voucherSignature: string;
  readonly receiptSignature: string | null;
  readonly state: UsageReceiptState;
  readonly reservedAtMs: number;
  readonly settledAtMs: number | null;
}

const COLUMNS = `channel_id, usage_nonce, principal_id, offer_id, payer, seller,
       release_ref, meter_unit, meter_quantity, unit_price_micros, price_version,
       split_manifest_hash, reserved_micros, amount_micros,
       cumulative_claim_micros, expires_at_ms, voucher_digest, voucher_signature,
       receipt_signature, state, reserved_at_ms, settled_at_ms`;

function fromRow(row: UsageReceiptRow): StoredUsageReceipt {
  return {
    channelId: row.channel_id,
    usageNonce: row.usage_nonce,
    principalId: row.principal_id,
    offerId: row.offer_id,
    payer: row.payer,
    seller: row.seller,
    releaseRef: row.release_ref,
    meterUnit: row.meter_unit,
    meterQuantity: Number(row.meter_quantity),
    unitPriceMicros: Number(row.unit_price_micros),
    priceVersion: row.price_version,
    splitManifestHash: row.split_manifest_hash,
    reservedMicros: Number(row.reserved_micros),
    amountMicros: row.amount_micros == null ? null : Number(row.amount_micros),
    cumulativeClaimMicros: Number(row.cumulative_claim_micros),
    expiresAtMs: Number(row.expires_at_ms),
    voucherDigest: row.voucher_digest,
    voucherSignature: row.voucher_signature,
    receiptSignature: row.receipt_signature,
    state: row.state as UsageReceiptState,
    reservedAtMs: Number(row.reserved_at_ms),
    settledAtMs: row.settled_at_ms == null ? null : Number(row.settled_at_ms),
  };
}

export async function getUsageReceipt(
  db: D1Database,
  channelId: string,
  usageNonce: string,
): Promise<StoredUsageReceipt | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM usage_receipts WHERE channel_id = ? AND usage_nonce = ?`)
    .bind(channelId, usageNonce)
    .first<UsageReceiptRow>();
  return row ? fromRow(row) : null;
}

export async function listChannelUsageReceipts(
  db: D1Database,
  channelId: string,
): Promise<readonly StoredUsageReceipt[]> {
  const rows = await db
    .prepare(`SELECT ${COLUMNS} FROM usage_receipts WHERE channel_id = ? ORDER BY reserved_at_ms ASC, usage_nonce ASC`)
    .bind(channelId)
    .all<UsageReceiptRow>();
  return (rows.results ?? []).map(fromRow);
}

/**
 * Rebuild the in-memory `MicrochargeChannel` the pure core expects from durable
 * state.
 *
 * `committedMicros` and `escrowMicros` come from `payment_channels` (the escrow
 * authority, mig 023) rather than from summing receipts: the chain-facing
 * committed total is what the CHECK constraint guards, and re-deriving it here
 * would let the two disagree silently.
 */
export async function loadMicrochargeChannel(
  db: D1Database,
  channel: StoredPaymentChannel,
): Promise<MicrochargeChannel> {
  const receipts = await listChannelUsageReceipts(db, channel.channelId);
  const reservations: Record<string, bigint> = {};
  const settled: Record<string, string> = {};
  let lastCumulativeMicros = 0n;
  for (const r of receipts) {
    const claim = BigInt(r.cumulativeClaimMicros);
    if (claim > lastCumulativeMicros) lastCumulativeMicros = claim;
    if (r.state === 'reserved') reservations[r.usageNonce] = BigInt(r.reservedMicros);
    else settled[r.usageNonce] = r.voucherDigest;
  }
  return {
    channelId: channel.channelId,
    escrowMicros: BigInt(channel.escrowMicros),
    committedMicros: BigInt(channel.committedMicros),
    lastCumulativeMicros,
    reservations,
    receipts: settled,
  };
}

export interface ReserveUsageReceiptInput {
  readonly channelId: string;
  readonly usageNonce: string;
  readonly principalId: string;
  readonly offerId: string;
  readonly payer: string;
  readonly seller: string;
  readonly releaseRef: string;
  readonly meterUnit: string;
  readonly meterQuantity: bigint;
  readonly unitPriceMicros: bigint;
  readonly priceVersion: string;
  readonly splitManifestHash: string;
  readonly reservedMicros: bigint;
  readonly cumulativeClaimMicros: bigint;
  readonly expiresAtMs: number;
  readonly voucherDigest: string;
  readonly voucherSignature: string;
  readonly nowMs: number;
}

export type ReserveUsageReceiptResult =
  | { readonly ok: true; readonly receipt: StoredUsageReceipt }
  | { readonly ok: false; readonly code: 'duplicate-nonce'; readonly receipt: StoredUsageReceipt | null };

/**
 * Persist a reservation.
 *
 * The insert is deliberately UNGUARDED by a prior read: the PRIMARY KEY is the
 * race winner, so two concurrent requests carrying the same nonce cannot both
 * reserve, however they interleave. `ON CONFLICT DO NOTHING` turns the loser
 * into a named `duplicate-nonce` refusal instead of a 500.
 */
export async function reserveUsageReceipt(
  db: D1Database,
  input: ReserveUsageReceiptInput,
): Promise<ReserveUsageReceiptResult> {
  await db
    .prepare(
      `INSERT INTO usage_receipts (
         channel_id, usage_nonce, principal_id, offer_id, payer, seller,
         release_ref, meter_unit, meter_quantity, unit_price_micros,
         price_version, split_manifest_hash, reserved_micros, amount_micros,
         cumulative_claim_micros, expires_at_ms, voucher_digest, voucher_signature,
         receipt_signature, state, reserved_at_ms, settled_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, 'reserved', ?, NULL)
       ON CONFLICT (channel_id, usage_nonce) DO NOTHING`,
    )
    .bind(
      input.channelId,
      input.usageNonce,
      input.principalId,
      input.offerId,
      input.payer,
      input.seller,
      input.releaseRef,
      input.meterUnit,
      Number(input.meterQuantity),
      Number(input.unitPriceMicros),
      input.priceVersion,
      input.splitManifestHash,
      Number(input.reservedMicros),
      Number(input.cumulativeClaimMicros),
      input.expiresAtMs,
      input.voucherDigest,
      input.voucherSignature,
      input.nowMs,
    )
    .run();
  const stored = await getUsageReceipt(db, input.channelId, input.usageNonce);
  if (!stored) return { ok: false, code: 'duplicate-nonce', receipt: null };
  // A row whose digest differs from the one we just built is somebody else's
  // reservation under the same nonce — the conflict we were guarding against.
  if (stored.voucherDigest !== input.voucherDigest || stored.reservedAtMs !== input.nowMs) {
    return { ok: false, code: 'duplicate-nonce', receipt: stored };
  }
  return { ok: true, receipt: stored };
}

export interface SettleUsageReceiptInput {
  readonly channelId: string;
  readonly usageNonce: string;
  readonly amountMicros: bigint;
  readonly meterQuantity: bigint;
  readonly receiptSignature: string;
  readonly nowMs: number;
}

export type SettleUsageReceiptResult =
  | { readonly ok: true; readonly receipt: StoredUsageReceipt }
  | {
      readonly ok: false;
      readonly code: 'unknown-reservation' | 'already-settled' | 'cap-exhausted';
      readonly detail: string;
    };

/**
 * Settle a reservation and advance the channel's committed escrow, atomically.
 *
 * Both writes go in ONE `db.batch`. If the committed increment would break mig
 * 023's `committed_micros + refunded_micros <= escrow_micros` CHECK, the whole
 * batch rolls back — so a settlement can never record a receipt for money the
 * escrow does not hold. That constraint IS the durable cap-exhaustion refusal;
 * the pure core's in-memory check is the fast path, not the authority.
 */
export async function settleUsageReceipt(
  db: D1Database,
  input: SettleUsageReceiptInput,
): Promise<SettleUsageReceiptResult> {
  const existing = await getUsageReceipt(db, input.channelId, input.usageNonce);
  if (!existing) {
    return { ok: false, code: 'unknown-reservation', detail: `no reservation for usage nonce '${input.usageNonce}'` };
  }
  if (existing.state === 'settled') {
    return { ok: false, code: 'already-settled', detail: `usage nonce '${input.usageNonce}' was already settled` };
  }
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE usage_receipts
              SET state = 'settled', amount_micros = ?, meter_quantity = ?,
                  receipt_signature = ?, settled_at_ms = ?
            WHERE channel_id = ? AND usage_nonce = ? AND state = 'reserved'`,
        )
        .bind(
          Number(input.amountMicros),
          Number(input.meterQuantity),
          input.receiptSignature,
          input.nowMs,
          input.channelId,
          input.usageNonce,
        ),
      db
        .prepare(
          `UPDATE payment_channels
              SET committed_micros = committed_micros + ?, updated_at_ms = ?
            WHERE channel_id = ?`,
        )
        .bind(Number(input.amountMicros), input.nowMs, input.channelId),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The CHECK constraint is the only failure this batch can produce that is a
    // legitimate refusal rather than a bug; anything else must not be swallowed.
    if (/CHECK constraint|constraint failed/i.test(message)) {
      return { ok: false, code: 'cap-exhausted', detail: 'settling this receipt would exceed the channel escrow' };
    }
    throw error;
  }
  const settled = await getUsageReceipt(db, input.channelId, input.usageNonce);
  if (!settled || settled.state !== 'settled') {
    return { ok: false, code: 'unknown-reservation', detail: `reservation '${input.usageNonce}' was not settled` };
  }
  return { ok: true, receipt: settled };
}
