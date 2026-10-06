/** Prepaid allocation rules for the existing hosted budget context reader.
 *
 * This is a pure validator, NOT a payment verifier or a funding authority.
 * The server reader must authenticate the account/customer, collect a complete
 * current payment/reversal census and lock its durable allocation rows in the
 * reservation transaction before using this result. Payment receipts alone do
 * not certify live mode or availability. No production reader is installed here.
 */
import { MICROS_PER_CENT, addMicrosDecimals, formatMicrosDecimal, journalLinesForMovement,
  parseMicrosDecimal, splitMicrosDecimal, validateJournalEntry, type JournalEntry,
  type JournalLine, type MoneyMovement } from '../../../cupboard/money-journal';
import { receiptCommitment, receiptTransactionProblem } from '../../../cupboard/payment-receipt';
import type { StoredPaymentReceipt } from '../../../cupboard/payment-receipt-store';
import { createHash } from 'node:crypto';
import { journalVerdictForStripeBalanceTransaction, validatePolicy,
  type CustomerPaymentPolicy } from '../../../cupboard/money-journal-producers';
import type { StripeBillingClient, StripeBillingCallResult, StripePaymentLineagePin, StripeAccountCashEvidence, StripeAccountPaymentSourceEvidence,
  StripeAccountTransactionEvidence, StripePaymentLineageEvidence,
  StripeObservedBalanceTransaction } from './stripe-billing-client';

export interface HostedPrepaidAllocation {
  readonly allocationId: string;
  readonly paymentTransactionId: string;
  readonly organizationId: string;
  /** Null is unassigned organization funding; workspace allocations partition it. */
  readonly customerWorkspaceId: string | null;
  readonly budgetKey: string;
  readonly micros: number;
  readonly microsExact?: string;
}
interface Payment {
  readonly entry: JournalEntry;
  readonly receipt: StoredPaymentReceipt;
  readonly available: boolean;
}
interface Reversal extends Omit<Payment, 'available'> {
  /** Established by the authenticated provider source, not by matching amounts. */
  readonly paymentTransactionId: string;
}
/** Current, complete cash-pool evidence supplied by the authenticated reader.
 * The journal covers EVERY customer/organization sharing this pool. Available
 * cash is independently reconciled liquid cash, not a receipt sum or forecast.
 * The reader must lock this population with allocations and reservation writes.
 * These fields are verifier inputs; this pure module does not authenticate them.
 */
export interface HostedCashBacking {
  readonly controlWorkspaceId: string;
  readonly stripeAccountId: string;
  readonly asOfMs: number;
  readonly livemode: boolean;
  readonly complete: boolean;
  readonly evidenceRef: string;
  readonly journalEntries: readonly JournalEntry[];
  readonly availableMicros: number;
  readonly availableMicrosExact?: string;
  /** Unpaid costs not already represented by journal outflows or reserves.
   * The reader must reconcile provider bills/roll-ups to avoid double counting.
   * Never subtract customer credit obligations merely because work was admitted.
   */
  readonly unpaidProviderMicros: number;
  readonly unpaidProviderMicrosExact?: string;
  readonly retainedReserveMicros: number | null;
}
export interface HostedPrepaidFundingInput {
  readonly scope: { readonly controlWorkspaceId: string; readonly organizationId: string; readonly customerWorkspaceId: string };
  readonly budgetKey: string;
  readonly windowStartMs: number;
  readonly asOfMs: number;
  readonly snapshot: {
    readonly controlWorkspaceId: string;
    readonly organizationId: string;
    readonly stripeAccountId: string;
    readonly stripeCustomerId: string;
    readonly livemode: boolean;
    readonly complete: boolean;
    readonly asOfMs: number;
    readonly evidenceRef: string;
  };
  readonly payments: readonly Payment[];
  readonly reversals: readonly Reversal[];
  /** ALL allocations of these payments, across keys/workspaces/organizations. */
  readonly allocations: readonly HostedPrepaidAllocation[];
  /** Latest final charges from earlier policy windows only, excluding current
   * window charges/holds that PostgresHostedBudgetStore counts independently. */
  readonly priorCharges: readonly {
    readonly chargeId: string;
    readonly organizationId: string;
    readonly customerWorkspaceId: string;
    readonly budgetKey: string;
    readonly periodEndMs: number;
    readonly costSource: 'provider-billed';
    readonly providerFinal: boolean;
    readonly micros: number;
    readonly microsExact?: string;
  }[];
  /** Missing current cash authority refuses even otherwise valid allocations. */
  readonly cashBacking: HostedCashBacking | null;
}
type FundingAmount = { readonly fundedMicros: number; readonly fundedMicrosExact?: string };
type Refusal = 'unverified-funding' | 'funding-scope-mismatch' | 'unavailable-payment'
  | 'unmatched-reversal' | 'funding-overallocated' | 'funding-overspent'
  | 'unverified-cash-backing' | 'insufficient-cash-backing';
export type HostedPrepaidFundingResult = { readonly ok: false; readonly reason: Refusal }
  | { readonly ok: true; readonly organization: FundingAmount;
    /** Null means no separate workspace allocation; the organization cap still applies. */
    readonly workspace: FundingAmount | null; readonly evidenceRef: string };
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(v);
const safe = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const refuse = (reason: Refusal): HostedPrepaidFundingResult => ({ ok: false, reason });
function exact(micros: number, microsExact?: string): string {
  if (!safe(micros)) throw new Error('invalid prepaid micro amount');
  const parsed = splitMicrosDecimal(microsExact ?? String(micros));
  if (parsed.micros !== micros || (microsExact !== undefined && parsed.exact !== microsExact)) {
    throw new Error('invalid exact prepaid micro amount');
  }
  return parsed.exact;
}
function subtract(a: string, b: string): string | null {
  const aa = parseMicrosDecimal(a); const bb = parseMicrosDecimal(b);
  const scale = Math.max(aa.scale, bb.scale);
  const difference = aa.coefficient * 10n ** BigInt(scale - aa.scale) - bb.coefficient * 10n ** BigInt(scale - bb.scale);
  return difference < 0n ? null : formatMicrosDecimal(difference, scale);
}
function amount(value: string): FundingAmount {
  const a = splitMicrosDecimal(value);
  return { fundedMicros: a.micros, ...(a.exact.includes('.') ? { fundedMicrosExact: a.exact } : {}) };
}
const sortedLines = (lines: readonly JournalLine[]) => JSON.stringify([...lines]
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
function samePosting(entry: JournalEntry, movement: MoneyMovement): void {
  const built = journalLinesForMovement(movement);
  if (!built.ok || sortedLines(entry.lines) !== sortedLines(built.lines)) throw new Error('prepaid journal posting mismatch');
}
function posting(payment: Omit<Payment, 'available'>, customerId: string): JournalEntry {
  const { receipt } = payment;
  const valid = validateJournalEntry(payment.entry);
  if (!valid.ok || receiptTransactionProblem(receipt.transaction)
      || receipt.commitment !== receiptCommitment(receipt.transaction, receipt.salt)) throw new Error('invalid prepaid receipt or journal');
  const entry = valid.entry; const t = receipt.transaction;
  if (entry.externalRef.kind !== 'stripe-balance-transaction' || entry.externalRef.id !== t.id
      || entry.currency !== 'USD' || t.currency.toLowerCase() !== 'usd'
      || entry.occurredAtMs !== t.created * 1000 || receipt.sourceCustomer !== customerId) {
    throw new Error('prepaid receipt binding mismatch');
  }
  return entry;
}

/** Reconcile the Stripe portion of a locked funding read. All evidence must be
 * collected by the server's authenticated client; this pure function does not
 * authenticate a caller or lock SQL. Two unchanged censuses bracket the fresh
 * lineage reads. Equality detects observed drift, not an atomic provider
 * snapshot or protection against a later external withdrawal.
 *
 * Uses the SAME receipt and journal mapping as the existing importer. Every
 * account transaction must have an exact posting and committed receipt, even
 * for another customer. Unposted reversals refuse the whole pool. Payouts and
 * unsupported reinstatements remain unresolved here: the bank/provider/cash
 * reconciliation and allocation locks are still required independently.
 */
export interface HostedStripeFundingRead {
  readonly scope: HostedPrepaidFundingInput['scope'];
  readonly accountId: string;
  readonly customerId: string;
  readonly asOfMs: number;
  readonly maximumAgeMs: number;
  readonly policy: CustomerPaymentPolicy;
  readonly cashBefore: StripeAccountCashEvidence;
  readonly sourcesBefore: StripeAccountPaymentSourceEvidence;
  readonly transactionsBefore: StripeAccountTransactionEvidence;
  readonly lineages: readonly StripePaymentLineageEvidence[];
  readonly transactionsAfter: StripeAccountTransactionEvidence;
  readonly sourcesAfter: StripeAccountPaymentSourceEvidence;
  readonly cashAfter: StripeAccountCashEvidence;
  /** Entire pool population read through the reservation's SQL transaction. */
  readonly entries: readonly JournalEntry[];
  readonly receipts: readonly StoredPaymentReceipt[];
}
type StripeFundingRefusal = 'unverified-stripe-read' | 'stripe-read-changed'
  | 'unreconciled-stripe-source' | 'unreconciled-stripe-movement' | 'unreconciled-stripe-receipt';
export type HostedStripeFundingResult = { readonly ok: false; readonly reason: StripeFundingRefusal }
  | { readonly ok: true; readonly snapshot: HostedPrepaidFundingInput['snapshot'];
    readonly payments: readonly Payment[]; readonly reversals: readonly Reversal[];
    readonly evidenceRef: string };

/** Server collection inputs, read from the complete locked local population.
 * The caller keeps the account/allocation and journal population locked until
 * reservation commit. This collector does not create that SQL authority, bank
 * backing, provider finality, or permission to execute paid work. */
export interface HostedStripeFundingCollection {
  readonly scope: HostedPrepaidFundingInput['scope'];
  readonly accountId: string;
  readonly customerId: string;
  readonly maximumAgeMs: number;
  readonly policy: CustomerPaymentPolicy;
  readonly entries: readonly JournalEntry[];
  readonly receipts: readonly StoredPaymentReceipt[];
  /** Persisted customer bindings, including other customers sharing the pool.
   * Each binding is independently checked by the authenticated lineage read. */
  readonly customers: readonly { readonly stripeCustomerId: string; readonly organizationId: string; readonly livemode: boolean }[];
}
export type HostedStripeFundingCollectorClient = Pick<StripeBillingClient, 'livemode' | 'readAccountCash'
  | 'readAccountPaymentSources' | 'readAccountTransactions' | 'readPaymentLineage'>;

/** Collect actual client evidence in the order required by the existing
 * reconciler. The completion clock, rather than a request's earlier timestamp,
 * bounds the observations. Unchanged brackets prove observed consistency only;
 * an external withdrawal after the last read is still possible. */
export async function collectHostedStripeFunding(input: HostedStripeFundingCollection, dependencies: {
  readonly client: HostedStripeFundingCollectorClient;
  readonly now?: () => number;
  /** A bound refuses the whole collection, never a truncated population. */
  readonly maximumLineages?: number;
  /** One deadline across every page and lineage, while local locks are held.
   * Adapters must honor the supplied signal through transport/body reads. */
  readonly maximumDurationMs?: number;
  readonly signal?: AbortSignal;
}): Promise<HostedStripeFundingResult> {
  input = structuredClone(input);
  const client = dependencies.client;
  const now = dependencies.now ?? Date.now;
  const maximumLineages = dependencies.maximumLineages ?? 1000;
  const maximumDurationMs = dependencies.maximumDurationMs ?? 10_000;
  if (!id(input.scope.controlWorkspaceId) || !id(input.scope.organizationId) || !id(input.scope.customerWorkspaceId)
      || !/^acct_[A-Za-z0-9]+$/.test(input.accountId) || !/^cus_[A-Za-z0-9]+$/.test(input.customerId)
      || !safe(input.maximumAgeMs) || validatePolicy(input.policy) || !safe(maximumLineages) || maximumLineages < 1
      || !safe(maximumDurationMs) || maximumDurationMs < 1 || maximumDurationMs > 10_000
      || !Array.isArray(input.entries) || !Array.isArray(input.receipts) || !Array.isArray(input.customers)) {
    throw new Error('invalid Stripe funding collection');
  }
  const reject = (reason: StripeFundingRefusal): HostedStripeFundingResult => ({ ok: false, reason });
  if (client.livemode !== true) return reject('unverified-stripe-read');
  const customers = new Map<string, string>();
  for (const c of input.customers) {
    if (!/^cus_[A-Za-z0-9]+$/.test(c.stripeCustomerId) || !id(c.organizationId)
        || c.livemode !== true || customers.has(c.stripeCustomerId)) return reject('unverified-stripe-read');
    customers.set(c.stripeCustomerId, c.organizationId);
  }
  if (customers.get(input.customerId) !== input.scope.organizationId) return reject('unverified-stripe-read');
  const controller = new AbortController();
  const signal = dependencies.signal ? AbortSignal.any([dependencies.signal, controller.signal]) : controller.signal;
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), maximumDurationMs);
  async function read<T>(operation: (signal: AbortSignal) => Promise<StripeBillingCallResult<T>>) {
    signal.throwIfAborted();
    const result = await operation(signal);
    signal.throwIfAborted();
    if (performance.now() - started >= maximumDurationMs) throw new Error('stripe collection deadline');
    return result;
  }
  try {
    // Detach every response before the next await: an adapter must not change a
    // prior bracket in place and make observed provider drift disappear.
    const cashPin = { accountId: input.accountId, customerId: input.customerId, organizationId: input.scope.organizationId };
    const cash1 = await read(signal => client.readAccountCash({ ...cashPin }, signal));
    if (!cash1.ok) return reject('unverified-stripe-read');
    const cashBefore = structuredClone(cash1.evidence);
    const sources1 = await read(signal => client.readAccountPaymentSources({ accountId: input.accountId }, signal));
    if (!sources1.ok) return reject('unverified-stripe-read');
    const sourcesBefore = structuredClone(sources1.evidence);
    const tx1 = await read(signal => client.readAccountTransactions({ accountId: input.accountId }, signal));
    if (!tx1.ok) return reject('unverified-stripe-read');
    const transactionsBefore = structuredClone(tx1.evidence);
    const charges = new Map(sourcesBefore.charges.map(c => [c.id, c]));
    const receipts = new Map(input.receipts.map(r => [r.transaction.id, r]));
    if (charges.size !== sourcesBefore.charges.length || receipts.size !== input.receipts.length) {
      return reject('unreconciled-stripe-source');
    }
    const pins: StripePaymentLineagePin[] = [];
    function pin(kind: StripePaymentLineagePin['source']['kind'], sourceId: string, chargeId: string): boolean {
      const charge = charges.get(chargeId);
      if (!charge?.customerId || !charge.balanceTransactionId) return false;
      const organizationId = customers.get(charge.customerId);
      const receipt = receipts.get(charge.balanceTransactionId);
      // Original pins come from the local immutable receipt, never from a
      // provider list alone, a caller amount, or another customer's request.
      if (!organizationId || !receipt || receipt.sourceId !== chargeId || receipt.sourceCustomer !== charge.customerId) return false;
      pins.push({ accountId: input.accountId, customerId: receipt.sourceCustomer, organizationId,
        chargeId: receipt.sourceId, chargeBalanceTransactionId: receipt.transaction.id,
        source: { kind, id: sourceId } });
      return pins.length <= maximumLineages;
    }
    for (const charge of sourcesBefore.charges) {
      if (charge.balanceTransactionId === null && charge.capturedCents === 0 && charge.refundedCents === 0
          && charge.failureBalanceTransactionId === null && !charge.paid && !charge.captured) continue;
      if (!pin('charge', charge.id, charge.id)) return reject('unreconciled-stripe-source');
    }
    for (const refund of sourcesBefore.refunds) {
      if (['failed', 'canceled'].includes(refund.status) && refund.balanceTransactionId === null
          && refund.failureBalanceTransactionId === null) continue;
      if (!pin('refund', refund.id, refund.chargeId)) return reject('unreconciled-stripe-source');
    }
    // The accounting mapper deliberately has no dispute restoration authority.
    if (sourcesBefore.disputes.length) return reject('unreconciled-stripe-source');
    const lineages: StripePaymentLineageEvidence[] = [];
    for (const p of pins) {
      const result = await read(signal => client.readPaymentLineage(p, signal));
      if (!result.ok) return reject('unverified-stripe-read');
      lineages.push(structuredClone(result.evidence));
    }
    const tx2 = await read(signal => client.readAccountTransactions({ accountId: input.accountId }, signal));
    if (!tx2.ok) return reject('unverified-stripe-read');
    const transactionsAfter = structuredClone(tx2.evidence);
    const sources2 = await read(signal => client.readAccountPaymentSources({ accountId: input.accountId }, signal));
    if (!sources2.ok) return reject('unverified-stripe-read');
    const sourcesAfter = structuredClone(sources2.evidence);
    const cash2 = await read(signal => client.readAccountCash({ ...cashPin }, signal));
    if (!cash2.ok) return reject('unverified-stripe-read');
    const cashAfter = structuredClone(cash2.evidence);
    const result = reconcileHostedStripeFunding({ ...input, cashBefore, sourcesBefore, transactionsBefore,
      lineages, transactionsAfter, sourcesAfter, cashAfter, asOfMs: now() });
    signal.throwIfAborted();
    if (performance.now() - started >= maximumDurationMs) throw new Error('stripe collection deadline');
    return result;
  } catch {
    // Provider failures cannot echo secrets or certify a partial collection.
    return reject('unverified-stripe-read');
  } finally {
    clearTimeout(timer);
  }
}

export function reconcileHostedStripeFunding(input: HostedStripeFundingRead): HostedStripeFundingResult {
  const reject = (reason: StripeFundingRefusal): HostedStripeFundingResult => ({ ok: false, reason });
  const { sourcesBefore: before, sourcesAfter: after, transactionsBefore: txBefore,
    transactionsAfter: txAfter, cashBefore, cashAfter } = input;
  if (!id(input.scope.controlWorkspaceId) || !id(input.scope.organizationId) || !id(input.scope.customerWorkspaceId)
      || !/^acct_[A-Za-z0-9]+$/.test(input.accountId) || !/^cus_[A-Za-z0-9]+$/.test(input.customerId)
      || !safe(input.asOfMs) || !safe(input.maximumAgeMs) || validatePolicy(input.policy)
      || !Array.isArray(input.lineages) || !Array.isArray(input.entries) || !Array.isArray(input.receipts)) {
    throw new Error('invalid Stripe funding read');
  }
  const readings = [cashBefore, before, txBefore, ...input.lineages, txAfter, after, cashAfter];
  if (readings.some(r => !r || r.accountId !== input.accountId || !id(r.evidenceRef)
      || !safe(r.observedAtMs) || r.observedAtMs > input.asOfMs
      || input.asOfMs - r.observedAtMs > input.maximumAgeMs)
      || [cashBefore, cashAfter].some(c => c.customerId !== input.customerId
        || c.organizationId !== input.scope.organizationId || c.livemode !== true
        || !Number.isSafeInteger(c.availableUsdCents) || !Number.isSafeInteger(c.pendingUsdCents))
      || before.livemode !== true || after.livemode !== true
      || !safe(before.collectionStartedAtMs) || !safe(after.collectionStartedAtMs)
      || cashBefore.observedAtMs > before.collectionStartedAtMs || before.collectionStartedAtMs > before.observedAtMs
      || before.observedAtMs > txBefore.observedAtMs || txBefore.observedAtMs > txAfter.observedAtMs
      || txAfter.observedAtMs > after.collectionStartedAtMs || after.collectionStartedAtMs > after.observedAtMs
      || after.observedAtMs > cashAfter.observedAtMs
      || input.lineages.some(l => l.livemode !== true || l.observedAtMs < txBefore.observedAtMs
        || l.observedAtMs > txAfter.observedAtMs)) return reject('unverified-stripe-read');
  const sorted = <T extends { readonly id: string }>(rows: readonly T[]) => JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)));
  if (sorted(before.charges) !== sorted(after.charges) || sorted(before.refunds) !== sorted(after.refunds)
      || sorted(before.disputes) !== sorted(after.disputes) || sorted(txBefore.transactions) !== sorted(txAfter.transactions)
      || cashBefore.availableUsdCents !== cashAfter.availableUsdCents || cashBefore.pendingUsdCents !== cashAfter.pendingUsdCents) {
    return reject('stripe-read-changed');
  }
  const transactions = new Map<string, StripeObservedBalanceTransaction>();
  const entries = new Map<string, JournalEntry>();
  const receipts = new Map<string, StoredPaymentReceipt>();
  for (const bt of txAfter.transactions) {
    if (transactions.has(bt.id) || bt.currency !== 'usd' || !Number.isSafeInteger(bt.amount) || !safe(bt.fee)
        || bt.net !== bt.amount - bt.fee || !safe(bt.created) || bt.created * 1000 > txBefore.observedAtMs
        || !['available', 'pending'].includes(bt.status) || !safe(bt.available_on)) return reject('unreconciled-stripe-movement');
    transactions.set(bt.id, bt);
  }
  for (const raw of input.entries) {
    const valid = validateJournalEntry(raw);
    if (!valid.ok || raw.occurredAtMs > input.asOfMs) return reject('unreconciled-stripe-movement');
    if (raw.externalRef.kind !== 'stripe-balance-transaction') continue;
    if (entries.has(raw.externalRef.id)) return reject('unreconciled-stripe-movement');
    entries.set(raw.externalRef.id, valid.entry);
  }
  for (const r of input.receipts) {
    if (receipts.has(r.transaction.id) || receiptTransactionProblem(r.transaction)
        || r.commitment !== receiptCommitment(r.transaction, r.salt)) return reject('unreconciled-stripe-receipt');
    receipts.set(r.transaction.id, r);
  }
  const sourceId = (bt: StripeObservedBalanceTransaction) => typeof bt.source === 'string' ? bt.source : bt.source?.id;
  for (const [transactionId, bt] of transactions) {
    const mapped = journalVerdictForStripeBalanceTransaction(bt, input.policy);
    const entry = entries.get(transactionId); const receipt = receipts.get(transactionId);
    if (mapped.disposition !== 'entry' || !entry || mapped.entry.movement !== entry.movement
        || mapped.entry.occurredAtMs !== entry.occurredAtMs || mapped.entry.currency !== entry.currency
        || sortedLines(mapped.entry.lines) !== sortedLines(entry.lines)) return reject('unreconciled-stripe-movement');
    if (!receipt || receipt.transaction.amount !== bt.amount || receipt.transaction.fee !== bt.fee
        || receipt.transaction.currency !== bt.currency || receipt.transaction.created !== bt.created
        || receipt.sourceId !== sourceId(bt)) return reject('unreconciled-stripe-receipt');
  }
  // Comparing both directions is essential: an omitted outflow or an extra
  // book inflow can otherwise make a partial census look solvent.
  if (entries.size !== transactions.size || receipts.size !== transactions.size) return reject('unreconciled-stripe-movement');
  const lineages = new Map<string, StripePaymentLineageEvidence>();
  for (const l of input.lineages) {
    const key = JSON.stringify([l.source.kind, l.source.id]);
    if (lineages.has(key)) return reject('unreconciled-stripe-source');
    lineages.set(key, l);
  }
  const used = new Set<string>(); const pinnedMovements = new Set<string>();
  const payments: Payment[] = []; const reversals: Reversal[] = [];
  const charges = new Map(after.charges.map(c => [c.id, c]));
  if (charges.size !== after.charges.length) return reject('unreconciled-stripe-source');
  function lineage(kind: 'charge' | 'refund' | 'dispute', source: string, chargeId: string): StripePaymentLineageEvidence | null {
    const key = JSON.stringify([kind, source]); const l = lineages.get(key); const c = charges.get(chargeId);
    if (!l || !c || l.charge.id !== chargeId || l.customerId !== c.customerId || !id(l.organizationId)
        || (l.customerId === input.customerId && l.organizationId !== input.scope.organizationId)
        || l.charge.balanceTransaction.id !== c.balanceTransactionId || l.charge.capturedUsdCents !== c.capturedCents
        || l.charge.refundedUsdCents !== c.refundedCents
        || !sameMovement(l.charge.balanceTransaction) || sourceId(l.charge.balanceTransaction) !== chargeId
        || !['charge', 'payment'].includes(l.charge.balanceTransaction.type)
        || l.charge.balanceTransaction.amount !== c.capturedCents) return null;
    used.add(key); return l;
  }
  function sameMovement(bt: StripeObservedBalanceTransaction): boolean {
    const current = transactions.get(bt.id);
    return !!current && current.amount === bt.amount && current.fee === bt.fee && current.net === bt.net
      && current.currency === bt.currency && current.created === bt.created && current.type === bt.type
      && current.status === bt.status && current.available_on === bt.available_on && sourceId(current) === sourceId(bt);
  }
  for (const c of after.charges) {
    if (c.currency !== 'usd' || !safe(c.created) || c.created * 1000 > before.observedAtMs) return reject('unreconciled-stripe-source');
    // Uncaptured failed/pending attempts cannot supply cash. A movement or
    // refunded principal still requires a fully reconciled original payment.
    if (c.balanceTransactionId === null && c.capturedCents === 0 && c.refundedCents === 0
        && c.failureBalanceTransactionId === null && !c.paid && !c.captured) continue;
    const l = lineage('charge', c.id, c.id);
    if (!l || !c.paid || !c.captured || c.status !== 'succeeded' || c.failureBalanceTransactionId !== null
        || l.source.status !== c.status || l.source.amountUsdCents !== c.capturedCents
        || l.source.balanceTransactions.length !== 1 || !sameMovement(l.source.balanceTransactions[0]!)
        || l.source.balanceTransactions[0]!.id !== c.balanceTransactionId) return reject('unreconciled-stripe-source');
    const bt = l.charge.balanceTransaction; const r = receipts.get(bt.id)!;
    if (r.sourceCustomer !== c.customerId || pinnedMovements.has(bt.id)) return reject('unreconciled-stripe-receipt');
    pinnedMovements.add(bt.id);
    const entry = entries.get(bt.id)!;
    if (c.customerId === input.customerId && entry.movement === 'credit-purchase') {
      payments.push({ entry, receipt: r, available: bt.status === 'available' && bt.available_on * 1000 <= input.asOfMs });
    }
  }
  const refunded = new Map<string, bigint>(); const refundIds = new Set<string>();
  for (const r of after.refunds) {
    const original = charges.get(r.chargeId);
    if (!original || refundIds.has(r.id) || r.currency !== 'usd' || !safe(r.amountCents)
        || !safe(r.created) || r.created < original.created || r.created * 1000 > before.observedAtMs) return reject('unreconciled-stripe-source');
    refundIds.add(r.id);
    if (['failed', 'canceled'].includes(r.status) && r.balanceTransactionId === null && r.failureBalanceTransactionId === null) continue;
    const l = lineage('refund', r.id, r.chargeId);
    if (!l || r.status !== 'succeeded' || r.failureBalanceTransactionId !== null
        || l.source.status !== r.status || l.source.amountUsdCents !== r.amountCents
        || l.source.balanceTransactions.length !== 1 || l.source.balanceTransactions[0]!.id !== r.balanceTransactionId) {
      return reject('unreconciled-stripe-source');
    }
    const bt = l.source.balanceTransactions[0]!;
    if (!sameMovement(bt) || bt.amount !== -r.amountCents || !['refund', 'payment_refund'].includes(bt.type)
        || sourceId(bt) !== r.id || pinnedMovements.has(bt.id)) return reject('unreconciled-stripe-source');
    pinnedMovements.add(bt.id);
    refunded.set(r.chargeId, (refunded.get(r.chargeId) ?? 0n) + BigInt(r.amountCents));
    const receipt = receipts.get(bt.id)!;
    if (receipt.sourceCustomer !== l.customerId) return reject('unreconciled-stripe-receipt');
    if (l.customerId === input.customerId && payments.some(p => p.receipt.transaction.id === l.charge.balanceTransaction.id)) {
      reversals.push({ entry: entries.get(bt.id)!, receipt, paymentTransactionId: l.charge.balanceTransaction.id });
    }
  }
  if (after.charges.some(c => !safe(c.refundedCents) || (refunded.get(c.id) ?? 0n) !== BigInt(c.refundedCents))
      || after.disputes.length > 0 || lineages.size !== used.size
      || [...transactions.values()].some(bt => ['charge', 'payment', 'refund', 'payment_refund', 'adjustment', 'refund_failure'].includes(bt.type)
        && !pinnedMovements.has(bt.id))) return reject('unreconciled-stripe-source');
  const evidenceRef = 'stripe-funding-read:' + createHash('sha256').update(JSON.stringify({ scope: input.scope,
    asOfMs: input.asOfMs, policy: input.policy, readings: readings.map(r => r.evidenceRef),
    entries: input.entries, receipts: input.receipts })).digest('hex');
  const frozenPayment = <T extends Omit<Payment, 'available'>>(p: T): T => Object.freeze({ ...p,
    entry: Object.freeze({ ...p.entry, externalRef: Object.freeze({ ...p.entry.externalRef }),
      lines: Object.freeze(p.entry.lines.map(line => Object.freeze({ ...line }))) }),
    receipt: Object.freeze({ ...p.receipt, transaction: Object.freeze({ ...p.receipt.transaction }) }) });
  return Object.freeze({ ok: true, snapshot: Object.freeze({ controlWorkspaceId: input.scope.controlWorkspaceId, organizationId: input.scope.organizationId,
    stripeAccountId: input.accountId, stripeCustomerId: input.customerId, livemode: true,
    complete: true, asOfMs: input.asOfMs, evidenceRef }), payments: Object.freeze(payments.map(frozenPayment)),
    reversals: Object.freeze(reversals.map(frozenPayment)), evidenceRef });
}
const cents = (entry: JournalEntry, account: JournalLine['account'], side: JournalLine['side']) =>
  entry.lines.filter(l => l.account === account && l.side === side).reduce((n, l) => n + BigInt(l.cents), 0n);

function cashBackingProblem(input: HostedPrepaidFundingInput): Refusal | null {
  const c = input.cashBacking;
  if (!c || c.controlWorkspaceId !== input.scope.controlWorkspaceId
      || c.stripeAccountId !== input.snapshot.stripeAccountId || c.asOfMs !== input.asOfMs
      || c.livemode !== true || c.complete !== true || !id(c.evidenceRef)
      || c.retainedReserveMicros === null) return 'unverified-cash-backing';
  if (!Array.isArray(c.journalEntries) || !safe(c.retainedReserveMicros)) throw new Error('invalid cash backing input');
  const available = exact(c.availableMicros, c.availableMicrosExact);
  const unpaid = exact(c.unpaidProviderMicros, c.unpaidProviderMicrosExact);
  const postings = new Map<string, JournalEntry>();
  const references = new Set<string>();
  let operating = 0n;
  const liabilities = new Map<JournalLine['account'], bigint>();
  for (const raw of c.journalEntries) {
    const valid = validateJournalEntry(raw);
    if (!valid.ok) throw new Error('invalid cash backing journal');
    const entry = valid.entry;
    const ref = JSON.stringify(entry.externalRef);
    if (entry.currency !== 'USD' || entry.occurredAtMs > input.asOfMs
        || postings.has(entry.entryId) || references.has(ref)) throw new Error('invalid or duplicate cash backing posting');
    postings.set(entry.entryId, entry); references.add(ref);
    for (const line of entry.lines) {
      const debit = line.side === 'debit' ? BigInt(line.cents) : -BigInt(line.cents);
      if (line.account === 'operating') operating += debit;
      if (['customer-credit-reserve', 'refund-chargeback-reserve', 'tax-reserve', 'dao-payable'].includes(line.account)) {
        liabilities.set(line.account, (liabilities.get(line.account) ?? 0n) - debit);
      }
    }
  }
  // A scoped receipt cannot supply backing absent from the global journal.
  for (const p of [...input.payments, ...input.reversals]) {
    const stored = postings.get(p.entry.entryId);
    if (!stored || stored.occurredAtMs !== p.entry.occurredAtMs || stored.movement !== p.entry.movement
        || JSON.stringify(stored.externalRef) !== JSON.stringify(p.entry.externalRef)
        || sortedLines(stored.lines) !== sortedLines(p.entry.lines)) throw new Error('cash backing prepaid posting mismatch');
  }
  if (operating < 0n) return 'insufficient-cash-backing';
  // Each credit-normal account contributes its positive obligation separately.
  // A debit provision balance never cancels another customer's credit/tax/DAO.
  const reservedCents = [...liabilities.values()].reduce((n, value) => n + (value > 0n ? value : 0n), 0n);
  const reserved = addMicrosDecimals((reservedCents * BigInt(MICROS_PER_CENT)).toString(),
    unpaid, String(c.retainedReserveMicros));
  // Both book cash AND independent available cash must back the entire pool.
  // Compare aggregate decimals before any whole-micro admission projection.
  return subtract((operating * BigInt(MICROS_PER_CENT)).toString(), reserved) === null
    || subtract(available, reserved) === null ? 'insufficient-cash-backing' : null;
}

/** Allocations partition the cash of each individual prepaid payment; they are
 * never additional money alongside the organization total. Fees, tax and
 * linked refunds/chargebacks reduce backing before any allocation is accepted.
 * A reversal below an existing grant suspends funding rather than silently
 * inventing debt or choosing which customer/workspace loses its allocation.
 */
export function evaluateHostedPrepaidFunding(input: HostedPrepaidFundingInput): HostedPrepaidFundingResult {
  const s = input.scope; const v = input.snapshot;
  if (!s || !v || !id(s.controlWorkspaceId) || !id(s.organizationId) || !id(s.customerWorkspaceId)
      || !id(input.budgetKey) || !safe(input.asOfMs) || !safe(input.windowStartMs) || input.windowStartMs > input.asOfMs
      || !Array.isArray(input.payments) || !Array.isArray(input.reversals) || !Array.isArray(input.allocations)
      || !Array.isArray(input.priorCharges)) throw new Error('invalid prepaid funding input');
  if (v.controlWorkspaceId !== s.controlWorkspaceId || v.organizationId !== s.organizationId) return refuse('funding-scope-mismatch');
  if (v.livemode !== true || v.complete !== true || v.asOfMs !== input.asOfMs
      || !/^acct_[A-Za-z0-9]+$/.test(v.stripeAccountId) || !/^cus_[A-Za-z0-9]+$/.test(v.stripeCustomerId)
      || !id(v.evidenceRef)) return refuse('unverified-funding');
  const payments = new Map<string, { credits: bigint; cash: bigint; tax: bigint; available: boolean }>();
  const journalIds = new Set<string>(); const transactionIds = new Set<string>();
  function unique(entry: JournalEntry, transactionId: string): void {
    if (journalIds.has(entry.entryId) || transactionIds.has(transactionId)) throw new Error('duplicate prepaid journal source');
    journalIds.add(entry.entryId); transactionIds.add(transactionId);
    if (entry.occurredAtMs > input.asOfMs) throw new Error('future prepaid journal source');
  }
  for (const p of input.payments) {
    const entry = posting(p, v.stripeCustomerId); const t = p.receipt.transaction;
    unique(entry, t.id);
    if (entry.movement !== 'credit-purchase' || typeof p.available !== 'boolean') throw new Error('not a prepaid funding payment');
    const tax = cents(entry, 'tax-reserve', 'credit');
    if (tax > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('prepaid tax overflow');
    samePosting(entry, { kind: 'credit-purchase', grossCents: t.amount, feeCents: t.fee, taxCents: Number(tax) });
    payments.set(t.id, { credits: BigInt(t.amount) - tax, cash: BigInt(t.amount) - BigInt(t.fee) - tax, tax, available: p.available });
  }
  for (const r of input.reversals) {
    const entry = posting(r, v.stripeCustomerId); const t = r.receipt.transaction;
    unique(entry, t.id);
    const p = payments.get(r.paymentTransactionId);
    if (!p) return refuse('unmatched-reversal');
    if (entry.movement === 'refund') {
      const tax = cents(entry, 'tax-reserve', 'debit');
      if (t.fee !== 0 || tax > BigInt(Number.MAX_SAFE_INTEGER) || tax > p.tax) throw new Error('invalid prepaid refund fee or tax');
      samePosting(entry, { kind: 'refund', amountCents: -t.amount, taxCents: Number(tax) });
      p.tax -= tax;
      p.credits -= BigInt(-t.amount) - tax;
      p.cash -= BigInt(-t.amount) - tax;
    } else if (entry.movement === 'chargeback') {
      samePosting(entry, { kind: 'chargeback', amountCents: -t.amount, feeCents: t.fee });
      p.credits -= BigInt(-t.amount); p.cash -= BigInt(-t.amount) + BigInt(t.fee);
    } else throw new Error('not a prepaid funding reversal');
  }
  const allocated = new Map<string, string>(); const allocationIds = new Set<string>();
  const org: string[] = []; const workspace: string[] = [];
  const grantsByKey = new Map<string, string>(); const workspaceGrants = new Map<string, string>();
  const workspaceKey = (workspaceId: string, budgetKey: string) => JSON.stringify([workspaceId, budgetKey]);
  for (const a of input.allocations) {
    if (!id(a.allocationId) || !id(a.paymentTransactionId) || !id(a.organizationId) || !id(a.budgetKey)
        || (a.customerWorkspaceId !== null && !id(a.customerWorkspaceId)) || allocationIds.has(a.allocationId)) {
      throw new Error('invalid or duplicate prepaid allocation');
    }
    allocationIds.add(a.allocationId);
    const value = exact(a.micros, a.microsExact); const p = payments.get(a.paymentTransactionId);
    if (!p || a.organizationId !== s.organizationId) return refuse('funding-scope-mismatch');
    if (!p.available) return refuse('unavailable-payment');
    allocated.set(a.paymentTransactionId, addMicrosDecimals(allocated.get(a.paymentTransactionId) ?? '0', value));
    grantsByKey.set(a.budgetKey, addMicrosDecimals(grantsByKey.get(a.budgetKey) ?? '0', value));
    if (a.customerWorkspaceId !== null) {
      const key = workspaceKey(a.customerWorkspaceId, a.budgetKey);
      workspaceGrants.set(key, addMicrosDecimals(workspaceGrants.get(key) ?? '0', value));
    }
    if (a.budgetKey === input.budgetKey) {
      org.push(value);
      if (a.customerWorkspaceId === s.customerWorkspaceId) workspace.push(value);
    }
  }
  for (const [transactionId, p] of payments) {
    const capacity = (p.credits < p.cash ? p.credits : p.cash) * BigInt(MICROS_PER_CENT);
    if (capacity < 0n || subtract(capacity.toString(), allocated.get(transactionId) ?? '0') === null) {
      return refuse('funding-overallocated');
    }
  }
  const priorOrg: string[] = []; const priorWorkspace: string[] = []; const chargeIds = new Set<string>();
  const priorByKey = new Map<string, string>(); const priorByWorkspace = new Map<string, string>();
  for (const c of input.priorCharges) {
    if (!id(c.chargeId) || chargeIds.has(c.chargeId) || !id(c.budgetKey) || !id(c.customerWorkspaceId)
        || !safe(c.periodEndMs) || c.periodEndMs > input.windowStartMs
        || c.costSource !== 'provider-billed' || c.providerFinal !== true) throw new Error('invalid or duplicate prior prepaid charge');
    chargeIds.add(c.chargeId);
    if (c.organizationId !== s.organizationId) return refuse('funding-scope-mismatch');
    const value = exact(c.micros, c.microsExact);
    priorByKey.set(c.budgetKey, addMicrosDecimals(priorByKey.get(c.budgetKey) ?? '0', value));
    const key = workspaceKey(c.customerWorkspaceId, c.budgetKey);
    priorByWorkspace.set(key, addMicrosDecimals(priorByWorkspace.get(key) ?? '0', value));
    if (c.budgetKey === input.budgetKey) {
      priorOrg.push(value);
      if (c.customerWorkspaceId === s.customerWorkspaceId) priorWorkspace.push(value);
    }
  }
  // Changing the requested key/workspace cannot hide another allocation's
  // overrun and spend backing that has already become somebody else's debt.
  for (const [key, value] of priorByKey) {
    if (subtract(grantsByKey.get(key) ?? '0', value) === null) return refuse('funding-overspent');
  }
  for (const [key, value] of priorByWorkspace) {
    const grant = workspaceGrants.get(key);
    if (grant !== undefined && subtract(grant, value) === null) return refuse('funding-overspent');
  }
  const organization = subtract(addMicrosDecimals(...org), addMicrosDecimals(...priorOrg));
  const workspaceGrant = workspaceGrants.has(workspaceKey(s.customerWorkspaceId, input.budgetKey));
  const scoped = workspaceGrant ? subtract(addMicrosDecimals(...workspace), addMicrosDecimals(...priorWorkspace)) : '0';
  if (organization === null || scoped === null) return refuse('funding-overspent');
  const cashProblem = cashBackingProblem(input);
  if (cashProblem) return refuse(cashProblem);
  return { ok: true, organization: amount(organization), workspace: workspaceGrant ? amount(scoped) : null, evidenceRef: v.evidenceRef };
}
