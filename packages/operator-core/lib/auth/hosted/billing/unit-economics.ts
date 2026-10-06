/** Pilot quote arithmetic; extends hosted billing using the existing journal's USD unit.
 * Catalog prices and modeled workloads remain provisional. This does not charge a customer.
 */
import { MICROS_PER_CENT } from '../../../cupboard/money-journal';

export const PILOT_COST_CATEGORIES = [
  'compute', 'persistent-storage', 'external-ip', 'egress',
  'inference-input', 'inference-output', 'cache-read', 'cache-write', 'inference-fees',
  'support', 'platform-overhead',
] as const;
export type PilotCostCategory = (typeof PILOT_COST_CATEGORIES)[number];
export type CostPayer = 'platform' | 'consumption' | 'customer-direct';

export interface CostProvenance {
  readonly evidenceRef: string;
  readonly measuredAtMs: number;
}
export interface PilotCostLine {
  readonly id: string;
  readonly category: PilotCostCategory;
  readonly payer: CostPayer;
  /** Count in the rate's unit: seconds, bytes, tokens or staff minutes, for example. */
  readonly quantity: number;
  readonly unit: string;
  readonly usage: CostProvenance & { readonly kind: 'observed' | 'modeled' };
  /** Null means unpriced, never free. An explicit zero quantity proves no exposure. */
  readonly rate: (CostProvenance & {
    readonly unit: string;
    readonly unitsPerRate: number;
    readonly microsPerRate: number;
    readonly minimumBillableUnits?: number;
    readonly billingIncrementUnits?: number;
    readonly kind: 'provider-billed' | 'measured-labor' | 'catalog' | 'estimate';
  }) | null;
}
export interface PilotPriceSheet {
  readonly version: string;
  readonly asOfMs: number;
  readonly maximumEvidenceAgeMs: number;
  readonly lines: readonly PilotCostLine[];
  readonly platformPriceCents: number;
  readonly consumptionPriceCents: number;
  readonly includedAllowanceMicros: number;
  readonly inferenceMode: 'customer-key' | 'managed';
  readonly overage: 'stop' | 'opt-in';
  readonly paymentFee: (CostProvenance & {
    readonly percentageBps: number;
    readonly fixedCents: number;
    readonly kind: 'merchant-confirmed' | 'catalog' | 'estimate';
  }) | null;
  readonly targetPlatformMarginBps: number;
  readonly targetConsumptionMarginBps: number;
}
export interface PilotMargin {
  readonly revenueMicros: number;
  /** A lower bound when costMicros is null. */
  readonly knownCostMicros: number;
  readonly costMicros: number | null;
  readonly paymentFeeMicros: number | null;
  readonly profitMicros: number | null;
  /** Floor of profit / revenue in basis points; null for zero revenue or incomplete cost. */
  readonly marginBps: number | null;
  readonly targetMet: boolean;
  /** Standalone price floor, including this axis's fees. Fixed transaction fee belongs to platform. */
  readonly minimumPriceCents: number | null;
}
export interface PilotEconomics {
  readonly version: string;
  readonly state: 'incomplete' | 'provisional' | 'measured';
  readonly quoteAllowed: boolean;
  readonly reasons: readonly string[];
  readonly costs: readonly { id: string; category: PilotCostCategory; payer: CostPayer; micros: number | null }[];
  readonly customerDirectKnownCostMicros: number;
  readonly paymentFeeCents: number | null;
  readonly platform: PilotMargin;
  readonly consumption: PilotMargin;
}

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const CENT = BigInt(MICROS_PER_CENT);
const BPS = 10_000n;
const inferenceCategories = new Set<PilotCostCategory>(['inference-input', 'inference-output', 'cache-read', 'cache-write', 'inference-fees']);

function integer(value: number, name: string, minimum = 0): bigint {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`invalid ${name}`);
  return BigInt(value);
}
function safe(value: bigint, name: string): number {
  if (value > MAX || value < -MAX) throw new Error(`overflow ${name}`);
  return Number(value);
}
function ceil(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
function floor(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return numerator < 0n && numerator % denominator !== 0n ? quotient - 1n : quotient;
}
function reference(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`invalid ${name}`);
}
function bps(value: number, name: string): bigint {
  const amount = integer(value, name);
  if (amount >= BPS) throw new Error(`invalid ${name}`);
  return amount;
}

/** Exact fee-aware floor, including the fee's whole-cent rounding. */
function priceFloor(cost: bigint, fixedCents: bigint, feeBps: bigint, targetBps: bigint): number | null {
  if (feeBps + targetBps >= BPS) return null;
  const maximum = MAX / CENT;
  const meets = (price: bigint): boolean => {
    const revenue = price * CENT;
    const fee = price === 0n ? 0n : (ceil(price * feeBps, BPS) + fixedCents) * CENT;
    return (revenue - cost - fee) * BPS >= revenue * targetBps;
  };
  // Ignoring fee rounding gives a proven lower bound. Rounding adds less than
  // one cent, so at most ceil(10000 / denominator) further cents are needed.
  // The predicate can briefly turn false at a fee step: binary search is unsafe.
  const denominator = BPS - feeBps - targetBps;
  const lower = ceil((cost + fixedCents * CENT) * BPS, denominator * CENT);
  const upper = lower + ceil(BPS, denominator);
  for (let price = lower; price <= upper && price <= maximum; price += 1n) {
    if (meets(price)) return safe(price, 'minimum price');
  }
  return null;
}

export function calculatePilotEconomics(sheet: PilotPriceSheet): PilotEconomics {
  reference(sheet.version, 'sheet version');
  integer(sheet.asOfMs, 'as-of time');
  integer(sheet.maximumEvidenceAgeMs, 'evidence age', 1);
  integer(sheet.includedAllowanceMicros, 'finite allowance', 1);
  if (!['customer-key', 'managed'].includes(sheet.inferenceMode)) throw new Error('invalid inference mode');
  if (!['stop', 'opt-in'].includes(sheet.overage)) throw new Error('invalid overage policy');
  const platformCents = integer(sheet.platformPriceCents, 'platform price');
  const consumptionCents = integer(sheet.consumptionPriceCents, 'consumption price');
  const platformRevenue = platformCents * CENT;
  const consumptionRevenue = consumptionCents * CENT;
  safe(platformRevenue + consumptionRevenue, 'total revenue');
  const targets = {
    platform: bps(sheet.targetPlatformMarginBps, 'platform margin target'),
    consumption: bps(sheet.targetConsumptionMarginBps, 'consumption margin target'),
  };
  const sums: Record<CostPayer, bigint> = { platform: 0n, consumption: 0n, 'customer-direct': 0n };
  const complete: Record<CostPayer, boolean> = { platform: true, consumption: true, 'customer-direct': true };
  const reasons: string[] = [];
  let provisional = false;
  const seen = new Set<string>();
  const categories = new Set<PilotCostCategory>();
  const checkProvenance = (provenance: CostProvenance, name: string): void => {
    reference(provenance.evidenceRef, `${name} evidence`);
    integer(provenance.measuredAtMs, `${name} time`);
    if (provenance.measuredAtMs > sheet.asOfMs || sheet.asOfMs - provenance.measuredAtMs > sheet.maximumEvidenceAgeMs) {
      reasons.push(`stale-evidence:${name}`);
      provisional = true;
    }
  };
  const costs = sheet.lines.map((line) => {
    reference(line.id, 'line id');
    if (seen.has(line.id)) throw new Error(`duplicate line ${line.id}`);
    seen.add(line.id);
    if (!(PILOT_COST_CATEGORIES as readonly string[]).includes(line.category)) throw new Error('invalid cost category');
    if (!Object.hasOwn(sums, line.payer)) throw new Error('invalid cost payer');
    if ((line.category === 'support' || line.category === 'platform-overhead') && line.payer !== 'platform') {
      throw new Error('support and overhead belong to platform');
    }
    if (inferenceCategories.has(line.category) && line.payer !== (sheet.inferenceMode === 'customer-key' ? 'customer-direct' : 'consumption')) {
      throw new Error('inference payer disagrees with key policy');
    }
    categories.add(line.category);
    const quantity = integer(line.quantity, `${line.id} quantity`);
    reference(line.unit, `${line.id} unit`);
    if (!['observed', 'modeled'].includes(line.usage.kind)) throw new Error('invalid usage kind');
    checkProvenance(line.usage, `${line.id}:usage`);
    if (line.usage.kind === 'modeled') {
      reasons.push(`modeled-usage:${line.id}`);
      provisional = true;
    }
    let amount: bigint | null = quantity === 0n ? 0n : null;
    if (line.rate !== null) {
      if (line.rate.unit !== line.unit) throw new Error(`unit mismatch ${line.id}`);
      const units = integer(line.rate.unitsPerRate, `${line.id} rate units`, 1);
      const rate = integer(line.rate.microsPerRate, `${line.id} rate`);
      const minimum = integer(line.rate.minimumBillableUnits ?? 0, `${line.id} minimum billable units`);
      const increment = integer(line.rate.billingIncrementUnits ?? 1, `${line.id} billing increment`, 1);
      if (!['provider-billed', 'measured-labor', 'catalog', 'estimate'].includes(line.rate.kind)) throw new Error('invalid rate kind');
      checkProvenance(line.rate, `${line.id}:rate`);
      const billable = quantity === 0n ? 0n : ceil(quantity < minimum ? minimum : quantity, increment) * increment;
      safe(billable, `${line.id} billable quantity`);
      amount = ceil(billable * rate, units);
      if (quantity > 0n && (line.rate.kind === 'catalog' || line.rate.kind === 'estimate')) {
        reasons.push(`estimated-cost:${line.id}`);
        provisional = true;
      }
    }
    if (amount === null) {
      reasons.push(`unpriced:${line.id}`);
      complete[line.payer] = false;
    } else sums[line.payer] += amount;
    return { id: line.id, category: line.category, payer: line.payer, micros: amount === null ? null : safe(amount, line.id) };
  });
  for (const category of PILOT_COST_CATEGORIES) {
    if (categories.has(category)) continue;
    reasons.push(`missing-cost:${category}`);
    // An omitted exposure has no measured payer either. Do not present partial sums as a margin.
    complete.platform = complete.consumption = complete['customer-direct'] = false;
  }
  safe(sums.platform + sums.consumption + sums['customer-direct'], 'total cost');
  let feeCents: bigint | null = null;
  let platformFee: bigint | null = null;
  let consumptionFee: bigint | null = null;
  let percentage: bigint | null = null;
  let fixed: bigint | null = null;
  if (sheet.paymentFee === null) reasons.push('unpriced:payment-fee');
  else {
    percentage = bps(sheet.paymentFee.percentageBps, 'payment percentage');
    fixed = integer(sheet.paymentFee.fixedCents, 'fixed payment fee');
    if (!['merchant-confirmed', 'catalog', 'estimate'].includes(sheet.paymentFee.kind)) throw new Error('invalid payment fee kind');
    checkProvenance(sheet.paymentFee, 'payment-fee');
    if (sheet.paymentFee.kind !== 'merchant-confirmed') {
      reasons.push('estimated-cost:payment-fee');
      provisional = true;
    }
    const totalCents = platformCents + consumptionCents;
    const variableFee = ceil(totalCents * percentage, BPS) * CENT;
    const fixedFee = totalCents === 0n ? 0n : fixed * CENT;
    safe(variableFee + fixedFee, 'payment fee');
    feeCents = (variableFee + fixedFee) / CENT;
    // Allocate the variable fee proportionally; put its exact residue on consumption.
    const platformVariable = totalCents === 0n ? 0n : variableFee * platformCents / totalCents;
    platformFee = platformVariable + fixedFee;
    consumptionFee = variableFee - platformVariable;
  }
  const margin = (payer: 'platform' | 'consumption', revenue: bigint, fee: bigint | null): PilotMargin => {
    const cost = complete[payer] ? sums[payer] : null;
    const profit = cost === null || fee === null ? null : revenue - cost - fee;
    const marginBps = profit === null || revenue === 0n ? null : floor(profit * BPS, revenue);
    return {
      revenueMicros: safe(revenue, `${payer} revenue`),
      knownCostMicros: safe(sums[payer], `${payer} cost`),
      costMicros: cost === null ? null : safe(cost, `${payer} cost`),
      paymentFeeMicros: fee === null ? null : safe(fee, `${payer} fee`),
      profitMicros: profit === null ? null : safe(profit, `${payer} profit`),
      marginBps: marginBps === null ? null : safe(marginBps, `${payer} margin`),
      targetMet: marginBps !== null && marginBps >= targets[payer],
      minimumPriceCents: cost === null || percentage === null || fixed === null ? null
        : priceFloor(cost, payer === 'platform' ? fixed : 0n, percentage, targets[payer]),
    };
  };
  const platform = margin('platform', platformRevenue, platformFee);
  const consumption = margin('consumption', consumptionRevenue, consumptionFee);
  if (!platform.targetMet) reasons.push('margin-target:platform');
  if (consumptionRevenue > 0n && !consumption.targetMet) reasons.push('margin-target:consumption');
  if (consumptionRevenue === 0n && sums.consumption > 0n) reasons.push('unfunded-consumption');
  const incomplete = Object.values(complete).some((value) => !value) || sheet.paymentFee === null;
  const state = incomplete ? 'incomplete' : provisional ? 'provisional' : 'measured';
  return {
    version: sheet.version, state,
    quoteAllowed: state === 'measured' && platform.targetMet && (consumptionRevenue === 0n ? sums.consumption === 0n : consumption.targetMet),
    reasons, costs, customerDirectKnownCostMicros: safe(sums['customer-direct'], 'customer direct cost'),
    paymentFeeCents: feeCents === null ? null : safe(feeCents, 'payment fee'), platform, consumption,
  };
}
