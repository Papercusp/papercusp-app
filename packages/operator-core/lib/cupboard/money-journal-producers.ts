/**
 * Money-journal producers (agent-economy-flywheel-2026-08-30 P-042, R-30, D-023).
 *
 * The journal (`money-journal.ts`) knows how to turn a `MoneyMovement` into a
 * balanced entry. This module is where real money movements become those
 * movements:
 *
 *   - Stripe: one entry per BALANCE TRANSACTION. The balance-transaction list is
 *     the authoritative ledger of every movement on the Stripe account — a
 *     subscription invoice, a cupboard checkout, a prepaid-credit purchase, a
 *     refund, a lost dispute, a Stripe fee — whichever code path created it.
 *     Webhook payloads carry neither the balance-transaction id nor the fee, so
 *     they cannot be the producer (D-023).
 *   - Chain: a treasury Safe transfer to the DAO becomes a `dao-transfer` keyed
 *     by its transaction hash.
 *
 * Every balance transaction gets exactly one verdict: an entry, a SKIP with a
 * reason (a payout moves money between two places that are both `operating`),
 * or UNMAPPED with a reason. Unmapped is reported to the caller, never dropped,
 * so a movement type nobody anticipated is visible instead of silently absent
 * from the books.
 */

import {
  daoShareCents,
  journalEntryForMovement,
  type JournalEntry,
  type JournalRejection,
  type MoneyMovement,
} from './money-journal';

// ---------------------------------------------------------------------------
// Policy.
// ---------------------------------------------------------------------------

export interface CustomerPaymentPolicy {
  /** The DAO's share of net revenue (gross minus tax), in basis points. */
  readonly daoBasisPoints: number;
  /** The refund/chargeback provision set aside from net revenue, in basis points. */
  readonly refundReserveBasisPoints: number;
}

export function validatePolicy(policy: CustomerPaymentPolicy): string | null {
  for (const [name, bps] of [
    ['daoBasisPoints', policy.daoBasisPoints],
    ['refundReserveBasisPoints', policy.refundReserveBasisPoints],
  ] as const) {
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) return `${name} must be an integer 0-10000, got ${bps}`;
  }
  if (policy.daoBasisPoints + policy.refundReserveBasisPoints > 10_000) {
    return 'daoBasisPoints + refundReserveBasisPoints exceed 10000';
  }
  return null;
}

/** Floor of `cents x bps / 10,000` (the same rounding as the DAO share). */
function basisPointsOf(cents: number, bps: number): number {
  return Math.floor((cents * bps) / 10_000);
}

// ---------------------------------------------------------------------------
// Stripe balance transactions.
// ---------------------------------------------------------------------------

/** The fields of a Stripe balance transaction (with `source` expanded) that the journal reads. */
export interface StripeBalanceTransaction {
  readonly id: string;
  readonly type: string;
  /** Signed minor units; negative when money leaves the balance. */
  readonly amount: number;
  /** Stripe's fee on this transaction, in minor units (>= 0). */
  readonly fee: number;
  readonly currency: string;
  /** Unix seconds. */
  readonly created: number;
  readonly source?: string | StripeBalanceSource | null;
}

export interface StripeBalanceSource {
  readonly id: string;
  readonly object: string;
  readonly metadata?: Readonly<Record<string, string>> | null;
  /** On a charge: the invoice it paid, expanded or as an id. */
  readonly invoice?: string | StripeInvoiceTaxView | null;
  /** On a charge or refund: the Stripe customer, which is who a payment receipt belongs to (P-046). */
  readonly customer?: string | { readonly id: string } | null;
}

export interface StripeInvoiceTaxView {
  readonly id: string;
  /** Current API: the tax lines of the invoice. */
  readonly total_taxes?: ReadonlyArray<{ readonly amount: number }> | null;
  /** Older API versions: the invoice's tax total. */
  readonly tax?: number | null;
}

/** The metadata value that marks a charge as a prepaid-credit purchase (D-023). */
export const PREPAID_CREDITS_PURPOSE = 'prepaid-credits';

export type ProducerVerdict =
  | { readonly disposition: 'entry'; readonly entry: JournalEntry }
  | { readonly disposition: 'skip'; readonly sourceId: string; readonly reason: string }
  | { readonly disposition: 'unmapped'; readonly sourceId: string; readonly reason: string };

function sourceObject(bt: StripeBalanceTransaction): StripeBalanceSource | null {
  return bt.source && typeof bt.source === 'object' ? bt.source : null;
}

/**
 * Sales tax collected on the invoice a charge paid. Null when it cannot be
 * known (the invoice was not expanded), which the caller must treat as
 * unmapped: guessing zero would book collected tax as revenue.
 */
export function invoiceTaxCents(source: StripeBalanceSource | null): number | null {
  if (!source || source.object !== 'charge') return 0;
  const invoice = source.invoice;
  if (invoice == null) return 0; // a charge with no invoice (a one-time checkout) carries no invoice tax
  if (typeof invoice === 'string') return null;
  if (Array.isArray(invoice.total_taxes)) {
    let sum = 0;
    for (const line of invoice.total_taxes) {
      if (!Number.isSafeInteger(line?.amount) || line.amount < 0) return null;
      sum += line.amount;
    }
    return sum;
  }
  if (typeof invoice.tax === 'number') return Number.isSafeInteger(invoice.tax) && invoice.tax >= 0 ? invoice.tax : null;
  return 0;
}

function unmapped(bt: StripeBalanceTransaction, reason: string): ProducerVerdict {
  return { disposition: 'unmapped', sourceId: bt.id, reason };
}

function rejected(bt: StripeBalanceTransaction, rejection: JournalRejection): ProducerVerdict {
  return unmapped(bt, `${rejection.code}: ${rejection.detail}`);
}

/** The movement a balance transaction records, before it is built into an entry. */
export function movementForStripeBalanceTransaction(
  bt: StripeBalanceTransaction,
  policy: CustomerPaymentPolicy,
): { ok: true; movement: MoneyMovement; memo: string } | { ok: false; verdict: ProducerVerdict } {
  const fail = (reason: string) => ({ ok: false as const, verdict: unmapped(bt, reason) });
  if (!Number.isSafeInteger(bt.amount) || !Number.isSafeInteger(bt.fee) || bt.fee < 0) {
    return fail('amount and fee must be whole minor units, fee >= 0');
  }
  const source = sourceObject(bt);
  switch (bt.type) {
    case 'charge':
    case 'payment': {
      if (bt.amount <= 0) return fail(`${bt.type} with a non-positive amount`);
      const taxCents = invoiceTaxCents(source);
      if (taxCents === null) return fail('the charge paid an invoice that was not expanded, so its tax is unknown');
      if (taxCents > bt.amount) return fail('invoice tax exceeds the charge');
      if (source?.metadata?.purpose === PREPAID_CREDITS_PURPOSE) {
        return {
          ok: true,
          memo: `prepaid credits ${source.id}`,
          movement: { kind: 'credit-purchase', grossCents: bt.amount, feeCents: bt.fee, taxCents },
        };
      }
      const net = bt.amount - taxCents;
      return {
        ok: true,
        memo: `payment ${source?.id ?? bt.id}`,
        movement: {
          kind: 'customer-payment',
          grossCents: bt.amount,
          feeCents: bt.fee,
          taxCents,
          daoCents: daoShareCents(net, policy.daoBasisPoints),
          refundReserveCents: basisPointsOf(net, policy.refundReserveBasisPoints),
        },
      };
    }
    case 'refund':
    case 'payment_refund': {
      if (bt.amount >= 0) return fail(`${bt.type} with a non-negative amount`);
      if (bt.fee !== 0) return fail(`${bt.type} carries a fee, which has no journal movement`);
      return { ok: true, memo: `refund ${source?.id ?? bt.id}`, movement: { kind: 'refund', amountCents: -bt.amount, taxCents: 0 } };
    }
    case 'adjustment': {
      if (source?.object !== 'dispute') return fail('an adjustment that is not a dispute');
      if (bt.amount >= 0) return fail('a dispute reversal (won dispute) has no journal movement');
      return {
        ok: true,
        memo: `dispute ${source.id}`,
        movement: { kind: 'chargeback', amountCents: -bt.amount, feeCents: bt.fee },
      };
    }
    case 'stripe_fee':
    case 'tax_fee': {
      if (bt.amount >= 0) return fail(`${bt.type} with a non-negative amount`);
      return { ok: true, memo: `stripe fee ${bt.id}`, movement: { kind: 'provider-payment', amountCents: -bt.amount } };
    }
    default:
      return fail(`balance transaction type '${bt.type}' has no journal mapping`);
  }
}

/** Payout-family types move money from the Stripe balance to the bank: both are `operating`. */
const INTERNAL_TRANSFER_TYPES = new Set(['payout', 'payout_cancel', 'payout_failure', 'payout_minimum_balance_hold', 'payout_minimum_balance_release']);

/** Map one Stripe balance transaction to its journal verdict. */
export function journalVerdictForStripeBalanceTransaction(
  bt: StripeBalanceTransaction,
  policy: CustomerPaymentPolicy,
): ProducerVerdict {
  if (INTERNAL_TRANSFER_TYPES.has(bt.type)) {
    return { disposition: 'skip', sourceId: bt.id, reason: 'Stripe balance to bank: both sides are operating' };
  }
  const mapped = movementForStripeBalanceTransaction(bt, policy);
  if (!mapped.ok) return mapped.verdict;
  if (!Number.isSafeInteger(bt.created) || bt.created <= 0) return unmapped(bt, 'created must be positive unix seconds');
  const built = journalEntryForMovement({
    entryId: `stripe-bt:${bt.id}`,
    occurredAtMs: bt.created * 1000,
    currency: String(bt.currency ?? '').toUpperCase(),
    externalRef: { kind: 'stripe-balance-transaction', id: bt.id },
    memo: mapped.memo,
    movement: mapped.movement,
  });
  return built.ok ? { disposition: 'entry', entry: built.entry } : rejected(bt, built);
}

// ---------------------------------------------------------------------------
// Chain: treasury transfers to the DAO's Safe.
// ---------------------------------------------------------------------------

export interface TreasuryTransfer {
  /** EIP-155 chain id the transfer settled on. */
  readonly chainId: number;
  /** The transaction hash of the settled transfer. */
  readonly txHash: string;
  /** The USD value moved, in whole cents. */
  readonly amountCents: number;
  readonly occurredAtMs: number;
  readonly memo?: string;
}

/** A settled treasury transfer pays down DAO payable from operating. */
export function journalVerdictForTreasuryTransfer(transfer: TreasuryTransfer): ProducerVerdict {
  const txHash = String(transfer.txHash).toLowerCase();
  const built = journalEntryForMovement({
    entryId: `chain-tx:${transfer.chainId}:${txHash}`,
    occurredAtMs: transfer.occurredAtMs,
    currency: 'USD',
    externalRef: { kind: 'chain-tx', chainId: transfer.chainId, txHash },
    memo: transfer.memo ?? `dao transfer ${txHash}`,
    movement: { kind: 'dao-transfer', amountCents: transfer.amountCents },
  });
  if (built.ok) return { disposition: 'entry', entry: built.entry };
  return { disposition: 'unmapped', sourceId: String(transfer.txHash), reason: `${built.code}: ${built.detail}` };
}

// ---------------------------------------------------------------------------
// Chain: FINAL settlement claims on the EVM rail (D-032).
// ---------------------------------------------------------------------------

export interface SettlementClaim {
  /** EIP-155 chain id the claim settled on. */
  readonly chainId: number;
  /** The claim transaction's hash. */
  readonly txHash: string;
  /** What the claim moved, in whole cents. */
  readonly grossCents: number;
  /** The DAO's allocation of the batch, in whole cents. */
  readonly daoCents: number;
  /** When the claim became FINAL: a claim that can still be reorged is not money received. */
  readonly occurredAtMs: number;
  readonly memo?: string;
}

/**
 * A final settlement claim is a customer payment over the chain: the gross
 * lands in operating, the DAO's allocation is owed to the DAO, the rest is
 * revenue. The split was fixed when the batch settled, so no policy applies here.
 */
export function journalVerdictForSettlementClaim(claim: SettlementClaim): ProducerVerdict {
  const txHash = String(claim.txHash).toLowerCase();
  const built = journalEntryForMovement({
    entryId: `chain-tx:${claim.chainId}:${txHash}`,
    occurredAtMs: claim.occurredAtMs,
    currency: 'USD',
    externalRef: { kind: 'chain-tx', chainId: claim.chainId, txHash },
    memo: claim.memo ?? `settlement claim ${txHash}`,
    movement: { kind: 'customer-payment', grossCents: claim.grossCents, feeCents: 0, taxCents: 0, daoCents: claim.daoCents, refundReserveCents: 0 },
  });
  if (built.ok) return { disposition: 'entry', entry: built.entry };
  return { disposition: 'unmapped', sourceId: String(claim.txHash), reason: `${built.code}: ${built.detail}` };
}

// ---------------------------------------------------------------------------
// The importer.
// ---------------------------------------------------------------------------

export interface StripeBalanceTransactionPage {
  readonly data: readonly StripeBalanceTransaction[];
  readonly has_more: boolean;
}

export interface StripeBalanceTransactionLister {
  (params: { readonly limit: number; readonly startingAfter?: string; readonly createdGte?: number }): Promise<StripeBalanceTransactionPage>;
}

const STRIPE_BALANCE_TRANSACTIONS_URL = 'https://api.stripe.com/v1/balance_transactions';

/**
 * A lister over the Stripe REST API: one read-only GET per page, with each
 * transaction's source (and a charge's invoice) expanded so fee, tax and
 * purpose need no second fetch. Throws on a transport or provider error so an
 * import run stops rather than recording a partial window as complete.
 */
export function stripeBalanceTransactionLister(input: {
  readonly secretKey: string;
  readonly fetchImpl: typeof fetch;
}): StripeBalanceTransactionLister {
  return async ({ limit, startingAfter, createdGte }) => {
    const query = new URLSearchParams();
    query.set('limit', String(limit));
    if (startingAfter) query.set('starting_after', startingAfter);
    if (createdGte !== undefined) query.set('created[gte]', String(createdGte));
    query.append('expand[]', 'data.source');
    query.append('expand[]', 'data.source.invoice');
    const response = await input.fetchImpl(`${STRIPE_BALANCE_TRANSACTIONS_URL}?${query.toString()}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${input.secretKey}` },
    });
    const text = await response.text();
    let body: { data?: unknown; has_more?: unknown; error?: { message?: unknown } };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`stripe balance_transactions: non-JSON response (${response.status})`);
    }
    if (!response.ok) {
      const detail = typeof body?.error?.message === 'string' ? body.error.message : `status ${response.status}`;
      throw new Error(`stripe balance_transactions: ${detail}`);
    }
    if (!Array.isArray(body.data) || typeof body.has_more !== 'boolean') {
      throw new Error('stripe balance_transactions: response carried no list');
    }
    return { data: body.data as StripeBalanceTransaction[], has_more: body.has_more };
  };
}

export type JournalPoster = (entry: JournalEntry) => Promise<{ ok: true; duplicate: boolean } | { ok: false; code: string; detail: string }>;

export interface ImportReport {
  readonly scanned: number;
  readonly posted: number;
  readonly duplicates: number;
  readonly skipped: ReadonlyArray<{ readonly sourceId: string; readonly reason: string }>;
  readonly unmapped: ReadonlyArray<{ readonly sourceId: string; readonly reason: string }>;
  readonly refused: ReadonlyArray<{ readonly sourceId: string; readonly code: string; readonly detail: string }>;
  /** True when the page budget ran out before Stripe said there was nothing more. */
  readonly truncated: boolean;
}

/**
 * Page the account's balance transactions (newest first, back to `createdGte`)
 * and post an entry for each. Posting is idempotent on entryId, so re-running
 * over an overlapping window is safe and is how a missed run is recovered.
 */
export async function importStripeBalanceTransactions(input: {
  readonly list: StripeBalanceTransactionLister;
  readonly post: JournalPoster;
  readonly policy: CustomerPaymentPolicy;
  readonly createdGte?: number;
  readonly pageSize?: number;
  readonly maxPages?: number;
}): Promise<ImportReport> {
  const policyError = validatePolicy(input.policy);
  if (policyError) throw new Error(`importStripeBalanceTransactions: ${policyError}`);
  const pageSize = input.pageSize ?? 100;
  const maxPages = input.maxPages ?? 20;
  const skipped: Array<{ sourceId: string; reason: string }> = [];
  const unmappedList: Array<{ sourceId: string; reason: string }> = [];
  const refused: Array<{ sourceId: string; code: string; detail: string }> = [];
  let scanned = 0;
  let posted = 0;
  let duplicates = 0;
  let startingAfter: string | undefined;
  let truncated = false;
  for (let page = 0; ; page += 1) {
    if (page >= maxPages) {
      truncated = true;
      break;
    }
    const result = await input.list({ limit: pageSize, startingAfter, createdGte: input.createdGte });
    for (const bt of result.data) {
      scanned += 1;
      const verdict = journalVerdictForStripeBalanceTransaction(bt, input.policy);
      if (verdict.disposition === 'skip') skipped.push({ sourceId: verdict.sourceId, reason: verdict.reason });
      else if (verdict.disposition === 'unmapped') unmappedList.push({ sourceId: verdict.sourceId, reason: verdict.reason });
      else {
        const outcome = await input.post(verdict.entry);
        if (!outcome.ok) refused.push({ sourceId: bt.id, code: outcome.code, detail: outcome.detail });
        else if (outcome.duplicate) duplicates += 1;
        else posted += 1;
      }
    }
    if (!result.has_more || result.data.length === 0) break;
    startingAfter = result.data[result.data.length - 1]!.id;
  }
  return { scanned, posted, duplicates, skipped, unmapped: unmappedList, refused, truncated };
}
