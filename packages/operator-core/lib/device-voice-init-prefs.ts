/**
 * voice-session-init pref resolution — combines the device's per-session
 * query overrides (`?mode=`, `?idleMin=`, `?sessionMaxMin=`) with the
 * workspace voice prefs from PG. Extracted from _hono/mobile.ts so the
 * fallback + clamp logic is unit-testable.
 *
 * Resolution rules (in order):
 *
 *   1. mode: if query.mode is one of the 3 valid modes → use it.
 *      Otherwise fall back to prefs.fullAgentVoiceMode.
 *
 *   2. idleTimeoutMin: if query.idleMin is a non-negative finite
 *      number → use it. Otherwise fall back to prefs.fullAgentIdleTimeoutMin.
 *
 *   3. sessionMaxMin: same logic against prefs.fullAgentSessionMaxMin.
 *
 *   4. CLAMP: if final mode is 'single-utterance', idle is clamped to
 *      ≤1 regardless of the resolved value. The clamp also bumps a 0
 *      ("never auto-disconnect") request up to 1, because single-
 *      utterance with no idle = session never ends.
 */

export const VALID_VOICE_MODES = ['continuous', 'hybrid', 'single-utterance'] as const;
export type VoiceMode = (typeof VALID_VOICE_MODES)[number];

export interface VoicePrefsSubset {
  fullAgentVoiceMode: VoiceMode;
  fullAgentIdleTimeoutMin: number;
  fullAgentSessionMaxMin: number;
}

export interface VoiceInitQuery {
  mode?: string;
  idleMin?: string;
  sessionMaxMin?: string;
}

export interface ResolvedVoiceInit {
  voiceMode: VoiceMode;
  idleTimeoutMin: number;
  sessionMaxMin: number;
}

function parseNonNegativeNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

export function resolveVoiceInit(query: VoiceInitQuery, prefs: VoicePrefsSubset): ResolvedVoiceInit {
  const modeFromQuery = (VALID_VOICE_MODES as readonly string[]).includes(query.mode ?? '')
    ? (query.mode as VoiceMode)
    : undefined;
  const voiceMode: VoiceMode = modeFromQuery ?? prefs.fullAgentVoiceMode;

  const queryIdle = parseNonNegativeNumber(query.idleMin);
  const resolvedIdle = queryIdle !== undefined ? queryIdle : prefs.fullAgentIdleTimeoutMin;

  const queryMax = parseNonNegativeNumber(query.sessionMaxMin);
  const sessionMaxMin = queryMax !== undefined ? queryMax : prefs.fullAgentSessionMaxMin;

  // Single-utterance forces a hard 1-min idle cap. A request for 0
  // ("never auto-disconnect") in single-utterance mode would defeat
  // the mode's whole purpose, so we bump to 1.
  const idleTimeoutMin = voiceMode === 'single-utterance'
    ? Math.min(resolvedIdle || 1, 1)
    : resolvedIdle;

  return { voiceMode, idleTimeoutMin, sessionMaxMin };
}
