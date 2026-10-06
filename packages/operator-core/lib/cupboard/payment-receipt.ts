/**
 * Per-payment receipts (agent-economy-flywheel-2026-08-30 P-046, D-029).
 *
 * Every Stripe balance transaction gets a salted SHA-256 COMMITMENT over
 * (id, amount, currency, fee, created). Only the commitment is chained (stream
 * `stripe.payment-receipts`) and so anchored hourly with the other ledgers
 * (D-024). The salt is 32 random bytes, so a commitment says nothing about a
 * low-entropy amount: totals stay public, individual payments stay private.
 *
 * A RECEIPT is what the customer keeps: the transaction fields, the salt, and
 * the D-024 inclusion bundle for the receipt's chain link. `verifyPaymentReceipt`
 * recomputes the commitment, checks it is the entry the bundle proves, then
 * checks the bundle against the anchored root read from public chain data.
 *
 * This module imports no Postgres code, so the open-source verifier CLI
 * (`scripts/verify-payment-receipt.mts`) can use it with only a public RPC.
 */
import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import { verifyInclusionBundle, type AnchorInclusionBundle, type AnchorReader, type BundleVerdict } from './ledger-anchor';

export const PAYMENT_RECEIPT_STREAM_ID = 'stripe.payment-receipts';
export const PAYMENT_RECEIPT_DOMAIN = 'papercusp.payment-receipt/v1\n';
export const PAYMENT_RECEIPT_FORMAT = 'papercusp.payment-receipt' as const;

const HEX64 = /^[0-9a-f]{64}$/;
const CURRENCY = /^[a-z]{3}$/;

/** The committed fields of a Stripe balance transaction. */
export interface ReceiptTransaction {
  readonly id: string;
  /** Signed minor units, as Stripe reports it. */
  readonly amount: number;
  readonly currency: string;
  /** Stripe's fee in minor units (>= 0). */
  readonly fee: number;
  /** Unix seconds. */
  readonly created: number;
}

/** The chain entry for one receipt: the commitment and nothing else. */
export interface ReceiptChainEntry {
  readonly commitment: string;
}

export function newReceiptSalt(): string {
  return randomBytes(32).toString('hex');
}

/** Why a transaction cannot be committed, or null when it can. */
export function receiptTransactionProblem(tx: ReceiptTransaction): string | null {
  if (typeof tx?.id !== 'string' || tx.id.length === 0 || tx.id.length > 255) return 'id must be a non-empty string (<= 255 chars)';
  if (!Number.isSafeInteger(tx.amount)) return 'amount must be a whole number of minor units';
  if (!Number.isSafeInteger(tx.fee) || tx.fee < 0) return 'fee must be a whole number of minor units, >= 0';
  if (typeof tx.currency !== 'string' || !CURRENCY.test(tx.currency)) return 'currency must be a lowercase ISO 4217 code';
  if (!Number.isSafeInteger(tx.created) || tx.created < 0) return 'created must be unix seconds';
  return null;
}

/** The salted commitment: SHA-256(domain + salt + '\n' + canonical JSON of the five fields). */
export function receiptCommitment(tx: ReceiptTransaction, salt: string): string {
  const problem = receiptTransactionProblem(tx);
  if (problem) throw new Error(`receiptCommitment: ${problem}`);
  if (!HEX64.test(salt)) throw new Error('receiptCommitment: salt must be 64 lowercase hex characters');
  const fields = canonicalJson({ amount: tx.amount, created: tx.created, currency: tx.currency, fee: tx.fee, id: tx.id });
  return createHash('sha256').update(`${PAYMENT_RECEIPT_DOMAIN}${salt}\n${fields}`, 'utf8').digest('hex');
}

/** Exactly the committed fields, so a receipt never carries anything else from Stripe. */
export function receiptTransaction(tx: ReceiptTransaction): ReceiptTransaction {
  return { id: tx.id, amount: tx.amount, currency: tx.currency, fee: tx.fee, created: tx.created };
}

export interface PaymentReceipt {
  readonly format: typeof PAYMENT_RECEIPT_FORMAT;
  readonly version: 1;
  readonly transaction: ReceiptTransaction;
  readonly salt: string;
  readonly commitment: string;
  /** The D-024 proof for the receipt's chain link, with `entry` = { commitment }. */
  readonly bundle: AnchorInclusionBundle;
}

/** Assemble a receipt; throws if the parts do not belong together (an issuer bug, never a customer's problem). */
export function assemblePaymentReceipt(input: {
  readonly transaction: ReceiptTransaction;
  readonly salt: string;
  readonly bundle: AnchorInclusionBundle;
}): PaymentReceipt {
  const transaction = receiptTransaction(input.transaction);
  const commitment = receiptCommitment(transaction, input.salt);
  const entry = input.bundle.entry as Partial<ReceiptChainEntry> | undefined;
  if (input.bundle.link.streamId !== PAYMENT_RECEIPT_STREAM_ID) {
    throw new Error(`assemblePaymentReceipt: bundle proves stream '${input.bundle.link.streamId}', not ${PAYMENT_RECEIPT_STREAM_ID}`);
  }
  if (entry?.commitment !== commitment) throw new Error('assemblePaymentReceipt: bundle entry does not carry this commitment');
  return { format: PAYMENT_RECEIPT_FORMAT, version: 1, transaction, salt: input.salt, commitment, bundle: input.bundle };
}

export type ReceiptVerdict =
  | {
      readonly ok: true;
      readonly transaction: ReceiptTransaction;
      /** End of the hour whose anchor covers the receipt: the payment existed by then. */
      readonly anchoredWindowEnd: number;
      readonly attester: string | null;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'malformed'
        | 'commitment-mismatch'
        | 'wrong-stream'
        | Exclude<BundleVerdict, { ok: true }>['reason'];
    };

/**
 * Verify a receipt with only the receipt and an `AnchorReader` over public
 * chain data. Pin `expectedAttester` to the published anchor address.
 */
export async function verifyPaymentReceipt(
  receipt: PaymentReceipt,
  reader: AnchorReader,
  opts: { readonly expectedAttester?: string; readonly expectedLogId?: string } = {},
): Promise<ReceiptVerdict> {
  if (receipt?.format !== PAYMENT_RECEIPT_FORMAT || receipt.version !== 1 || !receipt.transaction || !receipt.bundle?.link) {
    return { ok: false, reason: 'malformed' };
  }
  if (receiptTransactionProblem(receipt.transaction) !== null || typeof receipt.salt !== 'string' || !HEX64.test(receipt.salt)) {
    return { ok: false, reason: 'malformed' };
  }
  const commitment = receiptCommitment(receipt.transaction, receipt.salt);
  const entry = receipt.bundle.entry as Partial<ReceiptChainEntry> | undefined;
  // The bundle must carry the entry, or the verifier could not tie the link to this commitment.
  if (receipt.commitment !== commitment || entry?.commitment !== commitment) return { ok: false, reason: 'commitment-mismatch' };
  if (receipt.bundle.link.streamId !== PAYMENT_RECEIPT_STREAM_ID) return { ok: false, reason: 'wrong-stream' };
  const verdict = await verifyInclusionBundle(receipt.bundle, reader, opts);
  if (!verdict.ok) return verdict;
  return {
    ok: true,
    transaction: receiptTransaction(receipt.transaction),
    anchoredWindowEnd: verdict.anchoredWindowEnd,
    attester: verdict.attester,
  };
}
