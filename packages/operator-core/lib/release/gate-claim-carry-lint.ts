/**
 * P-007 (frozen-candidate-compliance-enforcement-2026-08-30): a gate-progress claim must not
 * survive compaction and be inherited as fact.
 *
 * P-006 catches the false claim at `work_items:complete`. This catches it one layer deeper,
 * on the CARRY SURFACES — loop:checkpoint, work_items:checkpoint, facts:assert,
 * session:request-compaction — which is where a claim stops being one agent's sentence and
 * becomes the next agent's premise.
 *
 * WHY THAT MATTERS MORE THAN THE COMPLETION CASE. A completion record is read by an audit
 * that can re-check it. A carry note is re-injected verbatim into a successor's context as
 * background truth, and the successor has no way to tell an observation from an inference —
 * the exact rot the provenance lint beside this one exists to stop for owner attribution.
 * "The gate is green" written into a checkpoint by an agent whose fixes never reached the
 * judged sha is inherited, restated with more confidence, and acted on.
 *
 * SHAPE. A lint, not a gate: it annotates the write, never refuses it, and is silent unless
 * a frozen queue actually exists. Same fail-open discipline as every sibling here.
 */
import { readFrozenRepairMarker, type FrozenRepairEditMarker } from './frozen-repair-edit-marker';
import { looksLikeGateRedFixClaim } from './gate-red-completion-claim';

export interface GateClaimCarryLint {
  flagged: true;
  note: string;
  /** The lines that made a gate-progress claim, so the writer can find them. */
  matches: string[];
  judgedSha: string;
  candidate: string;
}

export const GATE_CLAIM_CARRY_NOTE =
  'gate_claim_lint: this carry surface asserts GATE PROGRESS while a frozen repair queue is ' +
  'open, and a carry note is re-injected into a successor as background truth rather than as a ' +
  'claim to re-check. A fix committed to staging while the gate is frozen lands ABOVE the sha ' +
  'under judgment, so "the gate is green" / "fixed N gate reds" can be locally true and globally ' +
  'false — and the successor inherits it as fact. Before this text carries forward, verify ' +
  'containment against the JUDGED sha (not the tip) with ' +
  "release:repair-queue { op:'admit', paths:[...] }, and write the containment verdict into " +
  'the claim itself. If the claim is about work already proven contained, state the judged sha ' +
  'in the note so the successor can tell an observation from an inference.';

/**
 * Lint a carry-surface text. Returns `undefined` when there is nothing to say — which is
 * every case where no repair is frozen, since then an ordinary commit IS the judged lineage.
 */
export function gateClaimCarryLint(
  text: string | null | undefined,
  probe: { marker?: FrozenRepairEditMarker | null } = {},
): GateClaimCarryLint | undefined {
  try {
    if (!text || !text.trim()) return undefined;
    const marker = 'marker' in probe ? probe.marker : readFrozenRepairMarker();
    if (!marker) return undefined;

    // Line-scoped so the writer is pointed at the sentence, not handed a whole-note verdict.
    const matches = text
      .split('\n')
      .filter((line) => looksLikeGateRedFixClaim({ summary: line }))
      .map((line) => line.trim().slice(0, 220));
    if (!matches.length) return undefined;

    return {
      flagged: true,
      note: GATE_CLAIM_CARRY_NOTE,
      matches: matches.slice(0, 5),
      judgedSha: marker.repairHead,
      candidate: marker.candidate,
    };
  } catch {
    return undefined; // fail open — a lint fault must never fail a carry write
  }
}
