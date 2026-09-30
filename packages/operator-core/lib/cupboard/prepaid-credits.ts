/**
 * Stripe-funded prepaid BYOC credits (shared-pot DAO plan P-030).
 *
 * The commerce ledger remains the money authority. This reducer derives exactly
 * one credit grant from each verified, paid top-up order and one reversal from
 * each verified refund/chargeback, then folds explicit reserve/settle/release
 * events used to fund the existing microcharge rail.
 *
 * A reversal can arrive after credits were spent. Rather than manufacture a
 * negative spendable balance, the reducer records the shortfall as debt and
 * refuses new reservations until later grants repay it.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { createMicrochargeChannel, type MicrochargeChannel } from '../p2p/microcharge';
import {
  reduceLedger,
  validateLedgerEvent,
  type LedgerEvent,
  type Money,
} from './commerce-ledger';

export const PREPAID_CREDIT_PRODUCT_ID = 'papercusp-prepaid-byoc-credits';
export const PREPAID_CREDIT_OFFER_ID = 'papercusp-prepaid-byoc-credits-usd-10';
export const PREPAID_CREDIT_SKU_REF = 'papercusp:byoc-credits:usd-10';
export const PREPAID_CREDIT_TOP_UP: Money = { amountMinor: 1_000, currency: 'USD' };
export const CREDIT_MICROS_PER_USD_MINOR = 10_000;

/** Idempotent catalog facts the Checkout door can append before reading offers. */
export function prepaidCreditCatalogEvents(occurredAtMs = 0): LedgerEvent[] {
  return [
    {
      ledgerEventId: 'catalog:prepaid-credit:0-product',
      kind: 'product.defined',
      occurredAtMs,
      source: { provider: 'operator', providerEventId: null },
      payload: {
        productId: PREPAID_CREDIT_PRODUCT_ID,
        skuRef: PREPAID_CREDIT_SKU_REF,
        creatorId: 'papercusp-dao',
        title: 'Papercusp prepaid BYOC credits',
      },
    },
    {
      ledgerEventId: 'catalog:prepaid-credit:1-offer',
      kind: 'offer.defined',
      occurredAtMs,
      source: { provider: 'operator', providerEventId: null },
      payload: {
        offerId: PREPAID_CREDIT_OFFER_ID,
        productId: PREPAID_CREDIT_PRODUCT_ID,
        pricingModel: 'one-time',
        price: PREPAID_CREDIT_TOP_UP,
      },
    },
  ];
}

export const PREPAID_CREDIT_EVENT_KINDS = [
  'credit.reserved',
  'credit.settled',
  'credit.released',
] as const;
export type PrepaidCreditEventKind = (typeof PREPAID_CREDIT_EVENT_KINDS)[number];

export interface PrepaidCreditEvent {
  readonly creditEventId: string;
  readonly kind: PrepaidCreditEventKind;
  readonly occurredAtMs: number;
  readonly principalId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface PrepaidCreditBalance {
  readonly principalId: string;
  readonly availableMicros: number;
  readonly reservedMicros: number;
  readonly spentMicros: number;
  readonly debtMicros: number;
  readonly grantedMicros: number;
  readonly reversedMicros: number;
  readonly updatedAtMs: number;
}

export type CreditReservationState = 'open' | 'settled' | 'released';

export interface PrepaidCreditReservation {
  readonly reservationId: string;
  readonly principalId: string;
  readonly channelId: string;
  readonly reservedMicros: number;
  readonly committedMicros: number;
  readonly state: CreditReservationState;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type PrepaidCreditRejectionCode =
  | 'invalid-event'
  | 'duplicate-conflict'
  | 'unsupported-currency'
  | 'negative-balance'
  | 'unknown-reservation'
  | 'reservation-conflict'
  | 'invalid-transition'
  | 'amount-exceeds-reservation';

export interface PrepaidCreditRejection {
  readonly eventId: string;
  readonly kind: string;
  readonly code: PrepaidCreditRejectionCode;
  readonly detail: string;
}

export interface PrepaidCreditLedgerState {
  readonly balances: Map<string, PrepaidCreditBalance>;
  readonly reservations: Map<string, PrepaidCreditReservation>;
  readonly applied: string[];
  readonly duplicates: string[];
  readonly rejected: PrepaidCreditRejection[];
}

type CreditOperation =
  | {
      readonly id: string;
      readonly kind: 'grant' | 'reverse';
      readonly occurredAtMs: number;
      readonly principalId: string;
      readonly amountMicros: number;
    }
  | {
      readonly id: string;
      readonly kind: 'manual';
      readonly occurredAtMs: number;
      readonly principalId: string;
      readonly event: PrepaidCreditEvent;
    };

type ApplyResult =
  | { ok: true }
  | { ok: false; code: PrepaidCreditRejectionCode; detail: string };

function isSafeMicros(value: unknown, allowZero = false): value is number {
  return (
    Number.isSafeInteger(value) &&
    (allowZero ? (value as number) >= 0 : (value as number) > 0)
  );
}

function stringField(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function emptyState(): PrepaidCreditLedgerState {
  return {
    balances: new Map(),
    reservations: new Map(),
    applied: [],
    duplicates: [],
    rejected: [],
  };
}

function balanceFor(
  state: PrepaidCreditLedgerState,
  principalId: string,
  occurredAtMs: number,
): PrepaidCreditBalance {
  return (
    state.balances.get(principalId) ?? {
      principalId,
      availableMicros: 0,
      reservedMicros: 0,
      spentMicros: 0,
      debtMicros: 0,
      grantedMicros: 0,
      reversedMicros: 0,
      updatedAtMs: occurredAtMs,
    }
  );
}

function setBalance(
  state: PrepaidCreditLedgerState,
  balance: PrepaidCreditBalance,
): void {
  state.balances.set(balance.principalId, balance);
}

function moneyToCreditMicros(money: Money): number | null {
  if (money.currency !== 'USD') return null;
  const amount = money.amountMinor * CREDIT_MICROS_PER_USD_MINOR;
  return Number.isSafeInteger(amount) ? amount : null;
}

function derivedOperations(commerceEvents: readonly unknown[]): CreditOperation[] {
  const commerce = reduceLedger(commerceEvents);
  const applied = new Set(commerce.applied);
  const paidAt = new Map<string, number>();
  const refundedAt = new Map<string, number>();

  for (const raw of commerceEvents) {
    const verdict = validateLedgerEvent(raw);
    if (!verdict.ok || !applied.has(verdict.event.ledgerEventId)) continue;
    const event = verdict.event;
    if (event.source.provider !== 'stripe' || !event.source.providerEventId) continue;
    if (event.kind === 'order.paid') {
      const orderId = stringField(event.payload, 'orderId');
      if (orderId && !paidAt.has(orderId)) paidAt.set(orderId, event.occurredAtMs);
    } else if (event.kind === 'refund.succeeded') {
      const refundId = stringField(event.payload, 'refundId');
      if (refundId && !refundedAt.has(refundId)) refundedAt.set(refundId, event.occurredAtMs);
    }
  }

  const operations: CreditOperation[] = [];
  for (const [orderId, occurredAtMs] of paidAt) {
    const order = commerce.orders.get(orderId);
    if (!order || order.offerId !== PREPAID_CREDIT_OFFER_ID) continue;
    const amountMicros = moneyToCreditMicros(order.amount);
    if (amountMicros == null) continue;
    operations.push({
      id: `stripe-topup:${orderId}`,
      kind: 'grant',
      occurredAtMs,
      principalId: order.buyerId,
      amountMicros,
    });
  }

  for (const [refundId, occurredAtMs] of refundedAt) {
    const refund = commerce.refunds.get(refundId);
    const order = refund ? commerce.orders.get(refund.orderId) : null;
    if (!refund || !order || order.offerId !== PREPAID_CREDIT_OFFER_ID) continue;
    const amountMicros = moneyToCreditMicros(refund.amount);
    if (amountMicros == null) continue;
    operations.push({
      id: `stripe-reversal:${refundId}`,
      kind: 'reverse',
      occurredAtMs,
      principalId: order.buyerId,
      amountMicros,
    });
  }
  return operations;
}

function validateManualEvent(raw: unknown): PrepaidCreditEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const event = raw as Partial<PrepaidCreditEvent>;
  if (typeof event.creditEventId !== 'string' || !event.creditEventId.trim()) return null;
  if (!PREPAID_CREDIT_EVENT_KINDS.includes(event.kind as PrepaidCreditEventKind)) return null;
  if (!Number.isFinite(event.occurredAtMs) || (event.occurredAtMs as number) < 0) return null;
  if (typeof event.principalId !== 'string' || !event.principalId.trim()) return null;
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return null;
  return event as PrepaidCreditEvent;
}

function eventDigest(event: PrepaidCreditEvent): string {
  return createHash('sha256').update(canonicalJson(event)).digest('hex');
}

function applyDerived(
  state: PrepaidCreditLedgerState,
  operation: Extract<CreditOperation, { kind: 'grant' | 'reverse' }>,
): ApplyResult {
  const current = balanceFor(state, operation.principalId, operation.occurredAtMs);
  if (operation.kind === 'grant') {
    const debtPaid = Math.min(current.debtMicros, operation.amountMicros);
    setBalance(state, {
      ...current,
      availableMicros: current.availableMicros + operation.amountMicros - debtPaid,
      debtMicros: current.debtMicros - debtPaid,
      grantedMicros: current.grantedMicros + operation.amountMicros,
      updatedAtMs: operation.occurredAtMs,
    });
    return { ok: true };
  }

  const fromAvailable = Math.min(current.availableMicros, operation.amountMicros);
  setBalance(state, {
    ...current,
    availableMicros: current.availableMicros - fromAvailable,
    debtMicros: current.debtMicros + operation.amountMicros - fromAvailable,
    reversedMicros: current.reversedMicros + operation.amountMicros,
    updatedAtMs: operation.occurredAtMs,
  });
  return { ok: true };
}

function applyManual(
  state: PrepaidCreditLedgerState,
  event: PrepaidCreditEvent,
): ApplyResult {
  const payload = event.payload;
  const reservationId = stringField(payload, 'reservationId');
  if (!reservationId) {
    return { ok: false, code: 'invalid-event', detail: `${event.kind} needs reservationId` };
  }

  if (event.kind === 'credit.reserved') {
    const channelId = stringField(payload, 'channelId');
    const amountMicros = payload.amountMicros;
    if (!channelId || !isSafeMicros(amountMicros)) {
      return {
        ok: false,
        code: 'invalid-event',
        detail: 'credit.reserved needs channelId and a positive safe-integer amountMicros',
      };
    }
    const existing = state.reservations.get(reservationId);
    if (existing) {
      return existing.principalId === event.principalId &&
        existing.channelId === channelId &&
        existing.reservedMicros === amountMicros
        ? { ok: true }
        : {
            ok: false,
            code: 'reservation-conflict',
            detail: `reservation ${reservationId} already has different terms`,
          };
    }
    const balance = balanceFor(state, event.principalId, event.occurredAtMs);
    if (balance.debtMicros > 0 || balance.availableMicros < amountMicros) {
      return {
        ok: false,
        code: 'negative-balance',
        detail: `principal ${event.principalId} has ${balance.availableMicros} available and ${balance.debtMicros} debt; cannot reserve ${amountMicros}`,
      };
    }
    setBalance(state, {
      ...balance,
      availableMicros: balance.availableMicros - amountMicros,
      reservedMicros: balance.reservedMicros + amountMicros,
      updatedAtMs: event.occurredAtMs,
    });
    state.reservations.set(reservationId, {
      reservationId,
      principalId: event.principalId,
      channelId,
      reservedMicros: amountMicros,
      committedMicros: 0,
      state: 'open',
      createdAtMs: event.occurredAtMs,
      updatedAtMs: event.occurredAtMs,
    });
    return { ok: true };
  }

  const reservation = state.reservations.get(reservationId);
  if (!reservation) {
    return {
      ok: false,
      code: 'unknown-reservation',
      detail: `reservation ${reservationId} is not known`,
    };
  }
  if (reservation.principalId !== event.principalId) {
    return {
      ok: false,
      code: 'reservation-conflict',
      detail: `reservation ${reservationId} belongs to another principal`,
    };
  }
  const balance = balanceFor(state, event.principalId, event.occurredAtMs);

  if (event.kind === 'credit.released') {
    if (reservation.state === 'released') return { ok: true };
    if (reservation.state !== 'open') {
      return {
        ok: false,
        code: 'invalid-transition',
        detail: `reservation ${reservationId} cannot move ${reservation.state} -> released`,
      };
    }
    setBalance(state, {
      ...balance,
      availableMicros: balance.availableMicros + reservation.reservedMicros,
      reservedMicros: balance.reservedMicros - reservation.reservedMicros,
      updatedAtMs: event.occurredAtMs,
    });
    state.reservations.set(reservationId, {
      ...reservation,
      state: 'released',
      updatedAtMs: event.occurredAtMs,
    });
    return { ok: true };
  }

  const committedMicros = payload.committedMicros;
  if (!isSafeMicros(committedMicros, true)) {
    return {
      ok: false,
      code: 'invalid-event',
      detail: 'credit.settled needs a non-negative safe-integer committedMicros',
    };
  }
  if (reservation.state === 'settled') {
    return reservation.committedMicros === committedMicros
      ? { ok: true }
      : {
          ok: false,
          code: 'invalid-transition',
          detail: `reservation ${reservationId} was already settled for ${reservation.committedMicros}`,
        };
  }
  if (reservation.state !== 'open') {
    return {
      ok: false,
      code: 'invalid-transition',
      detail: `reservation ${reservationId} cannot move ${reservation.state} -> settled`,
    };
  }
  if (committedMicros > reservation.reservedMicros) {
    return {
      ok: false,
      code: 'amount-exceeds-reservation',
      detail: `committed ${committedMicros} exceeds reserved ${reservation.reservedMicros}`,
    };
  }
  const releasedMicros = reservation.reservedMicros - committedMicros;
  setBalance(state, {
    ...balance,
    availableMicros: balance.availableMicros + releasedMicros,
    reservedMicros: balance.reservedMicros - reservation.reservedMicros,
    spentMicros: balance.spentMicros + committedMicros,
    updatedAtMs: event.occurredAtMs,
  });
  state.reservations.set(reservationId, {
    ...reservation,
    committedMicros,
    state: 'settled',
    updatedAtMs: event.occurredAtMs,
  });
  return { ok: true };
}

/**
 * Fold verified commerce facts plus explicit microcharge reservation events.
 *
 * Ordering is deterministic and independent of input order. Semantic grant ids
 * are order-based and reversal ids are refund/dispute-based, so a provider retry
 * under a second webhook event id still cannot mint or reverse twice.
 */
export function reducePrepaidCredits(
  commerceEvents: readonly unknown[],
  creditEvents: readonly unknown[] = [],
): PrepaidCreditLedgerState {
  const state = emptyState();
  const operations = derivedOperations(commerceEvents);
  const seenManual = new Map<string, string>();

  for (const raw of creditEvents) {
    const event = validateManualEvent(raw);
    if (!event) {
      const partial = raw && typeof raw === 'object' ? (raw as Partial<PrepaidCreditEvent>) : {};
      state.rejected.push({
        eventId: typeof partial.creditEventId === 'string' ? partial.creditEventId : '',
        kind: typeof partial.kind === 'string' ? partial.kind : '',
        code: 'invalid-event',
        detail: 'credit event needs id, supported kind, timestamp, principalId and payload',
      });
      continue;
    }
    const digest = eventDigest(event);
    const prior = seenManual.get(event.creditEventId);
    if (prior !== undefined) {
      if (prior === digest) state.duplicates.push(event.creditEventId);
      else {
        state.rejected.push({
          eventId: event.creditEventId,
          kind: event.kind,
          code: 'duplicate-conflict',
          detail: 'a different credit fact already carries this creditEventId',
        });
      }
      continue;
    }
    seenManual.set(event.creditEventId, digest);
    operations.push({
      id: event.creditEventId,
      kind: 'manual',
      occurredAtMs: event.occurredAtMs,
      principalId: event.principalId,
      event,
    });
  }

  operations.sort(
    (a, b) =>
      a.occurredAtMs - b.occurredAtMs ||
      a.id.localeCompare(b.id),
  );
  for (const operation of operations) {
    const result =
      operation.kind === 'manual'
        ? applyManual(state, operation.event)
        : applyDerived(state, operation);
    if (result.ok) state.applied.push(operation.id);
    else {
      state.rejected.push({
        eventId: operation.id,
        kind: operation.kind === 'manual' ? operation.event.kind : operation.kind,
        code: result.code,
        detail: result.detail,
      });
    }
  }
  return state;
}

export function serializePrepaidCreditState(state: PrepaidCreditLedgerState): {
  balances: PrepaidCreditBalance[];
  reservations: PrepaidCreditReservation[];
} {
  return {
    balances: [...state.balances.values()].sort((a, b) =>
      a.principalId.localeCompare(b.principalId),
    ),
    reservations: [...state.reservations.values()].sort((a, b) =>
      a.reservationId.localeCompare(b.reservationId),
    ),
  };
}

/** Turn an OPEN credit reservation into the escrow object the P-020 rail uses. */
export function microchargeChannelForCreditReservation(
  state: PrepaidCreditLedgerState,
  reservationId: string,
): { ok: true; channel: MicrochargeChannel } | { ok: false; code: 'unknown-reservation' | 'reservation-not-open'; detail: string } {
  const reservation = state.reservations.get(reservationId);
  if (!reservation) {
    return {
      ok: false,
      code: 'unknown-reservation',
      detail: `reservation ${reservationId} is not known`,
    };
  }
  if (reservation.state !== 'open') {
    return {
      ok: false,
      code: 'reservation-not-open',
      detail: `reservation ${reservationId} is ${reservation.state}`,
    };
  }
  return {
    ok: true,
    channel: createMicrochargeChannel(
      reservation.channelId,
      BigInt(reservation.reservedMicros),
    ),
  };
}
