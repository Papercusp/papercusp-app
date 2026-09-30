/**
 * composeAmbiguityPrompt — build a short spoken disambiguation prompt
 * when the matcher returns multiple candidate options.
 *
 * Plan: apps/operator/docs/plans/voice-aware-cards-2026-05-14.md §C.2
 *
 * Split from match-voice-answer.ts not for purity (this is also pure)
 * but for separation of concerns: matching is a stable problem;
 * phrasing is TTS-aware and likely to churn. Frozen matcher vs.
 * evolving phrasing.
 */

import type { OpenCardSnapshot } from '@papercusp/agent-mcp';

/**
 * Compose: "Did you mean A, or B?"
 *
 * - 2 candidates: "Did you mean A, or B?"
 * - 3 candidates: "Did you mean A, B, or C?"
 * - Falls back to the card prompt when candidateIds don't resolve to options.
 */
export function composeAmbiguityPrompt(
  card: OpenCardSnapshot,
  candidateIds: readonly string[],
): string {
  const presentation = card.presentation;
  if (!presentation || presentation.kind !== 'radio') {
    return card.prompt;
  }
  const labelsById = new Map<string, string>();
  for (const opt of presentation.options) {
    labelsById.set(opt.id, opt.label);
  }
  const labels: string[] = [];
  for (const id of candidateIds) {
    const label = labelsById.get(id);
    if (label) labels.push(label);
  }
  if (labels.length === 0) return card.prompt;
  if (labels.length === 1) return `Did you mean ${labels[0]}?`;
  if (labels.length === 2) return `Did you mean ${labels[0]}, or ${labels[1]}?`;
  const head = labels.slice(0, -1).join(', ');
  const tail = labels[labels.length - 1];
  return `Did you mean ${head}, or ${tail}?`;
}
