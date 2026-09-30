/**
 * Per-use microcharge protocol (P-020).
 *
 * Amounts are bigint micro-units internally: tiny charges never pass through
 * floating point. The payer signs cumulative vouchers; the host reserves the
 * delta before execution and settles the actual usage afterwards.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';

export interface CumulativePaymentVoucher {
  readonly channelId: string;
  readonly payer: string;
  readonly seller: string;
  readonly releaseRef: string;
  readonly usageNonce: string;
  readonly meterQuantity: bigint;
  readonly pricePerUnitMicros: bigint;
  readonly priceVersion: string;
  readonly splitManifestHash: string;
  readonly expiresAtMs: number;
  readonly cumulativeClaimMicros: bigint;
  readonly signature: string;
}

/**
 * Strip the signature so a signed voucher can be fed to the signing-bytes / digest
 * functions. (The former `{ ...voucher, signature: undefined as never }` spread idiom
 * is an excess-property error under TypeScript 6 — `Omit<T, 'signature'>` rejects a
 * literal that names the omitted key.)
 */
export function unsignedVoucher(voucher: CumulativePaymentVoucher): Omit<CumulativePaymentVoucher, 'signature'> {
  const { signature: _signature, ...unsigned } = voucher;
  void _signature;
  return unsigned;
}

function voucherJson(voucher: Omit<CumulativePaymentVoucher, 'signature'>): Record<string, unknown> {
  return {
    channelId: voucher.channelId,
    cumulativeClaimMicros: voucher.cumulativeClaimMicros.toString(),
    expiresAtMs: voucher.expiresAtMs,
    meterQuantity: voucher.meterQuantity.toString(),
    payer: voucher.payer,
    pricePerUnitMicros: voucher.pricePerUnitMicros.toString(),
    priceVersion: voucher.priceVersion,
    releaseRef: voucher.releaseRef,
    seller: voucher.seller,
    splitManifestHash: voucher.splitManifestHash,
    usageNonce: voucher.usageNonce,
  };
}

export function paymentVoucherSigningBytes(voucher: Omit<CumulativePaymentVoucher, 'signature'>): Buffer {
  return Buffer.from(canonicalJson(voucherJson(voucher)), 'utf8');
}

export function paymentVoucherDigest(voucher: Omit<CumulativePaymentVoucher, 'signature'>): string {
  return createHash('sha256').update(paymentVoucherSigningBytes(voucher)).digest('hex');
}

export interface SignedUsageReceipt {
  readonly channelId: string;
  readonly usageNonce: string;
  readonly meterQuantity: bigint;
  readonly amountMicros: bigint;
  readonly voucherDigest: string;
  readonly occurredAtMs: number;
  readonly signature: string;
}

export interface MicrochargeChannel {
  readonly channelId: string;
  readonly escrowMicros: bigint;
  readonly committedMicros: bigint;
  readonly lastCumulativeMicros: bigint;
  readonly reservations: Readonly<Record<string, bigint>>;
  readonly receipts: Readonly<Record<string, string>>;
}

export function createMicrochargeChannel(channelId: string, escrowMicros: bigint): MicrochargeChannel {
  if (!channelId.trim() || escrowMicros < 0n) throw new Error('channelId must be non-empty and escrowMicros must be non-negative');
  return { channelId, escrowMicros, committedMicros: 0n, lastCumulativeMicros: 0n, reservations: {}, receipts: {} };
}

export type MicrochargeRefusalCode = 'channel-mismatch' | 'expired' | 'invalid-voucher' | 'cumulative-regression' | 'duplicate-nonce' | 'cap-exhausted' | 'unknown-reservation' | 'actual-exceeds-reservation';

export type MicrochargeOpenResult =
  | { readonly ok: true; readonly channel: MicrochargeChannel; readonly deltaMicros: bigint }
  | { readonly ok: false; readonly code: MicrochargeRefusalCode; readonly detail: string };

/** Reserve a cumulative voucher delta before execution. */
export function reserveMicrocharge(channel: MicrochargeChannel, voucher: CumulativePaymentVoucher, nowMs: number): MicrochargeOpenResult {
  if (voucher.channelId !== channel.channelId) return { ok: false, code: 'channel-mismatch', detail: 'voucher channel does not match the local payment channel' };
  if (!voucher.payer.trim() || !voucher.seller.trim() || !voucher.releaseRef.trim() || !voucher.usageNonce.trim() || !voucher.priceVersion.trim() || !voucher.splitManifestHash.trim() || voucher.signature.trim() === '') return { ok: false, code: 'invalid-voucher', detail: 'voucher identity, price, split, and signature fields are required' };
  if (voucher.meterQuantity <= 0n || voucher.pricePerUnitMicros < 0n || voucher.cumulativeClaimMicros < 0n || !Number.isFinite(nowMs) || nowMs > voucher.expiresAtMs) return { ok: false, code: nowMs > voucher.expiresAtMs ? 'expired' : 'invalid-voucher', detail: 'voucher amount fields must be valid and the voucher must not be expired' };
  if (voucher.usageNonce in channel.receipts || voucher.usageNonce in channel.reservations) return { ok: false, code: 'duplicate-nonce', detail: `usage nonce '${voucher.usageNonce}' was already observed` };
  if (voucher.cumulativeClaimMicros <= channel.lastCumulativeMicros) return { ok: false, code: 'cumulative-regression', detail: 'cumulative claim must advance monotonically' };
  const deltaMicros = voucher.cumulativeClaimMicros - channel.lastCumulativeMicros;
  // OUTSTANDING RESERVATIONS COUNT AGAINST THE CAP. Checking `committedMicros`
  // alone only sees units that already SETTLED, so units reserved-but-not-yet-
  // settled were invisible and several of them could each pass while together
  // exceeding the escrow. That defeats the purpose of reserving first: the
  // overdraft then surfaced at settlement — after the seller had already served
  // the unit — against `payment_channels`' committed + refunded <= escrow CHECK,
  // as a database error rather than a refusal anyone could act on.
  let heldMicros = 0n;
  for (const reserved of Object.values(channel.reservations)) heldMicros += reserved;
  if (channel.committedMicros + heldMicros + deltaMicros > channel.escrowMicros) return { ok: false, code: 'cap-exhausted', detail: 'cumulative claim exceeds escrow/channel cap' };
  return { ok: true, deltaMicros, channel: { ...channel, lastCumulativeMicros: voucher.cumulativeClaimMicros, reservations: { ...channel.reservations, [voucher.usageNonce]: deltaMicros } } };
}

export type MicrochargeSettleResult =
  | { readonly ok: true; readonly channel: MicrochargeChannel; readonly receipt: SignedUsageReceipt }
  | { readonly ok: false; readonly code: MicrochargeRefusalCode; readonly detail: string };

/** Settle actual usage, releasing unused reserved escrow and recording a receipt digest. */
export function settleMicrocharge(input: { channel: MicrochargeChannel; voucher: CumulativePaymentVoucher; actualAmountMicros?: bigint; actualMeterQuantity?: bigint; occurredAtMs: number; receiptSignature: string }): MicrochargeSettleResult {
  const reserved = input.channel.reservations[input.voucher.usageNonce];
  if (reserved == null) return { ok: false, code: 'unknown-reservation', detail: `no reservation for usage nonce '${input.voucher.usageNonce}'` };
  const actual = input.actualAmountMicros ?? reserved;
  if (actual < 0n || actual > reserved) return { ok: false, code: 'actual-exceeds-reservation', detail: `actual amount ${actual} exceeds reserved delta ${reserved}` };
  if (!input.receiptSignature.trim()) return { ok: false, code: 'invalid-voucher', detail: 'signed usage receipt signature is required' };
  const { [input.voucher.usageNonce]: _reserved, ...rest } = input.channel.reservations;
  void _reserved;
  const receipt: SignedUsageReceipt = { channelId: input.channel.channelId, usageNonce: input.voucher.usageNonce, meterQuantity: input.actualMeterQuantity ?? input.voucher.meterQuantity, amountMicros: actual, voucherDigest: paymentVoucherDigest(unsignedVoucher(input.voucher)), occurredAtMs: input.occurredAtMs, signature: input.receiptSignature };
  return { ok: true, channel: { ...input.channel, committedMicros: input.channel.committedMicros + actual, reservations: rest, receipts: { ...input.channel.receipts, [input.voucher.usageNonce]: receipt.voucherDigest } }, receipt };
}
