/**
 * Spoken nudges (Phase 4, v4 §2e).
 *
 * Three nudge kinds with persisted per-kind dedup windows:
 *   budget   30 min
 *   breaker  10 min
 *   pause     5 min
 *
 * Persisted to voice-prefs.json so reload doesn't reset; sleep-through-
 * midnight + timezone travel are absorbed because we compare ms
 * timestamps (not dates).
 */

import { loadVoicePrefs, saveVoicePrefs } from './voice-prefs';

export type NudgeKind = 'budget' | 'breaker' | 'pause';

export const NUDGE_DEDUP_MS: Record<NudgeKind, number> = {
  budget:  30 * 60_000,
  breaker: 10 * 60_000,
  pause:    5 * 60_000,
};

/**
 * Pure decision: should this nudge fire? Returns the next nudgeDedup
 * map (with this kind's lastSpokenAt updated) when firing, or null when
 * deduped.
 *
 * Caller persists the next state if non-null.
 */
export function shouldFireNudge(
  kind: NudgeKind,
  lastSpokenAt: string | null,
  now: number = Date.now(),
): { fire: true; nextLastSpokenAtIso: string } | { fire: false } {
  const windowMs = NUDGE_DEDUP_MS[kind];
  if (lastSpokenAt) {
    const lastMs = new Date(lastSpokenAt).getTime();
    if (Number.isFinite(lastMs) && now - lastMs < windowMs) {
      return { fire: false };
    }
  }
  return { fire: true, nextLastSpokenAtIso: new Date(now).toISOString() };
}

/**
 * Side-effecting helper for server contexts: load prefs, decide, save
 * the updated nudgeDedup if firing. Returns { fire: boolean }.
 */
export async function maybeFireNudge(kind: NudgeKind, now: number = Date.now()): Promise<boolean> {
  const prefs = await loadVoicePrefs();
  const cur = prefs.nudgeDedup[kind].lastSpokenAt;
  const decision = shouldFireNudge(kind, cur, now);
  if (decision.fire) {
    await saveVoicePrefs({
      nudgeDedup: {
        ...prefs.nudgeDedup,
        [kind]: { lastSpokenAt: decision.nextLastSpokenAtIso },
      },
    });
    return true;
  }
  return false;
}
