/**
 * STT cost tracking + soft/hard cap state (parallel to tts-spend.ts).
 *
 * Tracks minutes of audio sent to paid cloud STT engines. Voicemode
 * (local Whisper) and Web Speech (browser's built-in) are free and do
 * not record. Deepgram Nova-2 ~ $0.0043/min is the first paid engine.
 *
 * Persisted in `harness_shared.operator_stt_spend` (PG, migration 020) —
 * was previously `<papercuspRoot>/system/operator/stt-spend.json`. PG
 * fixes the multi-tab race the JSON file approach had.
 */

import {
  readOperatorState,
  writeOperatorState,
  updateOperatorState,
} from './operator-state-pg';

export interface SttSpendDay {
  date: string;
  minutes: number;
  estimatedUsd: number;
}

export interface SttSpendState {
  perMinuteRate: number;
  softCapUsd: number;
  hardCapUsd: number;
  lastSpendDate: string | null;
  softCapAcknowledgedDate: string | null;
  spend: SttSpendDay[];
}

export interface SttSpendUpdate {
  next: SttSpendState;
  fireSoftCap: boolean;
  hardCapTripped: boolean;
  todayUsd: number;
}

export const DEFAULT_STT_SPEND_STATE: SttSpendState = {
  perMinuteRate: 0.0043,
  softCapUsd: 1,
  hardCapUsd: 5,
  lastSpendDate: null,
  softCapAcknowledgedDate: null,
  spend: [],
};

function utcDateString(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function computeNextSttState(
  cur: SttSpendState,
  minutes: number,
  now: number = Date.now(),
): SttSpendUpdate {
  const today = utcDateString(now);
  let spend = [...cur.spend];
  let softCapAcknowledgedDate = cur.softCapAcknowledgedDate;

  if (cur.lastSpendDate !== today) {
    spend.unshift({ date: today, minutes: 0, estimatedUsd: 0 });
    spend = spend.slice(0, 7);
    softCapAcknowledgedDate = null;
  }

  spend[0].minutes += minutes;
  spend[0].estimatedUsd = spend[0].minutes * cur.perMinuteRate;
  const todayUsd = spend[0].estimatedUsd;

  const next: SttSpendState = {
    ...cur,
    lastSpendDate: today,
    softCapAcknowledgedDate,
    spend,
  };

  const fireSoftCap = todayUsd > cur.softCapUsd && softCapAcknowledgedDate !== today;
  const hardCapTripped = todayUsd > cur.hardCapUsd;
  if (fireSoftCap) next.softCapAcknowledgedDate = today;

  return { next, fireSoftCap, hardCapTripped, todayUsd };
}

export async function loadSttSpend(): Promise<SttSpendState> {
  const raw = await readOperatorState<Partial<SttSpendState>>('operator_stt_spend');
  if (!raw) return { ...DEFAULT_STT_SPEND_STATE };
  return {
    ...DEFAULT_STT_SPEND_STATE,
    ...raw,
    spend: Array.isArray(raw.spend) ? raw.spend.slice(0, 7) : [],
  };
}

export async function saveSttSpend(state: SttSpendState): Promise<void> {
  await writeOperatorState('operator_stt_spend', state);
}

export async function recordSttSpend(minutes: number, now: number = Date.now()): Promise<SttSpendUpdate> {
  let captured!: SttSpendUpdate;
  await updateOperatorState<SttSpendState>(
    'operator_stt_spend',
    DEFAULT_STT_SPEND_STATE,
    (cur) => {
      const normalized: SttSpendState = {
        ...DEFAULT_STT_SPEND_STATE,
        ...cur,
        spend: Array.isArray(cur.spend) ? cur.spend.slice(0, 7) : [],
      };
      captured = computeNextSttState(normalized, minutes, now);
      return captured.next;
    },
  );
  return captured;
}
