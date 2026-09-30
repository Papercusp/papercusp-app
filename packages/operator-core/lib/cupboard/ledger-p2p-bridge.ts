/**
 * The ledger ↔ P2P commerce bridge (P-035, D-048).
 *
 * P-016 publishes SIGNED commerce events on the P2P rail; P-010 keeps the
 * authoritative ledger the account and dashboard projections fold. Before this
 * module the two never met: `loadCommerceLedgerEvents` returned an empty fold
 * unconditionally, so a per-use purchase settled on the P2P rail granted no
 * ledger entitlement, appeared in no dashboard, and its reversal propagated
 * nowhere.
 *
 * WHY THE BRIDGE SPLITS ITS OUTPUT IN TWO
 *
 * Per-use money is `bigint` MICROS (1e-6 of a currency unit — see
 * `microcharge.CumulativePaymentVoucher`), and the ledger's `Money` is an
 * integer count of MINOR units (cents). A single usage receipt is routinely
 * worth a fraction of one cent, so projecting receipts into ledger orders would
 * floor most of them to zero and silently destroy revenue — the failure would
 * show up as a dashboard that under-reports, which is indistinguishable from a
 * quiet period. So each fact goes to the store that can represent it EXACTLY:
 *
 *   - `bridgeCommerceEventsToLedger` maps only the kinds the ledger models
 *     exactly in minor units — offers, orders, refunds, reversals.
 *   - `perUseRollup` keeps usage and settlement in micros, as decimal strings
 *     at the boundary (the same convention `buildSettlementProofEvent` uses),
 *     and never rounds.
 *
 * A `usage-receipt` is a CLAIM and a `settlement-proof` with `final: true` is
 * FINALITY; the rollup reports them separately because acceptance line 14 turns
 * on exactly that distinction, and D-055 puts finality on chain rather than on
 * the hive log.
 *
 * IDEMPOTENCY. Every emitted ledger event id is derived from the commerce
 * event's own `(streamId, sequence)` — never from its position in the batch —
 * so re-bridging a larger batch produces byte-identical events for the facts it
 * already carried, and `reduceLedger` reports them as duplicates rather than
 * rejecting them. The zero-padded sequence also makes the ids sort in causal
 * order within a stream, which is what keeps a `product.defined` ahead of the
 * `offer.defined` it is a precondition for when both carry one timestamp.
 */
import type { CommerceEvent } from '../p2p/commerce-events';

import type { Entitlement, LedgerEvent, Money } from './commerce-ledger';
import type { EntitlementGrant, EntitlementProjection } from './entitled-delivery';

/** A commerce fact this bridge could not carry across, and why. */
export interface BridgeIssue {
  readonly eventId: string;
  readonly reason: string;
}

export interface CommerceLedgerBridgeResult {
  /**
   * Ledger events in emission order. Feed them to `reduceLedger` ALONGSIDE any
   * locally-sourced events; the reducer owns ordering, idempotency and every
   * transition rule, and this module deliberately re-implements none of it.
   */
  readonly ledgerEvents: readonly LedgerEvent[];
  /** Kinds the ledger cannot represent exactly — see `perUseRollup`. */
  readonly deferredToRollup: readonly string[];
  readonly unbridged: readonly BridgeIssue[];
}

const LEDGER_PROVIDER = 'p2p';

/** Widest zero-pad that keeps a safe-integer sequence lexicographically ordered. */
const SEQUENCE_PAD = 16;

function ledgerEventId(event: CommerceEvent, suffix: string): string {
  return `p2p:${event.streamId}:${String(event.sequence).padStart(SEQUENCE_PAD, '0')}:${suffix}`;
}

function readString(payload: Readonly<Record<string, unknown>>, field: string): string | null {
  const value = payload[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readMoney(value: unknown): Money | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const money = value as Partial<Money>;
  if (!Number.isSafeInteger(money.amountMinor) || (money.amountMinor as number) < 0) return null;
  if (typeof money.currency !== 'string' || !/^[A-Z]{3}$/.test(money.currency)) return null;
  return { amountMinor: money.amountMinor as number, currency: money.currency };
}

/**
 * Read a micros amount that crossed a JSON boundary.
 *
 * Micros are emitted as DECIMAL STRINGS (`bigint.toString()`) because a
 * cumulative claim can exceed `Number.MAX_SAFE_INTEGER` — accepting a `number`
 * here would let a large channel's total lose its low digits before the bridge
 * ever saw it. A safe integer is still accepted, because a small hand-built
 * fact is legitimately a number, but a non-integral or unsafe one is refused
 * rather than coerced.
 */
function readMicros(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value.trim())) return null;
    return BigInt(value.trim());
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  return null;
}

function source(event: CommerceEvent): LedgerEvent['source'] {
  return { provider: LEDGER_PROVIDER, providerEventId: event.eventId };
}

/**
 * Project accepted P-016 commerce events into P-010 ledger events.
 *
 * INPUT MUST BE `reduceCommerceEvents(...).accepted`. That reducer owns
 * signature-shape validation, idempotency and conflict quarantine; taking raw
 * events here would open a second, less careful door into the ledger — the
 * exact hazard `projectEntitlements` documents on the delivery side.
 *
 * Kinds are mapped only where the ledger's own reducer can check the fact:
 *
 *   offer     → `product.defined` + `offer.defined` (the ledger already carries
 *               `PerUseOfferTerms`, so per-use pricing survives the crossing)
 *   order     → `order.created`, plus `order.paid` when the fact says it is paid
 *   refund    → `refund.requested` and/or `refund.succeeded`
 *   reversal  → `entitlement.revoked`
 *
 * An `entitlement` event emits NOTHING here on purpose: the ledger mints
 * `ent:<orderId>` itself when an order is paid, so bridging one would grant the
 * same entitlement twice under two ids and leave a revocation able to reach
 * only one of them. Entitlement events reach delivery through
 * `projectEntitlements`, and the two views are combined by
 * `mergeEntitlementProjections`.
 */
export function bridgeCommerceEventsToLedger(
  accepted: readonly CommerceEvent[],
): CommerceLedgerBridgeResult {
  const ledgerEvents: LedgerEvent[] = [];
  const unbridged: BridgeIssue[] = [];
  const deferredToRollup: string[] = [];

  for (const event of accepted) {
    const p = event.payload;
    const at = event.occurredAtMs;

    switch (event.kind) {
      case 'offer': {
        const productId = readString(p, 'productId');
        const offerId = readString(p, 'offerId');
        const skuRef = readString(p, 'skuRef');
        const creatorId = readString(p, 'creatorId');
        const title = readString(p, 'title');
        const pricingModel = readString(p, 'pricingModel');
        const price = readMoney(p.price);
        if (!productId || !offerId || !skuRef || !creatorId || !title || !pricingModel) {
          unbridged.push({
            eventId: event.eventId,
            reason:
              'offer event needs productId, offerId, skuRef, creatorId, title and pricingModel to define a ledger product and offer',
          });
          continue;
        }
        if (!price) {
          unbridged.push({
            eventId: event.eventId,
            reason: 'offer event price must be integer minor units + an ISO-4217 currency',
          });
          continue;
        }
        ledgerEvents.push({
          ledgerEventId: ledgerEventId(event, '1-product'),
          kind: 'product.defined',
          occurredAtMs: at,
          source: source(event),
          payload: { productId, skuRef, creatorId, title, active: p.active !== false },
        });
        ledgerEvents.push({
          ledgerEventId: ledgerEventId(event, '2-offer'),
          kind: 'offer.defined',
          occurredAtMs: at,
          source: source(event),
          payload: {
            offerId,
            productId,
            pricingModel,
            price,
            active: p.active !== false,
            // Passed through UNVALIDATED on purpose: `perUseTerms` in the ledger
            // is the single authority on what a per-use offer must carry, and a
            // second shape check here could accept terms the ledger rejects (or
            // the reverse) without either side reporting a disagreement.
            ...(p.perUse != null ? { perUse: p.perUse } : {}),
          },
        });
        continue;
      }

      case 'order': {
        const orderId = readString(p, 'orderId');
        const offerId = readString(p, 'offerId');
        const buyerId = readString(p, 'buyerId');
        if (!orderId || !offerId || !buyerId) {
          unbridged.push({
            eventId: event.eventId,
            reason: 'order event needs orderId, offerId and buyerId',
          });
          continue;
        }
        const amount = readMoney(p.amount);
        const providerRef = readString(p, 'providerRef');
        ledgerEvents.push({
          ledgerEventId: ledgerEventId(event, '1-order-created'),
          kind: 'order.created',
          occurredAtMs: at,
          source: source(event),
          payload: {
            orderId,
            offerId,
            buyerId,
            ...(amount ? { amount } : {}),
            ...(providerRef ? { providerRef } : {}),
          },
        });
        // A P2P order announces its own settlement rather than waiting for a
        // provider webhook, so `paid` (or `state: 'paid'`) is what mints the
        // entitlement. Anything else stays PENDING: inferring payment from the
        // mere existence of an order is how an unpaid buyer gets the bytes.
        const paid = p.paid === true || readString(p, 'state') === 'paid';
        if (paid) {
          ledgerEvents.push({
            ledgerEventId: ledgerEventId(event, '2-order-paid'),
            kind: 'order.paid',
            occurredAtMs: at,
            source: source(event),
            payload: {
              orderId,
              ...(amount ? { amount } : {}),
              ...(providerRef ? { providerRef } : {}),
            },
          });
        }
        continue;
      }

      case 'refund': {
        const refundId = readString(p, 'refundId');
        const orderId = readString(p, 'orderId');
        const amount = readMoney(p.amount);
        if (!refundId || !orderId) {
          unbridged.push({
            eventId: event.eventId,
            reason: 'refund event needs refundId and orderId',
          });
          continue;
        }
        if (!amount) {
          unbridged.push({
            eventId: event.eventId,
            reason: 'refund event amount must be integer minor units + an ISO-4217 currency',
          });
          continue;
        }
        const state = readString(p, 'state') ?? 'succeeded';
        if (state !== 'pending' && state !== 'succeeded') {
          unbridged.push({
            eventId: event.eventId,
            reason: `refund event state '${state}' is neither 'pending' nor 'succeeded'`,
          });
          continue;
        }
        const providerRef = readString(p, 'providerRef');
        const base = {
          refundId,
          orderId,
          amount,
          ...(providerRef ? { providerRef } : {}),
        };
        ledgerEvents.push({
          ledgerEventId: ledgerEventId(event, '1-refund-requested'),
          kind: 'refund.requested',
          occurredAtMs: at,
          source: source(event),
          payload: base,
        });
        if (state === 'succeeded') {
          ledgerEvents.push({
            ledgerEventId: ledgerEventId(event, '2-refund-succeeded'),
            kind: 'refund.succeeded',
            occurredAtMs: at,
            source: source(event),
            payload: base,
          });
        }
        continue;
      }

      case 'reversal': {
        const entitlementId = readString(p, 'entitlementId');
        if (!entitlementId) {
          unbridged.push({
            eventId: event.eventId,
            reason: 'reversal event needs entitlementId to revoke a ledger entitlement',
          });
          continue;
        }
        ledgerEvents.push({
          ledgerEventId: ledgerEventId(event, '1-entitlement-revoked'),
          kind: 'entitlement.revoked',
          occurredAtMs: at,
          source: source(event),
          payload: { entitlementId, reason: readString(p, 'reason') ?? 'reversal' },
        });
        continue;
      }

      case 'entitlement':
      case 'usage-receipt':
      case 'settlement-proof':
      case 'revenue-split':
        deferredToRollup.push(event.eventId);
        continue;

      default:
        unbridged.push({
          eventId: event.eventId,
          reason: `unsupported commerce event kind '${String(event.kind)}'`,
        });
    }
  }

  return { ledgerEvents, deferredToRollup, unbridged };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-use rollup — micros, never rounded
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One per-use channel's position.
 *
 * Every micros field is a DECIMAL STRING of a non-negative integer, matching
 * `buildSettlementProofEvent`'s payload convention. It is deliberately not a
 * `number`: a cumulative claim can exceed `Number.MAX_SAFE_INTEGER`, and it is
 * deliberately not a `bigint`, because this value crosses the agent-tool JSON
 * boundary where `bigint` does not serialize.
 */
export interface PerUseChannelPosition {
  readonly channelId: string;
  readonly releaseRef: string | null;
  readonly payer: string | null;
  readonly seller: string | null;
  /** Summed `usage-receipt` amounts — money CLAIMED, not money received. */
  readonly claimedMicros: string;
  readonly receipts: number;
  /** Summed `settlement-proof` amounts with `final: true` — money RECEIVED. */
  readonly settledMicros: string;
  /** Claimed on chain but not yet final (`finality: 'claimed'`). */
  readonly pendingSettlementMicros: string;
  /** Summed `reversal` amounts naming this channel. */
  readonly reversedMicros: string;
  /** `settledMicros - reversedMicros`, floored at zero. */
  readonly netSettledMicros: string;
  readonly lastEventAtMs: number;
}

export interface PerUseRollup {
  readonly channels: readonly PerUseChannelPosition[];
  readonly totals: {
    readonly claimedMicros: string;
    readonly settledMicros: string;
    readonly pendingSettlementMicros: string;
    readonly reversedMicros: string;
    readonly netSettledMicros: string;
  };
  readonly unusable: readonly BridgeIssue[];
}

interface ChannelAccumulator {
  channelId: string;
  releaseRef: string | null;
  payer: string | null;
  seller: string | null;
  claimedMicros: bigint;
  receipts: number;
  settledMicros: bigint;
  pendingSettlementMicros: bigint;
  reversedMicros: bigint;
  lastEventAtMs: number;
}

function accumulatorFor(
  channels: Map<string, ChannelAccumulator>,
  channelId: string,
): ChannelAccumulator {
  const existing = channels.get(channelId);
  if (existing) return existing;
  const created: ChannelAccumulator = {
    channelId,
    releaseRef: null,
    payer: null,
    seller: null,
    claimedMicros: 0n,
    receipts: 0,
    settledMicros: 0n,
    pendingSettlementMicros: 0n,
    reversedMicros: 0n,
    lastEventAtMs: 0,
  };
  channels.set(channelId, created);
  return created;
}

/**
 * Fold per-use usage, settlement and reversal facts into a per-channel view.
 *
 * This is what makes per-use revenue and reversals visible to a dashboard
 * WITHOUT rounding a sub-cent receipt to zero. `claimedMicros` and
 * `settledMicros` are reported separately and never summed together, because a
 * cumulative voucher's claim is a promise the seller holds and a settlement
 * proof is money that actually moved — conflating them is precisely the
 * "payment claim vs payment finality" error acceptance line 14 forbids.
 *
 * A settlement proof's `claimMicros` is the amount THIS batch settles (a
 * `cumulativeClaimMicros` is the running total the channel has ever claimed, so
 * summing that across proofs would multiply-count every earlier unit).
 */
export function perUseRollup(accepted: readonly CommerceEvent[]): PerUseRollup {
  const channels = new Map<string, ChannelAccumulator>();
  const unusable: BridgeIssue[] = [];
  const settledRequestHashes = new Set<string>();

  for (const event of accepted) {
    if (
      event.kind !== 'usage-receipt' &&
      event.kind !== 'settlement-proof' &&
      event.kind !== 'reversal'
    ) {
      continue;
    }
    const p = event.payload;
    const channelId = readString(p, 'channelId');
    if (!channelId) {
      // A reversal that names no channel is still a real ledger fact (it
      // revokes an entitlement); it simply cannot be attributed to a per-use
      // position, so it is reported here rather than dropped.
      if (event.kind !== 'reversal') {
        unusable.push({
          eventId: event.eventId,
          reason: `${event.kind} event needs channelId to be attributed to a per-use position`,
        });
      }
      continue;
    }

    const channel = accumulatorFor(channels, channelId);
    if (event.occurredAtMs > channel.lastEventAtMs) channel.lastEventAtMs = event.occurredAtMs;
    channel.releaseRef = channel.releaseRef ?? readString(p, 'releaseRef');
    channel.payer = channel.payer ?? readString(p, 'payer');
    channel.seller = channel.seller ?? readString(p, 'seller');

    if (event.kind === 'usage-receipt') {
      const micros = readMicros(p.amountMicros);
      if (micros === null) {
        unusable.push({
          eventId: event.eventId,
          reason: 'usage-receipt needs amountMicros as a non-negative integer (decimal string)',
        });
        continue;
      }
      channel.claimedMicros += micros;
      channel.receipts += 1;
      continue;
    }

    if (event.kind === 'settlement-proof') {
      const micros = readMicros(p.claimMicros);
      if (micros === null) {
        unusable.push({
          eventId: event.eventId,
          reason: 'settlement-proof needs claimMicros as a non-negative integer (decimal string)',
        });
        continue;
      }
      const isFinal = p.final === true || readString(p, 'finality') === 'final';
      const requestHash = readString(p, 'requestHash');
      if (isFinal) {
        // The `claimed` and `final` proofs of ONE batch are two distinct events
        // by construction (`buildSettlementProofEvent` derives each id from the
        // finality). Counting the final one moves the batch out of pending
        // rather than adding to it — keyed on requestHash so an out-of-order
        // arrival of the claimed proof cannot resurrect the pending amount.
        settledRequestHashes.add(requestHash ?? event.eventId);
        channel.settledMicros += micros;
      } else if (!settledRequestHashes.has(requestHash ?? event.eventId)) {
        channel.pendingSettlementMicros += micros;
      }
      continue;
    }

    // reversal
    const micros = readMicros(p.amountMicros) ?? readMicros(p.reversedMicros);
    if (micros === null) {
      unusable.push({
        eventId: event.eventId,
        reason:
          'reversal names a channel but carries no amountMicros/reversedMicros, so its per-use effect cannot be measured',
      });
      continue;
    }
    channel.reversedMicros += micros;
  }

  // A `final` proof can arrive before the `claimed` one it supersedes, so the
  // pending column is corrected after the fold rather than during it.
  for (const channel of channels.values()) {
    if (channel.settledMicros > 0n && channel.pendingSettlementMicros > 0n) {
      const corrected = channel.pendingSettlementMicros - channel.settledMicros;
      channel.pendingSettlementMicros = corrected > 0n ? corrected : 0n;
    }
  }

  const ordered = [...channels.values()].sort((a, b) => a.channelId.localeCompare(b.channelId));
  const totals = { claimed: 0n, settled: 0n, pending: 0n, reversed: 0n, net: 0n };
  const lines = ordered.map((channel) => {
    const net =
      channel.settledMicros > channel.reversedMicros
        ? channel.settledMicros - channel.reversedMicros
        : 0n;
    totals.claimed += channel.claimedMicros;
    totals.settled += channel.settledMicros;
    totals.pending += channel.pendingSettlementMicros;
    totals.reversed += channel.reversedMicros;
    totals.net += net;
    return {
      channelId: channel.channelId,
      releaseRef: channel.releaseRef,
      payer: channel.payer,
      seller: channel.seller,
      claimedMicros: channel.claimedMicros.toString(),
      receipts: channel.receipts,
      settledMicros: channel.settledMicros.toString(),
      pendingSettlementMicros: channel.pendingSettlementMicros.toString(),
      reversedMicros: channel.reversedMicros.toString(),
      netSettledMicros: net.toString(),
      lastEventAtMs: channel.lastEventAtMs,
    } satisfies PerUseChannelPosition;
  });

  return {
    channels: lines,
    totals: {
      claimedMicros: totals.claimed.toString(),
      settledMicros: totals.settled.toString(),
      pendingSettlementMicros: totals.pending.toString(),
      reversedMicros: totals.reversed.toString(),
      netSettledMicros: totals.net.toString(),
    },
    unusable,
  };
}

/**
 * One organization's view of the per-use rollup.
 *
 * `excludedChannels` is not decoration: without it an org that is party to no
 * channel and an org whose channels were all filtered out render identically,
 * and "you have no per-use revenue" would be indistinguishable from "this view
 * is scoped and you are not seeing everything".
 */
export interface PerUseDashboard {
  readonly channels: readonly PerUseChannelPosition[];
  readonly totals: PerUseRollup['totals'];
  /** Channels present in the rollup that this org is not a party to. */
  readonly excludedChannels: number;
  /** Facts the rollup could not attribute — carried through, never hidden. */
  readonly unusable: readonly BridgeIssue[];
}

/**
 * Scope a per-use rollup to one organization.
 *
 * A channel is visible when the org is its PAYER or its SELLER. Anything else
 * is another party's money: the dashboards door is an authorization boundary,
 * and a read surface that shows a stranger's revenue is a leak whether or not
 * anyone meant it as one. Totals are recomputed over the visible channels
 * rather than copied from the rollup, because a total that silently includes
 * rows the caller cannot see is worse than no total at all.
 */
export function perUseDashboard(
  rollup: PerUseRollup | null,
  orgId: string,
): PerUseDashboard {
  if (!rollup) {
    return {
      channels: [],
      totals: {
        claimedMicros: '0',
        settledMicros: '0',
        pendingSettlementMicros: '0',
        reversedMicros: '0',
        netSettledMicros: '0',
      },
      excludedChannels: 0,
      unusable: [],
    };
  }
  const visible = rollup.channels.filter(
    (channel) => channel.payer === orgId || channel.seller === orgId,
  );
  const totals = { claimed: 0n, settled: 0n, pending: 0n, reversed: 0n, net: 0n };
  for (const channel of visible) {
    totals.claimed += BigInt(channel.claimedMicros);
    totals.settled += BigInt(channel.settledMicros);
    totals.pending += BigInt(channel.pendingSettlementMicros);
    totals.reversed += BigInt(channel.reversedMicros);
    totals.net += BigInt(channel.netSettledMicros);
  }
  return {
    channels: visible,
    totals: {
      claimedMicros: totals.claimed.toString(),
      settledMicros: totals.settled.toString(),
      pendingSettlementMicros: totals.pending.toString(),
      reversedMicros: totals.reversed.toString(),
      netSettledMicros: totals.net.toString(),
    },
    excludedChannels: rollup.channels.length - visible.length,
    unusable: rollup.unusable,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Combining the two entitlement views
// ─────────────────────────────────────────────────────────────────────────────

function grantKeyOf(grant: EntitlementGrant): string {
  return `${grant.subject}\n${grant.releaseRef}`;
}

/**
 * Combine entitlement projections from several sources into the one view a
 * delivery gate reads.
 *
 * REVOCATION IS TERMINAL ACROSS SOURCES. If any projection says a grant is
 * revoked, the merged grant is revoked — with the EARLIEST revocation time,
 * because a buyer whose refund settled on the P2P rail must not keep delivery
 * merely because the ledger's own view of that grant has not caught up. The
 * asymmetry is deliberate: a false revocation costs a support ticket, while a
 * false grant hands over bytes that were paid for and then refunded.
 *
 * Later sources win on the non-revocation fields, so callers should pass the
 * more authoritative projection last.
 */
export function mergeEntitlementProjections(
  ...projections: readonly EntitlementProjection[]
): EntitlementProjection {
  const grants = new Map<string, EntitlementGrant>();
  const unusable: BridgeIssue[] = [];
  const seenIssues = new Set<string>();

  for (const projection of projections) {
    for (const issue of projection.unusable) {
      const key = `${issue.eventId}\n${issue.reason}`;
      if (seenIssues.has(key)) continue;
      seenIssues.add(key);
      unusable.push(issue);
    }
    for (const grant of projection.grants.values()) {
      const key = grantKeyOf(grant);
      const existing = grants.get(key);
      if (!existing) {
        grants.set(key, grant);
        continue;
      }
      const revokedAtMs =
        existing.revokedAtMs != null && grant.revokedAtMs != null
          ? Math.min(existing.revokedAtMs, grant.revokedAtMs)
          : (existing.revokedAtMs ?? grant.revokedAtMs);
      const revokedReason =
        revokedAtMs == null
          ? null
          : revokedAtMs === existing.revokedAtMs
            ? (existing.revokedReason ?? grant.revokedReason)
            : (grant.revokedReason ?? existing.revokedReason);
      grants.set(key, { ...existing, ...grant, revokedAtMs, revokedReason });
    }
  }

  return { grants, unusable };
}

/**
 * The two product decisions D-048 leaves explicit, resolved from the P-016
 * `entitlement` events that already carry them.
 *
 * A ledger `Entitlement` names a catalog product and a buyer; delivery needs an
 * immutable release ref and an install subject. Rather than guess a convention
 * (`productId === releaseRef` is the tempting one, and it silently ships the
 * wrong bytes when a listing has more than one release), this builds the
 * mapping from the signed P2P entitlement facts that state both sides — the
 * seller SAID which release this order entitles, so nothing has to be inferred.
 */
export function bridgeFromCommerceEntitlements(accepted: readonly CommerceEvent[]): {
  readonly releaseRefForProduct: (productId: string, entitlement: Entitlement) => string | null;
  readonly subjectForBuyer: (buyerId: string, entitlement: Entitlement) => string | null;
} {
  const releaseByProduct = new Map<string, string>();
  const subjectByBuyer = new Map<string, string>();

  for (const event of accepted) {
    if (event.kind !== 'entitlement') continue;
    const productId = readString(event.payload, 'productId');
    const releaseRef = readString(event.payload, 'releaseRef');
    const buyerId = readString(event.payload, 'buyerId');
    const subject = readString(event.payload, 'subject');
    // Last writer wins within a deterministically-ordered accepted list, so a
    // re-issued entitlement naming a NEWER release moves the mapping forward.
    if (productId && releaseRef) releaseByProduct.set(productId, releaseRef);
    if (buyerId && subject) subjectByBuyer.set(buyerId, subject);
  }

  return {
    releaseRefForProduct: (productId) => releaseByProduct.get(productId) ?? null,
    subjectForBuyer: (buyerId) => subjectByBuyer.get(buyerId) ?? null,
  };
}
