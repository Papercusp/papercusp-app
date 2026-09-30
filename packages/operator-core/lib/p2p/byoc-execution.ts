/**
 * BYOC execution seam (P-017).
 *
 * The caller executes inference/tools on the customer's or host's local
 * credentials. This pure module only performs the control-plane work around
 * that call: billing-mode validation, claim-time lease revalidation, budget
 * reservation/commit, and privacy-preserving metering.
 */
import { commit, createLedger, reserve, type AxisCap, type LedgerState } from './offer-budget';
import { revalidateAtClaim, type ClaimGate, type InferenceLease } from './inference-lease';
import { recordContribution, recordSpend, type MeteringLedger } from './metering-ledger';
import { resolveBillingAuthority, type BillingContext, type BillingMode, type BillingModeSpec } from './billing-matrix';
import {
  closeMeteredInvocation,
  openMeteredInvocation,
  type BillableUnit,
  type MeterDeclaration,
} from './metered-invocation';
import type { CumulativePaymentVoucher, MicrochargeChannel, SignedUsageReceipt } from './microcharge';
import type { BudgetAxis, BudgetUnit } from './offer-budget';

/**
 * P-031: the per-use meter + interception point on the honor path.
 *
 * Supplied only when the executed unit is billable under a per-use offer. When
 * it is absent this module behaves exactly as it did before P-031, so the
 * free/allowance honor path is unchanged.
 */
export interface ByocMicrochargeContext {
  readonly channel: MicrochargeChannel;
  readonly meter: MeterDeclaration;
  readonly unit: BillableUnit;
  readonly nowMs: number;
  readonly signVoucher: (bytes: Buffer) => string;
}

export interface ByocMicrochargeSettlement {
  readonly channel: MicrochargeChannel;
  readonly voucher: CumulativePaymentVoucher;
  /** Units actually served; defaults to the reserved quantity. */
  readonly actualQuantity?: bigint;
  readonly occurredAtMs: number;
  readonly signReceipt: (bytes: Buffer) => string;
}

export interface ByocExecutionContext {
  readonly hostRef: string;
  readonly fleetSlug: string;
  readonly axis: BudgetAxis;
  readonly unit: BudgetUnit;
  readonly billedAmount: number;
  readonly reservationId: string;
  readonly billingMode: BillingMode;
  readonly billingContext?: BillingContext;
  readonly lease?: InferenceLease;
  readonly claimGate?: ClaimGate;
  readonly nowReceiver?: number;
  readonly ownerHighWaterEpoch?: number;
  readonly attestedUserId?: string;
  readonly perUserContributionCap?: number | null;
}

export type ByocPreparationResult =
  | {
      readonly ok: true;
      readonly ledger: LedgerState;
      readonly billing: BillingModeSpec;
      readonly relay: 'local-only';
      /** Present only when a per-use meter was declared for this call (P-031). */
      readonly microcharge?: { readonly channel: MicrochargeChannel; readonly voucher: CumulativePaymentVoucher; readonly reservedMicros: bigint };
    }
  | { readonly ok: false; readonly code: string; readonly detail: string };

/** Reserve a local BYOC call. No inference bytes or credentials enter this API. */
export function prepareByocExecution(input: { budget: LedgerState; context: ByocExecutionContext; microcharge?: ByocMicrochargeContext }): ByocPreparationResult {
  const billing = resolveBillingAuthority(input.context.billingMode, input.context.billingContext);
  if (!billing.ok) return billing;
  if (input.context.lease) {
    if (!input.context.claimGate || input.context.nowReceiver == null || input.context.ownerHighWaterEpoch == null) {
      return { ok: false, code: 'lease_context_missing', detail: 'lease execution requires claimGate, nowReceiver, and ownerHighWaterEpoch' };
    }
    const lease = revalidateAtClaim({ lease: input.context.lease, gate: input.context.claimGate, nowReceiver: input.context.nowReceiver, ownerHighWaterEpoch: input.context.ownerHighWaterEpoch });
    if (!lease.ok) return lease;
  }
  // P-031: the microcharge reservation runs BEFORE the local budget draw so a
  // cap-exhausted or replayed unit is refused while refusing is still free —
  // and because both reservations are pure, a later refusal simply never
  // returns the advanced state, so neither can strand the other.
  let microcharge: { channel: MicrochargeChannel; voucher: CumulativePaymentVoucher; reservedMicros: bigint } | undefined;
  if (input.microcharge) {
    const opened = openMeteredInvocation({
      channel: input.microcharge.channel,
      meter: input.microcharge.meter,
      unit: input.microcharge.unit,
      nowMs: input.microcharge.nowMs,
      signVoucher: input.microcharge.signVoucher,
    });
    if (!opened.ok) return { ok: false, code: opened.code, detail: opened.detail };
    microcharge = { channel: opened.channel, voucher: opened.voucher, reservedMicros: opened.reservedMicros };
  }
  const result = reserve(input.budget, input.context.billedAmount, input.context.reservationId);
  if (!result.ok) return result;
  return { ok: true, ledger: result.state, billing: billing.spec, relay: 'local-only', ...(microcharge ? { microcharge } : {}) };
}

export type ByocSettlementResult =
  | {
      readonly ok: true;
      readonly budget: LedgerState;
      readonly metering: MeteringLedger;
      readonly committedAmount: number;
      readonly contributionCredited: number;
      /** Present only when a per-use meter was settled for this call (P-031). */
      readonly microcharge?: { readonly channel: MicrochargeChannel; readonly receipt: SignedUsageReceipt; readonly amountMicros: bigint };
    }
  | { readonly ok: false; readonly code: string; readonly detail: string };

/**
 * Commit actual local spend and record the host/user metering facts.
 *
 * When `microcharge` is supplied (P-031) the reserved cumulative voucher is
 * settled here too, emitting the SignedUsageReceipt for the units actually
 * served. The served units are NOT recorded on the metering ledger twice: the
 * budget commit above already records them through `recordSpend`.
 */
export function settleByocExecution(input: { budget: LedgerState; metering: MeteringLedger; context: ByocExecutionContext; actualAmount?: number; microcharge?: ByocMicrochargeSettlement }): ByocSettlementResult {
  const committed = commit(input.budget, input.context.reservationId, input.actualAmount);
  if (!committed.ok) return committed;
  const spent = recordSpend(input.metering, { hostRef: input.context.hostRef, fleetSlug: input.context.fleetSlug, axis: input.context.axis, amount: committed.committedAmount, unit: input.context.unit });
  if (!spent.ok) return spent;
  let metering = spent.ledger;
  let contributionCredited = 0;
  if (input.context.attestedUserId) {
    const contribution = recordContribution(metering, { attestedUserId: input.context.attestedUserId, axis: input.context.axis, amount: committed.committedAmount, unit: input.context.unit, perUserCap: input.context.perUserContributionCap ?? null });
    if (!contribution.ok) return contribution;
    metering = contribution.ledger;
    contributionCredited = contribution.credited;
  }
  if (!input.microcharge) {
    return { ok: true, budget: committed.state, metering, committedAmount: committed.committedAmount, contributionCredited };
  }
  const closed = closeMeteredInvocation({
    channel: input.microcharge.channel,
    voucher: input.microcharge.voucher,
    ...(input.microcharge.actualQuantity !== undefined ? { actualQuantity: input.microcharge.actualQuantity } : {}),
    occurredAtMs: input.microcharge.occurredAtMs,
    signReceipt: input.microcharge.signReceipt,
  });
  if (!closed.ok) return { ok: false, code: closed.code, detail: closed.detail };
  return {
    ok: true,
    budget: committed.state,
    metering,
    committedAmount: committed.committedAmount,
    contributionCredited,
    microcharge: { channel: closed.channel, receipt: closed.receipt, amountMicros: closed.amountMicros },
  };
}

/** Convenience constructor for a two-axis offer budget. */
export function createByocBudget(axis: AxisCap): LedgerState {
  return createLedger(axis);
}
