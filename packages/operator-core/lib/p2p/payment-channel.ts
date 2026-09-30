/** Network-neutral batch settlement adapter over cumulative vouchers (P-021). */
import { paymentVoucherDigest, unsignedVoucher, type CumulativePaymentVoucher } from './microcharge';

export type PaymentRail = 'evm-x402' | 'lightning' | 'custom';

export interface PaymentChannelState {
  readonly channelId: string;
  readonly rail: PaymentRail;
  readonly escrowMicros: bigint;
  readonly settledMicros: bigint;
  readonly lastCumulativeMicros: bigint;
  readonly claimedVoucherDigests: readonly string[];
}

export function createPaymentChannel(channelId: string, rail: PaymentRail, escrowMicros: bigint): PaymentChannelState {
  if (!channelId.trim() || escrowMicros < 0n) throw new Error('channelId must be non-empty and escrowMicros non-negative');
  return { channelId, rail, escrowMicros, settledMicros: 0n, lastCumulativeMicros: 0n, claimedVoucherDigests: [] };
}

export type ChannelRefusalCode = 'empty-batch' | 'channel-mismatch' | 'expired' | 'invalid-signature' | 'non-monotonic' | 'duplicate-claim' | 'escrow-exhausted' | 'dispute';

export type BatchSettlementResult =
  | { readonly ok: true; readonly channel: PaymentChannelState; readonly claimMicros: bigint; readonly voucherDigests: readonly string[] }
  | { readonly ok: false; readonly code: ChannelRefusalCode; readonly detail: string };

/** Verify and settle a batch off-chain. The returned state is the claim proof input. */
export function settleVoucherBatch(input: {
  channel: PaymentChannelState;
  vouchers: readonly CumulativePaymentVoucher[];
  nowMs: number;
  verifySignature?: (voucher: CumulativePaymentVoucher) => boolean;
  disputed?: boolean;
}): BatchSettlementResult {
  if (input.disputed) return { ok: false, code: 'dispute', detail: 'settlement is frozen while a voucher dispute or chain reorg is unresolved' };
  if (input.vouchers.length === 0) return { ok: false, code: 'empty-batch', detail: 'at least one voucher is required' };
  const verify = input.verifySignature ?? ((v: CumulativePaymentVoucher) => v.signature.trim().length > 0);
  let cumulative = input.channel.lastCumulativeMicros;
  const digests: string[] = [];
  for (const voucher of input.vouchers) {
    if (voucher.channelId !== input.channel.channelId) return { ok: false, code: 'channel-mismatch', detail: 'voucher belongs to a different payment channel' };
    if (!Number.isFinite(input.nowMs) || input.nowMs > voucher.expiresAtMs) return { ok: false, code: 'expired', detail: `voucher '${voucher.usageNonce}' is expired` };
    if (!verify(voucher)) return { ok: false, code: 'invalid-signature', detail: `voucher '${voucher.usageNonce}' signature failed verification` };
    const digest = paymentVoucherDigest(unsignedVoucher(voucher));
    if (input.channel.claimedVoucherDigests.includes(digest) || digests.includes(digest)) return { ok: false, code: 'duplicate-claim', detail: `voucher '${voucher.usageNonce}' was already claimed` };
    if (voucher.cumulativeClaimMicros <= cumulative) return { ok: false, code: 'non-monotonic', detail: 'batch vouchers must advance cumulative claims monotonically' };
    cumulative = voucher.cumulativeClaimMicros;
    digests.push(digest);
  }
  const claimMicros = cumulative - input.channel.lastCumulativeMicros;
  if (input.channel.settledMicros + claimMicros > input.channel.escrowMicros) return { ok: false, code: 'escrow-exhausted', detail: 'batch claim exceeds escrow balance' };
  return { ok: true, claimMicros, voucherDigests: digests, channel: { ...input.channel, settledMicros: input.channel.settledMicros + claimMicros, lastCumulativeMicros: cumulative, claimedVoucherDigests: [...input.channel.claimedVoucherDigests, ...digests] } };
}

export function refundableEscrow(channel: PaymentChannelState): bigint {
  return channel.escrowMicros - channel.settledMicros;
}
