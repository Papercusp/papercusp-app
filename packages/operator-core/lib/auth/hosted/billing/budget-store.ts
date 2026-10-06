/** Durable hosted commitments, not a second funding/payment ledger (P-005).
 *
 * Funding and entitlement authority stay with their existing readers. This
 * receipt table fills the missing accounting term: work admitted but not yet
 * finally billed. All organization writers serialize under one transaction
 * lock; workspace limits share that lock. Process expiry never releases money.
 */
import { createHash } from 'node:crypto';
import { withHostedServiceContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { HostedEntitlementSet } from '../../hosted-entitlement-schema';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { shadowMonthBounds } from '../../../cupboard/shadow-metering-reader';
import { addMicrosDecimals, splitMicrosDecimal } from '../../../cupboard/money-journal';
import { readMoneyJournalEntries } from '../../../cupboard/money-journal-store';
import { pgPaymentReceiptStore, type StoredPaymentReceipt } from '../../../cupboard/payment-receipt-store';
import type { JournalEntry } from '../../../cupboard/money-journal';
import type { HostedBillingCustomer } from './billing-store';
import { evaluateHostedBudget, settleHostedReservation, type HostedBudgetDecision, type HostedBudgetPolicy } from './budget-policy';
import { HOSTED_COST_SOURCE_RANK, type HostedCostSource } from './usage-statement';
import { collectHostedStripeFunding, evaluateHostedPrepaidFunding, type HostedPrepaidAllocation,
  type HostedPrepaidFundingInput, type HostedStripeFundingResult } from './budget-funding';
import { createStripeBillingClient } from './stripe-billing-client';
import { validatePolicy, type CustomerPaymentPolicy } from '../../../cupboard/money-journal-producers';

export interface HostedBudgetScope {
  readonly controlWorkspaceId: string;
  readonly organizationId: string;
  readonly customerWorkspaceId: string;
}
export interface HostedBudgetRequest {
  readonly scope: HostedBudgetScope;
  readonly reservationId: string;
  readonly month: string;
  readonly budgetKey: string;
  readonly maximumCostMicros: number;
  /** Opaque receipt for the server/provider's enforced maximum, not a key. */
  readonly providerLimitRef: string;
  readonly asOfMs: number;
}
export interface HostedBudgetLimit {
  /** Null is the required organization cap; the second cap may name this workspace. */
  readonly customerWorkspaceId: string | null;
  readonly entitlements: Pick<HostedEntitlementSet, 'budgets'>;
  /** Verified funding attributable to this window, net of older settled spend. */
  readonly fundedMicros: number;
  readonly fundedMicrosExact?: string;
  /** Costs outside this reservation ledger; exclude its settled receipts. */
  readonly externalSpentMicros: number;
  readonly externalSpentMicrosExact?: string;
  readonly retainedReserveMicros: number | null;
  readonly unreconciled: boolean;
}
export interface HostedBudgetContext {
  readonly scope: HostedBudgetScope;
  readonly month: string;
  /** Completion time of the fresh authority read, from a server clock. */
  readonly asOfMs: number;
  readonly policy: HostedBudgetPolicy;
  readonly limits: readonly HostedBudgetLimit[];
  readonly evidenceRef: string;
}
/** Installed only by authenticated server composition. Read/lock authoritative
 * funding and policy rows through THIS sql transaction. Browser values, cached
 * balances and forecasts are not this authority. No installed reader = refusal. */
export type HostedBudgetContextReader = (sql: Sql, request: HostedBudgetRequest) => Promise<HostedBudgetContext | null>;

export interface HostedPrepaidPool {
  readonly controlWorkspaceId: string;
  readonly stripeAccountId: string;
}
export interface HostedPrepaidAllocationRequest {
  readonly scope: HostedBudgetScope;
  readonly stripeAccountId: string;
  readonly allocation: HostedPrepaidAllocation;
  readonly month: string;
  readonly asOfMs: number;
}
/** Authenticated server composition only. Called AFTER the global pool lock;
 * all journal, cash, source and prior-charge reads use the supplied transaction.
 * A caller-supplied allocation list cannot replace the durable population. */
export type HostedPrepaidFundingReader = (sql: Sql, request: HostedPrepaidAllocationRequest) =>
  Promise<Omit<HostedPrepaidFundingInput, 'allocations'> | null>;

export interface HostedBudgetObservation {
  readonly scope: HostedBudgetScope;
  readonly reservationId: string;
  readonly eventId: string;
  readonly revision: number;
  readonly observedAtMs: number;
  readonly costSource: HostedCostSource;
  readonly costMicros: number | null;
  readonly costMicrosExact?: string;
  readonly providerFinal: boolean;
  readonly evidenceRef: string;
}
/** A committed admission, bound to the exact provider limit and policy.
 * This is delivered only to the winning server-side dispatch callback. */
export interface HostedBudgetExecutionGrant extends Omit<HostedBudgetRequest, 'asOfMs'> {
  readonly policyId: string;
  readonly policyRevision: number;
  readonly evidenceRef: string;
}
export interface HostedBudgetReceipt extends Omit<HostedBudgetRequest, 'asOfMs'> {
  readonly eventId: string;
  readonly revision: number;
  readonly requestHash: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly observedAtMs: number;
  readonly costSource: HostedCostSource;
  readonly costMicros: number | null;
  readonly costMicrosExact?: string;
  readonly providerFinal: boolean;
  readonly evidenceRef: string;
}
type Receipt = HostedBudgetReceipt;
export interface HostedBudgetPopulation {
  /** Every immutable revision, including unpriced admissions and old windows. */
  readonly history: readonly HostedBudgetReceipt[];
  /** One current revision per control/organization/reservation, not per amount. */
  readonly latest: readonly HostedBudgetReceipt[];
}
type Row = Record<string, unknown>;
const identifier = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(v);
const safe = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
function number(v: unknown): number {
  const n = Number(v); if (!safe(n)) throw new Error('invalid budget receipt counter'); return n;
}
function sum(values: readonly number[]): number {
  const n = values.reduce((total, value) => total + BigInt(value), 0n);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('budget receipt total overflow');
  return Number(n);
}
function scope(input: HostedBudgetScope): HostedBudgetScope {
  if (!input || Object.keys(input).some(k => !['controlWorkspaceId', 'organizationId', 'customerWorkspaceId'].includes(k))
      || !identifier(input.controlWorkspaceId) || !identifier(input.organizationId) || !identifier(input.customerWorkspaceId)) {
    throw new Error('invalid hosted budget scope');
  }
  return Object.freeze({ ...input });
}
const sameScope = (a: HostedBudgetScope, b: HostedBudgetScope) => a.controlWorkspaceId === b.controlWorkspaceId
  && a.organizationId === b.organizationId && a.customerWorkspaceId === b.customerWorkspaceId;
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const requestHash = (r: HostedBudgetRequest) => digest([r.scope.controlWorkspaceId, r.scope.organizationId,
  r.scope.customerWorkspaceId, r.reservationId, r.month, r.budgetKey, r.maximumCostMicros, r.providerLimitRef]);
const canonical = (r: Receipt) => JSON.stringify([r.requestHash, r.eventId, r.revision, r.observedAtMs,
  r.costSource, r.costMicrosExact ?? (r.costMicros === null ? null : String(r.costMicros)), r.providerFinal, r.evidenceRef]);
const settlement = (r: Receipt) => settleHostedReservation({ reservedMicros: r.maximumCostMicros,
  observedCostMicros: r.costMicros, observedCostMicrosExact: r.costMicrosExact,
  costSource: r.costSource, providerFinal: r.providerFinal, evidenceRef: r.evidenceRef });

function exactCounter(value: number, exact: string | undefined): string {
  if (!safe(value)) throw new Error('invalid external budget spend');
  if (exact === undefined) return String(value);
  const amount = splitMicrosDecimal(exact);
  if (amount.micros !== value || amount.exact !== exact) throw new Error('invalid exact external budget spend');
  return exact;
}

function receipt(r: Row): Receipt {
  const cost = r.cost_micros === null ? null : splitMicrosDecimal(String(r.cost_micros));
  return { scope: scope({ controlWorkspaceId: r.control_workspace_id as string, organizationId: r.organization_id as string,
    customerWorkspaceId: r.customer_workspace_id as string }), reservationId: r.reservation_id as string,
    month: r.month as string, budgetKey: r.budget_key as string, maximumCostMicros: number(r.maximum_cost_micros),
    providerLimitRef: r.provider_limit_ref as string, eventId: r.event_id as string, revision: number(r.revision),
    requestHash: r.request_hash as string, policyId: r.policy_id as string, policyRevision: number(r.policy_revision),
    observedAtMs: number(r.observed_at_ms), costSource: r.cost_source as HostedCostSource,
    costMicros: cost?.micros ?? null, ...(cost?.exact.includes('.') ? { costMicrosExact: cost.exact } : {}),
    providerFinal: r.provider_final as boolean,
    evidenceRef: r.evidence_ref as string };
}
async function lock(sql: Sql, s: HostedBudgetScope): Promise<void> {
  // The full local census and the subsequent receipt INSERT share this fence.
  // Take a write-capable mode BEFORE organization/account/source locks: two
  // SHARE readers that later INSERT would otherwise wait on each other's
  // upgrades. Raw INSERT takes its table lock before the organization trigger,
  // so store writers must use that same table-before-organization order.
  await sql`SELECT papercusp_auth.lock_hosted_stripe_funding_population('budget-writer')`;
  // Use the identical SQL writer as the table guard, including JSON spacing.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(
    json_build_array('hosted-budget', ${s.controlWorkspaceId}::text, ${s.organizationId}::text)::text, 0))`;
}

/** Complete LOCAL receipt history through the caller's reservation transaction.
 * The store takes the write-capable population fence before its organization
 * lock, then preserves organization -> account -> source ordering. Require
 * that already-held fence here; acquiring it after an account/source lock
 * would invert the writer order. It remains held through the admission INSERT
 * and commit/rollback, even with no rows. No runner, month or tenant filter.
 *
 * These receipts do not authenticate a provider account/invoice/generation or
 * certify that a cost is absent from another ledger. Unknown costs, fractional
 * corrections and opaque providerLimitRef values remain intact. This is not
 * funding, a policy reader, an allowance, or provider completeness evidence.
 */
export async function readLockedHostedBudgetPopulation(sql: Sql): Promise<HostedBudgetPopulation> {
  const [isolation] = await sql<{ transaction_isolation: string }[]>`SHOW transaction_isolation`;
  if (isolation?.transaction_isolation !== 'read committed') throw new Error('budget population requires read committed');
  const [started] = await sql<{ transaction_id: string }[]>`SELECT pg_current_xact_id()::text AS transaction_id`;
  const [fence] = await sql<{ held: boolean }[]>`SELECT EXISTS (
    SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND granted
      AND relation = 'papercusp_auth.hosted_budget_receipts'::regclass
      AND mode = 'ShareRowExclusiveLock'
  ) AS held`;
  if (!fence?.held) throw new Error('budget population requires the early writer fence');
  const rows = await sql<Row[]>`SELECT * FROM papercusp_auth.hosted_budget_receipts
    ORDER BY control_workspace_id COLLATE "C", organization_id COLLATE "C", reservation_id COLLATE "C", revision`;
  const population = rows.map(r => Object.freeze(receipt(r)));
  const current = new Map<string, HostedBudgetReceipt>();
  for (const r of population) current.set(JSON.stringify([r.scope.controlWorkspaceId, r.scope.organizationId, r.reservationId]), r);
  const [finished] = await sql<{ transaction_id: string }[]>`SELECT pg_current_xact_id()::text AS transaction_id`;
  if (!started?.transaction_id || finished?.transaction_id !== started.transaction_id) {
    throw new Error('budget population requires one transaction');
  }
  return Object.freeze({ history: Object.freeze(population), latest: Object.freeze([...current.values()]) });
}
async function history(sql: Sql, s: HostedBudgetScope, reservationId: string): Promise<Receipt[]> {
  const rows = await sql<Row[]>`SELECT * FROM papercusp_auth.hosted_budget_receipts
    WHERE control_workspace_id = ${s.controlWorkspaceId} AND organization_id = ${s.organizationId}
      AND reservation_id = ${reservationId} ORDER BY revision`;
  return rows.map(receipt);
}
async function insert(sql: Sql, r: Receipt): Promise<void> {
  await sql`INSERT INTO papercusp_auth.hosted_budget_receipts
    (control_workspace_id, organization_id, customer_workspace_id, reservation_id, event_id, revision,
     month, budget_key, maximum_cost_micros, provider_limit_ref, request_hash, policy_id, policy_revision,
     observed_at_ms, cost_source, cost_micros, provider_final, evidence_ref)
    VALUES (${r.scope.controlWorkspaceId}, ${r.scope.organizationId}, ${r.scope.customerWorkspaceId}, ${r.reservationId},
      ${r.eventId}, ${r.revision}, ${r.month}, ${r.budgetKey}, ${r.maximumCostMicros}, ${r.providerLimitRef},
      ${r.requestHash}, ${r.policyId}, ${r.policyRevision}, ${r.observedAtMs}, ${r.costSource}, ${r.costMicrosExact ?? r.costMicros},
      ${r.providerFinal}, ${r.evidenceRef})`;
}

/** Lock the entire Stripe account, including an EMPTY allocation population.
 * The database writer guard uses the same key. The account lock deliberately
 * omits organization/workspace/key/control: none may hide a competing partition.
 * Call this BEFORE collecting external evidence in a reservation context reader.
 * The lock remains held until that SAME reservation transaction commits. */
export async function readLockedHostedPrepaidAllocations(sql: Sql, pool: HostedPrepaidPool): Promise<readonly HostedPrepaidAllocation[]> {
  if (!identifier(pool.controlWorkspaceId) || !/^acct_[A-Za-z0-9]+$/.test(pool.stripeAccountId)) throw new Error('invalid prepaid pool');
  pool = Object.freeze({ controlWorkspaceId: pool.controlWorkspaceId, stripeAccountId: pool.stripeAccountId });
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(
    json_build_array('hosted-prepaid', ${pool.stripeAccountId}::text)::text, 0))`;
  const rows = await sql<Row[]>`SELECT * FROM papercusp_auth.hosted_prepaid_allocations
    WHERE stripe_account_id = ${pool.stripeAccountId} ORDER BY allocation_id`;
  if (rows.some(r => r.control_workspace_id !== pool.controlWorkspaceId)) throw new Error('prepaid pool control mismatch');
  return Object.freeze(rows.map(r => {
    const value = splitMicrosDecimal(String(r.micros));
    return Object.freeze({ allocationId: r.allocation_id as string, paymentTransactionId: r.payment_transaction_id as string,
      organizationId: r.organization_id as string, customerWorkspaceId: r.customer_workspace_id as string | null,
      budgetKey: r.budget_key as string, micros: value.micros,
      ...(value.exact.includes('.') ? { microsExact: value.exact } : {}) });
  }));
}

export interface HostedStripeFundingPopulation {
  readonly allocations: readonly HostedPrepaidAllocation[];
  readonly entries: readonly JournalEntry[];
  readonly receipts: readonly StoredPaymentReceipt[];
  readonly customers: readonly HostedBillingCustomer[];
}

/** Local population for collectHostedStripeFunding, through the SAME reservation
 * transaction. Locks the global account before any population read and keeps
 * journal, receipt and customer writers out through transaction completion,
 * including insertions into empty populations. No provider call or paid grant.
 *
 * The existing importer assigns one configured workspace to its Stripe account.
 * Older journal/receipt rows carry no account provenance, so a different source
 * workspace cannot be silently excluded or assigned to this account. Refuse it
 * until authenticated account ownership can be established. The workspace here
 * comes from trusted server configuration, never a customer-selected workspace.
 * Cash backing, provider obligations, policy and entitlements remain separate.
 */
export async function readLockedHostedStripeFundingPopulation(sql: Sql, input: {
  readonly pool: HostedPrepaidPool; readonly journalWorkspaceId: string;
}): Promise<HostedStripeFundingPopulation> {
  input = structuredClone(input);
  if (!identifier(input.journalWorkspaceId)) throw new Error('invalid funding journal workspace');
  // A repeatable-read snapshot taken before these locks could omit a writer
  // that committed while we waited. Locks alone cannot refresh that snapshot.
  const [isolation] = await sql<{ transaction_isolation: string }[]>`SHOW transaction_isolation`;
  if (isolation?.transaction_isolation !== 'read committed') throw new Error('funding population requires read committed');
  const [started] = await sql<{ transaction_id: string }[]>`SELECT pg_current_xact_id()::text AS transaction_id`;
  const allocations = await readLockedHostedPrepaidAllocations(sql, input.pool);
  await sql`SELECT papercusp_auth.lock_hosted_stripe_funding_population()`;
  const workspaces = await sql<{ workspace_id: string }[]>`
    SELECT workspace_id FROM harness_shared.money_journal_entries
    UNION SELECT workspace_id FROM harness_shared.money_journal_lines
    UNION SELECT workspace_id FROM harness_shared.payment_receipts`;
  if (workspaces.some(w => w.workspace_id !== input.journalWorkspaceId)) {
    throw new Error('unmapped funding journal workspace');
  }
  const customers = await sql<{ organization_id: string; stripe_customer_id: string; livemode: boolean }[]>`
    SELECT organization_id::text AS organization_id, stripe_customer_id, livemode
    FROM papercusp_auth.hosted_billing_customers ORDER BY stripe_customer_id COLLATE "C"`;
  const entries = await readMoneyJournalEntries(input.journalWorkspaceId, { sql });
  const receipts = await pgPaymentReceiptStore(sql).list(input.journalWorkspaceId);
  const [finished] = await sql<{ transaction_id: string }[]>`SELECT pg_current_xact_id()::text AS transaction_id`;
  // Passing a pool's autocommit Sql instead of the reservation transaction
  // releases each lock at statement end. Never return that unlocked census.
  if (!started?.transaction_id || finished?.transaction_id !== started.transaction_id) {
    throw new Error('funding population requires one transaction');
  }
  return Object.freeze({ allocations, entries: Object.freeze(entries), receipts: Object.freeze([...receipts]),
    customers: Object.freeze(customers.map(c => Object.freeze({ organizationId: c.organization_id,
      stripeCustomerId: c.stripe_customer_id, livemode: c.livemode }))) });
}

export type HostedLockedStripeFundingReader = (sql: Sql, customerScope: HostedBudgetScope, signal?: AbortSignal) =>
  Promise<Extract<HostedStripeFundingResult, { ok: false }> | (Extract<HostedStripeFundingResult, { ok: true }> & {
    readonly allocations: readonly HostedPrepaidAllocation[];
    readonly entries: readonly JournalEntry[];
  })>;

/** Server-only composition of the existing locked population and authenticated
 * Stripe collector. Supply the billing runtime's account/credential/owner flag
 * and the reconciliation runtime's journal workspace/payment policy. These are
 * server configuration, never fields on a reservation or browser request.
 *
 * The credential's own /account and persisted customer's organization are
 * authenticated by the client on each collection. The target customer is read
 * from THIS transaction, including uncommitted bindings; no second store/runner
 * can substitute a different snapshot. The caller retains all locks through
 * reservation commit. This returns source evidence only: bank/cash backing,
 * provider obligations and entitlements are still required independently.
 */
export function createLockedHostedStripeFundingReader(configuration: {
  readonly pool: HostedPrepaidPool;
  readonly journalWorkspaceId: string;
  readonly policy: CustomerPaymentPolicy;
  readonly maximumAgeMs: number;
}, dependencies: {
  readonly secretKey: string;
  readonly liveModeAllowed: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly maximumDurationMs?: number;
}): { readonly ok: true; readonly read: HostedLockedStripeFundingReader }
  | { readonly ok: false; readonly reason: 'unverified-stripe-read' } {
  configuration = structuredClone(configuration);
  const maximumDurationMs = dependencies.maximumDurationMs ?? 10_000;
  const now = dependencies.now ?? Date.now;
  if (!identifier(configuration.pool.controlWorkspaceId) || !/^acct_[A-Za-z0-9]+$/.test(configuration.pool.stripeAccountId)
      || !identifier(configuration.journalWorkspaceId) || validatePolicy(configuration.policy)
      || !safe(configuration.maximumAgeMs) || !safe(maximumDurationMs) || maximumDurationMs < 1
      || maximumDurationMs > 10_000 || typeof now !== 'function') throw new Error('invalid locked Stripe funding configuration');
  const built = createStripeBillingClient({ secretKey: dependencies.secretKey, liveModeAllowed: dependencies.liveModeAllowed,
    fetchImpl: dependencies.fetchImpl ?? fetch, readTimeoutMs: maximumDurationMs });
  if (!built.ok || !built.client.livemode) return { ok: false, reason: 'unverified-stripe-read' };
  const client = built.client;
  return { ok: true, read: async (sql, customerScope, signal) => {
    const s = scope(customerScope);
    if (signal?.aborted || s.controlWorkspaceId !== configuration.pool.controlWorkspaceId) {
      return { ok: false, reason: 'unverified-stripe-read' };
    }
    const population = await readLockedHostedStripeFundingPopulation(sql, configuration);
    const customer = population.customers.find(c => c.organizationId === s.organizationId);
    if (!customer || !customer.livemode) return { ok: false, reason: 'unverified-stripe-read' };
    const result = await collectHostedStripeFunding({ scope: s, accountId: configuration.pool.stripeAccountId,
      customerId: customer.stripeCustomerId, maximumAgeMs: configuration.maximumAgeMs, policy: configuration.policy,
      entries: population.entries, receipts: population.receipts, customers: population.customers },
    { client, now, maximumDurationMs, signal });
    return result.ok ? { ...result, allocations: population.allocations, entries: population.entries } : result;
  } };
}

/** Keep other organizations' unrelated payments out of the customer projection,
 * but retain EVERY partition of a selected payment. Reusing that payment under
 * a second organization therefore fails the existing scope validator. */
function fundingAllocations(input: Omit<HostedPrepaidFundingInput, 'allocations'>, population: readonly HostedPrepaidAllocation[]) {
  const payments = new Set(input.payments.map(p => p.receipt.transaction.id));
  return population.filter(a => a.organizationId === input.scope.organizationId || payments.has(a.paymentTransactionId));
}

export async function evaluateLockedHostedPrepaidFunding(sql: Sql, input: Omit<HostedPrepaidFundingInput, 'allocations'>) {
  input = structuredClone(input);
  const population = await readLockedHostedPrepaidAllocations(sql, { controlWorkspaceId: input.scope.controlWorkspaceId,
    stripeAccountId: input.snapshot.stripeAccountId });
  return evaluateHostedPrepaidFunding({ ...input, allocations: fundingAllocations(input, population) });
}

const allocationHash = (pool: HostedPrepaidPool, a: HostedPrepaidAllocation) => digest([pool.controlWorkspaceId,
  pool.stripeAccountId, a.allocationId, a.paymentTransactionId, a.organizationId, a.customerWorkspaceId,
  a.budgetKey, exactCounter(a.micros, a.microsExact)]);

export class PostgresHostedBudgetStore {
  private readonly run: HostedServiceContextRunner;
  private readonly readContext: HostedBudgetContextReader;
  private readonly readPrepaidFunding: HostedPrepaidFundingReader;
  private readonly now: () => number;
  private readonly maximumEvidenceAgeMs: number;
  constructor(options: { run?: HostedServiceContextRunner; readContext?: HostedBudgetContextReader;
    readPrepaidFunding?: HostedPrepaidFundingReader; now?: () => number; maximumEvidenceAgeMs?: number } = {}) {
    this.run = options.run ?? withHostedServiceContext;
    this.readContext = options.readContext ?? (async () => null);
    this.readPrepaidFunding = options.readPrepaidFunding ?? (async () => null);
    this.now = options.now ?? Date.now;
    this.maximumEvidenceAgeMs = options.maximumEvidenceAgeMs ?? 60_000;
    if (typeof this.now !== 'function' || !safe(this.maximumEvidenceAgeMs)) throw new Error('invalid budget clock configuration');
  }

  private freshTime(observed: number, started: number, completed: number): boolean {
    return safe(started) && safe(completed) && safe(observed) && completed >= started
      && observed >= started && observed <= completed && completed - observed <= this.maximumEvidenceAgeMs;
  }

  /** Persist one immutable prepaid partition after fresh server verification.
   * This never creates cash, dispatches work, expires funding or reallocates an
   * existing grant. The same account lock is used by reservation context reads.
   * No production funding reader is installed by this module. */
  async allocatePrepaid(input: HostedPrepaidAllocationRequest) {
    if (!input || Object.keys(input).some(k => !['scope', 'stripeAccountId', 'allocation', 'month', 'asOfMs'].includes(k))
        || !/^acct_[A-Za-z0-9]+$/.test(input.stripeAccountId) || !safe(input.asOfMs)) throw new Error('invalid prepaid allocation request');
    const a = input.allocation;
    const s = scope(input.scope);
    if (!a || Object.keys(a).some(k => !['allocationId', 'paymentTransactionId', 'organizationId', 'customerWorkspaceId', 'budgetKey', 'micros', 'microsExact'].includes(k))
        || !identifier(a.allocationId) || !identifier(a.paymentTransactionId) || !identifier(a.budgetKey)
        || a.organizationId !== s.organizationId || (a.customerWorkspaceId !== null && a.customerWorkspaceId !== s.customerWorkspaceId)) {
      throw new Error('prepaid allocation scope mismatch');
    }
    exactCounter(a.micros, a.microsExact);
    input = Object.freeze({ ...input, scope: s, allocation: Object.freeze({ ...a }) });
    const { startMs, endMs } = shadowMonthBounds(input.month);
    const pool = { controlWorkspaceId: s.controlWorkspaceId, stripeAccountId: input.stripeAccountId };
    const hash = allocationHash(pool, input.allocation);
    return this.run(async sql => {
      // All store operations take the organization lock before a pool lock;
      // the pool reader never locks another organization's mutable row.
      await lock(sql, s);
      const population = await readLockedHostedPrepaidAllocations(sql, pool);
      const previous = population.find(p => p.allocationId === input.allocation.allocationId);
      if (previous) {
        const matches = allocationHash(pool, previous) === hash;
        return { outcome: matches ? 'duplicate' as const : 'conflict' as const, allocation: matches ? previous : null };
      }
      const startedAtMs = this.now();
      if (!safe(startedAtMs) || input.asOfMs > startedAtMs) {
        return { outcome: 'refused' as const, reason: 'unverified-time', allocation: null };
      }
      // The request timestamp never certifies evidence. The reader receives
      // the server's start time and may finish after its external reads.
      const received = await this.readPrepaidFunding(sql, Object.freeze({ ...input, asOfMs: startedAtMs }));
      if (!received) return { outcome: 'refused' as const, reason: 'unconfigured-funding', allocation: null };
      if (!sameScope(scope(received.scope), s) || received.budgetKey !== input.allocation.budgetKey
          || received.windowStartMs !== startMs
          || received.snapshot.stripeAccountId !== pool.stripeAccountId) throw new Error('prepaid funding authority mismatch');
      const completedAtMs = this.now();
      if (!this.freshTime(received.asOfMs, startedAtMs, completedAtMs)) {
        return { outcome: 'refused' as const, reason: 'unverified-time', allocation: null };
      }
      if (completedAtMs < startMs || completedAtMs >= endMs) {
        return { outcome: 'refused' as const, reason: 'inactive-window', allocation: null };
      }
      const funding = evaluateHostedPrepaidFunding({ ...received,
        allocations: [...fundingAllocations(received, population), input.allocation] });
      if (!funding.ok) return { outcome: 'refused' as const, reason: funding.reason, allocation: null };
      await sql`INSERT INTO papercusp_auth.hosted_prepaid_allocations
        (control_workspace_id, stripe_account_id, allocation_id, payment_transaction_id, organization_id,
         binding_customer_workspace_id, customer_workspace_id, budget_key, micros, allocation_hash, observed_at_ms, evidence_ref)
        VALUES (${s.controlWorkspaceId}, ${pool.stripeAccountId}, ${input.allocation.allocationId},
          ${input.allocation.paymentTransactionId}, ${s.organizationId}, ${s.customerWorkspaceId}, ${input.allocation.customerWorkspaceId},
          ${input.allocation.budgetKey}, ${exactCounter(input.allocation.micros, input.allocation.microsExact)},
          ${hash}, ${completedAtMs}, ${funding.evidenceRef})`;
      return { outcome: 'allocated' as const, allocation: input.allocation, funding };
    });
  }

  /** Commit the full exposure BEFORE invoking a provider, at most once.
   * The reservation itself is the durable launch fence: only a fresh admission
   * dispatches. Retries, completed bills and process/lease expiry never reopen
   * it. A crash between commit and dispatch is deliberately ambiguous: keep
   * the hold and reconcile the provider rather than blindly relaunching.
   *
   * Network I/O runs outside the transaction. A callback failure propagates
   * without releasing money or deleting the fence. The authenticated caller
   * must enforce the bound identified by providerLimitRef; this method cannot
   * turn a forecast or an arbitrary reference into a provider-enforced limit.
   */
  async executeOnce<T>(input: HostedBudgetRequest, execute: (grant: HostedBudgetExecutionGrant) => Promise<T>) {
    if (typeof execute !== 'function') throw new Error('invalid budget executor');
    // Snapshot before the first await so a shared caller object cannot change
    // the reserved scope or limit while authority is being read.
    const snapshot = Object.freeze({ ...input, scope: scope(input.scope) });
    const reservation = await this.reserve(snapshot);
    if (reservation.outcome !== 'reserved') {
      return { execution: 'not-started' as const, reservation, value: null };
    }
    const r = reservation.receipt;
    const grant: HostedBudgetExecutionGrant = Object.freeze({ scope: snapshot.scope,
      reservationId: r.reservationId, month: r.month, budgetKey: r.budgetKey,
      maximumCostMicros: r.maximumCostMicros, providerLimitRef: r.providerLimitRef,
      policyId: r.policyId, policyRevision: r.policyRevision, evidenceRef: r.evidenceRef });
    const value = await execute(grant);
    // A returned operation/stream handle is dispatched, not finally billed.
    return { execution: 'dispatched' as const, reservation, value };
  }

  /** A duplicate is a saved receipt, NOT permission to start the provider again.
   * Use executeOnce for first launch; a direct reserve call only reserves
   * exposure. Resumption requires provider reconciliation, never a duplicate
   * receipt. Lost/crashed responses keep their original hold. */
  async reserve(input: HostedBudgetRequest) {
    if (Object.keys(input).some(k => !['scope', 'reservationId', 'month', 'budgetKey', 'maximumCostMicros', 'providerLimitRef', 'asOfMs'].includes(k))
        || !identifier(input.reservationId) || !identifier(input.budgetKey) || !identifier(input.providerLimitRef)
        || !safe(input.maximumCostMicros) || !safe(input.asOfMs)) throw new Error('invalid budget request');
    input = Object.freeze({ ...input, scope: scope(input.scope) });
    const { startMs, endMs } = shadowMonthBounds(input.month);
    const hash = requestHash(input);
    return this.run(async sql => {
      await lock(sql, input.scope);
      const prior = await history(sql, input.scope, input.reservationId);
      if (prior.length) return { outcome: prior[0]!.requestHash === hash ? 'duplicate' as const : 'conflict' as const,
        receipt: sameScope(prior[0]!.scope, input.scope) ? prior.at(-1)! : null, decisions: [] as HostedBudgetDecision[] };
      const startedAtMs = this.now();
      if (!safe(startedAtMs) || input.asOfMs > startedAtMs) {
        return { outcome: 'refused' as const, reason: 'unverified-time', receipt: null, decisions: [] as HostedBudgetDecision[] };
      }
      const received = await this.readContext(sql, Object.freeze({ ...input, asOfMs: startedAtMs }));
      if (!received) return { outcome: 'refused' as const, reason: 'unconfigured-context', receipt: null, decisions: [] as HostedBudgetDecision[] };
      if (!sameScope(scope(received.scope), input.scope) || received.month !== input.month
          || received.policy.budgetKey !== input.budgetKey || received.policy.effectiveFromMs !== startMs
          || received.policy.effectiveUntilMs !== endMs || !identifier(received.evidenceRef)
          || !Array.isArray(received.limits) || received.limits.length < 1 || received.limits.length > 2
          || received.limits.filter(l => l.customerWorkspaceId === null).length !== 1
          || received.limits.some(l => l.customerWorkspaceId !== null && l.customerWorkspaceId !== input.scope.customerWorkspaceId)) {
        throw new Error('budget authority context mismatch');
      }
      const policy = Object.freeze({ ...received.policy });
      const evidenceRef = received.evidenceRef;
      const evidenceAtMs = received.asOfMs;
      const limits = received.limits.map(l => Object.freeze({ ...l, entitlements: { budgets: { ...l.entitlements.budgets } } }));
      // All keys share the organization lock and committed exposure. A new
      // policy/key cannot erase an old reservation. Open OLD-month holds also
      // remain liabilities against this month's funding and cap.
      const rows = await sql<Row[]>`SELECT * FROM (
        SELECT DISTINCT ON (reservation_id) * FROM papercusp_auth.hosted_budget_receipts
        WHERE control_workspace_id = ${input.scope.controlWorkspaceId} AND organization_id = ${input.scope.organizationId}
        ORDER BY reservation_id, revision DESC
      ) latest WHERE month = ${input.month} OR NOT provider_final OR cost_source <> 'provider-billed'
        OR cost_micros > maximum_cost_micros`;
      const latest = rows.map(receipt);
      // Check after the last database await, so queue/collection latency cannot
      // admit against an expired policy or stale authority snapshot.
      const completedAtMs = this.now();
      if (!this.freshTime(evidenceAtMs, startedAtMs, completedAtMs)) {
        return { outcome: 'refused' as const, reason: 'unverified-time', receipt: null, decisions: [] as HostedBudgetDecision[] };
      }
      const decisions = limits.map(limit => {
        const relevant = latest.filter(r => limit.customerWorkspaceId === null || r.scope.customerWorkspaceId === limit.customerWorkspaceId);
        const amounts = relevant.map(r => ({ month: r.month, ...settlement(r) }));
        const spent = splitMicrosDecimal(addMicrosDecimals(exactCounter(limit.externalSpentMicros, limit.externalSpentMicrosExact),
          ...amounts.filter(a => a.month === input.month).map(a => a.chargedMicrosExact ?? String(a.chargedMicros))));
        return evaluateHostedBudget({ entitlements: limit.entitlements, policy, maximumCostMicros: input.maximumCostMicros,
          asOfMs: completedAtMs, position: { fundedMicros: limit.fundedMicros,
            fundedMicrosExact: limit.fundedMicrosExact, spentMicros: spent.micros,
            ...(spent.exact.includes('.') ? { spentMicrosExact: spent.exact } : {}),
            openReservedMicros: sum(amounts.map(a => a.heldMicros)), retainedReserveMicros: limit.retainedReserveMicros,
            unreconciled: limit.unreconciled || amounts.some(a => a.suspend) } });
      });
      if (decisions.some(d => !d.admitted)) return { outcome: 'refused' as const, receipt: null, decisions };
      const r: Receipt = { ...input, requestHash: hash, eventId: digest(['admission', hash]), revision: 0,
        policyId: policy.policyId, policyRevision: policy.revision, observedAtMs: completedAtMs,
        costSource: 'unpriced', costMicros: null, providerFinal: false, evidenceRef };
      await insert(sql, r);
      return { outcome: 'reserved' as const, receipt: r, decisions };
    });
  }

  /** Called by a verified provider collector, never the browser. New billed
   * corrections REPLACE the charge for this reservation; they do not add it.
   * No timer, cancellation flag or process restart can release this hold. */
  async observe(input: HostedBudgetObservation) {
    if (Object.keys(input).some(k => !['scope', 'reservationId', 'eventId', 'revision', 'observedAtMs', 'costSource', 'costMicros', 'costMicrosExact', 'providerFinal', 'evidenceRef'].includes(k))
        || !identifier(input.reservationId) || !identifier(input.eventId) || !identifier(input.evidenceRef)
        || !safe(input.revision) || input.revision < 1 || !safe(input.observedAtMs)
        || !Object.hasOwn(HOSTED_COST_SOURCE_RANK, input.costSource)
        || (input.costSource === 'unpriced' ? input.costMicros !== null : !safe(input.costMicros))
        || typeof input.providerFinal !== 'boolean') throw new Error('invalid budget observation');
    // Validate the exact/integer pair before any transaction or history write.
    settleHostedReservation({ reservedMicros: 0, observedCostMicros: input.costMicros,
      observedCostMicrosExact: input.costMicrosExact, costSource: input.costSource,
      providerFinal: input.providerFinal, evidenceRef: input.evidenceRef });
    input = Object.freeze({ ...input, scope: scope(input.scope) });
    return this.run(async sql => {
      await lock(sql, input.scope);
      const prior = await history(sql, input.scope, input.reservationId);
      const first = prior[0]; const last = prior.at(-1);
      if (!first || !last || !sameScope(first.scope, input.scope)) return { outcome: 'unknown' as const, receipt: null };
      const reused = await sql<Row[]>`SELECT reservation_id FROM papercusp_auth.hosted_budget_receipts
        WHERE control_workspace_id = ${input.scope.controlWorkspaceId} AND organization_id = ${input.scope.organizationId}
          AND event_id = ${input.eventId}`;
      if (reused[0] && reused[0].reservation_id !== input.reservationId) return { outcome: 'conflict' as const, receipt: null };
      const r: Receipt = { ...first, ...input };
      const replay = prior.find(p => p.eventId === input.eventId);
      if (replay) return { outcome: canonical(replay) === canonical(r) ? 'duplicate' as const : 'conflict' as const, receipt: replay };
      if (prior.some(p => p.revision === input.revision)) return { outcome: 'conflict' as const, receipt: null };
      if (input.revision < last.revision) return { outcome: 'stale' as const, receipt: null };
      if (input.observedAtMs < last.observedAtMs || HOSTED_COST_SOURCE_RANK[input.costSource] < HOSTED_COST_SOURCE_RANK[last.costSource]
          || (settlement(last).state === 'settled' && settlement(r).state !== 'settled')) throw new Error('budget observation downgrade');
      await insert(sql, r);
      return { outcome: 'recorded' as const, receipt: r, settlement: settlement(r) };
    });
  }
}
