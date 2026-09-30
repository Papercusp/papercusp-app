/**
 * Pilot EVM/stablecoin settlement adapter (P-022), with RPC submission injected,
 * plus the P-033 batch settlement execution pipeline built on top of it.
 *
 * P-022 shipped only the calldata builder. P-033 adds the spine that actually
 * executes a batch: `settleVoucherBatch` (P-021) output drives the request
 * builder here, the integer-atomic revenue split (P-018) is computed over the
 * claimed amount, an injected self-hosted facilitator submits the claim/refund,
 * and the result is projected into a P-016 `settlement-proof` commerce event.
 *
 * Acceptance line 14 — "distinguish a payment claim from payment finality" — is
 * why `SettlementLifecycleState` separates `claimed` (a transaction the chain
 * accepted) from `final` (a transaction buried under the configured number of
 * confirmations). A claim is never treated as money received: a reorg can drop
 * it, and `unwindReorgedClaim` is the recovery that puts the channel and its
 * vouchers back where they were so the batch can be re-claimed.
 *
 * SCOPE BOUNDARY: this module computes the split allocations and records them in
 * the settlement proof. Routing those allocations to the Safe/Zodiac DAO
 * treasury is P-034, which is blocked on this item; nothing here moves money to
 * a treasury.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import type { CommerceEvent } from './commerce-events';
import type { CumulativePaymentVoucher } from './microcharge';
import { settleVoucherBatch, type ChannelRefusalCode, type PaymentChannelState } from './payment-channel';
import {
  REVENUE_SHARES,
  settleRevenue,
  type RevenueSplitManifest,
  type SettlementReceipt,
  type SettlementRefusalCode,
} from './revenue-settlement';

export interface EvmSettlementConfig {
  readonly chainId: number;
  readonly settlementContract: string;
  readonly stablecoin: string;
  readonly maxBatchSize: number;
}

export type EvmConfigResult = { ok: true; config: EvmSettlementConfig } | { ok: false; code: 'invalid-chain' | 'invalid-address' | 'invalid-batch-size'; detail: string };

export function validateEvmSettlementConfig(config: EvmSettlementConfig): EvmConfigResult {
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) return { ok: false, code: 'invalid-chain', detail: 'chainId must be a positive safe integer' };
  const address = /^0x[0-9a-fA-F]{40}$/;
  if (!address.test(config.settlementContract) || !address.test(config.stablecoin)) return { ok: false, code: 'invalid-address', detail: 'settlementContract and stablecoin must be 20-byte EVM addresses' };
  if (!Number.isSafeInteger(config.maxBatchSize) || config.maxBatchSize < 1 || config.maxBatchSize > 500) return { ok: false, code: 'invalid-batch-size', detail: 'maxBatchSize must be between 1 and 500' };
  return { ok: true, config };
}

export interface EvmBatchSettlementRequest {
  readonly chainId: number;
  readonly to: string;
  readonly stablecoin: string;
  readonly channelId: string;
  readonly amountMicros: bigint;
  readonly voucherDigests: readonly string[];
  readonly calldata: string;
  readonly requestHash: string;
}

export type EvmRequestResult = { ok: true; request: EvmBatchSettlementRequest } | { ok: false; code: 'invalid-config' | 'wrong-rail' | 'empty-batch' | 'batch-too-large' | 'amount-invalid'; detail: string };

/** Build deterministic calldata-like bytes for an injected EVM RPC client. */
export function buildEvmBatchSettlementRequest(input: { config: EvmSettlementConfig; channel: PaymentChannelState; amountMicros: bigint; voucherDigests: readonly string[] }): EvmRequestResult {
  const config = validateEvmSettlementConfig(input.config);
  if (!config.ok) return { ok: false, code: 'invalid-config', detail: config.detail };
  if (input.channel.rail !== 'evm-x402') return { ok: false, code: 'wrong-rail', detail: `channel rail '${input.channel.rail}' is not evm-x402` };
  if (input.voucherDigests.length === 0) return { ok: false, code: 'empty-batch', detail: 'at least one voucher digest is required' };
  if (input.voucherDigests.length > config.config.maxBatchSize) return { ok: false, code: 'batch-too-large', detail: 'voucher batch exceeds configured maxBatchSize' };
  if (input.amountMicros <= 0n || input.amountMicros > input.channel.escrowMicros - input.channel.settledMicros) return { ok: false, code: 'amount-invalid', detail: 'amount must be positive and within channel escrow' };
  const body = { amountMicros: input.amountMicros.toString(), channelId: input.channel.channelId, chainId: config.config.chainId, stablecoin: config.config.stablecoin.toLowerCase(), to: config.config.settlementContract.toLowerCase(), voucherDigests: [...input.voucherDigests] };
  const calldata = Buffer.from(canonicalJson(body), 'utf8').toString('hex');
  // `body` carries amountMicros as a decimal string for canonical JSON; the request type keeps the bigint.
  return { ok: true, request: { ...body, amountMicros: input.amountMicros, calldata: `0x${calldata}`, requestHash: createHash('sha256').update(calldata).digest('hex') } };
}

/* ------------------------------------------------------------------ *
 * P-033 — batch settlement execution
 * ------------------------------------------------------------------ */

/**
 * Lifecycle of one submitted batch. `claimed` and `final` are deliberately
 * distinct states, not two readings of one flag: the acceptance criterion is
 * that a payment CLAIM is never reported as payment FINALITY.
 */
export const SETTLEMENT_LIFECYCLE_STATES = ['claimed', 'final', 'reorged', 'disputed', 'refunded'] as const;
export type SettlementLifecycleState = (typeof SETTLEMENT_LIFECYCLE_STATES)[number];

/** A transaction the facilitator got onto the pilot rail. */
export interface EvmTransactionReceipt {
  readonly transactionHash: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
}

/**
 * What the chain says about a previously submitted transaction RIGHT NOW.
 * `present: false` is a real answer (the transaction is no longer in the
 * canonical chain), not an error — it is exactly the reorg signal.
 */
export type EvmTransactionObservation =
  | {
      readonly present: true;
      readonly blockNumber: bigint;
      readonly blockHash: string;
      readonly headBlockNumber: bigint;
      readonly reverted?: boolean;
    }
  | { readonly present: false; readonly headBlockNumber: bigint };

/**
 * Self-hosted facilitator contract. Papercusp runs this itself against the
 * pilot L2 — it is an interface rather than a third-party service so the
 * production door can inject a deterministic fake in tests and a viem-backed
 * implementation in the Worker.
 *
 * `submitBatchClaim` MUST be idempotent by `request.requestHash`: the Worker can
 * crash after the chain accepts the claim but before the batch row records the
 * receipt, and the retry must converge on the existing claim rather than double
 * spending the channel's escrow.
 */
export interface EvmSettlementFacilitator {
  readonly chainId: number;
  readonly settlementContract: string;
  readonly stablecoin: string;
  /** The address that submits claims — also the settlement proof's issuer. */
  readonly signerAddress: string;
  /** Confirmations required before a claim is treated as final. */
  readonly requiredConfirmations: number;
  submitBatchClaim(request: EvmBatchSettlementRequest): Promise<EvmTransactionReceipt>;
  submitRefund(input: { channelId: string; amountMicros: bigint; refundAddress: string }): Promise<EvmTransactionReceipt>;
  observeTransaction(transactionHash: string): Promise<EvmTransactionObservation>;
  /**
   * Sign `commerceEventSigningBytes` for a settlement proof.
   *
   * The signer that submitted the claim is the party attesting to it, so the
   * proof is verifiable against the same address that appears on chain. This
   * module never holds the key; the facilitator does.
   */
  signSettlementProof(bytes: Uint8Array): Promise<string>;
}

export interface BatchSettlementPlan {
  /** The channel state AFTER the batch is applied — the claim proof input. */
  readonly channel: PaymentChannelState;
  /** The channel state BEFORE the batch, kept so a reorg can be unwound. */
  readonly priorChannel: PaymentChannelState;
  readonly claimMicros: bigint;
  readonly cumulativeClaimMicros: bigint;
  readonly voucherDigests: readonly string[];
  readonly request: EvmBatchSettlementRequest;
  /** Integer-atomic split of the claimed amount (allocations sum exactly). */
  readonly receipt: SettlementReceipt;
}

export type BatchSettlementRefusalCode =
  | ChannelRefusalCode
  | SettlementRefusalCode
  | 'invalid-config'
  | 'wrong-rail'
  | 'batch-too-large'
  | 'amount-invalid'
  | 'split-not-atomic';

export type BatchSettlementPlanResult =
  | { readonly ok: true; readonly plan: BatchSettlementPlan }
  | { readonly ok: false; readonly code: BatchSettlementRefusalCode; readonly detail: string };

/**
 * Drive one batch end to end, up to but not including submission.
 *
 * `settleVoucherBatch` is the authority on which vouchers may be claimed (the
 * double-spend, monotonicity, expiry, signature and escrow refusals all live
 * there). Its output — and only its output — feeds the revenue split and the
 * EVM request, so a batch that the channel refuses can never reach the rail.
 */
export function planBatchSettlement(input: {
  readonly config: EvmSettlementConfig;
  readonly channel: PaymentChannelState;
  readonly vouchers: readonly CumulativePaymentVoucher[];
  readonly nowMs: number;
  readonly settlementId: string;
  readonly splitManifest: RevenueSplitManifest;
  readonly daoTreasury: string;
  readonly providerCostMicros?: bigint;
  readonly verifySignature?: (voucher: CumulativePaymentVoucher) => boolean;
  /** A live dispute or unresolved reorg freezes settlement (P-033). */
  readonly disputed?: boolean;
}): BatchSettlementPlanResult {
  const settled = settleVoucherBatch({
    channel: input.channel,
    vouchers: input.vouchers,
    nowMs: input.nowMs,
    verifySignature: input.verifySignature,
    disputed: input.disputed,
  });
  if (!settled.ok) return { ok: false, code: settled.code, detail: settled.detail };

  const providerCostMicros = input.providerCostMicros ?? 0n;
  const split = settleRevenue({
    settlementId: input.settlementId,
    grossMicros: settled.claimMicros,
    providerCostMicros,
    splitManifest: input.splitManifest,
    daoTreasury: input.daoTreasury,
  });
  if (!split.ok) return { ok: false, code: split.code, detail: split.detail };

  // Integer-atomic accounting: every distributable micro-unit is allocated to
  // exactly one share. `settleRevenue` assigns the rounding remainder to the
  // DAO, so this is a guard against a future regression in that arithmetic
  // reaching the chain, not a restatement of it.
  let allocated = 0n;
  for (const share of REVENUE_SHARES) allocated += split.receipt.allocationsMicros[share];
  if (allocated !== split.receipt.distributableMicros) {
    return {
      ok: false,
      code: 'split-not-atomic',
      detail: `allocations sum to ${allocated} micros but ${split.receipt.distributableMicros} are distributable`,
    };
  }

  const request = buildEvmBatchSettlementRequest({
    config: input.config,
    channel: input.channel,
    amountMicros: settled.claimMicros,
    voucherDigests: settled.voucherDigests,
  });
  if (!request.ok) return { ok: false, code: request.code, detail: request.detail };

  return {
    ok: true,
    plan: {
      channel: settled.channel,
      priorChannel: input.channel,
      claimMicros: settled.claimMicros,
      cumulativeClaimMicros: settled.channel.lastCumulativeMicros,
      voucherDigests: settled.voucherDigests,
      request: request.request,
      receipt: split.receipt,
    },
  };
}

export type FinalityVerdict =
  | { readonly state: 'claimed'; readonly final: false; readonly confirmations: number; readonly detail: string }
  | { readonly state: 'final'; readonly final: true; readonly confirmations: number }
  | {
      readonly state: 'reorged';
      readonly final: false;
      readonly reason: 'dropped' | 'reverted' | 'block-hash-changed';
      readonly detail: string;
    };

/**
 * The claim-vs-finality verdict.
 *
 * A transaction that is present, un-reverted, in the block it was mined into,
 * and buried under `requiredConfirmations` is FINAL. Anything else is still a
 * claim — or, if the chain no longer agrees the transaction is where it was, a
 * reorg the caller must unwind.
 */
export function assessClaimFinality(input: {
  readonly claim: { readonly transactionHash: string; readonly blockNumber: bigint; readonly blockHash: string };
  readonly observation: EvmTransactionObservation;
  readonly requiredConfirmations: number;
}): FinalityVerdict {
  const required = Math.max(1, Math.trunc(input.requiredConfirmations));
  if (!input.observation.present) {
    return {
      state: 'reorged',
      final: false,
      reason: 'dropped',
      detail: `claim transaction '${input.claim.transactionHash}' is no longer in the canonical chain`,
    };
  }
  if (input.observation.reverted === true) {
    return {
      state: 'reorged',
      final: false,
      reason: 'reverted',
      detail: `claim transaction '${input.claim.transactionHash}' reverted on chain`,
    };
  }
  // A re-mined transaction is NOT the same claim: the block it now sits in
  // decides its ordering against every other claim on this channel.
  if (
    input.observation.blockHash !== input.claim.blockHash ||
    input.observation.blockNumber !== input.claim.blockNumber
  ) {
    return {
      state: 'reorged',
      final: false,
      reason: 'block-hash-changed',
      detail: `claim was mined in block ${input.claim.blockNumber} (${input.claim.blockHash}) but the chain now reports block ${input.observation.blockNumber} (${input.observation.blockHash})`,
    };
  }
  const depth = input.observation.headBlockNumber - input.observation.blockNumber;
  const confirmations = depth < 0n ? 0 : Number(depth) + 1;
  if (confirmations >= required) return { state: 'final', final: true, confirmations };
  return {
    state: 'claimed',
    final: false,
    confirmations,
    detail: `claim has ${confirmations} of ${required} required confirmations`,
  };
}

export type ReorgUnwindResult =
  | { readonly ok: true; readonly channel: PaymentChannelState }
  | { readonly ok: false; readonly code: 'unwind-mismatch'; readonly detail: string };

/**
 * Recovery half of the reorg path: put the channel back exactly where it was
 * before the dropped claim, so the same vouchers can be re-claimed.
 *
 * The digests are REMOVED rather than kept: a reorged claim never happened, so
 * leaving them recorded would make the vouchers permanently unclaimable — a
 * silent loss to the seller, which is the failure mode this exists to prevent.
 */
export function unwindReorgedClaim(input: {
  readonly channel: PaymentChannelState;
  readonly claimMicros: bigint;
  readonly voucherDigests: readonly string[];
  readonly priorCumulativeMicros: bigint;
}): ReorgUnwindResult {
  if (input.claimMicros <= 0n || input.channel.settledMicros < input.claimMicros) {
    return {
      ok: false,
      code: 'unwind-mismatch',
      detail: `cannot unwind ${input.claimMicros} micros from a channel that has settled ${input.channel.settledMicros}`,
    };
  }
  const claimed = new Set(input.voucherDigests);
  const remaining = input.channel.claimedVoucherDigests.filter((digest) => !claimed.has(digest));
  if (input.channel.claimedVoucherDigests.length - remaining.length !== claimed.size) {
    return {
      ok: false,
      code: 'unwind-mismatch',
      detail: 'the channel does not hold every voucher digest this batch claimed',
    };
  }
  if (input.priorCumulativeMicros > input.channel.lastCumulativeMicros) {
    return {
      ok: false,
      code: 'unwind-mismatch',
      detail: 'prior cumulative claim is above the channel current cumulative claim',
    };
  }
  return {
    ok: true,
    channel: {
      ...input.channel,
      settledMicros: input.channel.settledMicros - input.claimMicros,
      lastCumulativeMicros: input.priorCumulativeMicros,
      claimedVoucherDigests: remaining,
    },
  };
}

export type SettlementFreeze =
  | { readonly frozen: false }
  | { readonly frozen: true; readonly reason: 'dispute' | 'reorg'; readonly detail: string };

/**
 * Whether a channel may submit a NEW batch, given its existing ones.
 *
 * An open dispute freezes settlement outright. A reorg freezes it only until
 * the unwind has run — `recovered` is the distinction, because a detected but
 * un-recovered reorg has left the channel's watermark advanced past vouchers
 * that were never actually paid, and claiming on top of that state would
 * settle an ordering the chain has already disagreed with.
 */
export function isSettlementFrozen(
  batches: readonly { readonly state: SettlementLifecycleState; readonly recovered?: boolean }[],
): SettlementFreeze {
  for (const batch of batches) {
    if (batch.state === 'disputed') {
      return { frozen: true, reason: 'dispute', detail: 'a settlement batch on this channel is disputed' };
    }
  }
  for (const batch of batches) {
    if (batch.state === 'reorged' && batch.recovered !== true) {
      return {
        frozen: true,
        reason: 'reorg',
        detail: 'a settlement batch on this channel was reorged and has not been recovered',
      };
    }
  }
  return { frozen: false };
}

/**
 * Project a settled batch into the P-016 commerce event log as a
 * `settlement-proof`.
 *
 * The event id and idempotency key are derived from the request hash AND the
 * finality, so the `claimed` proof and the later `final` proof are two distinct,
 * individually idempotent facts — replaying either cannot inflate the stream,
 * and a consumer can see the claim before finality is known.
 *
 * The caller signs the returned bytes (`commerceEventSigningBytes`); this
 * module never holds a key.
 */
export function buildSettlementProofEvent(input: {
  readonly streamId: string;
  readonly issuer: string;
  readonly sequence: number;
  readonly occurredAtMs: number;
  readonly plan: BatchSettlementPlan;
  readonly finality: 'claimed' | 'final';
  readonly confirmations: number;
  readonly chainId: number;
  readonly transaction: EvmTransactionReceipt;
}): Omit<CommerceEvent, 'signature'> {
  const allocations: Record<string, string> = {};
  for (const share of REVENUE_SHARES) {
    allocations[share] = input.plan.receipt.allocationsMicros[share].toString();
  }
  return {
    eventId: `settlement:${input.plan.request.requestHash}:${input.finality}`,
    streamId: input.streamId,
    kind: 'settlement-proof',
    version: 1,
    issuer: input.issuer,
    sequence: input.sequence,
    occurredAtMs: input.occurredAtMs,
    idempotencyKey: `settlement:${input.plan.request.requestHash}:${input.finality}`,
    payload: {
      channelId: input.plan.request.channelId,
      chainId: input.chainId,
      settlementContract: input.plan.request.to,
      stablecoin: input.plan.request.stablecoin,
      requestHash: input.plan.request.requestHash,
      claimMicros: input.plan.claimMicros.toString(),
      cumulativeClaimMicros: input.plan.cumulativeClaimMicros.toString(),
      voucherDigests: [...input.plan.voucherDigests],
      transactionHash: input.transaction.transactionHash,
      blockNumber: input.transaction.blockNumber.toString(),
      blockHash: input.transaction.blockHash,
      // The whole point of acceptance line 14: a consumer reads finality here,
      // and `final: false` means the money is claimed but not yet received.
      finality: input.finality,
      final: input.finality === 'final',
      confirmations: input.confirmations,
      settlementId: input.plan.receipt.settlementId,
      splitManifestHash: input.plan.receipt.splitManifestHash,
      providerCostMicros: input.plan.receipt.providerCostMicros.toString(),
      distributableMicros: input.plan.receipt.distributableMicros.toString(),
      allocationsMicros: allocations,
      daoTreasury: input.plan.receipt.daoTreasury,
      receiptHash: input.plan.receipt.receiptHash,
    },
  };
}
