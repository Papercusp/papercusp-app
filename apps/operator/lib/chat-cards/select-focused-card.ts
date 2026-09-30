/**
 * selectFocusedCard — pick the single open card that both the chat
 * surface displays first AND the voice router routes against.
 *
 * Plan: apps/operator/docs/plans/voice-aware-cards-2026-05-14.md §C.7
 *
 * Consistency over freshness: both surfaces consume this helper, so a
 * future change (priority flag, run-id grouping) flips both at once.
 *
 * Today's rule: openCards arrives in createdAt-ascending order from
 * the correlator (see use-state-snapshots.ts:100-104), so the head is
 * the oldest card. The chat bar already renders one card at a time
 * starting from this entry.
 */

import type { OpenCardWithRun } from '@/lib/use-state-snapshots';

export function selectFocusedCard(
  openCards: readonly OpenCardWithRun[],
): OpenCardWithRun | null {
  if (openCards.length === 0) return null;
  return openCards[0];
}
