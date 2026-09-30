/**
 * Reproducible baseline/challenger batteries (Blender redesign P-009).
 *
 * `experiment/run-core` executes one set of cases.  This module is the
 * authoring and audit seam around it: the battery pins every identity that can
 * change a result, keeps development / sealed acceptance / fresh monitoring
 * cases disjoint, and carries cost receipts without turning an absent receipt
 * into a zero.  The pure plan can be validated before any experiment spend.
 */

import type { RunExperimentArm, RunExperimentInput, RunExperimentSyntheticCase } from './run-core';

export const BATTERY_COHORTS = ['development', 'sealed-acceptance', 'fresh-monitoring'] as const;
export type BatteryCohort = (typeof BATTERY_COHORTS)[number];

export interface BatteryExposure {
  population: string;
  percentage: number;
}

export interface BatteryRandomization {
  /** Fixed seed is mandatory so a rerun can reconstruct arm/case assignment. */
  seed: string;
  strategy: 'fixed-seed';
}

export interface BatteryPins {
  taskHash: string;
  modelHash: string;
  promptHash: string;
  rubricHash: string;
  codeHash: string;
  evaluatorHash: string;
  baselineArmId: string;
  exposure: BatteryExposure;
  randomization: BatteryRandomization;
  repeats: number;
  /** Optional spend cap passed to experiment:run. */
  budgetUsd?: number;
}

export interface BatteryCase {
  caseId: string;
  context: string;
  intent: string;
  projectContext?: string;
  /** Sealed acceptance cases must carry an explicit seal marker. */
  sealed?: boolean;
  /** Fresh monitoring cases must carry an explicit freshness marker. */
  fresh?: boolean;
}

export interface BatteryArm {
  id: string;
  label?: string;
  knobs: Record<string, unknown>;
}

export interface BatteryCostReceipt {
  receiptId: string;
  cohort: BatteryCohort;
  armId: string;
  caseId: string;
  repeat: number;
  requestedUsd: number;
  reservedUsd: number;
  usedUsd: number;
  unsettledUsd: number;
}

export interface ReproducibleBattery {
  batteryId: string;
  pins: BatteryPins;
  arms: readonly BatteryArm[];
  cohorts: Readonly<Record<BatteryCohort, readonly BatteryCase[]>>;
  /** Receipts are appended after execution; absence means unmeasured, not free. */
  costReceipts?: readonly BatteryCostReceipt[];
}

export interface BatteryValidation {
  ok: boolean;
  errors: string[];
}

export interface BatteryCell {
  cohort: BatteryCohort;
  armId: string;
  caseId: string;
  repeat: number;
}

export interface BatteryPlan {
  ok: boolean;
  errors: string[];
  batteryId: string;
  identity: BatteryPins;
  cohortCaseCounts: Record<BatteryCohort, number>;
  totalCells: number;
  cells: BatteryCell[];
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const finiteNonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Validate all reproducibility and cohort-isolation invariants without IO. */
export function validateReproducibleBattery(battery: ReproducibleBattery): BatteryValidation {
  const errors: string[] = [];
  if (!nonEmpty(battery.batteryId)) errors.push('batteryId must be non-empty');
  const pins = battery.pins;
  for (const [value, field] of [
    [pins?.taskHash, 'pins.taskHash'],
    [pins?.modelHash, 'pins.modelHash'],
    [pins?.promptHash, 'pins.promptHash'],
    [pins?.rubricHash, 'pins.rubricHash'],
    [pins?.codeHash, 'pins.codeHash'],
    [pins?.evaluatorHash, 'pins.evaluatorHash'],
    [pins?.baselineArmId, 'pins.baselineArmId'],
    [pins?.randomization?.seed, 'pins.randomization.seed'],
  ] as const) {
    if (!nonEmpty(value)) errors.push(`${field} must be non-empty`);
  }
  if (pins?.randomization?.strategy !== 'fixed-seed') errors.push('pins.randomization.strategy must be fixed-seed');
  if (!Number.isInteger(pins?.repeats) || (pins?.repeats ?? 0) < 1) errors.push('pins.repeats must be a positive integer');
  if (!nonEmpty(pins?.exposure?.population)) errors.push('pins.exposure.population must be non-empty');
  if (!Number.isFinite(pins?.exposure?.percentage) || (pins?.exposure?.percentage ?? 0) <= 0 || (pins?.exposure?.percentage ?? 0) > 100) {
    errors.push('pins.exposure.percentage must be in (0, 100]');
  }
  if (pins?.budgetUsd !== undefined && !finiteNonNegative(pins.budgetUsd)) errors.push('pins.budgetUsd must be finite and non-negative');

  const arms = battery.arms ?? [];
  const armIds = arms.map((arm) => arm?.id);
  if (arms.length < 2) errors.push('at least one baseline and one challenger arm are required');
  if (new Set(armIds).size !== armIds.length) errors.push('arm ids must be unique');
  if (pins?.baselineArmId && !armIds.includes(pins.baselineArmId)) errors.push('pins.baselineArmId must name an arm');
  for (const [index, arm] of arms.entries()) {
    if (!nonEmpty(arm?.id)) errors.push(`arms[${index}].id must be non-empty`);
    if (!arm || typeof arm.knobs !== 'object' || arm.knobs == null || Array.isArray(arm.knobs)) errors.push(`arms[${index}].knobs must be an object`);
  }

  const seenCases = new Set<string>();
  const caseCohorts = new Map<string, BatteryCohort>();
  for (const cohort of BATTERY_COHORTS) {
    const cases = battery.cohorts?.[cohort] ?? [];
    if (cases.length === 0) errors.push(`${cohort} cohort must contain at least one case`);
    for (const [index, testCase] of cases.entries()) {
      if (!nonEmpty(testCase?.caseId)) errors.push(`${cohort}[${index}].caseId must be non-empty`);
      if (!nonEmpty(testCase?.context)) errors.push(`${cohort}[${index}].context must be non-empty`);
      if (!nonEmpty(testCase?.intent)) errors.push(`${cohort}[${index}].intent must be non-empty`);
      if (testCase?.caseId && seenCases.has(testCase.caseId)) errors.push(`caseId is reused across cohorts: ${testCase.caseId}`);
      if (testCase?.caseId) {
        seenCases.add(testCase.caseId);
        caseCohorts.set(testCase.caseId, cohort);
      }
      if (cohort === 'sealed-acceptance' && testCase?.sealed !== true) errors.push(`sealed-acceptance case ${testCase?.caseId ?? index} must be sealed`);
      if (cohort !== 'sealed-acceptance' && testCase?.sealed === true) errors.push(`only sealed-acceptance cases may set sealed=true (${testCase?.caseId ?? index})`);
      if (cohort === 'fresh-monitoring' && testCase?.fresh !== true) errors.push(`fresh-monitoring case ${testCase?.caseId ?? index} must be marked fresh`);
      if (cohort !== 'fresh-monitoring' && testCase?.fresh === true) errors.push(`only fresh-monitoring cases may set fresh=true (${testCase?.caseId ?? index})`);
    }
  }

  const receipts = battery.costReceipts ?? [];
  const receiptIds = new Set<string>();
  const receiptCells = new Set<string>();
  for (const [index, receipt] of receipts.entries()) {
    if (!nonEmpty(receipt?.receiptId)) errors.push(`costReceipts[${index}].receiptId must be non-empty`);
    if (receipt?.receiptId && receiptIds.has(receipt.receiptId)) errors.push(`cost receipt ids must be unique: ${receipt.receiptId}`);
    if (receipt?.receiptId) receiptIds.add(receipt.receiptId);
    if (!BATTERY_COHORTS.includes(receipt?.cohort)) errors.push(`costReceipts[${index}].cohort is invalid`);
    if (!armIds.includes(receipt?.armId)) errors.push(`costReceipts[${index}].armId must name an arm`);
    if (!seenCases.has(receipt?.caseId)) errors.push(`costReceipts[${index}].caseId must name a battery case`);
    if (receipt?.caseId && caseCohorts.get(receipt.caseId) !== receipt.cohort) errors.push(`costReceipts[${index}].cohort must match its case cohort`);
    const cellKey = `${receipt?.cohort ?? ''}|${receipt?.armId ?? ''}|${receipt?.caseId ?? ''}|${receipt?.repeat ?? ''}`;
    if (receipt?.cohort && receipt?.armId && receipt?.caseId && receiptCells.has(cellKey)) errors.push(`cost receipt cell is duplicated: ${cellKey}`);
    if (receipt?.cohort && receipt?.armId && receipt?.caseId) receiptCells.add(cellKey);
    if (!Number.isInteger(receipt?.repeat) || (receipt?.repeat ?? -1) < 0 || (receipt?.repeat ?? Number.MAX_SAFE_INTEGER) >= (pins?.repeats ?? 0)) {
      errors.push(`costReceipts[${index}].repeat must be within the configured repeats`);
    }
    for (const [value, field] of [
      [receipt?.requestedUsd, 'requestedUsd'],
      [receipt?.reservedUsd, 'reservedUsd'],
      [receipt?.usedUsd, 'usedUsd'],
      [receipt?.unsettledUsd, 'unsettledUsd'],
    ] as const) {
      if (!finiteNonNegative(value)) errors.push(`costReceipts[${index}].${field} must be finite and non-negative`);
    }
    if (finiteNonNegative(receipt?.reservedUsd) && finiteNonNegative(receipt?.requestedUsd) && receipt.reservedUsd > receipt.requestedUsd) {
      errors.push(`costReceipts[${index}] reservedUsd cannot exceed requestedUsd`);
    }
    if (finiteNonNegative(receipt?.usedUsd) && finiteNonNegative(receipt?.unsettledUsd) && finiteNonNegative(receipt?.reservedUsd) && receipt.usedUsd + receipt.unsettledUsd > receipt.reservedUsd) {
      errors.push(`costReceipts[${index}] usedUsd + unsettledUsd cannot exceed reservedUsd`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Expand a validated battery into deterministic arm × cohort-case × repeat cells. */
export function planReproducibleBattery(battery: ReproducibleBattery): BatteryPlan {
  const validation = validateReproducibleBattery(battery);
  const cohortCaseCounts = Object.fromEntries(BATTERY_COHORTS.map((cohort) => [cohort, battery.cohorts?.[cohort]?.length ?? 0])) as Record<BatteryCohort, number>;
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, batteryId: battery.batteryId, identity: battery.pins, cohortCaseCounts, totalCells: 0, cells: [] };
  }
  const cells: BatteryCell[] = [];
  for (const cohort of BATTERY_COHORTS) {
    for (const testCase of battery.cohorts[cohort]) {
      for (const arm of battery.arms) {
        for (let repeat = 0; repeat < battery.pins.repeats; repeat += 1) {
          cells.push({ cohort, armId: arm.id, caseId: testCase.caseId, repeat });
        }
      }
    }
  }
  return { ok: true, errors: [], batteryId: battery.batteryId, identity: battery.pins, cohortCaseCounts, totalCells: cells.length, cells };
}

/** Map one cohort to the existing experiment:run request without spending. */
export function toRunExperimentInput(battery: ReproducibleBattery, cohort: BatteryCohort): RunExperimentInput | null {
  if (!validateReproducibleBattery(battery).ok) return null;
  const cases: RunExperimentSyntheticCase[] = battery.cohorts[cohort].map((testCase) => ({
    caseId: testCase.caseId,
    context: testCase.context,
    intent: testCase.intent,
    ...(testCase.projectContext !== undefined ? { projectContext: testCase.projectContext } : {}),
  }));
  const arms: RunExperimentArm[] = battery.arms.map((arm) => ({ id: arm.id, ...(arm.label !== undefined ? { label: arm.label } : {}), knobs: arm.knobs }));
  return {
    testId: 'replay',
    batteryId: `${battery.batteryId}:${cohort}`,
    arms,
    cases,
    repeats: battery.pins.repeats,
    ...(battery.pins.budgetUsd !== undefined ? { budgetUsd: battery.pins.budgetUsd } : {}),
    dryRun: true,
  };
}

/** Compatibility aliases for callers that call the battery a baseline/challenger plan. */
export const validateBaselineChallengerBattery = validateReproducibleBattery;
export const planBaselineChallengerBattery = planReproducibleBattery;
export const validateBattery = validateReproducibleBattery;
export const planBattery = planReproducibleBattery;
