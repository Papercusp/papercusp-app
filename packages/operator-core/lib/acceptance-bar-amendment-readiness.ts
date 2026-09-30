/**
 * P-039 (review-system-rework-reduction-2026-09-23, R-9): what an acceptance-BAR amendment
 * does to ship READINESS, computed for the `rubrics:amend { dryRun }` preview.
 *
 * WHY. The preview already said which proof an amendment carries or invalidates (P-002), but
 * not what it does to the gate. Measured 2026-09-23 (owner #302): a 14-criterion amendment on
 * consult-expert-routing-2026-09-22 would have flipped 13 manual (`instrumentKey:'none'`) BARs to
 * automated proof with no test layers, adding up to 13 blocking codes to a gate that read "0 of
 * 14 BARs blocking". Nothing said so before the outside countersignature was requested.
 *
 * WHAT. Both sides are judged by the SAME lifecycle evaluator at the `ship` door (the only door
 * where proof obligations are evaluated), over the current snapshot and the amendment candidate
 * whose automated-proof verdicts were re-predicted by `predictAmendedBarProofFloor`. Proof and
 * grading state are carried from the current snapshot on both sides, so the delta isolates what
 * the CONTRACT change does. Review invalidation (vetting, grading, author verdict, invalidated
 * proof refs) is reported by the preview fields beside this delta, not double-counted here.
 *
 * Its own module, not the evaluator: the evaluator is a measured proof source for bound clauses,
 * and editing it for a consumer re-stales that proof (reproduced 2026-09-23, D-015).
 */
import {
  barRequiresAutomatedProof,
  type AcceptanceBarContractSnapshot,
  type AcceptanceBarSnapshotCode,
} from './acceptance-bar-contract-snapshot';
import { evaluateAcceptanceBarLifecycle } from './acceptance-bar-lifecycle-evaluator';

/** How a BAR reads wherever per-BAR amendment state is rendered. */
export const MANUAL_CONTRACT_LABEL = 'manual contract: no automated proof owed';
export const AUTOMATED_CONTRACT_LABEL = 'automated proof owed';

export type BarContractKind = 'manual' | 'automated';

export interface AmendmentReadinessBarRow {
  barKey: string;
  /** null when the BAR does not exist on that side of the amendment. */
  contractBefore: BarContractKind | null;
  contractAfter: BarContractKind | null;
  /** Human label of the POST-amendment contract (or the prior one for a removed BAR). */
  label: string;
  codesAdded: AcceptanceBarSnapshotCode[];
  codesRemoved: AcceptanceBarSnapshotCode[];
}

export interface AcceptanceBarAmendmentReadinessDelta {
  phase: 'ship';
  before: { blockingBarCount: number; barCount: number; codes: AcceptanceBarSnapshotCode[] };
  after: { blockingBarCount: number; barCount: number; codes: AcceptanceBarSnapshotCode[] };
  codesAdded: AcceptanceBarSnapshotCode[];
  codesRemoved: AcceptanceBarSnapshotCode[];
  /** Only BARs whose contract kind or blocking codes change. */
  bars: AmendmentReadinessBarRow[];
  flippedToAutomated: string[];
  flippedToManual: string[];
  /**
   * True when the amendment's ONLY per-BAR effect is a higher proof floor: it flips at least one
   * manual BAR to automated proof, no BAR loses a blocking code, and every BAR that gains one is a
   * flipped BAR. Contract-level codes are ignored here because every amendment re-pins revisions.
   */
  raisesProofFloorOnly: boolean;
  summary: string;
}

function contractOf(bar: Parameters<typeof barRequiresAutomatedProof>[0]): BarContractKind {
  return barRequiresAutomatedProof(bar) ? 'automated' : 'manual';
}

function labelOf(kind: BarContractKind): string {
  return kind === 'manual' ? MANUAL_CONTRACT_LABEL : AUTOMATED_CONTRACT_LABEL;
}

function without<T>(values: readonly T[], remove: readonly T[]): T[] {
  return values.filter((value) => !remove.includes(value));
}

export function evaluateAmendmentReadinessDelta(
  before: AcceptanceBarContractSnapshot,
  after: AcceptanceBarContractSnapshot,
): AcceptanceBarAmendmentReadinessDelta {
  const applicable = (snapshot: AcceptanceBarContractSnapshot) =>
    snapshot.applicable ? snapshot : { ...snapshot, applicable: true };
  const beforeVerdict = evaluateAcceptanceBarLifecycle(applicable(before), 'ship');
  const afterVerdict = evaluateAcceptanceBarLifecycle(applicable(after), 'ship');
  const beforeBars = new Map(before.bars.map((bar) => [bar.barKey, bar]));
  const afterBars = new Map(after.bars.map((bar) => [bar.barKey, bar]));
  const codesOf = (verdict: typeof beforeVerdict, barKey: string) =>
    verdict.blockingBars.find((bar) => bar.barKey === barKey)?.codes ?? [];

  const rows: AmendmentReadinessBarRow[] = [];
  const flippedToAutomated: string[] = [];
  const flippedToManual: string[] = [];
  for (const barKey of [...new Set([...beforeBars.keys(), ...afterBars.keys()])].sort()) {
    const prior = beforeBars.get(barKey);
    const next = afterBars.get(barKey);
    const contractBefore = prior ? contractOf(prior) : null;
    const contractAfter = next ? contractOf(next) : null;
    if (contractBefore === 'manual' && contractAfter === 'automated') flippedToAutomated.push(barKey);
    if (contractBefore === 'automated' && contractAfter === 'manual') flippedToManual.push(barKey);
    const beforeCodes = codesOf(beforeVerdict, barKey);
    const afterCodes = codesOf(afterVerdict, barKey);
    const codesAdded = without(afterCodes, beforeCodes);
    const codesRemoved = without(beforeCodes, afterCodes);
    if (contractBefore !== contractAfter || codesAdded.length > 0 || codesRemoved.length > 0) {
      rows.push({
        barKey,
        contractBefore,
        contractAfter,
        label: labelOf((contractAfter ?? contractBefore)!),
        codesAdded,
        codesRemoved,
      });
    }
  }

  const codesAdded = without(afterVerdict.codes, beforeVerdict.codes);
  const codesRemoved = without(beforeVerdict.codes, afterVerdict.codes);
  const raisesProofFloorOnly =
    flippedToAutomated.length > 0 &&
    flippedToManual.length === 0 &&
    rows.every((row) => row.codesRemoved.length === 0) &&
    rows.every((row) => row.codesAdded.length === 0 || flippedToAutomated.includes(row.barKey));

  const beforeCount = beforeVerdict.blockingBars.length;
  const afterCount = afterVerdict.blockingBars.length;
  const parts = [
    `Ship readiness: ${beforeCount} of ${before.bars.length} BAR(s) blocking before, ` +
      `${afterCount} of ${after.bars.length} after; codes added: ${codesAdded.join(', ') || 'none'}; ` +
      `codes removed: ${codesRemoved.join(', ') || 'none'}.`,
  ];
  if (flippedToAutomated.length > 0) {
    parts.push(
      `Flips from ${MANUAL_CONTRACT_LABEL} to ${AUTOMATED_CONTRACT_LABEL}: ${flippedToAutomated.join(', ')}.`,
    );
  }
  if (flippedToManual.length > 0) {
    parts.push(`Flips to ${MANUAL_CONTRACT_LABEL}: ${flippedToManual.join(', ')}.`);
  }
  if (raisesProofFloorOnly) {
    const added = rows.reduce((count, row) => count + row.codesAdded.length, 0);
    parts.push(
      `THIS AMENDMENT ONLY RAISES THE PROOF FLOOR: it repairs no blocking code and adds ${added} to ` +
        `${flippedToAutomated.length} BAR(s) that were manual contracts. Confirm that is intended ` +
        'BEFORE requesting a countersignature.',
    );
  }

  return {
    phase: 'ship',
    before: { blockingBarCount: beforeCount, barCount: before.bars.length, codes: beforeVerdict.codes },
    after: { blockingBarCount: afterCount, barCount: after.bars.length, codes: afterVerdict.codes },
    codesAdded,
    codesRemoved,
    bars: rows,
    flippedToAutomated,
    flippedToManual,
    raisesProofFloorOnly,
    summary: parts.join(' '),
  };
}
