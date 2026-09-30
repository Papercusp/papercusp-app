/**
 * The escrow authority — the Worker + chain half of D-055 (P-036).
 *
 * WHY THIS MODULE EXISTS, AND WHAT IT DELIBERATELY IS NOT
 *
 * D-055 splits the system in two: the hive log is authoritative for governance
 * and distribution ONLY, and commerce facts live behind the Worker and on
 * chain. P-036 is the end-to-end proof of that split across two REAL peer
 * processes, and it turns on a distinction that is easy to collapse:
 *
 *   - `reduceCommerceEvents` (the hive-log reducer) decides which FACTS the
 *     federated log carries. It quarantines events that contradict each other
 *     structurally — the same stream sequence, or the same issuer idempotency
 *     key, claimed by two different facts.
 *   - THIS module decides which of those facts get PAID. It cannot be the log
 *     reducer, because a double-spend is not a structural contradiction: two
 *     buyer machines that each issue a cumulative voucher against one channel
 *     while partitioned produce two individually well-formed events with
 *     distinct ids, distinct sequences and distinct idempotency keys. The
 *     reducer accepts BOTH — correctly, they are both real facts about what
 *     each machine did — and the escrow is what refuses the second.
 *
 * Conflating those layers is the specific error P-036 exists to catch. A system
 * that trusted the log to reject the double-spend would over-pay the moment two
 * machines went offline; a system that trusted the escrow to reject a forked
 * fact would lose the audit trail of the fork.
 *
 * DETERMINISM. Both peers must reach the SAME verdict from the same converged
 * log without talking to each other, so the adjudication order cannot be
 * arrival order. `canonicalClaimOrder` fixes a total order carried entirely in
 * the data (occurrence time, then voucher digest), and every consumer folds in
 * that order.
 *
 * REUSE. `settleVoucherBatch` is the authority on which vouchers may be claimed
 * — the duplicate, monotonicity, expiry, signature and escrow refusals all live
 * there, as `planBatchSettlement`'s own comment says — so this module composes
 * it one claim at a time and CLASSIFIES its refusals; it re-implements none of
 * the arithmetic.
 */
import {
  paymentVoucherDigest,
  unsignedVoucher,
  type CumulativePaymentVoucher,
} from '../microcharge';
import {
  settleVoucherBatch,
  type ChannelRefusalCode,
  type PaymentChannelState,
} from '../payment-channel';
import type { CommerceEvent } from '../commerce-events';

/**
 * One usage claim as it reached a peer over the federated log.
 *
 * `issuerMachine` is the BUYER MACHINE that minted the voucher, not the payer:
 * the double-spend case is one payer identity on two machines, so the payer is
 * identical on both sides of the fork and only the machine tells them apart.
 */
export interface FederatedUsageClaim {
  readonly eventId: string;
  readonly issuerMachine: string;
  readonly voucher: CumulativePaymentVoucher;
  readonly occurredAtMs: number;
}

/**
 * Why a claim did not become money.
 *
 * `duplicate` is benign and idempotent (the same voucher reached this peer
 * twice, which is the normal shape of a healed partition). `double-spend` is
 * the adversarial case: a DIFFERENT machine's voucher that the escrow cannot
 * honour on top of what has already been admitted.
 */
export type ClaimDisposition =
  | {
      readonly state: 'admitted';
      readonly eventId: string;
      readonly issuerMachine: string;
      readonly voucherDigest: string;
      /** What THIS claim adds to the channel, in micros (decimal string). */
      readonly claimMicros: string;
    }
  | {
      readonly state: 'duplicate';
      readonly eventId: string;
      readonly issuerMachine: string;
      readonly voucherDigest: string;
      readonly detail: string;
    }
  | {
      readonly state: 'double-spend';
      readonly eventId: string;
      readonly issuerMachine: string;
      readonly voucherDigest: string;
      readonly code: ChannelRefusalCode;
      readonly detail: string;
      /** The machine whose already-admitted claims this one collides with. */
      readonly collidesWithMachine: string;
    }
  | {
      readonly state: 'rejected';
      readonly eventId: string;
      readonly issuerMachine: string;
      readonly voucherDigest: string;
      readonly code: ChannelRefusalCode;
      readonly detail: string;
    };

export interface EscrowAdjudication {
  /** Channel state after every admitted claim — the claim-proof input. */
  readonly channel: PaymentChannelState;
  /** Dispositions in canonical order; one per input claim. */
  readonly dispositions: readonly ClaimDisposition[];
  /** Vouchers the escrow will pay for, in canonical order. */
  readonly admittedVouchers: readonly CumulativePaymentVoucher[];
  readonly admittedMicros: string;
  readonly escrowRemainingMicros: string;
  /** The double-spend subset, hoisted so a caller cannot miss it. */
  readonly doubleSpend: readonly ClaimDisposition[];
}

/**
 * Total order over claims, derived only from the claims themselves.
 *
 * Arrival order is NOT usable: two peers observe the same fork in opposite
 * orders after a partition heals, and an arrival-ordered fold would have them
 * pay different machines. Occurrence time is the intended economic order;
 * the voucher digest breaks ties so the order is total even when two machines
 * stamp the same millisecond, and the event id breaks a digest tie so a
 * re-federated copy of one voucher cannot reorder the fold.
 */
export function canonicalClaimOrder(
  claims: readonly FederatedUsageClaim[],
): FederatedUsageClaim[] {
  return [...claims].sort((a, b) => {
    if (a.occurredAtMs !== b.occurredAtMs) return a.occurredAtMs - b.occurredAtMs;
    const da = paymentVoucherDigest(unsignedVoucher(a.voucher));
    const db = paymentVoucherDigest(unsignedVoucher(b.voucher));
    if (da !== db) return da < db ? -1 : 1;
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  });
}

/** Refusals that mean "the escrow cannot cover this on top of what it already owes". */
const DOUBLE_SPEND_CODES: ReadonlySet<ChannelRefusalCode> = new Set([
  'escrow-exhausted',
  'non-monotonic',
]);

/**
 * Fold every federated claim for ONE channel through the escrow.
 *
 * Pure and deterministic: the same converged claim set produces the same
 * verdict on every peer, which is what lets two machines that never spoke
 * agree on who got paid.
 *
 * A refusal is classified as a DOUBLE-SPEND rather than a plain rejection when
 * it is an escrow/monotonicity refusal raised against a machine OTHER than the
 * one whose claims already moved the channel head. That distinction matters:
 * the same `escrow-exhausted` code from a single machine over-drawing its own
 * channel is a budgeting error, while the cross-machine case is the fork this
 * item is about, and reporting them identically would hide it.
 */
export function adjudicateEscrowClaims(input: {
  readonly channel: PaymentChannelState;
  readonly claims: readonly FederatedUsageClaim[];
  readonly nowMs: number;
  readonly verifySignature?: (voucher: CumulativePaymentVoucher) => boolean;
  readonly disputed?: boolean;
}): EscrowAdjudication {
  const ordered = canonicalClaimOrder(input.claims);
  const dispositions: ClaimDisposition[] = [];
  const admittedVouchers: CumulativePaymentVoucher[] = [];
  const seenDigests = new Set<string>();
  let channel = input.channel;
  let admittedMicros = 0n;
  /** The machine that most recently moved the channel head — the collision partner. */
  let headMachine = '';

  for (const claim of ordered) {
    const voucherDigest = paymentVoucherDigest(unsignedVoucher(claim.voucher));

    // A voucher this peer has already folded is idempotent, not a refusal. The
    // channel's own `duplicate-claim` would say the same thing, but only after
    // the digest is recorded; the local set also covers a duplicate that arrives
    // before its original is admitted.
    if (seenDigests.has(voucherDigest)) {
      dispositions.push({
        state: 'duplicate',
        eventId: claim.eventId,
        issuerMachine: claim.issuerMachine,
        voucherDigest,
        detail: `voucher '${claim.voucher.usageNonce}' was already folded into this channel`,
      });
      continue;
    }

    const settled = settleVoucherBatch({
      channel,
      vouchers: [claim.voucher],
      nowMs: input.nowMs,
      verifySignature: input.verifySignature,
      disputed: input.disputed,
    });

    if (settled.ok) {
      seenDigests.add(voucherDigest);
      channel = settled.channel;
      admittedMicros += settled.claimMicros;
      headMachine = claim.issuerMachine;
      admittedVouchers.push(claim.voucher);
      dispositions.push({
        state: 'admitted',
        eventId: claim.eventId,
        issuerMachine: claim.issuerMachine,
        voucherDigest,
        claimMicros: settled.claimMicros.toString(),
      });
      continue;
    }

    if (settled.code === 'duplicate-claim') {
      dispositions.push({
        state: 'duplicate',
        eventId: claim.eventId,
        issuerMachine: claim.issuerMachine,
        voucherDigest,
        detail: settled.detail,
      });
      continue;
    }

    if (DOUBLE_SPEND_CODES.has(settled.code) && headMachine && headMachine !== claim.issuerMachine) {
      dispositions.push({
        state: 'double-spend',
        eventId: claim.eventId,
        issuerMachine: claim.issuerMachine,
        voucherDigest,
        code: settled.code,
        detail: settled.detail,
        collidesWithMachine: headMachine,
      });
      continue;
    }

    dispositions.push({
      state: 'rejected',
      eventId: claim.eventId,
      issuerMachine: claim.issuerMachine,
      voucherDigest,
      code: settled.code,
      detail: settled.detail,
    });
  }

  const remaining = channel.escrowMicros - channel.settledMicros;
  return {
    channel,
    dispositions,
    admittedVouchers,
    admittedMicros: admittedMicros.toString(),
    escrowRemainingMicros: (remaining > 0n ? remaining : 0n).toString(),
    doubleSpend: dispositions.filter((d) => d.state === 'double-spend'),
  };
}

/**
 * Read the usage claims a converged commerce-event batch carries.
 *
 * The input is `reduceCommerceEvents(...).accepted` — facts the LOG agreed on.
 * What comes back is what the ESCROW must now judge, which is a strictly
 * smaller set: an accepted `usage-receipt` whose payload does not carry a
 * well-formed voucher is reported in `unusable` rather than silently dropped,
 * because a claim the authority never saw is indistinguishable from a claim it
 * refused, and only one of those is a bug.
 */
export function readUsageClaims(accepted: readonly CommerceEvent[]): {
  readonly claims: readonly FederatedUsageClaim[];
  readonly unusable: ReadonlyArray<{ readonly eventId: string; readonly reason: string }>;
} {
  const claims: FederatedUsageClaim[] = [];
  const unusable: Array<{ eventId: string; reason: string }> = [];
  for (const event of accepted) {
    if (event.kind !== 'usage-receipt') continue;
    const voucher = readVoucher(event.payload);
    if (!voucher) {
      unusable.push({
        eventId: event.eventId,
        reason: 'usage-receipt carries no well-formed cumulative voucher, so the escrow cannot judge it',
      });
      continue;
    }
    const machine = readText(event.payload, 'issuerMachine') ?? event.issuer;
    claims.push({
      eventId: event.eventId,
      issuerMachine: machine,
      voucher,
      occurredAtMs: event.occurredAtMs,
    });
  }
  return { claims, unusable };
}

/**
 * Build the `usage-receipt` commerce event a buyer machine federates.
 *
 * The payload carries BOTH representations on purpose: `amountMicros` is what
 * `perUseRollup` folds into `claimedMicros` (money claimed, never money
 * received), and the `voucher` block is what the escrow authority adjudicates.
 * Deriving the id and idempotency key from the voucher digest makes the fact
 * idempotent under re-federation, so a partition heal that re-delivers the same
 * receipt cannot inflate the claimed column.
 *
 * The caller signs `commerceEventSigningBytes(...)`; this module holds no key.
 */
export function buildUsageReceiptEvent(input: {
  readonly streamId: string;
  readonly issuer: string;
  readonly issuerMachine: string;
  readonly sequence: number;
  readonly occurredAtMs: number;
  readonly voucher: CumulativePaymentVoucher;
  /** What this receipt claims, in micros. Defaults to the voucher's cumulative claim. */
  readonly amountMicros?: bigint;
}): Omit<CommerceEvent, 'signature'> {
  const digest = paymentVoucherDigest(unsignedVoucher(input.voucher));
  const amount = input.amountMicros ?? input.voucher.cumulativeClaimMicros;
  return {
    eventId: `usage:${digest}`,
    streamId: input.streamId,
    kind: 'usage-receipt',
    version: 1,
    issuer: input.issuer,
    sequence: input.sequence,
    occurredAtMs: input.occurredAtMs,
    idempotencyKey: `usage:${digest}`,
    payload: {
      channelId: input.voucher.channelId,
      releaseRef: input.voucher.releaseRef,
      payer: input.voucher.payer,
      seller: input.voucher.seller,
      issuerMachine: input.issuerMachine,
      amountMicros: amount.toString(),
      voucherDigest: digest,
      voucher: {
        channelId: input.voucher.channelId,
        payer: input.voucher.payer,
        seller: input.voucher.seller,
        releaseRef: input.voucher.releaseRef,
        usageNonce: input.voucher.usageNonce,
        meterQuantity: input.voucher.meterQuantity.toString(),
        pricePerUnitMicros: input.voucher.pricePerUnitMicros.toString(),
        priceVersion: input.voucher.priceVersion,
        splitManifestHash: input.voucher.splitManifestHash,
        expiresAtMs: input.voucher.expiresAtMs,
        cumulativeClaimMicros: input.voucher.cumulativeClaimMicros.toString(),
        signature: input.voucher.signature,
      },
    },
  };
}

// ------------------------------------------------------------------ helpers

function readText(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Parse a decimal-string integer back to micros. Rejects anything else. */
function readMicros(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

function readVoucher(payload: Readonly<Record<string, unknown>>): CumulativePaymentVoucher | null {
  const raw = payload.voucher;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const meterQuantity = readMicros(v.meterQuantity);
  const pricePerUnitMicros = readMicros(v.pricePerUnitMicros);
  const cumulativeClaimMicros = readMicros(v.cumulativeClaimMicros);
  if (meterQuantity === null || pricePerUnitMicros === null || cumulativeClaimMicros === null) {
    return null;
  }
  const strings = ['channelId', 'payer', 'seller', 'releaseRef', 'usageNonce', 'priceVersion', 'splitManifestHash', 'signature'] as const;
  const text: Partial<Record<(typeof strings)[number], string>> = {};
  for (const key of strings) {
    const value = v[key];
    if (typeof value !== 'string' || !value.trim()) return null;
    text[key] = value;
  }
  if (typeof v.expiresAtMs !== 'number' || !Number.isFinite(v.expiresAtMs)) return null;
  return {
    channelId: text.channelId!,
    payer: text.payer!,
    seller: text.seller!,
    releaseRef: text.releaseRef!,
    usageNonce: text.usageNonce!,
    meterQuantity,
    pricePerUnitMicros,
    priceVersion: text.priceVersion!,
    splitManifestHash: text.splitManifestHash!,
    expiresAtMs: v.expiresAtMs,
    cumulativeClaimMicros,
    signature: text.signature!,
  };
}
