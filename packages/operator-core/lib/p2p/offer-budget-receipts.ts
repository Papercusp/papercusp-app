/**
 * p2p/offer-budget-receipts.ts — the ONE IO edge of P-107: turn a pure
 * WindDownDecision into a LOUD receipt (p2p-work-distribution-2026-07-02 P-107,
 * "exhaustion = graceful wind-down + LOUD RECEIPT").
 *
 * The budget arithmetic + the wind-down DECISION are pure (./offer-budget). This
 * module is the thin bridge that emits the decision as a P-004 receipt so the
 * requesting fleet learns — durably, cross-machine — exactly why its offer wound
 * down (which axis, budget vs cancel vs partition). It carries no logic of its
 * own beyond the field mapping, and takes the emitter by parameter so the
 * mapping is unit-testable with no PG.
 *
 * X8 taxonomy is honoured via decision.receiptKind: an explicit cancel is an
 * EXCUSED breach (does not dent host reliability); budget/expiry/partition are
 * plain refusals carrying the structured {code, detail} emitP2pReceipt requires.
 */
import { emitP2pReceipt, type EmitP2pReceiptArgs, type EmitP2pReceiptResult } from './receipts';
import type { OrgSql } from '../work-items';
import type { WindDownDecision, WorkOffer } from './offer-budget';

/** The emitter shape (P-004 emitP2pReceipt), injectable for tests. */
export type ReceiptEmitter = (args: EmitP2pReceiptArgs, sqlOverride?: OrgSql) => Promise<EmitP2pReceiptResult>;

export interface WindDownReceiptCtx {
  /** The host's resolved identity workspace (C3 — un-federating 'default' is refused downstream). */
  workspaceId: string | null | undefined;
  /** The hive HOME slug the receipt federates under. */
  potSlug: string;
  /** The enforcing host — numeric GitHub user-id (X9). */
  responderGithubUserId: number;
  responderDevicePubkey?: string | null;
  /** Audit actor label; defaults to 'p2p:offer-budget'. */
  actor?: string;
  /** Event-time override (tests); forwarded to emitP2pReceipt. */
  receiptTs?: number;
}

/**
 * Emit a wind-down receipt for `offer` per `decision`. Returns the emit result
 * verbatim (so the caller can log a failed emit — a receipt that never lands is
 * itself a silent drop, D-004). The emitter defaults to the real
 * PG-backed emitP2pReceipt; tests pass a fake.
 */
export async function emitOfferWindDownReceipt(
  offer: Pick<WorkOffer, 'offerId' | 'fleetSlug' | 'publisherRef'>,
  decision: WindDownDecision,
  ctx: WindDownReceiptCtx,
  emit: ReceiptEmitter = emitP2pReceipt,
  sqlOverride?: OrgSql,
): Promise<EmitP2pReceiptResult> {
  const args: EmitP2pReceiptArgs = {
    workspaceId: ctx.workspaceId,
    potSlug: ctx.potSlug,
    kind: decision.receiptKind,
    offerId: offer.offerId,
    action: 'wind-down',
    budgetAxis: decision.axis ?? null,
    detail: decision.detail,
    requester: { kind: 'fleet', ref: offer.fleetSlug },
    responderGithubUserId: ctx.responderGithubUserId,
    responderDevicePubkey: ctx.responderDevicePubkey ?? null,
    actor: ctx.actor ?? 'p2p:offer-budget',
    receiptTs: ctx.receiptTs,
    // emitP2pReceipt REQUIRES a structured refusal when kind==='refusal'; an
    // excused-breach carries none.
    refusal:
      decision.receiptKind === 'refusal'
        ? { code: decision.cause, detail: decision.detail }
        : null,
  };
  return emit(args, sqlOverride);
}
