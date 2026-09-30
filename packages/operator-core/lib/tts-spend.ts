/**
 * ElevenLabs cost tracking + soft/hard cap state (v4 §1.2.3 + §2n).
 *
 * Per-call spend is persisted in `harness_shared.operator_tts_spend` (PG)
 * — migration 020. Was previously `<papercuspRoot>/system/operator/tts-spend.json`;
 * the JSON file approach raced under multi-tab usage, the PG transactional
 * update fixes it.
 *
 * Schema (the JSONB payload):
 *   {
 *     perKCharRate: 0.18,           // user-configurable, default Creator tier
 *     softCapUsd:   5,
 *     hardCapUsd:   20,
 *     lastSpendDate: 'YYYY-MM-DD',  // UTC; rolls when current date differs
 *     softCapAcknowledgedDate: null | 'YYYY-MM-DD',
 *     spend: [{ date, chars, estimatedUsd }, ...]   // last 7 days
 *   }
 *
 * Recording is split into pure logic (`computeNextState`) + side-effect
 * IO so the tricky bits (rollover, dedup, cap-trip detection) are
 * unit-testable without a filesystem or a database.
 */

import { readOperatorState, writeOperatorState } from './operator-state-pg';

export interface TtsSpendDay {
  date: string;
  chars: number;
  estimatedUsd: number;
}

export interface TtsSpendState {
  perKCharRate: number;
  softCapUsd: number;
  hardCapUsd: number;
  lastSpendDate: string | null;
  softCapAcknowledgedDate: string | null;
  spend: TtsSpendDay[];
}

export interface SpendUpdate {
  next: TtsSpendState;
  /** True when this call crossed the soft cap AND it hasn't been ack'd today. */
  fireSoftCap: boolean;
  /** True when today's spend exceeds the hard cap. */
  hardCapTripped: boolean;
  /** Today's total spend AFTER this call. */
  todayUsd: number;
}

export const DEFAULT_SPEND_STATE: TtsSpendState = {
  perKCharRate: 0.18, // Creator tier default
  softCapUsd: 5,
  hardCapUsd: 20,
  lastSpendDate: null,
  softCapAcknowledgedDate: null,
  spend: [],
};

export function utcDateString(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Pure update step. Given current state + new chars to add, returns the
 * next state plus side-effect signals (cap toasts to fire). No IO.
 *
 * Handles three cases:
 *   - Normal accumulation (same UTC day)
 *   - Date rollover (new UTC day): roll spend list, reset acknowledgement
 *   - Soft-cap crossed: fire iff not already ack'd today
 *   - Hard-cap crossed: always fire (caller decides what to do)
 */
export function computeNextState(
  cur: TtsSpendState,
  chars: number,
  now: number = Date.now(),
): SpendUpdate {
  const today = utcDateString(now);
  let spend = [...cur.spend];
  let softCapAcknowledgedDate = cur.softCapAcknowledgedDate;

  // Rollover: any time the date changes, prepend a new day entry and
  // reset the soft-cap acknowledgement so today's first crossing
  // re-fires the toast.
  if (cur.lastSpendDate !== today) {
    spend.unshift({ date: today, chars: 0, estimatedUsd: 0 });
    spend = spend.slice(0, 7);
    softCapAcknowledgedDate = null;
  }

  // Accumulate.
  spend[0].chars += chars;
  spend[0].estimatedUsd = (spend[0].chars / 1000) * cur.perKCharRate;
  const todayUsd = spend[0].estimatedUsd;

  const next: TtsSpendState = {
    ...cur,
    lastSpendDate: today,
    softCapAcknowledgedDate,
    spend,
  };

  const fireSoftCap = todayUsd > cur.softCapUsd && softCapAcknowledgedDate !== today;
  const hardCapTripped = todayUsd > cur.hardCapUsd;

  // If we're firing the soft-cap toast this call, mark it ack'd so we
  // don't fire again today.
  if (fireSoftCap) {
    next.softCapAcknowledgedDate = today;
  }

  return { next, fireSoftCap, hardCapTripped, todayUsd };
}

export async function loadSpend(): Promise<TtsSpendState> {
  const raw = await readOperatorState<Partial<TtsSpendState>>('operator_tts_spend');
  if (!raw) return { ...DEFAULT_SPEND_STATE };
  return {
    ...DEFAULT_SPEND_STATE,
    ...raw,
    spend: Array.isArray(raw.spend) ? raw.spend.slice(0, 7) : [],
  };
}

export async function saveSpend(state: TtsSpendState): Promise<void> {
  await writeOperatorState('operator_tts_spend', state);
}
