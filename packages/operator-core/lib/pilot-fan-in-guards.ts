/**
 * Pure event-cap-aware fan-in plans and registration receipt guards for D-037/D-038.
 *
 * Event delivery is a wake hint.  The resulting verdict still comes from the
 * canonical work-item and scorecard ledgers, so this module never treats a fire as
 * completion or grading evidence.
 */
import { createHash } from 'node:crypto';
import { scorecardEmittedKey } from './scorecard-emitted-events.js';
import { MAX_TREE_LEAVES, type ComposedLeafSpec, type ComposedSpec } from './events/await/compose-spec.js';

export const PILOT_FAN_IN_COHORT_SIZE = 21;

export type PilotFanInKind = 'completion' | 'grading';

export interface PilotFanInRootPlan {
  kind: PilotFanInKind;
  batchIndex: number;
  itemIds: string[];
  spec: ComposedSpec;
  rootFingerprint: string;
}

export interface PilotFanInPlan {
  itemIds: string[];
  completionExactLeaves: Array<{ itemId: string; event: string }>;
  completionRoots: PilotFanInRootPlan[];
  gradingRoots: PilotFanInRootPlan[];
  evidencePolicy: {
    completion: 'work-item-terminal-ledger';
    grading: 'scorecard-ledger-card-id';
    scorecardEvent: 'wake-hint-only';
  };
}

export interface PilotExactCompletionAwaitReceipt {
  itemId: string;
  event: string;
  awaitId: number;
  registeredAtMs: number;
}

export interface PilotComposedAwaitReceipt {
  kind: PilotFanInKind;
  batchIndex: number;
  rootFingerprint: string;
  rootId: number;
  anchorAwaitId: number;
  leafCount: number;
  registeredAtMs: number;
}

export type PilotFanInReceiptGapCode =
  | 'invalid-cohort'
  | 'missing-registration-receipt'
  | 'duplicate-registration-receipt'
  | 'unbound-registration-receipt'
  | 'registration-receipt-mismatch';

export interface PilotFanInReceiptGap {
  kind: PilotFanInKind;
  batchIndex: number | null;
  itemId?: string;
  code: PilotFanInReceiptGapCode;
  detail: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fingerprintRoot(
  kind: PilotFanInKind,
  batchIndex: number,
  itemIds: readonly string[],
  spec: ComposedSpec,
): string {
  return createHash('sha256').update(canonicalJson({ kind, batchIndex, itemIds, spec })).digest('hex');
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}

function rootPlan(
  kind: PilotFanInKind,
  batchIndex: number,
  itemIds: string[],
  leaves: ComposedLeafSpec[],
): PilotFanInRootPlan {
  const spec: ComposedSpec = { all: leaves };
  return {
    kind,
    batchIndex,
    itemIds,
    spec,
    rootFingerprint: fingerprintRoot(kind, batchIndex, itemIds, spec),
  };
}

/**
 * Build the exact 21-key completion set plus the composed 20+1 alternative, and
 * the mandatory subject-filtered 20+1 grading roots on the shared rubric event.
 */
export function buildPilotFanInPlan(input: { itemIds: readonly string[]; rubricRef: string }): PilotFanInPlan {
  const itemIds = [...input.itemIds];
  const unique = new Set(itemIds);
  if (
    itemIds.length !== PILOT_FAN_IN_COHORT_SIZE ||
    unique.size !== PILOT_FAN_IN_COHORT_SIZE ||
    itemIds.some((id) => id.trim().length === 0) ||
    input.rubricRef.trim().length === 0
  ) {
    throw new Error(
      `pilot fan-in requires exactly ${PILOT_FAN_IN_COHORT_SIZE} unique non-empty item ids and a rubricRef`,
    );
  }

  const batches = chunks(itemIds, MAX_TREE_LEAVES);
  const completionExactLeaves = itemIds.map((itemId) => ({ itemId, event: `work-item:done:${itemId}` }));
  const completionRoots = batches.map((batch, batchIndex) =>
    rootPlan(
      'completion',
      batchIndex,
      batch,
      batch.map((itemId) => ({ event: `work-item:done:${itemId}` })),
    ),
  );
  const gradeEvent = scorecardEmittedKey(input.rubricRef);
  const gradingRoots = batches.map((batch, batchIndex) =>
    rootPlan(
      'grading',
      batchIndex,
      batch,
      batch.map((itemId) => ({ event: gradeEvent, when: { subjectRef: itemId } })),
    ),
  );

  return {
    itemIds,
    completionExactLeaves,
    completionRoots,
    gradingRoots,
    evidencePolicy: {
      completion: 'work-item-terminal-ledger',
      grading: 'scorecard-ledger-card-id',
      scorecardEvent: 'wake-hint-only',
    },
  };
}

/** Validate the permitted exact-key completion registration route. */
export function validatePilotExactCompletionReceipts(
  plan: PilotFanInPlan,
  receipts: readonly PilotExactCompletionAwaitReceipt[],
): { ok: boolean; gaps: PilotFanInReceiptGap[] } {
  const gaps: PilotFanInReceiptGap[] = [];
  const expectedByItem = new Map(plan.completionExactLeaves.map((leaf) => [leaf.itemId, leaf.event]));

  for (const [itemId, event] of expectedByItem) {
    const matches = receipts.filter((receipt) => receipt.itemId === itemId);
    if (matches.length === 0) {
      gaps.push({
        kind: 'completion',
        batchIndex: null,
        itemId,
        code: 'missing-registration-receipt',
        detail: `no exact await receipt for ${event}`,
      });
      continue;
    }
    if (matches.length !== 1) {
      gaps.push({
        kind: 'completion',
        batchIndex: null,
        itemId,
        code: 'duplicate-registration-receipt',
        detail: `found ${matches.length} exact await receipts`,
      });
      continue;
    }
    const receipt = matches[0]!;
    if (
      receipt.event !== event ||
      !Number.isInteger(receipt.awaitId) ||
      receipt.awaitId <= 0 ||
      !Number.isFinite(receipt.registeredAtMs) ||
      receipt.registeredAtMs <= 0
    ) {
      gaps.push({
        kind: 'completion',
        batchIndex: null,
        itemId,
        code: 'registration-receipt-mismatch',
        detail: `exact await receipt does not bind ${event}`,
      });
    }
  }
  for (const receipt of receipts) {
    if (!expectedByItem.has(receipt.itemId)) {
      gaps.push({
        kind: 'completion',
        batchIndex: null,
        itemId: receipt.itemId,
        code: 'unbound-registration-receipt',
        detail: 'receipt names an item outside the frozen cohort',
      });
    }
  }
  return { ok: gaps.length === 0 && receipts.length === plan.completionExactLeaves.length, gaps };
}

/** Validate server-returned registration receipts for either 20+1 root set. */
export function validatePilotComposedFanInReceipts(
  roots: readonly PilotFanInRootPlan[],
  receipts: readonly PilotComposedAwaitReceipt[],
): { ok: boolean; gaps: PilotFanInReceiptGap[] } {
  const gaps: PilotFanInReceiptGap[] = [];
  const expected = new Map(roots.map((root) => [`${root.kind}:${root.batchIndex}`, root]));

  for (const root of roots) {
    const matches = receipts.filter((receipt) => receipt.kind === root.kind && receipt.batchIndex === root.batchIndex);
    if (matches.length === 0) {
      gaps.push({
        kind: root.kind,
        batchIndex: root.batchIndex,
        code: 'missing-registration-receipt',
        detail: `no receipt for ${root.kind} root ${root.batchIndex}`,
      });
      continue;
    }
    if (matches.length !== 1) {
      gaps.push({
        kind: root.kind,
        batchIndex: root.batchIndex,
        code: 'duplicate-registration-receipt',
        detail: `found ${matches.length} receipts for one root`,
      });
      continue;
    }
    const receipt = matches[0]!;
    if (
      receipt.rootFingerprint !== root.rootFingerprint ||
      receipt.leafCount !== root.itemIds.length ||
      !Number.isInteger(receipt.rootId) ||
      receipt.rootId <= 0 ||
      !Number.isInteger(receipt.anchorAwaitId) ||
      receipt.anchorAwaitId <= 0 ||
      !Number.isFinite(receipt.registeredAtMs) ||
      receipt.registeredAtMs <= 0
    ) {
      gaps.push({
        kind: root.kind,
        batchIndex: root.batchIndex,
        code: 'registration-receipt-mismatch',
        detail: 'root receipt does not bind the planned spec and returned registration ids',
      });
    }
  }

  for (const receipt of receipts) {
    if (!expected.has(`${receipt.kind}:${receipt.batchIndex}`)) {
      gaps.push({
        kind: receipt.kind,
        batchIndex: receipt.batchIndex,
        code: 'unbound-registration-receipt',
        detail: 'receipt names a root outside the frozen fan-in plan',
      });
    }
  }
  return { ok: gaps.length === 0 && receipts.length === roots.length, gaps };
}
