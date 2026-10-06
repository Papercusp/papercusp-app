/**
 * SDK-free Stripe client for hosted subscription billing: one customer per
 * organization, subscription-mode Checkout, and customer-portal sessions.
 *
 * Writes use the cupboard adapter's `postStripeForm`; evidence reads use
 * authenticated GETs with request provenance and redirects refused.
 * The secret key is resolved by the caller from an injected reference;
 * it is never read from the tree.
 *
 * LIVE MODE IS AN OWNER-AUTHORITY ACTION. A live key (`sk_live_…`/`rk_live_…`)
 * charges real cards, so the client refuses to construct with one unless the
 * caller has established that the default-OFF `papercusp-hosted-billing-live-mode`
 * flag is on. Test keys are always accepted.
 *
 * stripe-subscription-signup-2026-10-01 P-004.
 */
// Import the contract SHAPE from the dependency-free leaf, never from
// `identity-refusal-contract`: this module sits in the portal-prebundled hosted cone and
// `hosted-auth-runtime.bundle-cone.test.ts` walks `import type` edges too (WI-10005197).
import type { RefusalContract } from '../../../capability-envelope/refusal-contract-types';
import { createHash } from 'node:crypto';
import { postStripeForm } from '../../../cupboard/payment-adapters/stripe';
import type { StripeBalanceTransaction } from '../../../cupboard/money-journal-producers';

export const STRIPE_API_BASE = 'https://api.stripe.com/v1';

export type StripeKeyMode = 'test' | 'live';

/** Classify a Stripe secret/restricted key without echoing it. */
export function stripeKeyMode(secretKey: string): StripeKeyMode | null {
  if (/^(sk|rk)_test_[A-Za-z0-9]+$/.test(secretKey)) return 'test';
  if (/^(sk|rk)_live_[A-Za-z0-9]+$/.test(secretKey)) return 'live';
  return null;
}

export type StripeBillingCallResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly code: 'provider-error' | 'malformed-response'; readonly status: number | null; readonly detail: string };

export interface StripeBillingClient {
  readonly livemode: boolean;
  /** Read-only provider evidence. This is NOT a payment/reversal census or
   * transaction-bound funding authority; it must be reconciled with those. */
  readAccountCash(input: {
    readonly accountId: string;
    readonly customerId: string;
    readonly organizationId: string;
  }, signal?: AbortSignal): Promise<StripeBillingCallResult<{ evidence: StripeAccountCashEvidence }>>;
  /** Exhaustive, unfiltered account history. Receipt/journal/reversal mapping
   * and freshness reconciliation are still required before funding admission. */
  readAccountTransactions(input: {
    readonly accountId: string;
    readonly maxPages?: number;
  }, signal?: AbortSignal): Promise<StripeBillingCallResult<{ evidence: StripeAccountTransactionEvidence }>>;
  /** Exhaust every charge/refund/dispute list, including sources with no
   * posted balance transaction. These separate lists are not an atomic
   * snapshot: reconcile their collection interval with fresh movements/cash
   * and the complete locked journal before admitting any funded work. */
  readAccountPaymentSources(input: {
    readonly accountId: string;
    /** Per endpoint. Reaching the bound discards the entire partial result. */
    readonly maxPages?: number;
  }, signal?: AbortSignal): Promise<StripeBillingCallResult<{ evidence: StripeAccountPaymentSourceEvidence }>>;
  /** Resolve one payment/reversal against the original receipt's charge and
   * balance-transaction pins. This is evidence, not finality, completeness,
   * journal reconciliation or permission to spend. Pins must come from the
   * server's stored receipt/customer mapping, never a customer request body. */
  readPaymentLineage(input: StripePaymentLineagePin, signal?: AbortSignal): Promise<StripeBillingCallResult<{ evidence: StripePaymentLineageEvidence }>>;
  createCustomer(input: {
    organizationId: string;
    email?: string | null;
    name?: string | null;
  }): Promise<StripeBillingCallResult<{ customerId: string }>>;
  createSubscriptionCheckout(input: {
    customerId: string;
    organizationId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<StripeBillingCallResult<{ sessionId: string; url: string }>>;
  createPortalSession(input: {
    customerId: string;
    returnUrl: string;
    /** `bpc_…`; absent = Stripe's dashboard default configuration (which must then exist). */
    configurationId?: string | null;
  }): Promise<StripeBillingCallResult<{ url: string }>>;
}

export interface StripeAccountCashEvidence {
  readonly accountId: string;
  readonly customerId: string;
  readonly organizationId: string;
  /** Verified on BOTH the authenticated balance and customer responses. */
  readonly livemode: boolean;
  /** Signed cents. Negative cash remains negative; pending cash is separate. */
  readonly availableUsdCents: number;
  readonly pendingUsdCents: number;
  readonly observedAtMs: number;
  readonly requestIds: readonly string[];
  readonly evidenceRef: string;
}

export interface StripeAccountTransactionEvidence {
  readonly accountId: string;
  readonly observedAtMs: number;
  readonly requestIds: readonly string[];
  readonly transactions: readonly StripeObservedBalanceTransaction[];
  readonly evidenceRef: string;
}

export interface StripeObservedBalanceTransaction extends StripeBalanceTransaction {
  readonly object: 'balance_transaction';
  readonly status: 'available' | 'pending';
  readonly available_on: number;
  readonly net: number;
}

export interface StripeListedCharge {
  readonly id: string;
  readonly customerId: string | null;
  readonly currency: string;
  readonly amountCents: number;
  readonly capturedCents: number;
  readonly refundedCents: number;
  readonly paid: boolean;
  readonly captured: boolean;
  readonly status: string;
  readonly created: number;
  readonly balanceTransactionId: string | null;
  readonly failureBalanceTransactionId: string | null;
}
export interface StripeListedRefund {
  readonly id: string;
  readonly chargeId: string;
  readonly currency: string;
  readonly amountCents: number;
  readonly status: string;
  readonly created: number;
  readonly balanceTransactionId: string | null;
  readonly failureBalanceTransactionId: string | null;
}
export interface StripeListedDispute {
  readonly id: string;
  readonly chargeId: string;
  readonly currency: string;
  readonly amountCents: number;
  readonly status: string;
  readonly created: number;
  readonly balanceTransactionIds: readonly string[];
}
export interface StripeAccountPaymentSourceEvidence {
  readonly accountId: string;
  /** Charges/disputes match the credential mode; refunds bind through their
   * original charge. This is mode evidence, never a finality assertion. */
  readonly livemode: boolean;
  readonly collectionStartedAtMs: number;
  readonly observedAtMs: number;
  readonly requestIds: readonly string[];
  readonly charges: readonly StripeListedCharge[];
  readonly refunds: readonly StripeListedRefund[];
  readonly disputes: readonly StripeListedDispute[];
  readonly evidenceRef: string;
}

const REFUND_STATUSES = ['pending', 'requires_action', 'succeeded', 'failed', 'canceled'];
const DISPUTE_STATUSES = ['warning_needs_response', 'warning_under_review', 'warning_closed',
  'needs_response', 'under_review', 'won', 'lost', 'prevented'];

export interface StripePaymentLineagePin {
  readonly accountId: string;
  readonly customerId: string;
  readonly organizationId: string;
  readonly chargeId: string;
  readonly chargeBalanceTransactionId: string;
  readonly source: { readonly kind: 'charge' | 'refund' | 'dispute'; readonly id: string };
}

export interface StripePaymentLineageEvidence {
  readonly accountId: string;
  readonly customerId: string;
  readonly organizationId: string;
  /** Verified on the original charge/customer and, for disputes, the dispute.
   * Refunds do not expose livemode; their mode is bound through their charge. */
  readonly livemode: boolean;
  readonly charge: {
    readonly id: string;
    readonly capturedUsdCents: number;
    readonly refundedUsdCents: number;
    readonly balanceTransaction: StripeObservedBalanceTransaction;
  };
  readonly source: {
    readonly kind: 'charge' | 'refund' | 'dispute';
    readonly id: string;
    readonly status: string;
    readonly amountUsdCents: number;
    /** Includes both withdrawal and reinstatement/failure movements. Empty
     * means no posted movement was returned, never that the obligation ended. */
    readonly balanceTransactions: readonly StripeObservedBalanceTransaction[];
  };
  readonly observedAtMs: number;
  readonly requestIds: readonly string[];
  readonly evidenceRef: string;
}

const referenceId = (value: unknown): unknown => object(value) ? value.id : value;
const wholeNonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function validBalanceTransaction(row: unknown): row is StripeObject {
  return object(row) && row.object === 'balance_transaction' && typeof row.id === 'string' && /^txn_[A-Za-z0-9]+$/.test(row.id)
    && typeof row.type === 'string' && !!row.type && Number.isSafeInteger(row.amount)
    && wholeNonnegative(row.fee) && Number.isSafeInteger(row.net)
    && BigInt(row.net as number) === BigInt(row.amount as number) - BigInt(row.fee)
    && typeof row.currency === 'string' && /^[a-z]{3}$/.test(row.currency)
    && wholeNonnegative(row.created) && wholeNonnegative(row.available_on)
    && ['available', 'pending'].includes(row.status as string);
}

function freezeEvidence<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeEvidence(child);
    Object.freeze(value);
  }
  return value;
}

type StripeObject = Record<string, unknown>;
const object = (value: unknown): value is StripeObject => !!value && typeof value === 'object' && !Array.isArray(value);
function usdBalance(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const currencies = new Set<string>();
  let usd = 0;
  for (const row of value) {
    if (!object(row) || typeof row.currency !== 'string' || !/^[a-z]{3}$/.test(row.currency)
        || !Number.isSafeInteger(row.amount) || currencies.has(row.currency)) return null;
    currencies.add(row.currency);
    if (row.currency === 'usd') usd = row.amount as number;
  }
  return usd;
}

export type StripeBillingClientConstruction =
  | { readonly ok: true; readonly client: StripeBillingClient }
  | { readonly ok: false; readonly code: 'invalid_secret_key' }
  | { readonly ok: false; readonly code: 'invalid_read_timeout' }
  | { readonly ok: false; readonly code: 'live_mode_not_allowed'; readonly refusal: RefusalContract };

const malformed = (status: number, detail: string) =>
  ({ ok: false as const, code: 'malformed-response' as const, status, detail });

export function createStripeBillingClient(input: {
  secretKey: string;
  fetchImpl: typeof fetch;
  /** The resolved value of the default-OFF owner-authority live-mode flag. */
  liveModeAllowed: boolean;
  /** May shorten the 10-second authenticated GET deadline, never disable it. */
  readTimeoutMs?: number;
}): StripeBillingClientConstruction {
  // Pin injected credentials/transport once; mutation of the composition's
  // options must not switch the account between authenticated reads.
  const { secretKey, fetchImpl } = input;
  const readTimeoutMs = input.readTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1 || readTimeoutMs > 10_000) {
    return { ok: false, code: 'invalid_read_timeout' };
  }
  const mode = stripeKeyMode(secretKey);
  if (!mode) return { ok: false, code: 'invalid_secret_key' };
  if (mode === 'live' && !input.liveModeAllowed) {
    return {
      ok: false,
      code: 'live_mode_not_allowed',
      refusal: {
        observed: { keyMode: 'live', liveModeAllowed: 'false' },
        liftsWhen:
          'the owner turns the default-OFF `papercusp-hosted-billing-live-mode` flag on, or the deployment is ' +
          'given a test-mode (sk_test_/rk_test_) Stripe key. Retrying with the same live key and flag changes nothing',
        whoCanMakeItTrue: ['owner'],
      } satisfies RefusalContract,
    };
  }
  const post = (path: string, params: Record<string, unknown>, idempotencyKey?: string) =>
    postStripeForm({ url: `${STRIPE_API_BASE}${path}`, secretKey, params, fetchImpl, idempotencyKey });
  const get = async (path: string, parentSignal?: AbortSignal): Promise<StripeBillingCallResult<{ body: StripeObject; requestId: string; status: number }>> => {
    const controller = new AbortController();
    const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
    const started = performance.now();
    // Keep the deadline through body consumption. Aborting the actual fetch
    // cancels transport/body I/O; a detached Promise timeout would not do that.
    const timer = setTimeout(() => controller.abort(), readTimeoutMs);
    try {
      signal.throwIfAborted();
      const response = await fetchImpl(`${STRIPE_API_BASE}${path}`, {
        method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${secretKey}` },
        signal,
      });
      signal.throwIfAborted();
      // Never copy an error body, URL or transport exception containing a key
      // or customer PII into the evidence/result.
      if (!response.ok) return { ok: false, code: 'provider-error', status: response.status, detail: 'stripe authenticated read failed' };
      const body: unknown = await response.json();
      signal.throwIfAborted();
      if (performance.now() - started >= readTimeoutMs) throw new Error('stripe read deadline');
      const requestId = response.headers.get('request-id');
      if (!object(body) || !requestId || !/^req_[A-Za-z0-9]+$/.test(requestId)) {
        return malformed(response.status, 'stripe read lacks an object or request provenance');
      }
      return { ok: true, body, requestId, status: response.status };
    } catch {
      return { ok: false, code: 'provider-error', status: null, detail: 'stripe authenticated read failed' };
    } finally {
      clearTimeout(timer);
      // An error status returns without consuming its response body. Abort
      // that transport too, rather than clearing its only deadline while an
      // unread streaming body keeps the request alive.
      controller.abort();
    }
  };

  const readScope = async (accountId: string, customerId: string, organizationId: string, signal?: AbortSignal): Promise<StripeBillingCallResult<{ requestIds: string[] }>> => {
    if (!/^acct_[A-Za-z0-9]+$/.test(accountId) || !/^cus_[A-Za-z0-9]+$/.test(customerId)
        || typeof organizationId !== 'string' || !organizationId.trim()) return malformed(0, 'invalid pinned stripe scope');
    const account = await get('/account', signal);
    if (!account.ok) return account;
    if (account.body.object !== 'account' || account.body.id !== accountId) return malformed(account.status, 'stripe account pin mismatch');
    const customer = await get(`/customers/${customerId}`, signal);
    if (!customer.ok) return customer;
    if (customer.body.object !== 'customer' || customer.body.id !== customerId || customer.body.deleted === true
        || customer.body.livemode !== (mode === 'live') || !object(customer.body.metadata)
        || customer.body.metadata.organizationId !== organizationId) return malformed(customer.status, 'stripe customer pin mismatch');
    return { ok: true, requestIds: [account.requestId, customer.requestId] };
  };

  const readMovement = async (id: string, sourceId: string, signal?: AbortSignal): Promise<StripeBillingCallResult<{ transaction: StripeObservedBalanceTransaction; requestId: string }>> => {
    const result = await get(`/balance_transactions/${id}`, signal);
    if (!result.ok) return result;
    const row = result.body;
    if (!validBalanceTransaction(row) || row.id !== id || row.currency !== 'usd' || referenceId(row.source) !== sourceId) {
      return malformed(result.status, 'stripe payment movement pin mismatch');
    }
    // Select accounting fields only. Expanded source/customer/card/dispute
    // evidence and arbitrary metadata must not escape into funding evidence.
    const transaction = { id, object: 'balance_transaction' as const, source: sourceId,
      type: row.type as string, amount: row.amount as number, fee: row.fee as number, net: row.net as number,
      currency: 'usd', created: row.created as number, available_on: row.available_on as number,
      status: row.status as 'available' | 'pending' };
    return { ok: true, transaction, requestId: result.requestId };
  };

  // Select accounting pins only: card/address/refund destination/dispute
  // evidence and metadata never enter this account-level census.
  const balancePin = (v: unknown) => v == null || (typeof referenceId(v) === 'string'
    && /^txn_[A-Za-z0-9]+$/.test(referenceId(v) as string));
  const selectedBalancePin = (v: unknown) => (referenceId(v) ?? null) as string | null;
  const sourceShape = (row: StripeObject, kind: string, prefix: string) => row.object === kind
    && typeof row.id === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(row.id)
    && typeof row.currency === 'string' && /^[a-z]{3}$/.test(row.currency)
    && wholeNonnegative(row.amount) && wholeNonnegative(row.created)
    && Number.isSafeInteger((row.created as number) * 1000);

  const selectCharge = (row: StripeObject): StripeListedCharge | null => {
    const customer = referenceId(row.customer);
    if (!sourceShape(row, 'charge', 'ch') || row.livemode !== (mode === 'live')
        || typeof row.paid !== 'boolean' || typeof row.captured !== 'boolean'
        || !['pending', 'succeeded', 'failed'].includes(row.status as string)
        || !wholeNonnegative(row.amount_captured) || !wholeNonnegative(row.amount_refunded)
        || row.amount_captured > (row.amount as number) || row.amount_refunded > row.amount_captured
        || !Object.hasOwn(row, 'customer') || (row.customer !== null && (typeof customer !== 'string' || !/^cus_[A-Za-z0-9]+$/.test(customer)))
        || !Object.hasOwn(row, 'balance_transaction') || !balancePin(row.balance_transaction)
        || !balancePin(row.failure_balance_transaction)) return null;
    return { id: row.id as string, customerId: customer as string | null, currency: row.currency as string,
      amountCents: row.amount as number, capturedCents: row.amount_captured, refundedCents: row.amount_refunded,
      paid: row.paid, captured: row.captured, status: row.status as string, created: row.created as number,
      balanceTransactionId: selectedBalancePin(row.balance_transaction),
      failureBalanceTransactionId: selectedBalancePin(row.failure_balance_transaction) };
  };
  const selectRefund = (row: StripeObject): StripeListedRefund | null => {
    const chargeId = referenceId(row.charge);
    if (!sourceShape(row, 'refund', 're') || row.amount === 0 || typeof chargeId !== 'string' || !/^ch_[A-Za-z0-9]+$/.test(chargeId)
        || !REFUND_STATUSES.includes(row.status as string) || !Object.hasOwn(row, 'balance_transaction')
        || !balancePin(row.balance_transaction) || !balancePin(row.failure_balance_transaction)) return null;
    const debit = selectedBalancePin(row.balance_transaction); const failure = selectedBalancePin(row.failure_balance_transaction);
    const terminalFailure = ['failed', 'canceled'].includes(row.status as string);
    if ((row.status === 'succeeded' && debit === null) || (failure !== null && (!terminalFailure || debit === null))
        || (terminalFailure && debit !== null && failure === null)) return null;
    return { id: row.id as string, chargeId, currency: row.currency as string, amountCents: row.amount as number,
      status: row.status as string, created: row.created as number, balanceTransactionId: debit, failureBalanceTransactionId: failure };
  };
  const selectDispute = (row: StripeObject): StripeListedDispute | null => {
    const chargeId = referenceId(row.charge);
    if (!sourceShape(row, 'dispute', 'du') || row.amount === 0 || typeof chargeId !== 'string' || !/^ch_[A-Za-z0-9]+$/.test(chargeId)
        || row.livemode !== (mode === 'live') || !DISPUTE_STATUSES.includes(row.status as string)
        || !Array.isArray(row.balance_transactions) || row.balance_transactions.length > 2
        || row.balance_transactions.some(v => !balancePin(v) || v == null)) return null;
    return { id: row.id as string, chargeId, currency: row.currency as string, amountCents: row.amount as number,
      status: row.status as string, created: row.created as number,
      balanceTransactionIds: row.balance_transactions.map(v => referenceId(v) as string) };
  };
  const listSources = async <T extends { readonly id: string }>(path: string, maxPages: number,
    select: (row: StripeObject) => T | null, signal?: AbortSignal): Promise<StripeBillingCallResult<{ rows: T[]; requestIds: string[] }>> => {
    const rows: T[] = []; const seen = new Set<string>(); const requestIds: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const query = new URLSearchParams({ limit: '100' });
      if (cursor) query.set('starting_after', cursor);
      // No customer, charge, date, currency, status or payment filters: an
      // unposted reversal or another customer's liability cannot be hidden.
      const result = await get(`${path}?${query}`, signal);
      if (!result.ok) return result;
      const { data, has_more: more } = result.body;
      if (result.body.object !== 'list' || !Array.isArray(data) || data.length > 100 || typeof more !== 'boolean'
          || (more && data.length === 0) || (result.body.url !== undefined && result.body.url !== `/v1${path}`)) {
        return malformed(result.status, 'incomplete stripe payment source page');
      }
      requestIds.push(result.requestId);
      for (const raw of data) {
        const row = object(raw) ? select(raw) : null;
        if (!row || seen.has(row.id)) return malformed(result.status, 'invalid or duplicate stripe payment source');
        seen.add(row.id); rows.push(row);
      }
      if (!more) return { ok: true, rows, requestIds };
      cursor = rows.at(-1)!.id;
    }
    return malformed(0, 'stripe payment source census exceeds page budget');
  };

  const client: StripeBillingClient = {
    livemode: mode === 'live',

    async readAccountCash(input, signal) {
      const { accountId, customerId, organizationId } = input;
      // /account identifies the credential's own account. Looking up an
      // arbitrary /accounts/:id could prove access rather than cash ownership.
      const scope = await readScope(accountId, customerId, organizationId, signal);
      if (!scope.ok) return scope;
      const balance = await get('/balance', signal);
      if (!balance.ok) return balance;
      const available = usdBalance(balance.body.available); const pending = usdBalance(balance.body.pending);
      if (balance.body.object !== 'balance' || balance.body.livemode !== (mode === 'live')
          || available === null || pending === null) return malformed(balance.status, 'unverified stripe cash balance');
      const requestIds = Object.freeze([...scope.requestIds, balance.requestId]);
      const observedAtMs = Date.now();
      const selected = { accountId, customerId, organizationId, livemode: mode === 'live',
        availableUsdCents: available, pendingUsdCents: pending, observedAtMs, requestIds };
      const evidenceRef = `stripe-cash:${createHash('sha256').update(JSON.stringify(selected)).digest('hex')}`;
      return { ok: true, evidence: Object.freeze({ ...selected, evidenceRef }) };
    },

    async readAccountTransactions(input, signal) {
      const { accountId, maxPages = 100 } = input;
      if (!/^acct_[A-Za-z0-9]+$/.test(accountId) || !Number.isSafeInteger(maxPages) || maxPages < 1) {
        return malformed(0, 'invalid pinned stripe census scope');
      }
      const account = await get('/account', signal);
      if (!account.ok) return account;
      if (account.body.object !== 'account' || account.body.id !== accountId) return malformed(account.status, 'stripe account pin mismatch');
      const requestIds = [account.requestId];
      const transactions: StripeObservedBalanceTransaction[] = [];
      const seen = new Set<string>();
      let startingAfter: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const query = new URLSearchParams({ limit: '100' });
        if (startingAfter) query.set('starting_after', startingAfter);
        // Same expansions as the journal importer; no customer/date/type/
        // currency filters can omit a refund or another pool obligation.
        query.append('expand[]', 'data.source');
        query.append('expand[]', 'data.source.invoice');
        const result = await get(`/balance_transactions?${query}`, signal);
        if (!result.ok) return result;
        const { data, has_more: more } = result.body;
        if (result.body.object !== 'list' || !Array.isArray(data) || data.length > 100 || typeof more !== 'boolean'
            || (more && data.length === 0)) return malformed(result.status, 'incomplete stripe transaction page');
        requestIds.push(result.requestId);
        for (const row of data) {
          if (!validBalanceTransaction(row) || seen.has(row.id as string)) return malformed(result.status, 'invalid or duplicate stripe transaction');
          // Preserve unknown provider types and complete expanded sources for
          // the journal/reversal verifier to refuse or reconcile explicitly.
          seen.add(row.id as string);
          // Detach provider JSON before handing it to other server readers.
          transactions.push(JSON.parse(JSON.stringify(row)) as StripeObservedBalanceTransaction);
        }
        if (!more) {
          const observedAtMs = Date.now();
          const evidenceRef = `stripe-census:${createHash('sha256').update(JSON.stringify({ accountId, observedAtMs, requestIds, transactions })).digest('hex')}`;
          return { ok: true, evidence: freezeEvidence({ accountId, observedAtMs, requestIds, transactions, evidenceRef }) };
        }
        startingAfter = transactions.at(-1)!.id;
      }
      // A page budget is an operational bound, never proof of completeness.
      // Discard partial history rather than returning a successful census.
      return malformed(0, 'stripe transaction census exceeds page budget');
    },

    async readAccountPaymentSources(input, signal) {
      const { accountId, maxPages = 100 } = input;
      if (!/^acct_[A-Za-z0-9]+$/.test(accountId) || !Number.isSafeInteger(maxPages) || maxPages < 1) {
        return malformed(0, 'invalid pinned stripe payment source scope');
      }
      const collectionStartedAtMs = Date.now();
      const account = await get('/account', signal);
      if (!account.ok) return account;
      if (account.body.object !== 'account' || account.body.id !== accountId) return malformed(account.status, 'stripe account pin mismatch');
      const charges = await listSources('/charges', maxPages, selectCharge, signal);
      if (!charges.ok) return charges;
      const refunds = await listSources('/refunds', maxPages, selectRefund, signal);
      if (!refunds.ok) return refunds;
      const disputes = await listSources('/disputes', maxPages, selectDispute, signal);
      if (!disputes.ok) return disputes;
      const originals = new Map(charges.rows.map(c => [c.id, c]));
      const movements = new Set<string>();
      for (const c of charges.rows) {
        for (const id of [c.balanceTransactionId, c.failureBalanceTransactionId]) {
          if (id !== null && movements.has(id)) return malformed(0, 'duplicate stripe payment source movement');
          if (id !== null) movements.add(id);
        }
      }
      for (const reversal of [...refunds.rows, ...disputes.rows]) {
        const original = originals.get(reversal.chargeId);
        if (!original || original.currency !== reversal.currency || reversal.amountCents > original.capturedCents
            || reversal.created < original.created) return malformed(0, 'stripe payment source original charge mismatch');
        const ids = 'balanceTransactionIds' in reversal ? reversal.balanceTransactionIds
          : [reversal.balanceTransactionId, reversal.failureBalanceTransactionId].filter((id): id is string => id !== null);
        for (const id of ids) {
          if (movements.has(id)) return malformed(0, 'duplicate stripe payment source movement');
          movements.add(id);
        }
      }
      const selected = { accountId, livemode: mode === 'live', collectionStartedAtMs, observedAtMs: Date.now(),
        requestIds: [account.requestId, ...charges.requestIds, ...refunds.requestIds, ...disputes.requestIds],
        charges: charges.rows, refunds: refunds.rows, disputes: disputes.rows };
      const evidenceRef = `stripe-payment-sources:${createHash('sha256').update(JSON.stringify(selected)).digest('hex')}`;
      return { ok: true, evidence: freezeEvidence({ ...selected, evidenceRef }) };
    },

    async readPaymentLineage(input, signal) {
      // Snapshot nested caller pins too: an await must not permit changing the
      // original receipt or the reversal whose provenance is being verified.
      const { accountId, customerId, organizationId, chargeId, chargeBalanceTransactionId } = input;
      const kind = input.source?.kind; const sourceId = input.source?.id;
      const prefixes = { charge: 'ch', refund: 're', dispute: 'du' } as const;
      if (!/^ch_[A-Za-z0-9]+$/.test(chargeId) || !/^txn_[A-Za-z0-9]+$/.test(chargeBalanceTransactionId)
          || !Object.hasOwn(prefixes, kind) || typeof sourceId !== 'string'
          || !new RegExp(`^${prefixes[kind]}_[A-Za-z0-9]+$`).test(sourceId)
          || (kind === 'charge' && sourceId !== chargeId)) return malformed(0, 'invalid stripe payment lineage pins');
      const scope = await readScope(accountId, customerId, organizationId, signal);
      if (!scope.ok) return scope;
      const requestIds = [...scope.requestIds];
      let reversal: StripeObject | null = null;
      if (kind !== 'charge') {
        const result = await get(`/${kind === 'refund' ? 'refunds' : 'disputes'}/${sourceId}`, signal);
        if (!result.ok) return result;
        reversal = result.body; requestIds.push(result.requestId);
        if (reversal.object !== kind || reversal.id !== sourceId || referenceId(reversal.charge) !== chargeId
            || reversal.currency !== 'usd' || !wholeNonnegative(reversal.amount) || reversal.amount <= 0
            || (kind === 'dispute' && reversal.livemode !== (mode === 'live'))
            || (reversal.customer != null && referenceId(reversal.customer) !== customerId)) {
          return malformed(result.status, 'stripe reversal charge pin mismatch');
        }
      }
      const chargeResult = await get(`/charges/${chargeId}`, signal);
      if (!chargeResult.ok) return chargeResult;
      const charge = chargeResult.body; requestIds.push(chargeResult.requestId);
      if (charge.object !== 'charge' || charge.id !== chargeId || referenceId(charge.customer) !== customerId
          || charge.livemode !== (mode === 'live') || charge.currency !== 'usd'
          || charge.status !== 'succeeded' || charge.paid !== true || charge.captured !== true
          || !wholeNonnegative(charge.amount) || !wholeNonnegative(charge.amount_captured) || charge.amount_captured <= 0
          || charge.amount_captured > charge.amount || !wholeNonnegative(charge.amount_refunded)
          || charge.amount_refunded > charge.amount_captured
          || referenceId(charge.balance_transaction) !== chargeBalanceTransactionId) return malformed(chargeResult.status, 'stripe original charge pin mismatch');
      const original = await readMovement(chargeBalanceTransactionId, chargeId, signal);
      if (!original.ok) return original;
      requestIds.push(original.requestId);
      if (!['charge', 'payment'].includes(original.transaction.type) || original.transaction.amount !== charge.amount_captured) {
        return malformed(0, 'stripe original charge accounting mismatch');
      }
      const movements: StripeObservedBalanceTransaction[] = [];
      let status = 'succeeded'; let amount = charge.amount_captured;
      if (reversal) {
        status = reversal.status as string; amount = reversal.amount as number;
        let ids: string[];
        if (kind === 'refund') {
          if (!REFUND_STATUSES.includes(status) || amount > charge.amount_captured) {
            return malformed(0, 'invalid stripe refund state');
          }
          const debit = referenceId(reversal.balance_transaction); const failure = referenceId(reversal.failure_balance_transaction);
          const terminalFailure = ['failed', 'canceled'].includes(status);
          if ((debit != null && (typeof debit !== 'string' || !/^txn_[A-Za-z0-9]+$/.test(debit)))
              || (failure != null && (typeof failure !== 'string' || !/^txn_[A-Za-z0-9]+$/.test(failure)))
              || (status === 'succeeded' && debit == null)
              || (failure != null && (!terminalFailure || debit == null))
              || (terminalFailure && debit != null && failure == null)) return malformed(0, 'incomplete stripe refund movements');
          ids = [debit, failure].filter((id): id is string => typeof id === 'string');
        } else {
          if (!DISPUTE_STATUSES.includes(status)
              || !Array.isArray(reversal.balance_transactions) || reversal.balance_transactions.length > 2) return malformed(0, 'invalid stripe dispute state');
          ids = reversal.balance_transactions.map(referenceId) as string[];
        }
        if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^txn_[A-Za-z0-9]+$/.test(id) || id === chargeBalanceTransactionId)) {
          return malformed(0, 'invalid stripe reversal movement pins');
        }
        for (const [index, id] of ids.entries()) {
          const movement = await readMovement(id, sourceId, signal);
          if (!movement.ok) return movement;
          const bt = movement.transaction;
          const correctAccounting = kind === 'refund'
            ? (index === 0 ? ['refund', 'payment_refund'].includes(bt.type) && bt.amount === -amount
              : bt.type === 'refund_failure' && bt.amount === amount)
            : bt.type === 'adjustment' && (bt.amount === -amount || bt.amount === amount);
          if (!correctAccounting) return malformed(0, 'stripe reversal accounting mismatch');
          movements.push(bt); requestIds.push(movement.requestId);
        }
      }
      const selected = { accountId, customerId, organizationId, livemode: mode === 'live',
        charge: { id: chargeId, capturedUsdCents: charge.amount_captured, refundedUsdCents: charge.amount_refunded, balanceTransaction: original.transaction },
        source: { kind, id: sourceId, status, amountUsdCents: amount, balanceTransactions: kind === 'charge' ? [original.transaction] : movements },
        observedAtMs: Date.now(), requestIds };
      const evidenceRef = `stripe-lineage:${createHash('sha256').update(JSON.stringify(selected)).digest('hex')}`;
      return { ok: true, evidence: freezeEvidence({ ...selected, evidenceRef }) };
    },

    async createCustomer({ organizationId, email, name }) {
      // Stripe's idempotency window is 24h; the store's unique (organization_id)
      // row is the durable one-customer-per-org guarantee beyond it.
      const posted = await post('/customers', {
        email: email ?? undefined,
        name: name ?? undefined,
        metadata: { organizationId },
      }, `papercusp-org-customer:${organizationId}`);
      if (!posted.ok) return posted;
      const id = posted.body.id;
      if (typeof id !== 'string' || !/^cus_[A-Za-z0-9]+$/.test(id)) return malformed(posted.status, 'stripe response carried no customer id');
      return { ok: true, customerId: id };
    },

    async createSubscriptionCheckout({ customerId, organizationId, priceId, successUrl, cancelUrl, idempotencyKey }) {
      const posted = await post('/checkout/sessions', {
        mode: 'subscription',
        customer: customerId,
        client_reference_id: organizationId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: { organizationId, purpose: 'hosted-subscription' },
        // The org id must ride on the SUBSCRIPTION itself: every later
        // customer.subscription.* webhook is attributed from it (and verified
        // against the customer mapping), independent of checkout delivery order.
        subscription_data: { metadata: { organizationId } },
        // Same measured account default as the cupboard Checkout builder:
        // Managed Payments makes Stripe merchant of record and 400s line items
        // without a product tax code. We settle directly (P-038, 2026-09-06).
        managed_payments: { enabled: false },
      }, idempotencyKey);
      if (!posted.ok) return posted;
      const { id, url } = posted.body;
      if (typeof id !== 'string' || !id) return malformed(posted.status, 'stripe response carried no session id');
      if (typeof url !== 'string' || !url) return malformed(posted.status, 'stripe response carried no checkout url');
      return { ok: true, sessionId: id, url };
    },

    async createPortalSession({ customerId, returnUrl, configurationId }) {
      // An explicit portal configuration (created through the API) beats the account's dashboard
      // default: portal behaviour then lives in injected config, not in un-versioned dashboard state.
      const posted = await post('/billing_portal/sessions', {
        customer: customerId,
        return_url: returnUrl,
        ...(configurationId ? { configuration: configurationId } : {}),
      });
      if (!posted.ok) return posted;
      const { url } = posted.body;
      if (typeof url !== 'string' || !url) return malformed(posted.status, 'stripe response carried no portal url');
      return { ok: true, url };
    },
  };
  return { ok: true, client };
}
