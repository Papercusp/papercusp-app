/** Exact monetary policy for hosted reservations (monetization P-005).
 *
 * Uses resolved hosted entitlement budgets (minor USD) and the accounting
 * rail's micro-USD unit. This is a decision helper, not an atomic store: the
 * durable caller must read funding, charges and open holds and insert the
 * granted reservation in the SAME transaction under the scope's row lock.
 * It never creates funding, charges Stripe or releases a crashed reservation.
 */
import type { HostedEntitlementSet } from '../../hosted-entitlement-schema';
import { MICROS_PER_CENT, parseMicrosDecimal, formatMicrosDecimal, splitMicrosDecimal } from '../../../cupboard/money-journal';
import type { HostedUsageRecord } from './usage-statement';

export interface HostedBudgetPolicy {
  readonly policyId: string;
  readonly revision: number;
  readonly budgetKey: string;
  readonly effectiveFromMs: number;
  readonly effectiveUntilMs: number;
  readonly warningBps: number;
}

export interface HostedBudgetPosition {
  /** Total verified prepaid/finite allowance funding for this policy window,
   * including money already spent. A balance-after-spend is NOT this field. */
  readonly fundedMicros: number;
  readonly fundedMicrosExact?: string;
  readonly spentMicros: number;
  readonly spentMicrosExact?: string;
  /** Includes crashed, cancelled-but-unbilled and expired process holds. */
  readonly openReservedMicros: number;
  /** Bounded continuing storage/IP/etc. exposure. Null is unknown, not zero. */
  readonly retainedReserveMicros: number | null;
  /** A known charge outside accounted spend/holds prevents further admission. */
  readonly unreconciled: boolean;
}

export type HostedBudgetRefusal = 'inactive-policy' | 'unconfigured-budget'
  | 'unreconciled-charge' | 'unbounded-retained-cost' | 'budget-exhausted';
export interface HostedBudgetDecision {
  readonly admitted: boolean;
  readonly reason: HostedBudgetRefusal | null;
  readonly capMicros: number | null;
  readonly availableMicros: number | null;
  readonly capMicrosExact?: string;
  readonly availableMicrosExact?: string;
  readonly reserveMicros: number;
  readonly warning: boolean;
}

function amount(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`invalid hosted budget ${field}`);
}
function exactAmount(value: number, exact: string | undefined, field: string): string {
  amount(value, field);
  if (exact === undefined) return String(value);
  try {
    const parsed = splitMicrosDecimal(exact);
    if (parsed.exact === exact && parsed.micros === value) return exact;
  } catch { /* Refuse unsupported precision/range with the budget field named. */ }
  throw new Error(`invalid hosted budget exact ${field}`);
}
const fractional = (exact: string) => exact.includes('.') ? exact : undefined;
const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
const refusal = (reason: HostedBudgetRefusal, capMicros: number | null = null,
  availableMicros: number | null = null, warning = false): HostedBudgetDecision =>
  ({ admitted: false, reason, capMicros, availableMicros, reserveMicros: 0, warning });

/** Maximum cost must be a server-enforced bound, never a forecast. No partial
 * grant: the caller must lower its provider/resource limit before retrying. */
export function evaluateHostedBudget(input: {
  readonly entitlements: Pick<HostedEntitlementSet, 'budgets'>;
  readonly policy: HostedBudgetPolicy;
  readonly position: HostedBudgetPosition;
  readonly maximumCostMicros: number;
  readonly asOfMs: number;
}): HostedBudgetDecision {
  const { policy, position } = input;
  if (!identifier(policy.policyId) || !identifier(policy.budgetKey)
      || !Number.isSafeInteger(policy.revision) || policy.revision < 1
      || !Number.isInteger(policy.warningBps) || policy.warningBps < 0 || policy.warningBps > 10_000) {
    throw new Error('invalid hosted budget policy');
  }
  amount(input.asOfMs, 'time'); amount(policy.effectiveFromMs, 'policy start'); amount(policy.effectiveUntilMs, 'policy end');
  if (policy.effectiveUntilMs <= policy.effectiveFromMs) throw new Error('invalid hosted budget interval');
  amount(input.maximumCostMicros, 'maximum cost');
  const funded = exactAmount(position.fundedMicros, position.fundedMicrosExact, 'funding');
  const spent = exactAmount(position.spentMicros, position.spentMicrosExact, 'spent');
  amount(position.openReservedMicros, 'holds');
  if (typeof position.unreconciled !== 'boolean') throw new Error('invalid hosted budget reconciliation');
  if (position.retainedReserveMicros !== null) amount(position.retainedReserveMicros, 'retained reserve');
  if (input.asOfMs < policy.effectiveFromMs || input.asOfMs >= policy.effectiveUntilMs) return refusal('inactive-policy');
  if (!Object.hasOwn(input.entitlements.budgets, policy.budgetKey)) return refusal('unconfigured-budget');
  const cents = input.entitlements.budgets[policy.budgetKey];
  amount(cents, 'entitlement cap');
  const entitlementMicros = cents * MICROS_PER_CENT;
  amount(entitlementMicros, 'entitlement conversion');
  const amounts = [funded, spent].map(parseMicrosDecimal);
  const scale = Math.max(...amounts.map(a => a.scale));
  const divisor = 10n ** BigInt(scale);
  const units = amounts.map(a => a.coefficient * 10n ** BigInt(scale - a.scale));
  const entitlement = BigInt(entitlementMicros) * divisor;
  const cap = units[0]! < entitlement ? units[0]! : entitlement;
  const capAmount = splitMicrosDecimal(formatMicrosDecimal(cap, scale));
  const capMicros = capAmount.micros;
  const capFields = fractional(capAmount.exact) ? { capMicrosExact: capAmount.exact } : {};
  if (position.unreconciled) return { ...refusal('unreconciled-charge', capMicros), ...capFields };
  if (position.retainedReserveMicros === null) return { ...refusal('unbounded-retained-cost', capMicros), ...capFields };
  // Aggregate exact liabilities BEFORE projecting available whole micros.
  // Per-receipt flooring loses spend; per-receipt ceiling over-reserves it.
  const committed = units[1]! + (BigInt(position.openReservedMicros) + BigInt(position.retainedReserveMicros)) * divisor;
  const available = splitMicrosDecimal(formatMicrosDecimal(committed >= cap ? 0n : cap - committed, scale));
  const availableMicros = available.micros;
  const requested = BigInt(input.maximumCostMicros) * divisor;
  const warning = (committed + requested) * 10_000n >= cap * BigInt(policy.warningBps);
  const exactFields = { ...capFields,
    ...(fractional(available.exact) ? { availableMicrosExact: available.exact } : {}) };
  if (committed > cap || requested > cap - committed) return { ...refusal('budget-exhausted', capMicros, availableMicros, warning), ...exactFields };
  return { admitted: true, reason: null, capMicros, availableMicros, reserveMicros: input.maximumCostMicros, warning, ...exactFields };
}

export interface HostedReservationSettlement {
  readonly state: 'pending' | 'settled';
  readonly chargedMicros: number;
  readonly chargedMicrosExact?: string;
  readonly heldMicros: number;
  readonly releasedMicros: number;
  readonly releasedMicrosExact?: string;
  readonly overrunMicros: number;
  readonly overrunMicrosExact?: string;
  readonly suspend: boolean;
  readonly evidenceRef: string;
}

/** Cancellation, process death, estimates and incomplete provider reports do
 * not certify zero spend. Keep the FULL hold until a final provider bill (or
 * an explicit final zero bill) reconciles it. A measured overrun is visible in
 * full and suspends admission; never clamp it to hide provider liability. */
export function settleHostedReservation(input: {
  readonly reservedMicros: number;
  readonly observedCostMicros: number | null;
  readonly observedCostMicrosExact?: string;
  readonly costSource: HostedUsageRecord['costSource'];
  readonly providerFinal: boolean;
  readonly evidenceRef: string;
}): HostedReservationSettlement {
  amount(input.reservedMicros, 'settlement reserve');
  const exact = input.observedCostMicros === null ? null
    : exactAmount(input.observedCostMicros, input.observedCostMicrosExact, 'settlement cost');
  if (!['estimate', 'provider-reported', 'provider-billed', 'unpriced'].includes(input.costSource)
      || typeof input.providerFinal !== 'boolean' || !identifier(input.evidenceRef)
      || (input.costSource === 'unpriced' && input.observedCostMicros !== null)
      || (input.observedCostMicros === null && input.observedCostMicrosExact !== undefined)) {
    throw new Error('invalid hosted budget settlement evidence');
  }
  const parsed = parseMicrosDecimal(exact ?? '0');
  const reserved = BigInt(input.reservedMicros) * 10n ** BigInt(parsed.scale);
  const excess = parsed.coefficient > reserved ? parsed.coefficient - reserved : 0n;
  const overrun = splitMicrosDecimal(formatMicrosDecimal(excess, parsed.scale));
  const overrunFields = fractional(overrun.exact) ? { overrunMicrosExact: overrun.exact } : {};
  const overrunMicros = overrun.micros;
  if (!input.providerFinal || input.costSource !== 'provider-billed' || input.observedCostMicros === null) {
    return { state: 'pending', chargedMicros: 0, heldMicros: input.reservedMicros,
      releasedMicros: 0, overrunMicros, suspend: excess > 0n, evidenceRef: input.evidenceRef, ...overrunFields };
  }
  const released = splitMicrosDecimal(formatMicrosDecimal(reserved > parsed.coefficient ? reserved - parsed.coefficient : 0n, parsed.scale));
  return { state: 'settled', chargedMicros: input.observedCostMicros, heldMicros: 0,
    releasedMicros: released.micros, ...(fractional(released.exact) ? { releasedMicrosExact: released.exact } : {}),
    ...(fractional(exact!) ? { chargedMicrosExact: exact! } : {}),
    overrunMicros, suspend: excess > 0n, evidenceRef: input.evidenceRef, ...overrunFields };
}
