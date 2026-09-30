'use client';

/**
 * QueueSummary — the two-halves strip above the Queue
 * (queue-authorization-redesign-2026-06-14 P-006 / B1): "{N} waiting on you ·
 * {M} handled by the Queen". Ties the Pending tab (what needs you) to the
 * Queen's-log tab (what she took off your plate) so the human↔Queen division of
 * labor is visible at a glance.
 *
 * `waitingOnYou` is passed in (the caller already has the attention tier counts);
 * the Queen-handled count reads the decision.ledger disposition layer directly.
 */
import { useSyncQuery } from '@papercusp/sync';

import { useLexicon } from '@/lib/useLexicon';

interface DecisionRowLite {
  id: number;
}

const HANDLED_CAP = 100;

export default function QueueSummary({ waitingOnYou }: { waitingOnYou: number }) {
  const t = useLexicon();
  const { data } = useSyncQuery<DecisionRowLite>({
    queryName: 'decision.ledger',
    args: { layer: 'disposition', limit: HANDLED_CAP },
  });
  const handled = data?.length ?? 0;
  const handledLabel = handled >= HANDLED_CAP ? `${HANDLED_CAP}+` : String(handled);

  return (
    <div className="pc-queue__summary" role="status">
      <span className="pc-queue__summary-you">{waitingOnYou} waiting on you</span>
      <span className="pc-queue__summary-sep">·</span>
      <span className="pc-queue__summary-queen">{handledLabel} handled by the {t('brain')}</span>
    </div>
  );
}
