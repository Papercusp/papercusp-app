/**
 * Payment-receipt persistence + chaining (agent-economy-flywheel-2026-08-30
 * P-046, D-029). Pure receipt math lives in payment-receipt.ts.
 *
 *   recordPaymentReceipts  — the reconciliation pass calls this with every
 *                            balance transaction it listed; each new one gets a
 *                            salt + commitment row, then the stream is witnessed
 *                            into ledger_chain_links (and so into the hourly
 *                            anchor log via the existing pg feed).
 *   issuePaymentReceipt    — the receipt for one transaction, once its chain link
 *                            is covered by an anchored root.
 *   customerPaymentReceipts — every receipt for one Stripe customer (the hosted
 *                            billing route serves these to the signed-in org).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { buildInclusionBundle, type LedgerAnchorStore } from './ledger-anchor';
import { pgLedgerAnchorStore } from './ledger-anchor-store';
import { pgLedgerChainLinkStore, witnessLedger, type LedgerChainLinkStore, type LedgerSource } from './ledger-chain';
import type { StripeBalanceTransaction } from './money-journal-producers';
import {
  PAYMENT_RECEIPT_STREAM_ID,
  assemblePaymentReceipt,
  newReceiptSalt,
  receiptCommitment,
  receiptTransactionProblem,
  type PaymentReceipt,
  type ReceiptChainEntry,
  type ReceiptTransaction,
} from './payment-receipt';

export interface StoredPaymentReceipt {
  readonly transaction: ReceiptTransaction;
  readonly receiptSeq: number;
  readonly salt: string;
  readonly commitment: string;
  readonly sourceId: string | null;
  readonly sourceCustomer: string | null;
}

export type NewPaymentReceipt = Omit<StoredPaymentReceipt, 'receiptSeq'>;

export interface PaymentReceiptStore {
  /** Every receipt of the workspace, in receipt_seq order. */
  list(workspaceId: string): Promise<readonly StoredPaymentReceipt[]>;
  get(workspaceId: string, balanceTransactionId: string): Promise<StoredPaymentReceipt | null>;
  /** Insert the rows that are not there yet (by transaction id); returns how many were new. */
  insertMissing(workspaceId: string, rows: readonly NewPaymentReceipt[]): Promise<number>;
}

interface ReceiptRow {
  balance_transaction_id: string;
  receipt_seq: string | number;
  salt: string;
  commitment: string;
  amount: string | number;
  fee: string | number;
  currency: string;
  stripe_created: string | number;
  source_id: string | null;
  source_customer: string | null;
}

const fromRow = (r: ReceiptRow): StoredPaymentReceipt => ({
  transaction: {
    id: r.balance_transaction_id,
    amount: Number(r.amount),
    currency: r.currency,
    fee: Number(r.fee),
    created: Number(r.stripe_created),
  },
  receiptSeq: Number(r.receipt_seq),
  salt: r.salt,
  commitment: r.commitment,
  sourceId: r.source_id,
  sourceCustomer: r.source_customer,
});

/** `harness_shared.payment_receipts` (migration 1297, append-only by trigger). */
export function pgPaymentReceiptStore(sql?: Sql): PaymentReceiptStore {
  const db = (): Sql => sql ?? getOrgPg().sql;
  return {
    async list(workspaceId) {
      const rows = await db()<ReceiptRow[]>`
        SELECT balance_transaction_id, receipt_seq, salt, commitment, amount, fee, currency, stripe_created, source_id, source_customer
          FROM harness_shared.payment_receipts
         WHERE workspace_id = ${workspaceId} ORDER BY receipt_seq`;
      return rows.map(fromRow);
    },
    async get(workspaceId, balanceTransactionId) {
      const rows = await db()<ReceiptRow[]>`
        SELECT balance_transaction_id, receipt_seq, salt, commitment, amount, fee, currency, stripe_created, source_id, source_customer
          FROM harness_shared.payment_receipts
         WHERE workspace_id = ${workspaceId} AND balance_transaction_id = ${balanceTransactionId}`;
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async insertMissing(workspaceId, rows) {
      let inserted = 0;
      for (const r of rows) {
        const result = await db()`
          INSERT INTO harness_shared.payment_receipts
            (workspace_id, balance_transaction_id, salt, commitment, amount, fee, currency, stripe_created, source_id, source_customer)
          VALUES (${workspaceId}, ${r.transaction.id}, ${r.salt}, ${r.commitment}, ${r.transaction.amount}, ${r.transaction.fee},
                  ${r.transaction.currency}, ${r.transaction.created}, ${r.sourceId}, ${r.sourceCustomer})
          ON CONFLICT (workspace_id, balance_transaction_id) DO NOTHING`;
        inserted += result.count;
      }
      return inserted;
    },
  };
}

/** In-memory store (tests, dry runs). */
export function memoryPaymentReceiptStore(): PaymentReceiptStore {
  const byWorkspace = new Map<string, StoredPaymentReceipt[]>();
  let seq = 0;
  return {
    async list(workspaceId) {
      return [...(byWorkspace.get(workspaceId) ?? [])];
    },
    async get(workspaceId, id) {
      return (byWorkspace.get(workspaceId) ?? []).find((r) => r.transaction.id === id) ?? null;
    },
    async insertMissing(workspaceId, rows) {
      const list = byWorkspace.get(workspaceId) ?? [];
      let inserted = 0;
      for (const r of rows) {
        if (list.some((x) => x.transaction.id === r.transaction.id)) continue;
        seq += 1;
        list.push({ ...r, receiptSeq: seq });
        inserted += 1;
      }
      byWorkspace.set(workspaceId, list);
      return inserted;
    },
  };
}

/** The receipts as a hash-chain ledger source: entry = { commitment } only, never an amount. */
export function paymentReceiptsLedgerSource(workspaceId: string, store: PaymentReceiptStore): LedgerSource {
  return {
    streamId: PAYMENT_RECEIPT_STREAM_ID,
    async list() {
      return (await store.list(workspaceId)).map((r) => ({
        sourceId: r.transaction.id,
        entry: { commitment: r.commitment } satisfies ReceiptChainEntry,
      }));
    },
  };
}

function customerOf(bt: StripeBalanceTransaction): string | null {
  const source = bt.source;
  if (!source || typeof source === 'string') return null;
  const c = source.customer;
  if (!c) return null;
  return typeof c === 'string' ? c : c.id;
}

export interface PaymentReceiptDeps {
  readonly sql?: Sql;
  readonly store?: PaymentReceiptStore;
  readonly chain?: LedgerChainLinkStore;
  readonly anchors?: LedgerAnchorStore;
  readonly salt?: () => string;
}

export interface RecordPaymentReceiptsResult {
  readonly recorded: number;
  readonly existing: number;
  /** Transactions that cannot be committed (malformed fields), by id with the reason. */
  readonly rejected: readonly { readonly id: string; readonly reason: string }[];
  /** Links appended to the stripe.payment-receipts chain by this call. */
  readonly chained: number;
}

/**
 * Record a receipt for each balance transaction not yet seen, then witness the
 * stream. Idempotent: an already-recorded transaction keeps its original salt.
 * A failed witness throws; the rows stay unchained and the next call links them.
 */
export async function recordPaymentReceipts(
  workspaceId: string,
  transactions: readonly StripeBalanceTransaction[],
  deps: PaymentReceiptDeps = {},
): Promise<RecordPaymentReceiptsResult> {
  const store = deps.store ?? pgPaymentReceiptStore(deps.sql);
  const chain = deps.chain ?? pgLedgerChainLinkStore(deps.sql);
  const salt = deps.salt ?? newReceiptSalt;
  const known = new Set((await store.list(workspaceId)).map((r) => r.transaction.id));
  const rejected: { id: string; reason: string }[] = [];
  const fresh: NewPaymentReceipt[] = [];
  const queued = new Set<string>();
  for (const bt of transactions) {
    if (known.has(bt.id) || queued.has(bt.id)) continue;
    const transaction: ReceiptTransaction = { id: bt.id, amount: bt.amount, currency: bt.currency, fee: bt.fee, created: bt.created };
    const problem = receiptTransactionProblem(transaction);
    if (problem) {
      rejected.push({ id: String(bt.id), reason: problem });
      continue;
    }
    const s = salt();
    const source = bt.source;
    fresh.push({
      transaction,
      salt: s,
      commitment: receiptCommitment(transaction, s),
      sourceId: !source ? null : typeof source === 'string' ? source : source.id,
      sourceCustomer: customerOf(bt),
    });
    queued.add(bt.id);
  }
  const recorded = fresh.length > 0 ? await store.insertMissing(workspaceId, fresh) : 0;
  const witnessed = await witnessLedger(workspaceId, paymentReceiptsLedgerSource(workspaceId, store), chain);
  return { recorded, existing: transactions.length - fresh.length - rejected.length, rejected, chained: witnessed.appended };
}

export type IssueReceiptResult =
  | { readonly ok: true; readonly receipt: PaymentReceipt }
  | { readonly ok: false; readonly error: 'unknown-transaction' | 'not-chained' | 'not-in-log' | 'not-yet-anchored' };

/** The receipt for one balance transaction, proven against the earliest anchor that covers it. */
export async function issuePaymentReceipt(
  workspaceId: string,
  balanceTransactionId: string,
  deps: PaymentReceiptDeps = {},
): Promise<IssueReceiptResult> {
  const store = deps.store ?? pgPaymentReceiptStore(deps.sql);
  const chain = deps.chain ?? pgLedgerChainLinkStore(deps.sql);
  const anchors = deps.anchors ?? pgLedgerAnchorStore(deps.sql);
  const row = await store.get(workspaceId, balanceTransactionId);
  if (!row) return { ok: false, error: 'unknown-transaction' };
  const stored = (await chain.links(workspaceId, PAYMENT_RECEIPT_STREAM_ID)).find((l) => l.sourceId === balanceTransactionId);
  if (!stored) return { ok: false, error: 'not-chained' };
  const bundle = await buildInclusionBundle({
    workspaceId,
    link: stored.link,
    entry: { commitment: row.commitment } satisfies ReceiptChainEntry,
    store: anchors,
  });
  if ('error' in bundle) return { ok: false, error: bundle.error };
  return { ok: true, receipt: assemblePaymentReceipt({ transaction: row.transaction, salt: row.salt, bundle }) };
}

export interface CustomerReceiptEntry {
  readonly balanceTransactionId: string;
  /** Unix seconds. */
  readonly created: number;
  /** Signed minor units and currency, so a not-yet-anchored entry can still be listed. */
  readonly amount: number;
  readonly currency: string;
  readonly result: IssueReceiptResult;
}

/** Every receipt for one Stripe customer, newest first. Unanchored ones report why. */
export async function customerPaymentReceipts(
  workspaceId: string,
  stripeCustomerId: string,
  deps: PaymentReceiptDeps = {},
): Promise<readonly CustomerReceiptEntry[]> {
  const store = deps.store ?? pgPaymentReceiptStore(deps.sql);
  const mine = (await store.list(workspaceId)).filter((r) => r.sourceCustomer === stripeCustomerId);
  const out: CustomerReceiptEntry[] = [];
  for (const r of mine.slice().reverse()) {
    out.push({
      balanceTransactionId: r.transaction.id,
      created: r.transaction.created,
      amount: r.transaction.amount,
      currency: r.transaction.currency,
      result: await issuePaymentReceipt(workspaceId, r.transaction.id, { ...deps, store }),
    });
  }
  return out;
}
