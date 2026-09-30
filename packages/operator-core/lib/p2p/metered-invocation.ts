/**
 * Metering interception on every billable unit (shared-pot DAO plan P-031).
 *
 * P-020 (`microcharge.ts`) owns the ARITHMETIC and the refusal semantics —
 * duplicate nonce, cumulative regression, cap exhaustion, expiry, and the
 * settle-side reservation ceiling. This module owns the INTERCEPTION: it turns
 * a per-use offer's published terms (P-028 `PerUseOfferTerms`) plus ONE
 * billable unit into the cumulative voucher that is reserved BEFORE execution
 * and the `SignedUsageReceipt` that is settled AFTER it, then records the
 * served units on the P-205 metering ledger.
 *
 * Every field P-031 requires a voucher to bind — payer, seller/host, release,
 * nonce, quantity, price version, split-manifest hash — is a
 * `CumulativePaymentVoucher` field, so the binding is STRUCTURAL: a caller
 * cannot forget one and still produce a voucher.
 *
 * Pure by construction: no IO, no clock, no signing key. The caller injects
 * `nowMs` and the two signers, so the same core runs at the hosted Worker door,
 * in the BYOC honor path (`byoc-execution.ts`, P-017), and in tests.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import {
  paymentVoucherDigest,
  paymentVoucherSigningBytes,
  reserveMicrocharge,
  settleMicrocharge,
  unsignedVoucher,
  type CumulativePaymentVoucher,
  type MicrochargeChannel,
  type MicrochargeRefusalCode,
  type SignedUsageReceipt,
} from './microcharge';
import { recordContribution, recordSpend, type MeteringLedger } from './metering-ledger';
import type { BudgetAxis, BudgetUnit } from './offer-budget';

/** A `sha256:<64 hex>` split-manifest hash, exactly as `cupboard:publish-offer` accepts it. */
const SPLIT_MANIFEST_HASH = /^sha256:[0-9a-f]{64}$/i;

/**
 * The declared meter for a per-use item: the price terms every voucher for it
 * is signed against. Amounts are bigint micro-units so a tiny per-call charge
 * never passes through floating point.
 */
export interface MeterDeclaration {
  readonly meterUnit: string;
  readonly unitPriceMicros: bigint;
  readonly priceVersion: string;
  readonly splitManifestHash: string;
}

/**
 * The published shape of the terms, as the D1/JSON boundary carries them
 * (`PerUseOfferTerms.unitPriceMicros` is a safe integer there). Accepting the
 * bigint form too lets an in-process caller skip the round trip.
 */
export interface PerUseTermsInput {
  readonly unitPriceMicros: number | bigint;
  readonly meterUnit: string;
  readonly priceVersion: string;
  readonly splitManifestHash: string;
}

/** One billable unit of work, named before it is executed. */
export interface BillableUnit {
  readonly payer: string;
  /** The seller of the item, which on the honor path is also the serving host. */
  readonly seller: string;
  readonly releaseRef: string;
  readonly usageNonce: string;
  readonly quantity: bigint;
  readonly expiresAtMs: number;
}

/**
 * Where the served units land on the P-205 metering ledger. `axis`/`unit` are
 * the ledger's own vocabulary; `meterUnit` on the declaration is the seller's
 * display name for the same thing and is NOT interchangeable with it.
 */
export interface ServedUnitsBinding {
  readonly hostRef: string;
  readonly fleetSlug: string;
  readonly axis: BudgetAxis;
  readonly unit: BudgetUnit;
  /** M22: credit the served units to an attested user when one is known. */
  readonly attestedUserId?: string;
  readonly perUserContributionCap?: number | null;
}

export type MeteredRefusalCode =
  | MicrochargeRefusalCode
  | 'invalid-meter'
  | 'invalid-unit'
  | 'unsigned-voucher'
  | 'unsigned-receipt'
  | 'terms-mismatch'
  | 'metering-refused';

export interface MeteredRefusal {
  readonly ok: false;
  readonly code: MeteredRefusalCode;
  readonly detail: string;
}

const refuse = (code: MeteredRefusalCode, detail: string): MeteredRefusal => ({ ok: false, code, detail });

export type MeterDeclarationResult = { readonly ok: true; readonly meter: MeterDeclaration } | MeteredRefusal;

/**
 * Validate published per-use terms into a declared meter.
 *
 * This is the "declare a meter" half of P-031's interception point: a door that
 * cannot produce a `MeterDeclaration` must refuse the invocation rather than
 * execute an unpriced billable unit.
 */
export function declareMeter(terms: PerUseTermsInput): MeterDeclarationResult {
  const { meterUnit, priceVersion, splitManifestHash } = terms;
  if (!meterUnit.trim()) return refuse('invalid-meter', 'meterUnit is required');
  if (!priceVersion.trim()) return refuse('invalid-meter', 'priceVersion is required');
  if (!SPLIT_MANIFEST_HASH.test(splitManifestHash)) {
    return refuse('invalid-meter', 'splitManifestHash must be sha256:<64 hex>');
  }
  const raw = terms.unitPriceMicros;
  if (typeof raw === 'number' && !Number.isSafeInteger(raw)) {
    return refuse('invalid-meter', 'unitPriceMicros must be a safe integer');
  }
  const unitPriceMicros = BigInt(raw);
  if (unitPriceMicros <= 0n) {
    return refuse('invalid-meter', 'unitPriceMicros must be positive — a zero-price item is a free offer, not a metered one');
  }
  return { ok: true, meter: { meterUnit, unitPriceMicros, priceVersion, splitManifestHash } };
}

/** The micro-unit price of `quantity` units under this meter. */
export function quoteMicros(meter: MeterDeclaration, quantity: bigint): bigint {
  return meter.unitPriceMicros * quantity;
}

/**
 * Build the unsigned cumulative voucher for one billable unit.
 *
 * The claim is CUMULATIVE — the channel's last claim plus this unit's price —
 * which is what makes a replayed or reordered voucher detectable by
 * `reserveMicrocharge`'s monotonicity check rather than by convention here.
 */
export function buildUsageVoucher(
  channel: MicrochargeChannel,
  meter: MeterDeclaration,
  unit: BillableUnit,
): Omit<CumulativePaymentVoucher, 'signature'> {
  return {
    channelId: channel.channelId,
    payer: unit.payer,
    seller: unit.seller,
    releaseRef: unit.releaseRef,
    usageNonce: unit.usageNonce,
    meterQuantity: unit.quantity,
    pricePerUnitMicros: meter.unitPriceMicros,
    priceVersion: meter.priceVersion,
    splitManifestHash: meter.splitManifestHash,
    expiresAtMs: unit.expiresAtMs,
    cumulativeClaimMicros: channel.lastCumulativeMicros + quoteMicros(meter, unit.quantity),
  };
}

function receiptJson(receipt: Omit<SignedUsageReceipt, 'signature'>): Record<string, unknown> {
  return {
    amountMicros: receipt.amountMicros.toString(),
    channelId: receipt.channelId,
    meterQuantity: receipt.meterQuantity.toString(),
    occurredAtMs: receipt.occurredAtMs,
    usageNonce: receipt.usageNonce,
    voucherDigest: receipt.voucherDigest,
  };
}

/** Canonical signing bytes for a usage receipt, mirroring the voucher's own scheme. */
export function usageReceiptSigningBytes(receipt: Omit<SignedUsageReceipt, 'signature'>): Buffer {
  return Buffer.from(canonicalJson(receiptJson(receipt)), 'utf8');
}

export function usageReceiptDigest(receipt: Omit<SignedUsageReceipt, 'signature'>): string {
  return createHash('sha256').update(usageReceiptSigningBytes(receipt)).digest('hex');
}

export interface OpenMeteredInvocationInput {
  readonly channel: MicrochargeChannel;
  readonly meter: MeterDeclaration;
  readonly unit: BillableUnit;
  readonly nowMs: number;
  /** Returns the payer's signature over the voucher's canonical bytes. */
  readonly signVoucher: (bytes: Buffer) => string;
}

export type OpenMeteredInvocationResult =
  | {
      readonly ok: true;
      readonly channel: MicrochargeChannel;
      readonly voucher: CumulativePaymentVoucher;
      readonly reservedMicros: bigint;
    }
  | MeteredRefusal;

function validateUnit(unit: BillableUnit): MeteredRefusal | null {
  if (!unit.payer.trim()) return refuse('invalid-unit', 'payer is required');
  if (!unit.seller.trim()) return refuse('invalid-unit', 'seller is required');
  if (!unit.releaseRef.trim()) return refuse('invalid-unit', 'releaseRef is required');
  if (!unit.usageNonce.trim()) return refuse('invalid-unit', 'usageNonce is required');
  if (unit.quantity <= 0n) return refuse('invalid-unit', 'quantity must be positive');
  if (unit.quantity > BigInt(Number.MAX_SAFE_INTEGER)) {
    return refuse('invalid-unit', 'quantity exceeds the safe-integer range the metering ledger records in');
  }
  if (!Number.isFinite(unit.expiresAtMs)) return refuse('invalid-unit', 'expiresAtMs must be finite');
  return null;
}

/**
 * INTERCEPTION POINT — call this BEFORE executing the billable unit.
 *
 * Reserving first is the whole point: a unit that would exhaust the cap or
 * replay a nonce is refused while refusing is still free, instead of being
 * discovered after the seller has already paid to serve it.
 */
export function openMeteredInvocation(input: OpenMeteredInvocationInput): OpenMeteredInvocationResult {
  const invalid = validateUnit(input.unit);
  if (invalid) return invalid;
  const unsigned = buildUsageVoucher(input.channel, input.meter, input.unit);
  const signature = input.signVoucher(paymentVoucherSigningBytes(unsigned));
  if (typeof signature !== 'string' || !signature.trim()) {
    return refuse('unsigned-voucher', 'the payer signer returned no signature for the cumulative voucher');
  }
  const voucher: CumulativePaymentVoucher = { ...unsigned, signature };
  const reserved = reserveMicrocharge(input.channel, voucher, input.nowMs);
  if (!reserved.ok) return refuse(reserved.code, reserved.detail);
  return { ok: true, channel: reserved.channel, voucher, reservedMicros: reserved.deltaMicros };
}

export interface AcceptMeteredVoucherInput {
  readonly channel: MicrochargeChannel;
  readonly meter: MeterDeclaration;
  readonly unit: BillableUnit;
  /** The voucher as the PAYER signed it, arriving over the wire. */
  readonly voucher: CumulativePaymentVoucher;
  readonly nowMs: number;
  /** Cryptographic verification of the payer signature; defaults to presence. */
  readonly verifySignature?: (voucher: CumulativePaymentVoucher) => boolean;
}

/**
 * INTERCEPTION POINT for a voucher the caller did NOT build.
 *
 * A hosted door never holds the payer's signing key, so it receives a signed
 * voucher instead of producing one. That makes the voucher ATTACKER-CONTROLLED:
 * its cumulative claim, its price terms and its quantity are all assertions
 * until checked here. Every one of them is re-derived from the DECLARED meter
 * and the named unit, and the cumulative claim is then handed to
 * `reserveMicrocharge`, whose monotonicity guard is what refuses a REPLAYED or
 * REGRESSED claim from a stale (or malicious) client view of the channel.
 */
export function acceptMeteredVoucher(input: AcceptMeteredVoucherInput): OpenMeteredInvocationResult {
  const invalid = validateUnit(input.unit);
  if (invalid) return invalid;
  const expected = buildUsageVoucher(input.channel, input.meter, input.unit);
  const v = input.voucher;
  if (v.channelId !== expected.channelId) return refuse('channel-mismatch', 'voucher channel does not match the local payment channel');
  if (v.payer !== expected.payer) return refuse('terms-mismatch', 'voucher payer does not match the billed unit');
  if (v.seller !== expected.seller) return refuse('terms-mismatch', 'voucher seller does not match the billed unit');
  if (v.releaseRef !== expected.releaseRef) return refuse('terms-mismatch', 'voucher releaseRef does not match the billed unit');
  if (v.usageNonce !== expected.usageNonce) return refuse('terms-mismatch', 'voucher usageNonce does not match the billed unit');
  if (v.meterQuantity !== expected.meterQuantity) return refuse('terms-mismatch', 'voucher meterQuantity does not match the billed unit');
  if (v.pricePerUnitMicros !== expected.pricePerUnitMicros) return refuse('terms-mismatch', 'voucher price does not match the declared meter');
  if (v.priceVersion !== expected.priceVersion) return refuse('terms-mismatch', 'voucher priceVersion does not match the declared meter');
  if (v.splitManifestHash !== expected.splitManifestHash) return refuse('terms-mismatch', 'voucher splitManifestHash does not match the declared meter');
  if (!v.signature.trim()) return refuse('unsigned-voucher', 'the cumulative voucher carries no payer signature');
  const verify = input.verifySignature ?? ((candidate: CumulativePaymentVoucher) => candidate.signature.trim().length > 0);
  if (!verify(v)) return refuse('invalid-voucher', 'the payer signature failed verification');
  const reserved = reserveMicrocharge(input.channel, v, input.nowMs);
  if (!reserved.ok) return refuse(reserved.code, reserved.detail);
  return { ok: true, channel: reserved.channel, voucher: v, reservedMicros: reserved.deltaMicros };
}

export interface CloseMeteredInvocationInput {
  readonly channel: MicrochargeChannel;
  readonly voucher: CumulativePaymentVoucher;
  /** Units actually served; defaults to the reserved quantity. Never more. */
  readonly actualQuantity?: bigint;
  readonly occurredAtMs: number;
  /** Returns the seller/host signature over the receipt's canonical bytes. */
  readonly signReceipt: (bytes: Buffer) => string;
  /** Record the served units on the P-205 ledger as part of the same settlement. */
  readonly metering?: {
    readonly ledger: MeteringLedger;
    readonly served: ServedUnitsBinding;
  };
}

export type CloseMeteredInvocationResult =
  | {
      readonly ok: true;
      readonly channel: MicrochargeChannel;
      readonly receipt: SignedUsageReceipt;
      readonly amountMicros: bigint;
      /** Present only when `metering` was supplied. */
      readonly metering?: MeteringLedger;
      readonly contributionCredited: number;
    }
  | MeteredRefusal;

/**
 * INTERCEPTION POINT — call this AFTER the billable unit has been executed.
 *
 * Settling with the ACTUAL quantity releases the unused part of the reservation
 * back to the channel, so a unit that reserved ten and served three does not
 * strand the other seven.
 */
export function closeMeteredInvocation(input: CloseMeteredInvocationInput): CloseMeteredInvocationResult {
  const served = input.actualQuantity ?? input.voucher.meterQuantity;
  if (served <= 0n) return refuse('invalid-unit', 'actualQuantity must be positive');
  if (served > input.voucher.meterQuantity) {
    return refuse('actual-exceeds-reservation', `served ${served} exceeds the reserved quantity ${input.voucher.meterQuantity}`);
  }
  if (!Number.isFinite(input.occurredAtMs)) return refuse('invalid-unit', 'occurredAtMs must be finite');
  const amountMicros = input.voucher.pricePerUnitMicros * served;
  const unsignedReceipt: Omit<SignedUsageReceipt, 'signature'> = {
    channelId: input.channel.channelId,
    usageNonce: input.voucher.usageNonce,
    meterQuantity: served,
    amountMicros,
    voucherDigest: paymentVoucherDigest(unsignedVoucher(input.voucher)),
    occurredAtMs: input.occurredAtMs,
  };
  const receiptSignature = input.signReceipt(usageReceiptSigningBytes(unsignedReceipt));
  if (typeof receiptSignature !== 'string' || !receiptSignature.trim()) {
    return refuse('unsigned-receipt', 'the seller signer returned no signature for the usage receipt');
  }

  const settled = settleMicrocharge({
    channel: input.channel,
    voucher: input.voucher,
    actualAmountMicros: amountMicros,
    actualMeterQuantity: served,
    occurredAtMs: input.occurredAtMs,
    receiptSignature,
  });
  if (!settled.ok) return refuse(settled.code, settled.detail);

  if (!input.metering) {
    return { ok: true, channel: settled.channel, receipt: settled.receipt, amountMicros, contributionCredited: 0 };
  }

  // The served QUANTITY (not the money) is what the metering ledger counts —
  // it is a capacity ledger, and `served`'s unit is the binding's BudgetUnit.
  const amount = Number(served);
  const spend = recordSpend(input.metering.ledger, {
    hostRef: input.metering.served.hostRef,
    fleetSlug: input.metering.served.fleetSlug,
    axis: input.metering.served.axis,
    amount,
    unit: input.metering.served.unit,
  });
  if (!spend.ok) return refuse('metering-refused', `${spend.code}: metering ledger refused the served units`);
  let ledger = spend.ledger;
  let contributionCredited = 0;
  if (input.metering.served.attestedUserId) {
    const contribution = recordContribution(ledger, {
      attestedUserId: input.metering.served.attestedUserId,
      axis: input.metering.served.axis,
      amount,
      unit: input.metering.served.unit,
      perUserCap: input.metering.served.perUserContributionCap ?? null,
    });
    if (!contribution.ok) return refuse('metering-refused', `${contribution.code}: metering ledger refused the contribution credit`);
    ledger = contribution.ledger;
    contributionCredited = contribution.credited;
  }
  return {
    ok: true,
    channel: settled.channel,
    receipt: settled.receipt,
    amountMicros,
    metering: ledger,
    contributionCredited,
  };
}
