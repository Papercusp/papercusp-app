/**
 * Operator pause/resume actions invoked from the mobile WS bridge.
 *
 * (This module previously also carried the operator-CARD verbs —
 * listPendingCards / dispatchCard / dismissCard / describeCard. Those were
 * retired with the scanner card stream: unify-agent-launches-as-blueprints
 * D-005 dissolved the bespoke scanner + card feed into the scheduled `scan`
 * launch blueprint whose findings land as work_items in the
 * self-improvement backlog.)
 */
import { notifySyncInvalidate } from './sync-sse';
import { readOperatorState, writeOperatorState } from './operator-state-pg';

// ── Pause / resume sentinel (PG-backed, migration 029) ─────────────────
//
// Was previously `<ws>/.papercusp/system/operator/paused.flag` — file
// existence = "paused". Now `harness_shared.operator_paused` row with
// JSONB payload `{ paused, by?, at? }`. We keep `paused: false` rows
// rather than deleting on resume so the row holds the audit trail of
// the last-pause-by-whom (read by getPauseInfo when paused, ignored
// otherwise). Same single-row-per-workspace pattern as the rest of
// operator-state-pg.

interface PauseState {
  paused: boolean;
  by?: string;
  at?: string;
}

export async function setPaused(by: string): Promise<void> {
  await writeOperatorState<PauseState>('operator_paused', {
    paused: true,
    by,
    at: new Date().toISOString(),
  });
  void notifySyncInvalidate('operatorPauseFlag').catch(() => {});
}

export async function setResumed(): Promise<void> {
  await writeOperatorState<PauseState>('operator_paused', { paused: false });
  void notifySyncInvalidate('operatorPauseFlag').catch(() => {});
}

export async function isPaused(): Promise<boolean> {
  const s = await readOperatorState<PauseState>('operator_paused');
  return s?.paused === true;
}

export async function getPauseInfo(): Promise<{ paused: boolean; by?: string; at?: string }> {
  const s = await readOperatorState<PauseState>('operator_paused');
  if (!s?.paused) return { paused: false };
  return { paused: true, by: s.by, at: s.at };
}
