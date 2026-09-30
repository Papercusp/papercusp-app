/**
 * Pure functions for the learning loop. Extracted from learning.ts so
 * we can unit-test the prompt-derivation logic without a live PG.
 */

export interface FeedbackByKind {
  edit: Record<string, number>;
  delete: Record<string, number>;
}

export interface LearningSignal {
  totalEdits: number;
  totalDeletes: number;
  forgetAllCount: number;
  byKind: FeedbackByKind;
  /** Counts below this are ignored as noise. Defaults to 3. */
  noiseFloor?: number;
}

export function rebuildCustomInstructions(sig: LearningSignal): string | null {
  const floor = sig.noiseFloor ?? 3;
  const hints: string[] = [];

  if (sig.forgetAllCount >= 1) {
    hints.push(
      'The user has recently triggered a full memory reset. Treat this as a strong signal that prior extractions were too aggressive. Extract only high-confidence, explicitly stated facts. When in doubt, prefer NOT extracting.',
    );
  }

  if (sig.totalDeletes >= floor && sig.totalDeletes > sig.totalEdits) {
    hints.push(
      `The user has deleted ${sig.totalDeletes} memories recently (vs ${sig.totalEdits} edits). This indicates over-extraction. Be more conservative: skip ambiguous facts, prefer direct statements over inferences, and avoid presuming long-term preferences from single utterances.`,
    );
  } else if (sig.totalEdits >= floor && sig.totalEdits > sig.totalDeletes) {
    hints.push(
      `The user has edited ${sig.totalEdits} memories recently (vs ${sig.totalDeletes} deletes). This indicates the facts are *close* but the wording is off. Extract more literally — paraphrase less, quote the user's framing when useful.`,
    );
  }

  // Per-kind hints (only if we have signal at threshold)
  for (const [kind, n] of Object.entries(sig.byKind.delete)) {
    if (n >= floor) {
      hints.push(
        `Users frequently delete memories tagged kind=${kind} (${n} recent deletions). Be conservative when extracting facts of this kind.`,
      );
    }
  }
  for (const [kind, n] of Object.entries(sig.byKind.edit)) {
    if (n >= floor) {
      hints.push(
        `Users frequently edit memories tagged kind=${kind} (${n} recent edits). Extract them more literally; minimize inference.`,
      );
    }
  }

  if (hints.length === 0) return null;
  return `## Adaptive extraction notes (derived from user feedback)\n\n${hints.map((h) => `- ${h}`).join('\n')}`;
}
