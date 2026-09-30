/**
 * Pure receipt guards for the directed-pair pilot collection boundary.
 *
 * D-037/D-038 deliberately keep this module separate from `pilot-cohort.ts` until
 * the integration lane.  It accepts only server-issued binding/dispatch receipts,
 * canonical terminal timestamps, the exact scorecard id returned by the writer,
 * and scorecard ledger rows.  Events and caller-authored timestamps are not
 * evidence here.
 */
import type { PilotArm } from './pilot-arm-assignment.js';
import type {
  PilotParticipantBindingReceipt,
  PilotParticipantDispatchReceipt,
  PilotParticipantRole,
} from './pilot-participant-receipts.js';
import { settledGradingAuditIsCurrent, type ScorecardRow } from './scorecards.js';

/** Frozen before reveal: one item, one independent grader, one opaque packet. */
export interface PilotGradeBinding {
  itemId: string;
  graderOwnerId: string;
  packetFingerprint: string;
}

export interface PilotGradeReceipt {
  itemId: string;
  cardId: string;
  graderOwnerId: string;
  packetFingerprint: string;
  closedAtMs: number;
  createdAtMs: number;
  evidenceSource: 'scorecard-ledger';
}

export interface PilotReceiptCostWindow {
  key: string;
  itemId: string;
  ownerId: string;
  sessionId: string;
  role: PilotParticipantRole;
  bindingReceiptId: string;
  dispatchReceiptId: string;
  startMs: number;
  endMs: number;
  evidenceSource: 'binding-dispatch-receipts';
}

export type PilotCollectionGuardGapCode =
  | 'missing-grade-binding'
  | 'duplicate-grade-binding'
  | 'unbound-grade-binding'
  | 'ineligible-grader'
  | 'invalid-packet-fingerprint'
  | 'missing-exact-card'
  | 'unbound-scorecard'
  | 'duplicate-scorecard'
  | 'pre-terminal-scorecard'
  | 'incomplete-scorecard'
  | 'provisional-scorecard'
  | 'scorecard-audit-not-passed'
  | 'invalid-terminal-time'
  | 'invalid-arm-participant-count'
  | 'invalid-binding-receipt'
  | 'duplicate-binding-receipt'
  | 'missing-dispatch-receipt'
  | 'duplicate-dispatch-receipt'
  | 'dispatch-receipt-mismatch'
  | 'pre-binding-dispatch'
  | 'post-terminal-dispatch';

export interface PilotCollectionGuardGap {
  itemId: string;
  code: PilotCollectionGuardGapCode;
  detail: string;
}

export interface PilotGradeBindingValidation {
  ok: boolean;
  accepted: PilotGradeBinding[];
  gaps: PilotCollectionGuardGap[];
}

const OPAQUE_FINGERPRINT_RE = /^[a-f0-9]{64}$/i;

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function canonicalIsoInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/**
 * Validate the cohort-wide PREBINDING, before any score is visible.  A grader may
 * grade more than one item, but every item has exactly one binding and no grader may
 * be a participant, the cohort operator, or the frozen runbook author.
 */
export function validatePilotGradeBindings(input: {
  itemIds: readonly string[];
  bindings: readonly PilotGradeBinding[];
  participantOwnerIds: readonly string[];
  operatorOwnerId: string;
  runbookAuthorOwnerId: string;
}): PilotGradeBindingValidation {
  const itemIds = [...new Set(input.itemIds)];
  const expected = new Set(itemIds);
  const excluded = new Set([...input.participantOwnerIds, input.operatorOwnerId, input.runbookAuthorOwnerId]);
  const gaps: PilotCollectionGuardGap[] = [];
  const accepted: PilotGradeBinding[] = [];

  for (const itemId of itemIds) {
    const matches = input.bindings.filter((binding) => binding.itemId === itemId);
    if (matches.length === 0) {
      gaps.push({ itemId, code: 'missing-grade-binding', detail: 'no frozen grader binding exists' });
      continue;
    }
    if (matches.length !== 1) {
      gaps.push({
        itemId,
        code: 'duplicate-grade-binding',
        detail: `expected exactly one frozen grader binding; found ${matches.length}`,
      });
      continue;
    }
    const binding = matches[0]!;
    if (!nonEmpty(binding.graderOwnerId) || excluded.has(binding.graderOwnerId)) {
      gaps.push({
        itemId,
        code: 'ineligible-grader',
        detail: `grader ${binding.graderOwnerId || '<empty>'} is not independent of the frozen cohort`,
      });
      continue;
    }
    if (!OPAQUE_FINGERPRINT_RE.test(binding.packetFingerprint)) {
      gaps.push({
        itemId,
        code: 'invalid-packet-fingerprint',
        detail: 'pre-reveal packet fingerprint must be an opaque 64-hex digest',
      });
      continue;
    }
    accepted.push(binding);
  }

  for (const binding of input.bindings) {
    if (!expected.has(binding.itemId)) {
      gaps.push({
        itemId: binding.itemId,
        code: 'unbound-grade-binding',
        detail: 'grader binding names an item outside the frozen cohort',
      });
    }
  }

  return { ok: gaps.length === 0 && accepted.length === itemIds.length, accepted, gaps };
}

function scorecardQualityGap(card: ScorecardRow): PilotCollectionGuardGapCode | null {
  if (!card.rubricResolved || card.missingKeys.length > 0 || card.extraKeys.length > 0 || card.score10 === null) {
    return 'incomplete-scorecard';
  }
  if (card.provisional) return 'provisional-scorecard';
  if (card.gradingAudit?.state !== 'passed' || !settledGradingAuditIsCurrent(card)) {
    return 'scorecard-audit-not-passed';
  }
  return null;
}

function cardBelongsToBinding(card: ScorecardRow, binding: PilotGradeBinding, rubricRef: string): boolean {
  return (
    card.subject?.kind === 'work-item' &&
    card.subject.ref === binding.itemId &&
    card.rubricRef === rubricRef &&
    card.createdBy === binding.graderOwnerId
  );
}

/**
 * Resolve exactly the scorecard id returned by the writer.  We never select the
 * first plausible card: a second independently-valid post-terminal card is a typed
 * duplicate and fails closed.
 */
export function validatePilotGradeReceipt(input: {
  binding: PilotGradeBinding;
  returnedCardId: string;
  rubricRef: string;
  closedAtMs: number;
  cards: readonly ScorecardRow[];
}): { ok: boolean; receipt: PilotGradeReceipt | null; gaps: PilotCollectionGuardGap[] } {
  const { binding } = input;
  const gaps: PilotCollectionGuardGap[] = [];
  if (!finitePositive(input.closedAtMs)) {
    return {
      ok: false,
      receipt: null,
      gaps: [
        { itemId: binding.itemId, code: 'invalid-terminal-time', detail: 'closedAtMs must be finite and positive' },
      ],
    };
  }

  const exact = input.cards.filter((card) => card.issueId === input.returnedCardId);
  if (exact.length === 0) {
    return {
      ok: false,
      receipt: null,
      gaps: [
        {
          itemId: binding.itemId,
          code: 'missing-exact-card',
          detail: `card ${input.returnedCardId} is absent from the scorecard ledger`,
        },
      ],
    };
  }
  if (exact.length !== 1) {
    return {
      ok: false,
      receipt: null,
      gaps: [
        {
          itemId: binding.itemId,
          code: 'duplicate-scorecard',
          detail: `card id ${input.returnedCardId} appears ${exact.length} times`,
        },
      ],
    };
  }

  const card = exact[0]!;
  if (!cardBelongsToBinding(card, binding, input.rubricRef)) {
    gaps.push({
      itemId: binding.itemId,
      code: 'unbound-scorecard',
      detail: `card ${card.issueId} does not bind the frozen item, rubric, and grader`,
    });
  }
  const createdAtMs = Date.parse(card.createdAt);
  if (!Number.isFinite(createdAtMs) || createdAtMs < input.closedAtMs) {
    gaps.push({
      itemId: binding.itemId,
      code: 'pre-terminal-scorecard',
      detail: `card ${card.issueId} was not created at or after canonical close`,
    });
  }
  const qualityGap = scorecardQualityGap(card);
  if (qualityGap) {
    gaps.push({ itemId: binding.itemId, code: qualityGap, detail: `card ${card.issueId} failed ${qualityGap}` });
  }

  const validPostTerminal = input.cards.filter((candidate) => {
    if (!cardBelongsToBinding(candidate, binding, input.rubricRef)) return false;
    const at = Date.parse(candidate.createdAt);
    return Number.isFinite(at) && at >= input.closedAtMs && scorecardQualityGap(candidate) === null;
  });
  if (validPostTerminal.length > 1) {
    gaps.push({
      itemId: binding.itemId,
      code: 'duplicate-scorecard',
      detail: `expected exactly one complete post-terminal card from the prebound grader; found ${validPostTerminal.length}`,
    });
  } else if (validPostTerminal.length === 1 && validPostTerminal[0]!.issueId !== input.returnedCardId) {
    gaps.push({
      itemId: binding.itemId,
      code: 'unbound-scorecard',
      detail: `the sole valid card is ${validPostTerminal[0]!.issueId}, not returned id ${input.returnedCardId}`,
    });
  }

  if (gaps.length > 0) return { ok: false, receipt: null, gaps };
  return {
    ok: true,
    gaps: [],
    receipt: {
      itemId: binding.itemId,
      cardId: card.issueId,
      graderOwnerId: binding.graderOwnerId,
      packetFingerprint: binding.packetFingerprint,
      closedAtMs: input.closedAtMs,
      createdAtMs,
      evidenceSource: 'scorecard-ledger',
    },
  };
}

function expectedRoles(arm: PilotArm): readonly PilotParticipantRole[] {
  return arm === 'C' ? ['director', 'implementer'] : ['solo'];
}

function bindingValid(binding: PilotParticipantBindingReceipt): boolean {
  return (
    nonEmpty(binding.receiptId) &&
    nonEmpty(binding.itemId) &&
    nonEmpty(binding.ownerId) &&
    nonEmpty(binding.sessionId) &&
    canonicalIsoInstant(binding.claimVersion) &&
    finitePositive(binding.bindingIssuedAtMs)
  );
}

/**
 * Build immutable participant cost windows from canonical receipts.  The caller
 * supplies no start time: start is always `bindingIssuedAtMs`, dispatch must link
 * exactly and occur no earlier, and the end is the canonical work-item close.
 */
export function derivePilotReceiptCostWindows(input: {
  itemId: string;
  arm: PilotArm;
  closedAtMs: number;
  bindings: readonly PilotParticipantBindingReceipt[];
  dispatches: readonly PilotParticipantDispatchReceipt[];
}): { ok: boolean; windows: PilotReceiptCostWindow[]; gaps: PilotCollectionGuardGap[] } {
  const gaps: PilotCollectionGuardGap[] = [];
  if (!finitePositive(input.closedAtMs)) {
    gaps.push({
      itemId: input.itemId,
      code: 'invalid-terminal-time',
      detail: 'closedAtMs must be finite and positive',
    });
  }

  const roles = expectedRoles(input.arm);
  const actualRoles = input.bindings.map((binding) => binding.role).sort();
  const wantedRoles = [...roles].sort();
  if (
    input.bindings.length !== roles.length ||
    actualRoles.length !== wantedRoles.length ||
    actualRoles.some((role, index) => role !== wantedRoles[index])
  ) {
    gaps.push({
      itemId: input.itemId,
      code: 'invalid-arm-participant-count',
      detail: `arm ${input.arm} requires roles ${wantedRoles.join('+')}; received ${actualRoles.join('+') || 'none'}`,
    });
  }

  const bindingIds = new Set<string>();
  const dispatchIds = new Set<string>();
  const windows: PilotReceiptCostWindow[] = [];

  for (const binding of input.bindings) {
    if (!bindingValid(binding) || binding.itemId !== input.itemId) {
      gaps.push({
        itemId: input.itemId,
        code: 'invalid-binding-receipt',
        detail: `binding ${binding.receiptId || '<empty>'} is malformed or names another item`,
      });
      continue;
    }
    if (bindingIds.has(binding.receiptId)) {
      gaps.push({
        itemId: input.itemId,
        code: 'duplicate-binding-receipt',
        detail: `binding receipt ${binding.receiptId} is duplicated`,
      });
      continue;
    }
    bindingIds.add(binding.receiptId);

    const matches = input.dispatches.filter((dispatch) => dispatch.bindingReceiptId === binding.receiptId);
    if (matches.length === 0) {
      gaps.push({
        itemId: input.itemId,
        code: 'missing-dispatch-receipt',
        detail: `binding ${binding.receiptId} has no linked dispatch receipt`,
      });
      continue;
    }
    if (matches.length !== 1) {
      gaps.push({
        itemId: input.itemId,
        code: 'duplicate-dispatch-receipt',
        detail: `binding ${binding.receiptId} has ${matches.length} linked dispatch receipts`,
      });
      continue;
    }
    const dispatch = matches[0]!;
    if (dispatchIds.has(dispatch.receiptId)) {
      gaps.push({
        itemId: input.itemId,
        code: 'duplicate-dispatch-receipt',
        detail: `dispatch receipt ${dispatch.receiptId} is reused`,
      });
      continue;
    }
    dispatchIds.add(dispatch.receiptId);
    if (
      !nonEmpty(dispatch.receiptId) ||
      dispatch.itemId !== binding.itemId ||
      dispatch.ownerId !== binding.ownerId ||
      dispatch.sessionId !== binding.sessionId ||
      dispatch.role !== binding.role ||
      !finitePositive(dispatch.dispatchedAtMs)
    ) {
      gaps.push({
        itemId: input.itemId,
        code: 'dispatch-receipt-mismatch',
        detail: `dispatch ${dispatch.receiptId || '<empty>'} does not exactly match binding ${binding.receiptId}`,
      });
      continue;
    }
    if (dispatch.dispatchedAtMs < binding.bindingIssuedAtMs) {
      gaps.push({
        itemId: input.itemId,
        code: 'pre-binding-dispatch',
        detail: `dispatch ${dispatch.receiptId} predates binding ${binding.receiptId}`,
      });
      continue;
    }
    if (binding.bindingIssuedAtMs >= input.closedAtMs || dispatch.dispatchedAtMs > input.closedAtMs) {
      gaps.push({
        itemId: input.itemId,
        code: 'post-terminal-dispatch',
        detail: `binding/dispatch ${binding.receiptId}/${dispatch.receiptId} does not precede canonical close`,
      });
      continue;
    }

    windows.push({
      key: `${binding.itemId}:${binding.receiptId}:${binding.sessionId}`,
      itemId: binding.itemId,
      ownerId: binding.ownerId,
      sessionId: binding.sessionId,
      role: binding.role,
      bindingReceiptId: binding.receiptId,
      dispatchReceiptId: dispatch.receiptId,
      startMs: binding.bindingIssuedAtMs,
      endMs: input.closedAtMs,
      evidenceSource: 'binding-dispatch-receipts',
    });
  }

  const knownBindings = new Set(input.bindings.map((binding) => binding.receiptId));
  for (const dispatch of input.dispatches) {
    if (!knownBindings.has(dispatch.bindingReceiptId)) {
      gaps.push({
        itemId: input.itemId,
        code: 'dispatch-receipt-mismatch',
        detail: `dispatch ${dispatch.receiptId || '<empty>'} links unknown binding ${dispatch.bindingReceiptId}`,
      });
    }
  }

  return {
    ok: gaps.length === 0 && windows.length === roles.length,
    windows: gaps.length === 0 ? windows : [],
    gaps,
  };
}
