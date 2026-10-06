/**
 * Double-entry money journal (agent-economy-flywheel-2026-08-30 P-042, R-30).
 *
 * Every money movement becomes ONE balanced journal entry: debits equal
 * credits, every amount is an exact whole number of cents, and the entry
 * carries the external reference of the movement it records (a Stripe
 * balance-transaction id, a bank transaction id, or a chain tx hash). The
 * journal is what P-043 reconciles against Stripe, the bank feed and the chain,
 * so an entry without a reference has nothing to reconcile against and is
 * refused.
 *
 * Per-use charges are priced in micro-USD (shared-pot-dao-cupboard-v1 D-062).
 * Micros never enter the journal: they roll up OUTSIDE it in a `MicrosRollup`,
 * and only whole cents settle in. The sub-cent residue stays in the roll-up's
 * explicit rounding balance, so for every roll-up
 *
 *   (cents the journal received from it) x 10,000 + roundingMicros = micros accrued
 *
 * holds exactly: no fraction of a cent is lost, and none is invented.
 *
 * This module is pure (no I/O). Postgres persistence, the database-side
 * guards, and the hash-chain stream live in money-journal-store.ts.
 *
 * Chart of accounts and normal balances:
 *   operating                  debit   cash held at Stripe, the bank and the Safe
 *   customer-credit-reserve    credit  prepaid credits owed to customers
 *   refund-chargeback-reserve  credit  provision for refunds and chargebacks
 *   tax-reserve                credit  tax collected, owed to tax authorities
 *   dao-payable                credit  the DAO's share, accrued and not yet transferred
 *   revenue                    credit  recognized revenue
 *   provider-cost              debit   inference providers and payment-processing fees
 */

export const MONEY_JOURNAL_ACCOUNTS = [
  'operating',
  'customer-credit-reserve',
  'refund-chargeback-reserve',
  'tax-reserve',
  'dao-payable',
  'revenue',
  'provider-cost',
] as const;
export type MoneyJournalAccount = (typeof MONEY_JOURNAL_ACCOUNTS)[number];

export type JournalSide = 'debit' | 'credit';

export const ACCOUNT_NORMAL_SIDE: Readonly<Record<MoneyJournalAccount, JournalSide>> = Object.freeze({
  operating: 'debit',
  'customer-credit-reserve': 'credit',
  'refund-chargeback-reserve': 'credit',
  'tax-reserve': 'credit',
  'dao-payable': 'credit',
  revenue: 'credit',
  'provider-cost': 'debit',
});

/** 1 cent = 10,000 micro-USD. */
export const MICROS_PER_CENT = 10_000;

export const EXTERNAL_REF_KINDS = ['stripe-balance-transaction', 'bank-transaction', 'chain-tx'] as const;
export type ExternalRefKind = (typeof EXTERNAL_REF_KINDS)[number];

export type ExternalRef =
  | { readonly kind: 'stripe-balance-transaction'; readonly id: string }
  | { readonly kind: 'bank-transaction'; readonly id: string }
  | { readonly kind: 'chain-tx'; readonly chainId: number; readonly txHash: string };

export const MOVEMENT_KINDS = [
  'customer-payment',
  'credit-purchase',
  'refund',
  'chargeback',
  'provider-payment',
  'dao-transfer',
  'tax-remittance',
  'usage-settlement',
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/** Which external references can evidence each kind of movement. */
export const MOVEMENT_REF_KINDS: Readonly<Record<MovementKind, readonly ExternalRefKind[]>> = Object.freeze({
  'customer-payment': ['stripe-balance-transaction', 'chain-tx'],
  'credit-purchase': ['stripe-balance-transaction', 'chain-tx'],
  refund: ['stripe-balance-transaction', 'chain-tx'],
  chargeback: ['stripe-balance-transaction'],
  'provider-payment': ['bank-transaction', 'stripe-balance-transaction', 'chain-tx'],
  'dao-transfer': ['chain-tx'],
  'tax-remittance': ['bank-transaction'],
  'usage-settlement': ['stripe-balance-transaction', 'bank-transaction', 'chain-tx'],
});

export interface JournalLine {
  readonly account: MoneyJournalAccount;
  readonly side: JournalSide;
  /** A positive whole number of cents. Never micros. */
  readonly cents: number;
}

export interface JournalEntry {
  /** Idempotency key: the same movement always maps to the same id. */
  readonly entryId: string;
  readonly occurredAtMs: number;
  readonly currency: string;
  readonly movement: MovementKind;
  readonly externalRef: ExternalRef;
  /** Set only on a `usage-settlement`: the roll-up whose whole cents it settles. */
  readonly rollupId: string | null;
  readonly memo: string;
  readonly lines: readonly JournalLine[];
}

export type JournalRejectionCode =
  | 'invalid-entry'
  | 'missing-external-reference'
  | 'invalid-external-reference'
  | 'external-reference-kind-not-allowed'
  | 'unknown-account'
  | 'too-few-lines'
  | 'non-positive-amount'
  | 'sub-cent-amount'
  | 'micros-in-journal'
  | 'unbalanced'
  | 'currency-mismatch'
  | 'duplicate-entry'
  | 'invalid-movement';

export interface JournalRejection {
  readonly ok: false;
  readonly code: JournalRejectionCode;
  readonly detail: string;
}

const reject = (code: JournalRejectionCode, detail: string): JournalRejection => ({ ok: false, code, detail });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAccount(value: unknown): value is MoneyJournalAccount {
  return typeof value === 'string' && (MONEY_JOURNAL_ACCOUNTS as readonly string[]).includes(value);
}

function isMovementKind(value: unknown): value is MovementKind {
  return typeof value === 'string' && (MOVEMENT_KINDS as readonly string[]).includes(value);
}

const STRIPE_BALANCE_TXN = /^txn_[A-Za-z0-9]{1,250}$/;
const CHAIN_TX_HASH = /^0x[0-9a-f]{64}$/;
const CURRENCY = /^[A-Z]{3}$/;

export type ExternalRefValidation = { ok: true; ref: ExternalRef } | JournalRejection;

export function validateExternalRef(raw: unknown): ExternalRefValidation {
  if (raw === undefined || raw === null) return reject('missing-external-reference', 'an entry must carry the external reference of its movement');
  if (!isRecord(raw)) return reject('invalid-external-reference', 'externalRef must be an object');
  switch (raw.kind) {
    case 'stripe-balance-transaction':
      if (typeof raw.id !== 'string' || !STRIPE_BALANCE_TXN.test(raw.id)) {
        return reject('invalid-external-reference', 'a Stripe balance-transaction id looks like txn_…');
      }
      return { ok: true, ref: { kind: 'stripe-balance-transaction', id: raw.id } };
    case 'bank-transaction':
      if (typeof raw.id !== 'string' || raw.id.trim().length === 0 || raw.id.length > 256 || raw.id !== raw.id.trim()) {
        return reject('invalid-external-reference', 'a bank transaction id must be a non-empty trimmed string of at most 256 characters');
      }
      return { ok: true, ref: { kind: 'bank-transaction', id: raw.id } };
    case 'chain-tx':
      if (typeof raw.chainId !== 'number' || !Number.isSafeInteger(raw.chainId) || raw.chainId <= 0) {
        return reject('invalid-external-reference', 'chainId must be a positive integer (EIP-155)');
      }
      if (typeof raw.txHash !== 'string' || !CHAIN_TX_HASH.test(raw.txHash)) {
        return reject('invalid-external-reference', 'txHash must be 0x followed by 64 lowercase hex digits');
      }
      return { ok: true, ref: { kind: 'chain-tx', chainId: raw.chainId, txHash: raw.txHash } };
    default:
      return reject('invalid-external-reference', `externalRef.kind must be one of ${EXTERNAL_REF_KINDS.join(', ')}`);
  }
}

/** The reference as one string, e.g. `chain-tx:84532:0xab…`. Used for storage and reconciliation joins. */
export function externalRefKey(ref: ExternalRef): string {
  return ref.kind === 'chain-tx' ? `chain-tx:${ref.chainId}:${ref.txHash}` : `${ref.kind}:${ref.id}`;
}

export type JournalEntryValidation = { ok: true; entry: JournalEntry } | JournalRejection;

/** Validate a candidate entry. Refusals are typed; nothing partial is ever accepted. */
export function validateJournalEntry(raw: unknown): JournalEntryValidation {
  if (!isRecord(raw)) return reject('invalid-entry', 'entry must be an object');
  const { entryId, occurredAtMs, currency, movement, memo, rollupId, lines } = raw;
  if (typeof entryId !== 'string' || entryId.length === 0 || entryId.length > 256) {
    return reject('invalid-entry', 'entryId must be a string of 1-256 characters');
  }
  if (typeof occurredAtMs !== 'number' || !Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) {
    return reject('invalid-entry', 'occurredAtMs must be a non-negative integer');
  }
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    return reject('invalid-entry', 'currency must be an upper-case ISO-4217 code');
  }
  if (!isMovementKind(movement)) return reject('invalid-movement', `movement must be one of ${MOVEMENT_KINDS.join(', ')}`);
  if (memo !== undefined && (typeof memo !== 'string' || memo.length > 1000)) {
    return reject('invalid-entry', 'memo must be a string of at most 1000 characters');
  }
  if (rollupId !== undefined && rollupId !== null && (typeof rollupId !== 'string' || rollupId.length === 0 || rollupId.length > 256)) {
    return reject('invalid-entry', 'rollupId must be null or a string of 1-256 characters');
  }
  const normalizedRollup = typeof rollupId === 'string' ? rollupId : null;
  if ((normalizedRollup !== null) !== (movement === 'usage-settlement')) {
    return reject('invalid-entry', 'rollupId is required on a usage-settlement and forbidden on every other movement');
  }

  const ref = validateExternalRef(raw.externalRef);
  if (!ref.ok) return ref;
  if (!MOVEMENT_REF_KINDS[movement].includes(ref.ref.kind)) {
    return reject(
      'external-reference-kind-not-allowed',
      `a ${movement} is evidenced by ${MOVEMENT_REF_KINDS[movement].join(' or ')}, not ${ref.ref.kind}`,
    );
  }

  if (!Array.isArray(lines)) return reject('invalid-entry', 'lines must be an array');
  if (lines.length < 2) return reject('too-few-lines', 'a double-entry posting needs at least one debit and one credit line');
  const normalized: JournalLine[] = [];
  let debits = 0;
  let credits = 0;
  for (const [index, line] of lines.entries()) {
    if (!isRecord(line)) return reject('invalid-entry', `line ${index} must be an object`);
    if ('micros' in line || line.unit === 'micros') {
      return reject('micros-in-journal', `line ${index} carries micros; micros roll up outside the journal and only whole cents enter it`);
    }
    if (!isAccount(line.account)) return reject('unknown-account', `line ${index}: unknown account ${String(line.account)}`);
    if (line.side !== 'debit' && line.side !== 'credit') return reject('invalid-entry', `line ${index}: side must be debit or credit`);
    const cents = line.cents;
    if (typeof cents !== 'number' || !Number.isFinite(cents)) return reject('invalid-entry', `line ${index}: cents must be a number`);
    if (!Number.isInteger(cents)) return reject('sub-cent-amount', `line ${index}: ${cents} is not a whole number of cents`);
    if (!Number.isSafeInteger(cents)) return reject('invalid-entry', `line ${index}: cents is outside the safe integer range`);
    if (cents <= 0) return reject('non-positive-amount', `line ${index}: amounts are positive; the side carries the direction`);
    if (line.side === 'debit') debits += cents;
    else credits += cents;
    normalized.push({ account: line.account, side: line.side, cents });
  }
  if (!Number.isSafeInteger(debits) || !Number.isSafeInteger(credits)) {
    return reject('invalid-entry', 'entry totals are outside the safe integer range');
  }
  if (debits !== credits) return reject('unbalanced', `debits ${debits} != credits ${credits}`);
  if (debits === 0) return reject('too-few-lines', 'an entry needs at least one debit and one credit');

  return {
    ok: true,
    entry: {
      entryId,
      occurredAtMs,
      currency,
      movement,
      externalRef: ref.ref,
      rollupId: normalizedRollup,
      memo: typeof memo === 'string' ? memo : '',
      lines: normalized,
    },
  };
}

/** The entry's total: sum of its debits (= sum of its credits). */
export function entryTotalCents(entry: JournalEntry): number {
  return entry.lines.reduce((sum, line) => (line.side === 'debit' ? sum + line.cents : sum), 0);
}

// ---------------------------------------------------------------------------
// Posting rules: one movement -> the lines of its entry.
// ---------------------------------------------------------------------------

export type MoneyMovement =
  /** A customer paid for a subscription or a one-time purchase. Tax, the DAO share and a refund provision come out of revenue. */
  | {
      readonly kind: 'customer-payment';
      readonly grossCents: number;
      readonly feeCents: number;
      readonly taxCents: number;
      readonly daoCents: number;
      readonly refundReserveCents: number;
    }
  /** A customer bought prepaid credits: owed as service, not yet revenue. */
  | { readonly kind: 'credit-purchase'; readonly grossCents: number; readonly feeCents: number; readonly taxCents: number }
  /** Money returned to a customer, drawn from the refund provision (and the tax it carried). */
  | { readonly kind: 'refund'; readonly amountCents: number; readonly taxCents: number }
  /** A lost dispute: the amount plus the processor's dispute fee leave operating. */
  | { readonly kind: 'chargeback'; readonly amountCents: number; readonly feeCents: number }
  /** Paying an inference provider or other provider. */
  | { readonly kind: 'provider-payment'; readonly amountCents: number }
  /** Paying the DAO's accrued share to its Safe. */
  | { readonly kind: 'dao-transfer'; readonly amountCents: number }
  /** Paying collected tax to the authority. */
  | { readonly kind: 'tax-remittance'; readonly amountCents: number }
  /** Whole cents settled out of a per-use micros roll-up: credits consumed become revenue and the DAO share. */
  | { readonly kind: 'usage-settlement'; readonly cents: number; readonly daoCents: number };

export type MovementLines = { ok: true; lines: JournalLine[] } | JournalRejection;

function wholeCents(name: string, value: number, allowZero: boolean): JournalRejection | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return reject('invalid-movement', `${name} must be a number`);
  if (!Number.isInteger(value)) return reject('sub-cent-amount', `${name} = ${value} is not a whole number of cents`);
  if (!Number.isSafeInteger(value)) return reject('invalid-movement', `${name} is outside the safe integer range`);
  if (value < 0 || (!allowZero && value === 0)) {
    return reject('invalid-movement', `${name} must be ${allowZero ? 'zero or more' : 'positive'}`);
  }
  return null;
}

function linesOf(parts: ReadonlyArray<readonly [MoneyJournalAccount, JournalSide, number]>): JournalLine[] {
  return parts.filter(([, , cents]) => cents > 0).map(([account, side, cents]) => ({ account, side, cents }));
}

export function journalLinesForMovement(movement: MoneyMovement): MovementLines {
  switch (movement.kind) {
    case 'customer-payment': {
      const { grossCents, feeCents, taxCents, daoCents, refundReserveCents } = movement;
      const bad =
        wholeCents('grossCents', grossCents, false) ??
        wholeCents('feeCents', feeCents, true) ??
        wholeCents('taxCents', taxCents, true) ??
        wholeCents('daoCents', daoCents, true) ??
        wholeCents('refundReserveCents', refundReserveCents, true);
      if (bad) return bad;
      if (feeCents > grossCents) return reject('invalid-movement', 'the processing fee exceeds the gross payment');
      if (taxCents + daoCents + refundReserveCents > grossCents) {
        return reject('invalid-movement', 'tax, the DAO share and the refund provision exceed the gross payment');
      }
      return {
        ok: true,
        lines: linesOf([
          ['operating', 'debit', grossCents - feeCents],
          ['provider-cost', 'debit', feeCents],
          ['tax-reserve', 'credit', taxCents],
          ['dao-payable', 'credit', daoCents],
          ['refund-chargeback-reserve', 'credit', refundReserveCents],
          ['revenue', 'credit', grossCents - taxCents - daoCents - refundReserveCents],
        ]),
      };
    }
    case 'credit-purchase': {
      const { grossCents, feeCents, taxCents } = movement;
      const bad =
        wholeCents('grossCents', grossCents, false) ?? wholeCents('feeCents', feeCents, true) ?? wholeCents('taxCents', taxCents, true);
      if (bad) return bad;
      if (feeCents > grossCents) return reject('invalid-movement', 'the processing fee exceeds the gross payment');
      if (taxCents >= grossCents) return reject('invalid-movement', 'tax must leave a positive credit amount');
      return {
        ok: true,
        lines: linesOf([
          ['operating', 'debit', grossCents - feeCents],
          ['provider-cost', 'debit', feeCents],
          ['tax-reserve', 'credit', taxCents],
          ['customer-credit-reserve', 'credit', grossCents - taxCents],
        ]),
      };
    }
    case 'refund': {
      const bad = wholeCents('amountCents', movement.amountCents, false) ?? wholeCents('taxCents', movement.taxCents, true);
      if (bad) return bad;
      if (movement.taxCents > movement.amountCents) return reject('invalid-movement', 'refunded tax exceeds the refund');
      return {
        ok: true,
        lines: linesOf([
          ['refund-chargeback-reserve', 'debit', movement.amountCents - movement.taxCents],
          ['tax-reserve', 'debit', movement.taxCents],
          ['operating', 'credit', movement.amountCents],
        ]),
      };
    }
    case 'chargeback': {
      const bad = wholeCents('amountCents', movement.amountCents, false) ?? wholeCents('feeCents', movement.feeCents, true);
      if (bad) return bad;
      return {
        ok: true,
        lines: linesOf([
          ['refund-chargeback-reserve', 'debit', movement.amountCents],
          ['provider-cost', 'debit', movement.feeCents],
          ['operating', 'credit', movement.amountCents + movement.feeCents],
        ]),
      };
    }
    case 'provider-payment':
    case 'dao-transfer':
    case 'tax-remittance': {
      const bad = wholeCents('amountCents', movement.amountCents, false);
      if (bad) return bad;
      const debitAccount: MoneyJournalAccount =
        movement.kind === 'provider-payment' ? 'provider-cost' : movement.kind === 'dao-transfer' ? 'dao-payable' : 'tax-reserve';
      return {
        ok: true,
        lines: linesOf([
          [debitAccount, 'debit', movement.amountCents],
          ['operating', 'credit', movement.amountCents],
        ]),
      };
    }
    case 'usage-settlement': {
      const bad = wholeCents('cents', movement.cents, false) ?? wholeCents('daoCents', movement.daoCents, true);
      if (bad) return bad;
      if (movement.daoCents > movement.cents) return reject('invalid-movement', 'the DAO share exceeds the settled cents');
      return {
        ok: true,
        lines: linesOf([
          ['customer-credit-reserve', 'debit', movement.cents],
          ['dao-payable', 'credit', movement.daoCents],
          ['revenue', 'credit', movement.cents - movement.daoCents],
        ]),
      };
    }
    default: {
      const unknownKind: never = movement;
      return reject('invalid-movement', `unknown movement ${JSON.stringify(unknownKind)}`);
    }
  }
}

export interface MovementEntryInput {
  readonly entryId: string;
  readonly occurredAtMs: number;
  readonly currency: string;
  readonly externalRef: ExternalRef;
  readonly memo?: string;
  readonly rollupId?: string | null;
  readonly movement: MoneyMovement;
}

/** Build and validate the journal entry for one movement. */
export function journalEntryForMovement(input: MovementEntryInput): JournalEntryValidation {
  const built = journalLinesForMovement(input.movement);
  if (!built.ok) return built;
  return validateJournalEntry({
    entryId: input.entryId,
    occurredAtMs: input.occurredAtMs,
    currency: input.currency,
    movement: input.movement.kind,
    externalRef: input.externalRef,
    memo: input.memo ?? '',
    rollupId: input.rollupId ?? null,
    lines: built.lines,
  });
}

// ---------------------------------------------------------------------------
// The journal state and posting.
// ---------------------------------------------------------------------------

export interface MoneyJournalState {
  readonly currency: string;
  readonly entries: readonly JournalEntry[];
  readonly entryIds: ReadonlySet<string>;
  /** Signed per account, debit-positive. */
  readonly balancesCents: Readonly<Record<MoneyJournalAccount, number>>;
  readonly totalDebitCents: number;
  readonly totalCreditCents: number;
  /** Cents each micros roll-up has settled into the journal. */
  readonly settledCentsByRollup: Readonly<Record<string, number>>;
}

function zeroBalances(): Record<MoneyJournalAccount, number> {
  return Object.fromEntries(MONEY_JOURNAL_ACCOUNTS.map((account) => [account, 0])) as Record<MoneyJournalAccount, number>;
}

export function emptyMoneyJournal(currency = 'USD'): MoneyJournalState {
  if (!CURRENCY.test(currency)) throw new Error(`emptyMoneyJournal: invalid currency ${currency}`);
  return {
    currency,
    entries: [],
    entryIds: new Set(),
    balancesCents: zeroBalances(),
    totalDebitCents: 0,
    totalCreditCents: 0,
    settledCentsByRollup: {},
  };
}

export type PostResult = { ok: true; state: MoneyJournalState; entry: JournalEntry } | JournalRejection;

/** Post one entry. The returned state is new; the input state is never mutated. */
export function postJournalEntry(state: MoneyJournalState, raw: unknown): PostResult {
  const validated = validateJournalEntry(raw);
  if (!validated.ok) return validated;
  const entry = validated.entry;
  if (entry.currency !== state.currency) {
    return reject('currency-mismatch', `the journal is in ${state.currency}; the entry is in ${entry.currency}`);
  }
  if (state.entryIds.has(entry.entryId)) return reject('duplicate-entry', `entry ${entry.entryId} is already posted`);
  const balances = { ...state.balancesCents };
  let debit = state.totalDebitCents;
  let credit = state.totalCreditCents;
  for (const line of entry.lines) {
    if (line.side === 'debit') {
      balances[line.account] += line.cents;
      debit += line.cents;
    } else {
      balances[line.account] -= line.cents;
      credit += line.cents;
    }
  }
  const settled = { ...state.settledCentsByRollup };
  if (entry.rollupId !== null) settled[entry.rollupId] = (settled[entry.rollupId] ?? 0) + entryTotalCents(entry);
  const entryIds = new Set(state.entryIds);
  entryIds.add(entry.entryId);
  return {
    ok: true,
    entry,
    state: {
      currency: state.currency,
      entries: [...state.entries, entry],
      entryIds,
      balancesCents: balances,
      totalDebitCents: debit,
      totalCreditCents: credit,
      settledCentsByRollup: settled,
    },
  };
}

export interface TrialBalanceAccount {
  readonly account: MoneyJournalAccount;
  readonly normalSide: JournalSide;
  readonly debitCents: number;
  readonly creditCents: number;
  /** Balance on the account's normal side (positive = normal). */
  readonly balanceCents: number;
}

export interface TrialBalance {
  readonly currency: string;
  readonly debitCents: number;
  readonly creditCents: number;
  readonly balanced: boolean;
  readonly accounts: readonly TrialBalanceAccount[];
}

/** Recompute debits and credits from the entries themselves (not from the running totals). */
export function trialBalance(entries: readonly JournalEntry[], currency = 'USD'): TrialBalance {
  const debits = zeroBalances();
  const credits = zeroBalances();
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (line.side === 'debit') debits[line.account] += line.cents;
      else credits[line.account] += line.cents;
    }
  }
  const accounts = MONEY_JOURNAL_ACCOUNTS.map((account) => {
    const normalSide = ACCOUNT_NORMAL_SIDE[account];
    const net = debits[account] - credits[account];
    return {
      account,
      normalSide,
      debitCents: debits[account],
      creditCents: credits[account],
      balanceCents: normalSide === 'debit' ? net : -net,
    };
  });
  const debitCents = accounts.reduce((sum, a) => sum + a.debitCents, 0);
  const creditCents = accounts.reduce((sum, a) => sum + a.creditCents, 0);
  return { currency, debitCents, creditCents, balanced: debitCents === creditCents, accounts };
}

// ---------------------------------------------------------------------------
// The micros roll-up (outside the journal).
// ---------------------------------------------------------------------------

export interface MicrosRollup {
  readonly rollupId: string;
  readonly currency: string;
  /** Every micro accrued into this roll-up, ever. */
  readonly totalMicros: number;
  /** Whole cents already settled into the journal. */
  readonly settledCents: number;
  /** The rounding account: micros accrued but not yet a settled whole cent. */
  readonly roundingMicros: number;
  /** Canonical decimal micro amounts when the integer projection has residue. */
  readonly totalMicrosExact?: string;
  readonly roundingMicrosExact?: string;
  readonly accrualIds: ReadonlySet<string>;
  readonly accrualAmounts?: ReadonlyMap<string, string>;
}

/** Exact decimal arithmetic on the existing micro rail. No binary-float money
 * arithmetic or fixed NUMERIC scale: even subnormal provider numbers survive.
 * External contracts require this canonical form; PG numeric reads may have
 * trailing zeroes and are normalized here. */
export function parseMicrosDecimal(value: string): { coefficient: bigint; scale: number } {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,31})(?:\.[0-9]{1,324})?$/.test(value)) {
    throw new Error('invalid exact micro amount');
  }
  const [whole, fraction = ''] = value.split('.');
  return { coefficient: BigInt(whole! + fraction), scale: fraction.length };
}
export function formatMicrosDecimal(coefficient: bigint, scale: number): string {
  if (coefficient < 0n || !Number.isInteger(scale) || scale < 0 || scale > 324) throw new Error('invalid exact micro amount');
  const digits = coefficient.toString().padStart(scale + 1, '0');
  if (scale === 0) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return digits.slice(0, -scale) + (fraction ? '.' + fraction : '');
}
export function addMicrosDecimals(...values: string[]): string {
  const amounts = values.map(parseMicrosDecimal);
  const scale = Math.max(0, ...amounts.map(a => a.scale));
  return formatMicrosDecimal(amounts.reduce((sum, a) => sum + a.coefficient * 10n ** BigInt(scale - a.scale), 0n), scale);
}
export function splitMicrosDecimal(value: string): { micros: number; exact: string } {
  const { coefficient, scale } = parseMicrosDecimal(value);
  const divisor = 10n ** BigInt(scale);
  if (coefficient > BigInt(Number.MAX_SAFE_INTEGER) * divisor) throw new Error('micro amount exceeds safe integer range');
  return { micros: Number(coefficient / divisor), exact: formatMicrosDecimal(coefficient, scale) };
}

export type RollupRejectionCode = 'invalid-micros' | 'duplicate-accrual' | 'invalid-rollup' | 'currency-mismatch';
export interface RollupRejection {
  readonly ok: false;
  readonly code: RollupRejectionCode | JournalRejectionCode;
  readonly detail: string;
}

export function emptyMicrosRollup(rollupId: string, currency = 'USD'): MicrosRollup {
  if (rollupId.length === 0 || rollupId.length > 256) throw new Error('emptyMicrosRollup: rollupId must be 1-256 characters');
  if (!CURRENCY.test(currency)) throw new Error(`emptyMicrosRollup: invalid currency ${currency}`);
  return { rollupId, currency, totalMicros: 0, settledCents: 0, roundingMicros: 0, accrualIds: new Set() };
}

export type AccrueResult = { ok: true; rollup: MicrosRollup; duplicate: boolean } | RollupRejection;

/**
 * Accrue a per-use charge in micros. Idempotent on `accrualId` (a meter nonce):
 * a repeated accrual is a no-op reported as `duplicate`, never double-counted.
 */
export function accrueMicros(rollup: MicrosRollup, input: { readonly accrualId: string; readonly micros: number; readonly microsExact?: string }): AccrueResult {
  if (typeof input.accrualId !== 'string' || input.accrualId.length === 0 || input.accrualId.length > 256) {
    return { ok: false, code: 'invalid-rollup', detail: 'accrualId must be a string of 1-256 characters' };
  }
  let amount: ReturnType<typeof splitMicrosDecimal>;
  try { amount = splitMicrosDecimal(input.microsExact ?? String(input.micros)); }
  catch { return { ok: false, code: 'invalid-micros', detail: 'invalid exact micro amount' }; }
  if (!Number.isSafeInteger(input.micros) || amount.micros !== input.micros || amount.exact === '0'
      || (input.microsExact !== undefined && amount.exact !== input.microsExact)) {
    return { ok: false, code: 'invalid-micros', detail: `micros must be a positive whole number, got ${String(input.micros)}` };
  }
  if (rollup.accrualIds.has(input.accrualId)) {
    const previous = rollup.accrualAmounts?.get(input.accrualId);
    if (previous !== undefined && previous !== amount.exact) return { ok: false, code: 'invalid-micros', detail: 'accrual replay mismatch' };
    return { ok: true, rollup, duplicate: true };
  }
  let total: ReturnType<typeof splitMicrosDecimal>; let rounding: ReturnType<typeof splitMicrosDecimal>;
  try {
    total = splitMicrosDecimal(addMicrosDecimals(rollup.totalMicrosExact ?? String(rollup.totalMicros), amount.exact));
    rounding = splitMicrosDecimal(addMicrosDecimals(rollup.roundingMicrosExact ?? String(rollup.roundingMicros), amount.exact));
  } catch { return { ok: false, code: 'invalid-micros', detail: 'roll-up total exceeds the safe integer range' }; }
  const accrualIds = new Set(rollup.accrualIds);
  accrualIds.add(input.accrualId);
  const accrualAmounts = new Map(rollup.accrualAmounts); accrualAmounts.set(input.accrualId, amount.exact);
  return {
    ok: true,
    duplicate: false,
    rollup: { ...rollup, totalMicros: total.micros, roundingMicros: rounding.micros,
      totalMicrosExact: total.exact.includes('.') ? total.exact : undefined,
      roundingMicrosExact: rounding.exact.includes('.') ? rounding.exact : undefined, accrualIds, accrualAmounts },
  };
}

/** Split whole cents between the DAO and revenue: the DAO gets floor(cents x bps / 10,000). */
export function daoShareCents(cents: number, daoBasisPoints: number): number {
  if (!Number.isSafeInteger(daoBasisPoints) || daoBasisPoints < 0 || daoBasisPoints > 10_000) {
    throw new Error(`daoShareCents: basis points must be 0-10000, got ${daoBasisPoints}`);
  }
  return Math.floor((cents * daoBasisPoints) / 10_000);
}

export interface SettleRollupInput {
  readonly entryId: string;
  readonly occurredAtMs: number;
  readonly externalRef: ExternalRef;
  readonly daoBasisPoints: number;
  readonly memo?: string;
}

export type SettleResult =
  | { ok: true; journal: MoneyJournalState; rollup: MicrosRollup; settledCents: number; entry: JournalEntry | null }
  | RollupRejection;

/**
 * Settle the roll-up's whole cents into the journal as one `usage-settlement`
 * entry. The sub-cent remainder stays in the rounding balance. Settling a
 * roll-up holding less than a cent posts nothing.
 */
export function settleRollupIntoJournal(journal: MoneyJournalState, rollup: MicrosRollup, input: SettleRollupInput): SettleResult {
  if (rollup.currency !== journal.currency) {
    return { ok: false, code: 'currency-mismatch', detail: `roll-up is in ${rollup.currency}; the journal is in ${journal.currency}` };
  }
  const cents = Math.floor(rollup.roundingMicros / MICROS_PER_CENT);
  if (cents === 0) return { ok: true, journal, rollup, settledCents: 0, entry: null };
  const built = journalEntryForMovement({
    entryId: input.entryId,
    occurredAtMs: input.occurredAtMs,
    currency: journal.currency,
    externalRef: input.externalRef,
    memo: input.memo ?? '',
    rollupId: rollup.rollupId,
    movement: { kind: 'usage-settlement', cents, daoCents: daoShareCents(cents, input.daoBasisPoints) },
  });
  if (!built.ok) return built;
  const posted = postJournalEntry(journal, built.entry);
  if (!posted.ok) return posted;
  return {
    ok: true,
    journal: posted.state,
    entry: posted.entry,
    settledCents: cents,
    rollup: {
      ...rollup,
      settledCents: rollup.settledCents + cents,
      roundingMicros: rollup.roundingMicros - cents * MICROS_PER_CENT,
      roundingMicrosExact: rollup.roundingMicrosExact === undefined ? undefined
        : formatMicrosDecimal(parseMicrosDecimal(rollup.roundingMicrosExact).coefficient
          - BigInt(cents * MICROS_PER_CENT) * 10n ** BigInt(parseMicrosDecimal(rollup.roundingMicrosExact).scale),
        parseMicrosDecimal(rollup.roundingMicrosExact).scale),
    },
  };
}

export interface RollupInvariant {
  readonly rollupId: string;
  readonly totalMicros: number;
  readonly journalCents: number;
  readonly roundingMicros: number;
  readonly totalMicrosExact?: string;
  readonly roundingMicrosExact?: string;
  /** journalCents x 10,000 + roundingMicros = totalMicros, and the roll-up agrees with the journal on settled cents. */
  readonly holds: boolean;
}

/** The R-30 identity for one roll-up, computed from the journal's own entries. */
export function rollupInvariant(entries: readonly JournalEntry[], rollup: MicrosRollup): RollupInvariant {
  const journalCents = entries
    .filter((entry) => entry.rollupId === rollup.rollupId)
    .reduce((sum, entry) => sum + entryTotalCents(entry), 0);
  let exactHolds = false;
  try {
    const total = splitMicrosDecimal(rollup.totalMicrosExact ?? String(rollup.totalMicros));
    const rounding = splitMicrosDecimal(rollup.roundingMicrosExact ?? String(rollup.roundingMicros));
    exactHolds = total.micros === rollup.totalMicros && rounding.micros === rollup.roundingMicros
      && addMicrosDecimals(String(journalCents * MICROS_PER_CENT), rounding.exact) === total.exact;
  } catch { /* Invalid or overflowing exact amounts do not satisfy the identity. */ }
  return {
    rollupId: rollup.rollupId,
    totalMicros: rollup.totalMicros,
    journalCents,
    roundingMicros: rollup.roundingMicros,
    totalMicrosExact: rollup.totalMicrosExact,
    roundingMicrosExact: rollup.roundingMicrosExact,
    holds:
      journalCents * MICROS_PER_CENT + rollup.roundingMicros === rollup.totalMicros &&
      journalCents === rollup.settledCents &&
      rollup.roundingMicros >= 0 && exactHolds,
  };
}
